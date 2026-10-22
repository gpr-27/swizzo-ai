// Verify the Scenes parsers against REAL Swiggy payloads.
//   npx tsx --tsconfig tsconfig.json scripts/verify-scenes.ts
// Offline: docs/swiggy-mcp/LIVE-SAMPLES.md + scripts/fixtures/scenes/*_live.json
// (raw responses captured from the live Scenes MCP on 2026-10-22).
// Live (optional): SWIGGY_TOKEN=<bearer> also calls the READ-ONLY tools
// (discover_events, search_events, get_event_details, list_event_shows) and
// runs the same parsers on the fresh payloads. Never calls a mutating tool.

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { mapToolResult } from "@/backend/agent/agent";
import { rankScenesShortlist, scenesDateMs, scenesFacts, scenesFitLine, scenesShortlistNote } from "@/shared/aiRead";
import type { PromptContext } from "@/backend/agent/services";
import { SWIGGY_SCENES_MCP_URL } from "@/backend/config/env";
import { callTool, coerceToolPayload } from "@/backend/mcp/client";
import {
  agentDiscoverWithFallback,
  agentEnrichSearch,
  cityFromAddress,
  filterToCity,
  genreOf,
  interleaveUnique,
  mapScenesEvents,
  mapEventVenueInfo,
  mapSavedLocations,
  mapShowListing,
  mergeDetails,
  nearestCity,
  normalizeEventDetails,
  parseSelection,
  savedLocationCity,
  showIdForCart,
} from "@/backend/mcp/scenes-mcp";

const ROOT = join(__dirname, "..");
const BLR = { latitude: 12.9716, longitude: 77.5946 };
let failures = 0;
let passes = 0;

function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) {
    passes++;
    console.log(`  ✓ ${name}`);
  } else {
    failures++;
    console.log(`  ✗ ${name}${detail !== undefined ? ` — got ${JSON.stringify(detail)}` : ""}`);
  }
}

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(join(ROOT, "scripts/fixtures/scenes", name), "utf8"));
}

/** The first ```json block after a LIVE-SAMPLES heading. */
function liveSample(heading: string): unknown {
  const md = readFileSync(join(ROOT, "docs/swiggy-mcp/LIVE-SAMPLES.md"), "utf8");
  const at = md.indexOf(heading);
  if (at < 0) throw new Error(`LIVE-SAMPLES heading not found: ${heading}`);
  const start = md.indexOf("```json", at) + "```json".length;
  const end = md.indexOf("```", start);
  return JSON.parse(md.slice(start, end));
}

const ctx = { addressLine: "… New Tippasandra, Bengaluru, Karnataka, India", addressId: "x", ...BLR } as PromptContext;

console.log("\n# Cities");
check("address 'Bengaluru' → Bangalore", cityFromAddress(ctx.addressLine) === "Bangalore", cityFromAddress(ctx.addressLine));
check("nearest city to BLR coords", nearestCity(BLR) === "Bangalore");
check("nearest city to Mumbai coords", nearestCity({ latitude: 19.11, longitude: 72.87 }) === "Mumbai");
check("no city in the middle of nowhere", nearestCity({ latitude: 25, longitude: 85 }) === undefined);
check("genre comedy", genreOf("standup this weekend") === "comedy");
check("genre default", genreOf("what's on") === "all");

console.log("\n# search_events (LIVE-SAMPLES + live fixtures)");
{
  const sample = mapScenesEvents(liveSample("## scenes: search_events (live)"), BLR).events;
  check("5 suggestions parsed", sample.length === 5, sample.length);
  check("location split into area + city", sample[0].area === "Khb Colony" && sample[0].city === "Bangalore", sample[0]);
  const local = filterToCity(sample, "Bengaluru");
  check("city filter keeps 3 Bangalore events", local.length === 3, local.map((e) => e.city));
  check("user coords carried for follow-ups", local.every((e) => e.latitude === BLR.latitude));

  const music = mapScenesEvents(fixture("search_music_live.json"), BLR).events;
  const goa = filterToCity(music, "Goa");
  check("'Central Goa' matches Goa", goa.length === 1 && goa[0].city === "Central Goa", goa);
  const mix = interleaveUnique([
    filterToCity(music, "Bangalore"),
    filterToCity(mapScenesEvents(fixture("search_openmic_live.json"), BLR).events, "Bangalore"),
    filterToCity(sample, "Bangalore"),
  ]);
  check("interleaved browse mix is local + unique", mix.length === 8 && new Set(mix.map((e) => e.id)).size === 8, mix.length);
  check("round-robin mixes genres", mix[0].title.includes("Music") && mix[1].title.includes("Comedy"), mix.slice(0, 2).map((e) => e.title));
}

