// Pure-helper tests for the live-availability / standout features:
// ics builder, bill split, best-deal scan, live diff, countdown + date parsing,
// directions URLs, and the Scenes list_event_shows mapper (dates, venue
// coordinates, end time) against the LIVE payload captured 2026-10-22.
// Run: npx tsx --tsconfig tsconfig.json scripts/test-live-features.ts

import assert from "node:assert/strict";
import { buildIcs, icsDate, icsEscape, icsFileName, icsFold, googleCalendarUrl } from "../src/frontend/utils/ics";
import { admitsPerTicket, dineoutSplit, parseCostForTwo, scenesSplit } from "../src/frontend/utils/split";
import { bestDeal, slotSummary } from "../src/frontend/utils/bestDeal";
import { describeChanges, diffShows, diffSlots } from "../src/frontend/utils/liveDiff";
import { formatAgo, formatCountdown, istToEpoch, parseBookingWhen, parseClock, parseDate } from "../src/frontend/utils/time";
import { directionsUrl } from "../src/frontend/utils/maps";
import { mapShowListing } from "../src/backend/mcp/scenes-mcp";
import type { DineoutSlot, ScenesShow } from "../src/shared/types";

let passed = 0;
function test(name: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    console.error(`  ✗ ${name}`);
    throw err;
  }
}

/* ---------------------------------- ics ---------------------------------- */
console.log("ics");
test("icsDate is UTC basic format", () => assert.equal(icsDate(Date.UTC(2026, 9, 23, 16, 30)), "20261023T163000Z"));
test("icsEscape escapes , ; \\ and newlines", () => assert.equal(icsEscape("a,b;c\\d\ne"), "a\\,b\\;c\\\\d\\ne"));
test("icsFold folds > 75 octets with CRLF + space", () => {
  const folded = icsFold("DESCRIPTION:" + "x".repeat(200));
  for (const line of folded.split("\r\n")) assert.ok(new TextEncoder().encode(line).length <= 75);
  assert.equal(folded.replace(/\r\n /g, ""), "DESCRIPTION:" + "x".repeat(200));
});
test("buildIcs has one VEVENT with start/end/location/alarm", () => {
  const start = istToEpoch(2026, 10, 23, 22, 0);
  const ics = buildIcs(
    { uid: "scenes-123", title: "Standup Comedy, HSR", start, end: start + 90 * 60_000, location: "Bloom Creative Zone - HSR" },
    Date.UTC(2026, 9, 22),
  );
  assert.match(ics, /^BEGIN:VCALENDAR\r\n/);
  assert.match(ics, /DTSTART:20261023T163000Z\r\n/);
  assert.match(ics, /DTEND:20261023T180000Z\r\n/);
  assert.match(ics, /SUMMARY:Standup Comedy\\, HSR\r\n/);
  assert.match(ics, /UID:scenes-123@swizzo/);
  assert.match(ics, /TRIGGER:-PT60M/);
  assert.equal((ics.match(/BEGIN:VEVENT/g) ?? []).length, 1);
  assert.ok(ics.endsWith("END:VCALENDAR\r\n"));
});
test("buildIcs defaults the duration when end is missing", () => {
  const ics = buildIcs({ uid: "x", title: "t", start: Date.UTC(2026, 0, 1, 10), durationMin: 120 }, 0);
  assert.match(ics, /DTEND:20260101T120000Z/);
});
test("icsFileName slugs the title", () => assert.equal(icsFileName("Table at Toit!"), "table-at-toit.ics"));
test("googleCalendarUrl carries dates", () =>
  assert.match(googleCalendarUrl({ uid: "u", title: "T", start: Date.UTC(2026, 0, 1, 10) }), /dates=20260101T100000Z%2F20260101T120000Z/));

