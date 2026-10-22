// Instamart pack + product choice: the deterministic half of the AI basket.
// The model decides WHAT to buy (items, sizes, quantities); this module picks
// WHICH real pack from Swiggy's live results — best value per unit for the
// stated need, honest about sponsored listings, out-of-stock items and
// per-order caps — and writes a one-line reason from the real data.
// Pure (no I/O): used by the server basket builder, the usuals board, the
// ingredient resolver and the product card. Asserted in
// scripts/verify-food-instamart.ts.

import type {
  BasketLine,
  BasketPick,
  CartLine,
  InstamartBasket,
  Product,
  Variation,
} from "./types";

/* --------------------------------- measures -------------------------------- */

export type MeasureKind = "g" | "ml" | "pc";
export interface Measure {
  kind: MeasureKind;
  amount: number; // total, in g / ml / pieces
}

const UNIT: Record<string, { kind: MeasureKind; mult: number }> = {
  g: { kind: "g", mult: 1 },
  gm: { kind: "g", mult: 1 },
  gms: { kind: "g", mult: 1 },
  gram: { kind: "g", mult: 1 },
  grams: { kind: "g", mult: 1 },
  kg: { kind: "g", mult: 1000 },
  kgs: { kind: "g", mult: 1000 },
  ml: { kind: "ml", mult: 1 },
  l: { kind: "ml", mult: 1000 },
  lt: { kind: "ml", mult: 1000 },
  ltr: { kind: "ml", mult: 1000 },
  ltrs: { kind: "ml", mult: 1000 },
  litre: { kind: "ml", mult: 1000 },
  litres: { kind: "ml", mult: 1000 },
  liter: { kind: "ml", mult: 1000 },
  liters: { kind: "ml", mult: 1000 },
};
const PIECE = /^(pieces?|pcs?|nos?|numbers?|units?|eggs?|sachets?|rolls?|bars?|packets?|packs?|bottles?|cans?|tablets?|capsules?)$/;

function unitOf(word: string): { kind: MeasureKind; mult: number } | null {
  const w = word.toLowerCase().replace(/\.$/, "");
  if (UNIT[w]) return UNIT[w];
  if (PIECE.test(w)) return { kind: "pc", mult: 1 };
  return null;
}

/**
 * Swiggy's pack size → a total measure. Live shapes: "450 ml x 2",
 * "1 ltr x 12", "12 Pieces x 2", "52.9 g", "10 numbers", "500 g".
 * Returns null when the description has no parsable size.
 */
export function parsePack(desc: string | undefined): Measure | null {
  const s = (desc ?? "").toLowerCase().replace(/,/g, "").trim();
  if (!s) return null;
  // "2 x 500 g"
  let m = s.match(/^(\d+)\s*[x×]\s*(\d+(?:\.\d+)?)\s*([a-z.]+)/);
  if (m) {
    const u = unitOf(m[3]);
    if (u) return { kind: u.kind, amount: Number(m[1]) * Number(m[2]) * u.mult };
  }
  // "450 ml x 2" / "1 ltr" / "12 pieces"
  m = s.match(/(\d+(?:\.\d+)?)\s*([a-z.]+)(?:\s*[x×]\s*(\d+))?/);
  if (m) {
    const u = unitOf(m[2]);
    if (u) {
      const n = Number(m[1]) * u.mult * (m[3] ? Number(m[3]) : 1);
      if (n > 0) return { kind: u.kind, amount: n };
    }
  }
  return null;
}

/** A need the model stated ("2 L", "1kg", "12 eggs", "12") → a measure. */
export function parseNeed(size: string | undefined): Measure | null {
  const s = (size ?? "").trim();
  if (!s) return null;
  if (/^\d+(?:\.\d+)?$/.test(s)) return { kind: "pc", amount: Number(s) };
  return parsePack(s);
}