console.log("\n# get_event_details");
{
  const d = normalizeEventDetails(liveSample("## scenes: get_event_details (live)"), BLR);
  check("venueId 1233", d?.venueId === "1233", d);
  check("date + address", d?.dateSummary === "23rd Oct • 10:00 PM onwards" && d?.venueAddress?.endsWith("Bangalore") === true);
  check("empty price string → undefined (never invented)", d?.priceText === undefined);
  const d2 = normalizeEventDetails(fixture("details_100127262_live.json"), BLR);
  const base = mapScenesEvents(fixture("search_music_live.json"), BLR).events.find((e) => e.id === "100127262")!;
  const merged = mergeDetails(base, d2);
  check("search card + details merge", merged.venueId === "2486" && merged.city === "Bangalore" && merged.area === "Koramangala", merged);
}

console.log("\n# list_event_shows (LIVE-SAMPLES)");
{
  const l = mapShowListing(liveSample("## scenes: list_event_shows (live"), { eventId: "100109009", venueId: "1233", ...BLR });
  check("1 show", l.shows.length === 1, l.shows.length);
  const s = l.shows[0];
  check("showId kept as the STRING id", s.showId === "100496062", s.showId);
  check("show_time_unix / ist", s.showTimeUnix === 1792773000 && s.showTimeIst === "Fri, 23 Oct, 10:00 pm");
  check("date group → 2026-10-23", s.date === "2026-10-23", s.date);
  check("seats = maxAvailableInventory 12", s.availableSeats === 12);
  check("allowedCovers 1–10", s.minGuests === 1 && s.maxGuests === 10);
  check("2 ticket tiers", s.tickets.length === 2);
  const t = s.tickets[0];
  check("ticket id/name/price from {id,name,price.price.units}", t.ticketId === "1223907" && t.title === "Entry Pass For One" && t.price === 199, t);
  check("ticket inventory 7, on sale", t.availableInventory === 7 && t.onSale);
  check("no fake discount / zero cover hidden", t.originalPrice === undefined && t.coverCharge === undefined);
  check("tnc HTML stripped", t.tnc === "This pass admits 1 individual only", t.tnc);
  check("venue from venueDetails[]", l.venueName === "Bloom Creative Zone - HSR" && l.city === "Bangalore" && l.venueArea === "HSR Layout");
  check("eventInfo: languages, age, duration, tags", l.languages?.length === 3 && l.ageGroup === "18 yrs+" && l.duration === "1 hr" && l.tags?.includes("Stand Up Comedy") === true, l);
}

console.log("\n# list_event_shows (live fixture, 2 dates)");
{
  const l = mapShowListing(fixture("shows_100081309_live.json"), { eventId: "100081309", venueId: "1084", ...BLR });
  check("3 shows over 2 dates", l.shows.length === 3 && new Set(l.shows.map((s) => s.date)).size === 2);
  check("3 tiers on first show, ₹1699/3099/5399", l.shows[0].tickets.map((t) => t.price).join() === "1699,3099,5399");
  check("internal tags dropped, kids_friendly → Kid-friendly", JSON.stringify(l.tags) === JSON.stringify(["Perfume Making Workshop", "Kid-friendly"]), l.tags);
  check("empty ageGroup → undefined", l.ageGroup === undefined);
}

