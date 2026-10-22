# Dineout — field-level audit (live, 2026-10-22)

Sources: live calls via the `swiggy-dineout` MCP (search Indiranagar, render Italian/Koramangala ids,
get_restaurant_details 1450311, get_available_slots 1450311, get_payment_options), plus
`docs/swiggy-mcp/LIVE-SAMPLES.md` and `scripts/fixtures/dineout-live.json` (verified by
`scripts/verify-dineout.ts`, 85 checks). Mutating tools were never called; no orderId existed, so
get_booking_status was not called (its parser follows the docs shape).

Status: ✅ used before this pass · 🆕 newly used in this pass · ⏭ deliberately unused (reason).

Parser: `src/backend/mcp/dineout-mcp.ts`. Types: `src/shared/types.ts` (`DineoutRestaurant`, `DineoutOffer`,
`DineoutPaging`, `DineoutSlot`, `DineoutDeal`). UI: `catalog/DineoutRestaurantCard.tsx` (card),
`catalog/DineoutDetailsSheet.tsx` (sheet), `catalog/DineoutResults.tsx` (list + paging),
`features/DineoutCompare.tsx` (compare), `catalog/DineoutSlotPicker.tsx` (picker).
Model summary: `runner.ts summarize()` dineout branches.

## search_restaurants_dineout — `structuredContent` is `{}`; everything is in `content[0].text`

| field (text part) | example | meaning | where used | status |
|---|---|---|---|---|
| `Found N restaurant(s)` | `Found 28 restaurant(s) matching "Italian"` | total matches | `DineoutSearchResult.total` → event `paging.total` → DineoutResults header "28 restaurants … match"; model summary "(28 matched in total…)" | 🆕 (parsed ✅ before, now shown) |
| `showing M` | `showing 10` | page size | derivable from the lines | ⏭ redundant |
| `K more available, call again with offset=X` | `offset=10` | next page | `nextOffset` → `paging.nextOffset` → DineoutResults "Load more (18 more)" → `GET /api/dineout/search?…&offset=` ; model told the offset | 🆕 |
| line `N. Name` | `Thyme and Whisk` | name | card | ✅ |
| line cuisines | `North Indian, Italian` | cuisines | card (text fallback) | ✅ |
| line `4.3★` / `--★` | rating | rating (unrated = `--`) | card | ✅ |
| line `₹1000 for two` | cost | cost for two | card | ✅ |
| line area | `Jayanagar` | area | card | ✅ |
| line `(ID: 818805)` | id | restaurantId | everything | ✅ |
| `Search coordinates: latitude=…, longitude=…` | 12.9352, 77.6245 | coords to reuse | stored on every card → details/slots/booking | ✅ |
| instruction paragraphs ("When the user selects…", "These results are NOT yet shown…") | — | guidance for an LLM host | — | ⏭ our app renders cards itself (search → render is automatic) |
| `availableFilters` / `availableSorts` | — | facet ids / sort keys the tool schema says a search *may* advertise | — | ⏭ not present in any live response (captured texts + structuredContent `{}`); no ids to echo, and the schema forbids inventing them. Re-check when Swiggy starts sending them. |

## render_restaurants_dineout — `structuredContent.restaurants[]`