/** Swiggy's unitLevelPrice ("6.4/100 ml", "8.7/piece") → ₹ per base unit. */
function parseUnitLevel(u: string | undefined): { kind: MeasureKind; perBase: number } | null {
  const m = (u ?? "").replace("₹", "").match(/^\s*(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)?\s*([a-z.]+)/i);
  if (!m) return null;
  const unit = unitOf(m[3]);
  if (!unit) return null;
  const per = Number(m[2] ?? 1) * unit.mult;
  return per > 0 ? { kind: unit.kind, perBase: Number(m[1]) / per } : null;
}

/** ₹ per gram / ml / piece for one pack (computed, else Swiggy's unit price). */
export function perBaseCost(v: Variation): { kind: MeasureKind; perBase: number } | null {
  const pack = parsePack(v.quantityDescription);
  const price = v.offerPrice || v.mrp;
  if (pack && price > 0) return { kind: pack.kind, perBase: price / pack.amount };
  return parseUnitLevel(v.unitLevelPrice);
}

function round1(n: number): string {
  return n >= 10 ? String(Math.round(n)) : String(Math.round(n * 10) / 10);
}

/** "₹7/100 ml" — Swiggy's own label when sent, else computed from the pack. */
export function unitPriceText(v: Variation): string | undefined {
  const u = v.unitLevelPrice?.trim();
  if (u) return u.startsWith("₹") ? u : `₹${u}`;
  const c = perBaseCost(v);
  if (!c) return undefined;
  return c.kind === "pc" ? `₹${round1(c.perBase)}/piece` : `₹${round1(c.perBase * 100)}/100 ${c.kind}`;
}

/* -------------------------------- pack choice ------------------------------ */

export interface Need {
  amount?: Measure | null; // total wanted ("2 L")
  packs?: number; // or simply how many packs
}

export interface PackChoice {
  variation: Variation;
  units: number; // packs to add (already capped by maxQuantity)
  cost: number; // units × offer price
  covers: boolean; // meets the stated need (amount / packs)
  capped?: string; // Swiggy's cap text when the cap stopped us
  perBase?: number;
  kind?: MeasureKind;
  packCount: number; // in-stock packs Swiggy offers
  why: string; // pack-level reason
}

const inStockPacks = (p: Product) => (p.inStock ? p.variations.filter((v) => v.inStock && v.spinId) : []);
const cap = (v: Variation) => (v.maxQuantity && v.maxQuantity > 0 ? v.maxQuantity : 99);
const capText = (v: Variation) => v.maxQuantityMessage || `Swiggy allows ${v.maxQuantity} per order`;

function amountText(m: Measure): string {
  if (m.kind === "pc") return `${round1(m.amount)} pcs`;
  if (m.amount >= 1000) return `${round1(m.amount / 1000)} ${m.kind === "g" ? "kg" : "L"}`;
  return `${round1(m.amount)} ${m.kind}`;
}

/**
 * The best pack of ONE product for a need. With an amount ("2 L"): the
 * cheapest set of identical packs that covers it (fewest leftovers on ties),
 * respecting each pack's per-order cap. Without one: the SMALLEST pack (most
 * people buy the single pack, not the multi-pack) — the reason still says when
 * a bigger pack is cheaper per unit.
 */
