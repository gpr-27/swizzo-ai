// POST /api/bookings { items: [{ kind: "dineout" | "scenes", orderId }] }
// Live status for every booking this app has made. Swiggy's MCP has no
// "list my bookings" tool, so the client sends the order ids it saved and we
// look each one up (get_booking_status / get_event_booking_status).

import { isAuthError } from "@/backend/config/env";
import { getDineoutBookingStatus } from "@/backend/mcp/dineout-mcp";
import { getScenesBookingStatus } from "@/backend/mcp/scenes-mcp";
import { route } from "@/backend/http/route";
import { BookingsBody } from "@/backend/http/schemas";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Item = { kind: "dineout" | "scenes"; orderId: string };

export interface BookingStatusRow {
  kind: "dineout" | "scenes";
  orderId: string;
  ok: boolean;
  status?: string;
  title?: string;
  details?: string;
  error?: string;
}

const MAX_ITEMS = 15;
const CONCURRENCY = 3;

async function lookup(item: Item): Promise<BookingStatusRow> {
  if (item.kind === "dineout") {
    const b = await getDineoutBookingStatus(item.orderId);
    return {
      kind: "dineout",
      orderId: b.orderId || item.orderId,
      ok: true,
      status: b.status,
      title: b.restaurantName ? `Table at ${b.restaurantName}` : undefined,
      details: [
        b.reservationDate,
        b.reservationTime,
        b.guestCount ? `${b.guestCount} guest${b.guestCount === 1 ? "" : "s"}` : "",
        b.dealTitle,
        b.restaurantLocation,
      ]
        .filter(Boolean)
        .join(" · "),
    };
  }
  const b = await getScenesBookingStatus(item.orderId);
  return {
    kind: "scenes",
    orderId: b.orderId || item.orderId,
    ok: true,
    status: b.status,
    title: b.title || b.venueName,
    details: [
      b.venueName ? (b.venueLocation ? `${b.venueName}, ${b.venueLocation}` : b.venueName) : "",
      [b.date, b.time].filter(Boolean).join(" · "),
      b.guestCount ? `${b.guestCount} ticket${b.guestCount === 1 ? "" : "s"}` : "",
    ]
      .filter(Boolean)
      .join(" | "),
  };
}

export const POST = route({ name: "api/bookings", rateLimit: "read", body: BookingsBody }, async function POST(request: Request): Promise<Response> {
  let body: { items?: unknown };
  try {
    body = (await request.json()) as { items?: unknown };
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
    .slice(0, MAX_ITEMS);

  const rows: BookingStatusRow[] = new Array(items.length);
  let next = 0;
  let authFailed = false;
  async function worker() {
    while (next < items.length) {
      const idx = next++;
      const item = items[idx];
      try {
        rows[idx] = await lookup(item);
      } catch (err) {
        if (isAuthError(err)) authFailed = true;
        rows[idx] = {
          kind: item.kind,
          orderId: item.orderId,
          ok: false,
          error: err instanceof Error ? err.message : "Could not load this booking.",
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
