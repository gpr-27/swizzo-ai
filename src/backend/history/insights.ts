// History page AI insights — pure functions over the REAL rows from
// /api/history (history-map.ts) and the bookings this app saved. Everything
// is counted from what Swiggy returned; nothing is estimated or invented:
//  - spend (cancelled excluded) and the window it covers,
//  - the restaurants / dishes / Instamart items ordered most,
//  - the meal time the user usually orders at (from Swiggy's order times),
//  - active orders + booking statuses,
//  - one-tap actions (reorder the usual, track, refill Instamart usuals),
//  - a one-liner per order ("Your 3rd order from X — same as last time.").
// `insightFacts()` is the fact list the AI summary may rephrase (ai-phrase.ts).
// No I/O, so scripts/verify-history.ts runs exactly this code.

import type { HistoryOrder, HistoryService } from "./history-map";

export type MealSlot = "breakfast" | "lunch" | "evening snack" | "dinner" | "late-night";

/** IST hour → the meal people order at that time. */
export function mealSlot(hour: number): MealSlot {
  if (hour >= 5 && hour < 11) return "breakfast";
  if (hour >= 11 && hour < 16) return "lunch";
  if (hour >= 16 && hour < 19) return "evening snack";
  if (hour >= 19 && hour < 23) return "dinner";
  return "late-night";
}

