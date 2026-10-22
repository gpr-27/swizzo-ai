// Food tab "AI everywhere" — the pure, framework-free half (used by the server
// routes, the agent's marker parser, the client cards and
// scripts/verify-food-instamart.ts). Every fact these helpers state comes from
// a Swiggy payload the caller passes in; nothing here invents a dish, price,
// rating, coupon or saving.
//
//  - dedupeAddonGroups: Swiggy repeats an add-on group once per portion size
//    (Behrouz: "Choose Accompaniment", "Choose Accompaniment.", "-", "-." — all
//    required). Before the dish is in the cart we show ONE of each; the real,
//    variant-specific groups come from the cart's `valid_addons`.
//  - pickVariant / pickDefaultAddons: the AI's sensible defaults (portion that
//    fits "for 2", the fullest free accompaniment) with a one-line why.
//  - menuInsights: the AI read of a menu (top rated, bestsellers, best value,
//    veg, what's unavailable) + actionable chips.
//  - explainFoodBill / swiggyNudges: plain-language bill breakdown; a nudge is
//    only ever Swiggy's own words ("Add ₹40 more…").
//  - parseMealMarkers: the agent's MEAL: / MEALITEM: lines.

import type {
  FoodAddonGroup,
  FoodCart,
  FoodCartSelection,
  FoodItemCustomization,
  FoodRestaurant,
  FoodVariantGroup,
  MenuCategory,
  MenuItem,
} from "./types";
import { FOOD_ORDER_CAP } from "./types";

const inr = (n: number) => `₹${Math.round(n).toLocaleString("en-IN")}`;

/* ------------------------------ add-on groups ------------------------------ */

/** "Choose Accompaniment-." → "choose accompaniment" (Swiggy's per-variant copies). */
export function normGroupName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * Collapse near-duplicate add-on groups (same name once punctuation is
 * stripped). `variantScoped` is true when duplicates existed — a strong sign
 * the groups belong to different portion sizes, so the add-ons must be picked
 * from the cart's `valid_addons` AFTER the variant is added (search_menu docs).
 */
export function dedupeAddonGroups(groups: FoodAddonGroup[]): {
  groups: FoodAddonGroup[];
  variantScoped: boolean;
  duplicates: number;
} {
  const seen = new Map<string, FoodAddonGroup>();
  let duplicates = 0;
  for (const g of groups) {
    const key = normGroupName(g.name) || g.groupId;
    if (seen.has(key)) {
      duplicates++;
      continue;
    }
    seen.set(key, g);
  }
  return { groups: [...seen.values()], variantScoped: duplicates > 0, duplicates };
}

/** How many choices a group allows (0 / negative = unlimited, per the live schema). */
export function groupMax(g: FoodAddonGroup): number {
  return g.max > 0 ? g.max : Number.POSITIVE_INFINITY;
}

const COMBO = /(&|\band\b|\bwith\b|\+)/i;

/**
 * The AI's default for every REQUIRED add-on group (min > 0): free choices
 * first, and among free ones the "fullest" (a combo like "Mint Raita & Gulab
 * Jamun"); otherwise the cheapest. Optional groups are left empty (never
 * upsell silently). Returns the picks and one human reason per group.
 */
export function pickDefaultAddons(groups: FoodAddonGroup[]): {
  addons: FoodCartSelection["addons"];
  reasons: string[];
} {
  const addons: FoodCartSelection["addons"] = [];
  const reasons: string[] = [];
  for (const g of groups) {
    if (!(g.min > 0) || g.choices.length === 0) continue;
    const ranked = [...g.choices].sort((a, b) => {
      if (a.price !== b.price) return a.price - b.price;
      const ca = COMBO.test(a.name) ? 1 : 0;
      const cb = COMBO.test(b.name) ? 1 : 0;
      if (ca !== cb) return cb - ca;
      return b.name.length - a.name.length;
    });
    const n = Math.min(g.min, ranked.length, groupMax(g));
    const picks = ranked.slice(0, n);
    for (const c of picks) addons.push({ groupId: g.groupId, choiceId: c.id, name: c.name, price: c.price });
    const free = picks.every((c) => c.price === 0);
    const label = (g.name || "add-on").replace(/[-.\s]+$/, "");
    reasons.push(
      `${picks.map((c) => c.name).join(", ")} for "${label}" (${free ? (COMBO.test(picks[0]?.name ?? "") ? "free — the fullest free option" : "free") : `cheapest, +${inr(picks.reduce((s, c) => s + c.price, 0))}`})`,
    );
  }
  return { addons, reasons };
}

