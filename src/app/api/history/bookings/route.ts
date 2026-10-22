// POST /api/history/bookings
//   { items: [{ kind: "dineout" | "scenes", orderId, restaurantId?, lat?, lng? }], lat?, lng? }
// Live status for the bookings this app saved (Swiggy's MCP has no "list my
// bookings" tool — only get_booking_status / get_event_booking_status by
// orderId), plus each Dineout restaurant's OFFICIAL photo from
// get_restaurant_details (restaurantId from the saved booking or the status
// reply; coordinates saved at booking time, else the caller's address). Scenes
// returns no images at all — the page draws its generated poster art instead.
// Read-only; each row fails independently.

import { isAuthError } from "@/backend/config/env";
import { describeDineoutBooking, getDineoutBookingStatus, getDineoutRestaurantDetails } from "@/backend/mcp/dineout-mcp";
import { getScenesBookingStatus } from "@/backend/mcp/scenes-mcp";
import { route } from "@/backend/http/route";
import { HistoryBookingsBody } from "@/backend/http/schemas";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Item {
  kind: "dineout" | "scenes";
  orderId: string;
  restaurantId?: string;
  lat?: number;
  lng?: number;
}

export interface HistoryBookingRow {
  kind: "dineout" | "scenes";
  orderId: string;
  ok: boolean;
  status?: string;
  title?: string;
  details?: string;
  imageUrl?: string;
  error?: string;
}

const MAX_ITEMS = 20;
const CONCURRENCY = 3;

const fin = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

async function lookup(item: Item, fallback: { lat?: number; lng?: number }): Promise<HistoryBookingRow> {
  if (item.kind === "dineout") {
    const b = await getDineoutBookingStatus(item.orderId);
    const restaurantId = item.restaurantId || b.restaurantId || "";
    const lat = item.lat ?? fallback.lat;
    const lng = item.lng ?? fallback.lng;
    let imageUrl: string | undefined;
    if (restaurantId && lat !== undefined && lng !== undefined) {
      // Photo is a nice-to-have: a failed details call never fails the row.
      imageUrl = (await getDineoutRestaurantDetails(restaurantId, lat, lng).catch(() => null))?.imageUrl || undefined;
    }
    return {
      kind: "dineout",
      orderId: b.orderId || item.orderId,
      ok: true,
      status: b.status,
      title: b.restaurantName ? `Table at ${b.restaurantName}` : undefined,
      details: describeDineoutBooking(b) || undefined,
      ...(imageUrl ? { imageUrl } : {}),
    };
  }
  const b = await getScenesBookingStatus(item.orderId);
  return {
    kind: "scenes",
    orderId: b.orderId || item.orderId,
    ok: true,
    status: b.status,
    title: b.title || b.venueName,
    details:
      [
        b.venueName ? (b.venueLocation ? `${b.venueName}, ${b.venueLocation}` : b.venueName) : "",
        [b.date, b.time].filter(Boolean).join(" · "),
        b.guestCount ? `${b.guestCount} ticket${b.guestCount === 1 ? "" : "s"}` : "",
      ]
        .filter(Boolean)
        .join(" | ") || undefined,
  };
}

export const POST = route({ name: "api/history/bookings", rateLimit: "read", body: HistoryBookingsBody }, async function POST(request: Request): Promise<Response> {
  let body: { items?: unknown; lat?: unknown; lng?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return Response.json({ ok: false, message: "Invalid JSON body." }, { status: 400 });
  }
  const items: Item[] = (Array.isArray(body.items) ? body.items : [])
    .filter(
      (i): i is Item =>
        !!i &&
        typeof i === "object" &&
        ((i as Item).kind === "dineout" || (i as Item).kind === "scenes") &&
        typeof (i as Item).orderId === "string" &&
        (i as Item).orderId.length > 0 &&
        (i as Item).orderId.length < 80,
    )
    .map((i) => ({
      kind: i.kind,
      orderId: i.orderId,
      ...(typeof i.restaurantId === "string" && i.restaurantId.length < 40 ? { restaurantId: i.restaurantId } : {}),
      ...(fin(i.lat) !== undefined && fin(i.lng) !== undefined ? { lat: fin(i.lat), lng: fin(i.lng) } : {}),
    }))
    .slice(0, MAX_ITEMS);
  const fallback = { lat: fin(body.lat), lng: fin(body.lng) };

  const rows: HistoryBookingRow[] = new Array(items.length);
  let next = 0;
  let authFailed = false;
  async function worker() {
    while (next < items.length) {
      const idx = next++;
      const item = items[idx];
      try {
        rows[idx] = await lookup(item, fallback);
      } catch (err) {
        if (isAuthError(err)) authFailed = true;
        rows[idx] = {
          kind: item.kind,
          orderId: item.orderId,
          ok: false,
          error: err instanceof Error && err.message ? err.message : "Could not load this booking.",
        };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, worker));

  if (authFailed && rows.every((r) => !r.ok)) {
    return Response.json(
      { ok: false, needsLogin: true, message: "Your Swiggy session expired — please log in again." },
      { status: 401 },
    );
  }
  return Response.json({ ok: true, bookings: rows });
});
