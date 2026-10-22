// Swiggy Dineout MCP client over streamable HTTP.
// Contract: docs/swiggy-mcp/dineout.md, CORRECTED by the live responses in
// docs/swiggy-mcp/LIVE-SAMPLES.md (search is text-only; cards come from
// render_restaurants_dineout; slots live in the raw result's `_meta.slots`).
// Tools: search_restaurants_dineout, render_restaurants_dineout,
// get_restaurant_details, get_available_slots, create_cart, book_table,
// get_booking_status, cancel_booking (+ the shared payment tools, handled in
// payment-mcp.ts).
//
// Every function here returns only what Swiggy returned. Failures throw
// (AuthError / SwiggyToolError from client.ts, or the transport error) so the
// caller can show Swiggy's own message — nothing is mocked or defaulted.

import { isAuthError, SWIGGY_DINEOUT_MCP_URL } from "@/backend/config/env";
import { callTool, coerceToolPayload, hasTool, isRecord, str } from "@/backend/mcp/client";
import { swiggyImageUrl } from "@/backend/mcp/image";
import type {
  DineoutBooking,
  DineoutCart,
  DineoutDeal,
  DineoutOffer,
  DineoutRestaurant,
  DineoutSlot,
  DineoutSlotsView,
  PaymentSession,
} from "@/shared/types";
import { BoundedMap } from "@/backend/resilience/lru";

const DINEOUT_URL = SWIGGY_DINEOUT_MCP_URL;

const TOOL = {
  search: "search_restaurants_dineout",
  render: "render_restaurants_dineout",
  details: "get_restaurant_details",
  slots: "get_available_slots",
  createCart: "create_cart",
  bookTable: "book_table",
  bookingStatus: "get_booking_status",
  cancelBooking: "cancel_booking",
} as const;

/** Server gate for mutating calls (create_cart / book_table / cancel_booking). */
export function dineoutOrdersEnabled(): boolean {
  return process.env.SWIGGY_ENABLE_ORDERS === "true";
}

export const ORDERS_DISABLED_MESSAGE = "Ordering is disabled on this server";

/**
 * Map a thrown error to an API response for the Dineout routes:
 * - auth → 401 "log in again";
 * - Swiggy domain failure (`success:false`) → 200 with Swiggy's own message;
 * - anything else on a mutating call is AMBIGUOUS (the request may have reached
 *   Swiggy) — say so instead of guessing, since book_table has no idempotency key.
 */
export function dineoutErrorResponse(err: unknown, opts: { mutating?: boolean; fallback: string }): Response {
  const message = err instanceof Error && err.message ? err.message : opts.fallback;
  if (isAuthError(err)) {
    return Response.json({ ok: false, auth: true, message: "Your Swiggy session expired — please log in again." }, { status: 401 });
  }
  if (!opts.mutating && isRateLimited(err)) {
    return Response.json({ ok: false, busy: true, message: DINEOUT_BUSY_MESSAGE }, { status: 429 });
  }
  if ((err as { name?: string })?.name === "SwiggyToolError") {
    return Response.json({
      ok: false,
      message,
      reportId: (err as { reportId?: string }).reportId,
    });
  }
  if (opts.mutating) {
    return Response.json(
      {
        ok: false,
        ambiguous: true,
        message:
          "We couldn't confirm whether Swiggy received this request. Please check your bookings in the Swiggy app before trying again.",
      },
      { status: 502 },
    );
  }
  return Response.json({ ok: false, message }, { status: 502 });
}

/* --------------------------------- helpers --------------------------------- */

