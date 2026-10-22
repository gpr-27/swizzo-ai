// GET /api/scenes/shows?eventId=&venueId=&lat=&lng= — a LIVE re-read of one
// venue's list_event_shows (read-only). The ticket picker polls this every
// ~45 s while it is open and visible, so seats-left / sold-out states stay
// current. A 10 s per-listing cache + in-flight de-dup keeps several open
// pickers (or a double tap on "Refresh") to one Swiggy call. `fresh=1` (the
// seat re-check right before create_event_cart) only reuses a read < 2 s old.

import { listScenesShows, scenesErrorResponse } from "@/backend/mcp/scenes-mcp";
import type { ScenesShowListing } from "@/shared/types";
import { route } from "@/backend/http/route";
import { ScenesShowsQuery } from "@/backend/http/schemas";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const TTL_MS = 10_000;
const cache = ((globalThis as unknown as { __scenesShowsCache?: Map<string, { at: number; value: Promise<ScenesShowListing> }> })
  .__scenesShowsCache ??= new Map());

export const GET = route({ name: "api/scenes/shows", rateLimit: "read", query: ScenesShowsQuery }, async function GET(request: Request): Promise<Response> {
  const { searchParams } = new URL(request.url);
  const eventId = searchParams.get("eventId")?.trim() ?? "";
  const venueId = searchParams.get("venueId")?.trim() ?? "";
  const latitude = Number(searchParams.get("lat"));
  const longitude = Number(searchParams.get("lng"));
  if (!/^\w{1,40}$/.test(eventId) || !/^\w{1,40}$/.test(venueId)) {
    return Response.json({ ok: false, message: "eventId and venueId are required." }, { status: 400 });
  }
  if (!searchParams.get("lat") || !searchParams.get("lng") || !Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    return Response.json({ ok: false, message: "Your location is needed to load show times." }, { status: 400 });
  }
  const key = [eventId, venueId, latitude.toFixed(3), longitude.toFixed(3)].join("|");
  const now = Date.now();
  for (const [k, v] of cache) if (now - v.at > 5 * 60_000) cache.delete(k);
  let hit = cache.get(key);
  const ttl = searchParams.get("fresh") === "1" ? 2_000 : TTL_MS;
  if (!hit || now - hit.at > ttl) {
    const value = listScenesShows(eventId, venueId, { latitude, longitude }, searchParams.get("title") || undefined);
    hit = { at: now, value };
    cache.set(key, hit);
    value.catch(() => {
      if (cache.get(key)?.value === value) cache.delete(key);
    });
  }
  try {
    const listing = await hit.value;
    return Response.json({ ok: true, listing, fetchedAt: hit.at });
  } catch (err) {
    return scenesErrorResponse(err, "api/scenes/shows");
  }
});
