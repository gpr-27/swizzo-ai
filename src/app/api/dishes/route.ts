// GET /api/dishes?q=&addressId=[&offset=] — deterministic CROSS-RESTAURANT dish
// search via Swiggy Food `search_menu` (each dish carries its restaurant and its
// full variant / add-on options). Read-only.
//
// GET /api/dishes?q=<dish name>&restaurantId=<id>&addressId= — the same search
// scoped to one restaurant (search_menu `restaurantIdOfAddedItem`): used to load
// a dish's customization options before adding it to the cart.
//
// Besides the MenuItem cards we return a `catalog` block of FoodCartLine-style
// metadata keyed by menuItemId, so cross-restaurant Food `ADD:` markers on a
// later chat turn resolve to exact item metadata (no hallucinated price).

import { isAuthError } from '@/backend/config/env';
import { searchDishes, searchMenu } from '@/backend/mcp/food-mcp';
import type { FoodCartLine, MenuItem } from '@/shared/types';
import { route, unauthorized } from "@/backend/http/route";
import { DishesQuery } from "@/backend/http/schemas";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// One catalog entry == everything the food cart needs to add a cross-restaurant
// dish deterministically (matches ChatCatalog["dishes"][number]).
interface DishCatalogEntry {
  restaurantId: string;
  restaurantName: string;
  line: Omit<FoodCartLine, "quantity">;
}

/** Build the FoodCartLine-style catalog entry for a dish (id IS the menuItemId). */
function toCatalogEntry(d: MenuItem): DishCatalogEntry {
  return {
    restaurantId: d.restaurantId,
    restaurantName: d.restaurantName,
    line: {
      menuItemId: d.id,
      name: d.name,
      imageUrl: d.imageUrl,
      veg: d.veg,
      price: d.price,
    },
  };
}

// Results depend on the user's session + address: never cache in shared caches.
const PRIVATE = { "Cache-Control": "private, no-store" };

export const GET = route({ name: "api/dishes", rateLimit: "read", query: DishesQuery }, async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const q = (url.searchParams.get("q") ?? "").trim();
  const addressId = (url.searchParams.get("addressId") ?? "").trim();
  const restaurantId = (url.searchParams.get("restaurantId") ?? "").trim();
  const offset = Math.max(0, Number(url.searchParams.get("offset")) || 0);

  if (!q) return Response.json({ query: q, dishes: [], catalog: [] }, { headers: PRIVATE });
  if (!addressId) {
    return Response.json(
      { query: q, dishes: [], catalog: [], error: "Pick a delivery address first." },
      { status: 400, headers: PRIVATE },
    );
  }

  try {
    const result = restaurantId
      ? await searchMenu(addressId, q, { restaurantId })
      : await searchDishes(q, addressId, offset);
    return Response.json(
      {
        query: q,
        dishes: result.dishes,
        catalog: result.dishes.map(toCatalogEntry),
        hasMore: result.hasMore,
        nextOffset: result.nextOffset,
        ...(result.totalItems ? { totalItems: result.totalItems } : {}),
      },
      { headers: PRIVATE },
    );
  } catch (err) {
    if (isAuthError(err)) return unauthorized();
    console.error("[api/dishes] search failed:", err);
    return Response.json(
      {
        query: q,
        dishes: [],
        catalog: [],
        error: err instanceof Error ? err.message : "Swiggy dish search failed.",
      },
      { status: 502, headers: PRIVATE },
    );
  }
});