/** "dinner for 3", "for two", "serves 2" → 3 / 2 (null when no party size). */
export function partySize(text: string | undefined): number | null {
  if (!text) return null;
  const words: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6 };
  const m = text.toLowerCase().match(/\b(?:for|serves?|feeds?|of)\s+(\d+|one|two|three|four|five|six)\b/);
  if (!m) {
    const bare = text.trim().match(/^(\d+)$/);
    return bare ? Number(bare[1]) : null;
  }
  return words[m[1]] ?? (Number(m[1]) || null);
}

/**
 * Choose one option in a variant group: an exact-ish match for the hint
 * ("Serves 2", "for 2", "large"), else Swiggy's default, else the first in
 * stock. Never picks a sold-out option.
 */
export function pickVariant(
  g: FoodVariantGroup,
  hint?: string,
): { choiceId: string; name: string; reason: string } | null {
  const stock = g.choices.filter((c) => c.inStock);
  if (stock.length === 0) return null;
  const def = stock.find((c) => c.isDefault);
  const h = (hint ?? "").trim().toLowerCase();
  if (h) {
    const n = partySize(h) ?? (/^\d+$/.test(h) ? Number(h) : null);
    if (n) {
      const byServes = stock.find((c) => new RegExp(`serves\\s*${n}(?!\\d)`, "i").test(c.name));
      if (byServes) return { choiceId: byServes.id, name: byServes.name, reason: `${byServes.name} — fits ${n} people` };
    }
    const tokens = h.split(/[^a-z0-9]+/).filter((t) => t.length > 1 && !["for", "the", "serves", "serve"].includes(t));
    let best: { c: (typeof stock)[number]; score: number } | null = null;
    for (const c of stock) {
      const name = c.name.toLowerCase();
      const score = tokens.filter((t) => name.includes(t)).length;
      if (score > 0 && (!best || score > best.score)) best = { c, score };
    }
    if (best) return { choiceId: best.c.id, name: best.c.name, reason: `${best.c.name} — matches "${hint!.trim()}"` };
  }
  const c = def ?? stock[0];
  return { choiceId: c.id, name: c.name, reason: `${c.name} — ${def ? "Swiggy's default portion" : "the first available option"}` };
}

/**
 * The AI's whole pre-add selection for a customisable dish. With variants:
 * variants only (add-ons are confirmed from the cart's valid_addons after the
 * add). Without variants: the required add-on defaults from search_menu (all
 * of them valid — nothing depends on a variant).
 */
export function aiSelection(
  c: FoodItemCustomization,
  hint?: string,
): { selection: FoodCartSelection; reasons: string[]; addonsAfterAdd: boolean; extra: number } {
  const reasons: string[] = [];
  const variants: FoodCartSelection["variants"] = [];
  let extra = 0;
  for (const g of c.variantGroups) {
    const p = pickVariant(g, hint);
    if (!p) continue;
    variants.push({ groupId: g.groupId, variationId: p.choiceId, name: p.name });
    reasons.push(p.reason);
    const price = g.choices.find((x) => x.id === p.choiceId)?.price;
    if (g.pricesAreAddOns && typeof price === "number") extra += price;
  }
  const addonsAfterAdd = c.variantGroups.length > 0 && c.addonGroups.length > 0;
  let addons: FoodCartSelection["addons"] = [];
  if (!addonsAfterAdd) {
    const d = pickDefaultAddons(dedupeAddonGroups(c.addonGroups).groups);
    addons = d.addons;
    reasons.push(...d.reasons);
    extra += addons.reduce((s, a) => s + a.price, 0);
  }
  return { selection: { format: c.format, variants, addons }, reasons, addonsAfterAdd, extra };
}

/* ------------------------------- menu read --------------------------------- */

export interface MenuChip {
  label: string;
  itemId: string;
  hint?: string; // variant hint for the customizer ("for 2")
}

export interface MenuInsights {
  lines: string[];
  chips: MenuChip[];
  facts: string; // compact fact sheet for the LLM polish (numbers it may use)
}

const ratingOf = (it: MenuItem) => Number(it.rating) || 0;
const countOf = (it: MenuItem) => {
  const raw = (it.ratingCount ?? "").replace(/[^\d.kK]/g, "");
  const n = parseFloat(raw) || 0;
  return /k/i.test(raw) ? n * 1000 : n;
};

