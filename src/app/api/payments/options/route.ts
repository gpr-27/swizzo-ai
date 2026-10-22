// GET /api/payments/options?service=&addressId=&cartKey= — live payment methods
// (get_payment_options). Read-only; order placement lives in each service's own
// route behind explicit user confirmation.

import { getPaymentOptions, parseService, paymentErrorResponse } from "@/backend/mcp/payment-mcp";
import { route } from "@/backend/http/route";
import { PaymentOptionsQuery } from "@/backend/http/schemas";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = route({ name: "api/payments/options", rateLimit: "read", query: PaymentOptionsQuery }, async function GET(request: Request): Promise<Response> {
  const { searchParams } = new URL(request.url);
  const service = parseService(searchParams.get("service"));
  if (!service) {
    return Response.json({ ok: false, message: "Unknown service." }, { status: 400 });
  }

  try {
    const options = await getPaymentOptions(service, {
      addressId: searchParams.get("addressId") || undefined,
      cartKey: searchParams.get("cartKey") || undefined,
    });
    return Response.json({ ok: true, options });
  } catch (err) {
    return paymentErrorResponse(err, "Couldn't load payment options");
  }
});
