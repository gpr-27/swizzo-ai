// Food "AI everywhere" — the server half:
//  - resolveMealPlan: the agent's MEAL: / MEALITEM: markers → ONE FoodMealPlan
//    (ids resolved against the dishes a tool returned this turn / the catalog;
//    single restaurant; nothing invented).
//  - aiPhrase: a short, number-guarded LLM rewrite of a deterministic read
//    (menu read, bill read). The model may only use numbers present in the
//    facts; anything else falls back to the deterministic lines.

import { generateText } from "ai";

import { parseMealMarkers } from "@/shared/foodAi";
import type { FoodMealPlan, FoodMealPlanItem } from "@/shared/types";
import type { FoodResolved } from "./agent";
import { providerChain } from "./providers";
import { fenceUntrusted, UNTRUSTED_DATA_RULE } from "@/backend/security/prompt-guard";

/**
 * Pull MEAL / MEALITEM lines out of a Food reply and build the plan. Items
 * whose id was never returned by a tool are dropped; a Swiggy cart holds ONE
 * restaurant, so dishes from another restaurant than the first are dropped
 * with a note.
 */
export function resolveMealPlan(
  text: string,
  foodById: Map<string, FoodResolved>,
): { rest: string; plan: FoodMealPlan | null } {
  const { rest, meal, items } = parseMealMarkers(text);
  if (!items.length) return { rest, plan: null };
  const notes: string[] = [];
  const resolved: (FoodMealPlanItem & { restaurantId: string; restaurantName: string })[] = [];
  for (const it of items) {
    const f = foodById.get(it.id);
    if (!f) {
      notes.push(`Skipped one dish the menu didn't list (id ${it.id}).`);
      continue;
    }
    const existing = resolved.find((r) => r.menuItemId === it.id);
    if (existing) {
      existing.quantity += it.quantity;
      continue;
    }
    resolved.push({
      menuItemId: it.id,
      name: f.line.name,
      quantity: it.quantity,
      reason: it.reason,
      ...(it.option ? { option: it.option } : {}),
      price: f.line.price,
      veg: f.line.veg,
      imageUrl: f.line.imageUrl,
      ...(f.meta ? { customisable: f.meta.hasVariants || f.meta.hasAddons } : {}),
      ...(f.meta?.rating ? { rating: f.meta.rating } : {}),
      ...(f.meta?.bestseller ? { bestseller: true } : {}),
      restaurantId: f.restaurantId,
      restaurantName: f.restaurantName,
    });
  }
  if (!resolved.length) return { rest, plan: null };
  const rid = resolved[0].restaurantId;
  const same = resolved.filter((r) => r.restaurantId === rid);
  const dropped = resolved.filter((r) => r.restaurantId !== rid);
  if (dropped.length) {
    notes.push(
      `Left out ${dropped.map((d) => d.name).join(", ")} — it's from ${dropped[0].restaurantName}, and a Swiggy cart holds one restaurant.`,
    );
  }
  const planItems: FoodMealPlanItem[] = same.map(({ restaurantId: _r, restaurantName: _n, ...i }) => {
    void _r;
    void _n;
    return i;
  });
  return {
    rest,
    plan: {
      title: meal?.title || "Your order",
      ...(meal?.budget ? { budget: meal.budget } : {}),
      ...(meal?.people ? { people: meal.people } : {}),
      restaurantId: rid,
      restaurantName: resolved[0].restaurantName,
      items: planItems,
      estimate: planItems.reduce((s, i) => s + i.price * i.quantity, 0),
      ...(notes.length ? { notes } : {}),
    },
  };
}

/** Every number in `text` (₹ amounts, ratings, counts) — for the guard. */
function numbersIn(text: string): string[] {
  return (text.replace(/,(?=\d{3})/g, "").match(/\d+(?:\.\d+)?/g) ?? []).map((n) => String(Number(n)));
}

/** True when every number the model wrote appears in the facts (1–3 digit counts like "2 dishes" allowed ≤ 10). */
export function numbersGrounded(output: string, facts: string): boolean {
  const allowed = new Set(numbersIn(facts));
  return numbersIn(output).every((n) => allowed.has(n) || Number(n) <= 10);
}

/**
 * Ask the first answering model to rephrase a deterministic read into ≤ `max`
 * short lines, using ONLY the facts. Returns null (→ caller keeps its own
 * lines) when no provider answers in time or the output cites a number that
 * isn't in the facts.
 */
export async function aiPhrase(
  task: string,
  facts: string,
  draft: string[],
  opts: { max?: number; timeoutMs?: number } = {},
): Promise<string[] | null> {
  const max = opts.max ?? 3;
  const attempts = providerChain(process.env).slice(0, 3);
  if (!attempts.length || !facts.trim()) return null;
  const deadline = Date.now() + (opts.timeoutMs ?? 9_000);
  for (const a of attempts) {
    const left = deadline - Date.now();
    if (left < 1_500) break;
    try {
      const { text } = await generateText({
        model: a.languageModel,
        instructions: `You are the food concierge inside a Swiggy app. ${task} Write at most ${max} short lines (each under 140 characters), plain text, no bullets, no markdown, no greeting. Use ONLY the facts given — never add a dish, price, rating, discount or number that is not in them. Keep ₹ amounts exactly as written.`,
        prompt: `FACTS (from Swiggy):\n${fenceUntrusted(facts)}\n\nDRAFT (accurate, rephrase it better if you can):\n${fenceUntrusted(draft.join("\n"))}${UNTRUSTED_DATA_RULE}`,
        maxOutputTokens: 400,
        maxRetries: 0,
        abortSignal: AbortSignal.timeout(left),
        providerOptions: a.providerOptions as never,
      });
      const lines = text
        .split("\n")
        .map((l) => l.replace(/^[\s*•\-\d.)]+/, "").replace(/\*\*/g, "").trim())
        .filter((l) => l.length > 3)
        .slice(0, max);
      if (!lines.length) continue;
      if (!numbersGrounded(lines.join(" "), facts)) return null;
      return lines;
    } catch {
      // next provider
    }
  }
  return null;
}