export function choosePack(product: Product, need: Need = {}): PackChoice | null {
  const packs = inStockPacks(product);
  if (!packs.length) return null;
  const packCount = packs.length;

  if (need.amount) {
    const want = need.amount;
    const opts = packs
      .map((v) => ({ v, m: parsePack(v.quantityDescription) }))
      .filter((x): x is { v: Variation; m: Measure } => !!x.m && x.m.kind === want.kind)
      .map(({ v, m }) => {
        const ideal = Math.max(1, Math.ceil(want.amount / m.amount - 1e-9));
        const units = Math.min(ideal, cap(v));
        return { v, m, units, ideal, cost: units * v.offerPrice, got: units * m.amount };
      });
    if (opts.length) {
      const covering = opts.filter((o) => o.got >= want.amount);
      const best = covering.length
        ? covering.sort((a, b) => a.cost - b.cost || a.got - b.got)[0]
        : opts.sort((a, b) => b.got - a.got || a.cost - b.cost)[0];
      const c = perBaseCost(best.v);
      const covers = best.got >= want.amount;
      return {
        variation: best.v,
        units: best.units,
        cost: best.cost,
        covers,
        ...(best.units < best.ideal ? { capped: capText(best.v) } : {}),
        ...(c ? { perBase: c.perBase, kind: c.kind } : {}),
        packCount,
        why: covers
          ? `${best.units > 1 ? `${best.units} × ` : ""}${best.v.quantityDescription} covers your ${amountText(want)} for ₹${Math.round(best.cost)}${packCount > 1 ? ` (cheapest of ${packCount} packs)` : ""}`
          : `${best.units} × ${best.v.quantityDescription} = ${amountText({ kind: want.kind, amount: best.got })} of your ${amountText(want)} (per-order cap)`,
      };
    }
  }

  const wantPacks = Math.max(1, Math.round(need.packs ?? 1));
  const priced = packs.map((v) => ({ v, c: perBaseCost(v) }));
  const kinds = new Set(priced.map((x) => x.c?.kind).filter(Boolean));
  const comparable = kinds.size === 1 && priced.every((x) => x.c);
  // default = the smallest pack by quantity (else the lowest price); ties → cheaper
  const size = (v: Variation) => {
    const m = parsePack(v.quantityDescription);
    return m ? m.amount : Infinity;
  };
  const best = priced.reduce((a, b) => {
    const sa = comparable ? size(a.v) : a.v.offerPrice;
    const sb = comparable ? size(b.v) : b.v.offerPrice;
    if (sb < sa) return b;
    if (sb === sa && b.v.offerPrice < a.v.offerPrice) return b;
    return a;
  });
  const units = Math.min(wantPacks, cap(best.v));
  const unit = unitPriceText(best.v);
  let why: string;
  if (packCount > 1 && comparable) {
    const others = priced.filter((x) => x !== best && x.c);
    const worst = others.reduce((a, b) => (b.c!.perBase > (a?.c?.perBase ?? 0) ? b : a), others[0]);
    const save = worst?.c && best.c ? 1 - best.c.perBase / worst.c.perBase : 0;
    const bulk = priced.find((x) => x.c && best.c && x.c.perBase < best.c.perBase * 0.98);
    why = bulk?.c && best.c
      ? `${best.v.quantityDescription}${unit ? ` at ${unit}` : ""} — the ${bulk.v.quantityDescription} stock-up pack is ${Math.round((1 - bulk.c.perBase / best.c.perBase) * 100)}% cheaper per unit but ₹${Math.round(bulk.v.offerPrice)} upfront`
      : save < 0.02
        ? `${best.v.quantityDescription}${unit ? ` at ${unit}` : ""} — smallest pack, same per-unit price as the bigger ones`
        : `${best.v.quantityDescription}${unit ? ` at ${unit}` : ""} — smallest pack, and the best per-unit value of ${packCount} packs`;
  } else {
    why = `${best.v.quantityDescription}${unit ? ` · ${unit}` : ""}`;
  }
  return {
    variation: best.v,
    units,
    cost: units * best.v.offerPrice,
    covers: units >= wantPacks,
    ...(units < wantPacks ? { capped: capText(best.v) } : {}),
    ...(best.c ? { perBase: best.c.perBase, kind: best.c.kind } : {}),
    packCount,
    why,
  };
}

/* ------------------------------ product choice ----------------------------- */

const STOP = new Set(["a", "an", "the", "of", "for", "and", "with", "some", "pack", "packs", "fresh", "any", "good", "best", "cheap", "x"]);
function stem(w: string): string {
  return w.length > 4 && w.endsWith("es") ? w.slice(0, -2) : w.length > 3 && w.endsWith("s") ? w.slice(0, -1) : w;
}
export function tokens(s: string): string[] {
  return (s.toLowerCase().match(/[a-z0-9]+/g) ?? [])
    .filter((w) => !STOP.has(w) && !/^\d+(?:\.\d+)?$/.test(w) && !unitOf(w))
    .map(stem);
}

