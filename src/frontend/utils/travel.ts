// AI status lines for live booking / order cards, built ONLY from real data:
// the booking time and status Swiggy returned, the venue coordinates (Swiggy's
// own locationMapUrl carries origin=<user's search point>&destination=<venue>,
// else the venue lat/lng + the selected delivery address), and the ETA text
// Swiggy's tracker sent. The one derived figure is the "leave by" time, which
// is labelled an estimate: straight-line km × 1.3 road factor at an average
// city speed of 20 km/h, plus 10 min to park. Pure functions.

export interface LatLng {
  lat: number;
  lng: number;
}

const ok = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n !== 0;

/** Great-circle distance in km. */
export function haversineKm(a: LatLng, b: LatLng): number {
  const R = 6371;
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

function pair(v: string | null): LatLng | null {
  const m = v?.match(/^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/);
  if (!m) return null;
  const p = { lat: Number(m[1]), lng: Number(m[2]) };
  return ok(p.lat) && ok(p.lng) ? p : null;
}

/** origin / destination coordinates from a Google Maps directions URL (Swiggy's locationMapUrl). */
export function coordsFromMapUrl(url: string | undefined): { origin: LatLng | null; destination: LatLng | null } {
  if (!url) return { origin: null, destination: null };
  try {
    const u = new URL(url);
    return { origin: pair(u.searchParams.get('origin')), destination: pair(u.searchParams.get('destination')) };
  } catch {
    return { origin: null, destination: null };
  }
}

export const ROAD_FACTOR = 1.3;
export const CITY_KMPH = 20;
export const PARK_MIN = 10;

/** Road-distance estimate (km, 1 decimal) between the user and the venue, or null without real coordinates. */
export function tripKm(opts: { mapUrl?: string; venue?: Partial<LatLng>; origin?: Partial<LatLng> | null }): number | null {
  const fromUrl = coordsFromMapUrl(opts.mapUrl);
  const dest = fromUrl.destination ?? (ok(opts.venue?.lat) && ok(opts.venue?.lng) ? (opts.venue as LatLng) : null);
  const from =
    (ok(opts.origin?.lat) && ok(opts.origin?.lng) ? (opts.origin as LatLng) : null) ?? fromUrl.origin;
  if (!dest || !from) return null;
  const km = haversineKm(from, dest) * ROAD_FACTOR;
  // > 60 km is not a drive to dinner — the coordinates don't describe a trip.
  return km > 60 ? null : Math.round(km * 10) / 10;
}

const clock = (ms: number) =>
  new Date(ms).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: 'numeric', minute: '2-digit' }).replace(/\s?([ap])m$/i, (_m, x: string) => ` ${x.toUpperCase()}M`);
const dayWord = (ms: number, nowMs: number) => {
  const d = (t: number) => new Date(t + 330 * 60_000).toISOString().slice(0, 10);
  if (d(ms) === d(nowMs)) return 'today';
  if (d(ms) === d(nowMs + 86_400_000)) return 'tomorrow';
  return new Date(ms).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', weekday: 'short', day: 'numeric', month: 'short' });
};

/** "leave by" (epoch ms) for a trip of `km` to be there at `startsAt`. */
export function leaveByMs(startsAt: number, km: number): number {
  const minutes = (km / CITY_KMPH) * 60 + PARK_MIN;
  // round down to the 5 minutes before
  const raw = startsAt - minutes * 60_000;
  return Math.floor(raw / 300_000) * 300_000;
}

export interface BookingLineInput {
  kind: 'dineout' | 'scenes';
  status: string;
  place?: string;
  title: string;
  startsAt?: number;
  km: number | null;
}

/**
 * "Your table at Toit is confirmed for 8:00 PM today — leave by ~7:30 PM for the ~4.2 km drive (est.)."
 * Empty for final / past bookings or when there is nothing real to say.
 */
export function bookingStatusLine(b: BookingLineInput, nowMs: number = Date.now()): string {
  const s = b.status.toLowerCase();
  const what = b.kind === 'dineout' ? `Your table at ${b.place || b.title.replace(/^Table at\s+/i, '')}` : `Your tickets${b.place ? ` at ${b.place}` : ''}`;
  if (/cancel|fail|reject|refund|expired/.test(s)) return `${what} ${b.kind === 'dineout' ? 'was' : 'were'} ${s.replace(/_/g, ' ')} by Swiggy.`;
  const when = b.startsAt ? `${clock(b.startsAt)} ${dayWord(b.startsAt, nowMs)}` : '';
  const verb = b.kind === 'dineout' ? 'is' : 'are';
  let state: string;
  if (/confirm|success|booked|completed|placed|paid/.test(s)) state = `${verb} confirmed${when ? ` for ${when}` : ''}`;
  else if (/pending|processing|initiated|awaiting/.test(s)) state = `${verb} still being confirmed by Swiggy${when ? ` (for ${when})` : ''}`;
  else state = `${verb} ${s.replace(/_/g, ' ')}${when ? ` (${when})` : ''}`;
  if (b.startsAt && b.startsAt < nowMs - 30 * 60_000) return `${what} ${state}.`;
  let trip = '';
  if (b.startsAt && b.km !== null && b.startsAt > nowMs) {
    const leave = leaveByMs(b.startsAt, b.km);
    trip =
      leave <= nowMs
        ? ` — head out now for the ~${b.km} km drive (est.)`
        : ` — leave by ~${clock(leave)} for the ~${b.km} km drive (est.)`;
  } else if (b.km !== null) {
    trip = ` — about ${b.km} km away`;
  }
  return `${what} ${state}${trip}.`;
}

/** "12 mins" / "25-30 min" / "1 hr" → minutes (upper bound), or null. */
export function etaMinutes(eta: string | undefined): number | null {
  if (!eta) return null;
  const m = eta.match(/(\d+)(?:\s*[-–]\s*(\d+))?\s*(h|hr|hrs|hour|hours|m|min|mins|minutes)\b/i);
  if (!m) return null;
  const n = Number(m[2] ?? m[1]);
  return /^h/i.test(m[3]) ? n * 60 : n;
}

/** "Out for delivery — Swiggy expects it in 12 mins (around 7:42 PM). Ravi is bringing it." */
export function orderStatusLine(t: { status: string; eta?: string; partner?: string }, nowMs: number = Date.now()): string {
  const status = t.status.trim();
  if (!status) return '';
  if (/deliver(ed)?$|completed/i.test(status)) return 'Delivered — enjoy! Rate it in the Swiggy app.';
  if (/cancel|refund|fail/i.test(status)) return `${status} — call Swiggy care at 080-67466729 if this is unexpected.`;
  const mins = etaMinutes(t.eta);
  const eta = t.eta ? ` — Swiggy expects it in ${t.eta}${mins !== null ? ` (around ${clock(nowMs + mins * 60_000)})` : ''}` : '';
  const partner = t.partner ? ` ${t.partner.replace(/\.$/, '')}.` : '';
  return `${status}${eta}.${partner}`;
}