/** Short dish name for chips: drop Swiggy's parenthetical tails. */
export function shortDish(name: string, max = 28): string {
  const s = name.replace(/\s*\([^)]*\)/g, "").replace(/\s+/g, " ").trim() || name;
  return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s;
}

/** Deterministic AI read of one menu page. Only states what the data shows. */
export function menuInsights(categories: MenuCategory[], restaurant?: FoodRestaurant): MenuInsights {
  const seen = new Set<string>();
  const items: MenuItem[] = [];
  for (const c of categories) {
    for (const it of c.items) {
      if (!it.id || seen.has(it.id)) continue;
      seen.add(it.id);
      items.push(it);
    }
  }
  const lines: string[] = [];
  const chips: MenuChip[] = [];
  const facts: string[] = [];
  if (items.length === 0) return { lines, chips, facts: "" };

  const avail = items.filter((i) => i.inStock);
  const out = items.filter((i) => !i.inStock);
  const byRating = [...avail]
    .filter((i) => ratingOf(i) > 0)
    .sort((a, b) => ratingOf(b) - ratingOf(a) || countOf(b) - countOf(a));
  // a rating backed by a handful of votes is weaker than a well-reviewed 4.3
  const trusted = byRating.filter((i) => !i.ratingCount || countOf(i) >= 10);
  const top = (trusted.length ? trusted : byRating).slice(0, 2);
  const best = avail.filter((i) => i.bestseller);
  const veg = avail.filter((i) => i.veg);

  if (restaurant && restaurant.isOpen === false) {
    lines.push(`${restaurant.name} is closed right now — you can browse, but Swiggy won't take the order until it opens.`);
  }

  const tag = (i: MenuItem) =>
    [ratingOf(i) ? `★${i.rating}${i.ratingCount ? ` (${i.ratingCount})` : ""}` : "", i.bestseller ? "bestseller" : "", inr(i.price)]
      .filter(Boolean)
      .join(", ");
  if (top.length) {
    lines.push(`Top rated: ${top.map((i) => `${shortDish(i.name, 40)} (${tag(i)})`).join(" and ")}.`);
  } else if (best.length) {
    lines.push(`Bestsellers: ${best.slice(0, 2).map((i) => `${shortDish(i.name, 40)} (${inr(i.price)})`).join(" and ")}.`);
  }

  // best value: the cheapest dish that is still well rated (≥ 4.0) or a bestseller
  const valuePool = avail.filter((i) => i.price > 0 && (ratingOf(i) >= 4 || i.bestseller));
  const value = [...valuePool].sort((a, b) => a.price - b.price)[0];
  const vegTop = [...veg].sort((a, b) => Number(b.bestseller) - Number(a.bestseller) || ratingOf(b) - ratingOf(a))[0];
  const second: string[] = [];
  if (value && !top.some((t) => t.id === value.id)) second.push(`best value is ${shortDish(value.name, 40)} at ${inr(value.price)}${ratingOf(value) ? ` (★${value.rating})` : value.bestseller ? " (bestseller)" : ""}`);
  if (veg.length) {
    second.push(
      veg.length === avail.length
        ? "everything here is veg"
        : `${veg.length} of ${avail.length} dishes are veg${vegTop ? ` — ${shortDish(vegTop.name, 36)} (${tag(vegTop)}) leads` : ""}`,
    );
  } else if (avail.length) {
    second.push("no veg dishes on this page");
  }
  if (second.length) lines.push(`${second[0].charAt(0).toUpperCase()}${second[0].slice(1)}${second[1] ? `; ${second[1]}` : ""}.`);
  if (out.length) {
    lines.push(`Not available right now: ${out.slice(0, 3).map((i) => shortDish(i.name, 32)).join(", ")}${out.length > 3 ? ` +${out.length - 3} more` : ""}.`);
  }

  // chips — each one acts on a real dish
  const lead = best.find((i) => i.hasVariants) ?? best[0] ?? top[0];
  if (lead) {
    chips.push({ label: `Add the ${lead.bestseller ? "bestseller " : ""}${shortDish(lead.name)}`, itemId: lead.id });
    if (lead.hasVariants) chips.push({ label: `${shortDish(lead.name, 22)} for 2`, itemId: lead.id, hint: "for 2" });
  }
  if (top[0] && top[0].id !== lead?.id) chips.push({ label: `Add top-rated ${shortDish(top[0].name, 22)}`, itemId: top[0].id });
  if (value && !chips.some((c) => c.itemId === value.id)) chips.push({ label: `Best value: ${shortDish(value.name, 20)} ${inr(value.price)}`, itemId: value.id });
  if (vegTop && !chips.some((c) => c.itemId === vegTop.id)) chips.push({ label: `Veg pick: ${shortDish(vegTop.name, 22)}`, itemId: vegTop.id });

  // the fact sheet the LLM may phrase (it must not add numbers)
  if (restaurant) {
    facts.push(
      `Restaurant: ${restaurant.name}${restaurant.rating ? ` ★${restaurant.rating}` : ""}${restaurant.etaRange ? ` · ${restaurant.etaRange}` : ""}${restaurant.costForTwo ? ` · ${restaurant.costForTwo}` : ""}${restaurant.isOpen === false ? " · CLOSED now" : ""}`,
    );
  }
  for (const i of items.slice(0, 40)) {
    facts.push(
      `- ${shortDish(i.name, 50)} | ${inr(i.price)} | ${i.veg ? "veg" : "non-veg"}${i.rating ? ` | ★${i.rating}${i.ratingCount ? ` (${i.ratingCount})` : ""}` : ""}${i.bestseller ? " | bestseller" : ""}${i.hasVariants ? " | portions" : ""}${i.inStock ? "" : " | UNAVAILABLE"}`,
    );
  }
  return { lines: lines.slice(0, 3), chips: chips.slice(0, 4), facts: facts.join("\n") };
}