/** A finite number from a number or numeric string; otherwise undefined. */
function optNum(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

function optStr(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function idString(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return "";
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string" && !!v.trim()) : [];
}

function titles(value: unknown, ...keys: string[]): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((o) => (isRecord(o) ? keys.map((k) => str(o[k])).find(Boolean) ?? "" : typeof o === "string" ? o : ""))
    .filter((t) => t.trim());
}

/**
 * Offers / deals with every field Swiggy sends: render `offers[]`
 * ({offerTitle, offerDescription}) and details `deals[]` / `offers[]`
 * ({title, description, discountPercentage, coverCharge, slotGroupName, offerCategory}).
 */
function offerList(value: unknown): DineoutOffer[] {
  if (!Array.isArray(value)) return [];
  const out: DineoutOffer[] = [];
  for (const o of value) {
    if (!isRecord(o)) continue;
    const title = str(o.title) || str(o.offerTitle) || str(o.dealTitle);
    if (!title.trim()) continue;
    out.push({
      title,
      description: optStr(o.description) ?? optStr(o.offerDescription),
      discountPercentage: optNum(o.discountPercentage),
      coverCharge: optNum(o.coverCharge),
      slotGroupName: optStr(o.slotGroupName),
      offerCategory: optStr(o.offerCategory),
    });
  }
  return out;
}

/**
 * Does Swiggy take TABLE BOOKINGS here? Live: listing-only restaurants (KFC,
 * HFC, …) come back with partnerType "NPR", no highlights and no slots; bookable
 * ones carry partnerType "PR", a "Table booking" vendor highlight and/or the
 * "Reservation available" highlight. Unknown (no signal at all) → undefined.
 */
export function dineoutBookable(partnerType: unknown, signals: string[]): boolean | undefined {
  const p = str(partnerType).trim().toUpperCase();
  if (p === "NPR") return false;
  if (p === "PR") return true;
  if (signals.some((t) => /^\s*(table booking|reservation available)\s*$/i.test(t))) return true;
  return undefined;
}

/**
 * Keep Swiggy's order but move restaurants that take no table bookings after the
 * bookable ones — unless the user searched that restaurant by name, which stays first.
 */
export function orderBookableFirst(list: DineoutRestaurant[], query = ""): DineoutRestaurant[] {
  const q = query.trim().toLowerCase();
  const named = (r: DineoutRestaurant) => {
    const n = r.name.trim().toLowerCase();
    return !!q && q.length >= 3 && (n.includes(q) || q.includes(n));
  };
  const rank = (r: DineoutRestaurant) => (named(r) ? 0 : r.bookable === false ? 2 : 1);
  return list
    .map((r, i) => ({ r, i }))
    .sort((a, b) => rank(a.r) - rank(b.r) || a.i - b.i)
    .map((x) => x.r);
}

/** Same offer (title + description) — details repeats restaurant.deals[] as offers[]. */
const offerKey = (o: DineoutOffer) => `${o.title}|${o.description ?? ""}`;

/* ------------------------------ rate limiting ------------------------------ */

/** Shown when Swiggy rate-limits Dineout (HTTP 429) — never as "no results". */
export const DINEOUT_BUSY_MESSAGE = "Dineout is busy right now — please try again in a minute.";

/** Swiggy throttles dineout search hard (~7 searches → 429): back off for this long. */
const BUSY_COOLDOWN_MS = 60_000;
const g = globalThis as unknown as { __dineoutBusyUntil?: number };

export class DineoutBusyError extends Error {
  readonly status = 429;
  constructor() {
    super(DINEOUT_BUSY_MESSAGE);
    this.name = "DineoutBusyError";
  }
}

export function isRateLimited(err: unknown): boolean {
  if (err instanceof DineoutBusyError) return true;
  const code = (err as { code?: unknown })?.code;
  if (code === 429) return true;
  const msg = err instanceof Error ? err.message : String(err ?? "");
  return /\b429\b|rate[- ]?limit|too many requests/i.test(msg);
}

function assertNotBusy(): void {
  if ((g.__dineoutBusyUntil ?? 0) > Date.now()) throw new DineoutBusyError();
}

/** Run a Dineout read; a 429 starts the cool-down and becomes DineoutBusyError. */
async function guarded<T>(fn: () => Promise<T>): Promise<T> {
  assertNotBusy();
  try {
    return await fn();
  } catch (err) {
    if (isRateLimited(err)) {
      g.__dineoutBusyUntil = Date.now() + BUSY_COOLDOWN_MS;
      throw new DineoutBusyError();
    }
    throw err;
  }
}

/**
 * Short-lived cache + in-flight de-duplication for read calls, so a provider
 * fallback, a double tap or a re-render never fires the same Swiggy request
 * twice (search is rate-limited). Keyed by the exact request.
 */
const cache = ((globalThis as unknown as { __dineoutCacheV2?: BoundedMap<string, { at: number; value: Promise<unknown> }> })
  .__dineoutCacheV2 ??= new BoundedMap({ max: 1_000 }));

function cached<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
  const now = Date.now();
  for (const [k, v] of cache) if (now - v.at > 10 * 60_000) cache.delete(k);
  const hit = cache.get(key);
  if (hit && now - hit.at < ttlMs) return hit.value as Promise<T>;
  const value = fn();
  cache.set(key, { at: now, value });
  // Never cache failures.
  value.catch(() => {
    if (cache.get(key)?.value === value) cache.delete(key);
  });
  return value;
}

/* ------------------------------- normalizers ------------------------------- */

// Photo widths for the CDN resize transform (16:9 card / details hero strip).
const IMG_CARD_W = 640;
const IMG_HERO_W = 1000;