/** Share of the query's words found in the product's brand + name. */
export function relevance(query: string, p: Product): number {
  const q = tokens(query);
  if (!q.length) return 1;
  const hay = tokens(`${p.brand} ${p.name}`);
  const hit = q.filter((w) => hay.some((h) => h === w || (w.length >= 4 && (h.startsWith(w) || w.startsWith(h)))));
  return hit.length / q.length;
}

export interface ProductChoice extends PackChoice {
  product: Product;
  score: number;
}

export interface RankOptions {
  need?: Need;
  allowSponsored?: boolean; // the user asked for that brand / listing
  vegOnly?: boolean;
  exclude?: Set<string>; // spinIds already in the basket
}

export interface Ranked {
  pick: ProductChoice | null;
  alternatives: ProductChoice[];
  skippedSponsored: number;
  /** the top relevant result when it couldn't be bought (out of stock) */
  unavailableTop?: Product;
}

function ratingOf(v: Variation): number {
  return Number(v.rating?.value) || 0;
}
function slaMinutes(v: Variation): number {
  const m = (v.sla ?? "").match(/(\d+)/);
  return m ? Number(m[1]) : 0;
}

/**
 * Pick the best product + pack among search results for one need: only
 * results that actually match the ask (else the top 3), in stock, veg when
 * asked, sponsored listings skipped unless nothing else fits or the user asked.
 * Value = ₹ per unit (or the cost of covering the need), nudged by rating,
 * delivery time and Swiggy's relevance order.
 */
export function rankProducts(query: string, products: Product[], opts: RankOptions = {}): Ranked {
  const top = products.slice(0, 12);
  let relevant = top.filter((p) => relevance(query, p) >= 0.5);
  if (!relevant.length) relevant = top.slice(0, 3);
  // The result that best matches the ask (Swiggy's order breaks ties): when IT
  // can't be bought, whatever we pick is a substitute and we say so.
  const exact = relevant.reduce<Product | undefined>(
    (a, p) => (!a || relevance(query, p) > relevance(query, a) ? p : a),
    undefined,
  );
  const unavailableTop = exact && !choosePack(exact) ? exact : undefined;

  const all: ProductChoice[] = [];
  relevant.forEach((product, rank) => {
    const c = choosePack(product, opts.need);
    if (!c) return;
    if (opts.exclude?.has(c.variation.spinId)) return;
    if (opts.vegOnly && c.variation.veg === "nonveg") return;
    all.push({ ...c, product, score: rank });
  });
  const organic = all.filter((c) => !c.product.isPromoted);
  const pool = opts.allowSponsored || !organic.length ? all : organic;
  const skippedSponsored = pool === organic ? all.length - organic.length : 0;

  const kinds = new Set(pool.map((c) => c.kind));
  const byUnit = kinds.size === 1 && pool.every((c) => c.perBase !== undefined);
  const needAmount = !!opts.need?.amount;
  for (const c of pool) {
    const rank = c.score;
    let value = needAmount ? c.cost : byUnit ? c.perBase! : c.variation.offerPrice;
    const r = ratingOf(c.variation);
    if (r && r < 3.8) value *= 1.15;
    else if (r && r < 4.2) value *= 1.05;
    else if (r >= 4.5) value *= 0.97;
    if (slaMinutes(c.variation) > 30) value *= 1.05;
    if (!c.covers) value *= 1.3;
    value *= 1 + 0.03 * rank;
    c.score = value;
  }
  pool.sort((a, b) => a.score - b.score);
  return { pick: pool[0] ?? null, alternatives: pool.slice(1, 3), skippedSponsored, ...(unavailableTop ? { unavailableTop } : {}) };
}

/**
 * The closest in-stock stand-in for an item Swiggy can't sell right now:
 * most shared name words, same kind of measure, nearest pack size.
 */