/* --------------------------------- split --------------------------------- */
console.log("split");
test("parseCostForTwo", () => {
  assert.equal(parseCostForTwo("₹1000 for two"), 1000);
  assert.equal(parseCostForTwo("₹1,800 for two"), 1800);
  assert.equal(parseCostForTwo(undefined), undefined);
  assert.equal(parseCostForTwo("for two"), undefined);
});
test("dineoutSplit: 4 guests, 15% off, ₹25 fee, 2 payers", () => {
  const s = dineoutSplit({ costForTwo: 1000, guests: 4, payers: 2, discountPct: 15, bookingFee: 25 });
  assert.equal(s.total, 2000);
  assert.equal(s.totalAfterDiscount, 1700);
  assert.equal(s.perPayer, Math.round((1700 + 25) / 2));
  assert.equal(s.perPersonAfterDiscount, 425);
});
test("dineoutSplit clamps payers to guests", () => assert.equal(dineoutSplit({ costForTwo: 1000, guests: 2, payers: 9 }).payers, 2));
test("admitsPerTicket reads Swiggy tier names", () => {
  assert.equal(admitsPerTicket("Entry Pass For One"), 1);
  assert.equal(admitsPerTicket("Entry Pass For Two"), 2);
  assert.equal(admitsPerTicket("Couple Pass"), 2);
  assert.equal(admitsPerTicket("Stag"), 1);
  assert.equal(admitsPerTicket("Table for 4"), 4);
});
test("scenesSplit: 2 × ₹349 couple passes = 4 people", () => {
  const s = scenesSplit({ price: 349, tickets: 2, admits: 2 });
  assert.deepEqual(s, { tickets: 2, people: 4, total: 698, perPerson: 175 });
});

/* ------------------------------- best deal ------------------------------- */
console.log("best deal");
const NOW = istToEpoch(2026, 10, 22, 12, 0);
const t = (d: number, h: number, m = 0) => Math.round(istToEpoch(2026, 10, d, h, m) / 1000);
const slot = (d: number, h: number, group: string, deals: Partial<DineoutSlot["deals"][number]>[], extra: Partial<DineoutSlot> = {}): DineoutSlot => {
  const reservationTime = t(d, h);
  const dateStr = `2026-10-${String(d).padStart(2, "0")}`;
  return {
    key: `${dateStr}|${reservationTime}`,
    slotId: 1,
    dateStr,
    displayTime: `${h}:00`,
    reservationTime,
    slotGroupName: group,
    deals: deals.map((x, i) => ({ itemId: `r-${d}${h}${i}`, ticketId: `${i}`, slotId: 1, isFree: true, ...x })),
    ...extra,
  };
};
const SLOTS: DineoutSlot[] = [
  slot(22, 11, "Breakfast", [{ isFree: false, bookingPrice: 25, discountPercentage: 15 }]), // past (11:00 < noon)
  slot(22, 19, "Dinner", [{ isFree: true }, { isFree: false, bookingPrice: 25, discountPercentage: 15 }]),
  slot(22, 20, "Dinner", [{ isFree: false, bookingPrice: 50, discountPercentage: 25 }]),
  slot(22, 21, "Dinner", [{ isFree: false, bookingPrice: 0, discountPercentage: 25, soldOut: true }]),
  slot(23, 20, "Dinner", [{ isFree: true, discountPercentage: 30 }]),
  slot(23, 13, "Lunch", [{ isFree: true }], { availableInventory: 0 }),
];
test("tonight's best = 25% off (today, dinner, not sold out)", () => {
  const b = bestDeal(SLOTS, { scope: "tonight", nowMs: NOW });
  assert.ok(b);
  assert.equal(b.slot.displayTime, "20:00");
  assert.equal(b.discountPct, 25);
  assert.match(b.reason, /25% off the bill · ₹50 booking fee/);
});
test("week's best = 30% off, free, tomorrow", () => {
  const b = bestDeal(SLOTS, { scope: "week", nowMs: NOW });
  assert.ok(b);
  assert.equal(b.slot.dateStr, "2026-10-23");
  assert.equal(b.fee, 0);
});
test("tie on % prefers the free deal", () => {
  const b = bestDeal(
    [slot(22, 19, "Dinner", [{ isFree: false, bookingPrice: 25, discountPercentage: 10 }, { isFree: true, discountPercentage: 10 }])],
    { nowMs: NOW },
  );
  assert.equal(b?.fee, 0);
});
test("no open slots → null", () => assert.equal(bestDeal([SLOTS[0]], { nowMs: NOW }), null));
test("slotSummary counts open / free / paid / sold out per date", () => {
  const sum = slotSummary(SLOTS, NOW);
  const today = sum.get("2026-10-22");
  assert.ok(today);
  assert.equal(today.total, 4);
  assert.equal(today.open, 2); // 19:00, 20:00 (11:00 past, 21:00 sold out)
  assert.equal(today.soldOut, 1);
  assert.equal(today.free, 1);
  assert.equal(today.paid, 2);
  assert.equal(today.maxDiscount, 25);
  assert.deepEqual(today.groups.find((g) => g.name === "Dinner"), { name: "Dinner", open: 2, total: 3 });
  assert.equal(sum.get("2026-10-23")?.open, 1);
});