/** The current IST hour (Swiggy is India-only). */
export function istHour(nowMs: number = Date.now()): number {
  return new Date(nowMs + 330 * 60_000).getUTCHours();
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const IST_MS = 330 * 60_000;

export interface OrderTime {
  ms: number; // epoch ms
  hour: number; // IST hour 0-23
  label: string; // "Oct 14"
}

function fromEpoch(ms: number): OrderTime {
  const d = new Date(ms + IST_MS);
  return {
    ms,
    hour: d.getUTCHours(),
    label: `${MONTHS[d.getUTCMonth()].replace(/^./, (c) => c.toUpperCase())} ${d.getUTCDate()}`,
  };
}

/**
 * Swiggy's order time → epoch + IST hour. Food sends "October 14, 3:11 PM"
 * (no year: the latest such date not in the future); Instamart may send an
 * epoch (s / ms) or an ISO string. Unparseable → null (never guessed).
 */
export function parseOrderTime(raw: string | number | undefined, nowMs: number = Date.now()): OrderTime | null {
  if (raw === undefined || raw === null || raw === "") return null;
  if (typeof raw === "number" || /^\d{10,13}$/.test(String(raw).trim())) {
    const n = Number(raw);
    const ms = n < 1e12 ? n * 1000 : n;
    return Number.isFinite(ms) && ms > 0 ? fromEpoch(ms) : null;
  }
  const s = String(raw).trim();
  if (/^\d{4}-\d{2}-\d{2}T/.test(s)) {
    const ms = Date.parse(s);
    return Number.isFinite(ms) ? fromEpoch(ms) : null;
  }
  const m = s.match(/([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:,?\s+(\d{4}))?,?\s+(\d{1,2}):(\d{2})\s*([AaPp][Mm])/);
  if (!m) return null;
  const month = MONTHS.indexOf(m[1].slice(0, 3).toLowerCase());
  if (month < 0) return null;
  let h = Number(m[4]) % 12;
  if (/p/i.test(m[6])) h += 12;
  const nowYear = new Date(nowMs + IST_MS).getUTCFullYear();
  const at = (y: number) => Date.UTC(y, month, Number(m[2]), h, Number(m[5])) - IST_MS;
  let ms = at(m[3] ? Number(m[3]) : nowYear);
  if (!m[3] && ms > nowMs + 86_400_000) ms = at(nowYear - 1);
  return fromEpoch(ms);
}

/** Item names (with quantities) of one order: reorder lines, else Swiggy's "A (1),B (2)" summary. */
export function orderLines(o: HistoryOrder): { name: string; qty: number }[] {
  if (o.reorder?.items.length) return o.reorder.items.map((i) => ({ name: i.name, qty: i.quantity }));
  if (!o.items) return [];
  return o.items
    .split(/,(?![^(]*\))/)
    .map((part) => {
      const t = part.trim();
      const q = t.match(/\((\d+)\)\s*$/);
      return { name: t.replace(/\s*\(\d+\)\s*$/, "").trim(), qty: q ? Number(q[1]) : 1 };
    })
    .filter((l) => l.name);
}

const inr = (n: number) => `₹${Math.round(n).toLocaleString("en-IN")}`;
const ordinal = (n: number) => {
  const s = n % 100 >= 11 && n % 100 <= 13 ? "th" : ({ 1: "st", 2: "nd", 3: "rd" } as Record<number, string>)[n % 10] || "th";
  return `${n}${s}`;
};
const sameLines = (a: HistoryOrder, b: HistoryOrder) => {
  const key = (o: HistoryOrder) =>
    orderLines(o)
      .map((l) => `${l.name.toLowerCase()}×${l.qty}`)
      .sort()
      .join("|");
  const ka = key(a);
  return !!ka && ka === key(b);
};

export interface InsightBooking {
  kind: "dineout" | "scenes";
  title: string;
  status?: string;
}

export type InsightAction =
  | { kind: "reorder"; label: string; orderId: string }
  | { kind: "track"; label: string; orderId: string; service: HistoryService }
  | { kind: "refill"; label: string }
  | { kind: "bookings"; label: string };

export interface Ranked {
  name: string;
  count: number;
}

export interface HistoryInsights {
  /** deterministic one-glance summary (the AI may rephrase it from `facts`) */
  headline: string;
  spent: number;
  spentOrders: number;
  cancelled: number;
  since?: string; // "Sep 30" — the oldest order the window covers
  topRestaurants: Ranked[];
  topDishes: Ranked[];
  topItems: Ranked[]; // Instamart
  usual?: { slot: MealSlot; count: number; of: number };
  active: { service: HistoryService; orderId: string; title: string; status: string }[];
  bookings: { total: number; confirmed: number; pending: number; cancelled: number };
  actions: InsightAction[];
}

function rank(counts: Map<string, number>, min = 1, max = 3): Ranked[] {
  return [...counts.entries()]
    .filter(([, c]) => c >= min)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, max)
    .map(([name, count]) => ({ name, count }));
}

export function buildHistoryInsights(
  food: HistoryOrder[],
  instamart: HistoryOrder[],
  bookings: InsightBooking[] = [],
  nowMs: number = Date.now(),
): HistoryInsights {
  const all = [...food, ...instamart];
  const counted = all.filter((o) => o.tone !== "cancelled");
  const priced = counted.filter((o) => o.totalValue !== null);
  const spent = priced.reduce((s, o) => s + (o.totalValue ?? 0), 0);
  const times = all.map((o) => parseOrderTime(o.placedAt, nowMs)).filter((t): t is OrderTime => !!t);
  const oldest = times.length ? times.reduce((a, b) => (a.ms <= b.ms ? a : b)) : undefined;

  const restaurants = new Map<string, number>();
  const dishes = new Map<string, number>();
  const items = new Map<string, number>();
  for (const o of food.filter((x) => x.tone !== "cancelled")) {
    restaurants.set(o.title, (restaurants.get(o.title) ?? 0) + 1);
    for (const l of orderLines(o)) dishes.set(l.name, (dishes.get(l.name) ?? 0) + 1);
  }
  for (const o of instamart.filter((x) => x.tone !== "cancelled")) {
    for (const l of orderLines(o)) items.set(l.name, (items.get(l.name) ?? 0) + 1);
  }

  const slotCounts = new Map<MealSlot, number>();
  for (const o of counted) {
    const t = parseOrderTime(o.placedAt, nowMs);
    if (t) slotCounts.set(mealSlot(t.hour), (slotCounts.get(mealSlot(t.hour)) ?? 0) + 1);
  }
  const slotTotal = [...slotCounts.values()].reduce((a, b) => a + b, 0);
  const topSlot = [...slotCounts.entries()].sort((a, b) => b[1] - a[1])[0];
  const usual = topSlot && slotTotal >= 2 && topSlot[1] >= 2 ? { slot: topSlot[0], count: topSlot[1], of: slotTotal } : undefined;

  const active = all
    .filter((o) => o.active)
    .map((o) => ({ service: o.service, orderId: o.orderId, title: o.title, status: o.status }));
  const b = {
    total: bookings.length,
    confirmed: bookings.filter((x) => /confirm|success|booked/i.test(x.status ?? "")).length,
    pending: bookings.filter((x) => /pending|processing|initiated|awaiting/i.test(x.status ?? "")).length,
    cancelled: bookings.filter((x) => /cancel|fail|reject|refund|expired/i.test(x.status ?? "")).length,
  };

  const topRestaurants = rank(restaurants);
  const actions: InsightAction[] = [];
  for (const a of active.slice(0, 2)) {
    actions.push({ kind: "track", label: `Track ${a.title}`, orderId: a.orderId, service: a.service });
  }
  // "Your usual" = the most-ordered restaurant's latest reorderable order.
  const usualFrom = topRestaurants[0];
  const usualOrder = usualFrom
    ? food.find((o) => o.title === usualFrom.name && o.reorder && o.tone !== "cancelled")
    : undefined;
  const latestReorderable = food.find((o) => o.reorder && o.tone !== "cancelled");
  const reorderPick = usualOrder ?? latestReorderable;
  if (reorderPick) {
    actions.push({
      kind: "reorder",
      label:
        usualOrder && usualFrom && usualFrom.count >= 2
          ? `Reorder your usual from ${reorderPick.title}`
          : `Reorder from ${reorderPick.title}`,
      orderId: reorderPick.orderId,
    });
  }
  if (instamart.length || items.size) actions.push({ kind: "refill", label: "Refill Instamart usuals" });
  if (b.total) actions.push({ kind: "bookings", label: b.total === 1 ? "Check my booking" : "Check my bookings" });

  // Deterministic headline (real numbers only).
  const parts: string[] = [];
  if (priced.length) {
    parts.push(
      `${inr(spent)} on ${priced.length} order${priced.length === 1 ? "" : "s"}${oldest ? ` since ${oldest.label}` : ""}`,
    );
  }
  if (usualFrom && usualFrom.count >= 2) parts.push(`${usualFrom.name} is your go-to (${usualFrom.count} orders)`);
  if (usual) parts.push(`you usually order at ${usual.slot === "late-night" ? "late night" : usual.slot}`);
  let headline = parts.length ? `${parts.join(" — ")}.` : all.length ? "Here's your recent Swiggy activity." : "No orders yet.";
  headline = headline.charAt(0).toUpperCase() + headline.slice(1);
  if (active.length) headline += ` ${active.length} order${active.length === 1 ? " is" : "s are"} on the way now.`;

  return {
    headline,
    spent,
    spentOrders: priced.length,
    cancelled: all.length - counted.length,
    since: oldest?.label,
    topRestaurants,
    topDishes: rank(dishes),
    topItems: rank(items),
    usual,
    active,
    bookings: b,
    actions,
  };
}

/** The facts the AI summary may rephrase (every number in its answer must be in here). */
export function insightFacts(i: HistoryInsights): string[] {
  const f: string[] = [];
  if (i.spentOrders) f.push(`Spent ${inr(i.spent)} on ${i.spentOrders} orders${i.since ? ` since ${i.since}` : ""} (cancelled orders excluded)`);
  if (i.cancelled) f.push(`${i.cancelled} cancelled order${i.cancelled === 1 ? "" : "s"}`);
  if (i.topRestaurants.length) f.push(`Most-ordered restaurants: ${i.topRestaurants.map((r) => `${r.name} (${r.count})`).join(", ")}`);
  if (i.topDishes.length) f.push(`Most-ordered dishes: ${i.topDishes.map((r) => `${r.name} (${r.count})`).join(", ")}`);
  if (i.topItems.length) f.push(`Most-bought Instamart items: ${i.topItems.map((r) => `${r.name} (${r.count})`).join(", ")}`);
  if (i.usual) f.push(`Usually orders at ${i.usual.slot} time (${i.usual.count} of ${i.usual.of} orders)`);
  for (const a of i.active) f.push(`Active ${a.service} order from ${a.title}: ${a.status}`);
  if (i.bookings.total) {
    f.push(
      `Bookings made in this app: ${i.bookings.total} (${i.bookings.confirmed} confirmed, ${i.bookings.pending} pending, ${i.bookings.cancelled} cancelled)`,
    );
  }
  return f;
}

/**
 * One AI-style line per order (by orderId), from the order's real neighbours:
 * how many times the user ordered from this restaurant, and whether it was
 * the same as the previous time. `orders` is newest first (Swiggy's order).
 */
export function orderOneLiners(orders: HistoryOrder[], nowMs: number = Date.now()): Map<string, string> {
  const out = new Map<string, string>();
  const itemCounts = new Map<string, number>();
  for (const o of orders) {
    if (o.service !== "instamart" || o.tone === "cancelled") continue;
    for (const l of orderLines(o)) itemCounts.set(l.name, (itemCounts.get(l.name) ?? 0) + 1);
  }
  orders.forEach((o, i) => {
    if (!o.orderId) return;
    if (o.tone === "cancelled") {
      out.set(o.orderId, "Cancelled — not counted in your spend.");
      return;
    }
    if (o.active) {
      out.set(o.orderId, "On its way now — tap Track for Swiggy's live status.");
      return;
    }
    if (o.service === "instamart") {
      const repeat = orderLines(o)
        .map((l) => ({ name: l.name, n: itemCounts.get(l.name) ?? 0 }))
        .filter((x) => x.n >= 2)
        .sort((a, b) => b.n - a.n)[0];
      if (repeat) out.set(o.orderId, `Includes ${repeat.name}, which you bought in ${repeat.n} recent orders.`);
      return;
    }
    const same = orders.filter((x) => x.service === "food" && x.title === o.title && x.tone !== "cancelled");
    const older = orders.slice(i + 1).filter((x) => x.service === "food" && x.title === o.title && x.tone !== "cancelled");
    const nth = older.length + 1;
    const t = parseOrderTime(o.placedAt, nowMs);
    const when = t ? ` · a ${mealSlot(t.hour) === "late-night" ? "late-night" : mealSlot(t.hour)} order` : "";
    if (same.length === 1) {
      out.set(o.orderId, `Your only order from ${o.title} in this list${when}.`);
    } else if (nth === 1) {
      out.set(o.orderId, `Your first order from ${o.title} here${when}.`);
    } else {
      const prev = older[0];
      out.set(
        o.orderId,
        `Your ${ordinal(nth)} order from ${o.title}${prev ? (sameLines(o, prev) ? " — same as last time" : " — different from last time") : ""}${when}.`,
      );
    }
  });
  return out;
}
