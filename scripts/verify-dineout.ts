// Verifies the Dineout parsers against REAL Swiggy payloads:
//  - docs/swiggy-mcp/LIVE-SAMPLES.md (raw search text results + raw get_available_slots
//    with `_meta.slots`, + render/details structuredContent)
//  - scripts/fixtures/dineout-live.json (render/details captured live 2026-10-22)
// and the agent's mapping (mapToolResult) of those payloads into card events.
// Run: npx tsx --tsconfig tsconfig.json scripts/verify-dineout.ts

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { mapToolResult } from "@/backend/agent/agent";
import { coerceToolPayload } from "@/backend/mcp/client";
import {
  dineoutErrorResponse,
  DineoutBusyError,
  isRateLimited,
  mapDineoutDetails,
  mapDineoutRender,
  mapDineoutSearch,
  mapDineoutSlots,
  dineoutBookable,
  mergeRenderedCards,
  orderBookableFirst,
  parseDineoutSearchText,
  readSlotsPayload,
  mapDineoutBooking,
} from "@/backend/mcp/dineout-mcp";
import {
  bestDiscount,
  compactCount,
  dineoutCompareVerdict,
  dineoutFacts,
  dineoutFitLine,
  dineoutShortlistNote,
  parseAiRead,
  rankDineoutShortlist,
  readNeeds,
  trustedRating,
} from "@/shared/aiRead";
import type { ChatStreamEvent, DineoutRestaurant } from "@/shared/types";

const ROOT = join(__dirname, "..");
let failures = 0;
let passes = 0;

function check(cond: unknown, label: string): void {
  if (cond) {
    passes++;
    console.log(`  ✓ ${label}`);
  } else {
    failures++;
    console.log(`  ✗ ${label}`);
  }
}