| field | example | meaning | where used | status |
|---|---|---|---|---|
| `id` | `"1450311"` | restaurantId | everywhere | ✅ |
| `name` | `Baci Baci Osteria` | name | card, sheet, compare, model | ✅ |
| `cuisine[]` | `["Italian","Desserts"]` | cuisines (`[]` for listing-only) | card, sheet, compare, model | ✅ |
| `locality` | `Koramangala` | locality | `dineoutPlace()` (card/sheet), compare, model | ✅ |
| `area` | `Nexus Koramangala Mall, Koramangala` | finer area | `dineoutPlace()` de-dups area vs locality | ✅ |
| `rating.value` | `"4.8"` / `"--"` | rating | card badge, sheet, compare, model | ✅ |
| `rating.count` | `93` | number of ratings | card "(93)", sheet "93 ratings", compare, model | ✅ |
| `costForTwo` | `₹3400 for two` (`""` for NPR) | cost | card, sheet, bill split, compare, model | ✅ |
| `imageUrl` | media-assets JPG | card photo | card (CDN resize 640), compare, sheet fallback | ✅ |
| `distance` | `0.2 km` | from search coords | card, sheet, compare (best = green), model | ✅ |
| `highlights[]` | `Alcohol served, Pure veg, …` | amenity facts | card chips, sheet amenities (union with details), compare rows, model | ✅ (no longer mixed with vendor perks) |
| `vendorHighlights[].text` | `Free Beer`, `Table booking` | the restaurant's own perks | `vendorHighlights` → card 🎁 chips, sheet "Perks", compare "Perks" row, model "perks:"; `Table booking` feeds `bookable` and is not shown as a perk | 🆕 |
| `vendorHighlights[].type` | `""` | always empty | — | ⏭ always `""` |
| `offers[].offerTitle` | `Flat 20% off` | offer | `offers[]`, card fallback, compare, model | ✅ |
| `offers[].offerDescription` | `Available today` / `Total bill` | offer condition | `offerDetails[].description` → card sub-line fallback, sheet offer rows, model "offers:" | 🆕 |
| `offerHeadline.title` | `Flat 15% off` | headline offer | card badge, sheet, compare, model | ✅ |
| `offerHeadline.subtitle` | `on pre-booking` | headline qualifier | card, sheet, compare, model | ✅ |
| `offerHeadline.subtext` | `+5 offers` | more-offers count | card sub-line, sheet (right-aligned), model | ✅ card / 🆕 sheet + model |
| `offerHeadline.kind` | `deal` / `payment` | headline type | stored (`kind`) | ⏭ display — the title already says "with bank offers" for `payment` |
| `offerHeadline.logoUrl` | `…/one_pre_booking.png`, `…/pocket_hero.png` | badge image | card badge + sheet offer row | ✅ |
| `offerHeadline.logoText` | `ONE` | Swiggy One badge text | card badge tag, sheet tag, compare offers row, model "[Swiggy ONE]" | 🆕 |
| `bankOffers[].offerTitle` | `Flat 10% off` | bank offers | `bankOffers` → card "🏦 Bank offer" line (when it differs from the headline), sheet rows, compare "Bank offers" row, model | 🆕 |
| `availableDeals[]` | `[]` in every live sample | bookable deals | tolerant parse (`dealTitle`/`title`) → `deals`/`dealDetails` | ✅ (always empty live) |
| `partnerType` | `"NPR"` (listing-only, e.g. KFC 588619) | booking partner type | `partnerType` + `bookable=false` → card/sheet "Walk-in only — no table booking on Swiggy" badge instead of Reserve; compare "Table booking" row; model "bookable: no (walk-in only)"; ordered after bookable ones | 🆕 |
| `source` | `"autosuggest"` | how the card was resolved | `source` (type) | ⏭ display — internal; `partnerType` is the actionable signal |
| `message` | `Showing 2 restaurants. (1 of 3 requested id could not be resolved and were skipped)` | render note | `renderNote` on the search result (cards the render drops keep their text line via `mergeRenderedCards`) | 🆕 parsed; ⏭ UI (the card list itself shows what resolved) |
| `latitude` / `longitude` | 12.9352 | coords | cards | ✅ |

## get_restaurant_details — `structuredContent`

| field | example | meaning | where used | status |
|---|---|---|---|---|
| `restaurantId`, `restaurant.id`, `restaurant.restaurantId` | `1450311` | id (3× repeated) | id | ✅ (dups ⏭) |
| `restaurant.name`, `cuisines[]` | | | sheet, model | ✅ |
| `restaurant.locality` / `area` | `Koramangala, Bangalore` (identical) | place | `dineoutPlace()` | ✅ |
| `restaurant.address` | `0.2 km • 431, 8th Main Road, …` | distance • address | split → `distance` + `address` → sheet address box, share text, Maps link, model "address:" | ✅ / 🆕 model |
| `restaurant.avgRating` | `4.8` | rating | sheet, compare | ✅ |
| `restaurant.costForTwo` | `₹3400 for two` | cost | sheet, bill split | ✅ |
| `restaurant.imageUrl` | JPG | hero | sheet (leads the strip if not in masthead), card backfill | ✅ |
| `restaurant.mastheadImageUrls[]` | 30 JPGs for Baci Baci | gallery | sheet photo strip — now **all** photos (was capped at 12), lazy-loaded, tap → Lightbox | 🆕 (all) |
| `restaurant.timings` | `Open till 11:59PM` | opening | sheet, compare, model | ✅ |
| `restaurant.deals[].title` / `description` | `Flat 15% off on Total Bill` / `Available on Mon-Sun` | deal | `deals[]` + `dealDetails[]` → sheet offers, model | ✅ |
| `restaurant.deals[].discountPercentage` | `15` | % off | sheet "15% off" pill, model | 🆕 |
| `restaurant.deals[].coverCharge` | `0` | ₹ cover charge | sheet "No cover charge" / "₹N cover charge", model when > 0 | 🆕 |
| `restaurant.deals[].slotGroupName` | `Pre-booking offers` | offer group | sheet groups offers under it | 🆕 |
| `restaurant.deals[].offerCategory` | `prebooking` | category | sheet tag | 🆕 |
| `restaurant.deals[].id` | `""` | always empty | — | ⏭ always `""` |
| `restaurant.partnerType` | `PR` / `NPR` | booking partner | `bookable` (sheet: Reserve vs Walk-in badge; compare row; model) | 🆕 |
| `offers[]` | same objects as `restaurant.deals[]` | offers | kept only when different from deals (`offerDetails`) | ✅ de-dup |
| `menuImages[]` (`imageUrl`, `label`) | 14 pages | flat menu | fallback group when no `menuImageGroups` | ✅ |
| `menuImageGroups[]` (`title`, `images[].imageUrl/label`) | `Food • 8 pages`, `Bar • 4 pages` | grouped menu | sheet Menu rows (every page) → Lightbox; model "menu photos: …" | ✅ / 🆕 model |
| `amenities[]` | `Alcohol served, …` | amenities | sheet (union with card highlights), compare rows, model | ✅ |
| `locationMapUrl` | Google Maps directions | map | sheet "Directions in Google Maps", share | ✅ |
| `latitude` / `longitude` | | coords | slots/booking | ✅ |

