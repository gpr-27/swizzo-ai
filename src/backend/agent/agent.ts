// The chat concierge agent: marker parsing, tool-result → card mapping and the
// public runChat entry. The LLM loop itself lives in runner.ts and walks the
// provider chain in providers.ts (Claude Haiku → Groq ×2 → Gemini ×2).

import type { PromptContext } from "./services";
import { classifyProviderError, formatErrorMarkdown } from "./diagnostics";
import { errorStatus } from "./providers";
import { isAuthError } from "@/backend/config/env";
import { str } from "@/backend/mcp/client";

function bool(v: unknown, fallback = false): boolean {
  if (typeof v === "boolean") return v;
  if (typeof v === "string") return v.toLowerCase() === "true";
  return fallback;
}
import {
  mapProductsPayload,
  imTrackerFromDeliveryStatus,
  imTrackerFromOrder,
  pastInstamartOrders,
  imTrackerFromTrackOrder,
} from "@/backend/mcp/swiggy-mcp";
import {
  mapFoodRestaurants,
  mapSearchMenu,
  normalizeMenu,
  trackerFromDeliveryStatus as foodTrackerFromDeliveryStatus,
  trackerFromFoodOrders,
  pastFoodOrders,
  trackerFromTrackFoodOrder,
} from "@/backend/mcp/food-mcp";
import {
  describeDineoutBooking,
  mapDineoutBooking,
  mapDineoutDetails,
  mapDineoutSearch,
  mapDineoutSlots,
} from "@/backend/mcp/dineout-mcp";
import {
  describeScenesBooking,
  filterToCity,
  mapEventBooking,
  mapScenesEvents,
  mapShowListing,
  normalizeEventDetails,
  mapEventVenueInfo,
  mapSavedLocations,
  resolveUserCity,
  savedLocationCity,
  scenesCoords,
} from "@/backend/mcp/scenes-mcp";
import { getDishIngredients } from "@/shared/recipeData";
import { extractPickMarkers, extractWhyMarkers } from "@/shared/picker";
import { runChatChain } from "./runner";
import { extractPlanMarkers } from "./plan-markers";
import { resolveMealPlan } from "./food-ai";
import type {
  ActivePicker,
  CartLine,
  ChatStreamEvent,
  FoodCartLine,
  InstamartBasket,
  Role,
  Service,
} from "@/shared/types";

export type ProductLine = Omit<CartLine, "quantity">;
export type FoodResolved = {
  restaurantId: string;
  restaurantName: string;
  line: Omit<FoodCartLine, "quantity">;
  // menu facts the meal planner carries onto its proposal (menu/search_menu only)
  meta?: { hasVariants: boolean; hasAddons: boolean; rating?: string; bestseller?: boolean };
};

/** Accumulated structured Compare verdict parsed from COMPARE:/NOTE: markers. */
type ComparisonAcc = {
  winnerId?: string;
  verdict?: string;
  notes: { id: string; note: string }[];
};

/** Cache item metadata from a card event so ADD markers resolve exactly. */
export function cacheFromEvent(
  event: ChatStreamEvent,
  lineBySpin: Map<string, ProductLine>,
  foodById: Map<string, FoodResolved>,
  restNameById: Map<string, string>,
): void {
  if (event.type === "foodRestaurants") {
    for (const r of event.restaurants) {
      if (r.id && r.name) restNameById.set(r.id, r.name);
    }
    return;
  }
  if (event.type === "products" || event.type === "suggestions") {
    for (const p of event.products) {
      for (const v of p.variations) {
        if (!v.spinId) continue;
        lineBySpin.set(v.spinId, {
          spinId: v.spinId,
          ...(v.skuId ? { skuId: v.skuId } : {}),
          productId: p.productId,
          name: p.name,
          brand: p.brand,
          quantityDescription: v.quantityDescription,
          imageUrl: v.imageUrl,
          unitPrice: v.offerPrice,
          mrp: v.mrp,
          ...(v.maxQuantity ? { maxQuantity: v.maxQuantity } : {}),
          ...(v.maxQuantityMessage ? { maxQuantityMessage: v.maxQuantityMessage } : {}),
          inStock: p.inStock && v.inStock,
        });
      }
    }
  } else if (event.type === "menu") {
    for (const c of event.categories) {
      for (const it of c.items) {
        if (!it.id) continue;
        foodById.set(it.id, {
          restaurantId: it.restaurantId || event.restaurantId,
          restaurantName: it.restaurantName || event.restaurantName,
          line: {
            menuItemId: it.id,
            name: it.name,
            imageUrl: it.imageUrl,
            veg: it.veg,
            price: it.price,
          },
          meta: {
            hasVariants: it.hasVariants,
            hasAddons: it.hasAddons,
            ...(it.rating ? { rating: it.rating } : {}),
            ...(it.bestseller ? { bestseller: true } : {}),
          },
        });
      }
    }
  }
}