/* -------------------------------- bill read -------------------------------- */

/**
 * Swiggy's own "add ₹N more …" style lines (coupon subtitles / descriptions,
 * the cart's delivery subtitle, a cart notice). Verbatim — never computed.
 */
export function swiggyNudges(texts: (string | undefined | null)[]): string[] {
  const out: string[] = [];
  for (const raw of texts) {
    const t = (raw ?? "").replace(/\s+/g, " ").trim();
    if (!t) continue;
    if (/\badd\s+(?:items?\s+worth\s+)?₹\s?\d+|₹\s?\d+\s+more\b|\bmore\s+to\s+(?:get|avail|unlock)\b/i.test(t) && !out.includes(t)) out.push(t);
  }
  return out.slice(0, 2);
}

export interface BillRead {
  lines: string[];
  nudges: string[];
  savings: number; // Σ real savings Swiggy reported (coupon + delivery strike-off + line discounts)
  facts: string;
}

/** Plain-language breakdown of Swiggy's real bill (get_food_cart pricing / offers). */
export function explainFoodBill(cart: FoodCart): BillRead {
  const lines: string[] = [];
  const facts: string[] = [];
  if (!cart.items.length || cart.synced === false) {
    return { lines, nudges: [], savings: 0, facts: "" };
  }
  const coupon = cart.appliedCoupon && cart.appliedCoupon.savings > 0 ? cart.appliedCoupon : null;
  const strike = cart.deliveryChargeStrikeoff && cart.deliveryChargeStrikeoff > cart.deliveryCharge ? cart.deliveryChargeStrikeoff - cart.deliveryCharge : 0;
  const lineDisc = cart.items.reduce(
    (s, l) => s + (l.lineSubtotal !== undefined && l.lineFinal !== undefined ? Math.max(0, l.lineSubtotal - l.lineFinal) : 0),
    0,
  );
  const free = cart.freeDeliveryApplied === true || cart.deliveryCharge === 0;
  const parts = [
    `food ${inr(cart.itemTotal)}`,
    cart.taxes > 0 ? `taxes & charges ${inr(cart.taxes)}` : "",
    free ? "free delivery" : `delivery ${inr(cart.deliveryCharge)}`,
    coupon ? `minus ${inr(coupon.savings)} coupon` : "",
  ].filter(Boolean);
  lines.push(`You pay ${inr(cart.toPay)}: ${parts.join(" + ").replace("+ minus", "−")}.`);
  const saved: string[] = [];
  if (coupon) saved.push(`${coupon.code} takes off ${inr(coupon.savings)}`);
  if (strike) saved.push(`delivery is ${inr(strike)} cheaper than usual (${inr(cart.deliveryChargeStrikeoff!)} → ${free ? "free" : inr(cart.deliveryCharge)})`);
  else if (free && cart.freeDeliveryApplied) saved.push("Swiggy waived the delivery fee");
  if (lineDisc > 0) saved.push(`the restaurant's dish discounts save ${inr(lineDisc)}`);
  const savings = (coupon?.savings ?? 0) + strike + lineDisc;
  if (saved.length) lines.push(`Savings: ${saved.join("; ")}${savings > 0 && saved.length > 1 ? ` — ${inr(savings)} in all` : ""}.`);
  if (cart.toPay > FOOD_ORDER_CAP) {
    lines.push(`That's ${inr(cart.toPay - FOOD_ORDER_CAP)} over Swiggy's ${inr(FOOD_ORDER_CAP)} limit for these orders — remove something to place it.`);
  } else if (cart.taxes > 0 && cart.itemTotal > 0) {
    lines.push(`Taxes & charges are ${Math.round((cart.taxes / cart.itemTotal) * 100)}% of the food (Swiggy's GST, packaging and platform fees).`);
  }
  const nudges = swiggyNudges([
    cart.deliverySubtitle,
    cart.notice,
    ...(cart.couponReport?.others ?? []).map((o) => o.reason),
  ]);
  facts.push(
    `item_total ${inr(cart.itemTotal)}; taxes_and_charges ${inr(cart.taxes)}; delivery_charge ${inr(cart.deliveryCharge)}${cart.deliveryChargeStrikeoff ? ` (strike-off ${inr(cart.deliveryChargeStrikeoff)})` : ""}; free_delivery ${free ? "yes" : "no"}; coupon ${coupon ? `${coupon.code} −${inr(coupon.savings)}` : "none"}; line discounts ${inr(lineDisc)}; to_pay ${inr(cart.toPay)}; total savings ${inr(savings)}; cap ${inr(FOOD_ORDER_CAP)}${strike ? `; delivery saving ${inr(strike)}` : ""}${cart.taxes > 0 && cart.itemTotal > 0 ? `; taxes are ${Math.round((cart.taxes / cart.itemTotal) * 100)}% of food` : ""}${cart.toPay > FOOD_ORDER_CAP ? `; over cap by ${inr(cart.toPay - FOOD_ORDER_CAP)}` : ""}`,
  );
  if (nudges.length) facts.push(`Swiggy says: ${nudges.join(" | ")}`);
  return { lines: lines.slice(0, 3), nudges, savings, facts: facts.join("\n") };
}

