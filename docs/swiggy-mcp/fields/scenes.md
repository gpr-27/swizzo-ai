# Scenes MCP — field-level audit (live, 2026-10-22)

Every field the READ-ONLY Scenes tools returned live, and where Swizzo uses it.
Captured with Bengaluru (12.9716, 77.5946), Mumbai (19.076, 72.8777) and Delhi
(28.6139, 77.209). Fixtures: `scripts/fixtures/scenes/*_live.json`; assertions:
`scripts/verify-scenes.ts` (81 checks).

Status: ✅ already used · 🆕 newly used in this pass · ⏭ intentionally unused (reason).

Files: mapper `src/backend/mcp/scenes-mcp.ts` · types `src/shared/types.ts` (Scenes block) ·
cards `src/frontend/components/catalog/ScenesEventCard.tsx`, `ScenesShowPicker.tsx` ·
model summaries `src/backend/agent/runner.ts summarize()` (scenes branches) ·
agent mapping `src/backend/agent/agent.ts mapToolResult`.

## Calls made

| Tool | Args | Result |
|---|---|---|
| discover_events | BLR, Mumbai | `{"events":[],"collectionChips":[]}` — empty server-side everywhere (confirmed) |
| get_events_collection | `collectionIdentifier:"1"` (no chip ids exist) | `{"events":[]}` |
| search_events | comedy / music / workshop / concert / "Zakir Khan" | `suggestions[]` — up to ~38 hits from ALL cities (not 4 as documented) |
| get_event_details | 100111962, 100081309, 100128633 | flat object, `price:""` every time |
| list_event_shows | with venueId, without venueId, 30-day `dateSummaryEndTime`, Mumbai coords | `eventShowListing{…}`; **without lat/lng → 400 "empty location context"** |
| get_event_venue_info | 100081309 + lat/lng | same shape as list_event_shows, but shows have `tickets:[]` and no `show_time_*`; spans every venue |
| get_saved_locations | — | `locations[]` |
| get_payment_options / get_event_cart / get_event_booking_status | — | skipped: need a cartKey / orderId from a mutating call |

## search_events → `suggestions[]`

| Field | Example | Meaning | Used in | Status |
|---|---|---|---|---|
| eventId | "100111962" | event id | card id, every follow-up | ✅ |
| eventName | "Indiranagar Comedy Nights Standup Show" | title | card title, poster, summary | ✅ |
| location | "Indiranagar, Bangalore" | "Area, City" | `splitLocation` → area + city; city filter (`filterToCity`) | ✅ |

## discover_events / get_events_collection
`events[]` (`eventId, eventName, venueName, area, date, price`) and `collectionChips[]` (`collectionIdentifier, label`) — mapped by `mapScenesEvents` ✅, but always empty live, so browsing uses the keyword-search fallback.

## get_event_details

| Field | Example | Used in | Status |
|---|---|---|---|
| eventId / eventName | "100128633" / "Rajesh Krishnan Live…" | card | ✅ |
| venueId | "4752" | the only bookable venue id → list_event_shows / create_event_cart | ✅ |
| venueName | "KLE SOCIETY'S DEGREE COLLEGE" | card place line, picker header | ✅ |
| area | "Nagarbhavi" | card place line | ✅ |
| formattedAddress | "Kle Society's Degree College, Bangalore" | `venueAddress` + city (last part) | ✅ |
| venueLat / venueLng | "12.978852" / "77.510837" (strings) | Directions link (card + picker) | ✅ |
| upcomingDate | "6th Nov • 06:00 PM onwards" | card date line, picker `dateSummary` | ✅ |
| price | "" | `priceText` badge when non-empty (empty live → hidden, never invented) | ✅ |

## list_event_shows / get_event_venue_info → `eventShowListing`

### dateSummary[]
| Field | Example | Used in | Status |
|---|---|---|---|
| date {year,month,day} | {2026,10,23} | picker date chips, "extra dates" (no show times yet), venue-info "Next:" | ✅ |
| totalAvailableInventory | 10 | seats-per-date on chips; summary `Dates:` line | ✅ (🆕 in model summary) |
| status | ENTITIES_DISCOVERY_STATE_ON_SALE | sold-out dates | ✅ |

