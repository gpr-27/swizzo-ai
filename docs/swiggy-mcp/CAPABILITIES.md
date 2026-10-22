# Swizzo × Swiggy MCP: capabilities, coverage and limits

Last verified: **2026-10-22**, against the live `tools/list` of all four servers (Food, Instamart,
Dineout, Scenes), the official Builders Club docs (`builders-llms-full.txt`), and real responses
(`LIVE-SAMPLES.md`, `live/*.json`).

**How to read the tables**

- **Kind**: **R** = read-only. **M** = mutating (changes cart, order, booking, address or payment state). Swizzo's LLM agent
  only ever gets **R** tools. **M** tools are called by deterministic API routes, and only after the user taps an explicit
  confirmation.
- **Status**:
  - ✅ works end to end
  - ⚠️ partial (see note)
  - ❌ not implemented
  - 🚫 not possible through the MCP (the tool is missing on the live server, or Swiggy says not to use it)
- **Where**: route = `src/app/api/**`, agent = `src/backend/agent/tools.ts` (LLM tool), UI = component under
  `src/frontend/components/**`.
- Order placement, cancellation and payment sit behind `SWIGGY_ENABLE_ORDERS=true`. Without it the routes return
  `{ gated: true, message: "Ordering is disabled on this server" }` and never a fake success.

---

## 0. The inventory at a glance

| Server | Endpoint | Live tools | Documented | Live but not documented | Documented but **not live** |
| --- | --- | --- | --- | --- | --- |
| Food | `mcp.swiggy.com/food` | 20 | 21 | n/a | `recommend_address` |
| Instamart | `mcp.swiggy.com/im` | 16 | 20 | n/a | `list_coupons`, `apply_coupon`, `get_order_details`, `recommend_address` |
| Dineout | `mcp.swiggy.com/dineout` | 11 | 11 | `render_restaurants_dineout` | `cancel_booking` |
| Scenes | `mcp.swiggy.com/scenes` | 15 | 15 | n/a | n/a |
| **Total** | | **62** | 67 ("66" in the docs) | | |

Notes:

- The docs hedge on rollout: *"if cancel_booking is available for the user's account, use it…"*. Tools missing from
  `tools/list` may be gated per account. The code checks this at runtime with `hasTool()`
  (`src/backend/mcp/client.ts`), so a tool that gets enabled later starts working with no code change wherever the check is
  used (Dineout cancel).
- Instamart `update_cart` mentions an `add_print_to_cart` tool (Instamart Print). It is in neither the live list nor the
  docs.
- The shared tools (`get_payment_options`, `check_payment_status`, `confirm_order`, `report_error`) exist on every server.
  The address tools (`get_addresses`, `create_address`, `delete_address`) exist on Food and Instamart, which share one
  address book.

---

## 0b. Final coverage matrix (pass 3, 2026-10-22): every live tool, verified

Checked automatically by `scripts/verify-coverage.ts`: all 62 live tools are called in `src/`, each is classified READ or
MUTATING exactly once, the agent never gets a mutating tool, every read tool is exposed to its tab's agent or excluded on
purpose (reason listed in the script), and Plan's tools are a subset of the domain agents' tools.

**Verified** column:
- ✅ called live this pass, and our parser was run on (or checked against) the real output
- 🔍 schema-checked only: argument names, types, required fields and enums compared with the live input schema plus a code
  review. These are mutating tools (never called while testing) or reads that need an id we don't have (orderId, paasId,
  cartKey)
- 🚫 not live

**Images** column: which field carries Swiggy's official image, and where Swizzo shows it. Every image goes through
`src/backend/mcp/image.ts` (`swiggyImageUrl`), except Dineout's `dineout-media-assets` URLs, which are used as-is.

### Food (20)

