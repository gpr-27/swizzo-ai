// GET /api/usuals — household go-to Instamart items for the House Board.
// Read-only. Uses your_go_to_items (+ optional get_orders for honest "Due"
// labels). Never touches the cart or checkout.

import { getOrders, goToItems } from "@/backend/mcp/swiggy-mcp";
import { isAuthError } from "@/backend/config/env";
import type { Product } from "@/shared/types";
import { usualPick, toPick } from "@/shared/instamart-packs";
import { daysAgo, lastOrderedFor, orderIndex } from "@/backend/mcp/instamart-basket";
import { route, unauthorized } from "@/backend/http/route";
import { AddressOnlyQuery } from "@/backend/http/schemas";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export type UsualBadge = "due" | "again";

export interface UsualLine {
  product: Product;
  badge: UsualBadge;
  /** spinId used as the draft key (first in-stock variation, else first). */
  spinId: string;
  /** false when no variation is in stock at this address (shown, not preselected). */
  inStock: boolean;
  /** why the AI picked this pack (₹/unit across the product's packs, rating, ETA) */
  pickReason?: string;
  /** how many in-stock packs Swiggy offers (the tile lets you switch) */
  packCount?: number;
  /** "ordered 6 days ago" when get_orders has it */
  lastOrdered?: string;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

/** get_orders `createdAt` (string) → epoch ms, or null if unparseable. */
function parseOrderDate(o: Record<string, unknown>): number | null {
  const c = o.createdAt;
  if (typeof c === "string" && c.trim()) {
    const t = Date.parse(c);
    if (Number.isFinite(t)) return t;
  }
  return null;
}

/**
 * Keys for an order's items. get_orders items are `{ name, quantity, itemId? }`
 * — no brand and no documented product id — so we match on the normalized name
 * (plus itemId, which may equal a productId / spinId [UNCERTAIN]).
 */
function itemKeys(o: Record<string, unknown>): string[] {
  const raw = Array.isArray(o.items) ? o.items : [];
  const keys: string[] = [];
  for (const it of raw) {
    if (!isRecord(it)) continue;
    const name = normName(str(it.name));
    const itemId = typeof it.itemId === "number" ? String(it.itemId) : str(it.itemId);
    if (name) keys.push(`name:${name}`);
    if (itemId) keys.push(`id:${itemId}`);
  }
  return keys;
}

function normName(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/**
 * Mark a product "due" only when order history has ≥2 dated purchases of that
 * item, a stable gap (±35%), and we're past that gap since the last buy.
 * Otherwise leave it unmarked (caller defaults to "again").
 */
function dueProductIds(orders: Record<string, unknown>[]): Set<string> {
  const byKey = new Map<string, number[]>();
  for (const o of orders) {
    const t = parseOrderDate(o);
    if (t == null) continue;
    for (const k of itemKeys(o)) {
      const list = byKey.get(k) ?? [];
      list.push(t);
      byKey.set(k, list);
    }
  }

  const dueKeys = new Set<string>();
  const now = Date.now();
  const DAY = 86_400_000;

  for (const [key, times] of byKey) {
    const sorted = [...new Set(times)].sort((a, b) => a - b);
    if (sorted.length < 2) continue;
    const gaps: number[] = [];
    for (let i = 1; i < sorted.length; i++) {
      gaps.push(sorted[i]! - sorted[i - 1]!);
    }
    const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
    // Need a real household cadence (2–45 days). Skip one-offs / monthly noise.
    if (mean < 2 * DAY || mean > 45 * DAY) continue;
    const maxDev = Math.max(...gaps.map((g) => Math.abs(g - mean)));
    if (maxDev > mean * 0.35) continue; // gap not clear enough
    const last = sorted[sorted.length - 1]!;
    if (now - last >= mean * 0.9) dueKeys.add(key);
  }
  return dueKeys;
}

function productMatchesDue(p: Product, due: Set<string>): boolean {
  if (p.productId && due.has(`id:${p.productId}`)) return true;
  const name = normName(p.name || "");
  if (name && due.has(`name:${name}`)) return true;
  const branded = normName(`${p.brand} ${p.name}`);
  if (branded && due.has(`name:${branded}`)) return true;
  for (const v of p.variations) {
    if (v.spinId && due.has(`id:${v.spinId}`)) return true;
  }
  return false;
}

/** The AI pack: best value per unit among the in-stock packs (else the first). */
function pickSpin(p: Product): { spinId: string; reason?: string; packCount?: number } {
  const c = usualPick(p);
  if (c) return { spinId: c.variation.spinId, reason: toPick(c).reason, packCount: c.packCount };
  return { spinId: p.variations[0]?.spinId ?? "" };
}

// Plan: fish & fresh meat stay off the auto-usuals board — person adds by hand.
const FRESH_MEAT_FISH =
  /\b(chicken|mutton|lamb|goat|pork|beef|fish|prawn|shrimp|seafood|keema|meat|turkey|duck|crab|lobster|salmon|rohu|katla)\b/i;

function isPersonAddOnly(p: Product): boolean {
  const hay = `${p.name} ${p.brand}`;
  return FRESH_MEAT_FISH.test(hay);
}

export const GET = route({ name: "api/usuals", rateLimit: "read", query: AddressOnlyQuery }, async function GET(request: Request): Promise<Response> {
  const addressId = new URL(request.url).searchParams.get("addressId") ?? "";
  if (!addressId) {
    return Response.json({ items: [], label: "again" as const }, { status: 400 });
  }

  try {
    // get_orders only covers the last 15 days, so ask for the max recommended
    // count. It only powers the "Due" label — never fail the board on it.
    const [{ products }, orders] = await Promise.all([
      goToItems(addressId, 0),
      getOrders({ count: 20 }).catch((err: unknown) => {
        if (isAuthError(err)) throw err;
        return [] as Record<string, unknown>[];
      }),
    ]);

    const due = dueProductIds(orders);
    const idx = orderIndex(orders);
    const items: UsualLine[] = products
      .filter((product) => !isPersonAddOnly(product))
      .map((product) => {
        const pick = pickSpin(product);
        if (!pick.spinId) return null;
        const badge: UsualBadge = productMatchesDue(product, due) ? "due" : "again";
        const inStock = product.inStock && product.variations.some((v) => v.inStock);
        const t = lastOrderedFor(product, idx.byName);
        return {
          product,
          badge,
          spinId: pick.spinId,
          inStock,
          ...(pick.reason ? { pickReason: pick.reason } : {}),
          ...(pick.packCount ? { packCount: pick.packCount } : {}),
          ...(t ? { lastOrdered: daysAgo(t) } : {}),
        } as UsualLine;
      })
      .filter((x): x is UsualLine => !!x);

    // Put Due lines first when we have any; otherwise keep API order.
    items.sort((a, b) => {
      if (a.badge === b.badge) return 0;
      return a.badge === "due" ? -1 : 1;
    });

    const hasDue = items.some((i) => i.badge === "due");
    // Facts for the AI briefing (every one from Swiggy's own data).
    const short = (p: Product) => p.name.replace(/\s*\(.*?\)\s*/g, " ").trim();
    const oos = items.filter((i) => !i.inStock);
    const facts = [
      `usual items (from Swiggy go-to items): ${items.slice(0, 6).map((i) => short(i.product)).join(", ")}${items.length > 6 ? ` and ${items.length - 6} more` : ""}`,
      idx.latest
        ? `last Instamart order: ${daysAgo(idx.latest)} (${idx.count} order${idx.count === 1 ? "" : "s"} in the last 15 days)`
        : "no Instamart orders in the last 15 days (Swiggy only reports 15 days)",
      hasDue ? `due again now: ${items.filter((i) => i.badge === "due").map((i) => short(i.product)).join(", ")}` : "",
      oos.length ? `out of stock at this address right now: ${oos.map((i) => short(i.product)).join(", ")}` : "",
    ].filter(Boolean);
    const names = items.slice(0, 3).map((i) => short(i.product).toLowerCase());
    const text = items.length
      ? `You usually buy ${names.join(", ")}${items.length > 3 ? ` and ${items.length - 3} more` : ""} — ${
          idx.latest ? `last ordered ${daysAgo(idx.latest).replace(/^ordered /, "")}` : "no Instamart order in the last 15 days"
        }${oos.length ? `; ${oos.length} out of stock right now` : ""}. Tap Refill my usuals for one ready basket.`
      : "";
    return Response.json({
      briefing: { facts, text },
      items,
      // Section copy: only claim "due" when math landed on something.
      label: hasDue ? ("mixed" as const) : ("again" as const),
    });
  } catch (err: unknown) {
    if (isAuthError(err)) return unauthorized();
    console.error("[api/usuals] failed:", err);
    return Response.json(
      { items: [], label: "again" as const, error: err instanceof Error ? err.message : "Couldn't load your usuals" },
      { status: 502 },
    );
  }
});
