// GET /api/dineout/details?restaurantId=&lat=&lng= → get_restaurant_details
// (photos, timings, address, amenities, deals, menu images, map link) for the
// "View details" sheet. Use the coordinates the restaurant was searched with.

import { dineoutErrorResponse, getDineoutRestaurantDetails } from "@/backend/mcp/dineout-mcp";
import { route } from "@/backend/http/route";
import { DineoutDetailsQuery } from "@/backend/http/schemas";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function coord(value: string | null): number | undefined {
  if (value === null || value.trim() === "") return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

export const GET = route({ name: "api/dineout/details", rateLimit: "read", query: DineoutDetailsQuery }, async function GET(request: Request): Promise<Response> {
  const { searchParams } = new URL(request.url);
  const restaurantId = (searchParams.get("restaurantId") || "").trim();
  const latitude = coord(searchParams.get("lat"));
  const longitude = coord(searchParams.get("lng"));
  if (!restaurantId) {
    return Response.json({ ok: false, message: "restaurantId is required." }, { status: 400 });
  }
  if (latitude === undefined || longitude === undefined) {
    return Response.json({ ok: false, message: "lat and lng are required." }, { status: 400 });
  }
  try {
    const restaurant = await getDineoutRestaurantDetails(restaurantId, latitude, longitude);
    return Response.json({ ok: true, restaurant });
  } catch (err) {
    console.error("[api/dineout/details] error:", err);
    return dineoutErrorResponse(err, { fallback: "Could not load this restaurant's details." });
  }
});