/** The first text block of a raw tool result. */
function resultText(raw: unknown): string {
  if (!isRecord(raw) || !Array.isArray(raw.content)) return "";
  return raw.content
    .filter((b): b is { type: string; text: string } => isRecord(b) && b.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("\n");
}

export interface DineoutSearchResult {
  restaurants: DineoutRestaurant[];
  latitude?: number;
  longitude?: number;
  total?: number; // "Found N restaurant(s)"
  nextOffset?: number; // "call again with offset=X" — absent when nothing more matched
  /** render's note when some requested ids could not be resolved ("1 of 3 requested id … skipped"). */
  renderNote?: string;
  /** "text" when the photo cards could not be rendered and came from the search text. */
  source?: "render" | "text";
}

// `4. Si Nonna's Original Sourdough Pizza — Italian, Pizza | 4.8★ | ₹1000 for two | Koramangala (ID: 1032642)`
const SEARCH_LINE =
  /^\s*\d+\.\s+(.+?)\s+—\s+(.*?)\s*\|\s*([\d.]+|--|-)\s*★\s*\|\s*(.*?)\s*\|\s*(.*?)\s*\(ID:\s*(\d+)\)\s*$/;

/**
 * search_restaurants_dineout replies in TEXT only (structuredContent is `{}`):
 * a "Found N … showing M. K more available, call again with offset=X." header,
 * one numbered line per restaurant, then "Search coordinates: latitude=…, longitude=…".
 */
export function parseDineoutSearchText(text: string): DineoutSearchResult {
  const restaurants: DineoutRestaurant[] = [];
  const coords = /latitude=(-?[\d.]+),\s*longitude=(-?[\d.]+)/.exec(text);
  const latitude = coords ? optNum(coords[1]) : undefined;
  const longitude = coords ? optNum(coords[2]) : undefined;
  for (const line of text.split("\n")) {
    const m = SEARCH_LINE.exec(line);
    if (!m) continue;
    const [, name, cuisines, rating, cost, area, id] = m;
    const r = optNum(rating);
    restaurants.push({
      id,
      name: name.trim(),
      cuisines: cuisines.split(",").map((c) => c.trim()).filter(Boolean),
      rating: r && r > 0 ? r : undefined,
      costForTwo: optStr(cost.trim()),
      area: optStr(area.trim()),
      latitude,
      longitude,
    });
  }
  const found = /Found\s+(\d+)\s+restaurant/i.exec(text);
  const next = /offset=(\d+)/.exec(text);
  return {
    restaurants,
    latitude,
    longitude,
    total: found ? optNum(found[1]) : undefined,
    nextOffset: next ? optNum(next[1]) : undefined,
    source: "text",
  };
}

/** One render_restaurants_dineout `restaurants[]` card (also the documented search shape). */
function normalizeRenderRestaurant(raw: unknown, latitude?: number, longitude?: number): DineoutRestaurant | null {
  if (!isRecord(raw)) return null;
  const id = idString(raw.id);
  const name = str(raw.name);
  if (!id || !name) return null;
  const rating = isRecord(raw.rating) ? raw.rating : undefined;
  const value = rating ? optNum(rating.value) : undefined; // "--" → undefined
  const count = rating ? optNum(rating.count) : undefined;
  const head = isRecord(raw.offerHeadline) ? raw.offerHeadline : undefined;
  const headTitle = head ? str(head.title) : "";
  const highlights = strings(raw.highlights);
  const bookable = dineoutBookable(raw.partnerType, [...highlights, ...titles(raw.vendorHighlights, "text")]);
  // vendorHighlights are the restaurant's own perks ("Free Beer"); "Table booking"
  // is on every Dineout card and says nothing, so it is dropped.
  const vendor = [...new Set(titles(raw.vendorHighlights, "text"))].filter(
    (v) => !/^table booking$/i.test(v.trim()) && !highlights.includes(v),
  );
  const offerDetails = offerList(raw.offers);
  const dealDetails = offerList(raw.availableDeals);
  return {
    id,
    name,
    cuisines: strings(raw.cuisine ?? raw.cuisines),
    rating: value && value > 0 ? value : undefined,
    ratingCount: value && count && count > 0 ? count : undefined,
    costForTwo: optStr(raw.costForTwo),
    area: optStr(raw.area),
    locality: optStr(raw.locality),
    distance: optStr(raw.distance),
    offers: titles(raw.offers, "offerTitle", "title"),
    offerDetails: offerDetails.length ? offerDetails : undefined,
    offerHeadline: headTitle
      ? {
          title: headTitle,
          subtitle: optStr(head?.subtitle),
          subtext: optStr(head?.subtext),
          kind: optStr(head?.kind),
          logoUrl: optStr(head?.logoUrl), // dineout-media CDN, used as-is
          logoText: optStr(head?.logoText),
        }
      : undefined,
    bankOffers: (() => {
      const b = [...new Set(titles(raw.bankOffers, "offerTitle", "title"))];
      return b.length ? b : undefined;
    })(),
    highlights: [...new Set(highlights)],
    vendorHighlights: vendor.length ? vendor : undefined,
    // availableDeals is [] in every live sample; its shape is tolerated either way.
    deals: titles(raw.availableDeals, "dealTitle", "title"),
    dealDetails: dealDetails.length ? dealDetails : undefined,
    partnerType: optStr(raw.partnerType),
    source: optStr(raw.source),
    bookable,
    imageUrl: optStr(swiggyImageUrl(raw.imageUrl, IMG_CARD_W)),
    latitude,
    longitude,
  };
}

/** render_restaurants_dineout structuredContent → cards in the requested order. */
export function mapDineoutRender(payload: unknown): DineoutSearchResult {
  const data = isRecord(payload) ? payload : {};
  const latitude = optNum(data.latitude);
  const longitude = optNum(data.longitude);
  const list = Array.isArray(data.restaurants) ? data.restaurants : [];
  // "Showing 2 restaurants. (1 of 3 requested id could not be resolved and were skipped)"
  const note = /\(([^)]*could not be resolved[^)]*)\)/i.exec(str(data.message));
  return {
    restaurants: list
      .map((r) => normalizeRenderRestaurant(r, latitude, longitude))
      .filter((r): r is DineoutRestaurant => r !== null),
    latitude,
    longitude,
    renderNote: note ? note[1] : undefined,
    source: "render",
  };
}

