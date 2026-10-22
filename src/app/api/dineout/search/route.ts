// GET /api/dineout/search
//   ?query=&lat=&lng=[&limit=&offset=]   → search_restaurants_dineout (text) →
//                                          render_restaurants_dineout (photo cards)
//   ?restaurantId=&date=YYYY-MM-DD&lat=&lng=[&restaurantName=]
//                                        → get_available_slots (7 days from `date`,
//                                          read from the raw result's `_meta.slots`)
// Coordinates are required: Dineout searches the city/area the user named and
// has no saved-address lookup. A Swiggy 429 replies 429 { busy:true, message }
// ("Dineout is busy…") — never an empty result.

import {
  dineoutErrorResponse,
  getDineoutSlots,
  searchDineoutRestaurants,
} from "@/backend/mcp/dineout-mcp";
import { route } from "@/backend/http/route";
import { DineoutSearchQuery } from "@/backend/http/schemas";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function coord(value: string | null): number | undefined {
  if (value === null || value.trim() === "") return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

export const GET = route({ name: "api/dineout/search", rateLimit: "read", query: DineoutSearchQuery }, async function GET(request: Request): Promise<Response> {
  const { searchParams } = new URL(request.url);
  const query = (searchParams.get("query") || "").trim();
  const latitude = coord(searchParams.get("lat"));
  const longitude = coord(searchParams.get("lng"));
  const restaurantId = searchParams.get("restaurantId");
  const date = searchParams.get("date");

  if (latitude === undefined || longitude === undefined) {
    return Response.json({ ok: false, message: "lat and lng are required." }, { status: 400 });
  }

  try {
    if (restaurantId) {
      if (!date || !/^\d{4}-\d{2}-\d{2}$|^\d+$/.test(date)) {
        return Response.json({ ok: false, message: "date must be YYYY-MM-DD." }, { status: 400 });
      }
      const view = await getDineoutSlots(restaurantId, date, latitude, longitude, {
        restaurantName: searchParams.get("restaurantName") || undefined,
      });
      return Response.json({ ok: true, ...view });
    }

    if (!query) {
      return Response.json({ ok: false, message: "query is required." }, { status: 400 });
    }
    const limit = coord(searchParams.get("limit"));
    const offset = coord(searchParams.get("offset"));
    const result = await searchDineoutRestaurants({ query, latitude, longitude, limit, offset });
    return Response.json({ ok: true, ...result });
  } catch (err) {
    console.error("[api/dineout/search] error:", err);
    return dineoutErrorResponse(err, { fallback: "Dineout search failed." });
  }
});
