// Runs the History page's mappers on the REAL get_food_orders payload captured
// 2026-10-22 (scripts/fixtures/history-food-orders.json — identical to the
// live call made while building this) and on Instamart get_orders shapes, then
// checks that Reorder turns reorderMeta into Food cart lines whose `selection`
// becomes update_food_cart's legacy `variants: [{group_id, variation_id}]`.
// Run: npx tsx --tsconfig tsconfig.json scripts/verify-history.ts

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  dedupeOrders,
  foodTrackUrl,
  mapFoodHistory,
  mapInstamartHistory,
  rupeeValue,
} from "@/backend/history/history-map";
import { parseFoodOrderDetailsText } from "@/backend/mcp/food-mcp";
import { reorderToFoodLines } from "@/frontend/components/history/reorder";
import { buildHistoryInsights, insightFacts, mealSlot, orderOneLiners, parseOrderTime } from "@/backend/history/insights";
import { acceptPhrase, numbersGrounded, numbersIn } from "@/backend/briefing/ai-phrase";
import { buildBriefing } from "@/backend/briefing/briefing";
import { bookingStatusLine, coordsFromMapUrl, etaMinutes, leaveByMs, orderStatusLine, tripKm } from "@/frontend/utils/travel";

const fixture = JSON.parse(readFileSync(join(__dirname, "fixtures/history-food-orders.json"), "utf8")) as {
  structuredContent: { orders: unknown[] };
};

/* ---------------------------------- food ---------------------------------- */
const food = mapFoodHistory(fixture.structuredContent.orders);
assert.equal(food.length, 5, "5 live food orders");
const [bikk, isha, bismillah] = food;