| Tool | R/M | UI entry point (besides chat) | Agent | Verified | Images |
| --- | --- | --- | --- | --- | --- |
| `search_restaurants` | R | restaurant cards (chat); dish fallback in `/api/dishes` | Food, Plan | ✅ | `restaurants[].imageUrl` → `FoodRestaurantCard` |
| `get_restaurant_menu` | R | **new `/api/food-menu`**: "View menu" on a card is now instant (no LLM). **"More categories"** pages it. Each category's live `hasMoreItems/totalItems` shows **"N more in <category>"**, which opens a scoped `search_menu` | Food, Plan | ✅ | `items[].imageUrl` → `MenuList` rows; `restaurant.imageUrl` |
| `search_menu` | R | `/api/dishes` (DISHES cards); **new "More dishes" button** (`nextOffset`); `FoodCustomizer` (scoped: `variantsV2` / `variations` + add-on groups, `maxAddons`, `-1`/`0` = unlimited) | Food, Plan | ✅ (cross + scoped with add-ons) | `items[].imageUrl` → `MenuList` |
| `get_food_cart` | R | `/api/food-cart` → `FoodCartPanel` (`data:null` = empty cart, handled) | **Food (new)** | ✅ | cart item image → `CartLineRow` |
| `update_food_cart` | M | `/api/food-cart` add/inc/dec/set, plus **new `action:"cutlery"`** → `cutleryOptIn` (**new "Send cutlery" toggle** in `FoodCartPanel`, re-sent on every update) | n/a | 🔍 | n/a |
| `flush_food_cart` | M | `/api/food-cart` clear | n/a | 🔍 | n/a |
| `fetch_food_coupons` | R | `FoodCartPanel` "All coupons" | **Food (new)** | ✅ (`coupon_sections:[]`, "COD only") | none returned |
| `apply_food_coupon` | M | `FoodCartPanel` (best, listed, or typed code) | n/a | 🔍 | n/a |
| `place_food_order` | M | confirm sheet → `/api/food-cart` place. **New "Note to the restaurant" field** → `noteToRestaurant` | n/a | 🔍 | n/a |
| `get_payment_options` | R | confirm sheet picker | excluded (renders the picker) | ✅ (`allMethods:[]`, `agenticPaymentEligible:false` for this account) | `methods[].iconUrl` → confirm-sheet chips |
| `check_payment_status` | R* | `PaymentModal` poll | excluded | 🔍 (needs paasId) | n/a |
| `confirm_order` | M | `PaymentModal` | n/a | 🔍 | n/a |
| `get_food_orders` | R | History view, usuals, `OrderHistoryCard` | Food | ✅ | `actions[].reorderMeta.restaurantCoverImageId` → order rows |
| `get_food_order_details` | R | "Details" on order rows | Food | ✅ called. `structuredContent` is `{}` and the detail is text-only (parser: `parseFoodOrderDetailsText`) | text `[image: url]` → item thumbs |
| `track_food_order` | R | History "Track" | Food | ✅ (`{orders:[]}` with no active order) | n/a |
| `get_food_delivery_status` | R | History "Track" | Food | ✅ (`statusText`, `delivered`, `trackUrl`, `pollIntervalSec`) | n/a |
| `get_addresses` | R | `AddressPicker` | excluded (app context) | ✅ | n/a |
| `create_address` | M | `CreateAddressModal` | n/a | 🔍 (all 8 required fields + `addressCategory` enum) | n/a |
| `delete_address` | M | `AddressPicker` delete + confirm | n/a | 🔍 | n/a |
| `report_error` | M | `ReportProblemButton` | n/a | 🔍 | n/a |

### Instamart (16)