/** The ```json block that follows each "## <heading>" in LIVE-SAMPLES.md. */
function samples(heading: string): string[] {
  const md = readFileSync(join(ROOT, "docs/swiggy-mcp/LIVE-SAMPLES.md"), "utf8");
  const out: string[] = [];
  const parts = md.split(/\n## /);
  for (const part of parts) {
    if (!part.startsWith(heading)) continue;
    const m = /```json\n([\s\S]*?)\n```/.exec(part);
    if (m) out.push(m[1]);
  }
  return out;
}

/** The slots sample is truncated mid-object: keep every complete slot and close the JSON. */
function repairTruncatedSlots(text: string): unknown {
  const cut = text.lastIndexOf("\n   },");
  const head = text.slice(0, cut + "\n   }".length);
  return JSON.parse(`${head}\n  ]\n }\n}`);
}

const ctx = { addressId: "", latitude: 12.9352, longitude: 77.6245 } as unknown as Parameters<typeof mapToolResult>[2];

function eventsOf(events: ChatStreamEvent[], type: string) {
  return events.filter((e) => e.type === type);
}

/* --------------------------------- search --------------------------------- */
console.log("\nsearch_restaurants_dineout (raw text results from LIVE-SAMPLES)");
const searchRaws = samples("search_restaurants_dineout").map((t) => JSON.parse(t) as Record<string, unknown>);
check(searchRaws.length === 2, "found 2 raw search samples");
const [italianRaw, koramangalaRaw] = searchRaws;

// The coerced payload (what the generic path sees) is `{ text }`.
const coerced = coerceToolPayload(italianRaw) as { text?: string };
check(typeof coerced.text === "string" && coerced.text.includes("(ID: 818805)"), "coerceToolPayload yields { text }");

const italian = parseDineoutSearchText(coerced.text ?? "");
check(italian.restaurants.length === 10, `Italian: 10 restaurants (got ${italian.restaurants.length})`);
check(italian.total === 28 && italian.nextOffset === 10, `Italian: total=28 nextOffset=10 (got ${italian.total}/${italian.nextOffset})`);
check(italian.latitude === 12.9352 && italian.longitude === 77.6245, "Italian: search coordinates parsed");
const first = italian.restaurants[0];
check(
  first.id === "818805" && first.name === "Thyme and Whisk" && first.rating === 4.3 && first.costForTwo === "₹1000 for two" && first.area === "Jayanagar",
  `Italian #1 parsed: ${JSON.stringify({ id: first.id, name: first.name, rating: first.rating, cost: first.costForTwo, area: first.area })}`,
);
check(first.cuisines.join("|") === "North Indian|Italian", "Italian #1 cuisines");
const last = italian.restaurants[9];
check(last.id === "1133390" && last.area === "Koramangala" && last.rating === 5, "Italian #10 (trailing spaces in area) parsed");
check(italian.restaurants.every((r) => r.latitude === 12.9352), "every card carries the search latitude");

const kora = mapDineoutSearch(coerceToolPayload(koramangalaRaw));
check(kora.restaurants.length === 10, `Koramangala: 10 restaurants (got ${kora.restaurants.length})`);
const pizzaBakery = kora.restaurants.find((r) => r.id === "728469");
check(pizzaBakery?.cuisines.join("|") === "Desserts", "trailing empty cuisine dropped ('Desserts, ')");
const brau = kora.restaurants.find((r) => r.id === "1075087");
check(brau !== undefined && brau.rating === undefined, "'--★' rating → no rating");
check(parseDineoutSearchText("No restaurants found matching \"zzz\".").restaurants.length === 0, "no-match text → empty");

/* --------------------------------- render --------------------------------- */
console.log("\nrender_restaurants_dineout (LIVE-SAMPLES + live fixture)");
const fixtures = JSON.parse(readFileSync(join(ROOT, "scripts/fixtures/dineout-live.json"), "utf8")) as Record<
  string,
  { structuredContent: unknown }
> & { slots_1032642_structured: Record<string, unknown> };

const renderSample = JSON.parse(samples("render_restaurants_dineout")[0]);
const rendered = mapDineoutRender(renderSample);
check(rendered.restaurants.length === 2, "sample render: 2 cards");
const siNonna = rendered.restaurants[0];
check(siNonna.id === "1032642" && siNonna.rating === 4.8 && siNonna.ratingCount === 1529, "rating {value:'4.8',count:1529} → 4.8 (1529)");
check(!!siNonna.imageUrl && siNonna.imageUrl.startsWith("https://media-assets.swiggy.com/"), `photo URL: ${siNonna.imageUrl?.slice(0, 80)}…`);
check(siNonna.distance === "1.3 km" && siNonna.costForTwo === "₹1000 for two", "distance + cost for two");
check(siNonna.offerHeadline?.title === "Flat 15% off" && siNonna.offerHeadline?.subtitle === "on pre-booking", "offerHeadline");
check(siNonna.offers?.[0] === "Flat 15% off", "offers[].offerTitle");
check(!!siNonna.highlights?.includes("Free wifi"), "highlights");

const liveRender = mapDineoutRender(fixtures.render_koramangala.structuredContent);
check(liveRender.restaurants.length === 4, "live render: 4 cards");
check(liveRender.restaurants.every((r) => !!r.imageUrl), "live render: every card has a photo");
const liveBrau = liveRender.restaurants.find((r) => r.id === "1075087");
check(liveBrau?.rating === undefined && liveBrau?.ratingCount === undefined, "live render: rating '--'/0 → unrated");
check(liveRender.restaurants.find((r) => r.id === "728469")?.cuisines.join("|") === "Desserts", "live render: empty cuisine dropped");
check(!!liveRender.restaurants[0].vendorHighlights?.includes("Free Beer"), "live render: vendorHighlights → perks ('Free Beer')");
check(!liveRender.restaurants[0].highlights?.includes("Free Beer"), "live render: perks kept apart from amenity highlights");
check(liveRender.restaurants.every((r) => !r.vendorHighlights?.includes("Table booking")), "'Table booking' perk is not shown as a perk");
check(liveRender.restaurants[0].offerHeadline?.logoText === "ONE" && liveRender.restaurants[0].offerHeadline?.subtext === "+5 offers", "offerHeadline logoText + subtext");
check(liveRender.restaurants[0].bankOffers?.[0] === "Flat 10% off", "bankOffers[].offerTitle");
check(liveRender.restaurants[0].offerDetails?.[0]?.description === "Available today", "offers[].offerDescription kept");
check(siNonna.bookable === true && siNonna.offerDetails?.[0]?.description === "Total bill", "sample render: bookable via 'Table booking' + offer description");

console.log("\nrender_restaurants_dineout (live 2026-10-22: partial render + payment headline)");
const partialRender = mapDineoutRender(fixtures.render_italian_partial.structuredContent);
check(partialRender.restaurants.length === 2, "partial render: 2 of 3 ids resolved");
check(/1 of 3 requested id could not be resolved/.test(partialRender.renderNote ?? ""), `render note kept: ${partialRender.renderNote}`);
const baci = partialRender.restaurants[0];
check(baci.offerHeadline?.kind === "payment" && !baci.offerHeadline.subtitle && !!baci.offerHeadline.logoUrl, "payment-kind headline with logo, no subtitle");
check(baci.bankOffers === undefined && baci.vendorHighlights === undefined, "empty bankOffers / only 'Table booking' perk → absent");
check(partialRender.restaurants[1].offerHeadline?.logoText === "ONE", "Swiggy One badge text");

console.log("\nbookable vs walk-in (partnerType NPR)");
const npr = mapDineoutRender(fixtures.render_npr_kfc.structuredContent);
const kfc = npr.restaurants.find((r) => r.id === "588619")!;
check(kfc.partnerType === "NPR" && kfc.source === "autosuggest", "render partnerType + source mapped");
check(kfc.bookable === false, "partnerType NPR → bookable false");
check(kfc.cuisines.length === 0 && kfc.costForTwo === undefined && kfc.rating === undefined && kfc.ratingCount === undefined, "NPR empty cuisine/cost/rating → absent");
check(npr.restaurants.find((r) => r.id === "1032642")?.bookable === true, "'Table booking' / 'Reservation available' → bookable true");
check(dineoutBookable("PR", []) === true && dineoutBookable(undefined, ["Free wifi"]) === undefined, "PR → true; no signal → unknown");
check(italian.restaurants.every((r) => r.bookable === undefined), "text-only search cards → bookable unknown");
const ordered = orderBookableFirst(npr.restaurants, "pizza");
check(ordered.map((r) => r.id).join(",") === "1032642,588619", "non-bookable sorted after bookable");
check(orderBookableFirst(npr.restaurants, "KFC")[0].id === "588619", "named restaurant stays first even if walk-in");
const kfcDetails = mapDineoutDetails(fixtures.details_npr_kfc.structuredContent);
check(kfcDetails?.bookable === false && kfcDetails.partnerType === "NPR" && !kfcDetails.dealDetails, "details NPR → bookable false, no deals");

// search order + render merge (the flow searchDineoutRestaurants runs)
const renderIds = ["1373139", "728469", "693811", "1075087"];
const textCards = kora.restaurants.filter((r) => renderIds.includes(r.id)).map((r) => ({ ...r, latitude: 12.9352, longitude: 77.6245 }));
const merged = mergeRenderedCards(textCards, liveRender);
check(merged.map((r) => r.id).join(",") === "1373139,728469,693811,1075087", "merge keeps Swiggy's search order");
check(merged.every((r) => !!r.imageUrl && r.latitude === 12.9352), "merged cards: photos + search coordinates");
const partial = mergeRenderedCards(textCards, { restaurants: liveRender.restaurants.slice(0, 2) });
check(!partial[3].imageUrl && partial[3].name.startsWith("Brau Galie"), "card missing from render falls back to its text line (no photo)");

/* --------------------------------- details -------------------------------- */
console.log("\nget_restaurant_details (LIVE-SAMPLES + live fixture)");
const sampleDetails = mapDineoutDetails(JSON.parse(samples("get_restaurant_details")[0]), 12.9716, 77.5946);
check(sampleDetails?.name === "Kling Brewery" && sampleDetails.rating === 4.6, "sample details: name + avgRating");
check(sampleDetails?.timings === "Open till 12:30AM", "sample details: timings");
check(sampleDetails?.distance === "1.2 km" && !!sampleDetails.address?.startsWith("27,Ground Floor"), "address '1.2 km • …' split into distance + address");
check((sampleDetails?.amenities?.length ?? 0) === 8, "sample details: 8 amenities");
check(sampleDetails?.deals?.[0] === "Flat 20% off on Total Bill — Available on Mon-Sun", "sample details: deals");
const kd = sampleDetails?.dealDetails?.[0];
check(
  kd?.discountPercentage === 20 && kd.coverCharge === 0 && kd.slotGroupName === "Pre-booking offers" && kd.offerCategory === "prebooking",
  "sample details: deal discountPercentage / coverCharge / slotGroupName / offerCategory",
);
check(sampleDetails?.partnerType === "PR" && sampleDetails.bookable === true, "sample details: partnerType PR → bookable");
check(!sampleDetails?.offerDetails, "sample details: offers[] identical to deals → not repeated");
check(sampleDetails?.menuImageGroups?.[0]?.title === "Bar • 3 pages", "sample details: menu image groups");
check(!!sampleDetails?.locationMapUrl?.startsWith("https://www.google.com/maps"), "sample details: map link");

const liveDetails = mapDineoutDetails(fixtures.details_1032642.structuredContent, 12.9352, 77.6245) as DineoutRestaurant;
check(liveDetails?.id === "1032642" && liveDetails.hasDetails === true, "live details: id + hasDetails");
check((liveDetails?.mastheadImageUrls?.length ?? 0) === 3, "live details: masthead photos");
check(liveDetails?.menuImageGroups?.length === 2, "live details: 2 menu groups");
check(liveDetails?.offers?.length === 0, "live details: offers identical to deals de-duplicated");
// fetchDineoutToolPayload hands the agent `{ restaurant }` (already normalized) — idempotent:
check(mapDineoutDetails({ restaurant: liveDetails })?.rating === 4.8, "normalized details pass through unchanged");

/* ---------------------------------- slots --------------------------------- */
console.log("\nget_available_slots (raw `_meta.slots` from LIVE-SAMPLES)");
const slotsRaw = repairTruncatedSlots(samples("get_available_slots")[0]) as Record<string, unknown>;
const slotsRawWithStructured = { ...slotsRaw, structuredContent: fixtures.slots_1032642_structured };
const coercedSlots = coerceToolPayload(slotsRawWithStructured) as Record<string, unknown>;
check(!Array.isArray(coercedSlots.slots), "coerceToolPayload alone loses the slots (they live in _meta)");
const view = mapDineoutSlots(readSlotsPayload(slotsRawWithStructured), {
  restaurantId: "1032642",
  restaurantName: "Si Nonna's",
  date: "2026-10-23",
  latitude: 12.9352,
  longitude: 77.6245,
});
const slotCount = ((slotsRaw._meta as { slots: unknown[] }).slots ?? []).length;
check(!!view && view.slots.length === slotCount && slotCount > 20, `all ${slotCount} slots parsed (got ${view?.slots.length})`);
const s0 = view!.slots[0];
check(s0.reservationTime === 1792733400 && typeof s0.reservationTime === "number", "reservationTime string → number (unix s)");
check(s0.displayTime === "11:00 AM" && s0.slotGroupName === "Breakfast" && s0.dateStr === "2026-10-23", "displayTime / group / dateStr");
check(s0.slotId === 1 && s0.subText === "15% off", "slotId from deals[0], subText");
check(s0.daySubtext === "15% off", "daySubtext");
check(s0.deals[0].dealCategory === "GIRF" && s0.deals[0].title === "Flat 15% off on Total Bill" && s0.deals[0].isFree === false, "deal dealCategory / title / isFree");
check(s0.availableInventory === undefined, "no inventory field → undefined (bookable), not 0");
check(new Set(view!.slots.map((s) => s.key)).size === view!.slots.length, "slot keys unique (slotId is not)");
const lunch = view!.slots.find((s) => s.displayTime === "12:00 PM")!;
const free = lunch.deals.find((d) => d.isFree);
const paid = lunch.deals.find((d) => !d.isFree);
check(free?.itemId === "1032642-58545" && free.bookingPrice === 0 && free.ticketId === "58545", "free deal: itemId, ₹0, ticketId from itemId");
check(paid?.itemId === "1032642-1145157" && paid.bookingPrice === 25 && paid.discountPercentage === 15, "paid deal: ₹25 booking fee, 15% off");
// (the captured sample is truncated in the afternoon, so Dinner may be cut off)
check(new Set(view!.slots.map((s) => s.slotGroupName)).size >= 2, "meal groups (Breakfast / Lunch …) present");

/* ------------------------------ agent mapping ------------------------------ */
console.log("\nagent mapToolResult");
const searchEvents = mapToolResult(
  { bareTool: "search_restaurants_dineout", query: "Koramangala", input: { query: "Koramangala" } },
  { ...kora, restaurants: merged, source: "render" },
  ctx,
);
const cards = eventsOf(searchEvents, "dineoutRestaurants") as Extract<ChatStreamEvent, { type: "dineoutRestaurants" }>[];
check(cards.length === 1 && cards[0].restaurants.length === 4 && !!cards[0].restaurants[0].imageUrl, "search → one photo-card event");
check(
  cards[0].paging?.query === "Koramangala" && cards[0].paging.total === 28 && cards[0].paging.nextOffset === 10 && cards[0].paging.latitude === 12.9352,
  `search event carries paging for "Load more": ${JSON.stringify(cards[0].paging)}`,
);
check(
  mapToolResult({ bareTool: "search_restaurants_dineout", query: "x", input: {} }, { message: "No Dineout restaurants matched" }, ctx).length === 0,
  "empty search → no cards",
);
// The generic `{ text }` payload still yields (text) cards.
check(
  (mapToolResult({ bareTool: "search_restaurants_dineout", query: "Italian", input: {} }, coerced, ctx)[0] as { restaurants?: unknown[] })
    ?.restaurants?.length === 10,
  "generic { text } payload → 10 text cards",
);
const slotEvents = mapToolResult(
  { bareTool: "get_available_slots", query: "", input: { restaurantId: "1032642", restaurantName: "Si Nonna's", date: "2026-10-23" } },
  view,
  ctx,
);
const slotEv = slotEvents[0] as Extract<ChatStreamEvent, { type: "dineoutSlots" }>;
check(slotEv?.type === "dineoutSlots" && slotEv.slots.length === slotCount && slotEv.restaurantName === "Si Nonna's", "slots view → slot picker event");
const detEvents = mapToolResult(
  { bareTool: "get_restaurant_details", query: "", input: { restaurantId: "1032642", latitude: 12.9352, longitude: 77.6245 } },
  { restaurant: liveDetails },
  ctx,
);
check(
  (detEvents[0] as { restaurants?: DineoutRestaurant[] })?.restaurants?.[0]?.hasDetails === true,
  "details → card with hasDetails (opens the details sheet without a refetch)",
);

/* --------------------------- AI read / shortlist --------------------------- */
console.log("\nAI shortlist + AI read + compare verdict (live data, no extra Swiggy call)");
{
  const pool = liveRender.restaurants;
  const sl = rankDineoutShortlist(pool);
  check(sl.length >= 2 && sl.length <= 3, `shortlist of ${sl.length}: ${sl.map((x) => `${x.label}=${x.name}`).join(", ")}`);
  check(sl.every((x) => pool.some((r) => r.id === x.id)), "shortlist ids are real restaurant ids");
  check(new Set(sl.map((x) => x.id)).size === sl.length, "shortlist rows are distinct restaurants");
  const top = sl.find((x) => x.kind === "top");
  check(top?.name === "The Pizza Bakery - Koramangala" && /1\.1k ratings/.test(top.why), `Top rated weighs the count (4.6★ × 1.1k): ${top?.name} — ${top?.why}`);
  check(trustedRating({ rating: 4.9, ratingCount: 3 }) < trustedRating({ rating: 4.5, ratingCount: 2450 }), "4.9★ from 3 ratings ranks below 4.5★ from 2.5k");
  check(sl.every((x) => /★|New/.test(x.line)), "every row shows stars (+count) or New");
  const date = rankDineoutShortlist(pool, { needs: readNeeds("romantic date night with drinks for 2") });
  check(date[0]?.kind === "match" && date[0].label === "Best for a date night" && /Alcohol served/.test(date[0].why), `needs → ${date[0]?.label}: ${date[0]?.name} (${date[0]?.why})`);
  check(readNeeds("table for 4 at 8 pm").guests === 4 && readNeeds("dinner at 8 pm").guests === undefined, "guests parsed, '8 pm' is not a party size");
  check(readNeeds("under 1500 for two").budgetForTwo === 1500, "budget parsed");
  const withBest = rankDineoutShortlist(pool, { bestPicks: { [pool[1].id]: "model reason" } });
  check(withBest[0]?.kind === "concierge" && withBest[0].id === pool[1].id, "the concierge BEST mark leads the shortlist");
  const walk = rankDineoutShortlist([...pool, kfc]);
  check(!walk.some((x) => x.id === kfc.id), "walk-in-only (NPR) not shortlisted when bookable ones exist");
  const note = dineoutShortlistNote(pool, "date night");
  check(/AI SHORTLIST/.test(note) && /restaurantId=\d+/.test(note) && /Book .+ tomorrow 8 PM for 2/.test(note), "model gets the shortlist + a concrete action chip");
  check(compactCount(1052) === "1.1k" && compactCount(93) === "93" && compactCount(12000) === "12k", "compact rating counts");
  check(bestDiscount(pool.find((r) => r.name === "Yuki")!) === 10, "% off from a payment headline ('Up to 10% off with bank offers')");

  const facts = dineoutFacts(liveDetails);
  const f = facts.facts.join("\n");
  check(/Rated \d\.\d★/.test(f) || /No ratings yet/.test(f), "facts: rating line");
  check(!liveDetails.timings || f.includes(liveDetails.timings), "facts: timings");
  check(!liveDetails.menuImageGroups?.length || /Menu photos: .*\(\d+ pages?\)/.test(f), "facts: menu page counts");
  check(!liveDetails.mastheadImageUrls?.length || /\d+ photos? from Swiggy/.test(f), "facts: photo count");
  check(!liveDetails.dealDetails?.length || /cover charge/.test(f), "facts: deals with cover charge, grouped by slot group");
  check(!liveDetails.amenities?.length || /Amenities \(\d+\)/.test(f), "facts: amenities");
  check(!/review/i.test(f + facts.summary), "facts never mention reviews (Swiggy has none)");
  check(facts.summary.startsWith(liveDetails.name), `summary: ${facts.summary}`);
  check(/^Walk in only/.test(dineoutFitLine(kfc, {})), "fit: walk-in only is said plainly");
  check(dineoutFitLine(pool[0], {}) === "", "fit: no needs → no invented verdict");

  const v = dineoutCompareVerdict(pool.slice(0, 3));
  check(/wins on/.test(v) && /rating \(/.test(v) && /value \(/.test(v), `compare verdict: ${v}`);
  check(dineoutCompareVerdict([pool[0]]) === "", "compare verdict needs 2+ rows");
  const parsed = parseAiRead("SUMMARY: Great spot.\nFIT: Yes — rooftop.\nNOTE: x");
  check(parsed.summary === "Great spot." && parsed.fit === "Yes — rooftop.", "AI reply parse");
  check(parseAiRead("SUMMARY: Reviewers love the pasta").summary === undefined, "AI reply claiming reviews is dropped");
}

/* ------------------------------- rate limits ------------------------------- */
console.log("\nrate limiting");
check(isRateLimited(Object.assign(new Error("Streamable HTTP error: Error POSTing to endpoint (HTTP 429)"), { code: 429 })), "HTTP 429 detected");
check(isRateLimited(new DineoutBusyError()), "DineoutBusyError is rate-limited");
check(!isRateLimited(new Error("fetch failed")), "network error is not a 429");
const busyRes = dineoutErrorResponse(new DineoutBusyError(), { fallback: "x" });
void (busyRes.json() as Promise<{ busy?: boolean; message?: string }>).then((busyBody) => {
  check(busyRes.status === 429 && busyBody.busy === true && /busy/i.test(busyBody.message ?? ""), `429 → friendly "${busyBody.message}"`);
  console.log(`\n${passes} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
});

// get_booking_status nests the booking under `order` (live, 23 Oct 2026)
{
  const mapBooking = mapDineoutBooking;
  const live = {
    order: {
      orderId: '251659596133204', restaurantId: '854085', restaurantName: 'Ganbeii', restaurantLocation: 'Koramangala',
      reservationDate: '27 Oct 2026', reservationTime: '08:00 PM', guestCount: 2, dealTitle: 'Flat 10% Off on Total Bill',
      status: 'PLACED', bill: { subTotal: 20, totalBillAmount: 20, charges: [], taxes: [], discounts: [] },
    },
    message: 'Order Status: PLACED',
  };
  const b = mapBooking(live);
  if (!b || b.status !== 'PLACED' || b.restaurantName !== 'Ganbeii' || b.guestCount !== 2 || b.amount !== 20) {
    console.error('FAIL booking status: nested `order` not parsed', b);
    process.exitCode = 1;
  } else console.log('booking status (nested order): ok');
}