console.log("\n# list_event_shows field audit (live fixture 100111962, 2026-10-22)");
{
  const l = mapShowListing(fixture("shows_100111962_live.json"), { eventId: "100111962", venueId: "3606", ...BLR });
  const s = l.shows[0];
  check("2 shows", l.shows.length === 2, l.shows.length);
  check("show length from timeRange = 90 min", s.durationMin === 90, s.durationMin);
  check("show venueId carried", s.venueId === "3606", s.venueId);
  check("gatePreopenedAt null → undefined", s.gatesOpenUnix === undefined);
  check("seatingArrangement → Seated", l.seating === "Seated", l.seating);
  check("recurring true", l.recurring === true);
  check("run window from eventInfo.timeRange", l.runFromUnix === Date.parse("2026-08-21T15:30:00Z") / 1000 && l.runUntilUnix === Date.parse("2026-10-31T17:00:00Z") / 1000);
  check("rewards text without {{img}} markup", l.rewards === "Earn 10% DineCash on ticket booking", l.rewards);
  check("rewards logo is the https asset", l.rewardsLogo?.startsWith("https://media-assets.swiggy.com/") === true, l.rewardsLogo);
  check("venue distance 5092 m → 5.1 km", l.venueDistanceKm === 5.1, l.venueDistanceKm);
  check("ticketStartPrice null → lowest on-sale ticket ₹199", l.startPrice === 199, l.startPrice);
  check("lower-case genre tags kept + title-cased, promo tags dropped", JSON.stringify(l.tags) === JSON.stringify(["Open Mic", "Open Mic Comedy", "Stand Up Comedy", "Storytelling"]), l.tags);
  check("empty description / category / artists / organizer / tnc → undefined", [l.description, l.category, l.artists, l.organizer, l.tour, l.thingsToRemember, l.eventTnc].every((x) => x === undefined));
  check("dateSummary: 5 dates with inventory 10", l.dates?.length === 5 && l.dates.every((d) => d.available === 10 && d.onSale));
  check("tnc for pass for 2", s.tickets[1].tnc === "This pass admits 2 individuals only", s.tickets[1].tnc);

  // Synthetic eventInfo extras + a discounted ticket + another venue's show.
  const raw = JSON.parse(JSON.stringify(fixture("shows_100111962_live.json")));
  const info = raw.eventShowListing.eventInfo;
  Object.assign(info, {
    description: "<p>An evening of <b>stand-up</b> &amp; crowd work.</p>",
    eventCategory: { id: "7", name: "Comedy" },
    artists: [{ name: "Harshit Mahawar" }, "Guest Comic"],
    organizer: { name: "Bloom Creative" },
    thingsToRemember: ["<ul><li>Carry an ID</li></ul>", { title: "Parking", description: "Limited" }],
    tnc: "<ul><li>No re-entry</li></ul>",
    seatingArrangement: "SEATING_ARRANGEMENT_STANDING_AND_SEATED",
    ticketStartPrice: { currencyCode: "INR", units: "149", nanos: 0 },
  });
  const show0 = raw.eventShowListing.dateGroupedEventShow[0].eventShow[0];
  show0.gatePreopenedAt = "2026-10-23T15:00:00Z";
  show0.tickets[0].price.price.units = "299";
  raw.eventShowListing.dateGroupedEventShow[1].eventShow[0].venue.venueId = "9999";
  const x = mapShowListing(raw, { eventId: "100111962", venueId: "3606", ...BLR });
  check("description HTML → text", x.description === "An evening of stand-up & crowd work.", x.description);
  check("category / artists / organizer", x.category === "Comedy" && x.artists?.join() === "Harshit Mahawar,Guest Comic" && x.organizer === "Bloom Creative", x);
  check("thingsToRemember strings + records", x.thingsToRemember?.join("|") === "Carry an ID|Parking: Limited", x.thingsToRemember);
  check("event tnc", x.eventTnc === "No re-entry", x.eventTnc);
  check("Standing & seated", x.seating === "Standing & seated");
  check("ticketStartPrice money wins", x.startPrice === 149, x.startPrice);
  check("gates open 30 min before", x.shows[0].gatesOpenUnix === x.shows[0].showTimeUnix - 1800, x.shows[0].gatesOpenUnix);
  check("discount → strike-through originalPrice 299, pay 199", x.shows[0].tickets[0].price === 199 && x.shows[0].tickets[0].originalPrice === 299);
  check("another venue's show dropped from a venue-scoped listing", x.shows.length === 1, x.shows.length);
}

console.log("\n# get_event_venue_info (live fixture, 2 venues)");
{
  const cards = mapEventVenueInfo(fixture("venue_info_100081309_live.json"), BLR);
  check("one card per venue", cards.length === 2 && cards[0].venueId === "1084" && cards[1].venueId === "1071", cards.map((c) => c.venueId));
  check("per-venue dates from show venue ids", cards[0].dateSummary === "Next: 24 Oct, 31 Oct" && cards[1].dateSummary === "Next: 25 Oct", cards.map((c) => c.dateSummary));
  check("per-venue show counts 3 / 2", cards[0].showCount === 3 && cards[1].showCount === 2, cards.map((c) => c.showCount));
  check("distance km 4.5 / 5.7", cards[0].distanceKm === 4.5 && cards[1].distanceKm === 5.7, cards.map((c) => c.distanceKm));
  check("venue lat/lng for directions", cards[1].venueLatitude === 12.970732 && cards[1].venueLongitude === 77.647639);
  check("event metadata on cards", cards[0].duration === "1 hr" && cards[0].seating === "Standing & seated" && cards[0].languages?.length === 3 && cards[0].ageGroup === undefined, cards[0]);
  check("rewards on cards", cards[0].rewards === "Earn 10% DineCash on ticket booking");
}