### venueDetails[]
| Field | Example | Used in | Status |
|---|---|---|---|
| id | "3606" | scoped venue | ✅ |
| name | "Bloom Creative Zone - Indiranagar" | picker header, venue-info card | ✅ |
| address | "…Indiranagar, Bengaluru, Karnataka, India" | picker header, card | ✅ |
| localityDisplayName / cityDisplayName | "Indiranagar" / "Bangalore" | venue line, city | ✅ |
| location.latLng.latitude/longitude | 12.978528 / 77.641058 | Directions (picker, 🆕 on venue-info cards) | ✅/🆕 |
| distance | 5092.6 (metres from user) | 🆕 `venueDistanceKm` / `distanceKm` → "5.1 km away" chip (picker meta, venue-info card), model summary | 🆕 |
| auditoriums[] | [] | 🆕 id→name map; shown as the show's hall when `auditoriumId` matches (empty live) | 🆕 |
| description | "" | ⏭ always empty; would duplicate eventInfo.description | ⏭ |
| type | VENUE_TYPE_SPECIFIC / VENUE_TYPE_RX | ⏭ internal venue class (RX = a Dineout restaurant); no user meaning | ⏭ |
| location.cityId / zoneId / poiIds | 1 / 0 / [] | ⏭ internal ids | ⏭ |

### dateGroupedEventShow[].eventShow[]
| Field | Example | Used in | Status |
|---|---|---|---|
| date (group) | {2026,10,23} | `show.date` → date grouping | ✅ |
| id | "100494758" (string) | showId → Number() for create_event_cart | ✅ |
| show_time_unix | 1792769400 | create_event_cart.showTime, countdown | ✅ |
| show_time_ist | "Fri, 23 Oct, 9:00 pm" | show-time buttons, summaries | ✅ |
| timeRange.endTime | "2026-10-23T17:00:00Z" | `endTimeUnix` (calendar / countdown end) | ✅ |
| timeRange.startTime | "2026-10-23T15:30:00Z" | 🆕 `durationMin` (end − start = 90 min) under each show button + summary | 🆕 |
| gatePreopenedAt | null | 🆕 `gatesOpenUnix` → "Gates 8:30 pm" under the show (null live → hidden) | 🆕 |
| maxAvailableInventory | 10 | seats left per show | ✅ |
| purchaseRules.allowedCovers.min/max | 1 / 10 | ticket-count stepper bounds; 🆕 in summary ("1–10 per booking") | ✅ |
| purchaseRules.allowedType | TICKET_PURCHASE_ALLOWED_MULTIPLE_VARIANTS | ⏭ create_event_cart takes ONE ticketId per cart, so mixing tiers isn't possible anyway | ⏭ |
| status | ENTITIES_DISCOVERY_STATE_ON_SALE | sold-out shows disabled | ✅ |
| venue.venueId | "3606" | 🆕 `show.venueId`; shows of another venue are dropped from a venue-scoped listing (booking safety); per-venue dates + show count on venue-info cards | 🆕 |
| auditoriumId | "" | 🆕 matched to venue auditoriums (empty live) | 🆕 |
| eventId | "100111962" | ⏭ duplicate of the request id | ⏭ |
| name | "2026-10-23 15:30:00-2026-10-23 17:00:00" | ⏭ UTC range string, same as timeRange | ⏭ |
| venue.type / name / status / locality | "", STATE_INVALID | ⏭ always empty / invalid placeholders | ⏭ |

### tickets[]
| Field | Example | Used in | Status |
|---|---|---|---|
| id | "1221939" | create_event_cart.ticketId | ✅ |
| name | "Entry Pass For 2" | ticket buttons | ✅ |
| availableInventory | 5 | "5 left" / selling-fast, seat re-check before cart | ✅ |
| price.discountedPrice.units | "349" | the price paid | ✅ |
| price.price.units | "349" | strike-through `originalPrice` only when higher than discountedPrice | ✅ |
| price.coverCharge.units | "0" | "+ ₹X cover" when > 0; 🆕 in summary | ✅ |
| price.*.currencyCode / nanos | INR / 0 | nanos added to units; currency always INR | ✅ |
| tnc | "<ul><li>This pass admits 2 individuals only</li></ul>" | HTML → text; shown under the selected ticket + tooltip; 🆕 in model summary | ✅ |
| status | ENTITIES_DISCOVERY_STATE_ON_SALE | sold-out tiers disabled | ✅ |