/* ------------------------------- live diff ------------------------------- */
console.log("live diff");
const show = (id: string, seats: number | undefined, onSale: boolean, tickets: [string, number | undefined, boolean][]): ScenesShow => ({
  showId: id,
  showTimeIst: "",
  showTimeUnix: 1,
  availableSeats: seats,
  onSale,
  tickets: tickets.map(([ticketId, availableInventory, on]) => ({ ticketId, title: ticketId, availableInventory, onSale: on })),
});
test("diffShows: seats down, tier sold out, new show", () => {
  const prev = [show("a", 12, true, [["t1", 7, true], ["t2", 5, true]])];
  const next = [show("a", 9, true, [["t1", 4, true], ["t2", 0, false]]), show("b", 10, true, [])];
  const d = diffShows(prev, next);
  assert.equal(d.get("show:a"), "down");
  assert.equal(d.get("ticket:a:t1"), "down");
  assert.equal(d.get("ticket:a:t2"), "soldout");
  assert.equal(d.get("show:b"), "new");
  assert.equal(describeChanges(d), "2 selling · 1 sold out · 1 freed up");
});
test("diffShows: identical → empty", () => {
  const s = [show("a", 12, true, [["t1", 7, true]])];
  assert.equal(diffShows(s, s).size, 0);
});
test("diffSlots: open → full", () => {
  const a = slot(22, 19, "Dinner", [{ isFree: true }]);
  const b = { ...a, deals: [{ ...a.deals[0], soldOut: true }] };
  const open = (s: DineoutSlot) => s.deals.some((d) => !d.soldOut);
  assert.equal(diffSlots([a], [b], open).get(a.key), "soldout");
  assert.equal(diffSlots([b], [a], open).get(a.key), "reopened");
});

/* ---------------------------------- time --------------------------------- */
console.log("time");
test("formatCountdown", () => {
  const now = Date.UTC(2026, 0, 1, 10);
  assert.equal(formatCountdown(now + (2 * 60 + 15) * 60_000, now), "Starts in 2h 15m");
  assert.equal(formatCountdown(now + 45 * 60_000, now), "Starts in 45m");
  assert.equal(formatCountdown(now + 3 * 86_400_000, now), "Starts in 3 days");
  assert.equal(formatCountdown(now + 26 * 3_600_000, now), "Starts in 1 day 2h");
  assert.equal(formatCountdown(now - 60_000, now), "Starting now");
  assert.equal(formatCountdown(now - 20 * 60_000, now), "Started 20m ago");
  assert.equal(formatCountdown(now - 5 * 3_600_000, now), "");
});
test("formatAgo", () => {
  assert.equal(formatAgo(1000, 3000), "just now");
  assert.equal(formatAgo(0, 12_000), "12s ago");
  assert.equal(formatAgo(0, 180_000), "3m ago");
});
test("parseClock", () => {
  assert.deepEqual(parseClock("7:30 PM"), [19, 30]);
  assert.deepEqual(parseClock("Fri, 23 Oct, 10:00 pm"), [22, 0]);
  assert.deepEqual(parseClock("12:15 AM"), [0, 15]);
  assert.deepEqual(parseClock("19:45"), [19, 45]);
  assert.equal(parseClock("no time"), null);
});
test("parseDate variants", () => {
  const now = istToEpoch(2026, 10, 22, 12);
  assert.deepEqual(parseDate("2026-10-23", now), { y: 2026, m: 10, d: 23 });
  assert.deepEqual(parseDate("Fri, 23 Oct", now), { y: 2026, m: 10, d: 23 });
  assert.deepEqual(parseDate("23rd Oct • 10:00 PM onwards", now), { y: 2026, m: 10, d: 23 });
  assert.deepEqual(parseDate("Oct 5, 2027", now), { y: 2027, m: 10, d: 5 });
  assert.deepEqual(parseDate("5 Jan", now), { y: 2027, m: 1, d: 5 }); // already past this year → next year
  assert.deepEqual(parseDate("Tomorrow", now), { y: 2026, m: 10, d: 23 });
  assert.equal(parseDate("31 Feb 2026", now), null);
});
test("parseBookingWhen from Swiggy display strings", () => {
  const now = istToEpoch(2026, 10, 22, 12);
  assert.equal(parseBookingWhen("2026-10-23 · 07:30 PM · 2 guests · Flat 15% off", now), istToEpoch(2026, 10, 23, 19, 30));
  assert.equal(parseBookingWhen("Bloom, HSR | Fri, 23 Oct · 10:00 pm | 2× Entry Pass", now), istToEpoch(2026, 10, 23, 22, 0));
  assert.equal(parseBookingWhen("2 guests · Flat 15% off", now), undefined);
});

