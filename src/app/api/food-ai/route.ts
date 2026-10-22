// POST /api/food-ai — the Food tab's AI reads and the meal resolver. Read-only:
// nothing here mutates the Swiggy cart (the approved plan is applied through
// /api/food-cart like any other cart change).
//
//  {action:"menuRead", restaurant?, categories}  → 2–3 lines + actionable chips
//      from the menu page the user is looking at (get_restaurant_menu data).
//  {action:"billRead", cart}                       → plain-language bill + Swiggy's
//      own nudges (get_food_cart pricing / offers).
//  {action:"resolveMeal", addressId, restaurantId, restaurantName, items[]}
//      → each proposed dish with its customization resolved via a scoped
//      search_menu (portion matched to the plan's option, required add-ons for
//      no-variant dishes) and a better estimate. Variant dishes get their
//      add-ons from the cart's valid_addons after the add.
//
// The reads are deterministic first (src/shared/foodAi.ts); an LLM may only
// rephrase them, and any number it writes must already be in Swiggy's data.

import { aiPhrase } from '@/backend/agent/food-ai';
import { isAuthError } from '@/backend/config/env';
import { searchMenu } from '@/backend/mcp/food-mcp';
import { aiSelection, explainFoodBill, menuInsights } from '@/shared/foodAi';
import type { FoodCart, FoodCartLine, FoodMealPlanItem, FoodRestaurant, MenuCategory, MenuItem } from '@/shared/types';
import { route, unauthorized } from "@/backend/http/route";
import { FoodAiBody } from "@/backend/http/schemas";
import { BoundedMap } from "@/backend/resilience/lru";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PRIVATE = { "Cache-Control": "private, no-store" };

// Same menu page / same bill → same read; keeps LLM calls to one per view.
const READ_TTL = 10 * 60_000;
const readCache = new BoundedMap<string, { at: number; value: unknown }>({ max: 300, ttlMs: READ_TTL });
function cached<T>(key: string): T | undefined {
  const hit = readCache.get(key);
  if (hit && Date.now() - hit.at < READ_TTL) return hit.value as T;
  return undefined;
}
function remember(key: string, value: unknown) {
  if (readCache.size > 300) readCache.clear();
  readCache.set(key, { at: Date.now(), value });
}

// Scoped search_menu results are reused across the dishes of one plan.
const SEARCH_TTL = 60_000;
const searchCache = new BoundedMap<string, { at: number; dishes: MenuItem[] }>({ max: 300, ttlMs: SEARCH_TTL });
async function scopedDishes(addressId: string, restaurantId: string, query: string): Promise<MenuItem[]> {
  const key = `${addressId}|${restaurantId}|${query.toLowerCase()}`;
  const hit = searchCache.get(key);
  if (hit && Date.now() - hit.at < SEARCH_TTL) return hit.dishes;
  const { dishes } = await searchMenu(addressId, query, { restaurantId });
  searchCache.set(key, { at: Date.now(), dishes });
  return dishes;
}

/** search_menu wants a dish name — drop Swiggy's parenthetical tails. */
const searchName = (name: string) => name.replace(/\s*\([^)]*\)/g, "").trim().slice(0, 80) || name.slice(0, 80);

export const POST = route({ name: "api/food-ai", rateLimit: "ai", body: FoodAiBody, maxBodyBytes: 512 * 1024 }, async function POST(request: Request): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return Response.json({ error: "Invalid request." }, { status: 400, headers: PRIVATE });
  }
  try {
    switch (body.action) {
      case "menuRead":
        return Response.json(await menuRead(body), { headers: PRIVATE });
      case "billRead":
        return Response.json(await billRead(body), { headers: PRIVATE });
      case "resolveMeal":
        return Response.json(await resolveMeal(body), { headers: PRIVATE });
      default:
        return Response.json({ error: "Unknown action." }, { status: 400, headers: PRIVATE });
    }
  } catch (err) {
    if (isAuthError(err)) return unauthorized();
    console.error("[api/food-ai] failed:", err);
    return Response.json(
      { error: err instanceof Error ? err.message : "Couldn't prepare the AI read." },
      { status: 502, headers: PRIVATE },
    );
  }
});

