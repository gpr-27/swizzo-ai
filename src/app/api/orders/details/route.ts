// GET /api/orders/details?service=food&orderId= → get_food_order_details.
// Read-only; powers the "Details" toggle on the order-history card.
// Instamart: the documented get_order_details is NOT exposed by the live
// Instamart server (tools/list, 2026-10-22), so we answer honestly instead of
// calling a tool that doesn't exist — the order-history row already shows the
// items Swiggy returned in get_orders.

import { isAuthError } from "@/backend/config/env";
import { getFoodOrderDetails } from "@/backend/mcp/food-mcp";
import { route } from "@/backend/http/route";
import { OrderDetailsQuery } from "@/backend/http/schemas";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = route({ name: "api/orders/details", rateLimit: "read", query: OrderDetailsQuery }, async function GET(request: Request): Promise<Response> {
  const params = new URL(request.url).searchParams;
  const orderId = (params.get("orderId") || "").trim();
  const service = params.get("service") || "food";
  if (!orderId || orderId.length > 64) {
    return Response.json({ ok: false, message: "orderId is required." }, { status: 400 });
  }
  if (service !== "food") {
    return Response.json(
      { ok: false, unavailable: true, message: "Swiggy doesn't offer Instamart order details through its MCP yet — see the Swiggy app." },
      { status: 200 },
    );
  }
  try {
    return Response.json({ ok: true, details: await getFoodOrderDetails(orderId) });
  } catch (err) {
    if (isAuthError(err)) {
      return Response.json({ ok: false, auth: true, message: "Your Swiggy session expired — please log in again." }, { status: 401 });
    }
    console.error("[api/orders/details] failed:", err);
    const reportId = (err as { reportId?: unknown })?.reportId;
    return Response.json(
      {
        ok: false,
        message: err instanceof Error && err.message ? err.message : "Couldn't load this order.",
        ...(typeof reportId === "string" ? { reportId } : {}),
      },
      { status: 502 },
    );
  }
});
