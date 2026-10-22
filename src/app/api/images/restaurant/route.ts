// GET /api/images/restaurant — the OFFICIAL Swiggy photo for a restaurant card
// that arrived without one (read-only; nothing is ever invented).
//   ?kind=dineout&id=&lat=&lng=   → get_restaurant_details → restaurant.imageUrl,
//                                   else mastheadImageUrls[0] (+ the masthead list)
//   ?kind=food&id=&addressId=     → get_restaurant_menu (pageSize 1) →
//                                   restaurant.imageUrl, else the first dish photo
//                                   of that restaurant's own menu (source "dish")
// Returns { ok, imageUrl | null, images?, source }. Results are cached for 6 h
// per restaurant (a miss for 15 min), process-wide — photos are not
// user-specific. Dineout is rate-limited: its existing 429 cool-down / 5-min
// details cache applies, and a busy Dineout replies 429 { busy, retryAfterSec }.

import { isAuthError } from "@/backend/config/env";
import { MCP_SERVERS } from "@/backend/agent/services";
import { callTool, coerceToolPayload, isRecord } from "@/backend/mcp/client";
import { DineoutBusyError, getDineoutRestaurantDetails, isRateLimited } from "@/backend/mcp/dineout-mcp";
import { IMG_CARD, swiggyImageUrl } from "@/backend/mcp/image";
import { route } from "@/backend/http/route";
import { ImagesQuery } from "@/backend/http/schemas";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface ImageResult {
  imageUrl: string | null;
  images?: string[];
  source: "restaurant" | "masthead" | "dish" | "none";
}

const HIT_TTL_MS = 6 * 60 * 60_000;
const MISS_TTL_MS = 15 * 60_000;
const MAX_ENTRIES = 2000;
type Entry = { at: number; value: Promise<ImageResult>; resolved?: ImageResult };
const cache = ((globalThis as unknown as { __restaurantImageCache?: Map<string, Entry> }).__restaurantImageCache ??=
  new Map());

/** Cached + in-flight de-duplicated; failures are never cached, a miss expires sooner. */
function cachedImage(key: string, fn: () => Promise<ImageResult>): Promise<ImageResult> {
  const now = Date.now();
  const hit = cache.get(key);
  const ttl = hit?.resolved && !hit.resolved.imageUrl ? MISS_TTL_MS : HIT_TTL_MS;
  if (hit && now - hit.at < ttl) return hit.value;
  if (cache.size > MAX_ENTRIES) cache.delete(cache.keys().next().value as string);
  const entry: Entry = { at: now, value: fn() };
  cache.set(key, entry);
  entry.value.then(
    (v) => {
      entry.resolved = v;
    },
    () => {
      if (cache.get(key) === entry) cache.delete(key);
    },
  );
  return entry.value;
}

async function dineoutImage(id: string, lat: number, lng: number): Promise<ImageResult> {
  const r = await getDineoutRestaurantDetails(id, lat, lng);
  const images = (r.mastheadImageUrls ?? []).filter(Boolean);
  if (r.imageUrl) return { imageUrl: r.imageUrl, images: images.length ? images : undefined, source: "restaurant" };
  if (images[0]) return { imageUrl: images[0], images, source: "masthead" };
  return { imageUrl: null, source: "none" };
}

async function foodImage(id: string, addressId: string): Promise<ImageResult> {
  // get_restaurant_menu requires the user's addressId live (lat/lng is rejected).
  const payload = coerceToolPayload(
    await callTool(MCP_SERVERS.food.url, "get_restaurant_menu", { restaurantId: id, addressId, pageSize: 1 }),
  );
  const body = isRecord(payload) && !isRecord(payload.restaurant) && isRecord(payload.data) ? payload.data : payload;
  const restaurant = isRecord(body) && isRecord(body.restaurant) ? body.restaurant : {};
  for (const v of [restaurant.imageUrl, restaurant.cloudinaryImageId, restaurant.imageId]) {
    const url = swiggyImageUrl(v, IMG_CARD);
    if (url) return { imageUrl: url, source: "restaurant" };
  }
  // No cover photo: the first dish photo from this restaurant's own menu.
  const categories = isRecord(body) && Array.isArray(body.categories) ? body.categories : [];
  for (const c of categories) {
    if (!isRecord(c)) continue;
    const lists = [c.items, ...(Array.isArray(c.subcategories) ? c.subcategories.map((sc) => (isRecord(sc) ? sc.items : [])) : [])];
    for (const list of lists) {
      for (const it of Array.isArray(list) ? list : []) {
        const url = isRecord(it) ? swiggyImageUrl(it.imageUrl ?? it.imageId, IMG_CARD) : "";
        if (url) return { imageUrl: url, source: "dish" };
      }
    }
  }
  return { imageUrl: null, source: "none" };
}

export const GET = route({ name: "api/images/restaurant", rateLimit: "read", query: ImagesQuery }, async function GET(request: Request): Promise<Response> {
  const { searchParams } = new URL(request.url);
  const kind = searchParams.get("kind");
  const id = (searchParams.get("id") || "").trim();
  if (!/^[\w-]{1,40}$/.test(id) || (kind !== "dineout" && kind !== "food")) {
    return Response.json({ ok: false, message: "kind (dineout|food) and id are required." }, { status: 400 });
  }
  try {
    let result: ImageResult;
    if (kind === "dineout") {
      const lat = Number(searchParams.get("lat"));
      const lng = Number(searchParams.get("lng"));
      if (!searchParams.get("lat") || !searchParams.get("lng") || !Number.isFinite(lat) || !Number.isFinite(lng)) {
        return Response.json({ ok: false, message: "lat and lng are required for Dineout." }, { status: 400 });
      }
      result = await cachedImage(`dineout|${id}`, () => dineoutImage(id, lat, lng));
    } else {
      const addressId = (searchParams.get("addressId") || "").trim();
      if (!addressId || addressId.length > 120) {
        return Response.json({ ok: false, message: "addressId is required for Food." }, { status: 400 });
      }
      result = await cachedImage(`food|${id}`, () => foodImage(id, addressId));
    }
    return Response.json(
      { ok: true, ...result },
      { headers: { "Cache-Control": result.imageUrl ? "private, max-age=21600" : "private, max-age=900" } },
    );
  } catch (err) {
    if (isAuthError(err)) return Response.json({ ok: false, authRequired: true }, { status: 401 });
    if (err instanceof DineoutBusyError || isRateLimited(err)) {
      return Response.json({ ok: false, busy: true, retryAfterSec: 60 }, { status: 429 });
    }
    console.warn(`[api/images/restaurant] ${kind} ${id}: ${err instanceof Error ? err.message : String(err)}`);
    return Response.json({ ok: false, message: "Swiggy returned no photo for this restaurant." }, { status: 502 });
  }
});
