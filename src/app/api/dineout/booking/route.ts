// GET  /api/dineout/booking?orderId=   → get_booking_status (+ canCancel)
// POST /api/dineout/booking { orderId, action:"cancel", reason? } → cancel_booking
// Cancellation is destructive: the UI must show "Cancel booking <orderId>?" and
// get an explicit yes before calling this. cancel_booking is not rolled out for
// every account (checked via tools/list): when it's missing, or on failure, the
// user is pointed to the Swiggy Dineout app / customer care.

import {
  cancelDineoutBooking,
  dineoutCanCancel,
  DineoutCancelUnavailableError,
  dineoutErrorResponse,
  dineoutOrdersEnabled,
  DINEOUT_SUPPORT_HINT,
  getDineoutBookingStatus,
  ORDERS_DISABLED_MESSAGE,
} from "@/backend/mcp/dineout-mcp";
import { route } from "@/backend/http/route";
import { DineoutBookingQuery, DineoutCancelBody } from "@/backend/http/schemas";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = route({ name: "api/dineout/booking", rateLimit: "read", query: DineoutBookingQuery }, async function GET(request: Request): Promise<Response> {
  const orderId = new URL(request.url).searchParams.get("orderId");
  if (!orderId) {
    return Response.json({ ok: false, message: "orderId is required." }, { status: 400 });
  }
  try {
    const [booking, canCancel] = await Promise.all([
      getDineoutBookingStatus(orderId),
      dineoutCanCancel().catch(() => undefined),
    ]);
    // canCancel: true/false from the live tool list; omitted when unknown.
    return Response.json({ ok: true, booking, ...(canCancel === undefined ? {} : { canCancel }) });
  } catch (err) {
    console.error("[api/dineout/booking] status error:", err);
    return dineoutErrorResponse(err, { fallback: "Could not load the booking status." });
  }
});

export const POST = route({ name: "api/dineout/booking", rateLimit: "order", body: DineoutCancelBody, idempotent: "dineout:cancel" }, async function POST(request: Request): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return Response.json({ ok: false, message: "Invalid JSON body." }, { status: 400 });
  }
  const orderId = typeof body.orderId === "string" ? body.orderId : "";
  if (!orderId || body.action !== "cancel") {
    return Response.json({ ok: false, message: "orderId and action:\"cancel\" are required." }, { status: 400 });
  }
  if (!dineoutOrdersEnabled()) {
    return Response.json({ ok: false, placed: false, gated: true, message: ORDERS_DISABLED_MESSAGE });
  }
  try {
    const reason = typeof body.reason === "string" ? body.reason : undefined;
    const result = await cancelDineoutBooking(orderId, reason);
    return Response.json({ ok: true, ...result });
  } catch (err) {
    if (err instanceof DineoutCancelUnavailableError) {
      return Response.json({ ok: false, unavailable: true, message: err.message });
    }
    console.error("[api/dineout/booking] cancel error:", err);
    const res = dineoutErrorResponse(err, { mutating: true, fallback: "Cancellation failed." });
    if (res.status === 401) return res;
    const payload = (await res.json()) as Record<string, unknown>;
    return Response.json({ ...payload, message: `${String(payload.message)} ${DINEOUT_SUPPORT_HINT}` }, { status: res.status });
  }
});
