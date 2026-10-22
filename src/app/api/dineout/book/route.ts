// POST /api/dineout/book — book_table, after the user confirmed in the slot picker.
// Body (all copied verbatim from the selected slot + deal):
//   { restaurantId, slotId:number, itemId, reservationTime:number, guestCount:1-20,
//     latitude, longitude,
//     payment?: { cartKey, intentApp? | generateUPIQR?, amount? }   // PAID deals only
//     restaurantName? }                                            // display only
// Replies:
//   FREE  → { ok:true, booking }                       (confirmed in one step)
//   PAID  → { ok:true, paymentSession, booking }       (status PENDING_PAYMENT)
//   error → { ok:false, message }  — Swiggy's own message, never a fake booking.

import {
  bookDineoutTable,
  dineoutErrorResponse,
  dineoutOrdersEnabled,
  ORDERS_DISABLED_MESSAGE,
  parseDineoutSlotArgs,
} from "@/backend/mcp/dineout-mcp";
import { route } from "@/backend/http/route";
import { DineoutBookBody } from "@/backend/http/schemas";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export const POST = route({ name: "api/dineout/book", rateLimit: "order", body: DineoutBookBody, idempotent: "dineout:book" }, async function POST(request: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ ok: false, message: "Invalid JSON body." }, { status: 400 });
  }

  const args = parseDineoutSlotArgs(body);
  if (typeof args === "string") {
    return Response.json({ ok: false, message: args }, { status: 400 });
  }

  const b = isRecord(body) ? body : {};
  let payment: { cartKey: string; intentApp?: string; generateUPIQR?: boolean; amount?: number; title?: string } | undefined;
  if (isRecord(b.payment)) {
    const p = b.payment;
    const cartKey = typeof p.cartKey === "string" ? p.cartKey : "";
    const intentApp = typeof p.intentApp === "string" && p.intentApp ? p.intentApp : undefined;
    const generateUPIQR = p.generateUPIQR === true;
    if (!cartKey) {
      return Response.json({ ok: false, message: "payment.cartKey (from create_cart) is required for a paid deal." }, { status: 400 });
    }
    if (!intentApp && !generateUPIQR) {
      return Response.json({ ok: false, message: "Pick a UPI app or scan-QR to pay for this deal." }, { status: 400 });
    }
    const restaurantName = typeof b.restaurantName === "string" ? b.restaurantName : "";
    payment = {
      cartKey,
      intentApp,
      generateUPIQR,
      amount: typeof p.amount === "number" && Number.isFinite(p.amount) ? p.amount : undefined,
      title: restaurantName ? `Table at ${restaurantName}` : "Dineout table booking",
    };
  }

  if (!dineoutOrdersEnabled()) {
    return Response.json({ ok: false, placed: false, gated: true, message: ORDERS_DISABLED_MESSAGE });
  }

  try {
    const result = await bookDineoutTable(args, payment);
    if (result.kind === "pending_payment") {
      return Response.json({ ok: true, paymentSession: result.session, booking: result.booking });
    }
    return Response.json({ ok: true, booking: result.booking });
  } catch (err) {
    console.error("[api/dineout/book] error:", err);
    return dineoutErrorResponse(err, { mutating: true, fallback: "Booking failed." });
  }
});