export interface RunChatArgs {
  service: Service;
  message: string;
  history?: { role: Role; text: string }[];
  ctx: PromptContext;
  /** Photo attached this turn (base64, no data: prefix). */
  image?: { mediaType: string; data: string };
  /** Aborted when the client disconnects or presses Stop. */
  signal?: AbortSignal;
  /** No tools this turn (the AI read of a just-loaded picker reuses its data). */
  noTools?: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Pull the control markers out of a reply so they never reach the chat text:
 *  - `ADD: <id> [x<qty>]` lines        -> deterministic add-to-cart instructions
 *  - `BEST/HEALTHY/WARN: <id> — why`   -> card flags
 *  - `MACRO: <id> <kcal>kcal <g>g`     -> per-item nutrition for the macro meter
 *  - `COMPARE: winner=<id> | verdict`  -> structured compare verdict (+ `NOTE:`)
 *  - `STEPS:` / `DISHES:`              -> cook-with-me steps / dish search
 *  - a trailing `SUGGESTIONS: a | b | c` line -> dynamic follow-up chips
 */
function extractMarkers(s: string): {
  prose: string;
  chips: string[] | null;
  adds: { id: string; quantity: number }[];
  removes: string[];
  ingredients: string[];
  controls: { action: string; value?: string }[];
  bests: { id: string; reason: string }[];
  warns: { id: string; reason: string }[];
  steps: { text: string; seconds?: number }[];
  dishQueries: string[];
  healthies: { id: string; reason: string }[];
  macros: { id: string; kcal: number; protein: number }[];
  comparison: ComparisonAcc | null;
} {
  // Some models bold the marker keyword ("**BEST:** id"); normalise so it parses.
  let prose = s.replace(
    /^([ \t>-]*)\*\*(ADD|REMOVE|INGREDIENTS|SHOPPING LIST|CONTROL|BEST|HEALTHY|WARN|MACRO|COMPARE|NOTE|STEPS?|DISHES|SUGGESTIONS):?\*\*:?/gim,
    "$1$2:",
  );
  const adds: { id: string; quantity: number }[] = [];
  const removes: string[] = [];
  const ingredients: string[] = [];
  const controls: { action: string; value?: string }[] = [];
  const bests: { id: string; reason: string }[] = [];
  const healthies: { id: string; reason: string }[] = [];
  const warns: { id: string; reason: string }[] = [];
  const steps: { text: string; seconds?: number }[] = [];
  const dishQueries: string[] = [];
  const macros: { id: string; kcal: number; protein: number }[] = [];
  let comparison: ComparisonAcc | null = null;

  // ADD: <id> [x<qty>]
  prose = prose.replace(
    /^[ \t>*-]*ADD:\s*([A-Za-z0-9_-]+)\s*(?:x\s*(\d+))?[^\n]*$/gim,
    (_m, id: string, qty?: string) => {
      adds.push({ id, quantity: Math.max(1, Number(qty) || 1) });
      return "";
    },
  );

  // REMOVE: <id>
  prose = prose.replace(
    /^[ \t>*-]*REMOVE:\s*([A-Za-z0-9_-]+)[^\n]*$/gim,
    (_m, id: string) => {
      removes.push(id);
      return "";
    },
  );

  // INGREDIENTS / SHOPPING LIST: a | b | c or a, b, c
  prose = prose.replace(
    /^[ \t>*-]*(?:INGREDIENTS|SHOPPING\s*LIST):\s*([^\n]+)$/gim,
    (_m, list: string) => {
      const parts = list.includes("|") ? list.split("|") : list.split(",");
      for (const it of parts) {
        const v = it.trim().replace(/^["'\-•\s]+|["'\s]+$/g, "");
        if (v && v.length < 50) ingredients.push(v);
      }
      return "";
    },
  );

  // CONTROL: action=value
  prose = prose.replace(
    /^[ \t>*-]*CONTROL:\s*([a-zA-Z0-9_-]+)(?:=([^\n]+))?$/gim,
    (_m, action: string, value?: string) => {
      controls.push({ action: action.trim(), value: value?.trim() });
      return "";
    },
  );

  // BEST: <id> — <reason>
  prose = prose.replace(
    /^[ \t>*-]*BEST:\s*([A-Za-z0-9_-]+)(?:\s*[-—:]\s*([^\n]+))?$/gim,
    (_m, id: string, reason?: string) => {
      bests.push({ id, reason: (reason || "Best pick").trim() });
      return "";
    },
  );

  // HEALTHY: <id> — <reason>
  prose = prose.replace(
    /^[ \t>*-]*HEALTHY:\s*([A-Za-z0-9_-]+)(?:\s*[-—:]\s*([^\n]+))?$/gim,
    (_m, id: string, reason?: string) => {
      healthies.push({ id, reason: (reason || "Healthiest option").trim() });
      return "";
    },
  );

  // WARN: <id> — <reason>
  prose = prose.replace(
    /^[ \t>*-]*WARN:\s*([A-Za-z0-9_-]+)(?:\s*[-—:]\s*([^\n]+))?$/gim,
    (_m, id: string, reason?: string) => {
      warns.push({ id, reason: (reason || "Note").trim() });
      return "";
    },
  );

  // MACRO: <id> <kcal>kcal <protein>g
  prose = prose.replace(
    /^[ \t>*-]*MACRO:\s*([A-Za-z0-9_-]+)\s+(\d+)\s*kcal(?:\s+(\d+)\s*g)?[^\n]*$/gim,
    (_m, id: string, kcal: string, protein?: string) => {
      macros.push({
        id,
        kcal: Number(kcal) || 0,
        protein: Number(protein) || 0,
      });
      return "";
    },
  );

  // COMPARE: winner=<id> | <verdict>
  prose = prose.replace(
    /^[ \t>*-]*COMPARE:\s*winner=([A-Za-z0-9_-]+)\s*\|\s*([^\n]+)$/gim,
    (_m, winnerId: string, verdict: string) => {
      if (!comparison) comparison = { notes: [] };
      comparison.winnerId = winnerId.trim();
      comparison.verdict = verdict.trim();
      return "";
    },
  );

  // NOTE: <id> — <note>
  prose = prose.replace(
    /^[ \t>*-]*NOTE:\s*([A-Za-z0-9_-]+)\s*[-—:]\s*([^\n]+)$/gim,
    (_m, id: string, note: string) => {
      if (!comparison) comparison = { notes: [] };
      comparison.notes.push({ id: id.trim(), note: note.trim() });
      return "";
    },
  );

  // STEPS: block — one step per following line, optional timer like (8m) / (90s)
  // / (20 min), ending at a blank line, another marker, or the end of the reply.
  prose = prose.replace(
    /^[ \t>*-]*STEPS:[ \t]*\n((?:[ \t]*(?!SUGGESTIONS:)[^\n]+\n?)+)/gim,
    (_m, block: string) => {
      for (const rawLine of block.split("\n")) {
        const lineText = rawLine
          .replace(/^[ \t]*(?:\d+[.)]|[-*•])?[ \t]*/, "")
          .trim();
        if (!lineText) continue;
        const timer = lineText.match(/\((\d+)\s*(s|sec|secs|seconds|m|min|mins|minutes)\)\s*$/i);
        const seconds = timer
          ? Number(timer[1]) * (/^s/i.test(timer[2]) ? 1 : 60)
          : undefined;
        steps.push({
          text: timer ? lineText.slice(0, timer.index).trim() : lineText,
          seconds,
        });
      }
      return "";
    },
  );

  // STEP: <text> [~<seconds>s]
  prose = prose.replace(
    /^[ \t>*-]*STEP:\s*([^\n~]+)(?:~\s*(\d+)\s*s)?[^\n]*$/gim,
    (_m, stepText: string, seconds?: string) => {
      steps.push({
        text: stepText.trim(),
        seconds: seconds ? Number(seconds) : undefined,
      });
      return "";
    },
  );

  // DISHES: query1 | query2
  prose = prose.replace(
    /^[ \t>*-]*DISHES:\s*([^\n]+)$/gim,
    (_m, list: string) => {
      for (const it of list.split("|")) {
        const v = it.trim().replace(/^["'\-•\s]+|["'\s]+$/g, "");
        if (v) dishQueries.push(v);
      }
      return "";
    },
  );

  // Dynamic chips: SUGGESTIONS: a | b | c — the last such line wins; every
  // occurrence is stripped so none leaks into the visible reply.
  let chips: string[] | null = null;
  prose = prose.replace(/^[ \t>*-]*SUGGESTIONS:\s*([^\n]+)$/gim, (_m, raw: string) => {
    const items = raw
      .split("|")
      .map((s) => s.trim().replace(/^["'\-•\s]+|["'\s]+$/g, ""))
      .filter((s) => s.length > 0 && s.length <= 60)
      .slice(0, 4);
    if (items.length) chips = items;
    return "";
  });

  // Strip empty/filler narration from head
  const narration =
    /^\s*(?:(?:now|so|ok(?:ay)?|alright|great)[, ]+)*(?:let me|let's|i['’]?ll|i will|first,?\s*let me|allow me to)\b[^:.\n]{0,90}[:.]\s*/i;
  for (let i = 0; i < 4; i++) {
    const stripped = prose.replace(narration, "");
    if (stripped === prose) break;
    if (stripped.trim().length === 0) break;
    prose = stripped;
  }

  if (ingredients.length === 0) {
    const listBlockMatch = s.match(/(?:ingredients|shopping\s*list)[\s\S]*?(?:(?:\n\s*[-*•]\s*[^\n]+)+)/i);
    if (listBlockMatch) {
      const bulletLines = listBlockMatch[0].match(/^[ \t]*[-*•]\s*([^\n]+)$/gm);
      if (bulletLines) {
        for (const bl of bulletLines) {
          const clean = bl.replace(/^[ \t]*[-*•]\s*/, "").replace(/\([^\)]*\)/g, "").trim();
          if (clean && clean.length > 1 && clean.length < 40 && !/^(steps?|method|instructions?)/i.test(clean)) {
            ingredients.push(clean);
          }
        }
      }
    }
  }

  prose = prose.replace(/\n{3,}/g, "\n\n").trim();
  return {
    prose,
    chips,
    adds,
    removes,
    ingredients,
    controls,
    bests,
    warns,
    steps,
    dishQueries,
    healthies,
    macros,
    comparison,
  };
}

/**
 * Turn one chunk of assistant text into the ChatStreamEvents it implies.
 */
export function* emitAssistantText(
  text: string,
  service: Service,
  lineBySpin: Map<string, ProductLine>,
  foodById: Map<string, FoodResolved>,
  userMessage?: string,
  /** the picker open in the thread (PICK lines are routed to it) */
  activePicker?: Pick<ActivePicker, "kind" | "messageId">,
): Generator<ChatStreamEvent> {
  // Plan / isolation markers first (ITINERARY, PLAN TITLE, HANDOFF).
  const planned0 = extractPlanMarkers(text, service);
  // PICK: date=… | time=… | ticket=… — a selection inside the open picker.
  const picked = extractPickMarkers(planned0.rest);
  // WHY: <pickId> — reason — the model's words for the picker's AI PICKS.
  const whys = extractWhyMarkers(picked.rest);
  // Food: MEAL / MEALITEM — the one-sentence order as ONE approvable proposal.
  const meal = service === "food" ? resolveMealPlan(whys.rest, foodById) : { rest: whys.rest, plan: null };
  const planned = { ...planned0, rest: meal.rest };
  const {
    prose,
    chips,
    adds,
    removes,
    ingredients,
    controls,
    bests,
    warns,
    steps,
    dishQueries,
    healthies,
    macros,
    comparison,
  } = extractMarkers(planned.rest);

  // Fallback: recipe ingredient detection if user asked to cook or order ingredients for a dish
  if (service === "instamart" && ingredients.length === 0) {
    const msg = (userMessage || "").toLowerCase();
    const txt = text.toLowerCase();
    if (
      msg.includes("ingredient") ||
      msg.includes("cook") ||
      msg.includes("recipe") ||
      msg.includes("shopping list") ||
      msg.includes("required item") ||
      txt.includes("shopping list") ||
      txt.includes("ingredients")
    ) {
      const fallback = getDishIngredients(msg || txt);
      if (fallback.length > 0) {
        ingredients.push(...fallback);
      }
    }
  }

  if (prose) {
    yield { type: "text", delta: prose };
  }

  for (const p of picked.picks) {
    const target =
      service === "scenes" || service === "dineout"
        ? service
        : activePicker?.kind ??
          (p.ticketId || p.ticketName || p.qty || p.showId ? "scenes" : p.guests || p.deal ? "dineout" : undefined);
    if (!target) continue;
    yield {
      type: "pickerSelect",
      target,
      ...(activePicker && activePicker.kind === target ? { messageId: activePicker.messageId } : {}),
      ...p,
    };
  }

  if (whys.reasons.length) {
    const target = service === "scenes" || service === "dineout" ? service : activePicker?.kind;
    if (target) {
      yield {
        type: "pickerReasons",
        target,
        ...(activePicker && activePicker.kind === target ? { messageId: activePicker.messageId } : {}),
        reasons: whys.reasons,
      };
    }
  }

  if (planned.itinerary && service === "plan") {
    yield { type: "itinerary", ...planned.itinerary };
  }

  for (const h of planned.handoffs) {
    yield { type: "handoff", ...h };
  }

  if (chips && chips.length > 0) {
    yield { type: "chips", items: chips };
  }

  if (steps.length > 0) {
    yield { type: "steps", steps };
  }

  if (
    dishQueries.length === 0 &&
    service === "food" &&
    userMessage &&
    !prose.includes("?") &&
    /(pizza|biryani|burger|pasta|noodles|curry|dosa|momos|sandwich|wrap|roll|fries)/i.test(userMessage)
  ) {
    dishQueries.push(userMessage.trim());
  }

  if (meal.plan) {
    // the plan IS the answer — don't also run the keyword dish-search fallback
    dishQueries.splice(0, dishQueries.length, ...dishQueries.filter((q) => q !== (userMessage || "").trim()));
    yield { type: "foodMealPlan", plan: meal.plan };
  }

  for (const q of dishQueries) {
    yield { type: "dishQuery", query: q };
  }

  if (comparison && comparison.winnerId) {
    yield {
      type: "comparison",
      winnerId: comparison.winnerId,
      verdict: comparison.verdict || "Winner based on value and quality.",
      notes: comparison.notes.length ? comparison.notes : undefined,
    };
  }

  for (const b of bests) {
    yield { type: "bestPick", id: b.id, reason: b.reason };
  }
  for (const h of healthies) {
    yield { type: "healthyPick", id: h.id, reason: h.reason };
  }
  for (const w of warns) {
    yield { type: "warn", id: w.id, reason: w.reason };
  }
  if (macros.length > 0) {
    yield { type: "macros", items: macros };
  }

  for (const c of controls) {
    yield { type: "control", action: c.action, value: c.value };
  }

  for (const id of removes) {
    yield {
      type: "removeFromCart",
      target: service === "food" ? "food" : "instamart",
      id,
    };
  }

  for (const add of adds) {
    let im = lineBySpin.get(add.id);
    if (!im) {
      const target = add.id.toLowerCase();
      for (const [spinId, line] of lineBySpin.entries()) {
        if (spinId.toLowerCase() === target || line.name.toLowerCase().includes(target)) {
          im = line;
          break;
        }
      }
    }
    if (im) {
      yield {
        type: "addToCart",
        target: "instamart",
        quantity: add.quantity,
        line: im,
      };
      continue;
    }
    let f = foodById.get(add.id);
    if (!f) {
      const target = add.id.toLowerCase();
      for (const [menuId, resolved] of foodById.entries()) {
        if (menuId.toLowerCase() === target || resolved.line.name.toLowerCase().includes(target)) {
          f = resolved;
          break;
        }
      }
    }
    if (f) {
      yield {
        type: "addToCart",
        target: "food",
        quantity: add.quantity,
        restaurantId: f.restaurantId,
        restaurantName: f.restaurantName,
        line: f.line,
      };
    }
  }

  // (No "auto-add the first item" fallback: the cart only changes on an explicit
  // ADD from the model or a tap by the user — the docs require user choice.)

  if (ingredients.length > 0) {
    yield {
      type: "ingredients",
      dish: "",
      items: ingredients,
    };
  }
}

/** Pre-seed cache maps with items from the client's catalog. */
export function seedFromCatalog(
  ctx: PromptContext,
  lineBySpin: Map<string, ProductLine>,
  foodById: Map<string, FoodResolved>,
  restNameById: Map<string, string>,
): void {
  const c = ctx.catalog;
  if (!c) return;
  if (Array.isArray(c.products)) {
    for (const p of c.products) {
      if (p && p.spinId) {
        lineBySpin.set(p.spinId, p);
      }
    }
  }
  if (Array.isArray(c.dishes)) {
    for (const d of c.dishes) {
      if (d?.line?.menuItemId) {
        foodById.set(d.line.menuItemId, d);
        if (d.restaurantId && d.restaurantName) {
          restNameById.set(d.restaurantId, d.restaurantName);
        }
      }
    }
  }
}

/** User-facing status label for a tool call. */
export function statusLabel(bareTool: string, q: string): string | null {
  switch (bareTool) {
    case "search_products":
      return q ? `Searching Instamart for “${q}”…` : "Searching Instamart…";
    case "your_go_to_items":
      return "Checking your usuals…";
    case "search_restaurants":
      return q ? `Finding restaurants for “${q}”…` : "Finding restaurants…";
    case "get_restaurant_menu":
      return "Checking the menu…";
    case "search_menu":
      return q ? `Searching menu for “${q}”…` : "Searching menu…";
    case "search_restaurants_dineout":
      return q ? `Finding places to dine for “${q}”…` : "Searching dining spots…";
    case "get_restaurant_details":
      return "Checking restaurant details & offers…";
    case "get_available_slots":
      return "Checking table reservation slots…";
    case "get_booking_status":
      return "Checking your table booking…";
    case "discover_events":
      return "Discovering live events near you…";
    case "search_events":
      return q ? `Searching events for “${q}”…` : "Searching events…";
    case "get_events_collection":
      return "Loading events in this category…";
    case "get_event_details":
      return "Loading event & venue details…";
    case "list_event_shows":
      return "Checking show times & tickets…";
    case "get_food_orders":
    case "track_food_order":
      return "Checking your food order…";
    case "get_food_delivery_status":
      return "Checking the delivery ETA…";
    case "get_food_order_details":
      return "Opening your order details…";
    case "get_food_cart":
    case "get_cart":
      return "Reading your cart…";
    case "build_basket":
      return "Building your basket — searching every item in parallel…";
    case "get_payment_options":
      return "Checking how you can pay…";
    case "fetch_food_coupons":
      return "Checking coupons for your cart…";
    case "get_event_venue_info":
      return "Loading venue info…";
    case "get_saved_locations":
      return "Checking your saved places…";
    case "get_orders":
    case "get_event_booking_status":
    case "track_order":
    case "get_delivery_status":
      return "Checking your orders & bookings…";
    default:
      return null;
  }
}

/** Map one (tool, payload) pair into zero-or-one card events. */
export function mapToolResult(
  meta: { bareTool: string; query: string; input: Record<string, unknown> },
  payload: unknown,
  _ctx: PromptContext,
): ChatStreamEvent[] {
  switch (meta.bareTool) {
    case "search_products": {
      const { products, similarProducts, nextOffset } = mapProductsPayload(payload);
      const out: ChatStreamEvent[] = [];
      if (products.length) out.push({ type: "products", query: meta.query, products, nextOffset });
      // Docs: show similarProducts in their own "Similar items" section.
      if (similarProducts.length) {
        out.push({
          type: "products",
          query: meta.query ? `Similar to “${meta.query}”` : "Similar items",
          products: similarProducts,
          nextOffset: null,
        });
      }
      return out;
    }
    case "your_go_to_items": {
      const { products } = mapProductsPayload(payload);
      if (products.length === 0) return [];
      return [{ type: "suggestions", products }];
    }
    // Instamart order tracking (each tool has its own documented shape).
    case "get_orders": {
      const obj = isRecord(payload) ? payload : {};
      const orders = Array.isArray(obj.orders) ? obj.orders.filter(isRecord) : [];
      const history = pastInstamartOrders(payload);
      const out: ChatStreamEvent[] = history.length
        ? [{ type: "orderHistory", service: "instamart", orders: history }]
        : [];
      // A live tracker only for an order that is still on its way.
      const active = orders.find((o) => o.isActive === true);
      const tr = active ? imTrackerFromOrder(active) : null;
      if (tr && active) {
        const orderId = str(active.orderId);
        const items = [orderId ? `Order #${orderId}` : "", tr.items ?? ""].filter(Boolean).join(" · ");
        out.push({ type: "tracker", ...tr, ...(items ? { items } : {}) });
      }
      return out;
    }
    case "track_order": {
      const tr = isRecord(payload) ? imTrackerFromTrackOrder(payload) : null;
      return tr ? [{ type: "tracker", ...tr }] : [];
    }
    case "get_delivery_status": {
      const tr = isRecord(payload) ? imTrackerFromDeliveryStatus(payload) : null;
      return tr ? [{ type: "tracker", ...tr }] : [];
    }
    // App-side composite (runner.ts → instamart-basket.ts): one basket card.
    case "build_basket": {
      const b = payload as InstamartBasket | null;
      return b && Array.isArray(b.lines) && (b.lines.length || b.missing?.length) ? [{ type: "basket", basket: b }] : [];
    }
    case "search_restaurants": {
      const restaurants = mapFoodRestaurants(payload);
      if (restaurants.length === 0) return [];
      return [{ type: "foodRestaurants", query: meta.query, restaurants }];
    }
    case "get_restaurant_menu": {
      // Browse view (paginated over categories; nested categories flattened).
      const restaurantName = str(meta.input.restaurantName);
      const restaurantId = str(meta.input.restaurantId);
      const menu = normalizeMenu(payload, restaurantName, restaurantId);
      if (menu.categories.length === 0) return [];
      return [
        {
          type: "menu",
          restaurantId: menu.restaurantId,
          restaurantName: menu.restaurantName,
          categories: menu.categories,
          page: menu.page,
          hasMore: menu.hasMore,
          ...(menu.restaurant ? { restaurant: menu.restaurant } : {}),
          ...(menu.totalCategories ? { totalCategories: menu.totalCategories } : {}),
        },
      ];
    }
    case "search_menu": {
      // Items carry snake_case ids (menu_item_id / restaurant_id) and their own
      // restaurant; the scope arg is `restaurantIdOfAddedItem`.
      const scopedId = str(meta.input.restaurantIdOfAddedItem);
      const { dishes } = mapSearchMenu(payload, scopedId, str(meta.input.restaurantName));
      if (dishes.length === 0) return [];
      const ids = new Set(dishes.map((d) => d.restaurantId));
      const single = ids.size === 1 ? dishes[0] : null;
      return [
        {
          type: "menu",
          restaurantId: single?.restaurantId ?? "",
          restaurantName: single?.restaurantName ?? "",
          categories: [{ title: meta.query ? `Matches for “${meta.query}”` : "Matches", items: dishes }],
        },
      ];
    }
    // Dineout — payloads come from fetchDineoutToolPayload (runner.ts): search
    // is already rendered photo cards, slots already read from `_meta.slots`.
    // An empty search means nothing matched: no cards, never stand-ins.
    case "search_restaurants_dineout": {
      const { restaurants, total, nextOffset, latitude, longitude } = mapDineoutSearch(payload);
      if (restaurants.length === 0) return [];
      const q = str(meta.input.query) || meta.query;
      // total + nextOffset from Swiggy's "Found N … offset=X" header → "Load more" on the cards.
      const paging =
        q && latitude !== undefined && longitude !== undefined ? { query: q, latitude, longitude, total, nextOffset } : undefined;
      return [{ type: "dineoutRestaurants", query: meta.query, restaurants, paging }];
    }
    case "get_restaurant_details": {
      const r = mapDineoutDetails(
        payload,
        typeof meta.input.latitude === "number" ? meta.input.latitude : undefined,
        typeof meta.input.longitude === "number" ? meta.input.longitude : undefined,
      );
      if (!r) return [];
      return [{ type: "dineoutRestaurants", query: meta.query, restaurants: [r] }];
    }
    case "get_available_slots": {
      const view = mapDineoutSlots(payload, {
        restaurantId: str(meta.input.restaurantId),
        restaurantName: str(meta.input.restaurantName),
        date: str(meta.input.date),
        latitude: typeof meta.input.latitude === "number" ? meta.input.latitude : undefined,
        longitude: typeof meta.input.longitude === "number" ? meta.input.longitude : undefined,
      });
      if (!view) return [];
      return [{ type: "dineoutSlots", ...view }];
    }
    // Scenes — shapes per docs/swiggy-mcp/LIVE-SAMPLES.md. Empty results mean
    // nothing matched: no cards (the model tells the user), never stand-ins.
    case "discover_events":
    case "get_events_collection": {
      const coords = scenesCoords(meta.input);
      const { events, collections } = mapScenesEvents(payload, coords);
      if (events.length === 0 && collections.length === 0) {
        // discover_events is empty server-side today: hand the agent's keyword
        // fallback (tools.ts) the user's location + city. Draws no card.
        if (meta.bareTool !== "discover_events" || coords.latitude === undefined || coords.longitude === undefined) {
          return [];
        }
        const city = resolveUserCity(coords, _ctx.addressLine);
        return [
          {
            type: "scenesEvents",
            events: [],
            emptyDiscover: { latitude: coords.latitude, longitude: coords.longitude, ...(city ? { city } : {}) },
          },
        ];
      }
      return [
        {
          type: "scenesEvents",
          query: meta.query,
          events,
          collections: collections.length ? collections : undefined,
        },
      ];
    }
    case "search_events": {
      // Live search returns events from EVERY city ("Area, City"): keep the
      // user's city when anything matched there, else show all (with city).
      // A saved-location search (addressId) is filtered to THAT place's city.
      const coords = scenesCoords(meta.input);
      const { events } = mapScenesEvents(payload, coords);
      const city = savedLocationCity(meta.input.addressId) ?? resolveUserCity(coords, _ctx.addressLine);
      const local = filterToCity(events, city);
      const shown = (local.length ? local : events).slice(0, 12);
      if (shown.length === 0) return [];
      return [{ type: "scenesEvents", query: meta.query, events: shown }];
    }
    case "get_saved_locations":
      // No card: the model lists them (compact payload). Remembers each id's
      // address line so a later search_events{addressId} keeps that city.
      mapSavedLocations(payload);
      return [];
    case "get_event_details": {
      const event = normalizeEventDetails(payload, scenesCoords(meta.input));
      if (!event) return [];
      return [{ type: "scenesEvents", query: meta.query, events: [event] }];
    }
    case "get_event_venue_info": {
      const events = mapEventVenueInfo(payload, scenesCoords(meta.input));
      if (events.length === 0) return [];
      return [{ type: "scenesEvents", query: meta.query, events }];
    }
    case "list_event_shows": {
      const listing = mapShowListing(payload, {
        eventId: str(meta.input.eventId),
        eventTitle: str(meta.input.eventTitle) || undefined,
        venueId: str(meta.input.venueId) || undefined,
        ...scenesCoords(meta.input),
      });
      if (listing.shows.length === 0) return [];
      // No venueId → the listing spans venues and is not safe to book from; the
      // picker re-fetches the venue-scoped listing (get_event_details first).
      return [{ type: "scenesShows", ...listing }];
    }
    case "get_booking_status": {
      // Dineout reservation status — only what Swiggy returned; no default status.
      const b = mapDineoutBooking(payload);
      if (!b) return [];
      return [
        {
          type: "bookingTracker",
          kind: "dineout",
          title: b.restaurantName ? `Table at ${b.restaurantName}` : "Table reservation",
          status: b.status,
          details: describeDineoutBooking(b),
          orderId: b.orderId,
        },
      ];
    }
    case "get_event_booking_status": {
      // Scenes booking — returned under `booking` (not `data`); status verbatim
      // (PROCESSING is not final), no defaults.
      const b = mapEventBooking(payload);
      if (!b) return [];
      return [
        {
          type: "bookingTracker",
          kind: "scenes",
          title: b.title || (b.venueName ? `Tickets at ${b.venueName}` : "Event tickets"),
          status: b.status,
          details: describeScenesBooking(b),
          orderId: b.orderId,
        },
      ];
    }
    // Food order tracking (each tool has its own documented shape).
    case "get_food_orders": {
      const history = pastFoodOrders(payload);
      const out: ChatStreamEvent[] = history.length
        ? [{ type: "orderHistory", service: "food", orders: history }]
        : [];
      // A live tracker only when an order is still active.
      if (history.some((o) => o.active)) {
        const tr = trackerFromFoodOrders(payload);
        if (tr) out.push({ type: "tracker", ...tr });
      }
      return out;
    }
    case "track_food_order": {
      const tr = trackerFromTrackFoodOrder(payload);
      return tr ? [{ type: "tracker", ...tr }] : [];
    }
    case "get_food_delivery_status": {
      const tr = foodTrackerFromDeliveryStatus(payload);
      return tr ? [{ type: "tracker", ...tr }] : [];
    }
    default:
      return [];
  }
}

function errMsg(err: unknown): string {
  if (isAuthError(err)) {
    return formatErrorMarkdown(classifyProviderError(401, "swiggy token expired"));
  }
  const rawMsg = err instanceof Error ? err.message : String(err || "Unexpected runtime error");
  return formatErrorMarkdown(classifyProviderError(errorStatus(err) ?? 500, rawMsg));
}

/** Wrap a raw runner so it always ends with a terminal `done` and surfaces errors. */
async function* finalize(
  gen: AsyncGenerator<ChatStreamEvent>,
): AsyncGenerator<ChatStreamEvent> {
  try {
    for await (const ev of gen) yield ev;
  } catch (err) {
    yield { type: "error", message: errMsg(err) };
  } finally {
    yield { type: "done" };
  }
}

/**
 * Public entry point. Runs the turn across the provider chain
 * (Claude Haiku → Groq key 1 → Groq key 2 → Gemini key 1 → Gemini key 2);
 * photo turns only use vision-capable models. See providers.ts / runner.ts.
 */
export async function* runChat(
  args: RunChatArgs,
): AsyncGenerator<ChatStreamEvent> {
  yield* finalize(runChatChain(args));
}