console.log("\n# AI read + shortlist (live fixtures, no Swiggy call)");
{
  const NOW = Date.UTC(2026, 9, 22, 6, 30);
  const l = mapShowListing(fixture("shows_100081309_live.json"), { eventId: "100081309", venueId: "1084", ...BLR });
  const read = scenesFacts(l, NOW);
  check("facts: price range ₹1,699–₹5,399 from real tiers", read.facts.some((f) => f === "Tickets ₹1,699–₹5,399"), read.facts);
  check("facts: duration + languages line", read.facts.some((f) => /1 hr/.test(f) && /Hinglish/.test(f)), read.facts[0]);
  check("facts: shows on sale + next show time", read.facts.some((f) => /show/.test(f) && /next /.test(f)));
  check("facts: tags (Kid-friendly) included", read.facts.some((f) => /Kid-friendly/.test(f)));
  const audit = scenesFacts(mapShowListing(fixture("shows_100111962_live.json"), { eventId: "100111962", venueId: "3606", ...BLR }), NOW);
  check("facts (100111962): seating + offer + ticket terms", ["Seated", "DineCash", "admits 2"].every((w) => audit.facts.some((f) => f.includes(w))), audit.facts);
  check("facts: no review / rating text invented", !read.facts.some((f) => /review|★/i.test(f)));
  check("summary names the event + price", read.summary.startsWith(l.eventTitle) && /from ₹1,699/.test(read.summary), read.summary);
  check("fit: kids + All Ages / no age → no false 'Probably not'", !/Probably not/.test(scenesFitLine(l, "something for my kids")));
  check("fit: budget under 1000 vs ₹1,699 → Probably not", /Probably not/.test(scenesFitLine(l, "under 1000 please")));
  const cards = mapEventVenueInfo(fixture("venue_info_100081309_live.json"), BLR);
  const sl = rankScenesShortlist(cards, { nowMs: NOW });
  check("venue-info shortlist: one row per venue (same eventId), soonest first", sl.length === 2 && sl[0].venueId === "1084" && sl[1].venueId === "1071" && sl[0].why === "Next show 24 Oct, 31 Oct", sl);
  check("shortlist ids are real card ids", sl.every((x) => cards.some((c) => c.id === x.id)));
  check("dateSummary parse '6th Nov • 06:00 PM onwards'", scenesDateMs("6th Nov • 06:00 PM onwards", NOW) === Date.UTC(2026, 10, 6, 12, 30));
  const search = mapToolResult({ bareTool: "search_events", query: "comedy", input: { query: "comedy" } }, fixture("search_music_live.json"), ctx);
  const evs = (search.find((e) => e.type === "scenesEvents") as { events?: { id: string }[] } | undefined)?.events ?? [];
  check("search events → shortlist note only from real ids", !scenesShortlistNote(evs as never) || /eventId=\d+/.test(scenesShortlistNote(evs as never)));
}

console.log("\n# get_saved_locations (live fixture)");
{
  const locs = mapSavedLocations(fixture("saved_locations_live.json"));
  check("3 locations with id + label", locs.length === 3 && locs[2].label === "Home" && locs[2].category === "Home", locs);
  check("city from address line", locs[0].city === "Chennai" && locs[1].city === "Bangalore", locs.map((l) => l.city));
  check("saved id → city for addressId searches", savedLocationCity(locs[0].id) === "Chennai" && savedLocationCity("nope") === undefined);
}

console.log("\n# create_event_cart args (not called)");
{
  check("string showId → number", showIdForCart("100496062") === 100496062);
  check("junk showId rejected", showIdForCart("12a") === undefined && showIdForCart("") === undefined);
  const future = Math.floor(Date.now() / 1000) + 3600;
  const sel = parseSelection({ venueId: "1233", showId: "100496062", ticketId: "1223907", showTime: future, guestCount: 2, ...BLR });
  check(
    "selection matches the tool's input schema",
    typeof sel === "object" && sel.showId === 100496062 && sel.ticketId === "1223907" && sel.venueId === "1233" && sel.showTime === future,
    sel,
  );
  check("past show rejected", typeof parseSelection({ venueId: "1", showId: "2", ticketId: "3", showTime: 1000, guestCount: 1, ...BLR }) === "string");
  check("21 guests rejected", typeof parseSelection({ venueId: "1", showId: "2", ticketId: "3", showTime: future, guestCount: 21, ...BLR }) === "string");
}