| Tool | R/M | UI entry point | Agent | Verified | Images |
| --- | --- | --- | --- | --- | --- |
| `search_products` | R | product grid + "Load more" (`offset` number, `nextOffset` string) | Instamart, Plan | ✅ (parser on a 63 KB live payload: 20 + 20 similar, every product has an image) | `variations[].imageUrl` → `ProductCard` |
| `your_go_to_items` | R | `UsualsBoard` | Instamart, **Plan (new)** | ✅ | `variations[].imageUrl` |
| `get_cart` | R | `CartPanel` (`cartAbsent:true` handled) | **Instamart (new)** | ✅ | cart item image |
| `update_cart` | M | `CartPanel` (`selectedAddressId`, full list, `spinId`+`skuId`) | n/a | 🔍 | n/a |
| `clear_cart` | M | `CartPanel` | n/a | 🔍 | n/a |
| `checkout` | M | confirm sheet: every method `get_payment_options` returns (UPI intent, QR, Cash, SwiggyPay) | n/a | 🔍 | n/a |
| `get_payment_options` / `check_payment_status` / `confirm_order` | R/R*/M | confirm sheet / `PaymentModal` | excluded | ✅ / 🔍 / 🔍 | `iconUrl` → picker chips |
| `get_orders` | R | History view | Instamart | ✅ (no orders in the last 15 days for this account) | item images where returned |
| `track_order` | R | History "Track" (order's own lat/lng) | Instamart | 🔍 (needs an orderId) | n/a |
| `get_delivery_status` | R | History "Track" | Instamart | 🔍 (needs an orderId) | n/a |
| `get_addresses` / `create_address` / `delete_address` | R/M/M | `AddressPicker` / `CreateAddressModal` | excluded | ✅ / 🔍 / 🔍 | n/a |
| `report_error` | M | `ReportProblemButton` | n/a | 🔍 | n/a |

### Dineout (11)

| Tool | R/M | UI entry point | Agent | Verified | Images |
| --- | --- | --- | --- | --- | --- |
| `search_restaurants_dineout` | R | `/api/dineout/search`; chat | Dineout, Plan | ✅ (`structuredContent` `{}`, text-only) | none (text) |
| `render_restaurants_dineout` | R | run after every search → photo cards | auto (excluded) | ✅ | `imageUrl` → `DineoutRestaurantCard`; **`offerHeadline.logoUrl` → offer badge (new; was dropped)** |
| `get_restaurant_details` | R | `DineoutDetailsSheet` | Dineout, Plan | ✅ | `imageUrl`, `mastheadImageUrls[]` (gallery), `menuImageGroups[].images[]` (menu pages); **headline logo (new)** |
| `get_available_slots` | R | `DineoutSlotPicker` (7 days, slots in `_meta.slots`) | Dineout, **Plan (new)** | ✅ ("Found 364 available slots") | n/a |
| `create_cart` (`DEAL_TICKET_PURCHASE`) | M | slot picker, paid deal | n/a | 🔍 (`slotId` number, `reservationTime` number, `cartType` enum) | n/a |
| `book_table` | M | slot picker (free, or UPI + `cartKey`) | n/a | 🔍 (`paymentMethod` enum `Cash`/`UPI`) | n/a |
| `get_payment_options` / `check_payment_status` / `confirm_order` | R/R*/M | slot picker / `PaymentModal` | excluded | 🔍 | `iconUrl` → slot-picker chips |
| `get_booking_status` | R | booking cards "Refresh", "My bookings" | Dineout | 🔍 (needs an orderId) | n/a |
| `report_error` | M | slot picker, booking cards | n/a | 🔍 | n/a |

### Scenes (15)

| Tool | R/M | UI entry point | Agent | Verified | Images |
| --- | --- | --- | --- | --- | --- |
| `discover_events` | R | chat (keyword fallback) | Scenes, Plan | ✅ (still `{events:[],collectionChips:[]}`) | none, so a generated poster |
| `get_events_collection` | R | genre chips | Scenes, Plan | ✅ (empty; no chip ids exist) | none |
| `search_events` | R | `/api/scenes/search` | Scenes, Plan | ✅ **now returns up to 30 suggestions across cities (not 4)**; we filter to the city and enrich the top 8 | none |
| `get_event_details` | R | event cards | Scenes, Plan | ✅ (`venueId`, `venueLat/Lng`, `upcomingDate`) | none |
| `list_event_shows` | R | `ScenesShowPicker` | Scenes, **Plan (new)** | ✅ (`show_time_unix`, `tickets[].price.price.units`) | none (`rewardsWidget.logo` is a DineCash promo, not event art) |
| `get_event_venue_info` | R | chat (venue cards) | Scenes | ✅ (needs lat/lng) | none |
| `get_saved_locations` | R | chat ("near my home") | Scenes | ✅ | n/a |
| `create_event_cart` | M | show picker | n/a | 🔍 (`showId` number, `showTime` = `show_time_unix`) | n/a |
| `get_event_cart` | R | **new**: `GET /api/scenes/cart` re-checks a UPI cart older than 3 min before payment; stops when `paymentAvailable=false` (never for FREE carts) | excluded (Swiggy: not part of the normal flow) | 🔍 (needs a cartKey) | n/a |
| `place_event_order` | M | show picker (FREE echo fields / UPI) | n/a | 🔍 (`paymentMethod` enum `UPI`/`FREE`) | n/a |
| `get_payment_options` (needs `cartKey`) / `check_payment_status` / `confirm_order` | R/R*/M | show picker / `PaymentModal` | excluded | 🔍 | `iconUrl` → picker chips |
| `get_event_booking_status` | R | booking cards "Refresh" | Scenes | 🔍 (needs an orderId) | n/a |
| `report_error` | M | show picker | n/a | 🔍 | n/a |

### Mismatches found and fixed in this pass

1. `/api/track` called `get_food_orders` without the **required** `addressId` when none was selected, and passed an
   undeclared `addressId` to `get_food_delivery_status` / `track_food_order`. It also read `track_food_order`'s
   `{orders:[…]}` as if it were one flat order. Fixed (the route is now unused by the UI; History uses
   `/api/history/track`).
2. `get_restaurant_menu` categories are capped at about 10 items (live `hasMoreItems` + `totalItems`). That was silently
   dropped; now surfaced as `MenuCategory.moreItems`.
3. Dineout `offerHeadline.logoUrl` (an official badge image) was dropped by `normalizeRenderRestaurant`. Now kept and shown.
4. `update_food_cart.cutleryOptIn` (it lives on `update_food_cart`, **not** `place_food_order`) was unused. Now exposed.
5. `place_food_order.noteToRestaurant` was supported by the hook but had no input in the UI. Added.
6. Agent compact payloads forwarded Swiggy's session JWT (`tid`/`sid` on `get_food_cart`) to the LLM. Now stripped.
7. Menu pagination: the hook dropped `page`/`hasMore` from `menu` events, so "more categories" only worked through chat.
   Fixed.

### Still impossible (or blocked) after this pass
- Everything in §6 below still applies.
- `get_food_order_details`: the live text content is not visible through the MCP tool display, so the text parser is
  verified on the documented format only.
- `track_order` / `get_delivery_status` / `get_booking_status` / `get_event_booking_status` / `check_payment_status` /
  `get_event_cart` need real ids (no active orders or bookings on the test account), so they are schema-checked only.
- Food/Instamart `get_payment_options` returns `allMethods:[]` with `agenticPaymentEligible:false` for this account, so
  no payment can start until Swiggy enables agentic payments for it. The UI shows "Payment options unavailable".
- Dineout search `filters` / `sortKey`: these need `availableFilters` / `availableSorts` ids, which the text-only search
  doesn't return in structured form, so they are not exposed.
- **Owner decision, unchanged:** the live `place_food_order` and `checkout` descriptions both say *"NO CART-VALUE LIMIT … do
  NOT refuse, warn about, or gate"*. Swizzo still enforces `FOOD_ORDER_CAP` (₹1000) in the Food prompt and
  `FoodCartPanel`. Real data says remove it.

---

## 1. Food (Swiggy delivery), 20 live tools

| Tool | Kind | What it does | Where in Swizzo | Status |
| --- | --- | --- | --- | --- |
| `search_restaurants` | R | Restaurants by name or cuisine near an address | agent → `foodRestaurants` cards | ✅ |
| `get_restaurant_menu` | R | Paginated menu by category | agent; `FoodCustomizer` / `MenuList` | ✅ |
| `search_menu` | R | Dishes with variants and add-ons, across restaurants or scoped to one | `/api/dishes` (DISHES marker); agent (scoped) | ✅ |
| `get_food_cart` | R | The cart with bill, `valid_addons` and coupon hint | `/api/food-cart` → `FoodCartPanel` | ✅ |
| `update_food_cart` | M | Add or update items (variants, add-ons) | `/api/food-cart` (add/inc/dec/set, `cutlery`) | ✅ (`cutleryOptIn` → "Send cutlery" toggle) |
| `flush_food_cart` | M | Empty the cart | `/api/food-cart` `action:"clear"`; also used in the update-then-flush fallback | ✅ |
| `fetch_food_coupons` | R | Coupons applicable to the cart | `/api/food-cart` `action:"coupons"` → **"All coupons" list in `FoodCartPanel`** (new); best coupon also shown one-tap | ✅ |
| `apply_food_coupon` | M | Apply a coupon code | `/api/food-cart` `action:"coupon"` (best coupon, a listed one, or a **typed code**, new) | ✅ |
| `place_food_order` | M | Place the order (Cash / UPI / SwiggyPay) | `/api/food-cart` `action:"place"`; `PaymentModal`; gated | ✅ |
| `get_payment_options` | R | Live payment methods | `/api/payments/options`, `/api/food-cart` | ✅ |
| `check_payment_status` | R* | Poll a UPI payment | `/api/payments/status` (`PaymentModal`) | ✅ |
| `confirm_order` | M | Finalise a UPI order | `/api/payments/confirm` | ✅ |
| `get_food_orders` | R | Order history across all addresses | agent → **all orders** in `OrderHistoryCard`; `/api/track`, `/api/food-usuals` | ✅ |
| `get_food_order_details` | R | Full order: items, variants, bill, payment, address | **new:** agent tool + `/api/orders/details` + "Details" toggle on each Food order in `OrderHistoryCard` | ✅ (see note 1) |
| `track_food_order` | R | Live status + ETA (+ trackUrl) | agent; `/api/track` | ✅ |
| `get_food_delivery_status` | R | ETA for the success widget (Swiggy calls it "internal") | `/api/track`; agent | ✅ |
| `get_addresses` | R | Saved addresses (paginated) | `/api/addresses`, `/api/auth/status` → `AddressPicker` | ✅ |
| `create_address` | M | Add an address | `/api/addresses/create` POST → `CreateAddressModal` | ✅ |
| `delete_address` | M | Delete an address | `/api/addresses/create` DELETE → **"Delete" + confirm in `AddressPicker`** (new) | ✅ |
| `report_error` | M | Log an error report, returns a mailto link | **new:** `/api/report-error` → `ReportProblemButton` | ✅ |
| `recommend_address` | n/a | (docs only) | n/a | 🚫 not on the live server |

*`check_payment_status` is a read, but with `finalize` it can confirm. Swizzo never sets `finalize`.

Note 1: on the live server, `get_food_order_details` returns an **empty `structuredContent`** with the detail in the text
content. The parser (`mapFoodOrderDetails`, `src/backend/mcp/food-mcp.ts`) handles both the documented `data.order` body
and the text-only case. In the text-only case it shows Swiggy's text verbatim. The text-only branch was verified against
synthetic input; the exact live text could not be captured because the on-disk token had expired.

---

## 2. Instamart (groceries), 16 live tools

| Tool | Kind | What it does | Where in Swizzo | Status |
| --- | --- | --- | --- | --- |
| `search_products` | R | Products and variants (paginated) | agent; `/api/search` → `ProductGrid` | ✅ |
| `your_go_to_items` | R | Frequently bought items | agent; `/api/usuals` → `UsualsBoard` | ✅ |
| `get_cart` | R | Cart and bill | `/api/cart`, `/api/checkout` → `CartPanel` | ✅ |
| `update_cart` | M | Replace the cart with the full desired list | `/api/cart` | ✅ |
| `clear_cart` | M | Empty the cart | `/api/cart` | ✅ |
| `checkout` | M | Place the order (Cash / UPI / SwiggyPay) | `/api/checkout`; `PaymentModal`; gated | ✅ |
| `get_payment_options` / `check_payment_status` / `confirm_order` | R/R*/M | UPI payment stage | `/api/payments/*` | ✅ |
| `get_orders` | R | Orders from the last 15 days | agent → `OrderHistoryCard`; `/api/orders`, `/api/track`, `/api/usuals` | ✅ |
| `track_order` | R | Primary live tracking (status, ETA, partner, items); needs lat/lng | `/api/track`; **new agent tool** (uses the order's own coordinates from `get_orders`, else the selected address's) | ✅ |
| `get_delivery_status` | R | ETA for the success widget ("internal") | `/api/track`, `/api/orders`; agent (fallback) | ✅ |
| `get_addresses` / `create_address` / `delete_address` | R/M/M | Shared address book | as in Food | ✅ |
| `report_error` | M | Error report | `/api/report-error` | ✅ |
| `list_coupons` | n/a | (docs only) | was an agent tool that would always fail, **removed** | 🚫 not on the live server |
| `apply_coupon` | n/a | (docs only) | `applyCoupon()` exists in `swiggy-mcp.ts` but nothing calls it | 🚫 not on the live server |
| `get_order_details` | n/a | (docs only) | was an agent tool, **removed**; `/api/orders/details?service=instamart` answers honestly | 🚫 not on the live server. `get_orders` already returns items, total and status |
| `recommend_address` | n/a | (docs only) | n/a | 🚫 not on the live server |

---

## 3. Dineout (table reservations), 11 live tools

| Tool | Kind | What it does | Where in Swizzo | Status |
| --- | --- | --- | --- | --- |
| `search_restaurants_dineout` | R | Text-only search results (rate-limited, about 7 calls before a 429) | agent (capped at 2 per turn, cached); `/api/dineout/search` | ✅ |
| `render_restaurants_dineout` | R | **Live-only (undocumented)**: photo cards for chosen ids | `fetchDineoutToolPayload` → `DineoutRestaurantCard` | ✅ |
| `get_restaurant_details` | R | Ratings, deals, timings, amenities, menu images | agent; `/api/dineout/details` → `DineoutDetailsSheet` | ✅ |
| `get_available_slots` | R | 7 days of slots; free and paid deals (in `_meta.slots`) | agent; `/api/dineout/search` → `DineoutSlotPicker` | ✅ |
| `create_cart` (`DEAL_TICKET_PURCHASE`) | M | Paid-deal booking cart | `/api/dineout/cart` → slot picker summary | ✅ |
| `create_cart` (`DINEOUT`, bill payment) | M | Bill-payment cart | n/a | 🚫 no tool completes a bill payment (`book_table` needs a slot) |
| `book_table` | M | Free booking, or paid via UPI with `cartKey` | `/api/dineout/book`; gated | ✅ |
| `get_payment_options` / `check_payment_status` / `confirm_order` | R/R*/M | UPI for paid deals | `/api/payments/*` | ✅ |
| `get_booking_status` | R | Status of one booking by orderId | agent; `/api/dineout/booking` GET (now also returns `canCancel`); `/api/bookings` ("my bookings"); **"Refresh status" on every booking card** (new) | ✅ |
| `report_error` | M | Error report | `/api/report-error`; **"Report a problem" in `DineoutSlotPicker` errors and on booking cards** (new) | ✅ |
| `cancel_booking` | n/a | (docs only for this account) | `/api/dineout/booking` POST `action:"cancel"` + **"Cancel booking" → "Cancel booking #id?" confirm on booking cards** (new). The route checks `tools/list` first; when the tool is missing it returns `unavailable:true` with "Cancel it in the Swiggy Dineout app or call customer care at 080-67466729" instead of making a call that can't succeed | 🚫 for this account today. ✅ automatically if Swiggy enables it |

---

## 4. Scenes (events and tickets), 15 live tools

| Tool | Kind | What it does | Where in Swizzo | Status |
| --- | --- | --- | --- | --- |
| `discover_events` | R | Events and genre chips near you | agent (with keyword-search fallback); `/api/scenes/search` | ⚠️ **returns empty server-side** (see §8). The fallback keeps the feature working |
| `get_events_collection` | R | Full listing for one genre chip | agent; genre chips in `MessageBubble` | ⚠️ chips only exist if `discover_events` returns some, so this is dormant today |
| `search_events` | R | Up to 4 auto-suggestions for an artist or show; all cities | agent (kept to the user's city); `/api/scenes/search`; **new: optional `addressId`** | ✅ |
| `get_event_details` | R | venueId, address, next date, price | agent; `/api/scenes/search` | ✅ |
| `list_event_shows` | R | Shows, ticket tiers, seats | agent; `/api/scenes/cart` → `ScenesShowPicker` | ✅ |
| `get_event_venue_info` | R | Venues + event metadata (browsing). **Requires lat/lng live** ("empty location context" otherwise) | **new agent tool**: coordinates injected, mapped to event cards per venue (`mapEventVenueInfo`) | ✅ |
| `get_saved_locations` | R | Saved addresses for "near my home / office" | **new agent tool** → pass the id to `search_events` | ✅ |
| `create_event_cart` | M | Cart; returns `checkoutMode` FREE / UPI / UNAVAILABLE | `/api/scenes/cart` → picker review step | ✅ |
| `get_event_cart` | R | "Compatibility lookup". Swiggy: *"the normal flow does not call this"* | `GET /api/scenes/cart`: re-checks a stale UPI cart before payment (see §0b) | ✅ |
| `place_event_order` | M | FREE, or UPI (no Cash on Scenes) | `/api/scenes/order`; gated | ✅ |
| `get_payment_options` (needs `cartKey`) / `check_payment_status` / `confirm_order` | R/R*/M | UPI | `/api/payments/*`, `/api/scenes/order` | ✅ |
| `get_event_booking_status` | R | Status of one ticket order | agent; `/api/scenes/order`; `/api/bookings`; **"Refresh status" on booking cards** (new) | ✅ |
| `report_error` | M | Error report | `/api/report-error`; **"Report a problem" in `ScenesShowPicker` errors** (new) | ✅ |

---

## 5. What you can do in Swizzo

**Food**
- Find dishes across restaurants, browse a menu, customise variants and add-ons, and keep one cart per restaurant (others
  can be parked).
- See applicable coupons, apply the best one, any listed one, or a typed code. A saving shows only when Swiggy confirms
  a discount.
- Pay with Cash (COD), UPI (intent app or desktop QR) or Swiggy Money, whichever Swiggy offers. Add a note to the
  restaurant.
- Order history (all orders), full order details (items, bill, payment, address), live tracking, reorder from history.

**Instamart**
- Search, your usuals, a full cart with bill, ingredient and recipe basket building, and checkout (Cash / UPI / Swiggy
  Money).
- Orders from the last 15 days, live tracking (status, ETA, partner).

**Dineout**
- Search with photo cards, restaurant details, 7-day slots with free and paid deals.
- Book free tables, or paid deals via UPI.
- Booking status: refresh on the card, "my bookings" for bookings made in this app, and Cancel (when Swiggy allows it).

**Scenes**
- Search events by artist or keyword (kept to your city), genre browsing through the keyword fallback, event and venue
  info.
- Show times and ticket tiers; book free tickets, or pay for paid ones by UPI. Booking status with refresh.

**Everywhere**
- Add and delete delivery addresses.
- "Report a problem" on Swiggy errors (`report_error`, with the error's `reportId`).
- Plan tab: cross-service itineraries built from discovery tools only.

---

## 6. What you can't do via the MCP (only in the Swiggy app or customer care)

Each item below is checked against the live tool list and the tool descriptions.

| You want to… | Why not here | What to do instead |
| --- | --- | --- |
| **Cancel a Food or Instamart order** | No cancel tool. The tool descriptions say *"do NOT call any tool… call 080-67466729"* | Swiggy customer care **080-67466729** |
| **Modify a placed order** (add or remove items, change the address) | No tool for it | Swiggy app / customer care |
| **Cancel a Dineout booking** (this account) | `cancel_booking` is documented but not in the live `tools/list` | Swiggy Dineout app or 080-67466729. Swizzo's Cancel button uses it automatically once Swiggy enables it |
| **Cancel or transfer Scenes tickets** | No cancel tool on Scenes | Swiggy app |
| **List Dineout / Scenes bookings made outside Swizzo** | No list-bookings tool; status lookup needs an orderId | Swizzo stores the bookings *it* makes ("my bookings"). Others are only in the Swiggy app |
| **Instamart coupons** | `list_coupons` and `apply_coupon` are not live | Swiggy app |
| **Instamart order details** beyond the `get_orders` summary | `get_order_details` is not live | Swiggy app |
| **Pay a restaurant bill (Dineout "Pay bill")** | `create_cart(DINEOUT)` exists, but no tool completes the payment | Swiggy app |
| **Rate or review** orders, restaurants, dishes or delivery partners | No ratings or reviews tool | Swiggy app |
| **Tip or chat with / call the delivery partner**, or edit delivery instructions | No tool. `track_order` reports the partner only as status | Swiggy app |
| **Use saved cards, net banking, other wallets, BNPL or UPI Collect (VPA)** | Only what `get_payment_options` returns: UPI intent/QR, Cash where offered, Swiggy Money where `available`. UPI Collect is deliberately not surfaced (NPCI) | Swiggy app |
| **Buy or manage Swiggy One**, top up Swiggy Money, check the balance | No tool | Swiggy app |
| **Refunds, complaints, help chat** ("missing item", "wrong order") | No tool. `report_error` reports *integration* errors to the MCP team, not order complaints | Swiggy app help / 080-67466729 |
| **Scheduled orders, group orders, Genie / Minis / other Swiggy verticals** | Not in any of the 4 servers | Swiggy app |
| **Instamart Print** (`add_print_to_cart`) | Mentioned in `update_cart`'s text but not exposed | Swiggy app |
| **Non-veg-only Food filter** | `search_menu` has only `vegFilter=1` | Swizzo shows mixed results and says so |
| **Guest (logged-out) ordering** | The servers support guest *search*; carts and orders need OAuth | Log in |

---

## 7. Platform limits

| Area | Limit / rule | How Swizzo handles it |
| --- | --- | --- |
| OAuth | PKCE + DCR; the redirect URI must be **exact-match allowlisted** by Swiggy (no wildcards, so preview deployments fail at `/authorize`) | `docs/swiggy-mcp/PRODUCTION-ACCESS.md` has the allowlist request; set `APP_BASE_URL` / `SWIGGY_OAUTH_REDIRECT_URI` |
| Token life | Access token from the code: **5 days**. After a refresh: **30 days** (`expires_in`; refresh tokens rotate). Session: 30 days idle (sliding). Auth code: 120 s, single use. An expired token **can't** be refreshed | Encrypted httpOnly session; proactive refresh at ≤60 s; one forced refresh on 401 / -32001, then "log in again" |
| Food order value | Docs: **₹1000 cap** for Builders Club orders. ⚠️ The live `place_food_order` description now says *"NO CART-VALUE LIMIT… relay the error instead"* | Swizzo still enforces ₹1000 (`FOOD_ORDER_CAP`, food prompt, `FoodCartPanel`). **Owner decision:** keep it, or remove it and rely on Swiggy's error |
| Payment methods | Offer only what `get_payment_options` returns. COD on Food and Instamart when `cod` is present. **Scenes never Cash**. Dineout: UPI or free. Swiggy Money only when `available` (Food, Instamart). Never ask for a VPA | Implemented in `PaymentModal`, `DineoutSlotPicker`, `ScenesShowPicker` |
| UPI flow | Place → `PENDING_PAYMENT` → poll `check_payment_status` (no tight loop) → `confirm_order` on success or at the timeout cap; never on FAILED or REFUND | `PaymentModal` owns the poll loop (headless client) |
| Rate limits | No published caps or `X-RateLimit` headers. Gateway `429` + `Retry-After`. Dineout search returns 429 after about 7 calls. Peak hours are 12–14 and 19–22 IST | Retries only idempotent tools and honours `Retry-After`. Dineout search capped at 2 per turn and cached. Tracking polls ≥10 s |
| Idempotency | Order, booking, cart-create, address, coupon and `report_error` calls are never auto-retried. On an ambiguous failure, read state before claiming success | `NON_IDEMPOTENT_TOOLS` in `client.ts`; check-then-report in the place-order routes |
| Errors | `{success:false, error:{message, reportId}}` arrives with HTTP 200. There is no symbolic error code | `SwiggyToolError` keeps `reportId`; the user sees Swiggy's own message and can report it |
| Ordering gate | `SWIGGY_ENABLE_ORDERS=true` is required for place / book / cancel / pay | All mutating order routes |
| Branding | "Powered by Swiggy / Instamart / Dineout" next to each service's content at every step | `PoweredBy` + card footers |
| Data | India-only. Saved-address coordinates are never exposed by `get_addresses` | Coordinates come from Swiggy responses, or a default city centre for Dineout/Scenes |

---

## 8. Known server-side issues (as of 2026-10-22)

1. **`discover_events` (Scenes) returns nothing** for Bangalore, Koramangala and Mumbai, and with `addressId` too. So
   genre chips and `get_events_collection` never appear. Swizzo falls back to a keyword `search_events` in your city
   (`agentDiscoverWithFallback`).
2. **`search_events` ignores location**: it returns events from every city (now up to 30, not the documented 4). Swizzo
   filters to your city when anything matches there.
3. **`get_event_venue_info` fails without coordinates** ("empty location context", HTTP 400), and it ignores the
   `showStartTime`/`showEndTime` window. Swizzo always passes lat/lng.
4. **Dineout search is text-only**. Cards need the undocumented `render_restaurants_dineout`, and slots live in the raw
   result's `_meta.slots`, not in `structuredContent`.
5. **Empty `structuredContent` (`{}`)** on `get_food_order_details` and `search_restaurants_dineout`: the data is in the
   text content (handled in `coerceToolPayload`).
6. **Documented but not live**: Instamart `list_coupons` / `apply_coupon` / `get_order_details` / `recommend_address`,
   Food `recommend_address`, Dineout `cancel_booking`.
7. **Instamart `get_cart` binds a SHORT address id** (`db7kh1…`), while `get_addresses` returns the long one
   (`db7kh1…__AMVE…`). Compare them with `sameAddressId()`.
8. **Scenes returns no images anywhere**. Swizzo uses generated genre artwork, clearly not a photo.
9. **The `place_food_order` description contradicts the docs on the ₹1000 cap** (see §7).

---

## 9. What changed in this pass (files)

- `src/backend/mcp/client.ts`: `hasTool(serverUrl, name)` checks the live `tools/list`, cached for 10 min per
  user+server.
- `src/backend/mcp/dineout-mcp.ts`: `dineoutCanCancel()`, `DineoutCancelUnavailableError`. `cancelDineoutBooking` checks
  availability first.
- `src/app/api/dineout/booking/route.ts`: GET returns `canCancel`. POST returns `unavailable:true` with the app/phone
  fallback.
- `src/app/api/report-error/route.ts` (new): `report_error` on the right server.
- `src/backend/mcp/food-mcp.ts`: `mapFoodOrderDetails`, `getFoodOrderDetails`. `src/shared/types.ts`: `OrderDetails`.
- `src/app/api/orders/details/route.ts` (new): Food order details; Instamart answers honestly that it's unavailable.
- `src/app/api/food-cart/route.ts`: `action:"coupons"` lists applicable coupons.
- `src/backend/mcp/swiggy-mcp.ts`: `instamartOrderCoords()` for `track_order`.
- `src/backend/mcp/scenes-mcp.ts`: `mapEventVenueInfo()`.
- `src/backend/agent/tools.ts`:
  - added Food `get_food_order_details`, Instamart `track_order`, Scenes `get_event_venue_info` and
    `get_saved_locations`, and `addressId` on `search_events`;
  - **removed** Instamart `get_order_details` and `list_coupons` (not live);
  - `injectedArgs` handles `track_order` lat/lng and `get_event_venue_info` coordinates.
- `src/backend/agent/agent.ts`: status labels, plus a `get_event_venue_info` → event-card mapping.
- `src/backend/agent/services.ts`: `READ_TOOLS` / `MUTATING_TOOLS` match the live inventory; the Instamart, Food,
  Dineout and Scenes prompts are updated.
- UI:
  - `features/BookingTrackerCard.tsx` (new: refresh, cancel with confirm, report);
  - `features/OrderHistoryCard.tsx` (new: Food "Details");
  - `features/ReportProblemButton.tsx` (new);
  - `chat/MessageBubble.tsx` uses the two cards;
  - `cart/FoodCartPanel.tsx` ("All coupons" + code box);
  - `navigation/AddressPicker.tsx` + `TopNav.tsx` (delete address with confirm);
  - `catalog/DineoutSlotPicker.tsx` + `catalog/ScenesShowPicker.tsx` ("Report a problem").
- `src/frontend/hooks/useSwiggyChat.ts`: `applyBestCoupon(code?)`, `listFoodCoupons`, `removeDeletedAddress`.
  `src/app/page.tsx` wires them.
