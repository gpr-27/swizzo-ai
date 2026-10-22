// Swiggy Scenes MCP client (events & shows) over streamable HTTP.
// Contracts: docs/swiggy-mcp/scenes.md, corrected by the LIVE payloads in
// docs/swiggy-mcp/LIVE-SAMPLES.md (real data wins). Every mapper reads only
// fields Swiggy returned and never fills gaps with invented values — a missing
// field stays undefined and the UI hides it. Errors propagate (AuthError /
// SwiggyToolError carry Swiggy's own message) so the user sees the real reason.
//
// Live reality (2026-10):
//   - discover_events returns `{events:[], collectionChips:[]}` everywhere, so
//     browsing falls back to search_events over a few genre keywords. That
//     search returns events from ALL cities (`location: "Area, City"`), so the
//     results are filtered to the user's city, de-duplicated, and the top few
//     enriched with get_event_details (venue, date, price string).
//   - list_event_shows: `eventShowListing.dateGroupedEventShow[].eventShow[]`
//     with a STRING `id`, `show_time_unix`, `show_time_ist`,
//     `maxAvailableInventory`, `purchaseRules.allowedCovers`, and
//     `tickets[] {id, name, availableInventory, price:{price,discountedPrice,coverCharge:{units}}}`;
//     `venueDetails` is an array.
//   - create_event_cart takes `showId` as a NUMBER (its input schema), so the
//     string id is converted with Number() at selection time.
//
// Booking flow:
//   discover_events (→ keyword-search fallback) | get_events_collection | search_events
//     → get_event_details (only source of venueId)
//     → list_event_shows{eventId, venueId}
//     → create_event_cart → user confirms the summary
//     → FREE: place_event_order(FREE + echoed selection)
//       UPI : get_payment_options{cartKey} → place_event_order(UPI) → payment stage

import { isAuthError, SWIGGY_SCENES_MCP_URL } from "@/backend/config/env";
import { callTool, coerceToolPayload, idStr, isRecord, str } from "@/backend/mcp/client";
import { envelopeMessage } from "@/backend/mcp/payload";
import type {
  PaymentSession,
  ScenesBooking,
  ScenesCart,
  ScenesCollection,
  ScenesEvent,
  ScenesSelection,
  ScenesShow,
  ScenesShowListing,
  ScenesTicket,
} from "@/shared/types";
import { BoundedMap } from "@/backend/resilience/lru";

const SCENES_URL = SWIGGY_SCENES_MCP_URL;

/** User coordinates every Scenes call is scoped to (reuse the same pair across the flow). */
export interface ScenesCoords {
  latitude: number;
  longitude: number;
}

/** One Scenes tool call → its unwrapped `data` (or whole body) + the envelope message. */
async function callScenes(
  name: string,
  args: Record<string, unknown>,
): Promise<{ data: unknown; message?: string }> {
  const raw = await callTool(SCENES_URL, name, args);
  return { data: coerceToolPayload(raw), message: envelopeMessage(raw) };
}

/** A finite number, or undefined (no invented fallbacks). */
function optNum(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return undefined;
}

/** A finite number from a number or a numeric string (Swiggy money `units` are strings). */
function numLike(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return undefined;
}