console.log("\n# agent mapping (mapToolResult)");
(async () => {
  const meta = (bareTool: string, input: Record<string, unknown> = {}) => ({ bareTool, query: "", input: { ...BLR, ...input } });
  const empty = mapToolResult(meta("discover_events"), fixture("discover_empty_live.json"), ctx);
  const e0 = empty[0];
  check(
    "empty discover → emptyDiscover marker with city",
    empty.length === 1 && e0.type === "scenesEvents" && e0.events.length === 0 && e0.emptyDiscover?.city === "Bangalore",
    empty,
  );
  const textOnly = mapToolResult(meta("discover_events"), { text: "No events found near the selected location." }, ctx);
  check("text-only discover payload also → marker", textOnly[0]?.type === "scenesEvents");
  const search = mapToolResult(meta("search_events", { query: "comedy" }), liveSample("## scenes: search_events (live)"), ctx);
  const se = search[0];
  check("search_events cards kept to the user's city", se?.type === "scenesEvents" && se.events.length === 3, se);
  const other = mapToolResult(meta("search_events", { query: "x" }), fixture("search_openmic_live.json"), ctx);
  check("no local match → all cities shown", other[0]?.type === "scenesEvents" && other[0].events.length === 4);
  const shows = mapToolResult(meta("list_event_shows", { eventId: "100109009", venueId: "1233" }), liveSample("## scenes: list_event_shows (live"), ctx);
  check("list_event_shows → scenesShows card", shows[0]?.type === "scenesShows");
  mapToolResult(meta("get_saved_locations"), fixture("saved_locations_live.json"), ctx);
  const chennai = mapToolResult(
    meta("search_events", { query: "comedy", addressId: "db7kh1c1d96ofdam8g8g__AMVEDwTGeS8WPRJQbO-o12", latitude: undefined, longitude: undefined }),
    { suggestions: [{ eventId: "1", eventName: "A", location: "Nandanam, Chennai" }, { eventId: "2", eventName: "B", location: "HSR, Bangalore" }] },
    ctx,
  );
  check("addressId search keeps the SAVED place's city (Chennai)", chennai[0]?.type === "scenesEvents" && chennai[0].events.map((e) => e.id).join() === "1", chennai);

  console.log("\n# agent tool helpers");
  const passthrough = await agentDiscoverWithFallback("EVENTS …\n• eventId=1 | x", undefined, async () => "");
  check("discover with events passes through", passthrough.startsWith("EVENTS"));
  const enriched = await agentEnrichSearch(
    "EVENTS (cards…):\n• eventId=100127262 | Live Music With Mohit | Koramangala, Bangalore",
    async (id) => `EVENTS:\n• eventId=${id} | venueId=2486 | Live Music With Mohit | House Of Dopamine`,
  );
  check("search result lines replaced by detail lines", enriched.includes("venueId=2486") && !enriched.includes("Koramangala, Bangalore"), enriched);

  const token = process.env.SWIGGY_TOKEN;
  if (token) {
    console.log("\n# LIVE (read-only tools)");
    const call = async (name: string, args: Record<string, unknown>) =>
      coerceToolPayload(await callTool(SWIGGY_SCENES_MCP_URL, name, args, { token }));
    const disc = mapScenesEvents(await call("discover_events", BLR), BLR);
    console.log(`  discover_events: ${disc.events.length} events, ${disc.collections.length} chips`);
    const live = filterToCity(mapScenesEvents(await call("search_events", { query: "comedy", ...BLR }), BLR).events, "Bangalore");
    check("live search_events has Bangalore events", live.length > 0, live.length);
    if (live[0]) {
      const det = normalizeEventDetails(await call("get_event_details", { eventId: live[0].id, ...BLR }), BLR);
      check("live details has venueId", !!det?.venueId, det);
      if (det?.venueId) {
        const l = mapShowListing(await call("list_event_shows", { eventId: det.id, venueId: det.venueId, ...BLR }), {
          eventId: det.id,
          venueId: det.venueId,
          ...BLR,
        });
        console.log(`  list_event_shows: ${l.shows.length} shows; first: ${l.shows[0]?.showTimeIst} ${l.shows[0]?.tickets.map((t) => `${t.title} ₹${t.price}`).join(", ")}`);
        check("live shows parse with string ids + unix time", l.shows.every((s) => /^\d+$/.test(s.showId) && s.showTimeUnix > 1e9));
      }
    }
  } else {
    console.log("\n(live checks skipped — set SWIGGY_TOKEN to run the read-only tools)");
  }

  console.log(`\n${passes} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