/**
 * Search-order text cards + rendered photo cards → photo cards in Swiggy's
 * order (search coordinates kept); a card the render dropped keeps its text line.
 */
export function mergeRenderedCards(textCards: DineoutRestaurant[], rendered: DineoutSearchResult): DineoutRestaurant[] {
  const byId = new Map(rendered.restaurants.map((r) => [r.id, r]));
  return textCards.map((t) => {
    const r = byId.get(t.id);
    return r ? { ...r, latitude: t.latitude, longitude: t.longitude } : t;
  });
}

/**
 * Any search-ish payload → cards: an already-built DineoutSearchResult (what
 * fetchDineoutToolPayload hands the agent), the coerced `{ text }` of a raw
 * search, or render-shaped JSON.
 */
export function mapDineoutSearch(payload: unknown): DineoutSearchResult {
  const data = isRecord(payload) ? payload : {};
  if (data.source === "render" || data.source === "text") return data as unknown as DineoutSearchResult;
  if (typeof data.text === "string" && !Array.isArray(data.restaurants)) return parseDineoutSearchText(data.text);
  return mapDineoutRender(data);
}

/** "1.3 km • Plot No. 64, …" → { distance: "1.3 km", address: "Plot No. 64, …" }. */
function splitAddress(raw: unknown): { distance?: string; address?: string } {
  const s = optStr(raw);
  if (!s) return {};
  const m = /^\s*([\d.]+\s*k?m)\s*•\s*(.+)$/i.exec(s);
  return m ? { distance: m[1], address: m[2].trim() } : { address: s.trim() };
}

/**
 * get_restaurant_details structuredContent → one fully-detailed card. Live shape
 * (no `data` wrapper): `{ restaurantId, restaurant:{…, avgRating, mastheadImageUrls,
 * timings, deals}, offers, menuImages, menuImageGroups, amenities, locationMapUrl,
 * latitude, longitude }`. The documented `{ data: {…} }` wrapper is tolerated too.
 */
export function mapDineoutDetails(payload: unknown, latitude?: number, longitude?: number): DineoutRestaurant | null {
  let body: Record<string, unknown> = isRecord(payload) ? payload : {};
  if (!isRecord(body.restaurant) && isRecord(body.data)) body = body.data;
  const r = isRecord(body.restaurant) ? body.restaurant : null;
  if (!r) return null;
  // Already normalized (fetchDineoutToolPayload hands the agent `{ restaurant }`).
  if (r.hasDetails === true && Array.isArray(r.cuisines)) return r as unknown as DineoutRestaurant;
  const id = idString(r.id) || idString(r.restaurantId) || idString(body.restaurantId);
  const name = str(r.name);
  if (!id || !name) return null;
  const dealText = (d: DineoutOffer) => [d.title, d.description].filter(Boolean).join(" — ");
  const dealDetails = offerList(r.deals);
  const dealKeys = new Set(dealDetails.map(offerKey));
  // body.offers repeats restaurant.deals in every live sample — keep only extras.
  const offerDetails = offerList(body.offers).filter((o) => !dealKeys.has(offerKey(o)));
  const deals = dealDetails.map(dealText);
  const offers = offerDetails.map(dealText);
  const masthead = strings(r.mastheadImageUrls).map((u) => swiggyImageUrl(u, IMG_HERO_W));
  const groups = (Array.isArray(body.menuImageGroups) ? body.menuImageGroups : [])
    .filter(isRecord)
    .map((grp) => ({
      title: str(grp.title) || "Menu",
      images: (Array.isArray(grp.images) ? grp.images : [])
        .filter(isRecord)
        .map((im) => ({ imageUrl: str(im.imageUrl), label: optStr(im.label) }))
        .filter((im) => im.imageUrl),
    }))
    .filter((grp) => grp.images.length);
  // No groups but a flat menuImages list → one "Menu" group.
  if (!groups.length && Array.isArray(body.menuImages)) {
    const images = body.menuImages
      .filter(isRecord)
      .map((im) => ({ imageUrl: str(im.imageUrl), label: optStr(im.label) }))
      .filter((im) => im.imageUrl);
    if (images.length) groups.push({ title: "Menu", images });
  }
  const { distance, address } = splitAddress(r.address);
  const rating = optNum(r.avgRating);
  return {
    id,
    name,
    cuisines: strings(r.cuisines),
    rating: rating && rating > 0 ? rating : undefined,
    costForTwo: optStr(r.costForTwo),
    area: optStr(r.area),
    locality: optStr(r.locality),
    address,
    distance: optStr(r.distance) ?? distance,
    timings: optStr(r.timings),
    deals,
    dealDetails: dealDetails.length ? dealDetails : undefined,
    offers,
    offerDetails: offerDetails.length ? offerDetails : undefined,
    partnerType: optStr(r.partnerType),
    bookable: dineoutBookable(r.partnerType, strings(body.amenities)),
    amenities: strings(body.amenities),
    imageUrl: optStr(swiggyImageUrl(r.imageUrl, IMG_CARD_W)) ?? masthead[0],
    mastheadImageUrls: masthead.length ? masthead : undefined,
    menuImageGroups: groups.length ? groups : undefined,
    locationMapUrl: optStr(body.locationMapUrl),
    description: optStr(r.description),
    hasDetails: true,
    latitude: optNum(body.latitude) ?? latitude,
    longitude: optNum(body.longitude) ?? longitude,
  };
}

