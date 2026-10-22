# Food MCP: field-level audit

Captured live on **2026-10-22** from `mcp.swiggy.com/food` (address `d1k9ctrdq1ocsktt0090__…` Bengaluru,
New Tippasandra). Raw captures are in `docs/swiggy-mcp/live/food_*.json` (long arrays trimmed, values
unchanged). Assertions for every 🆕 field are in `scripts/verify-food-instamart.ts`, section "Food field audit".

Status: ✅ already used · 🆕 used as of this audit · ⏭ deliberately unused (reason given).

Only read-only tools were called. Mutating tools (`update_food_cart`, `flush_food_cart`, `apply_food_coupon`,
`place_food_order`, `confirm_order`, `create_address`, `delete_address`, `report_error`) were not called. So the
**non-empty** `get_food_cart` / coupon / active-tracking shapes come from `docs/swiggy-mcp/food.md` and are
marked *(doc)*.

Main code paths:
- **parser**: `src/backend/mcp/food-mcp.ts`
- **history**: `src/backend/history/history-map.ts`
- **UI**: `catalog/FoodRestaurantCard.tsx`, `catalog/MenuList.tsx`, `catalog/FoodCustomizer.tsx`,
  `cart/FoodCartPanel.tsx`, `features/OrderHistoryCard.tsx`, `features/OrderTracker.tsx` + `LiveOrderTracker.tsx`,
  `history/HistoryOrderCard.tsx`
- **model**: `src/backend/agent/runner.ts` `summarize()`

---

## search_restaurants
Queries run: `biryani` (329 restaurants), `pizza` (102), `KFC` (23 total; mostly burger chains, plus KFC itself).

| Field | Example | Meaning | Where used | Status |
| --- | --- | --- | --- | --- |
| `restaurants[].id` | `"41795"` | restaurant id | `normalizeFoodRestaurant` → card, menu, cart | ✅ |
| `restaurants[].name` | `"Meghana Foods (Ad)"` | name; **" (Ad)" suffix = promoted listing** | `splitSponsored()` strips the suffix → `name`, sets `sponsored`; "Ad" tag on `FoodRestaurantCard` and the menu header; model sees `ad (promoted)` | 🆕 (sponsored) |
| `restaurants[].cuisines[]` | `["Biryani","Andhra"]` | cuisines | card line; summary | ✅ |
| `restaurants[].avgRating` | `4.5` | rating | card chip; summary | ✅ |
| `restaurants[].totalRatings` | `"129K+"` | rating count | card chip `(129K+)`; **summary now includes it** | ✅ / 🆕 (model) |
| `restaurants[].costForTwo` | `"₹500 for two"` | price level | **card chip**; summary | 🆕 |
| `restaurants[].areaName` | `"Indiranagar"` | locality | **card line**; summary | 🆕 |
| `restaurants[].distanceKm` | `0.4` | distance | card chip (coral "away" when > 5 km); summary | ✅ |
| `restaurants[].deliveryTimeMinutes` | `41` | ETA, minutes | fallback for `etaRange`; `deliveryMinutes` | 🆕 |
| `restaurants[].deliveryTimeRange` | `"35-45 MINS"` | ETA range | card chip; summary | ✅ |
| `restaurants[].imageUrl` | CDN URL | photo | card hero (backfill via `/api/images/restaurant`) | ✅ |
| `restaurants[].availabilityStatus` | `"OPEN"` | OPEN / CLOSED / UNAVAILABLE | dimmed card + disabled CTA; summary `status=` | ✅ |
| `restaurants[].nextOpenTime` *(doc)* | – | next opening | card "Opens …"; summary | ✅ |
| `restaurants[].offer` *(doc)* | – | offer text | amber badge on card | ✅ (not returned live) |
| `restaurants[].veg` *(doc)* | – | pure-veg restaurant | **"Pure veg" badge**; summary | 🆕 (not returned live) |
| `dishes[]` | `[]` | matching dishes | `mapRestaurantDishes` (dish fallback in `/api/dishes`) | ✅ (always empty live) |
| `dishes[].category` *(doc)* | – | menu category | `MenuItem.category` → shown next to the rating | 🆕 |
| `dishes[].restaurantRating / restaurantAreaName / deliveryTimeMinutes` *(doc)* | – | restaurant facts | – | ⏭ never returned live (dishes always `[]`); search_menu covers dishes |
| `total`, `totalDishes` | `10`, `0` | page size / dish count | – | ⏭ page bookkeeping |
| `totalRestaurants` | `329` | all matches | – | ⏭ no restaurant paging UI; cards show the top 10 |
| `hasMore`, `nextOffset` | `true`, `10` | restaurant pagination | – | ⏭ the model can re-call with `offset`; no "more restaurants" button yet |
| `query` | `"biryani"` | echo | – | ⏭ echo of our input |

