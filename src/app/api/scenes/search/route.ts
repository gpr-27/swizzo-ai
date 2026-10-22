// GET /api/scenes/search — read-only Scenes discovery (real Swiggy data only).
//   ?eventId=…            → get_event_details → list_event_shows{eventId, venueId} (bookable listing)
//   ?collectionId=…       → get_events_collection (a genre chip from discover_events)
//   ?query=…              → search_events, the user's city first, top results enriched with details
//   (none) [&genre=…]     → browse: discover_events, falling back (it is empty live) to a
//                           keyword search in the user's city, enriched with get_event_details
// lat & lng (the user's coordinates) are required — Scenes needs a location.
// Optional `address` (the selected address line) pins the user's city; otherwise
// the nearest city to lat/lng is used.

import {
  browseScenesEvents,
  genreOf,
  getBookableShows,
  getScenesCollection,
  resolveUserCity,
  scenesErrorResponse,
  searchScenesNearby,
} from "@/backend/mcp/scenes-mcp";
import { route } from "@/backend/http/route";
import { ScenesSearchQuery } from "@/backend/http/schemas";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = route({ name: "api/scenes/search", rateLimit: "read", query: ScenesSearchQuery }, async function GET(request: Request): Promise<Response> {
  const { searchParams } = new URL(request.url);
  const latitude = Number(searchParams.get("lat"));
  const longitude = Number(searchParams.get("lng"));
  if (!searchParams.get("lat") || !searchParams.get("lng") || !Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    return Response.json({ ok: false, message: "Your location is needed to find events." }, { status: 400 });
  }
  const coords = { latitude, longitude };
  const eventId = searchParams.get("eventId")?.trim();
  const collectionId = searchParams.get("collectionId")?.trim();
  const query = searchParams.get("query")?.trim().slice(0, 80);
  const genre = searchParams.get("genre")?.trim();
  const city = resolveUserCity(coords, searchParams.get("address")?.slice(0, 300) ?? undefined);

  try {
    if (eventId) {
      return Response.json({ ok: true, listing: await getBookableShows(eventId, coords) });
    }
    if (collectionId) {
      return Response.json({ ok: true, events: await getScenesCollection(collectionId, coords) });
    }
    if (query) {
      const res = await searchScenesNearby(query, coords, { city });
      return Response.json({ ok: true, ...res });
    }
    const res = await browseScenesEvents(coords, { city, genre: genre ? genreOf(genre) : "all" });
    return Response.json({ ok: true, ...res });
  } catch (err) {
    return scenesErrorResponse(err, "api/scenes/search");
  }
});