async function menuRead(body: Record<string, unknown>) {
  const categories = (Array.isArray(body.categories) ? body.categories : []) as MenuCategory[];
  const restaurant = (body.restaurant && typeof body.restaurant === "object" ? body.restaurant : undefined) as
    | FoodRestaurant
    | undefined;
  const insights = menuInsights(categories, restaurant);
  if (!insights.lines.length) return { lines: [], chips: [], source: "rules" };
  const key = `menu|${restaurant?.id ?? ""}|${insights.facts}`;
  const hit = cached<{ lines: string[] }>(key);
  const ai =
    hit?.lines ??
    (await aiPhrase(
      "Give a quick, friendly expert read of this restaurant menu page: the top-rated / bestseller picks, the best value, the veg options, and what's unavailable.",
      insights.facts,
      insights.lines,
      { max: 3 },
    ));
  if (ai) remember(key, { lines: ai });
  return { lines: ai ?? insights.lines, chips: insights.chips, source: ai ? "ai" : "rules" };
}

async function billRead(body: Record<string, unknown>) {
  const cart = (body.cart && typeof body.cart === "object" ? body.cart : null) as FoodCart | null;
  if (!cart || !Array.isArray(cart.items)) return { lines: [], nudges: [], savings: 0, source: "rules" };
  const read = explainFoodBill(cart);
  if (!read.lines.length) return { ...read, source: "rules" };
  const key = `bill|${read.facts}`;
  const hit = cached<{ lines: string[] }>(key);
  const ai =
    hit?.lines ??
    (await aiPhrase(
      "Explain this food-delivery bill in plain words for the customer: what they pay and why (fees, taxes, discounts, savings). Do not suggest adding items unless the facts quote Swiggy saying so.",
      read.facts,
      read.lines,
      { max: 3, timeoutMs: 7_000 },
    ));
  if (ai) remember(key, { lines: ai });
  return { lines: ai ?? read.lines, nudges: read.nudges, savings: read.savings, source: ai ? "ai" : "rules" };
}

interface ResolvedMealLine {
  line: Omit<FoodCartLine, "quantity">;
  quantity: number;
  note?: string; // what the AI picked (portion / add-ons) and why
  unavailable?: string; // Swiggy says it can't be ordered now
}

async function resolveMeal(body: Record<string, unknown>) {
  const addressId = typeof body.addressId === "string" ? body.addressId.trim() : "";
  const restaurantId = typeof body.restaurantId === "string" ? body.restaurantId.trim() : "";
  const items = (Array.isArray(body.items) ? body.items : []).slice(0, 12) as FoodMealPlanItem[];
  if (!addressId || !restaurantId || !items.length) {
    return { lines: [], estimate: 0, notes: ["Pick a delivery address first."] };
  }
  const out: ResolvedMealLine[] = [];
  const notes: string[] = [];
  // Sequential on purpose: Swiggy rate-limits bursts; most plans are 2–5 dishes.
  for (const it of items) {
    const base: Omit<FoodCartLine, "quantity"> = {
      menuItemId: it.menuItemId,
      name: it.name,
      imageUrl: it.imageUrl,
      veg: it.veg,
      price: it.price,
    };
    const quantity = Math.max(1, Math.min(10, Math.round(it.quantity) || 1));
    if (it.customisable === false) {
      out.push({ line: base, quantity });
      continue;
    }
    let match: MenuItem | undefined;
    try {
      const dishes = await scopedDishes(addressId, restaurantId, searchName(it.name));
      match = dishes.find((d) => d.id === it.menuItemId);
    } catch (err) {
      if (isAuthError(err)) throw err;
      notes.push(`Couldn't load ${it.name}'s options from Swiggy — it'll be added as listed.`);
    }
    if (match && !match.inStock) {
      out.push({ line: base, quantity, unavailable: `${it.name} is sold out on Swiggy right now.` });
      continue;
    }
    const c = match?.customization;
    if (!c || (c.variantGroups.length === 0 && c.addonGroups.length === 0)) {
      out.push({ line: { ...base, price: match?.price || base.price, imageUrl: base.imageUrl || match?.imageUrl || "" }, quantity });
      continue;
    }
    const ai = aiSelection(c, it.option);
    const unit = (match?.price || base.price) + ai.extra;
    out.push({
      line: { ...base, price: unit, imageUrl: base.imageUrl || match?.imageUrl || "", selection: ai.selection },
      quantity,
      note: `AI picked ${ai.reasons.join("; ")}${ai.addonsAfterAdd ? " · add-ons are matched to this portion once Swiggy confirms them in your cart" : ""}`,
    });
  }
  const estimate = out.filter((l) => !l.unavailable).reduce((s, l) => s + l.line.price * l.quantity, 0);
  return { lines: out, estimate, notes };
}