/* ---------------------------------- maps --------------------------------- */
console.log("maps");
test("directionsUrl drops Swiggy's search origin", () => {
  const u = directionsUrl({
    mapUrl: "https://www.google.com/maps/dir/?api=1&origin=12.9716,77.5946&destination=12.975062,77.601932&travelmode=driving",
  });
  assert.ok(!u.includes("origin="));
  assert.ok(u.includes("destination=12.975062%2C77.601932") || u.includes("destination=12.975062,77.601932"));
});
test("directionsUrl: coordinates, then name search, else empty", () => {
  assert.equal(directionsUrl({ lat: 12.9, lng: 77.6 }), "https://www.google.com/maps/dir/?api=1&destination=12.9,77.6");
  assert.match(directionsUrl({ name: "Toit", address: "Indiranagar" }), /search\/\?api=1&query=Toit%2C%20Indiranagar/);
  assert.equal(directionsUrl({}), "");
  assert.equal(directionsUrl({ mapUrl: "javascript:alert(1)" }), "");
});

/* ----------------------- scenes mapper (live payload) --------------------- */
console.log("scenes mapper");
const LIVE = {
  eventShowListing: {
    dateSummary: [
      { date: { year: 2026, month: 10, day: 23 }, totalAvailableInventory: 12, status: "ENTITIES_DISCOVERY_STATE_ON_SALE" },
      { date: { year: 2026, month: 10, day: 30 }, totalAvailableInventory: 0, status: "ENTITIES_DISCOVERY_STATE_SOLD_OUT" },
    ],
    venueDetails: [
      { id: "1233", name: "Bloom Creative Zone - HSR", location: { latLng: { latitude: 12.90682, longitude: 77.648935 } }, address: "HSR Layout", cityDisplayName: "Bangalore", localityDisplayName: "HSR Layout" },
    ],
    dateGroupedEventShow: [
      {
        date: { year: 2026, month: 10, day: 23 },
        eventShow: [
          {
            id: "100496062",
            timeRange: { startTime: "2026-10-23T16:30:00Z", endTime: "2026-10-23T18:00:00Z" },
            maxAvailableInventory: 12,
            tickets: [
              { id: "1223907", name: "Entry Pass For One", availableInventory: 7, price: { price: { units: "199" }, discountedPrice: { units: "199" }, coverCharge: { units: "0" } }, status: "ENTITIES_DISCOVERY_STATE_ON_SALE" },
              { id: "1223908", name: "Entry Pass For Two", availableInventory: 5, price: { price: { units: "349" }, discountedPrice: { units: "349" } }, status: "ENTITIES_DISCOVERY_STATE_ON_SALE" },
            ],
            purchaseRules: { allowedCovers: { min: 1, max: 10 } },
            status: "ENTITIES_DISCOVERY_STATE_ON_SALE",
            show_time_unix: 1792773000,
            show_time_ist: "Fri, 23 Oct, 10:00 pm",
          },
        ],
      },
    ],
    eventInfo: { id: "100109009", name: "Standup Comedy Show Bangalore" },
  },
};
test("mapShowListing: dates, venue coords, endTimeUnix, seats", () => {
  const l = mapShowListing(LIVE, { eventId: "100109009", venueId: "1233", latitude: 12.97, longitude: 77.59 });
  assert.deepEqual(l.dates, [
    { date: "2026-10-23", available: 12, onSale: true },
    { date: "2026-10-30", available: 0, onSale: false },
  ]);
  assert.equal(l.venueLatitude, 12.90682);
  assert.equal(l.venueLongitude, 77.648935);
  assert.equal(l.latitude, 12.97); // the user's coords stay the follow-up coords
  const s = l.shows[0];
  assert.equal(s.availableSeats, 12);
  assert.equal(s.endTimeUnix, Date.UTC(2026, 9, 23, 18) / 1000);
  assert.equal(s.showTimeUnix, 1792773000);
  assert.equal(s.tickets[1].availableInventory, 5);
  assert.equal(admitsPerTicket(s.tickets[1].title), 2);
});

console.log(`\n${passed} passed`);
