// POST /api/scenes/order — place_event_order after the user explicitly confirmed
// the create_event_cart summary. Gated by SWIGGY_ENABLE_ORDERS="true".
//   UPI : { cartKey, paymentMethod:"UPI", intentApp }            (UPI app — method id from get_payment_options)
//         { cartKey, paymentMethod:"UPI", generateUPIQR:true }   (scan-QR)
//         → { ok, placed:true, outcome:{ kind:"upi", session } } — status PENDING_PAYMENT,
//           NOT booked until the payment stage (check_payment_status → confirm_order) succeeds.
//   FREE: { cartKey, paymentMethod:"FREE", selection:{ venueId, showId, ticketId, showTime, guestCount, latitude, longitude } }
//         → { ok, placed:true, outcome:{ kind:"free", booking } } — CONFIRMED, or PROCESSING (re-checked once).
// place_event_order is never retried: on an ambiguous failure we say so instead of guessing.

import {
  getScenesBookingStatus,
  parseSelection,
  placeScenesEventOrder,
  scenesErrorResponse,
} from "@/backend/mcp/scenes-mcp";
import type { ScenesBooking } from "@/shared/types";
import { route } from "@/backend/http/route";
import { ScenesOrderBody } from "@/backend/http/schemas";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** FREE bookings: PROCESSING (or missing venue fields) → read get_event_booking_status once. */
async function settleFreeBooking(booking: ScenesBooking): Promise<ScenesBooking> {
  const processing = booking.status.toUpperCase() === "PROCESSING";
  if (!processing && booking.venueName) return booking;
  try {
    if (processing) await sleep(2500);
    const latest = await getScenesBookingStatus(booking.orderId);
    // Only fields the lookup actually returned override the placement response.
    const defined = Object.fromEntries(
      Object.entries(latest).filter(([, v]) => v !== undefined && v !== ""),
    ) as Partial<ScenesBooking>;
    return { ...booking, ...defined };
  } catch (err) {
    console.warn("[api/scenes/order] booking status follow-up failed:", err);
    return booking;
  }
}

export const POST = route({ name: "api/scenes/order", rateLimit: "order", body: ScenesOrderBody, idempotent: "scenes:order" }, async function POST(request: Request): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return Response.json({ ok: false, message: "Invalid request." }, { status: 400 });
  }

  if (process.env.SWIGGY_ENABLE_ORDERS !== "true") {
    return Response.json({ ok: false, placed: false, gated: true, message: "Ordering is disabled on this server" });
  }

  const cartKey = typeof body.cartKey === "string" ? body.cartKey : "";
  if (!cartKey) {
    return Response.json({ ok: false, message: "Create the ticket cart first." }, { status: 400 });
  }

  try {
    if (body.paymentMethod === "FREE") {
      const selection = parseSelection(body.selection);
      if (typeof selection === "string") {
        return Response.json({ ok: false, message: selection }, { status: 400 });
      }
      const res = await placeScenesEventOrder({ paymentMethod: "FREE", cartKey, selection });
      if (res.kind !== "free") throw new Error("Unexpected order response.");
      const booking = await settleFreeBooking(res.booking);
      return Response.json({ ok: true, placed: true, outcome: { kind: "free", booking, message: res.message } });
    }

    if (body.paymentMethod === "UPI") {
      const intentApp = typeof body.intentApp === "string" && body.intentApp ? body.intentApp : undefined;
      const generateUPIQR = !intentApp && body.generateUPIQR === true;
      if (!intentApp && !generateUPIQR) {
        return Response.json({ ok: false, message: "Pick a UPI app or scan-QR to pay." }, { status: 400 });
      }
      const res = await placeScenesEventOrder({
        paymentMethod: "UPI",
        cartKey,
        intentApp,
        generateUPIQR,
        amount: typeof body.amount === "number" && Number.isFinite(body.amount) ? body.amount : undefined,
        title: typeof body.title === "string" ? body.title.slice(0, 120) : undefined,
      });
      if (res.kind !== "upi") throw new Error("Unexpected order response.");
      return Response.json({ ok: true, placed: true, outcome: { kind: "upi", session: res.session } });
    }

    return Response.json({ ok: false, message: 'paymentMethod must be "UPI" or "FREE".' }, { status: 400 });
  } catch (err) {
    const name = (err as { name?: string } | null)?.name;
    if (name === "AuthError" || name === "SwiggyToolError") {
      return scenesErrorResponse(err, "api/scenes/order");
    }
    // Transport failure after sending: the order may or may not exist, and
    // without an orderId we can't look it up — never claim either outcome.
    console.error("[api/scenes/order] ambiguous failure:", err);
    return Response.json(
      {
        ok: false,
        ambiguous: true,
        message:
          "We couldn't confirm whether this booking went through. Please check your Swiggy app before trying again.",
      },
      { status: 502 },
    );
  }
});
