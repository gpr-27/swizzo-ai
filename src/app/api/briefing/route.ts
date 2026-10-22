// POST /api/briefing { service, addressId?, bookings?: [{kind, orderId, title, details?}] }
// → { ok, briefing, ai?: { text, model } }
// The proactive home briefing for an EMPTY tab. Read-only and cheap: only the
// reads that tab needs, each cached per user for a few minutes —
//   food      → get_food_orders (15)
//   instamart → get_orders
//   dineout   → get_booking_status for the newest saved tables + get_food_orders (taste)
//   scenes    → get_event_booking_status for the newest saved tickets
//   plan      → get_food_orders + get_orders + up to 3 booking statuses
// then one grounded AI phrasing (ai-phrase.ts, ~3.5 s budget). Every part fails
// soft: the client falls back to the static welcome on any error.

import { createHash } from "node:crypto";
import { MCP_SERVERS } from "@/backend/agent/services";
import { buildBriefing, type BriefingBooking } from "@/backend/briefing/briefing";
import { aiPhrase } from "@/backend/briefing/ai-phrase";
import { getSwiggyToken, isAuthError } from "@/backend/config/env";
import { mapFoodHistory, mapInstamartHistory, type HistoryOrder } from "@/backend/history/history-map";
import { callToolData, isRecord } from "@/backend/mcp/client";
import { describeDineoutBooking, getDineoutBookingStatus } from "@/backend/mcp/dineout-mcp";
import { getFoodOrders } from "@/backend/mcp/food-mcp";
import { getScenesBookingStatus } from "@/backend/mcp/scenes-mcp";
import { getAddresses } from "@/backend/mcp/swiggy-mcp";
import { SERVICES, type Service } from "@/shared/types";
import { route } from "@/backend/http/route";
import { BriefingBody } from "@/backend/http/schemas";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const TTL_MS = 3 * 60_000;
const cache = new Map<string, { at: number; value: unknown }>();

async function cached<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value as T;
  const value = await fn();
  if (cache.size > 500) cache.delete(cache.keys().next().value as string);
  cache.set(key, { at: Date.now(), value });
  return value;
}

async function userKey(): Promise<string> {
  const token = (await getSwiggyToken().catch(() => null)) ?? "anon";
  return createHash("sha256").update(token).digest("hex").slice(0, 16);
}

/** Read helpers: null on a non-auth failure (the briefing just leaves that part out). */
async function soft<T>(fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch (err) {
    if (isAuthError(err)) throw err;
    return null;
  }
}

async function foodOrders(user: string, addressIdIn: string): Promise<HistoryOrder[] | null> {
  return soft(() =>
    cached(`${user}:food:${addressIdIn}`, async () => {
      const addressId = addressIdIn || (await getAddresses())[0]?.id || "";
      if (!addressId) return [];
      return mapFoodHistory(await getFoodOrders(addressId, { orderCount: 15 }));
    }),
  );
}

async function instamartOrders(user: string): Promise<HistoryOrder[] | null> {
  return soft(() =>
    cached(`${user}:im`, async () => {
      const data = await callToolData(MCP_SERVERS.instamart.url, "get_orders", { count: 20 });
      return mapInstamartHistory(isRecord(data) && Array.isArray(data.orders) ? data.orders : []);
    }),
  );
}

async function bookingStatus(user: string, b: BriefingBooking): Promise<BriefingBooking> {
  const row = await soft(() =>
    cached(`${user}:bk:${b.kind}:${b.orderId}`, async () => {
      if (b.kind === "dineout") {
        const s = await getDineoutBookingStatus(b.orderId);
        return { status: s.status, details: describeDineoutBooking(s) || undefined };
      }
      const s = await getScenesBookingStatus(b.orderId);
      return { status: s.status, details: [s.date, s.time].filter(Boolean).join(" · ") || undefined };
    }),
  );
  return row ? { ...b, status: row.status, details: row.details || b.details } : b;
}

function parseBookings(raw: unknown): BriefingBooking[] {
  return (Array.isArray(raw) ? raw : [])
    .filter(isRecord)
    .filter(
      (b) =>
        (b.kind === "dineout" || b.kind === "scenes") &&
        typeof b.orderId === "string" &&
        b.orderId.length > 0 &&
        b.orderId.length < 80,
    )
    .map((b) => ({
      kind: b.kind as BriefingBooking["kind"],
      orderId: b.orderId as string,
      title: typeof b.title === "string" ? b.title.slice(0, 120) : "Booking",
      ...(typeof b.details === "string" ? { details: b.details.slice(0, 160) } : {}),
    }))
    .slice(0, 10);
}

export const POST = route({ name: "api/briefing", rateLimit: "ai", body: BriefingBody }, async function POST(request: Request): Promise<Response> {
  let body: { service?: unknown; addressId?: unknown; bookings?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return Response.json({ ok: false, message: "Invalid JSON body." }, { status: 400 });
  }
  const service = (SERVICES as string[]).includes(String(body.service)) ? (body.service as Service) : null;
  if (!service) return Response.json({ ok: false, message: "Unknown service." }, { status: 400 });
  const addressId = typeof body.addressId === "string" ? body.addressId.trim().slice(0, 128) : "";
  const saved = parseBookings(body.bookings);

  try {
    const user = await userKey();
    const kinds: BriefingBooking["kind"][] =
      service === "dineout" ? ["dineout"] : service === "scenes" ? ["scenes"] : service === "plan" ? ["dineout", "scenes"] : [];
    const wanted = saved.filter((b) => kinds.includes(b.kind)).slice(0, 3);
    const [food, instamart, bookings] = await Promise.all([
      service === "food" || service === "dineout" || service === "plan" ? foodOrders(user, addressId) : Promise.resolve(null),
      service === "instamart" || service === "plan" ? instamartOrders(user) : Promise.resolve(null),
      Promise.all(wanted.map((b) => bookingStatus(user, b))),
    ]);
    const briefing = buildBriefing({ service, nowMs: Date.now(), food, instamart, bookings });
    const ai = briefing.hasData
      ? await aiPhrase({
          task: `Write the welcome briefing for the ${service} tab of the app: 1-2 short sentences (max 200 characters) that open with "${briefing.greeting}" and lead with the most useful real thing (an active order or upcoming booking first, else their usual).`,
          facts: briefing.facts,
          maxChars: 220,
          timeoutMs: 3_500,
        }).catch(() => null)
      : null;
    return Response.json(
      { ok: true, briefing, ...(ai ? { ai } : {}) },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (err) {
    if (isAuthError(err)) {
      return Response.json({ ok: false, needsLogin: true, message: "Your Swiggy session expired — please log in again." }, { status: 401 });
    }
    console.error("[api/briefing] failed:", err);
    return Response.json({ ok: false, message: "Couldn't build your briefing." }, { status: 502 });
  }
});