export function closestSubstitute(
  original: { name: string; brand?: string; quantityDescription?: string; spinId?: string },
  products: Product[],
  exclude?: Set<string>,
): ProductChoice | null {
  const want = parsePack(original.quantityDescription);
  const words = tokens(original.name);
  let best: ProductChoice | null = null;
  products.slice(0, 15).forEach((product, rank) => {
    const c = choosePack(product, want ? { amount: want } : {});
    if (!c || c.variation.spinId === original.spinId || exclude?.has(c.variation.spinId)) return;
    const hay = tokens(`${product.brand} ${product.name}`);
    const overlap = words.length ? words.filter((w) => hay.includes(w)).length / words.length : 0;
    if (overlap < 0.34 && rank > 2) return;
    const m = parsePack(c.variation.quantityDescription);
    const sizeFit = want && m && m.kind === want.kind ? Math.min(m.amount, want.amount) / Math.max(m.amount, want.amount) : 0.5;
    const score = overlap * 2 + sizeFit + (product.isPromoted ? -0.3 : 0) - rank * 0.05;
    if (!best || score > best.score) best = { ...c, product, score };
  });
  return best;
}

/* ---------------------------------- lines ---------------------------------- */

export function lineOf(product: Product, v: Variation): Omit<CartLine, "quantity"> {
  return {
    spinId: v.spinId,
    ...(v.skuId ? { skuId: v.skuId } : {}),
    productId: product.productId,
    name: product.name,
    brand: product.brand,
    quantityDescription: v.quantityDescription,
    imageUrl: v.imageUrl,
    unitPrice: v.offerPrice,
    mrp: v.mrp,
    ...(v.maxQuantity ? { maxQuantity: v.maxQuantity } : {}),
    ...(v.maxQuantityMessage ? { maxQuantityMessage: v.maxQuantityMessage } : {}),
    inStock: product.inStock && v.inStock,
  };
}

function facts(v: Variation): string[] {
  return [
    v.rating ? `★${v.rating.value}${v.rating.count ? ` (${v.rating.count})` : ""}` : "",
    v.sla ? v.sla : "",
  ].filter(Boolean);
}

/** A ProductChoice → the card's BasketPick (reason = pack why + facts + honesty). */
export function toPick(c: ProductChoice, extra: string[] = []): BasketPick {
  const v = c.variation;
  const badges = (c.product.badges ?? []).filter((b) => b.type !== "BADGE_TYPE_AD").map((b) => b.text);
  const unitPrice = unitPriceText(v);
  const reason = [
    c.product.isPromoted ? "⭐ Sponsored" : "",
    c.why,
    ...facts(v),
    ...extra,
  ]
    .filter(Boolean)
    .join(" · ");
  return {
    line: lineOf(c.product, v),
    quantity: Math.max(1, c.units),
    reason,
    ...(unitPrice ? { unitPrice } : {}),
    ...(v.rating ? { rating: v.rating } : {}),
    ...(v.sla ? { sla: v.sla } : {}),
    ...(v.veg ? { veg: v.veg } : {}),
    ...(c.product.isPromoted ? { sponsored: true } : {}),
    ...(badges.length ? { badges } : {}),
    packCount: c.packCount,
  };
}

/* --------------------------------- baskets --------------------------------- */

export interface BasketRequestItem {
  query: string;
  quantity?: number; // packs
  size?: string; // total wanted ("2 L", "1 kg", "12")
}

export interface BasketRequest {
  title?: string;
  budget?: number;
  allowSponsored?: boolean;
  vegOnly?: boolean;
  items: BasketRequestItem[];
}

/** One request item's search results (+ an optional fallback search). */
export interface ItemResults {
  item: BasketRequestItem;
  products: Product[];
  error?: string; // Swiggy's message when the search failed
}

const needLabel = (i: BasketRequestItem) =>
  [i.query, i.size ? i.size : i.quantity && i.quantity > 1 ? `× ${i.quantity}` : ""].filter(Boolean).join(" · ");

/**
 * Assemble the one-card basket from each item's real results. Handles
 * out-of-stock top matches (says so), per-order caps (tops up the remainder
 * with the next-best product and says why) and the budget (reported, never
 * silently trimmed — the user decides on the card).
 */