function normalizeDeal(raw: unknown, slotIsFree?: boolean): DineoutDeal | null {
  if (!isRecord(raw)) return null;
  const itemId = str(raw.itemId);
  const slotId = optNum(raw.slotId);
  if (!itemId || slotId === undefined) return null;
  const bookingPrice = optNum(raw.bookingPrice);
  const explicitFree = typeof raw.isFree === "boolean" ? raw.isFree : slotIsFree;
  // Docs: bookingPrice > 0 / isFree=false means a PAID prebook deal, even if
  // the title reads like a discount.
  const isFree = (bookingPrice ?? 0) > 0 ? false : explicitFree !== false;
  return {
    itemId,
    // itemId is "restaurantId-ticketId"; live deals carry no separate ticketId.
    ticketId: idString(raw.ticketId) || itemId.split("-").slice(1).join("-"),
    slotId,
    title: optStr(raw.title),
    isFree,
    bookingPrice,
    displayFee: optStr(raw.displayFee),
    discountPercentage: optNum(raw.discountPercentage),
    dealCategory: optStr(raw.dealCategory),
    availableInventory: optNum(raw.availableInventory),
    soldOut: raw.soldOut === true || optNum(raw.availableInventory) === 0,
  };
}

function normalizeSlot(raw: unknown, fallbackDate: string): DineoutSlot | null {
  if (!isRecord(raw)) return null;
  // reservationTime arrives as a STRING of unix seconds ("1792733400").
  const reservationTime = optNum(raw.reservationTime);
  const displayTime = str(raw.displayTime);
  if (reservationTime === undefined || !displayTime) return null;
  const slotIsFree = typeof raw.isFree === "boolean" ? raw.isFree : undefined;
  const deals = (Array.isArray(raw.deals) ? raw.deals : [])
    .map((d) => normalizeDeal(d, slotIsFree))
    .filter((d): d is DineoutDeal => d !== null);
  // The slot carries no slotId of its own — it lives on each deal.
  const slotId = optNum(raw.slotId) ?? deals[0]?.slotId;
  if (slotId === undefined) return null;
  const dateStr = str(raw.dateStr) || fallbackDate;
  return {
    key: `${dateStr}|${reservationTime}`,
    slotId,
    dateStr,
    displayTime,
    reservationTime,
    slotGroupName: str(raw.slotGroupName),
    availableInventory: optNum(raw.availableInventory),
    subText: optStr(raw.subText),
    daySubtext: optStr(raw.daySubtext),
    deals,
  };
}

/**
 * get_available_slots → the slot picker view. The live slots are in the RAW
 * result's `_meta.slots` (structuredContent only has a count message); pass
 * `{ ...structuredContent, slots: _meta.slots }` (see readSlotsPayload).
 */
export function mapDineoutSlots(
  payload: unknown,
  fallback: { restaurantId?: string; restaurantName?: string; date?: string; latitude?: number; longitude?: number } = {},
): DineoutSlotsView | null {
  const data = isRecord(payload) ? payload : {};
  const firstDate = (/^\d{4}-\d{2}-\d{2}$/.test(str(data.date)) ? str(data.date) : "") || fallback.date || "";
  const seen = new Set<string>();
  const slots = (Array.isArray(data.slots) ? data.slots : [])
    .map((s) => normalizeSlot(s, firstDate))
    .filter((s): s is DineoutSlot => s !== null && !seen.has(s.key) && !!seen.add(s.key));
  const restaurantId = idString(data.restaurantId) || fallback.restaurantId || "";
  const latitude = optNum(data.latitude) ?? fallback.latitude;
  const longitude = optNum(data.longitude) ?? fallback.longitude;
  if (!restaurantId || latitude === undefined || longitude === undefined) return null;
  return {
    restaurantId,
    restaurantName: str(data.restaurantName) || fallback.restaurantName || "",
    latitude,
    longitude,
    slots,
  };
}

/** Raw get_available_slots result → `{ ...structuredContent, slots }` for mapDineoutSlots. */
export function readSlotsPayload(raw: unknown): Record<string, unknown> {
  const r = isRecord(raw) ? raw : {};
  const structured = isRecord(r.structuredContent) ? r.structuredContent : {};
  const meta = isRecord(r._meta) ? r._meta : {};
  const slots = Array.isArray(meta.slots) ? meta.slots : Array.isArray(structured.slots) ? structured.slots : [];
  return { ...structured, slots };
}

/** book_table (FREE) or get_booking_status `data` → booking. */
export function mapDineoutBooking(payload: unknown): DineoutBooking | null {
  const root = isRecord(payload) ? payload : {};
  // get_booking_status nests the booking: { order: { orderId, status, …, bill }, message }
  const d = isRecord(root.order) ? root.order : root;
  const orderId = idString(d.orderId);
  const status = str(d.status);
  if (!orderId || !status) return null;
  const bill = isRecord(d.bill) ? d.bill : {};
  const amount = optNum(bill.totalBillAmount);
  return {
    ...(amount !== undefined ? { amount } : {}),
    orderId,
    status,
    restaurantId: optStr(idString(d.restaurantId)),
    restaurantName: optStr(d.restaurantName),
    restaurantLocation: optStr(d.restaurantLocation),
    reservationDate: optStr(d.reservationDate),
    reservationTime: optStr(d.reservationTime),
    guestCount: optNum(d.guestCount),
    dealTitle: optStr(d.dealTitle),
  };
}

