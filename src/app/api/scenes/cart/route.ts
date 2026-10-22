// POST /api/scenes/cart — create_event_cart for the show + ticket the user picked.
// Body: { venueId, showId, ticketId, showTime, guestCount, latitude, longitude }
// (showTime = list_event_shows show_time_unix, verbatim).
// Returns { ok, cart: { cartKey, checkoutMode, billToPay, summary, selection } }.
// Nothing is placed here: the UI shows `summary` and waits for an explicit
// confirm before /api/scenes/order. checkoutMode UNAVAILABLE means stop.
//
// GET /api/scenes/cart?cartKey=&latitude=&longitude= — get_event_cart (read-only)
// to re-check a PAID cart that waited on the review step before paying.
// Returns { ok, paymentAvailable?, billToPay?, summary? }.

import {
  createScenesEventCart,
  getScenesEventCart,
  parseSelection,
  scenesErrorResponse,
} from "@/backend/mcp/scenes-mcp";
import { route } from "@/backend/http/route";
import { ScenesCartBody, ScenesCartQuery } from "@/backend/http/schemas";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = route({ name: "api/scenes/cart", rateLimit: "order", body: ScenesCartBody, idempotent: "scenes:cart" }, async function POST(request: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ ok: false, message: "Invalid request." }, { status: 400 });
  }
  const selection = parseSelection(body);
  if (typeof selection === "string") {
    return Response.json({ ok: false, message: selection }, { status: 400 });
  }

  try {
    const cart = await createScenesEventCart(selection);
    if (cart.checkoutMode === "UNAVAILABLE") {
      return Response.json({
        ok: false,
        unavailable: true,
        message: cart.summary || "This show can't be booked here. Please pick a different show.",
      });
    }
    return Response.json({ ok: true, cart });
  } catch (err) {
    // A sold-out / unavailable show is a non-retryable SwiggyToolError → 422 with Swiggy's message.
    return scenesErrorResponse(err, "api/scenes/cart");
  }
});

export const GET = route({ name: "api/scenes/cart", rateLimit: "read", query: ScenesCartQuery }, async function GET(request: Request): Promise<Response> {
  const q = new URL(request.url).searchParams;
  const cartKey = (q.get("cartKey") ?? "").trim();
  const latitude = Number(q.get("latitude"));
  const longitude = Number(q.get("longitude"));
  if (!cartKey || !Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    return Response.json({ ok: false, message: "cartKey, latitude and longitude are required." }, { status: 400 });
  }
  try {
    return Response.json({ ok: true, ...(await getScenesEventCart(cartKey, { latitude, longitude })) });
  } catch (err) {
    return scenesErrorResponse(err, "api/scenes/cart GET");
  }
});