### eventInfo
| Field | Example | Used in | Status |
|---|---|---|---|
| id / name | "100111962" / title | picker title, venue-info cards | ✅ |
| languages | ["hindi","english","hinglish"] | picker chips, 🆕 venue-info card chips, summary | ✅ |
| ageGroup | "18 yrs+" / "All Ages" / "" | picker chips, 🆕 card chips | ✅ |
| eventDuration {type,value} | {TYPE_HOURS, 1} | "1 hr" chip | ✅ |
| tags | ["stand up comedy","comedy_07","Collection1_v2",…] | genre tags, internal promo tags filtered; 🆕 lower-case genre tags kept + title-cased ("Stand Up Comedy"), `kids_friendly` → "Kid-friendly"; also sharpens the generated poster genre | ✅/🆕 |
| seatingArrangement | SEATING_ARRANGEMENT_SEATED / …_STANDING_AND_SEATED | 🆕 "Seated" / "Standing & seated" chip (picker + venue-info card), summary | 🆕 |
| recurring | true | 🆕 "Recurring" chip + summary | 🆕 |
| rewardsWidget.title | "{{img|24|24|…}} Earn 10% DineCash on ticket booking" | 🆕 markup stripped → green offer line in picker + venue-info card, share text, model summary ("Offer: …") | 🆕 |
| rewardsWidget.logo | https://media-assets.swiggy.com/…/Logo-Toggle.png | 🆕 icon next to the offer line in the picker | 🆕 |
| timeRange.startTime/endTime | 2026-08-21 → 2026-10-31 | 🆕 `runFromUnix` / `runUntilUnix`; "Recurring · till 31 Oct" chip + summary ("recurring until …") | 🆕 |
| ticketStartPrice | null | 🆕 `startPrice` (money), else the lowest on-sale ticket listed → "From ₹199" chip + summary | 🆕 |
| description | "" | 🆕 HTML → text, "About this event" disclosure + summary (empty live) | 🆕 |
| eventCategory.name | "" | 🆕 chip + summary when filled | 🆕 |
| artists[] | [] | 🆕 names (string or {name}) → "Artists: …" | 🆕 |
| organizer | null | 🆕 "By …" | 🆕 |
| tour | null | 🆕 "Part of …" | 🆕 |
| thingsToRemember[] | [] | 🆕 bullet lines (strings or {title, description}) | 🆕 |
| tnc | "" | 🆕 "Terms: …" (HTML → text) | 🆕 |
| status | ENTITIES_DISCOVERY_STATE_INVALID | ⏭ always INVALID at event level; per-show/ticket statuses are the real ones | ⏭ |
| layout / eventType | LAYOUT_INVALID / EVENT_TYPE_INVALID | ⏭ always invalid placeholders | ⏭ |
| contacts[] | [] | ⏭ organiser contact details — not needed for booking; avoid surfacing personal contact data | ⏭ |

### status (envelope)
`{code:0, message:"Success", details:[]}` — ⏭ transport status; errors come through `callTool` as `SwiggyToolError` with Swiggy's message + report id.

## get_saved_locations → `locations[]`

| Field | Example | Used in | Status |
|---|---|---|---|
| id | "d1k9ctrdq1oc…" | addressId for search_events (agent) | ✅ |
| addressLine | "Test User: [flat redacted], …, Bengaluru, Karnataka, India" | model lists it; 🆕 remembered per id so a `search_events{addressId}` is filtered to THAT place's city (`savedLocationCity`) instead of the current address's city | ✅/🆕 |
| addressTag / addressCategory | "GPR" / "Other", "Home" | 🆕 `label` / `category` in `mapSavedLocations`; model sees them | 🆕 |
| index | 1 | ⏭ display order only | ⏭ |
| phoneNumber | "****6256" | ⏭ masked by Swiggy; never needed | ⏭ |

No UI picker was added for saved locations: they carry no coordinates, and
list_event_shows / get_event_details / create_event_cart all need lat/lng. The
app's global address picker (`/api/addresses`, Instamart get_addresses) already
lists the same addresses with coordinates and drives the Scenes tab.

## Not exercised live (need a cart / order from a mutating tool)
get_payment_options `{cartKey}`, get_event_cart `{cartKey}`, get_event_booking_status `{orderId}` —
parsers unchanged (`getScenesEventCart`, `mapEventBooking`), shapes per docs/swiggy-mcp/scenes.md.
Images: Scenes returns none — generated genre posters stay.
