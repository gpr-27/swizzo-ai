// POST /api/payments/confirm — confirm_order for a UPI order. Call only after a
// terminal success that was NOT auto-confirmed, or once at the polling cap.
// `confirmed` is true only when Swiggy returns result "success".

import { ordersEnabled } from "@/backend/config/env";
import { confirmOrder, parseService, paymentErrorResponse } from "@/backend/mcp/payment-mcp";
import { route } from "@/backend/http/route";
import { PaymentConfirmBody } from "@/backend/http/schemas";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function optNum(v: unknown): number | undefined {
  const n = typeof v === "string" && v !== "" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : undefined;
}

function optStr(v: unknown): string | undefined {
  return typeof v === "string" && v ? v : undefined;
}

export const POST = route({ name: "api/payments/confirm", rateLimit: "order", body: PaymentConfirmBody, idempotent: "payments:confirm" }, async function POST(request: Request): Promise<Response> {
  let body: Record<string, unknown> = {};
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return Response.json({ ok: false, message: "Invalid JSON body." }, { status: 400 });
  }

  const service = parseService(body.service);
  const orderId = optStr(body.orderId);
  if (!service || !orderId) {
    return Response.json({ ok: false, message: "service and orderId are required." }, { status: 400 });
  }
  if (!ordersEnabled()) {
    return Response.json(
      { ok: false, confirmed: false, gated: true, message: "Ordering is disabled on this server" },
      { status: 403 },
    );
  }

  try {
    const result = await confirmOrder(service, {
      orderId,
      paasId: optStr(body.paasId),
      transactionId: optStr(body.transactionId),
      addressId: optStr(body.addressId),
      cartId: optStr(body.cartId),
      lat: optNum(body.lat),
      lng: optNum(body.lng),
    });
    return Response.json({ ok: true, confirmed: result.result === "success", result });
  } catch (err) {
    return paymentErrorResponse(err, "Couldn't confirm the order");
  }
});
