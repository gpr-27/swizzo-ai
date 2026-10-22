// The AI basket, server side: run every item's search_products in parallel
// (a few at a time — one Swiggy session), or read your_go_to_items (+ get_orders
// for "last ordered") for a usuals refill, then let src/shared/instamart-packs.ts
// pick the real pack per item. READ-ONLY: nothing here touches the cart — the
// user approves the card and the client sends update_cart through /api/cart.

import type { InstamartBasket, Product } from "@/shared/types";
import {
  assembleBasket,
  closestSubstitute,
  toPick,
  usualPick,
  type BasketRequest,
  type BasketRequestItem,
  type ItemResults,
} from "@/shared/instamart-packs";
import { isAuthError } from "@/backend/config/env";

import { getOrders, goToItems, searchProducts } from "./swiggy-mcp";

const MAX_ITEMS = 18;
const CONCURRENCY = 4;

export interface BuildBasketArgs extends BasketRequest {
  fromUsuals?: boolean;
}

/** Run `fn` over `items`, at most `n` at a time, keeping order. */
async function pool<T, R>(items: T[], n: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
  return out;
}

function errText(e: unknown): string {
  return e instanceof Error && e.message ? e.message.slice(0, 160) : "Search failed";
}

const searchAll = (addressId: string, query: string) =>
  searchProducts(addressId, query).then((r) => (r.products.length ? r.products : r.similarProducts));

/** Fish & fresh meat stay off auto-usuals (people pick those by hand). */
export const FRESH_MEAT_FISH =
  /\b(chicken|mutton|lamb|goat|pork|beef|fish|prawn|shrimp|seafood|keema|meat|turkey|duck|crab|lobster|salmon|rohu|katla)\b/i;