## get_restaurant_menu
Calls: Behrouz `41795` (page 1 and page 2, pageSize 3) and Domino's `264701` (pageSize 8, 27 categories).
No nested `subcategories[]` showed up live; the parser still flattens them as "Parent · Sub".

| Field | Example | Meaning | Where used | Status |
| --- | --- | --- | --- | --- |
| `restaurant.id`, `.name` | `"41795"`, `"Behrouz Biryani"` | restaurant | `normalizeMenu` | ✅ |
| `restaurant.imageUrl` | CDN URL | photo | **menu header photo** (`RestaurantHeader` in `MenuList`); `/api/images/restaurant` backfill | ✅ / 🆕 |
| `restaurant.avgRating` / `avgRatingString` | `4.1` / `"4.1"` | rating | **header** `★ 4.1`; summary. The string copy is only a fallback | 🆕 |
| `restaurant.totalRatingsString` | `"5.3K+ ratings"` | rating count | **header `(5.3K+)`**; summary | 🆕 |
| `restaurant.costForTwoMessage` | `"₹500 for two"` | price level | **header**; summary | 🆕 |
| `restaurant.slaString` | `"20-25 MINS"` | delivery SLA | **header**; summary | 🆕 |
| `restaurant.deliveryTime` | `27` | minutes | `deliveryMinutes` / SLA fallback | 🆕 |
| `restaurant.cuisines[]` | `["Biryani","North Indian"]` | cuisines | **header** | 🆕 |
| `restaurant.areaName`, `.city` | `"New Tippasandra"`, `"Bangalore"` | locality | **header**; summary | 🆕 |
| `restaurant.address` | `"Maruti Sankeerna, … 560075"` | street address | **header** (Swiggy's double commas cleaned) | 🆕 |
| `restaurant.isOpen` | `true` | open now | Open/Closed pill; closed-menu text in `openMenu`; summary `open/CLOSED` | ✅ / 🆕 |
| `categories[].title` | `"Recommended"` | category | section caption | ✅ |
| `categories[].categoryId` | `"40057453"` | category id | `MenuCategory.categoryId` | 🆕 (carried; the "N more" search goes by title) |
| `categories[].totalItems` | `13` | dishes in the category | **caption "· 13 dishes"**; summary `Categories: X (13, 3 not shown)` | 🆕 |
| `categories[].hasMoreItems` | `true` | capped at 10 | "N more in <category>" button (scoped search_menu) | ✅ |
| `categories[].subcategories[]` | – | nested categories | flattened "Parent · Sub" | ✅ (none live) |
| `items[].id/name/price` | `"193068246"`, …, `369` | dish | row; ADD marker id | ✅ |
| `items[].isVeg` | `false` | veg flag | veg mark | ✅ |
| `items[].isBestseller` | `true` | bestseller | "Bestseller" badge; summary | ✅ |
| `items[].rating` | `"4.1"` | dish rating | ★ chip; **summary now carries it** | ✅ / 🆕 (model) |
| `items[].inStock` | `1` | availability | "Sold out", sorted last; summary | ✅ |
| `items[].hasVariants/hasAddons` | `true` | customisable | opens `FoodCustomizer` (scoped search_menu) | ✅ |
| `items[].description` | `"Contains milk, gluten…"` (allergens) | description | 2-line clamp on the row, macros parsed; **summary now passes 60 chars (allergens!)** | ✅ / 🆕 (model) |
| `items[].imageUrl` | CDN URL | dish photo | row thumb + Lightbox | ✅ |
| `totalCategories` | `8` / `27` | category count | **header "8 menu categories"**; summary | 🆕 |
| `page`, `pageSize`, `hasMore` | `2`, `3`, `true` | category paging | "More categories" button; summary | ✅ (`pageSize` ⏭: our own input) |

## search_menu
Calls: cross-restaurant `paneer biryani` (`vegFilter=1`, 422 matches), `chicken biryani` `offset=10`
(`nextOffset 20`), and scoped `biryani` @ Behrouz (`restaurantIdOfAddedItem=41795`, 137 matches).

| Field | Example | Meaning | Where used | Status |
| --- | --- | --- | --- | --- |
| `items[].menu_item_id`, `name`, `price` | `"193068246"`, …, `369` | dish | `normalizeSearchMenuItem` | ✅ |
| `items[].isVeg` | `true` / **absent on non-veg** | veg flag | veg mark (absent = non-veg) | ✅ |
| `items[].inStock` | `1` | availability | Sold out | ✅ |
| `items[].imageUrl` | CDN URL | dish photo | row thumb | ✅ |
| `items[].restaurant_id`, `restaurant_name` | `"271"`, `"Meghana Foods"` | dish's restaurant | 🏪 chip; scope for add-to-cart. "(Ad)" stripped | ✅ |
| `items[].rating` | `"4.6"` | dish rating | ★ chip | ✅ |
| `items[].totalRatings` (scoped) | `"36"` | rating count | **★ 4.1 (36)**; summary | 🆕 |
| `items[].hasVariants/hasAddons` | `true` | customisable | customizer | ✅ |
| `items[].variantsV2[].groupId/name` | `"71345439"`, `"Select Portion Size"` | variant group | customizer legend; **model summary `options: … (default) / … +₹430`** (the meal planner picks portions from it) | ✅ / 🆕 (model) |
| `…variations[].id/name/inStock/default` | `"211720438"`, `default:1` | choices | pills; default preselected; sold-out disabled | ✅ |
| `…variations[].price` | `60`, `430` (default has none) | **add-on to the dish price** (₹369 + ₹430 = Serves 2) | **shown as "+₹430"** (`pricesAreAddOns`); **running "About ₹799 each" estimate** | 🆕 |
| `items[].variations[]` (legacy) | – | legacy variants | parsed into groups; price shown as-is (meaning unverified) | ✅ |
| `items[].addons[].groupId/groupName/choices[]` | `"Add an Egg"`, `{id,name,price}` | add-on groups | customizer | ✅ |
| `…minAddons/maxAddons` | `1` / `10` | pick rules | "(pick 1–1)", "(up to 10)"; validation | ✅ |
| `…maxFreeAddons` | `-1` | free picks (-1 = n/a) | **"first N free" + estimate** when > 0 | 🆕 (always -1 live) |
| `totalItems` | `422` / `137` | all matches | **"Swiggy has 422 matches nearby"** on the dish list (`/api/dishes` → `dishGroups[].totalItems`) | 🆕 |
| `hasMore`, `nextOffset` | `true`, `10`/`20` | paging | "More dishes" | ✅ |
| `total`, `query`, `restaurantIdOfAddedItem` | `10`, echoes | bookkeeping | – | ⏭ page size / echoes of our input |

## get_food_cart
Live: **empty** (`data: null`). The non-empty fields below are *(doc)*.

| Field | Example | Meaning | Where used | Status |
| --- | --- | --- | --- | --- |
| `statusCode`, `statusMessage` | `0`, `"CART"` | envelope | – | ⏭ envelope; errors come through `coerceToolPayload` |
| `statusTitle`, `ctaText`, `ctaAction`, `errorCodes` | `null` | error UI hints | – | ⏭ always null live; failures surface as Swiggy's error message |
| `successful` | `true` | envelope | – | ⏭ |
| `tid`, `sid`, `deviceId` | JWT / session | **session secrets** | stripped before the model (`compactPayload`) | ⏭ must never be shown |
| `addressId` | `"d1k9ctrdq1ocsktt0090"` (short form) | bound address | – | ⏭ we already hold the long id |
| `data` | `null` | the cart | `null` → empty cart | ✅ |
| `data.restaurant.id/name` | – | cart restaurant | panel header | ✅ |
| `data.restaurant.area` | – | locality | **"from X · Area"** | 🆕 |
| `data.restaurant.deliverySubtitle` | – | e.g. delivery ETA | **subtitle under the header** | 🆕 |
| `data.items[].menu_item_id/name/quantity/imageUrl/is_veg/in_stock` | – | lines | `CartLineRow` (photo, veg, stepper, out-of-stock) | ✅ |
| `data.items[].final_price/total/subtotal` | – | line totals | per-unit price; **struck-through `subtotal` when > `final_price`** | ✅ / 🆕 |
| `data.items[].variants[]/addons[]` | – | chosen options | line `detail` | ✅ |
| `data.items[].valid_addons[]` | – | add-ons valid for the chosen variant | `mapValidAddons` → `FoodCartLine.validAddons`. **Variant dishes are added variant-first; `/api/food-cart` then keeps only add-ons listed here, AI-picks the required ones (fullest free option) and re-pushes**; the tray's "Customise add-ons" editor offers only these. Fixes Behrouz's 4 per-portion "Choose Accompaniment" copies (live capture `food_search_menu_behrouz_addons.json`) | 🆕 |
| `data.items[].variants[]/addons[]` ids | – | the line's chosen ids | `remoteSelection` → `FoodCartLine.selection` when we have no local one (adopted carts) | 🆕 |
| `data.cart_id`, `data.result`, `data.item_count` | – | bookkeeping | – | ⏭ `itemCount` is the summed quantity |
| `data.pricing.item_total/taxes_and_charges/delivery_charge/to_pay` | – | bill | mini-bill + "Place order · ₹" | ✅ |
| `data.pricing.delivery_charge_strikeoff` | – | delivery fee before discount | **struck-through next to the fee / "Free"** | 🆕 |
| `data.offers.coupon_applied` + `coupon_discount` | – | coupon (applied only when discount > 0) | applied line or "Coupon available" | ✅ |
| `data.offers.free_delivery_applied` | – | free delivery | **"Free" delivery** | 🆕 |
| `availablePaymentMethods`, `paymentOptions`, `gpoError` (outer) | – | payment hints | – | ⏭ `get_payment_options` is the authority (tool description says get_food_cart returns no payment methods) |

## fetch_food_coupons
Live (Meghana `271`, Behrouz `41795`): `coupon_sections: []`, `summary.filter_applied: "COD only"`.

| Field | Example | Meaning | Where used | Status |
| --- | --- | --- | --- | --- |
| `status_message` | `"done successfully"` | envelope | – | ⏭ |
| `coupon_sections[].title` | *(doc)* | section | **`Coupon.section`** label | 🆕 |
| `coupon_sections[].type` | *(doc)* | section type | – | ⏭ no documented values |
| `coupons[].id` | *(doc)* | code (used for apply_food_coupon) | Apply button | ✅ |
| `coupons[].applicable` | *(doc)* | valid for this cart | **automatic best-coupon pass** (`autoCoupon` in `/api/food-cart`: tries up to 3 applicable, keeps the largest real `coupon_discount`, `FoodCart.couponReport` = "Applied X — saves ₹Y" + Swiggy's reason for the rest). Before that: | Applicable ones can be one-tapped. **Non-applicable ones are now listed greyed with "Not yet"** (before, they were dropped) | 🆕 |
| `coupons[].title/description` | *(doc)* | offer text | list rows | ✅ |
| `coupons[].subtitle` | *(doc)* | condition (e.g. "Add ₹120 more") | **amber line under the coupon** | 🆕 |
| `coupons[].ribbon_text` | *(doc)* | ribbon | **ribbon pill** | 🆕 |
| `coupons[].terms_and_conditions.bullet_texts[]` | *(doc)* | T&C | **"Terms" expander** | 🆕 |
| `summary.filter_applied` | `"COD only"` | server filter | **"Swiggy filter: COD only"** in the list (`/api/food-cart` `coupons` → `filter`) | 🆕 |
| `summary.total_coupons/applicable_coupons/sections_count` | `0` | counts | – | ⏭ derivable from the list |

## get_food_orders (`orderCount: 15`; the account has 5 orders)

| Field | Example | Meaning | Where used | Status |
| --- | --- | --- | --- | --- |
| `orders[].orderId` | `"250940466155091"` | id | rows; Details; Track | ✅ |
| `orders[].restaurantId` | `"1058795"` | restaurant | usuals cards, reorder; **`PastOrder.restaurantId`** | ✅ / 🆕 |
| `orders[].restaurantName`, `restaurantAreaName` | `"Bikkgane Biryani"`, `"Tambaram, Kancheepuram"` | where | row title / area; **summary now includes area** | ✅ / 🆕 |
| `orders[].orderTotal` | `"₹341"` | total | row; History "total spent" | ✅ |
| `orders[].orderStatus` / `orderDeliveryStatus` | `"Delivered"` / `"delivered"` (absent on cancelled) | status | status badge / tone | ✅ |
| `orders[].orderType` | `"regular"` | order type | **shown when not "regular"** (chat card + History); summary | 🆕 |
| `orders[].orderedItems` | `"Chicken noodles (1),…"` | summary | row; item count | ✅ |
| `orders[].orderedTime` | `"October 14, 3:11 PM"` | placed at | row | ✅ |
| `orders[].isActiveOrder` | `false` | active | Track button / live tracker | ✅ |
| `actions[].type=…REORDER` + `reorderMeta.orderItems[]` | `itemId, name, variants[{variationId, groupId, name, price}], quantity, subtotal` | reorder lines | History "Reorder" rebuilds the cart | ✅ |
| `reorderMeta.restaurantCoverImageId` | `"RX_THUMBNAIL/…_1058795.JPG"` | cover photo | order row photo; usuals cards | ✅ |
| `reorderMeta.orderItems[].isVeg` / `attributes.vegClassifier` | `"0"` / `"VEG_CLASSIFIER_NONVEG"` | veg | `ReorderItem.veg` | ✅ |
| `reorderMeta.orderItems[].total`, `packingCharges` | `"438"`, `"19"` | line incl. packing | – | ⏭ historical prices; Swiggy re-prices the cart on reorder |
| `reorderMeta.orderItems[].categoryDetails` | `{category, subCategory:"nota"}` | menu category | – | ⏭ informational; often `"nota"` |
| `…variants[].externalChoiceId/externalGroupId/variantTaxCharges/variantTaxExpressions/gstDetails/attributes`, `attributes.portionSize` | `"1281003915"`, `{gst:"0.0"}` | POS / tax plumbing | – | ⏭ internal; not user-facing |
| `actions[].type=…RATE_DELIVERY/RATE_ORDER/RATE_FOOD` + `title` | `"RATE DELIVERY"` | rating CTAs | **"★ Rate delivery — rate it in the Swiggy app"** (chat card + History). The model is told the same. There is **no rating tool** | 🆕 |
| `rateDeliveryMeta.ratingType/rateAll/ratingTitle` | `"delivery"`, `true`, `"Not available"` | rating meta | – | ⏭ no rating tool; `ratingTitle` is always "Not available" |
| `actions[].priority/isEnabled` | `1` / `true` | CTA order / enabled | disabled CTAs are skipped | ✅ |
| `total` | `5` | count | card header count | ✅ |

## get_food_order_details (`orderId 250940466155091`)
Live: `structuredContent` is `{}` and the detail is **text-only**. The MCP tool display here doesn't show
`content[].text`, so its lines can't be captured from this session. `parseFoodOrderDetailsText` handles every
line kind of the documented text form:

| Line | Example | Where used | Status |
| --- | --- | --- | --- |
| `Order <id> — <restaurant> (<area>)` | `Order 2448… — Isha Fast Food (Viralimalai)` | title / area | ✅ |
| `<status> \| <orderType>` | `Delivered \| regular` | status | ✅ (type: ⏭ already on the order row) |
| `Placed: …` | `2026-08-04 13:37:52` | "Placed" (History) and **now also in the chat Details** | ✅ / 🆕 |
| `Items (n):` + `- name — ₹x \| Veg [image: url]` | – | item rows with **photo**, veg dot, price | ✅ |
| indented continuation | `Serves 2 - 1000ml ₹419` | customizations | ✅ |
| `Delivery address:` / `Total paid:` / `Payment:` / `Coupon:` | – | details footer | ✅ |
| *(doc)* `data.order.charges{}`, `coupon_discount`, `is_cancellable`, `order_items[].image_id` … | – | structured fallback `mapFoodOrderDetails` | ✅ |
| *(doc)* `confirmed_time`, `customer_id`, `restaurant_address`, `restaurant_cuisine`, `is_reorderable_order`, `item_total`/`order_tax`/`order_discount` | – | – | ⏭ never returned live (text-only); `charges{}` already covers the bill lines |

## track_food_order / get_food_delivery_status

| Field | Example | Meaning | Where used | Status |
| --- | --- | --- | --- | --- |
| `track_food_order.orders` | `[]` (no active order) | active orders | `trackerFromTrackFoodOrder` | ✅ |
| `statusMessage` | `"Tracking information retrieved successfully"` | envelope | – | ⏭ |
| *(doc)* `orders[].orderStatus/title/subtitle/etaText` | – | status | tracker card | ✅ |
| *(doc)* `orders[].progressPercentage` | `"40"` | progress | **progress bar** (`OrderTracker`, History track panel); summary `40% done` | 🆕 |
| *(doc)* `orders[].pollingDuration` | `"5"` | poll cadence | **`/api/track` + `/api/history/track` `pollIntervalSec`** (clamped ≥ 10 s) → `LiveOrderTracker` | 🆕 |
| *(doc)* `orders[].trackUrl` / text link | `https://www.swiggy.com/track-order/<id>` | Swiggy tracking page | **"Track on Swiggy ↗"** on the chat tracker; History "Open Swiggy tracking"; summary | 🆕 (chat) / ✅ (History) |
| *(doc)* `orders[].icon`, `businessLine` | – | decoration | – | ⏭ not user-relevant |
| `get_food_delivery_status.orderId` | `"250940466155091"` | id | tracker `items` "Order #…" | 🆕 |
| `.deliveryBy`, `.serverNow` | `null`, epoch ms | absolute ETA | "N mins" ETA | ✅ |
| `.delivered`, `.cancelled`, `.statusText` | `true`, `false`, `"Delivered"` | terminal state | status; stops polling | ✅ |
| `.pollIntervalSec` | `45` | cadence | live poll cadence (now on `/api/track` too) | ✅ / 🆕 |
| `.trackUrl` | `https://www.swiggy.com/track-order/250940466155091` | tracking page | **tracker link**; summary | 🆕 |
| resource link (content) | `[Resource link: Track order …]` | same URL | covered by `trackUrl` | ✅ |

## get_payment_options (empty cart)

| Field | Example | Where used | Status |
| --- | --- | --- | --- |
| `allMethods` | `[]` | `mapPaymentOptions` → `PaymentModal` (nothing invented when empty) | ✅ |
| `agenticPaymentEligible` | `false` | `mapPaymentOptions` | ✅ |
| `paymentAmount` | `null` | `mapPaymentOptions` | ✅ |
| `addressId` | `"d1k9ctrdq1ocsktt0090"` | – | ⏭ echo (short form) |
| `placeOrderToolName` | `"place_food_order"` | `mapPaymentOptions` | ✅ |

## get_addresses
This is the address book Food shares with Instamart. Every field (`id`, `addressLine`, `phoneNumber` masked,
`addressCategory`, `addressTag`, `pagination`, `resolution.*`) is audited and used by the Instamart owner:
`mapAddressPage` in `swiggy-mcp.ts`, see `fields/instamart.md`. Food reads the selected address id from there.
