// GET /api/orders — deterministic latest-order tracker for Instamart. Read-only
// (never places an order); bypasses the agent so the tracking card is reliable.
// get_orders (active first) → get_delivery_status for a live ETA.

import { isAuthError } from '@/backend/config/env';
import { getInstamartTracking } from '@/backend/mcp/swiggy-mcp';
import { route, unauthorized } from "@/backend/http/route";
import { AddressOnlyQuery } from "@/backend/http/schemas";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = route({ name: "api/orders", rateLimit: "read", query: AddressOnlyQuery }, async function GET(request: Request): Promise<Response> {
  const addressId = new URL(request.url).searchParams.get("addressId") || undefined;
  try {
    return Response.json(await getInstamartTracking({ addressId }));
  } catch (err) {
    if (isAuthError(err)) return unauthorized();
    console.error("[api/orders] failed:", err);
    return Response.json(
      {
        tracker: null,
        summary: `Couldn't fetch your Instamart orders: ${err instanceof Error ? err.message : "Swiggy error"}`,
      },
      { status: 502 },
    );
  }
});