function normName(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/** get_orders → latest order time per normalised item name (+ the newest order). */
export function orderIndex(orders: Record<string, unknown>[]): { byName: Map<string, number>; latest: number | null; count: number } {
  const byName = new Map<string, number>();
  let latest: number | null = null;
  for (const o of orders) {
    const t = typeof o.createdAt === "string" ? Date.parse(o.createdAt) : NaN;
    if (!Number.isFinite(t)) continue;
    latest = latest === null ? t : Math.max(latest, t);
    for (const it of Array.isArray(o.items) ? o.items : []) {
      const name = it && typeof it === "object" ? normName(String((it as Record<string, unknown>).name ?? "")) : "";
      if (name) byName.set(name, Math.max(byName.get(name) ?? 0, t));
    }
  }
  return { byName, latest, count: orders.length };
}

export function lastOrderedFor(p: Product, idx: Map<string, number>): number | undefined {
  const names = [normName(p.name), normName(`${p.brand} ${p.name}`)];
  for (const [k, t] of idx) if (names.some((n) => n && (k === n || k.includes(n) || n.includes(k)))) return t;
  return undefined;
}

export function daysAgo(t: number, now = Date.now()): string {
  const d = Math.max(0, Math.floor((now - t) / 86_400_000));
  return d === 0 ? "ordered today" : d === 1 ? "ordered yesterday" : `ordered ${d} days ago`;
}

/** Build a one-card basket from a sentence's items (model) or from the usuals. */
export async function buildBasket(addressId: string, args: BuildBasketArgs): Promise<InstamartBasket> {
  const id = `bk-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  if (args.fromUsuals) return buildUsualsBasket(addressId, args, id);

  const items: BasketRequestItem[] = (args.items ?? [])
    .filter((i) => i && typeof i.query === "string" && i.query.trim())
    .slice(0, MAX_ITEMS)
    .map((i) => ({ ...i, query: i.query.trim().slice(0, 80) }));
  const results: ItemResults[] = await pool(items, CONCURRENCY, async (item) => {
    try {
      return { item, products: await searchAll(addressId, item.query) };
    } catch (e) {
      if (isAuthError(e)) throw e;
      return { item, products: [], error: errText(e) };
    }
  });
  return assembleBasket({ ...args, items }, results, id);
}

async function buildUsualsBasket(addressId: string, args: BuildBasketArgs, id: string): Promise<InstamartBasket> {
  const [{ products }, orders] = await Promise.all([
    goToItems(addressId, 0),
    getOrders({ count: 20 }).catch((e: unknown) => {
      if (isAuthError(e)) throw e;
      return [] as Record<string, unknown>[];
    }),
  ]);
  const idx = orderIndex(orders);
  const usuals = products.filter((p) => !FRESH_MEAT_FISH.test(`${p.name} ${p.brand}`)).slice(0, MAX_ITEMS);
  const used = new Set<string>();
  const basket = assembleBasket({ ...args, items: [] }, [], id);
  basket.source = "usuals";
  basket.title = args.title?.trim() || "Refill your usuals";

  // In-stock usuals first (AI pack), then substitutes for the out-of-stock ones.
  const oos: Product[] = [];
  for (const p of usuals) {
    const c = usualPick(p);
    if (!c) {
      oos.push(p);
      continue;
    }
    used.add(c.variation.spinId);
    const t = lastOrderedFor(p, idx.byName);
    basket.lines.push({
      ...toPick(c),
      id: `u:${c.variation.spinId}`,
      need: p.name,
      kind: "pick",
      ...(t ? { lastOrdered: daysAgo(t) } : {}),
    });
  }
  const subs = await pool(oos.slice(0, 6), CONCURRENCY, async (p) => {
    try {
      return { p, list: await searchAll(addressId, p.name) };
    } catch (e) {
      if (isAuthError(e)) throw e;
      return { p, list: [] as Product[] };
    }
  });
  for (const { p, list } of subs) {
    const v0 = p.variations[0];
    const sub = closestSubstitute({ name: p.name, brand: p.brand, quantityDescription: v0?.quantityDescription, spinId: v0?.spinId }, list, used);
    if (!sub) {
      (basket.missing ??= []).push({ need: p.name, why: "Out of stock at this address, and no close match is in stock" });
      continue;
    }
    used.add(sub.variation.spinId);
    basket.lines.push({
      ...toPick(sub),
      id: `s:${sub.variation.spinId}`,
      need: p.name,
      kind: "substitute",
      note: `Your usual ${p.brand && !/category/i.test(p.brand) ? `${p.brand} ` : ""}${p.name} is out of stock — closest in-stock match`,
    });
  }

  let itemTotal = 0;
  let mrpTotal = 0;
  for (const l of basket.lines) {
    itemTotal += l.line.unitPrice * l.quantity;
    mrpTotal += Math.max(l.line.mrp, l.line.unitPrice) * l.quantity;
  }
  basket.itemTotal = Math.round(itemTotal);
  basket.mrpTotal = Math.round(mrpTotal);
  if (!basket.lines.length && !basket.missing?.length && !usuals.length) {
    (basket.missing ??= []).push({ need: "your usuals", why: "Swiggy has no go-to items for this address yet" });
  }
  return basket;
}

/** Compact, id-bearing text the model reads back for a built basket. */
export function summarizeBasket(b: InstamartBasket): string {
  const out: string[] = [
    `BASKET "${b.title}" (ONE card with Approve all / remove / swap is ALREADY shown — do NOT list every line again; nothing is in the cart until the user taps Approve all):`,
  ];
  for (const l of b.lines) {
    out.push(
      `• ${l.need} → ${l.line.brand} ${l.line.name} ${l.line.quantityDescription} ×${l.quantity} = ₹${Math.round(l.line.unitPrice * l.quantity)}${l.line.mrp > l.line.unitPrice ? ` (mrp ₹${l.line.mrp} each)` : ""} | id=${l.line.spinId} | ${l.reason}${l.kind !== "pick" ? ` | ${l.kind.toUpperCase()}: ${l.note ?? ""}` : ""}${l.capped ? ` | CAP: ${l.capped}` : ""}${l.lastOrdered ? ` | ${l.lastOrdered}` : ""}${l.alternatives?.length ? ` | swaps: ${l.alternatives.map((a) => `${a.line.name} ${a.line.quantityDescription} ₹${a.line.unitPrice}`).join("; ")}` : ""}`,
    );
  }
  for (const m of b.missing ?? []) out.push(`• MISSING ${m.need}: ${m.why}`);
  const save = b.mrpTotal - b.itemTotal;
  out.push(
    `Item total ₹${b.itemTotal}${save > 0 ? ` (saves ₹${save} vs MRP)` : ""}${b.budget ? ` vs budget ₹${b.budget} — ${b.itemTotal <= b.budget ? `₹${b.budget - b.itemTotal} under` : `₹${b.itemTotal - b.budget} OVER: name 1-2 lines to remove`}` : ""}. Fees (handling, delivery) come from Swiggy's cart after approval; Instamart's minimum order is ₹99.${b.skippedSponsored ? ` Skipped ${b.skippedSponsored} sponsored listing(s) for better value.` : ""}${b.lines.some((l) => l.sponsored) ? " Some picks are SPONSORED — say so." : ""}`,
  );
  out.push(
    "Reply in 2-3 lines: the total vs budget, any substitute / cap / missing item and why, then tell them to tap Approve all (or remove lines). No ADD:/BEST: markers for these lines.",
  );
  return out.join("\n");
}