## get_available_slots — `result._meta.slots[]` (structuredContent only has a count message)

| field | example | meaning | where used | status |
|---|---|---|---|---|
| `displayTime` | `11:00 AM` | slot label | picker, model | ✅ |
| `slotGroupName` | `Breakfast` / `Lunch` / `Dinner` | meal window | picker groups, model | ✅ |
| `subText` | `15% off` | slot sub-label | picker time button | ✅ |
| `daySubtext` | `15% off` | the day's headline | picker date chip, model `• 2026-10-23 [15% off]` | 🆕 |
| `dateStr` | `2026-10-23` | date | picker dates, model | ✅ |
| `reservationTime` | `"1792733400"` (string) | unix s | → number → create_cart / book_table | ✅ |
| `deals[].itemId` | `1032642-1145157` | deal id | booking args; ticketId derived | ✅ |
| `deals[].slotId` | `1` | slot id | booking args | ✅ |
| `deals[].isFree` | `false` | free vs paid | picker (free vs UPI flow), model | ✅ |
| `deals[].title` | `Flat 15% off on Total Bill` | deal name | picker, booking summary, model | ✅ |
| `deals[].bookingPrice` | `25` | ₹ fee | picker price, model | ✅ |
| `deals[].discountPercentage` | `15` | % off bill | picker (paid **and now free** deals), date-chip max %, model | ✅ / 🆕 free + model |
| `deals[].dealCategory` | `GIRF` / `RESERVATION` | internal category | model summary | 🆕 model; ⏭ UI (opaque code; title + isFree already say it) |
| `soldOut` / `availableInventory` | absent live | inventory | parsed tolerant (absent = bookable) | ✅ |
| structured `message` | `Found 272 available slot(s) for 2026-10-23` | count | — | ⏭ derivable from slots |
| text per-date summary | (meal ranges) | for LLM hosts | — | ⏭ we have the exact slots |
| empty result (`{}`, no `_meta.slots`) | NPR restaurants | no bookings | hook marks the restaurant (`state/dineoutAvailability.ts`) → card + sheet show the Walk-in badge; chat says "listed but walk-in only" (no empty picker) | 🆕 |

## get_payment_options (shared, parsed in `payment-mcp.ts`, not owned here)

| field | example | where used | status |
|---|---|---|---|
| `platforms.mobile.methods[]` (`id`, `displayName`, `kind`, `iconUrl`) | `gpay://upi/`, Google Pay, icon | slot picker UPI buttons (icon + name), `intentApp` | ✅ |
| `platforms.desktop.methods[]` (`PayWithQR`, `kind:"qr"`) | | QR option (`generateUPIQR`) | ✅ |
| `allMethods[]` (+ `enabled`, `raw`) | | fallback list | ✅ (`raw` ⏭ duplicate) |
| `paymentAmount` | `"1784"` | amount (read in payment-mcp) | ✅ |
| `placeOrderToolName` | `book_table` | which tool places | ⏭ the app already knows its own flow |

## get_booking_status — not called (no orderId); docs fields `orderId, status, restaurantName, restaurantLocation, reservationDate, reservationTime, guestCount, dealTitle` are all mapped (`mapDineoutBooking`) and shown in the booking tracker ✅.
