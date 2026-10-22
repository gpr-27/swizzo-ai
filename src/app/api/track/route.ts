// POST /api/track — deterministic order tracking for a service. Read-only
// (never places an order); bypasses the agent so the tracking card refresh is
// reliable. Body { service, addressId, lat?, lng? }.
//
// Instamart → get_orders (active first) → get_delivery_status(orderId,
// addressId), plus track_order(orderId, lat, lng) when coordinates are known.
// Food → get_food_orders → track_food_order / get_food_delivery_status.
// Returns { tracker: {status, eta?, partner?, items?} | null, summary,
// pollIntervalSec? } — same shape as /api/orders.

import { MCP_SERVERS } from '@/backend/agent/services';
import { isAuthError } from '@/backend/config/env';
import { callToolData, isRecord, num } from '@/backend/mcp/client';
import { getInstamartTracking } from '@/backend/mcp/swiggy-mcp';
import { trackerFromDeliveryStatus, trackerFromTrackFoodOrder } from '@/backend/mcp/food-mcp';
import type { Service } from '@/shared/types';
import { route, unauthorized } from "@/backend/http/route";
import { TrackBody } from "@/backend/http/schemas";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Tracker {
  status: string;
  eta?: string;
  partner?: string;
  items?: string;
  trackUrl?: string; // Food: Swiggy's tracking page
  progress?: number; // Food: track_food_order progressPercentage
}

/* ------------------------------ food (generic) ----------------------------- */

function pickStr(o: Record<string, unknown>, keys: string[]): string {
  for (const k of keys) {
    const v = o[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return "";
}

const STATUS_KEYS = ["status", "currentStatus", "orderStatus", "deliveryStatus", "statusText", "statusMessage"];

const titleCase = (s: string) =>
  s ? s.charAt(0).toUpperCase() + s.slice(1).toLowerCase().replace(/_/g, " ") : "";

function toTracker(o: Record<string, unknown>): Tracker | null {
  const raw = pickStr(o, STATUS_KEYS);
  if (!raw) return null;
  const status = /delivered/i.test(raw) ? "Delivered" : titleCase(raw.split(/[,—]/)[0].trim());
  const eta = status !== "Delivered" ? pickStr(o, ["etaText", "estimatedDeliveryTime", "eta"]) || undefined : undefined;
  const count = num(o.itemCount, 0) || (Array.isArray(o.items) ? o.items.length : 0);
  const place = pickStr(o, ["restaurantName", "storeName"]);
  const items = [count ? `${count} item${count > 1 ? "s" : ""}` : "", place].filter(Boolean).join(" · ") || undefined;
  return { status, eta, items };
}

async function foodTracking(
  addressId: string,
): Promise<{ tracker: Tracker | null; summary: string; pollIntervalSec?: number }> {
  const url = MCP_SERVERS.food.url;
  // get_food_orders REQUIRES addressId (live schema; it only resolves coordinates).
  if (!addressId) return { tracker: null, summary: "Pick a delivery address to check your Food orders. 📦" };
  const payload = await callToolData(url, "get_food_orders", { addressId });
  const obj = isRecord(payload) ? payload : {};
  const orders = Array.isArray(obj.orders) ? obj.orders.filter(isRecord) : [];
  const order = orders[0];
  if (!order) return { tracker: null, summary: "You don't have any recent Food orders yet. 📦" };
  const orderId = pickStr(order, ["orderId", "order_id"]);
  let live: Tracker | null = null;
  let pollIntervalSec: number | undefined;
  if (orderId) {
    for (const tool of ["get_food_delivery_status", "track_food_order"]) {
      try {
        // Both take only orderId. track_food_order answers { orders: [...] } with
        // progressPercentage / pollingDuration / trackUrl; delivery status has
        // statusText / deliveryBy / pollIntervalSec / trackUrl.
        const d = await callToolData(url, tool, { orderId });
        const t = tool === "track_food_order" ? trackerFromTrackFoodOrder(d) : trackerFromDeliveryStatus(d);
        if (t) {
          const { pollIntervalSec: poll, ...rest } = t;
          live = rest;
          pollIntervalSec = poll;
          break;
        }
      } catch (err) {
        if (isAuthError(err)) throw err;
      }
    }
  }
  const tracker = live ?? toTracker(order);
  const summary = !tracker
    ? "Found your latest Food order, but Swiggy didn't return its status. 📦"
    : tracker.status === "Delivered"
      ? `Your latest Food order was delivered — ${tracker.items ?? "see details"}. 📦`
      : `Your Food order: ${tracker.status.toLowerCase()}${tracker.eta ? ` — about ${tracker.eta} away` : ""}. 🛵`;
  return { tracker, summary, ...(pollIntervalSec ? { pollIntervalSec } : {}) };
}

/* ---------------------------------- route ---------------------------------- */

export const POST = route({ name: "api/track", rateLimit: "read", body: TrackBody }, async function POST(request: Request): Promise<Response> {
  let body: { service?: Service; addressId?: string; lat?: number; lng?: number } = {};
  try {
    body = (await request.json()) as typeof body;
  } catch {
    // tolerate an empty body
  }

  const service: Service = body.service === "food" ? "food" : "instamart";
  const addressId = typeof body.addressId === "string" ? body.addressId : "";
  const lat = typeof body.lat === "number" && Number.isFinite(body.lat) ? body.lat : undefined;
  const lng = typeof body.lng === "number" && Number.isFinite(body.lng) ? body.lng : undefined;

  try {
    if (service === "instamart") {
      return Response.json(await getInstamartTracking({ addressId, lat, lng }));
    }
    return Response.json(await foodTracking(addressId));
  } catch (err) {
    if (isAuthError(err)) return unauthorized();
    console.error("[api/track] failed:", err);
    return Response.json(
      { tracker: null, summary: `Couldn't fetch your order status: ${err instanceof Error ? err.message : "Swiggy error"}` },
      { status: 502 },
    );
  }
});