/* ------------------------------ meal markers ------------------------------- */

export interface MealMarkerItem {
  id: string;
  quantity: number;
  option?: string;
  reason: string;
}

/**
 * Parse (and strip) the agent's one-sentence-order markers:
 *   MEAL: <title> | budget=<₹> | people=<n>
 *   MEALITEM: <menu_item_id> x<qty> | <portion / option or -> | <1-line reason>
 */
export function parseMealMarkers(text: string): {
  rest: string;
  meal: { title: string; budget?: number; people?: number } | null;
  items: MealMarkerItem[];
} {
  let meal: { title: string; budget?: number; people?: number } | null = null;
  const items: MealMarkerItem[] = [];
  let rest = text.replace(/^([ \t>-]*)\*\*(MEAL|MEALITEM):?\*\*:?/gim, "$1$2:");
  rest = rest.replace(/^[ \t>*-]*MEAL:\s*([^\n]+)$/gim, (_m, body: string) => {
    const parts = body.split("|").map((p) => p.trim());
    const out: { title: string; budget?: number; people?: number } = { title: "" };
    const title: string[] = [];
    for (const p of parts) {
      const kv = p.match(/^(budget|people)\s*[=:]\s*₹?\s*(\d+)/i);
      if (kv) {
        if (kv[1].toLowerCase() === "budget") out.budget = Number(kv[2]);
        else out.people = Number(kv[2]);
      } else if (p) title.push(p);
    }
    out.title = title.join(" · ") || "Your meal";
    meal = out;
    return "";
  });
  rest = rest.replace(/^[ \t>*-]*MEALITEM:\s*([^\n]+)$/gim, (_m, body: string) => {
    const parts = body.split("|").map((p) => p.trim());
    const head = (parts[0] ?? "").match(/^([A-Za-z0-9_-]+)(?:\s*x\s*(\d+))?/i);
    if (!head) return "";
    const option = parts.length >= 3 ? parts[1] : undefined;
    const reason = (parts.length >= 3 ? parts.slice(2).join(" | ") : parts[1] ?? "").replace(/^[—–-]\s*/, "").trim();
    items.push({
      id: head[1],
      quantity: Math.min(10, Math.max(1, Number(head[2]) || 1)),
      ...(option && option !== "-" && option.toLowerCase() !== "none" ? { option } : {}),
      reason: reason || "Picked for your order",
    });
    return "";
  });
  return { rest, meal, items };
}
