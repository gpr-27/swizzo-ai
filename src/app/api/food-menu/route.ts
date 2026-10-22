// GET /api/food-menu?restaurantId=&addressId=[&page=][&restaurantName=] —
// deterministic restaurant menu via Swiggy Food `get_restaurant_menu` (browse
// view, paginated over categories). Read-only. Powers "View menu" on a
// restaurant card and the menu's "More" button without a model round-trip.
// Returns { restaurantId, restaurantName, isOpen, categories, page, hasMore }.

import { isAuthError } from '@/backend/config/env';
import { getRestaurantMenu } from '@/backend/mcp/food-mcp';
import { route, unauthorized } from "@/backend/http/route";
import { FoodMenuQuery } from "@/backend/http/schemas";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PRIVATE = { "Cache-Control": "private, no-store" };

export const GET = route({ name: "api/food-menu", rateLimit: "read", query: FoodMenuQuery }, async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const restaurantId = (url.searchParams.get("restaurantId") ?? "").trim();
  const addressId = (url.searchParams.get("addressId") ?? "").trim();
  const restaurantName = (url.searchParams.get("restaurantName") ?? "").trim();
  const page = Math.max(1, Math.floor(Number(url.searchParams.get("page")) || 1));

  if (!restaurantId) {
    return Response.json({ error: "Missing restaurantId." }, { status: 400, headers: PRIVATE });
  }
  if (!addressId) {
    return Response.json({ error: "Pick a delivery address first." }, { status: 400, headers: PRIVATE });
  }

  try {
    const menu = await getRestaurantMenu(addressId, restaurantId, { page, restaurantName });
    return Response.json(menu, { headers: PRIVATE });
  } catch (err) {
    if (isAuthError(err)) return unauthorized();
    console.error("[api/food-menu] failed:", err);
    return Response.json(
      { error: err instanceof Error ? err.message : "Swiggy couldn't load this menu." },
      { status: 502, headers: PRIVATE },
    );
  }
});