assert.equal(bikk.orderId, "250940466155091");
assert.equal(bikk.title, "Bikkgane Biryani");
assert.equal(bikk.area, "Tambaram, Kancheepuram");
assert.equal(bikk.total, "₹341");
assert.equal(bikk.totalValue, 341);
assert.equal(bikk.placedAt, "October 14, 3:11 PM");
assert.equal(bikk.status, "Delivered");
assert.equal(bikk.tone, "success");
assert.equal(bikk.active, false);
assert.equal(bikk.itemCount, 1);
assert.match(bikk.imageUrl ?? "", /^https:\/\/media-assets\.swiggy\.com\/swiggy\/image\/upload\/fl_lossy,f_auto,q_auto,w_320\/RX_THUMBNAIL\//);
assert.ok(bikk.reorder, "reorderable");
assert.equal(bikk.reorder.restaurantId, "1058795");
assert.deepEqual(bikk.reorder.items[0], {
  itemId: "167173390",
  name: "Special Chicken Hyderabadi Boneless Biryani",
  quantity: 1,
  veg: false,
  unitPrice: 419,
  variants: [{ groupId: "57485311", variationId: "178376719", name: "Serves 2 - 1000ml" }],
  addons: [],
});

assert.equal(isha.itemCount, 3);
assert.equal(isha.reorder?.items.length, 3);
assert.deepEqual(isha.reorder?.items.map((i) => i.variants.length), [0, 0, 0]);

assert.equal(bismillah.status, "Cancelled");
assert.equal(bismillah.tone, "cancelled");
// bare image id (no path) → CDN URL
assert.match(bismillah.imageUrl ?? "", /\/u7dynyeabdgn5rujasvl$/);

const spent = food.filter((o) => o.tone !== "cancelled").reduce((s, o) => s + (o.totalValue ?? 0), 0);
assert.equal(spent, 341 + 36 + 109 + 110, "total spent excludes the cancelled order");

/* --------------------------------- reorder -------------------------------- */
const lines = reorderToFoodLines(bikk.reorder.items, {
  "special chicken hyderabadi boneless biryani": "https://media-assets.swiggy.com/x.jpg",
});
assert.deepEqual(lines[0], {
  menuItemId: "167173390",
  name: "Special Chicken Hyderabadi Boneless Biryani",
  imageUrl: "https://media-assets.swiggy.com/x.jpg",
  quantity: 1,
  veg: false,
  price: 419,
  selection: {
    format: "variations",
    variants: [{ groupId: "57485311", variationId: "178376719", name: "Serves 2 - 1000ml" }],
    addons: [],
  },
  detail: "Serves 2 - 1000ml",
});
// What food-mcp.ts toCartItem() sends for that selection (mirrored here — it isn't exported):
const sel = lines[0].selection!;
const cartItem = {
  menu_item_id: lines[0].menuItemId,
  quantity: lines[0].quantity,
  [sel.format === "variantsV2" ? "variantsV2" : "variants"]: sel.variants.map((v) => ({ group_id: v.groupId, variation_id: v.variationId })),
};
assert.deepEqual(cartItem, {
  menu_item_id: "167173390",
  quantity: 1,
  variants: [{ group_id: "57485311", variation_id: "178376719" }],
});
const plain = reorderToFoodLines(isha.reorder!.items);
assert.equal(plain[0].selection, undefined, "no-variant dishes carry no selection");
assert.equal(plain[2].price, 145);

/* ------------------------ order details (item photos) ---------------------- */
const details = parseFoodOrderDetailsText(
  [
    "Order 244800472180064 — Isha Fast Food (Viralimalai)",
    "Delivered | regular",
    "Placed: 2026-08-04 13:37:52",
    "Items (3):",
    "  - Chicken noodles — ₹110 | Non-veg [image: https://media-assets.swiggy.com/swiggy/image/upload/abc123]",
    "  - Chicken fried rice — ₹115 | Non-veg",
    "Delivery address: Viralimalai",
    "Total paid: ₹36",
    "Payment: Bank",
  ].join("\n"),
  "244800472180064",
);
assert.match(details.items[0].imageUrl ?? "", /w_160\/abc123$/, "dish photo from the [image: …] tag");
assert.equal(details.total, "₹36");

/* -------------------------------- instamart -------------------------------- */
assert.deepEqual(mapInstamartHistory([]), [], "live today: 0 orders → empty state");
const im = mapInstamartHistory(
  dedupeOrders([
    [
      {
        orderId: 9001,
        storeName: "Instamart",
        status: "DELIVERED",
        orderTotal: 266,
        orderTime: "Oct 20, 9:10 PM",
        items: [{ name: "Godrej Yummiez Cheese Corn Nuggets", quantity: 1, imageUrl: "https://media-assets.swiggy.com/swiggy/image/upload/NI_CATALOG/x.png" }],
      },
      { orderId: "9002", isActive: true, statusMessage: "Out for delivery", totalAmount: "₹120", items: [{ itemName: "Milk", quantity: 2 }] },
    ],
    [{ orderId: "9001", status: "DELIVERED" }],
  ]),
);
assert.equal(im.length, 2, "DASH + INSTAMART lists de-duplicated");
assert.equal(im[0].total, "₹266");
assert.equal(im[0].tone, "success");
assert.match(im[0].imageUrl ?? "", /w_320\/NI_CATALOG\/x\.png$/);
assert.equal(im[1].active, true);
assert.equal(im[1].tone, "active");
assert.equal(im[1].items, "Milk (2)");
assert.equal(im[1].itemCount, 2);

/* --------------------------------- misc ------------------------------------ */
assert.equal(rupeeValue("₹1,234.50"), 1234.5);
assert.equal(rupeeValue(undefined), null);
assert.equal(foodTrackUrl({ orders: [] }, "250940466155091"), "https://www.swiggy.com/track-order/250940466155091");
assert.equal(
  foodTrackUrl({ orders: [{ orderId: "1", trackUrl: "https://www.swiggy.com/track-order/1?x" }] }, "1"),
  "https://www.swiggy.com/track-order/1?x",
);

/* ------------------------------ AI insights -------------------------------- */
// "now" fixed just after the fixture's newest order (Oct 14 2026), so the year inference is stable.
const NOW = Date.UTC(2026, 9, 22, 8, 0); // 22 Oct 13:30 IST
const ot = parseOrderTime("October 14, 3:11 PM", NOW);
assert.ok(ot, "parses Swiggy's order time");
assert.equal(ot.hour, 15);
assert.equal(ot.label, "Oct 14");
assert.equal(parseOrderTime("December 30, 9:00 PM", NOW)?.ms, Date.UTC(2025, 11, 30, 15, 30), "no year + future date → last year");
assert.equal(parseOrderTime("not a date", NOW), null);
assert.equal(mealSlot(8), "breakfast");
assert.equal(mealSlot(13), "lunch");
assert.equal(mealSlot(20), "dinner");
assert.equal(mealSlot(1), "late-night");

const ins = buildHistoryInsights(food, im, [
  { kind: "dineout", title: "Table at Toit", status: "CONFIRMED" },
  { kind: "scenes", title: "Comedy", status: "PROCESSING" },
], NOW);
assert.equal(ins.spent, spent + 266 + 120, "spend = non-cancelled food + instamart (same figure the page shows)");
assert.equal(ins.cancelled, 1);
assert.equal(ins.topRestaurants[0].name, "Punjabi Dhaba");
assert.equal(ins.topRestaurants[0].count, 2);
assert.equal(ins.topDishes[0].name, "Chicken rice");
assert.equal(ins.topDishes[0].count, 2);
assert.equal(ins.active.length, 1, "the active Instamart order");
assert.deepEqual(ins.bookings, { total: 2, confirmed: 1, pending: 1, cancelled: 0 });
assert.deepEqual(ins.actions.map((a) => a.kind), ["track", "reorder", "refill", "bookings"]);
const reorderAct = ins.actions.find((a) => a.kind === "reorder");
assert.equal(reorderAct?.label, "Reorder your usual from Punjabi Dhaba");
assert.ok(reorderAct && reorderAct.kind === "reorder" && food.find((o) => o.orderId === reorderAct.orderId)?.reorder, "reorder action → a reorderable order");
assert.ok(!ins.topRestaurants.some((r) => r.name === "Bismillah Hyderabad Dum Biryani"), "cancelled orders don't count as favourites");
const facts = insightFacts(ins);
assert.ok(facts.some((f) => f.includes(`₹${ins.spent.toLocaleString("en-IN")}`)), "facts carry the real spend");
assert.ok(ins.headline.includes("Punjabi Dhaba is your go-to (2 orders)"), ins.headline);

const oneLiners = orderOneLiners(food, NOW);
assert.match(oneLiners.get(food[4].orderId) ?? "", /^Your first order from Punjabi Dhaba here( · a [a-z -]+ order)?\.$/);
assert.match(oneLiners.get(food[3].orderId) ?? "", /^Your 2nd order from Punjabi Dhaba — same as last time/);
assert.equal(oneLiners.get(bismillah.orderId), "Cancelled — not counted in your spend.");
assert.match(oneLiners.get(bikk.orderId) ?? "", /^Your only order from Bikkgane Biryani in this list · a lunch order\.$/);

/* ----------------------- AI phrasing guard (no invented numbers) ----------- */
const gf = ["Spent ₹596 on 4 orders since Sep 30", "Usually orders at lunch time (2 of 4 orders)"];
assert.ok(numbersGrounded("You've spent ₹596 across 4 orders since Sep 30.", gf));
assert.ok(!numbersGrounded("You've spent ₹600 across 4 orders.", gf), "a changed number is rejected");
assert.equal(acceptPhrase("**You spent ₹596** on 4 orders.", gf, 200), "You spent ₹596 on 4 orders.");
assert.equal(acceptPhrase("- You spent ₹596", gf, 200), null, "lists rejected");
assert.equal(acceptPhrase("You spent ₹596 on 5 orders.", gf, 200), null);
assert.deepEqual(numbersIn("₹1,234 at 7:35"), ["1234", "7", "35"]);

/* ---------------------------- home briefing -------------------------------- */
const fb = buildBriefing({ service: "food", nowMs: NOW, food });
assert.equal(fb.chips.length, 3);
assert.equal(fb.slot, "lunch");
assert.equal(fb.greeting, "Good afternoon");
assert.ok(fb.chips.some((c) => c.label === "Reorder Chicken rice from Punjabi Dhaba"), JSON.stringify(fb.chips));
assert.ok(fb.chips.some((c) => c.label === "Quick lunch near me"), "meal-time chip");
assert.ok(fb.headline.startsWith("Punjabi Dhaba is your go-to — 2 of your last 5 orders"), fb.headline);
assert.ok(fb.hasData);
const ib = buildBriefing({ service: "instamart", nowMs: NOW, instamart: im });
assert.ok(ib.lines.some((l) => /Instamart order/.test(l)), "active Instamart order line");
assert.equal(ib.chips[0].label, "Track my Instamart order");
assert.equal(ib.chips.length, 3);
const db = buildBriefing({
  service: "dineout",
  nowMs: NOW,
  food,
  bookings: [{ kind: "dineout", orderId: "1", title: "Table at Toit", status: "CONFIRMED", details: "2026-10-25 · 8:00 PM · 2 guests" }],
});
assert.equal(db.chips[0].label, "Is my table confirmed?");
assert.ok(db.lines[0].includes("Table at Toit — confirmed (2026-10-25 · 8:00 PM · 2 guests)"), db.lines[0]);
const pb = buildBriefing({ service: "plan", nowMs: NOW, food, instamart: [] });
assert.equal(pb.chips.length, 3);
assert.ok(pb.chips[0].label.startsWith("Plan this evening"), "before 4 PM → this evening");
const empty = buildBriefing({ service: "scenes", nowMs: NOW, bookings: [] });
assert.equal(empty.hasData, false, "no data → static welcome stays");
assert.equal(empty.chips.length, 3);
for (const b of [fb, ib, db, pb]) assert.ok(acceptPhrase(b.facts.join(" "), b.facts, 2000) !== null, "facts are self-grounded");

/* ------------------------- booking / order status lines -------------------- */
const mapUrl = "https://www.google.com/maps/dir/?api=1&origin=12.9352,77.6245&destination=12.9365184,77.61503979999999&travelmode=driving";
const c = coordsFromMapUrl(mapUrl);
assert.deepEqual(c.origin, { lat: 12.9352, lng: 77.6245 });
const km = tripKm({ mapUrl });
assert.ok(km !== null && km > 1 && km < 1.6, `~1.4 km road estimate, got ${km}`);
assert.equal(tripKm({ venue: { lat: 12.97, lng: 77.59 } }), null, "no origin → no distance (never guessed)");
const start = Date.UTC(2026, 9, 22, 14, 30); // 8:00 PM IST
const statusLine = bookingStatusLine({ kind: "dineout", status: "CONFIRMED", place: "Toit", title: "Table at Toit", startsAt: start, km: 4.2 }, NOW);
assert.equal(statusLine, "Your table at Toit is confirmed for 8:00 PM today — leave by ~7:35 PM for the ~4.2 km drive (est.).");
assert.equal(leaveByMs(start, 4.2), start - 25 * 60_000, "4.2 km @ 20 km/h = 12.6 min + 10 min park → rounded down to 7:35");
assert.match(bookingStatusLine({ kind: "scenes", status: "PROCESSING", title: "Comedy", startsAt: start, km: null }, NOW), /^Your tickets are still being confirmed by Swiggy \(for 8:00 PM today\)\.$/);
assert.match(bookingStatusLine({ kind: "dineout", status: "CANCELLED", place: "Toit", title: "Table at Toit", km: 2 }, NOW), /was cancelled by Swiggy/);
assert.equal(etaMinutes("12 mins"), 12);
assert.equal(etaMinutes("25-30 min"), 30);
assert.equal(etaMinutes("soon"), null);
assert.equal(orderStatusLine({ status: "Out for delivery", eta: "12 mins", partner: "Ravi is on the way" }, NOW), "Out for delivery — Swiggy expects it in 12 mins (around 1:42 PM). Ravi is on the way.");
assert.equal(orderStatusLine({ status: "Delivered" }, NOW), "Delivered — enjoy! Rate it in the Swiggy app.");

console.log("verify-history: OK");
console.log(
  food.map((o) => `  ${o.status.padEnd(9)} ${o.total?.padStart(5)}  ${o.title} — ${o.items}  [reorder ${o.reorder?.items.length ?? 0}]`).join("\n"),
);
console.log(`  total spent (excl. cancelled): ₹${spent}`);