export function assembleBasket(req: BasketRequest, results: ItemResults[], id: string): InstamartBasket {
  const lines: BasketLine[] = [];
  const missing: { need: string; why: string }[] = [];
  const used = new Set<string>();
  let skippedSponsored = 0;

  results.forEach((r, i) => {
    const need = needLabel(r.item);
    if (r.error) {
      missing.push({ need, why: r.error });
      return;
    }
    const amount = parseNeed(r.item.size);
    const ranked = rankProducts(r.item.query, r.products, {
      need: amount ? { amount } : { packs: r.item.quantity ?? 1 },
      allowSponsored: req.allowSponsored,
      vegOnly: req.vegOnly,
      exclude: used,
    });
    skippedSponsored += ranked.skippedSponsored;
    const pick = ranked.pick;
    if (!pick) {
      missing.push({
        need,
        why: ranked.unavailableTop
          ? `${ranked.unavailableTop.name} is out of stock here and nothing close is in stock`
          : r.products.length
            ? "No in-stock match at this address"
            : "Swiggy found nothing for this",
      });
      return;
    }
    used.add(pick.variation.spinId);
    const oos = ranked.unavailableTop;
    const base = toPick(pick);
    lines.push({
      ...base,
      id: `${i}:${pick.variation.spinId}`,
      need,
      kind: oos ? "substitute" : "pick",
      ...(oos ? { note: `${oos.brand ? `${oos.brand} ` : ""}${oos.name} is out of stock — closest in-stock match` } : {}),
      ...(pick.capped ? { capped: pick.capped } : {}),
      alternatives: ranked.alternatives.map((a) => toPick(a)),
    });
    // Per-order cap: top the remainder up with the next-best product.
    if (pick.capped && !pick.covers) {
      const rest = ranked.alternatives.find((a) => !used.has(a.variation.spinId));
      if (rest) {
        const remaining = amount
          ? Math.max(1, Math.ceil((amount.amount - pick.units * (parsePack(pick.variation.quantityDescription)?.amount ?? 0)) / (parsePack(rest.variation.quantityDescription)?.amount || 1)))
          : Math.max(1, (r.item.quantity ?? 1) - pick.units);
        const units = Math.min(remaining, rest.variation.maxQuantity || remaining);
        used.add(rest.variation.spinId);
        lines.push({
          ...toPick({ ...rest, units, cost: units * rest.variation.offerPrice }),
          id: `${i}:${rest.variation.spinId}:x`,
          need,
          kind: "overflow",
          note: `${pick.product.name}: ${pick.capped} — adding this for the rest`,
        });
      }
    }
  });

  let itemTotal = 0;
  let mrpTotal = 0;
  for (const l of lines) {
    itemTotal += l.line.unitPrice * l.quantity;
    mrpTotal += Math.max(l.line.mrp, l.line.unitPrice) * l.quantity;
  }
  return {
    id,
    title: req.title?.trim() || "Your basket",
    source: "ask",
    ...(req.budget && req.budget > 0 ? { budget: Math.round(req.budget) } : {}),
    lines,
    ...(missing.length ? { missing } : {}),
    itemTotal: Math.round(itemTotal),
    mrpTotal: Math.round(mrpTotal),
    ...(skippedSponsored ? { skippedSponsored } : {}),
    status: "pending",
  };
}

/** The usuals board / refill: AI pack for one go-to product (none if OOS). */
export function usualPick(product: Product): ProductChoice | null {
  const c = choosePack(product);
  return c ? { ...c, product, score: 0 } : null;
}

/** Lines the user is approving (removed lines dropped, chosen swaps applied). */
export function approvedLines(b: InstamartBasket): { line: Omit<CartLine, "quantity">; quantity: number }[] {
  const removed = new Set(b.removed ?? []);
  return b.lines
    .filter((l) => !removed.has(l.id))
    .map((l) => {
      const alt = b.chosen?.[l.id];
      const p = alt !== undefined && l.alternatives?.[alt] ? l.alternatives[alt] : l;
      return { line: p.line, quantity: p.quantity };
    });
}

/** Running total of what's still in the basket (for the card's budget meter). */
export function basketTotal(b: InstamartBasket): number {
  return approvedLines(b).reduce((s, x) => s + x.line.unitPrice * x.quantity, 0);
}
