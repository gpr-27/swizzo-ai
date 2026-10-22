// GET /api/payments/status — ONE check_payment_status iteration (Swiggy holds
// the request up to ~19 s). The client must run these sequentially, never in
// parallel. Food also echoes addressId / cartId / lat / lng.

import { checkPaymentStatus, parseService, paymentErrorResponse } from "@/backend/mcp/payment-mcp";
import { route } from "@/backend/http/route";
import { PaymentStatusQuery } from "@/backend/http/schemas";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// The long-poll can take ~20 s; leave headroom on serverless hosts.
export const maxDuration = 45;

function optNum(v: string | null): number | undefined {
  if (v === null || v === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

export const GET = route({ name: "api/payments/status", rateLimit: "read", query: PaymentStatusQuery }, async function GET(request: Request): Promise<Response> {
  const { searchParams } = new URL(request.url);
  const service = parseService(searchParams.get("service"));
  const orderId = searchParams.get("orderId");
  const paasId = searchParams.get("paasId");
  if (!service || !orderId || !paasId) {
    return Response.json({ ok: false, message: "service, orderId and paasId are required." }, { status: 400 });
  }

  try {
    const status = await checkPaymentStatus(service, {
      orderId,
      paasId,
      addressId: searchParams.get("addressId") || undefined,
      cartId: searchParams.get("cartId") || undefined,
      lat: optNum(searchParams.get("lat")),
      lng: optNum(searchParams.get("lng")),
    });
    return Response.json({ ok: true, status });
  } catch (err) {
    return paymentErrorResponse(err, "Couldn't check the payment status");
  }
});