/** One-line human summary of a booking for the tracker card. */
export function describeDineoutBooking(b: DineoutBooking): string {
  return [
    b.reservationDate,
    b.reservationTime,
    b.guestCount ? `${b.guestCount} guest${b.guestCount === 1 ? "" : "s"}` : "",
    b.dealTitle,
    b.amount ? `₹${b.amount}` : "",
    b.restaurantLocation,
  ]
    .filter(Boolean)
    .join(" · ");
}

/* ------------------------------- read calls -------------------------------- */

/** Rendered cards change rarely; slots/details a little more often. */
const SEARCH_TTL_MS = 3 * 60_000;
const DETAILS_TTL_MS = 5 * 60_000;
const SLOTS_TTL_MS = 60_000;

const coordKey = (n: number) => n.toFixed(4);

/**
 * search_restaurants_dineout (text) → ids in Swiggy's order →
 * render_restaurants_dineout (photo cards). If render fails, the cards come
 * from the search text (no photo → the UI shows a placeholder, never stock art).
 * Cached + de-duplicated; a 429 throws DineoutBusyError.
 */
export function searchDineoutRestaurants(
  args: { query: string; latitude: number; longitude: number; limit?: number; offset?: number; entityType?: string },
  options: { signal?: AbortSignal } = {},
): Promise<DineoutSearchResult> {
  const key = [
    "search",
    args.query.trim().toLowerCase(),
    coordKey(args.latitude),
    coordKey(args.longitude),
    args.limit ?? "",
    args.offset ?? "",
    args.entityType ?? "",
  ].join("|");
  return cached(key, SEARCH_TTL_MS, () =>
    guarded(async () => {
      const mcpArgs: Record<string, unknown> = {
        query: args.query.trim(),
        latitude: args.latitude,
        longitude: args.longitude,
      };
      if (args.limit !== undefined) mcpArgs.limit = args.limit;
      if (args.offset !== undefined) mcpArgs.offset = args.offset;
      if (args.entityType) mcpArgs.entityType = args.entityType;
      // At most one retry: every retry of a rate-limited search makes it worse.
      const raw = await callTool(DINEOUT_URL, TOOL.search, mcpArgs, { signal: options.signal, maxRetries: 1 });
      const parsed = parseDineoutSearchText(resultText(raw));
      // Tolerate the documented structured shape too, should Swiggy add it back.
      const structured = isRecord(raw.structuredContent) ? mapDineoutRender(raw.structuredContent) : null;
      const base: DineoutSearchResult = parsed.restaurants.length || !structured?.restaurants.length ? parsed : structured;
      const latitude = base.latitude ?? args.latitude;
      const longitude = base.longitude ?? args.longitude;
      const textCards = base.restaurants.map((r) => ({ ...r, latitude, longitude }));
      if (textCards.length === 0) return { ...base, restaurants: [], latitude, longitude };

      try {
        const search: Record<string, unknown> = { query: mcpArgs.query, latitude, longitude };
        if (args.entityType) search.entityType = args.entityType;
        const rendered = mapDineoutRender(
          coerceToolPayload(
            await callTool(
              DINEOUT_URL,
              TOOL.render,
              { restaurantIds: textCards.map((r) => r.id), searches: [search] },
              { signal: options.signal, maxRetries: 1 },
            ),
          ),
        );
        return {
          ...base,
          restaurants: orderBookableFirst(mergeRenderedCards(textCards, rendered), args.query),
          latitude,
          longitude,
          renderNote: rendered.renderNote,
          source: "render" as const,
        };
      } catch (err) {
        if (isAuthError(err) || isRateLimited(err)) throw err;
        console.warn(`[dineout] render failed, showing text cards: ${err instanceof Error ? err.message : String(err)}`);
        return { ...base, restaurants: textCards, latitude, longitude, source: "text" as const };
      }
    }),
  );
}

export function getDineoutRestaurantDetails(
  restaurantId: string,
  latitude: number,
  longitude: number,
  options: { signal?: AbortSignal } = {},
): Promise<DineoutRestaurant> {
  const key = ["details", restaurantId, coordKey(latitude), coordKey(longitude)].join("|");
  return cached(key, DETAILS_TTL_MS, () =>
    guarded(async () => {
      const payload = coerceToolPayload(
        await callTool(DINEOUT_URL, TOOL.details, { restaurantId, latitude, longitude }, { signal: options.signal }),
      );
      const r = mapDineoutDetails(payload, latitude, longitude);
      if (!r) throw new Error("Swiggy returned no details for this restaurant.");
      return r;
    }),
  );
}

