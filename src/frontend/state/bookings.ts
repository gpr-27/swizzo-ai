// Bookings made in THIS app (Dineout tables, Scenes tickets), saved per user in
// localStorage. Swiggy's MCP has no "list my bookings" tool — only
// get_booking_status / get_event_booking_status by orderId — so remembering the
// order ids we created is the only way to show "my bookings" later.
// When the server has a database, ./cloudSync.ts mirrors this list to it so
// it follows the account across devices (localStorage stays the offline cache).

import { noteLocalChange } from './syncBus';

export type BookingKind = "dineout" | "scenes";

export interface SavedBooking {
  kind: BookingKind;
  orderId: string;
  title: string;
  details?: string;
  createdAt: number; // epoch ms
  // Dineout: what get_restaurant_details needs to fetch the restaurant's
  // official photo for the History page (saved at booking time).
  restaurantId?: string;
  lat?: number;
  lng?: number;
  // Scenes event id; reservation / show start (epoch ms); guests; amount (₹)
  eventId?: string;
  startsAt?: number;
  party?: number;
  amount?: number;
  // Last live status seen (History page refresh) and when.
  status?: string;
  statusAt?: number;
  /** Last local edit (epoch ms) — the sync merge rule. Defaults to createdAt. */
  updatedAt?: number;
}

const MAX = 50;

function key(userId: string | undefined): string {
  return `swizzo.bookings.v1.${userId || "anon"}`;
}

export function loadBookings(userId: string | undefined): SavedBooking[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(key(userId));
    const list = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(list)
      ? list.filter(
          (b): b is SavedBooking =>
            !!b &&
            typeof b === "object" &&
            ((b as SavedBooking).kind === "dineout" || (b as SavedBooking).kind === "scenes") &&
            typeof (b as SavedBooking).orderId === "string" &&
            (b as SavedBooking).orderId.length > 0,
        )
      : [];
  } catch {
    return [];
  }
}

function writeBookings(userId: string | undefined, list: SavedBooking[]): void {
  try {
    window.localStorage.setItem(key(userId), JSON.stringify(list.slice(0, MAX)));
  } catch {
    // storage full / blocked — the booking itself is still on Swiggy
  }
}

/** Add or update (by kind + orderId) a booking; newest first. */
export function saveBooking(userId: string | undefined, booking: SavedBooking): void {
  if (typeof window === "undefined" || !booking.orderId) return;
  const rest = loadBookings(userId).filter(
    (b) => !(b.kind === booking.kind && b.orderId === booking.orderId),
  );
  writeBookings(userId, [{ ...booking, updatedAt: booking.updatedAt ?? Date.now() }, ...rest]);
  noteLocalChange({ entity: "bookings" });
}

/** Replace the whole list (cloud sync applying the merged server copy). */
export function replaceBookings(userId: string | undefined, list: SavedBooking[]): void {
  if (typeof window === "undefined") return;
  writeBookings(userId, [...list].sort((a, b) => b.createdAt - a.createdAt));
}

/** Remember the live statuses the History page just read (only real changes are written). */
export function updateBookingStatuses(
  userId: string | undefined,
  rows: { kind: string; orderId: string; status?: string }[],
): void {
  if (typeof window === "undefined" || !rows.length) return;
  const now = Date.now();
  let changed = false;
  const byKey = new Map(rows.filter((r) => r.status).map((r) => [`${r.kind}:${r.orderId}`, r.status as string]));
  const next = loadBookings(userId).map((b) => {
    const status = byKey.get(`${b.kind}:${b.orderId}`);
    if (!status || status === b.status) return b;
    changed = true;
    return { ...b, status, statusAt: now, updatedAt: now };
  });
  if (!changed) return;
  writeBookings(userId, next);
  noteLocalChange({ entity: "bookings" });
}
