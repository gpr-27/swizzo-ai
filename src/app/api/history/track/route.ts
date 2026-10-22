// POST /api/history/track { service: "food" | "instamart", orderId, addressId?, lat?, lng? }
// Live status for ONE order from the History page's "Track" button. Read-only.
//  Food      → track_food_order(orderId) (status, ETA, trackUrl), else
//              get_food_delivery_status(orderId).
//  Instamart → track_order(orderId, lat, lng) using the order's own delivery
//              coordinates from get_orders (else the caller's), else
//              get_delivery_status(orderId, addressId).
// Returns { ok, tracker: {status, eta?, partner?, items?} | null, trackUrl?, pollIntervalSec? }.

import { MCP_SERVERS } from "@/backend/agent/services";
import { isAuthError } from "@/backend/config/env";
import { callToolData, isRecord, num } from "@/backend/mcp/client";
import { trackerFromDeliveryStatus, trackerFromTrackFoodOrder } from "@/backend/mcp/food-mcp";
import {
  getDeliveryStatus,
  imTrackerFromDeliveryStatus,
  imTrackerFromTrackOrder,
  instamartOrderCoords,
  trackOrder,
} from "@/backend/mcp/swiggy-mcp";
import { foodTrackUrl } from "@/backend/history/history-map";
import { route } from "@/backend/http/route";
import { HistoryTrackBody } from "@/backend/http/schemas";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Tracker {
  status: string;
  eta?: string;
  partner?: string;
  items?: string;
  trackUrl?: string;
  progress?: number;
}

const pollSec = (v: unknown) => {
  const n = num(v, 0);
  // Never poll faster than 10 s (docs: rate limits).
  return n > 0 ? Math.max(10, n) : undefined;
};

async function trackFood(orderId: string) {
  const url = MCP_SERVERS.food.url;
  let tracker: Tracker | null = null;
  let trackUrl = `https://www.swiggy.com/track-order/${encodeURIComponent(orderId)}`;
  let pollIntervalSec: number | undefined;
  try {
    const t = await callToolData(url, "track_food_order", { orderId });
    const tr = trackerFromTrackFoodOrder(t);
    if (tr) {
      // progressPercentage / pollingDuration ride along (food-mcp mapper)
      const { pollIntervalSec: poll, ...rest } = tr;
      tracker = rest;
      pollIntervalSec = poll;
    }
    trackUrl = foodTrackUrl(t, orderId);
  } catch (err) {
    if (isAuthError(err)) throw err;
  }
  if (!tracker) {
    try {
      const d = await callToolData(url, "get_food_delivery_status", { orderId });
      tracker = trackerFromDeliveryStatus(d);
      if (isRecord(d)) pollIntervalSec = pollSec(d.pollIntervalSec);
    } catch (err) {
      if (isAuthError(err)) throw err;
    }
  }
  return { tracker, trackUrl, pollIntervalSec };
}

async function trackInstamart(orderId: string, addressId: string, lat?: number, lng?: number) {
  let tracker: Tracker | null = null;
  let pollIntervalSec: number | undefined;
  const coords = (await instamartOrderCoords(orderId).catch(() => undefined)) ??
    (lat !== undefined && lng !== undefined ? { lat, lng } : undefined);
  if (coords) {
    try {
      const t = await trackOrder(orderId, coords.lat, coords.lng);
      tracker = imTrackerFromTrackOrder(t);
      pollIntervalSec = pollSec(t.pollingIntervalSeconds);
    } catch (err) {
      if (isAuthError(err)) throw err;
    }
  }
  if (!tracker && addressId) {
    try {
      const d = await getDeliveryStatus(orderId, addressId);
      tracker = imTrackerFromDeliveryStatus(d);
      pollIntervalSec = pollSec(d.pollIntervalSec);
    } catch (err) {
      if (isAuthError(err)) throw err;
    }
  }
  return { tracker, pollIntervalSec };
}

export const POST = route({ name: "api/history/track", rateLimit: "read", body: HistoryTrackBody }, async function POST(request: Request): Promise<Response> {
  let body: { service?: unknown; orderId?: unknown; addressId?: unknown; lat?: unknown; lng?: unknown } = {};
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return Response.json({ ok: false, message: "Invalid JSON body." }, { status: 400 });
  }
  const orderId = typeof body.orderId === "string" ? body.orderId.trim() : "";
  if (!orderId || orderId.length > 64) {
    return Response.json({ ok: false, message: "orderId is required." }, { status: 400 });
  }
  const service = body.service === "instamart" ? "instamart" : "food";
  const addressId = typeof body.addressId === "string" ? body.addressId : "";
  const lat = typeof body.lat === "number" && Number.isFinite(body.lat) ? body.lat : undefined;
  const lng = typeof body.lng === "number" && Number.isFinite(body.lng) ? body.lng : undefined;
  try {
    const r = service === "food" ? await trackFood(orderId) : await trackInstamart(orderId, addressId, lat, lng);
    return Response.json({
      ok: true,
      ...r,
      ...(r.tracker ? {} : { message: "Swiggy didn't return a live status for this order right now." }),
    });
  } catch (err) {
    if (isAuthError(err)) {
      return Response.json({ ok: false, needsLogin: true, message: "Your Swiggy session expired — please log in again." }, { status: 401 });
    }
    console.error("[api/history/track] failed:", err);
    return Response.json(
      { ok: false, message: err instanceof Error && err.message ? err.message : "Couldn't track this order." },
      { status: 502 },
    );
  }
});