/** All slots for up to 7 days from `date` (YYYY-MM-DD) — one call; filter by dateStr client-side. */
export function getDineoutSlots(
  restaurantId: string,
  date: string,
  latitude: number,
  longitude: number,
  options: { signal?: AbortSignal; restaurantName?: string } = {},
): Promise<DineoutSlotsView> {
  const key = ["slots", restaurantId, date, coordKey(latitude), coordKey(longitude)].join("|");
  return cached(key, SLOTS_TTL_MS, () =>
    guarded(async () => {
      const raw = await callTool(
        DINEOUT_URL,
        TOOL.slots,
        { restaurantId, date, latitude, longitude },
        { signal: options.signal },
      );
      const view = mapDineoutSlots(readSlotsPayload(raw), {
        restaurantId,
        restaurantName: options.restaurantName,
        date,
        latitude,
        longitude,
      });
      if (!view) throw new Error("Swiggy returned no slot data for this restaurant.");
      return view;
    }),
  );
}

export async function getDineoutBookingStatus(orderId: string): Promise<DineoutBooking> {
  const payload = coerceToolPayload(await callTool(DINEOUT_URL, TOOL.bookingStatus, { orderId }));
  const b = mapDineoutBooking(payload);
  if (!b) throw new Error("Swiggy returned no booking for this order ID.");
  return b;
}

/**
 * The agent's fetch for Dineout tools (runner.ts). Generic coercion loses what
 * Dineout needs — search results are text-only and slots live in `_meta` — so
 * search returns rendered photo cards (DineoutSearchResult), slots return
 * `{ ...structuredContent, slots }`, details the structured body.
 */