/** A non-empty string, or undefined. */
function optStr(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** The user coordinates a tool call was made with (from its input args), if both are numbers. */
export function scenesCoords(input: Record<string, unknown>): Partial<ScenesCoords> {
  const latitude = optNum(input.latitude);
  const longitude = optNum(input.longitude);
  return latitude !== undefined && longitude !== undefined ? { latitude, longitude } : {};
}

/** One-line booking summary from the fields Swiggy actually returned. */
export function describeScenesBooking(b: ScenesBooking): string {
  const parts: string[] = [];
  if (b.venueName) parts.push(b.venueLocation ? `${b.venueName}, ${b.venueLocation}` : b.venueName);
  const when = [b.date, b.time].filter(Boolean).join(" · ");
  if (when) parts.push(when);
  if (b.guestCount !== undefined) parts.push(`${b.guestCount} ticket${b.guestCount === 1 ? "" : "s"}`);
  if (b.totalAmount !== undefined && b.totalAmount > 0) parts.push(`₹${b.totalAmount}`);
  if (b.status.toUpperCase() === "PROCESSING") parts.push("Swiggy is still confirming this booking");
  parts.push(`Order ${b.orderId}`);
  return parts.join(" | ");
}

/* ---------------------------------- cities --------------------------------- */

// Scenes search results carry `location: "Area, City"` across every city, so
// we need the user's city to keep only local events. Names are the ones Swiggy
// prints in `location` / `cityDisplayName`; aliases cover address spellings.
// Coordinates are city centres, used only to pick the nearest city.
const CITIES: { name: string; aliases: string[]; lat: number; lng: number }[] = [
  { name: "Bangalore", aliases: ["bengaluru", "bangalore"], lat: 12.9716, lng: 77.5946 },
  { name: "Mumbai", aliases: ["mumbai", "bombay", "navi mumbai", "thane"], lat: 19.076, lng: 72.8777 },
  { name: "Delhi", aliases: ["delhi", "new delhi"], lat: 28.6139, lng: 77.209 },
  { name: "Gurgaon", aliases: ["gurgaon", "gurugram"], lat: 28.4595, lng: 77.0266 },
  { name: "Noida", aliases: ["noida", "greater noida"], lat: 28.5355, lng: 77.391 },
  { name: "Hyderabad", aliases: ["hyderabad", "secunderabad"], lat: 17.385, lng: 78.4867 },
  { name: "Chennai", aliases: ["chennai", "madras"], lat: 13.0827, lng: 80.2707 },
  { name: "Pune", aliases: ["pune"], lat: 18.5204, lng: 73.8567 },
  { name: "Kolkata", aliases: ["kolkata", "calcutta"], lat: 22.5726, lng: 88.3639 },
  { name: "Ahmedabad", aliases: ["ahmedabad"], lat: 23.0225, lng: 72.5714 },
  { name: "Jaipur", aliases: ["jaipur"], lat: 26.9124, lng: 75.7873 },
  { name: "Kochi", aliases: ["kochi", "cochin", "ernakulam"], lat: 9.9312, lng: 76.2673 },
  { name: "Goa", aliases: ["goa", "panaji", "panjim"], lat: 15.4909, lng: 73.8278 },
  { name: "Chandigarh", aliases: ["chandigarh", "mohali", "panchkula"], lat: 30.7333, lng: 76.7794 },
  { name: "Lucknow", aliases: ["lucknow"], lat: 26.8467, lng: 80.9462 },
  { name: "Indore", aliases: ["indore"], lat: 22.7196, lng: 75.8577 },
  { name: "Udaipur", aliases: ["udaipur"], lat: 24.5854, lng: 73.7125 },
  { name: "Dehradun", aliases: ["dehradun"], lat: 30.3165, lng: 78.0322 },
  { name: "Coimbatore", aliases: ["coimbatore"], lat: 11.0168, lng: 76.9558 },
  { name: "Mysore", aliases: ["mysore", "mysuru"], lat: 12.2958, lng: 76.6394 },
  { name: "Vizag", aliases: ["visakhapatnam", "vizag"], lat: 17.6868, lng: 83.2185 },
  { name: "Surat", aliases: ["surat"], lat: 21.1702, lng: 72.8311 },
  { name: "Nagpur", aliases: ["nagpur"], lat: 21.1458, lng: 79.0882 },
  { name: "Bhubaneswar", aliases: ["bhubaneswar"], lat: 20.2961, lng: 85.8245 },
];

/** Canonical city key for comparisons ("Bengaluru" and "Bangalore" match; unknown → lower-case text). */
export function cityKey(name: string): string {
  const n = name.trim().toLowerCase();
  if (!n) return "";
  const hit = CITIES.find((c) => c.aliases.includes(n) || c.name.toLowerCase() === n);
  if (hit) return hit.name.toLowerCase();
  // Goa areas print as "Central Goa" / "North Goa".
  if (/\bgoa\b/.test(n)) return "goa";
  return n;
}

/** The city named in a free-text address ("… New Tippasandra, Bengaluru, Karnataka") — or undefined. */
export function cityFromAddress(addressLine: string | undefined): string | undefined {
  if (!addressLine) return undefined;
  const text = addressLine.toLowerCase();
  for (const c of CITIES) {
    if (c.aliases.some((a) => new RegExp(`\\b${a.replace(/ /g, "\\s+")}\\b`).test(text))) return c.name;
  }
  return undefined;
}

/** Nearest known city to the user's coordinates (within ~80 km), or undefined. */
export function nearestCity(coords: Partial<ScenesCoords>): string | undefined {
  const { latitude, longitude } = coords;
  if (latitude === undefined || longitude === undefined) return undefined;
  let best: { name: string; km: number } | undefined;
  for (const c of CITIES) {
    const dLat = ((c.lat - latitude) * Math.PI) / 180;
    const dLng = ((c.lng - longitude) * Math.PI) / 180;
    const h =
      Math.sin(dLat / 2) ** 2 +
      Math.cos((latitude * Math.PI) / 180) * Math.cos((c.lat * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
    const km = 2 * 6371 * Math.asin(Math.sqrt(h));
    if (!best || km < best.km) best = { name: c.name, km };
  }
  return best && best.km <= 80 ? best.name : undefined;
}

/** The user's city: the selected address names it, else the nearest city to the coordinates. */
export function resolveUserCity(coords: Partial<ScenesCoords>, addressLine?: string): string | undefined {
  return cityFromAddress(addressLine) ?? nearestCity(coords);
}

/* ------------------------------ saved locations ----------------------------- */

/** One get_saved_locations entry (`{index, id, addressLine, phoneNumber, addressCategory, addressTag}`). */
export interface ScenesSavedLocation {
  id: string;
  label?: string; // addressTag ("Home", "GPR") — else addressCategory
  category?: string; // addressCategory ("Home" | "Work" | "Other")
  addressLine: string; // verbatim; starts with "<contact name>: "
  city?: string; // the city named in addressLine
}

// get_saved_locations has no coordinates, so a search with `addressId` can't be
// city-filtered from coords. Remember each id's address line (per process,
// 30 min) so the search_events mapper can resolve the saved place's city.
const savedLines = new BoundedMap<string, { at: number; line: string }>({ max: 2_000, ttlMs: 30 * 60_000 });

/** get_saved_locations → entries (phoneNumber is masked by Swiggy and never needed). */
export function mapSavedLocations(payload: unknown): ScenesSavedLocation[] {
  const root = isRecord(payload) ? payload : {};
  const list = Array.isArray(root.locations) ? root.locations : Array.isArray(root.addresses) ? root.addresses : [];
  const out: ScenesSavedLocation[] = [];
  for (const raw of list) {
    if (!isRecord(raw)) continue;
    const id = idStr(raw.id);
    const addressLine = str(raw.addressLine);
    if (!id || !addressLine) continue;
    savedLines.set(id, { at: Date.now(), line: addressLine });
    const category = optStr(raw.addressCategory);
    out.push({ id, label: optStr(raw.addressTag) ?? category, category, addressLine, city: cityFromAddress(addressLine) });
  }
  return out;
}

/** The city of a saved location id seen in an earlier get_saved_locations call. */
export function savedLocationCity(addressId: unknown): string | undefined {
  const id = typeof addressId === "string" ? addressId : "";
  const hit = id ? savedLines.get(id) : undefined;
  if (!hit) return undefined;
  if (Date.now() - hit.at > 30 * 60_000) {
    savedLines.delete(id);
    return undefined;
  }
  return cityFromAddress(hit.line);
}

/** search_events `location` "Indiranagar, Bangalore" → { area: "Indiranagar", city: "Bangalore" }. */
export function splitLocation(location: string | undefined): { area?: string; city?: string } {
  const loc = optStr(location);
  if (!loc) return {};
  const parts = loc.split(",").map((p) => p.trim()).filter(Boolean);
  if (parts.length < 2) return { city: parts[0] };
  return { area: parts.slice(0, -1).join(", "), city: parts[parts.length - 1] };
}

/** Keep only events in `city` (events without a known city are kept — we can't tell). */
export function filterToCity(events: ScenesEvent[], city: string | undefined): ScenesEvent[] {
  const key = city ? cityKey(city) : "";
  if (!key) return events;
  return events.filter((e) => !e.city || cityKey(e.city) === key);
}

/* --------------------------------- mappers --------------------------------- */

/**
 * One event card from discover_events / get_events_collection
 * (`{eventId, eventName, venueName, area, date, price}`) or search_events
 * (`{eventId, eventName, location: "Area, City"}`). `price` is a display string — kept verbatim.
 */
function normalizeEventCard(raw: unknown, coords?: Partial<ScenesCoords>): ScenesEvent | null {
  if (!isRecord(raw)) return null;
  const id = idStr(raw.eventId);
  if (!id) return null;
  const loc = splitLocation(str(raw.location));
  return {
    id,
    title: str(raw.eventName),
    venueName: str(raw.venueName),
    area: optStr(raw.area) ?? loc.area,
    city: loc.city,
    dateSummary: optStr(raw.date),
    priceText: optStr(raw.price),
    latitude: optNum(coords?.latitude),
    longitude: optNum(coords?.longitude),
  };
}

/** Event list + genre chips from discover_events / get_events_collection / search_events (deduped by id). */
export function mapScenesEvents(
  payload: unknown,
  coords?: Partial<ScenesCoords>,
): { events: ScenesEvent[]; collections: ScenesCollection[] } {
  const obj = isRecord(payload) ? payload : {};
  const rawList = Array.isArray(obj.events)
    ? obj.events
    : Array.isArray(obj.suggestions)
      ? obj.suggestions
      : [];
  const seen = new Set<string>();
  const events: ScenesEvent[] = [];
  for (const raw of rawList) {
    const e = normalizeEventCard(raw, coords);
    if (!e || seen.has(e.id)) continue;
    seen.add(e.id);
    events.push(e);
  }

  const collections: ScenesCollection[] = [];
  if (Array.isArray(obj.collectionChips)) {
    for (const c of obj.collectionChips) {
      if (!isRecord(c)) continue;
      const id = idStr(c.collectionIdentifier);
      const label = str(c.label);
      if (id && label) collections.push({ id, label });
    }
  }
  return { events, collections };
}

/** get_event_details → one event incl. venueId (the only tool that returns it). */
export function normalizeEventDetails(
  payload: unknown,
  coords?: Partial<ScenesCoords>,
): ScenesEvent | null {
  if (!isRecord(payload)) return null;
  const id = idStr(payload.eventId);
  if (!id) return null;
  // formattedAddress ends with the city ("Bloom Creative Zone - Hsr, Bangalore").
  const address = optStr(payload.formattedAddress);
  return {
    id,
    title: str(payload.eventName),
    venueName: str(payload.venueName),
    venueId: optStr(idStr(payload.venueId)),
    area: optStr(payload.area),
    city: address && address.includes(",") ? splitLocation(address).city : undefined,
    venueAddress: address,
    dateSummary: optStr(payload.upcomingDate),
    priceText: optStr(payload.price),
    // venueLat / venueLng arrive as numeric strings ("12.90682").
    venueLatitude: numLike(payload.venueLat),
    venueLongitude: numLike(payload.venueLng),
    latitude: optNum(coords?.latitude),
    longitude: optNum(coords?.longitude),
  };
}

/**
 * get_event_venue_info (live 2026-10-22: `eventShowListing { dateSummary[],
 * venueDetails[], dateGroupedEventShow[], eventInfo }`, shows WITHOUT tickets /
 * show_time_*) → one event card per venue, for browsing ("which venues / where
 * is it"). Each card carries that venue's own upcoming dates + show count
 * (shows are matched by `venue.venueId`), its distance from the user, and the
 * event-level metadata (languages, age, duration, seating, rewards). The venue
 * id is real, so "See shows" works from these cards.
 */
export function mapEventVenueInfo(payload: unknown, coords?: Partial<ScenesCoords>): ScenesEvent[] {
  const root = isRecord(payload) ? payload : {};
  const listing = isRecord(root.eventShowListing) ? root.eventShowListing : root;
  const info = isRecord(listing.eventInfo) ? listing.eventInfo : {};
  const id = idStr(info.id);
  if (!id) return [];
  // Per venue: on-sale show dates (date groups whose shows name the venue).
  const byVenue = new Map<string, { dates: string[]; shows: number }>();
  for (const g of Array.isArray(listing.dateGroupedEventShow) ? listing.dateGroupedEventShow : []) {
    if (!isRecord(g)) continue;
    const key = dateKey(g.date);
    for (const sh of Array.isArray(g.eventShow) ? g.eventShow : []) {
      if (!isRecord(sh) || !onSaleStatus(sh.status)) continue;
      const vid = isRecord(sh.venue) ? idStr(sh.venue.venueId) : "";
      if (!vid) continue;
      const v = byVenue.get(vid) ?? { dates: [], shows: 0 };
      v.shows++;
      if (key && !v.dates.includes(key)) v.dates.push(key);
      byVenue.set(vid, v);
    }
  }
  // Fallback when shows carry no venue ids: the listing-wide on-sale dates.
  const allDates = (Array.isArray(listing.dateSummary) ? listing.dateSummary : [])
    .filter((d): d is Record<string, unknown> => isRecord(d) && onSaleStatus(d.status) && optNum(d.totalAvailableInventory) !== 0)
    .map((d) => dateKey(d.date))
    .filter((d): d is string => !!d);
  const languages = stringList(info.languages);
  const out: ScenesEvent[] = [];
  for (const v of Array.isArray(listing.venueDetails) ? listing.venueDetails : []) {
    if (!isRecord(v)) continue;
    const venueId = optStr(idStr(v.id));
    const own = venueId ? byVenue.get(venueId) : undefined;
    const dates = (own?.dates ?? (byVenue.size ? [] : allDates)).slice(0, 5).map(shortDay).filter(Boolean);
    const loc = isRecord(v.location) && isRecord(v.location.latLng) ? v.location.latLng : {};
    out.push({
      id,
      title: str(info.name),
      venueName: str(v.name),
      venueId,
      area: optStr(v.localityDisplayName),
      city: optStr(v.cityDisplayName),
      venueAddress: optStr(v.address),
      dateSummary: dates.length ? `Next: ${dates.join(", ")}` : undefined,
      venueLatitude: optNum(loc.latitude),
      venueLongitude: optNum(loc.longitude),
      distanceKm: distanceKm(v.distance),
      languages: languages.length ? languages : undefined,
      ageGroup: optStr(info.ageGroup),
      duration: durationText(info.eventDuration),
      seating: seatingText(info.seatingArrangement),
      rewards: rewardsText(info.rewardsWidget),
      showCount: own?.shows,
      latitude: optNum(coords?.latitude),
      longitude: optNum(coords?.longitude),
    });
  }
  return out;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2026-10-24" → "24 Oct". */
function shortDay(key: string): string {
  const m = /^\d{4}-(\d{2})-(\d{2})$/.exec(key);
  return m ? `${Number(m[2])} ${MONTHS[Number(m[1]) - 1] ?? ""}`.trim() : key;
}

/** Non-empty strings of an array (languages etc.). */
function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((l): l is string => typeof l === "string" && !!l.trim()).map((l) => l.trim()) : [];
}

/** venueDetails[].distance — metres from the user's coordinates → km (1 decimal). */
function distanceKm(metres: unknown): number | undefined {
  const m = optNum(metres);
  return m !== undefined && m >= 0 ? Math.round(m / 100) / 10 : undefined;
}

/** SEATING_ARRANGEMENT_STANDING_AND_SEATED → "Standing & seated"; *_INVALID / unknown → undefined. */
function seatingText(value: unknown): string | undefined {
  const v = str(value).toUpperCase();
  if (!v || v.endsWith("INVALID") || v.endsWith("UNSPECIFIED")) return undefined;
  const standing = v.includes("STANDING");
  const seated = v.includes("SEATED");
  if (standing && seated) return "Standing & seated";
  if (seated) return "Seated";
  if (standing) return "Standing";
  return undefined;
}

/** rewardsWidget.title "{{img|24|24|…}} Earn 10% DineCash on ticket booking" → the plain text. */
function rewardsText(widget: unknown): string | undefined {
  if (!isRecord(widget)) return undefined;
  return optStr(str(widget.title).replace(/\{\{[^}]*\}\}/g, "").replace(/\s+/g, " "));
}

/** ISO-8601 / epoch seconds / `{seconds}` timestamp → epoch seconds. */
function unixSeconds(value: unknown): number | undefined {
  if (typeof value === "string" && value.trim()) {
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? Math.round(ms / 1000) : numLike(value);
  }
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return value > 1e12 ? Math.round(value / 1000) : value;
  if (isRecord(value)) return numLike(value.seconds);
  return undefined;
}

/** A name from a string or a `{name | displayName | title}` record. */
function nameOf(value: unknown): string | undefined {
  if (typeof value === "string") return optStr(value);
  if (!isRecord(value)) return undefined;
  return optStr(value.name) ?? optStr(value.displayName) ?? optStr(value.title);
}

/** Text lines from strings or `{title, description | text | value}` records (HTML stripped). */
function textItems(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    if (typeof item === "string") {
      const t = plainTerms(item);
      if (t) out.push(t.replace(/\n/g, " "));
    } else if (isRecord(item)) {
      const head = optStr(item.title) ?? optStr(item.name);
      const body = plainTerms(item.description ?? item.text ?? item.value)?.replace(/\n/g, " ");
      const line = head && body ? `${head}: ${body}` : head ?? body;
      if (line) out.push(line);
    }
  }
  return out;
}

/** `{year, month, day}` (live) or a string date → "YYYY-MM-DD" / the string. */
function dateKey(value: unknown): string | undefined {
  if (typeof value === "string") return optStr(value);
  if (!isRecord(value)) return undefined;
  const y = optNum(value.year);
  const m = optNum(value.month);
  const d = optNum(value.day);
  if (y === undefined || m === undefined || d === undefined) return undefined;
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** Swiggy status enum: missing → treat as on sale; otherwise only *_ON_SALE is bookable. */
function onSaleStatus(status: unknown): boolean {
  const s = typeof status === "string" ? status : "";
  return !s || /ON_SALE/i.test(s);
}

/** Money `{units:"199", nanos:0}` → 199 (rupees). */
function money(value: unknown): number | undefined {
  if (!isRecord(value)) return numLike(value);
  const units = numLike(value.units);
  if (units === undefined) return undefined;
  const nanos = numLike(value.nanos) ?? 0;
  return units + nanos / 1e9;
}

/** HTML terms ("<ul><li>This pass admits 1 individual only</li></ul>") → plain text lines. */
function plainTerms(html: unknown): string | undefined {
  const s = optStr(html);
  if (!s) return undefined;
  const text = s
    .replace(/<\s*(li|br|p|div)[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .join("\n");
  return text || undefined;
}

/** One ticket tier: `{id, name, availableInventory, price:{price, discountedPrice, coverCharge}, tnc, status}`. */
function mapTicket(t: unknown): ScenesTicket | null {
  if (!isRecord(t)) return null;
  const ticketId = idStr(t.id) || idStr(t.ticketId);
  if (!ticketId) return null;
  const p = isRecord(t.price) ? t.price : {};
  // Older docs shape: `price` is a plain number.
  const list = isRecord(t.price) ? money(p.price) : numLike(t.price);
  const discounted = isRecord(t.price) ? money(p.discountedPrice) : undefined;
  const cover = isRecord(t.price) ? money(p.coverCharge) : undefined;
  const price = discounted ?? list;
  const availableInventory = optNum(t.availableInventory);
  return {
    ticketId,
    title: str(t.name) || str(t.ticketTitle),
    price,
    originalPrice: list !== undefined && price !== undefined && list > price ? list : undefined,
    coverCharge: cover !== undefined && cover > 0 ? cover : undefined,
    availableInventory,
    onSale: onSaleStatus(t.status) && availableInventory !== 0,
    tnc: plainTerms(t.tnc),
  };
}

/** eventDuration `{type:"TYPE_HOURS", value:1}` → "1 hr". */
function durationText(d: unknown): string | undefined {
  if (!isRecord(d)) return undefined;
  const v = optNum(d.value);
  if (v === undefined || v <= 0) return undefined;
  const type = str(d.type).toUpperCase();
  if (type.includes("MIN")) return `${v} min`;
  if (type.includes("DAY")) return `${v} day${v === 1 ? "" : "s"}`;
  return `${v} hr${v === 1 ? "" : "s"}`;
}

// Words that make a lower-case Swiggy tag a real genre / format label
// ("stand up comedy", "live music") rather than a merchandising bucket
// ("activity summer", "near bangalore", "rakhi").
const TAG_GENRE = /comed|music|concert|mic\b|storytell|workshop|theat|poetry|brunch|jam|\bdj\b|party|festival|stand ?up|\bart\b|dance|sufi|retro|karaoke|quiz|screening|unplugged|acoustic|improv|tasting|class\b/i;
// Internal promo / placement buckets: digits, underscores, "v2", "CoC", campaign words.
const TAG_INTERNAL = /[\d_,]|\bv\d\b|\bcoc\b|collection|carousel|experiences|flash|craz|cluster|curated|jacketed|animated|netflix|do-rx|scenes|stealers|worthy/i;

/**
 * Human-readable tags only, title-cased and de-duplicated: capitalised
 * curated tags ("Perfume Making Workshop"), lower-case genre tags ("stand up
 * comedy" → "Stand Up Comedy") and the kid-friendly flag; internal
 * promo / placement tags ("crazy 26mar", "Workshop_08", "Collection1_v2") are dropped.
 */
function readableTags(tags: unknown): string[] | undefined {
  if (!Array.isArray(tags)) return undefined;
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of tags) {
    if (typeof raw !== "string") continue;
    const t = raw.trim();
    let label: string | undefined;
    if (/^kid'?s?[ _-]?friendly$/i.test(t)) label = "Kid-friendly";
    else if (TAG_INTERNAL.test(t) || !/^[A-Za-z][A-Za-z &'/-]{2,30}$/.test(t)) label = undefined;
    else if (/^[A-Z]/.test(t) || TAG_GENRE.test(t)) label = t.replace(/\b[a-z]/g, (c) => c.toUpperCase());
    const key = label?.toLowerCase().replace(/[^a-z]/g, "");
    if (!label || !key || seen.has(key)) continue;
    seen.add(key);
    out.push(label);
  }
  return out.length ? out.slice(0, 5) : undefined;
}

/**
 * list_event_shows → flat show list (date-ordered as Swiggy returned it). The
 * live payload nests shows under `eventShowListing.dateGroupedEventShow[].eventShow[]`;
 * every field is optional. A show without an id or show_time_unix cannot be
 * booked, so it is dropped.
 */
export function mapShowListing(
  payload: unknown,
  ctx: { eventId: string; eventTitle?: string; venueId?: string; latitude?: number; longitude?: number },
): ScenesShowListing {
  const root = isRecord(payload) ? payload : {};
  const listing = isRecord(root.eventShowListing) ? root.eventShowListing : {};
  // venueDetails is an array live (an object in the docs). Prefer the scoped venue.
  const venues = Array.isArray(listing.venueDetails)
    ? listing.venueDetails.filter(isRecord)
    : isRecord(listing.venueDetails)
      ? [listing.venueDetails]
      : [];
  const venue =
    venues.find((v) => ctx.venueId && (idStr(v.id) === ctx.venueId || idStr(v.venueId) === ctx.venueId)) ??
    venues[0] ??
    {};
  const info = isRecord(listing.eventInfo) ? listing.eventInfo : {};
  // auditoriums[] (empty live) → id → name, for screen / hall labels on shows.
  const halls = new Map<string, string>();
  for (const v of venues) {
    for (const a of Array.isArray(v.auditoriums) ? v.auditoriums : []) {
      const aid = isRecord(a) ? idStr(a.id) || idStr(a.auditoriumId) : "";
      const name = nameOf(a);
      if (aid && name) halls.set(aid, name);
    }
  }

  const shows: ScenesShow[] = [];
  const groups = Array.isArray(listing.dateGroupedEventShow) ? listing.dateGroupedEventShow : [];
  for (const g of groups) {
    if (!isRecord(g)) continue;
    const list = Array.isArray(g.eventShow) ? g.eventShow : [];
    for (const s of list) {
      if (!isRecord(s)) continue;
      const showId = idStr(s.id) || idStr(s.showId);
      const showTimeUnix = numLike(s.show_time_unix);
      if (!showId || showTimeUnix === undefined) continue;
      // A venue-scoped listing must never offer another venue's show (the cart
      // is created with ctx.venueId).
      const showVenueId = isRecord(s.venue) ? optStr(idStr(s.venue.venueId)) : undefined;
      if (ctx.venueId && showVenueId && showVenueId !== ctx.venueId) continue;
      const tickets = (Array.isArray(s.tickets) ? s.tickets : [])
        .map(mapTicket)
        .filter((t): t is ScenesTicket => t !== null);
      const rules = isRecord(s.purchaseRules) ? s.purchaseRules : {};
      const covers = isRecord(rules.allowedCovers) ? rules.allowedCovers : {};
      const availableSeats = optNum(s.maxAvailableInventory) ?? optNum(s.availableSeats);
      const range = isRecord(s.timeRange) ? s.timeRange : {};
      const endMs = typeof range.endTime === "string" ? Date.parse(range.endTime) : NaN;
      const startMs = typeof range.startTime === "string" ? Date.parse(range.startTime) : NaN;
      const durationMin =
        Number.isFinite(startMs) && Number.isFinite(endMs) && endMs > startMs ? Math.round((endMs - startMs) / 60_000) : undefined;
      const gatesOpenUnix = unixSeconds(s.gatePreopenedAt);
      shows.push({
        showId,
        showTimeUnix,
        showTimeIst: str(s.show_time_ist),
        date: dateKey(g.date),
        availableSeats,
        minGuests: optNum(covers.min),
        maxGuests: optNum(covers.max),
        onSale: onSaleStatus(s.status) && availableSeats !== 0 && tickets.some((t) => t.onSale),
        tickets,
        endTimeUnix: Number.isFinite(endMs) && endMs / 1000 > showTimeUnix ? Math.round(endMs / 1000) : undefined,
        durationMin,
        gatesOpenUnix: gatesOpenUnix !== undefined && gatesOpenUnix < showTimeUnix ? gatesOpenUnix : undefined,
        venueId: showVenueId,
        auditorium: halls.get(idStr(s.auditoriumId)) || undefined,
      });
    }
  }

  // dateSummary: seats left per date across the whole listing window (live).
  const dates = (Array.isArray(listing.dateSummary) ? listing.dateSummary : [])
    .filter(isRecord)
    .map((d) => ({
      date: dateKey(d.date) ?? "",
      available: optNum(d.totalAvailableInventory),
      onSale: onSaleStatus(d.status) && optNum(d.totalAvailableInventory) !== 0,
    }))
    .filter((d) => d.date);
  const loc = isRecord(venue.location) ? venue.location : {};
  const latLng = isRecord(loc.latLng) ? loc.latLng : {};

  const languages = stringList(info.languages);
  const run = isRecord(info.timeRange) ? info.timeRange : {};
  const artists = (Array.isArray(info.artists) ? info.artists : []).map(nameOf).filter((a): a is string => !!a);
  const remember = textItems(info.thingsToRemember);
  const rewardsLogo = isRecord(info.rewardsWidget) ? optStr(info.rewardsWidget.logo) : undefined;
  // ticketStartPrice is null live; else the lowest on-sale ticket Swiggy listed.
  const prices = shows.flatMap((s) => s.tickets.filter((t) => t.onSale && t.price !== undefined).map((t) => t.price as number));
  const startPrice = money(info.ticketStartPrice) ?? (prices.length ? Math.min(...prices) : undefined);

  // venueDetails.location describes the venue, never the user — follow-up calls
  // keep using the user's own coordinates.
  return {
    eventId: ctx.eventId,
    eventTitle: str(info.name) || str(info.title) || ctx.eventTitle || "",
    venueId: ctx.venueId ?? (optStr(idStr(venue.id)) || optStr(idStr(venue.venueId))),
    venueName: optStr(venue.name),
    venueAddress: optStr(venue.address),
    venueArea: optStr(venue.localityDisplayName),
    city: optStr(venue.cityDisplayName),
    languages: languages.length ? languages : undefined,
    ageGroup: optStr(info.ageGroup),
    duration: durationText(info.eventDuration),
    tags: readableTags(info.tags),
    latitude: ctx.latitude,
    longitude: ctx.longitude,
    shows,
    dates: dates.length ? dates : undefined,
    venueLatitude: optNum(latLng.latitude),
    venueLongitude: optNum(latLng.longitude),
    venueDistanceKm: distanceKm(venue.distance),
    seating: seatingText(info.seatingArrangement),
    recurring: typeof info.recurring === "boolean" ? info.recurring : undefined,
    runFromUnix: unixSeconds(run.startTime),
    runUntilUnix: unixSeconds(run.endTime),
    rewards: rewardsText(info.rewardsWidget),
    rewardsLogo: rewardsLogo && /^https:\/\//.test(rewardsLogo) ? rewardsLogo : undefined,
    description: plainTerms(info.description),
    category: isRecord(info.eventCategory) ? optStr(info.eventCategory.name) : undefined,
    artists: artists.length ? artists : undefined,
    organizer: nameOf(info.organizer),
    tour: nameOf(info.tour),
    thingsToRemember: remember.length ? remember : undefined,
    eventTnc: plainTerms(info.tnc),
    startPrice,
  };
}

/** get_event_booking_status → `booking` (NOT `data`). Status is kept verbatim. */
export function mapEventBooking(payload: unknown): ScenesBooking | null {
  const root = isRecord(payload) ? payload : {};
  const b = isRecord(root.booking) ? root.booking : isRecord(root.data) && isRecord(root.data.booking) ? root.data.booking : null;
  if (!b) return null;
  const orderId = idStr(b.orderId);
  if (!orderId) return null;
  const bill = isRecord(b.bill) ? b.bill : {};
  return {
    orderId,
    status: str(b.status),
    title: optStr(b.dealTitle),
    venueName: optStr(b.restaurantName),
    venueLocation: optStr(b.restaurantLocation),
    date: optStr(b.reservationDate),
    time: optStr(b.reservationTime),
    guestCount: optNum(b.guestCount),
    totalAmount: optNum(bill.totalBillAmount),
  };
}

/* ------------------------------ discover stage ----------------------------- */

/** discover_events — genre chips + event cards near the user (currently empty server-side). */
export async function discoverScenesEvents(coords: ScenesCoords) {
  const { data } = await callScenes("discover_events", {
    latitude: coords.latitude,
    longitude: coords.longitude,
  });
  return mapScenesEvents(data, coords);
}

/** get_events_collection — the full listing for one genre chip from discover_events. */
export async function getScenesCollection(collectionIdentifier: string, coords: ScenesCoords) {
  const { data } = await callScenes("get_events_collection", {
    collectionIdentifier,
    latitude: coords.latitude,
    longitude: coords.longitude,
  });
  return mapScenesEvents(data, coords).events;
}

/** search_events — keyword / artist search. Live it returns events from every city. */
export async function searchScenesEvents(query: string, coords: ScenesCoords) {
  const { data } = await callScenes("search_events", {
    query,
    latitude: coords.latitude,
    longitude: coords.longitude,
  });
  return mapScenesEvents(data, coords).events;
}

/** get_event_details — throws when Swiggy returns no usable event. */
export async function getScenesEventDetails(eventId: string, coords: ScenesCoords): Promise<ScenesEvent> {
  const { data } = await callScenes("get_event_details", {
    eventId,
    latitude: coords.latitude,
    longitude: coords.longitude,
  });
  const event = normalizeEventDetails(data, coords);
  if (!event) throw new Error("Swiggy returned no details for this event.");
  return event;
}

/* ------------------------ keyword browse (discover fallback) ------------------------ */

// Genre → search keywords. search_events matches words in event titles, so a
// genre is a handful of title words; "all" is the default "what's on" mix.
const GENRE_KEYWORDS: Record<string, string[]> = {
  comedy: ["comedy", "standup", "open mic"],
  music: ["live music", "concert", "music", "gig"],
  party: ["party", "dj", "night"],
  theatre: ["theatre", "play", "drama"],
  workshop: ["workshop", "art", "class"],
  food: ["brunch", "food", "tasting"],
  sports: ["screening", "match", "sports"],
  kids: ["kids", "family"],
  all: ["comedy", "music", "concert", "standup", "open mic", "workshop", "theatre", "party"],
};

/** The browse genre a free-text ask maps to ("standup this weekend" → "comedy"); "all" when unclear. */
export function genreOf(text: string | undefined): string {
  const t = (text ?? "").toLowerCase();
  if (/comed|stand ?up|open ?mic|roast|improv/.test(t)) return "comedy";
  if (/music|concert|gig|band|singer|jam|unplugged|acoustic|sufi|retro/.test(t)) return "music";
  if (/party|dj|club|night ?life|techno|edm|bollywood night/.test(t)) return "party";
  if (/theat|play|drama|musical|poetry|storytell/.test(t)) return "theatre";
  if (/workshop|class|pottery|paint|craft|art\b|learn/.test(t)) return "workshop";
  if (/brunch|food|tasting|wine|beer|dinner/.test(t)) return "food";
  if (/screening|match|sport|cricket|football|ipl/.test(t)) return "sports";
  if (/kid|family|children/.test(t)) return "kids";
  return "all";
}

export function browseKeywords(genre: string): string[] {
  return GENRE_KEYWORDS[genre] ?? GENRE_KEYWORDS.all;
}

// Per-(city, keyword) search cache and per-event details cache — keeps the
// fan-out cheap and inside Swiggy's rate limits. Event listings are public,
// not user-specific, so a process-wide cache is safe.
const SEARCH_TTL_MS = 5 * 60_000;
const DETAILS_TTL_MS = 10 * 60_000;
const searchCache = new BoundedMap<string, { at: number; events: ScenesEvent[] }>({ max: 500, ttlMs: SEARCH_TTL_MS });
const detailsCache = new BoundedMap<string, { at: number; event: ScenesEvent }>({ max: 1_000, ttlMs: DETAILS_TTL_MS });

function cacheGet<T extends { at: number }>(map: Map<string, T>, key: string, ttl: number): T | undefined {
  const hit = map.get(key);
  if (hit && Date.now() - hit.at < ttl) return hit;
  if (hit) map.delete(key);
  return undefined;
}

/** Run `fn` over `items` with at most `limit` calls in flight; results keep input order. */
export async function mapPool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

const MAX_PARALLEL = 4;

/** search_events for one keyword, cached per (city, keyword). Errors other than auth → []. */
async function searchCached(keyword: string, coords: ScenesCoords, city: string | undefined): Promise<ScenesEvent[]> {
  const key = `${cityKey(city ?? "") || `${coords.latitude.toFixed(2)},${coords.longitude.toFixed(2)}`}|${keyword}`;
  const hit = cacheGet(searchCache, key, SEARCH_TTL_MS);
  if (hit) return hit.events.map((e) => ({ ...e, latitude: coords.latitude, longitude: coords.longitude }));
  try {
    const events = await searchScenesEvents(keyword, coords);
    searchCache.set(key, { at: Date.now(), events });
    return events;
  } catch (err) {
    if (isAuthFailure(err)) throw err;
    console.warn(`[scenes] search_events "${keyword}" failed:`, err instanceof Error ? err.message : err);
    return [];
  }
}

/** get_event_details, cached per event. Errors other than auth → null (the bare card is kept). */
export async function eventDetailsCached(eventId: string, coords: ScenesCoords): Promise<ScenesEvent | null> {
  const hit = cacheGet(detailsCache, eventId, DETAILS_TTL_MS);
  if (hit) return { ...hit.event, latitude: coords.latitude, longitude: coords.longitude };
  try {
    const event = await getScenesEventDetails(eventId, coords);
    detailsCache.set(eventId, { at: Date.now(), event });
    return event;
  } catch (err) {
    if (isAuthFailure(err)) throw err;
    console.warn(`[scenes] get_event_details ${eventId} failed:`, err instanceof Error ? err.message : err);
    return null;
  }
}

function isAuthFailure(err: unknown): boolean {
  return (err as { name?: string } | null)?.name === "AuthError" || isAuthError(err);
}

/**
 * Interleave per-keyword result lists round-robin (so "what's on" mixes
 * genres instead of 8 comedy nights), dropping duplicates by eventId.
 */
export function interleaveUnique(lists: ScenesEvent[][]): ScenesEvent[] {
  const seen = new Set<string>();
  const out: ScenesEvent[] = [];
  const longest = Math.max(0, ...lists.map((l) => l.length));
  for (let i = 0; i < longest; i++) {
    for (const list of lists) {
      const e = list[i];
      if (!e || seen.has(e.id)) continue;
      seen.add(e.id);
      out.push(e);
    }
  }
  return out;
}

/**
 * Keyword candidates for browsing: search_events for each keyword (≤ 4 in
 * flight, cached), keep the user's city, interleave + dedupe. No details yet.
 */
export async function keywordCandidates(
  keywords: string[],
  coords: ScenesCoords,
  city: string | undefined,
): Promise<ScenesEvent[]> {
  const lists = await mapPool(keywords, MAX_PARALLEL, (kw) => searchCached(kw, coords, city));
  return interleaveUnique(lists.map((l) => filterToCity(l, city)));
}

/** Merge get_event_details onto a search card (details win where they have a value). */
export function mergeDetails(base: ScenesEvent, details: ScenesEvent | null): ScenesEvent {
  if (!details) return base;
  const defined = Object.fromEntries(
    Object.entries(details).filter(([, v]) => v !== undefined && v !== ""),
  ) as Partial<ScenesEvent>;
  return { ...base, ...defined, city: base.city ?? details.city };
}

export interface ScenesBrowseResult {
  events: ScenesEvent[];
  collections: ScenesCollection[];
  city?: string;
  /** "discover" when Swiggy's discover_events had events; "search" for the keyword fallback. */
  source: "discover" | "search";
}

/**
 * "What's on" browsing. discover_events first (the documented path); when it
 * is empty — as it is live today — fall back to the keyword search in the
 * user's city and enrich the top `limit` with get_event_details.
 */
export async function browseScenesEvents(
  coords: ScenesCoords,
  opts: { city?: string; genre?: string; limit?: number } = {},
): Promise<ScenesBrowseResult> {
  const limit = opts.limit ?? 8;
  const city = opts.city ?? nearestCity(coords);
  let discovered: { events: ScenesEvent[]; collections: ScenesCollection[] } = { events: [], collections: [] };
  try {
    discovered = await discoverScenesEvents(coords);
  } catch (err) {
    if (isAuthFailure(err)) throw err;
    console.warn("[scenes] discover_events failed, using keyword search:", err instanceof Error ? err.message : err);
  }
  if (discovered.events.length) return { ...discovered, city, source: "discover" };

  const candidates = await keywordCandidates(browseKeywords(opts.genre ?? "all"), coords, city);
  const top = candidates.slice(0, limit);
  const details = await mapPool(top, MAX_PARALLEL, (e) => eventDetailsCached(e.id, coords));
  return {
    events: top.map((e, i) => mergeDetails(e, details[i])),
    collections: discovered.collections,
    city,
    source: "search",
  };
}

/**
 * search_events for a user's query, local results first: keeps the user's
 * city when anything matches there (else everything, flagged `elsewhere`),
 * and enriches the top few with get_event_details.
 */
export async function searchScenesNearby(
  query: string,
  coords: ScenesCoords,
  opts: { city?: string; limit?: number } = {},
): Promise<{ events: ScenesEvent[]; city?: string; elsewhere: boolean }> {
  const city = opts.city ?? nearestCity(coords);
  const all = await searchScenesEvents(query, coords);
  const local = filterToCity(all, city);
  const elsewhere = local.length === 0 && all.length > 0;
  const top = (elsewhere ? all : local).slice(0, opts.limit ?? 8);
  const details = await mapPool(top, MAX_PARALLEL, (e) => eventDetailsCached(e.id, coords));
  return { events: top.map((e, i) => mergeDetails(e, details[i])), city, elsewhere };
}

/* ----------------------- agent tool helpers (tools.ts) ----------------------- */

/** Bullet lines ("• eventId=…") from one or more summarize() results. */
function eventBullets(text: string): string[] {
  return text.split("\n").filter((l) => l.startsWith("• eventId="));
}

/**
 * The LLM's discover_events tool. `discoverResult` is the summary of the real
 * discover_events call; when Swiggy returned nothing (live today) it carries a
 * `DISCOVER_EMPTY lat=… lng=… city=…` line, and we browse by keyword instead:
 * search_events per genre keyword (cached, ≤ 4 in flight, user's city only),
 * then `runDetails` (the agent's get_event_details runner — it draws the cards)
 * for the top `limit`. Returns the text the model reads.
 */
export async function agentDiscoverWithFallback(
  discoverResult: string,
  genreText: string | undefined,
  runDetails: (eventId: string) => Promise<string>,
  limit = 8,
): Promise<string> {
  const m = /DISCOVER_EMPTY lat=(-?[\d.]+) lng=(-?[\d.]+)(?: city=([^\n]+))?/.exec(discoverResult);
  if (!m) return discoverResult;
  const coords = { latitude: Number(m[1]), longitude: Number(m[2]) };
  const city = m[3]?.trim() || nearestCity(coords);
  const genre = genreOf(genreText);
  const candidates = (await keywordCandidates(browseKeywords(genre), coords, city)).slice(0, limit);
  const where = city ? `in ${city}` : "near the user";
  if (candidates.length === 0) {
    return `No events found ${where}${genre !== "all" ? ` for "${genre}"` : ""}. Tell the user briefly and suggest another genre or an artist name.`;
  }
  const results = await mapPool(candidates, MAX_PARALLEL, (e) => runDetails(e.id));
  const bullets = results.flatMap(eventBullets);
  // A details call that failed still leaves the search hit worth naming.
  const covered = new Set(bullets.map((b) => /eventId=(\S+)/.exec(b)?.[1]));
  for (const e of candidates) {
    if (!covered.has(e.id)) bullets.push(`• eventId=${e.id} | ${e.title}${e.area ? ` | ${e.area}` : ""} (no details)`);
  }
  return [
    `EVENTS ${where}${genre !== "all" ? ` · ${genre}` : ""} (cards with Book buttons already shown; mark the best with BEST: <eventId> — <reason>):`,
    ...bullets,
  ].join("\n");
}

/**
 * The LLM's search_events tool: after the real search (cards already filtered
 * to the user's city), enrich the first few hits with get_event_details so the
 * cards gain venue + date and the model sees venueIds.
 */
export async function agentEnrichSearch(
  searchResult: string,
  runDetails: (eventId: string) => Promise<string>,
  limit = 4,
): Promise<string> {
  const ids = eventBullets(searchResult)
    .map((b) => /eventId=(\S+)/.exec(b)?.[1])
    .filter((id): id is string => !!id)
    .slice(0, limit);
  if (ids.length === 0) return searchResult;
  const details = (await mapPool(ids, MAX_PARALLEL, runDetails)).flatMap(eventBullets);
  const byId = new Map(details.map((b) => [/eventId=(\S+)/.exec(b)?.[1], b] as const));
  return searchResult
    .split("\n")
    .map((l) => byId.get(/^• eventId=(\S+)/.exec(l)?.[1]) ?? l)
    .join("\n");
}

/** list_event_shows scoped to one venue (a listing without venueId is not safe to book). */
export async function listScenesShows(
  eventId: string,
  venueId: string,
  coords: ScenesCoords,
  eventTitle?: string,
): Promise<ScenesShowListing> {
  const { data } = await callScenes("list_event_shows", {
    eventId,
    venueId,
    latitude: coords.latitude,
    longitude: coords.longitude,
  });
  return mapShowListing(data, { eventId, eventTitle, venueId, ...coords });
}

/** get_event_details → list_event_shows{eventId, venueId}: the documented path to a bookable listing. */
export async function getBookableShows(eventId: string, coords: ScenesCoords): Promise<ScenesShowListing> {
  const event = await getScenesEventDetails(eventId, coords);
  detailsCache.set(eventId, { at: Date.now(), event });
  if (!event.venueId) throw new Error("Swiggy did not return a venue for this event, so it can't be booked here.");
  const listing = await listScenesShows(eventId, event.venueId, coords, event.title);
  return {
    ...listing,
    eventTitle: listing.eventTitle || event.title,
    venueName: listing.venueName ?? (event.venueName || undefined),
    venueAddress: listing.venueAddress ?? event.venueAddress,
    venueArea: listing.venueArea ?? event.area,
    city: listing.city ?? event.city,
    dateSummary: event.dateSummary,
    venueLatitude: listing.venueLatitude ?? event.venueLatitude,
    venueLongitude: listing.venueLongitude ?? event.venueLongitude,
  };
}

/* ------------------------------- ticket stage ------------------------------ */

/**
 * create_event_cart (MUTATING). Returns the authoritative checkoutMode and the
 * response message (the cart summary the user must confirm before any order).
 */
export async function createScenesEventCart(selection: ScenesSelection): Promise<ScenesCart> {
  const { data, message } = await callScenes("create_event_cart", {
    venueId: selection.venueId,
    showId: selection.showId,
    ticketId: selection.ticketId,
    showTime: selection.showTime,
    guestCount: selection.guestCount,
    latitude: selection.latitude,
    longitude: selection.longitude,
  });
  const obj = isRecord(data) ? data : {};
  const cart = isRecord(obj.cart) ? obj.cart : {};
  const bill = isRecord(cart.bill) ? cart.bill : {};
  const pricing = isRecord(bill.dineoutPricingInfo) ? bill.dineoutPricingInfo : {};
  const cartKey = idStr(obj.cartKey) || idStr(cart.cartKey);
  const mode = str(obj.checkoutMode);
  if (mode !== "FREE" && mode !== "UPI" && mode !== "UNAVAILABLE") {
    throw new Error("Swiggy did not say how this ticket can be checked out. Please try another show.");
  }
  if (!cartKey && mode !== "UNAVAILABLE") {
    throw new Error("Swiggy did not return a cart for this selection.");
  }
  return {
    cartKey,
    checkoutMode: mode,
    billToPay: optNum(bill.billToPay) ?? optNum(pricing.billToPay),
    skipPayment: typeof bill.skipPayment === "boolean" ? bill.skipPayment : undefined,
    summary: message,
    selection,
  };
}

/**
 * get_event_cart (READ — Swiggy's "compatibility lookup"). The normal flow never
 * needs it (create_event_cart returns the authoritative summary); Swizzo uses it
 * only to RE-CHECK a paid (UPI) cart that sat on the review step for a while,
 * before fetching payment options. Never call it for a FREE cart (Swiggy: the
 * view route doesn't support those). `paymentAvailable` is undefined when
 * Swiggy didn't say — the caller then proceeds as before.
 */
export async function getScenesEventCart(
  cartKey: string,
  coords: ScenesCoords,
): Promise<{ paymentAvailable?: boolean; billToPay?: number; summary?: string }> {
  const raw = await callTool(SCENES_URL, "get_event_cart", {
    cartKey,
    latitude: coords.latitude,
    longitude: coords.longitude,
  });
  const data = coerceToolPayload(raw);
  const d = isRecord(data) ? data : {};
  const text =
    typeof data === "string"
      ? data
      : isRecord(raw) && Array.isArray(raw.content)
        ? raw.content.map((c) => (isRecord(c) && typeof c.text === "string" ? c.text : "")).join("\n")
        : "";
  const flag = typeof d.paymentAvailable === "boolean" ? d.paymentAvailable : undefined;
  const fromText = text.match(/paymentAvailable\W{0,3}(true|false)/i);
  const cart = isRecord(d.cart) ? d.cart : {};
  const bill = isRecord(cart.bill) ? cart.bill : {};
  return {
    paymentAvailable: flag ?? (fromText ? fromText[1].toLowerCase() === "true" : undefined),
    billToPay: optNum(bill.billToPay),
    summary: envelopeMessage(raw) || (text.trim() ? text.trim().slice(0, 600) : undefined),
  };
}

/* ------------------------------- booking stage ----------------------------- */

export type ScenesOrderResult =
  | { kind: "free"; booking: ScenesBooking; message?: string }
  | { kind: "upi"; session: PaymentSession; message?: string };

/**
 * place_event_order (MUTATING, never auto-retried).
 * UPI : { cartKey, paymentMethod:"UPI", intentApp } or { cartKey, paymentMethod:"UPI", generateUPIQR:true }
 * FREE: { cartKey, paymentMethod:"FREE", venueId, showId, ticketId, showTime, guestCount, latitude, longitude }
 */
export async function placeScenesEventOrder(
  args:
    | { paymentMethod: "UPI"; cartKey: string; intentApp?: string; generateUPIQR?: boolean; amount?: number; title?: string }
    | { paymentMethod: "FREE"; cartKey: string; selection: ScenesSelection },
): Promise<ScenesOrderResult> {
  const mcpArgs: Record<string, unknown> = { cartKey: args.cartKey, paymentMethod: args.paymentMethod };
  if (args.paymentMethod === "UPI") {
    if (args.intentApp) mcpArgs.intentApp = args.intentApp;
    else if (args.generateUPIQR) mcpArgs.generateUPIQR = true;
    else throw new Error("Pick a UPI app or scan-QR to pay.");
  } else {
    const s = args.selection;
    Object.assign(mcpArgs, {
      venueId: s.venueId,
      showId: s.showId,
      ticketId: s.ticketId,
      showTime: s.showTime,
      guestCount: s.guestCount,
      latitude: s.latitude,
      longitude: s.longitude,
    });
  }

  const { data, message } = await callScenes("place_event_order", mcpArgs);
  const d = isRecord(data) ? data : {};
  const orderId = idStr(d.orderId);
  if (!orderId) throw new Error(message || "Swiggy did not return an order for this booking.");

  if (args.paymentMethod === "FREE") {
    const booking: ScenesBooking = {
      orderId,
      status: str(d.status),
      cartKey: optStr(idStr(d.cartKey)),
      venueName: optStr(d.restaurantName),
      venueLocation: optStr(d.restaurantLocation),
      date: optStr(d.reservationDate),
      time: optStr(d.reservationTime),
      guestCount: optNum(d.guestCount),
      totalAmount: 0,
    };
    return { kind: "free", booking, message };
  }

  // UPI: the ticket is NOT booked yet (status PENDING_PAYMENT) — hand the real
  // payment session to the payment stage (check_payment_status → confirm_order).
  const paasId = idStr(d.paasId);
  if (!paasId) throw new Error(message || "Swiggy did not start a payment for this booking.");
  const pollingIntervalInMs = optNum(d.pollingIntervalInMs);
  const maxTimeToPollForInMs = optNum(d.maxTimeToPollForInMs);
  if (pollingIntervalInMs === undefined || maxTimeToPollForInMs === undefined) {
    throw new Error("Swiggy did not return a payment window for this booking.");
  }
  const session: PaymentSession = {
    orderId,
    paasId,
    transactionId: optStr(idStr(d.transactionId)),
    bridgeUrl: optStr(d.bridgeUrl),
    upiIntentUrl: optStr(d.upiIntentUrl),
    isQrFlow: typeof d.isQrFlow === "boolean" ? d.isQrFlow : undefined,
    echo: { cartKey: idStr(d.cartKey) || args.cartKey },
    paymentMethod: "UPI",
    status: "pending",
    pollingIntervalInMs,
    maxTimeToPollForInMs,
    confirmed: false,
    amount: args.amount ?? 0,
    service: "scenes",
    title: args.title,
  };
  return { kind: "upi", session, message };
}

/** get_event_booking_status — the final booking (PROCESSING ≠ confirmed). */
export async function getScenesBookingStatus(orderId: string): Promise<ScenesBooking> {
  const { data } = await callScenes("get_event_booking_status", { orderId });
  const booking = mapEventBooking(data);
  if (!booking) throw new Error("Swiggy returned no booking for this order.");
  return booking;
}

/**
 * JSON error response for the /api/scenes/* routes: auth → 401 (log in again),
 * Swiggy domain failure → 422 with Swiggy's own message, anything else → 502.
 */
export function scenesErrorResponse(err: unknown, route: string): Response {
  const name = (err as { name?: string } | null)?.name;
  const message = err instanceof Error && err.message ? err.message : "Swiggy Scenes is unavailable right now.";
  if (name === "AuthError" || isAuthError(err)) {
    return Response.json({ ok: false, authRequired: true, message: "Please log in to Swiggy again." }, { status: 401 });
  }
  if (name === "SwiggyToolError") {
    const reportId = (err as { reportId?: string }).reportId;
    return Response.json({ ok: false, message, reportId }, { status: 422 });
  }
  console.error(`[${route}] error:`, err);
  return Response.json({ ok: false, message }, { status: 502 });
}

/** Strict numeric check for route inputs (rejects NaN / numeric strings). */
export function isNum(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/**
 * list_event_shows gives the show id as a STRING ("100496062"); create_event_cart's
 * input schema types `showId` as a number. Convert only when it is an exact
 * integer (never round or invent one).
 */
export function showIdForCart(showId: unknown): number | undefined {
  if (typeof showId === "number") return Number.isSafeInteger(showId) && showId > 0 ? showId : undefined;
  if (typeof showId !== "string" || !/^\d{1,15}$/.test(showId.trim())) return undefined;
  const n = Number(showId.trim());
  return Number.isSafeInteger(n) && n > 0 ? n : undefined;
}

/**
 * Validate a client-sent selection against the create_event_cart contract
 * (all seven fields required; showId as a number; guestCount 1–20; showTime in
 * the future). Returns the selection or a user-facing reason it can't be booked.
 */
export function parseSelection(raw: unknown): ScenesSelection | string {
  const s = isRecord(raw) ? raw : {};
  const venueId = idStr(s.venueId);
  const ticketId = idStr(s.ticketId);
  const showId = showIdForCart(s.showId);
  if (!venueId || !ticketId || showId === undefined || !isNum(s.showTime)) {
    return "Pick a show and ticket type first.";
  }
  if (!isNum(s.latitude) || !isNum(s.longitude)) return "Your location is needed to book tickets.";
  if (!isNum(s.guestCount) || !Number.isInteger(s.guestCount) || s.guestCount < 1 || s.guestCount > 20) {
    return "Choose between 1 and 20 tickets.";
  }
  if (s.showTime <= Math.floor(Date.now() / 1000)) return "This show has already started — pick another one.";
  return {
    venueId,
    showId,
    ticketId,
    showTime: s.showTime,
    guestCount: s.guestCount,
    latitude: s.latitude,
    longitude: s.longitude,
  };
}
