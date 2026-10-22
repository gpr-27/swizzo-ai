// POST /api/dineout/cart — create_cart (DEAL_TICKET_PURCHASE) for a PAID deal.
// Body: { restaurantId, slotId, itemId, reservationTime, guestCount, latitude, longitude }
// copied verbatim from the selected get_available_slots slot + deal.
// Returns the cartKey + live billToPay for the Booking Summary. The caller then
// STOPS until the user taps "Proceed to payment" (per the create_cart contract).
// FREE deals skip this route — book_table creates and confirms them in one step.

import {
  createDineoutDealCart,
  dineoutErrorResponse,
  dineoutOrdersEnabled,
  ORDERS_DISABLED_MESSAGE,
  parseDineoutSlotArgs,
} from "@/backend/mcp/dineout-mcp";
import { route } from "@/backend/http/route";
import { DineoutCartBody } from "@/backend/http/schemas";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = route({ name: "api/dineout/cart", rateLimit: "order", body: DineoutCartBody, idempotent: "dineout:cart" }, async function POST(request: Request): Promise<Response> {
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

  if (!dineoutOrdersEnabled()) {
    return Response.json({ ok: false, placed: false, gated: true, message: ORDERS_DISABLED_MESSAGE });
  }

  try {
    const cart = await createDineoutDealCart(args);
    return Response.json({ ok: true, cart });
  } catch (err) {
    console.error("[api/dineout/cart] error:", err);
    return dineoutErrorResponse(err, { mutating: true, fallback: "Could not create the booking cart." });
  }
});