export async function fetchDineoutToolPayload(
  bareTool: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<unknown> {
  const lat = optNum(args.latitude);
  const lng = optNum(args.longitude);
  switch (bareTool) {
    case TOOL.search: {
      const query = str(args.query).trim();
      if (!query || lat === undefined || lng === undefined) throw new Error("query, latitude and longitude are required.");
      const result = await searchDineoutRestaurants(
        {
          query,
          latitude: lat,
          longitude: lng,
          offset: optNum(args.offset),
          limit: optNum(args.limit),
          entityType: optStr(args.entityType),
        },
        { signal },
      );
      if (!result.restaurants.length) {
        return { message: `No Dineout restaurants matched “${query}” here. Offer a different term (cuisine, area or vibe).` };
      }
      return result;
    }
    case TOOL.details: {
      if (lat === undefined || lng === undefined) throw new Error("latitude and longitude are required.");
      const r = await getDineoutRestaurantDetails(str(args.restaurantId), lat, lng, { signal });
      return { restaurant: r };
    }
    case TOOL.slots: {
      if (lat === undefined || lng === undefined) throw new Error("latitude and longitude are required.");
      const view = await getDineoutSlots(str(args.restaurantId), str(args.date), lat, lng, {
        signal,
        restaurantName: optStr(args.restaurantName),
      });
      return view;
    }
    default:
      return guarded(async () => coerceToolPayload(await callTool(DINEOUT_URL, bareTool, args, { signal })));
  }
}

/* ------------------------------ mutating calls ----------------------------- */

/** The exact slot fields book_table / create_cart require (copied from the selected slot + deal). */
export interface DineoutSlotArgs {
  restaurantId: string;
  slotId: number; // slot.deals[].slotId
  itemId: string; // slot.deals[].itemId
  reservationTime: number; // slot.reservationTime
  guestCount: number; // 1–20
  latitude: number;
  longitude: number;
}

/** Validate a request body into DineoutSlotArgs; returns an error message on bad input. */
export function parseDineoutSlotArgs(body: unknown): DineoutSlotArgs | string {
  const b = isRecord(body) ? body : {};
  const restaurantId = idString(b.restaurantId);
  const slotId = optNum(b.slotId);
  const itemId = str(b.itemId);
  const reservationTime = optNum(b.reservationTime);
  const guestCount = optNum(b.guestCount);
  const latitude = optNum(b.latitude);
  const longitude = optNum(b.longitude);
  if (!restaurantId) return "restaurantId is required.";
  if (slotId === undefined) return "slotId (number, from the selected deal) is required.";
  if (!itemId) return "itemId (from the selected deal) is required.";
  if (reservationTime === undefined) return "reservationTime (from the selected slot) is required.";
  if (guestCount === undefined || !Number.isInteger(guestCount) || guestCount < 1 || guestCount > 20) {
    return "guestCount must be a whole number from 1 to 20.";
  }
  if (latitude === undefined || longitude === undefined) return "latitude and longitude are required.";
  return { restaurantId, slotId, itemId, reservationTime, guestCount, latitude, longitude };
}

/** create_cart (DEAL_TICKET_PURCHASE) for a PAID deal. Never auto-retried. */
export async function createDineoutDealCart(args: DineoutSlotArgs): Promise<DineoutCart> {
  const payload = coerceToolPayload(
    await callTool(DINEOUT_URL, TOOL.createCart, { ...args, cartType: "DEAL_TICKET_PURCHASE" }),
  );
  const data = isRecord(payload) ? payload : {};
  const cart = isRecord(data.cart) ? data.cart : {};
  const bill = isRecord(cart.bill) ? cart.bill : {};
  const pricing = isRecord(bill.dineoutPricingInfo) ? bill.dineoutPricingInfo : {};
  const cartKey = str(data.cartKey) || str(cart.cartKey);
  if (!cartKey) throw new Error("Swiggy did not return a cart for this deal.");
  return {
    cartKey,
    cartId: optStr(idString(cart.cartId)),
    billToPay: optNum(bill.billToPay) ?? optNum(pricing.billToPay),
    skipPayment: typeof bill.skipPayment === "boolean" ? bill.skipPayment : undefined,
  };
}

export type DineoutBookResult =
  | { kind: "booked"; booking: DineoutBooking }
  | { kind: "pending_payment"; session: PaymentSession; booking: Partial<DineoutBooking> };

/**
 * book_table. FREE deal: pass only the slot args (Swiggy creates + confirms in
 * one step). PAID deal: also pass paymentMethod "UPI", the create_cart cartKey
 * and intentApp (or generateUPIQR). NOT idempotent — never retried here.
 */
export async function bookDineoutTable(
  args: DineoutSlotArgs,
  payment?: { cartKey: string; intentApp?: string; generateUPIQR?: boolean; amount?: number; title?: string },
): Promise<DineoutBookResult> {
  const mcpArgs: Record<string, unknown> = { ...args };
  if (payment) {
    mcpArgs.paymentMethod = "UPI";
    mcpArgs.cartKey = payment.cartKey;
    if (payment.generateUPIQR) mcpArgs.generateUPIQR = true;
    else if (payment.intentApp) mcpArgs.intentApp = payment.intentApp;
  }
  const payload = coerceToolPayload(await callTool(DINEOUT_URL, TOOL.bookTable, mcpArgs));
  const d = isRecord(payload) ? payload : {};
  const orderId = idString(d.orderId);
  const status = str(d.status);
  if (!orderId || !status) throw new Error("Swiggy did not return a booking for this request.");

  if (status === "PENDING_PAYMENT") {
    const paasId = str(d.paasId);
    const pollingIntervalInMs = optNum(d.pollingIntervalInMs);
    const maxTimeToPollForInMs = optNum(d.maxTimeToPollForInMs);
    if (!paasId || pollingIntervalInMs === undefined || maxTimeToPollForInMs === undefined) {
      throw new Error("Swiggy started the payment but returned no payment reference.");
    }
    return {
      kind: "pending_payment",
      session: {
        orderId,
        paasId,
        transactionId: optStr(idString(d.transactionId)),
        bridgeUrl: optStr(d.bridgeUrl),
        upiIntentUrl: optStr(d.upiIntentUrl),
        isQrFlow: d.isQrFlow === true,
        echo: payment ? { cartKey: payment.cartKey } : undefined,
        paymentMethod: "UPI",
        status: "pending",
        pollingIntervalInMs,
        maxTimeToPollForInMs,
        confirmed: false,
        amount: payment?.amount ?? 0,
        service: "dineout",
        title: payment?.title,
      },
      booking: {
        orderId,
        status,
        restaurantName: optStr(d.restaurantName),
        restaurantLocation: optStr(d.restaurantLocation),
        reservationDate: optStr(d.reservationDate),
        reservationTime: optStr(d.reservationTime),
        guestCount: optNum(d.guestCount),
      },
    };
  }

  const booking = mapDineoutBooking(d);
  if (!booking) throw new Error("Swiggy did not return a booking for this request.");
  return { kind: "booked", booking };
}

/**
 * Whether this account's live Dineout server exposes cancel_booking. It is
 * documented but not rolled out to every account (the live tools/list for our
 * test account omits it). `undefined` = the tool list couldn't be read.
 */
export function dineoutCanCancel(): Promise<boolean | undefined> {
  return hasTool(DINEOUT_URL, TOOL.cancelBooking);
}

/** Thrown when cancel_booking isn't available for this account. */
export class DineoutCancelUnavailableError extends Error {
  constructor() {
    super(
      "Swiggy hasn't enabled cancelling table bookings through this app for your account. Cancel it in the Swiggy Dineout app or call customer care at 080-67466729.",
    );
    this.name = "DineoutCancelUnavailableError";
  }
}

/** cancel_booking — destructive; only after the user confirmed. May not be rolled out for every account. */
export async function cancelDineoutBooking(
  orderId: string,
  cancellationReason?: string,
): Promise<{ orderId: string; status: string; cancelledAt?: string }> {
  // Never send a call the server will reject as an unknown tool (that error
  // would read as an ambiguous failure of a destructive call).
  if ((await dineoutCanCancel()) === false) throw new DineoutCancelUnavailableError();
  const args: Record<string, unknown> = { orderId };
  if (cancellationReason) args.cancellationReason = cancellationReason;
  const payload = coerceToolPayload(await callTool(DINEOUT_URL, TOOL.cancelBooking, args));
  const d = isRecord(payload) ? payload : {};
  const status = str(d.status);
  if (!status) throw new Error("Swiggy did not confirm the cancellation.");
  return { orderId: idString(d.orderId) || orderId, status, cancelledAt: optStr(d.cancelledAt) };
}

/** Customer-care fallback the docs give for a failed cancel_booking. */
export const DINEOUT_SUPPORT_HINT =
  "Please manage it in the Swiggy Dineout app or call customer care at 080-67466729.";
