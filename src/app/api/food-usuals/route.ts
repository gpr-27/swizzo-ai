// GET /api/food-usuals?addressId= — restaurants this user reorders from, read
// from Swiggy Food `get_food_orders` (newest first, across all addresses).
// Read-only. Used by the "Order the usual" chip on the Instamart board.
// Never mixes into the Instamart cart.
//
// get_food_orders carries only order history, so the cards show what Swiggy
// returned (name, area, and the restaurant cover photo from the REORDER
// action's `reorderMeta.restaurantCoverImageId`) — availability is "UNKNOWN"
// until the menu is opened; no rating / ETA is invented.

import { isAuthError } from "@/backend/config/env";
import { foodRestaurantFromOrder, getFoodOrders } from "@/backend/mcp/food-mcp";
import type { FoodRestaurant } from "@/shared/types";
import { route, unauthorized } from "@/backend/http/route";
import { AddressOnlyQuery } from "@/backend/http/schemas";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = route({ name: "api/food-usuals", rateLimit: "read", query: AddressOnlyQuery }, async function GET(request: Request): Promise<Response> {
  const addressId = (new URL(request.url).searchParams.get("addressId") ?? "").trim();
  if (!addressId) return Response.json({ restaurants: [] });

  try {
    const orders = await getFoodOrders(addressId, { orderCount: 15 });
    const seen = new Set<string>();
    const restaurants: FoodRestaurant[] = [];
    for (const raw of orders) {
      const r = foodRestaurantFromOrder(raw);
      if (!r || seen.has(r.id)) continue;
      seen.add(r.id);
      restaurants.push(r);
      if (restaurants.length >= 2) break;
    }
    return Response.json({ restaurants }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (err: unknown) {
    if (isAuthError(err)) return unauthorized();
    console.error("[api/food-usuals] failed:", err);
    return Response.json({ restaurants: [] });
  }
});
