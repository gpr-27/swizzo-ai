# Instamart: field-level audit (live, 2026-10-22)

Every field the live Instamart MCP server (`mcp.swiggy.com/im`) returned to the read-only tools, called for the
Bengaluru address `d1k9ctrdq1ocsktt0090__AMXrgASg728rGDWKq4_ky_` (and the account's own cart, orders and payment options).
Queries: `eggs`, `paneer`, `lays chips` (with `offset=1`), `something for a headache` (vague), plus `your_go_to_items`.

Captured payloads (trimmed arrays, values unchanged) live in `docs/swiggy-mcp/live/`:
`im_search_products_eggs.json`, `im_search_products_vague.json`, `im_search_products_offset1.json`,
`im_search_products.json` (paneer), `im_your_go_to_items.json`, `im_get_addresses.json`, `im_get_cart.raw.json`
(full cart), `im_get_cart_empty.json`, `im_get_orders.raw.json`, `im_get_payment_options.json`,
`im_get_payment_options_emptycart.json`. Assertions for every field marked ✅/🆕 below are in
`scripts/verify-food-instamart.ts` (section "Instamart field audit").

Status: ✅ already shown or used · 🆕 added in this pass · ⏭ intentionally unused (reason given).

Not called: `get_delivery_status` and `track_order` both need an orderId, and `get_orders` returned no orders in the
last 15 days. Their parsers (`imTrackerFromDeliveryStatus`, `imTrackerFromTrackOrder`) still follow the documented shapes.
Mutating tools were never called.

---

## search_products / your_go_to_items (same product shape)

| Field path | Example | Meaning | Where the app uses it | Status |
| --- | --- | --- | --- | --- |
| `nextOffset` | `"1"` → `"2"` with `offset=1`; go-to: `"0"` | Next page offset (string). `"0"` from go-to means no more pages | `mapProductsPayload` → `products` event `nextOffset` → `ProductGrid` "Load more" → `useSwiggyChat.loadMore` → `/api/search?offset=`; runner summary tells the model `offset=N` | ✅ (model hint 🆕) |
| `products[]` | 20 per page | Search results | `ProductGrid` / `ProductCard`; `UsualsBoard` | ✅ |
| `similarProducts[]` | 20 (eggs → curd, paneer, bread) | Related items Swiggy suggests | `agent.mapToolResult` sends a second grid, "Similar to “eggs”" | ✅ |
| `products[].displayName` | `Fresh Eggs White eggs` | Product name | `Product.name` → card title, cart line name, summary | ✅ |
| `products[].brand` | `Eggoz`; go-to: `Fruits & Vegetables Category` | Brand (a pseudo-brand for fresh produce) | Card brand line, usuals size line, summary | ✅ |
| `products[].inStock` | `true` | Product in stock | `Product.inStock` (AND `isAvail`) → OOS overlay, "Unavailable" | ✅ |
| `products[].isAvail` | `true` | Product available at this address | Combined into `Product.inStock` | ✅ |
| `products[].productId` | `KH3R7OZA65` | Product id | Dedupe key in `ProductGrid` / load-more merge, cart line `productId` | ✅ |
| `products[].parentProductId` | `FJU3D1OKJ3` (shared by two NOICE products) | Catalog grouping id across pack families | Not shown | ⏭ internal catalog id; products already arrive grouped with their variations |
| `products[].isPromoted` | `true` on Eggoz, Pringles, Too Yumm | Sponsored listing. The tool's DISPLAY INSTRUCTIONS: "display with ⭐ and mention Featured/Sponsored" | `ProductBadges` "⭐ Sponsored" chip on `ProductCard` + `UsualsBoard`; runner summary marks `SPONSORED` and tells the model to say so. **Bug fixed**: it used to render as "Bestseller" | 🆕 (was wrong) |
| `products[].badges[].type` | `BADGE_TYPE_BEST_SELLER`, `BADGE_TYPE_INSTA_UPGRADE`, `BADGE_TYPE_AD` | Badge kind | `Product.badges`; `AD` also sets `isPromoted` and is shown as the single "⭐ Sponsored" chip (not twice) | 🆕 |
| `products[].badges[].text` | `Bestseller`, `Switch`, `Ad` | Badge label | `ProductBadges` chips; runner summary | 🆕 |
| `products[].badges[].backgroundColor` | `#238BF4`, `#002E99`, `rgba(2,6,12,0.05)` | Swiggy's badge colour | Chip fill (white text on solid hex; translucent falls back to a light chip) | 🆕 |
| `variations[].spinId` | `PQO3B4KKNO` | Add-to-cart key | Pack picker key, `update_cart` item, ADD/BEST markers | ✅ |
| `variations[].skuId` | `545TG3Y78D` | SKU, sent with spinId to `update_cart` | `CartLine.skuId` → `/api/cart` | ✅ |
| `variations[].quantityDescription` | `12 Pieces x 2`, `52.9 g` | Pack size | Pack picker chips, cart line, summary, `ProductGrid` value trimming | ✅ |
| `variations[].displayName` | same as product | Variation name | n/a | ⏭ duplicate of `products[].displayName` on every live sample |
| `variations[].brandName` | same as product | Variation brand | n/a | ⏭ duplicate of `products[].brand` |
| `variations[].price.mrp` | `290` | MRP | `PriceTag` strike-through + % off; cart line MRP; savings | ✅ |
| `variations[].price.offerPrice` | `208` | Selling price | `PriceTag`, cart unit price, summary | ✅ |
| `variations[].price.unitLevelPrice` | `8.7/piece`, `42.5/100 g`; absent on medicines | Swiggy's per-unit price | "₹8.7/piece" under the price on `ProductCard` + `UsualsBoard`; summary for every pack | 🆕 (parsed before, never shown) |
| `variations[].isInStockAndAvailable` | `true` | Pack in stock | `Variation.inStock` → OOS overlay; OOS packs struck through in the picker | ✅ (picker 🆕) |
| `variations[].imageUrl` | `…/NI_CATALOG/IMAGES/ciw/2025/12/17/…png` | Pack photo (each pack has its own) | `swiggyImageUrl(…, IMG_CARD)` → card photo (switches with the pack), usuals tile, cart thumb | ✅ |
| `variations[].rating.value` | `"4.4"`; absent on many | Average rating | "★ 4.4" on card + usuals tile; summary | 🆕 |
| `variations[].rating.count` | `"140.4k"` | Number of ratings | "(140.4k)" next to the rating; summary | 🆕 |
| `variations[].sla.value` + `.unit` | `"14"` + `"MINS"` (one item `29`) | Delivery time for this pack | "⚡ 14 mins" on card + usuals tile; summary "arrives 14 mins" | 🆕 |
| `variations[].vegClassifier` | `VEG_CLASSIFIER_VEG` (go-to), `VEG_CLASSIFIER_INVALID` (eggs, chips, medicines) | Veg / non-veg mark | `VegDot` (green square = veg, brown = non-veg) by the brand / name; `INVALID` shows nothing; summary `veg` / `non-veg` | 🆕 |
| `variations[].maxQuantity` | `3`; absent on some packs (Crax 3-pack) | Per-order cap | Disables Add / + at the cap (card, cart); summary `max 3` | ✅ (summary 🆕) |
| `variations[].maxQuantityMessage` | `Only 3 unit(s) of this item can be added per order.` / `That’s all we have in stock at the moment!` | Swiggy's own cap text | Shown under the card and the cart line once the cap is reached, and as the stepper tooltip; carried into `CartLine` | 🆕 (was only a tooltip on the card) |
| content[0] text `DISPLAY INSTRUCTIONS` | "Products with isPromoted=true are sponsored; display with ⭐ and mention Featured/Sponsored" … | How Swiggy wants results shown | Followed: ⭐ Sponsored chip, brand + name, packs with MRP vs offer, spinId + skuId to `update_cart` | 🆕 |

## get_addresses

| Field path | Example | Meaning | Where the app uses it | Status |
| --- | --- | --- | --- | --- |
| `addresses[].id` | `d1k9ctrdq1ocsktt0090__AMXrgASg728rGDWKq4_ky_` | Address id for every downstream tool | `AddressPicker`, every Instamart/Food call | ✅ |
| `addresses[].addressLine` | `G.Praneeth Reddy: Ground floor G-02, DM Homes, …` | Full address | `AddressPicker` row + trigger | ✅ |
| `addresses[].addressTag` | `GPR`, `Home`, `Work` | User's label | `AddressPicker` pill + trigger | ✅ |
| `addresses[].addressCategory` | `Other`, `Work`, `Home` | Category | `AddressPicker` "· Other" | ✅ |
| `addresses[].phoneNumber` | `****6256` (masked by Swiggy) | Contact number | `AddressPicker` row "📞 ****6256" | 🆕 |
| `total` | `7` | Address count | n/a | ⏭ duplicate of `pagination.total`; picker shows "N saved" from the list |
| `pagination.page / pageSize / totalPages` | `1 / 10 / 1` | Paging | n/a | ⏭ only `hasMore` is needed to page |
| `pagination.hasMore` | `false` | More pages | `getAddressBook` loop (`mapAddressPage`) | ✅ |
| `pagination.total` | `7` | Count | n/a | ⏭ see `total` |
| `resolution.defaultAddressId` | Chennai address | Swiggy's suggested preselection | `useSwiggyChat` preselects it | ✅ |
| `resolution.resolutionSource` | `ranked_saved_address` | Why that default | `AddressResolution` (parsed, passed to the hook) | ✅ |
| `resolution.needsUserClarification` | `true` | Ask the user to confirm | `AddressResolution`; the picker is always visible, so the user confirms by choosing | ✅ |
| `resolution.candidateAddressIds[]` | 7 ids | Ranked order | n/a | ⏭ same order as `addresses[]`, which the picker already keeps |
| `resolution.scoreUsed` | `1` | Ranking score | n/a | ⏭ internal ranking detail |
| `imWidgetV2Eligible` | `true` | ChatGPT widget flag | n/a | ⏭ widget-host flag; Swizzo renders its own UI |
| content[0] text | "Found 7 saved addresses … 1. [Praneeth] …" | Text rendering of the list | n/a | ⏭ duplicate of structuredContent |
| `_meta.widgetFlags.chatgptPlatformOverrides` | `true` | Widget host flag | n/a | ⏭ widget-host plumbing |

## get_cart

| Field path | Example | Meaning | Where the app uses it | Status |
| --- | --- | --- | --- | --- |
| `selectedAddress` | `db7kh1c1d96ofdam8g8g` (short id) | Address the cart is bound to | `boundAddressId` via `sameAddressId` → "moves here" notice | ✅ |
| `selectedAddressDetails.id` | `db7kh1c1d96ofdam8g8g` | Same, inside the details | `InstamartCartView.boundAddressId`; checkout re-verifies | ✅ |
| `selectedAddressDetails.address` | `West Tambaram, Tambaram, Chennai, …` | Delivery address | `CartPanel` "Delivering to" block | 🆕 |
| `selectedAddressDetails.annotation` | `Praneeth` | Address label | "Delivering to **Praneeth**" | 🆕 |
| `selectedAddressDetails.category` | `OTHER` | Category | "· other" | 🆕 |
| `selectedAddressDetails.name` | `G.Praneeth Reddy` | Recipient | Under the address | 🆕 |
| `selectedAddressDetails.mobile` | `9392756256` (unmasked!) | Recipient phone | Masked server-side to `••••6256` before it reaches the UI | 🆕 (masked) |
| `selectedAddressDetails.flatNo` | `Hotel icon residency` | Flat / building | Prefixed to the address | 🆕 |
| `selectedAddressDetails.area` | `West Tambaram` | Area | `CartDeliveryAddress.area` | 🆕 |
| `selectedAddressDetails.city` | `Chennai` | City | `CartDeliveryAddress.city` | 🆕 |
| `selectedAddressDetails.lat / lng` | `12.928…, 80.116…` | Delivery coordinates | n/a | ⏭ not displayed; tracking takes coordinates from `get_orders` (its own documented source) |
| `cartTotalAmount` | `₹266` / `"0"` | Cart total | Fallback for the total when `toPay` is missing | ✅ |
| `items[].spinId / skuId` | `VRBN3GVWZ2 / 2CG4J4927S` | Line keys | Steppers → `update_cart` | ✅ |
| `items[].productId` | `SF4DO4VQNE` | Product id | `CartLine.productId` | ✅ |
| `items[].itemName` | `Godrej Yummiez Cheese Corn Nuggets` | Name | `CartLineRow` | ✅ |
| `items[].itemVariant` | `400 g` | Pack | `CartLineRow` under the name | ✅ |
| `items[].quantity` | `1` | Quantity | Stepper | ✅ |
| `items[].storeId` | `1404943` | Fulfilling store | Counted → `CartState.storeCount`; `CartPanel` says "Items from N stores — Swiggy places one order per store" when > 1 | 🆕 |
| `items[].isInStockAndAvailable` | `true` | Line availability | "Unavailable at this address", blocks checkout | ✅ |
| `items[].mrp` | `240` | MRP | `CartLineRow` struck-through MRP; "You save" total | ✅ (line MRP 🆕) |
| `items[].discountedFinalPrice` | `219` | Selling price | Line total, subtotal | ✅ |
| `items[].imageUrl` | `…/NI_CATALOG/IMAGES/CIW/2026/3/12/…png` | Thumb | `CartLineRow` photo (`IMG_THUMB`) | ✅ |
| `items[].maxQuantity` | `3` | Cap | Disables + at the cap | ✅ |
| `items[].maxQuantityMessage` | `That's all we have in stock at the moment!` | Cap text | Shown under the line at the cap + tooltip | 🆕 |
| `billBreakdown.lineItems[].label/value` | `Item Total ₹219.00`, `Handling Fee ₹12.00`, `Delivery Partner Fee FREE`, `Late Night Fee ₹35.40` | Real bill | `CartPanel` bill rows (FREE in teal) | ✅ |
| `billBreakdown.toPay.value` | `₹266` | Grand total | "To Pay" row, Checkout button, budget meter, checkout `cartTotal` | ✅ |
| `billBreakdown.toPay.label` | `To Pay` | Total label | `BillBreakdown.totalLabel` → total row label | 🆕 |
| `superData.userStatus / program / offering` | `SUPER / ONE / PLUS` | Swiggy One membership (text block: "Swiggy One Status: Active (ONE - PLUS)") | `CartState.swiggyOne` → "Swiggy ONE PLUS" chip in the cart header | 🆕 |
| `cartId` | `ace5f3ea-…` | Cart id | n/a | ⏭ Instamart `checkout` takes only `addressId`; the cart is resolved server-side |
| `cartAbsent` | `true` | No cart | `view.absent` → empty state | ✅ |
| content[0] text | "Please display … delivery address … items table … cost breakdown … Swiggy One Status" | Display instructions | Followed: address block, items, full bill, Swiggy One chip; payment methods only from `get_payment_options` | 🆕 |
| `_meta.widgetFlags` | `chatgptPlatformOverrides` | Widget flag | n/a | ⏭ widget-host plumbing |

The agent reads `get_cart` as raw JSON (`runner.compactPayload`, 3 KB cap), so every field above reaches the model.

## get_payment_options

| Field path | Example | Meaning | Where the app uses it | Status |
| --- | --- | --- | --- | --- |
| `platforms.mobile.methods[].id` | `gpay://upi/` | UPI app, echoed as `intentApp` | `payment-mcp.mapPaymentOptions` → checkout picker in `page.tsx` | ✅ |
| `platforms.mobile.methods[].displayName` | `Google Pay` | Label | Picker | ✅ |
| `platforms.mobile.methods[].kind` | `intent` | Method kind | Picker kind | ✅ |
| `platforms.mobile.methods[].iconUrl` | `…/PaymentLogos/paymentIcons/upicollect/gpay` | App icon | `page.tsx` picker `<img>` | ✅ |
| `platforms.*.groupName` | `UPI` | Group | `PaymentOptionsPayload.platforms.*.groupName` | ✅ |
| `platforms.desktop.methods[]` | `PayWithQR` (`kind: qr`) | Scan-QR | Picker on desktop (`generateUPIQR`) | ✅ |
| `cod.available / id / displayName` | `true / COD / Pay on delivery` | Cash on delivery | Picker "Cash" option | ✅ |
| `swiggyMoney.available / id / displayName` | `true / SwiggyPay / Swiggy Money` | Wallet | Picker wallet option | ✅ |
| `allMethods[]` (`id, groupName, displayName, iconUrl, enabled`) | 4 methods | Flat list, source of truth | `mapPaymentOptions` (`enabled` filters) | ✅ |
| `allMethods[].raw.*` | `upiIntent, name, display_name, payment_code, meta` | Swiggy's internal method record | n/a | ⏭ duplicate of the mapped fields |
| `agenticPaymentEligible` | `false` (both captures) | Account may pay through MCP | Parsed into `PaymentOptionsPayload.agenticPaymentEligible` | ✅ parsed. The picker UI is in `page.tsx`, which this agent doesn't own (see report) |
| `paymentAmount` | `"266"` / `null` (empty cart) | Payable | `PaymentOptionsPayload.paymentAmount` | ✅ |
| `placeOrderToolName` | `checkout` | Which tool places the order | `PaymentOptionsPayload.placeOrderToolName` | ✅ |
| `imWidgetV2Eligible` | `true` | Widget flag | n/a | ⏭ widget-host flag |

## get_orders

| Field path | Example | Meaning | Where the app uses it | Status |
| --- | --- | --- | --- | --- |
| `orders[]` | `[]` (no orders in 15 days) | Order list | `pastInstamartOrders` → history card; `imTrackerFromOrder` → tracker; `/api/usuals` "Due" math | ✅ (documented fields; nothing live to inspect) |
| `hasMore` | `false` | More orders | n/a | ⏭ app asks for `count: 20` (the recommended maximum) and the window is 15 days |
| content[0] text | "Found 0 orders from the last 15 days." | Summary | n/a | ⏭ duplicate |

---

## Agent (chat) side

`runner.summarize()` for `products` / `suggestions` events now gives the model, per product: brand, name, rating and
count, veg mark, delivery time, SPONSORED, badges (Bestseller / Switch), stock, and **every pack (up to 4)** with id,
size, offer price, MRP, unit price and cap. It also says when more pages exist (`offset=N`) and asks the model to say
"Sponsored" when it recommends a promoted item (the tool's display instruction). Asserted in
`scripts/verify-food-instamart.ts`.

---

## AI-first pass (2026-10-23): where the same fields now drive the AI

- **Pack choice** (`src/shared/instamart-packs.ts`): `quantityDescription` (parsed: `450 ml x 2`, `1 ltr x 12`,
  `12 Pieces x 2`, …) + `price.offerPrice` → ₹ per g / ml / piece (falls back to `unitLevelPrice`);
  `isInStockAndAvailable` / `inStock` / `isAvail`, `maxQuantity` + `maxQuantityMessage` (cap → top-up line with
  Swiggy's text), `isPromoted` / `BADGE_TYPE_AD` (skipped unless nothing else fits; else labelled ⭐ Sponsored),
  `rating`, `sla` (both in every reason and the score), `vegClassifier` (vegOnly baskets), `badges[].text`.
  Used by the `build_basket` card, the usuals tiles (**gap closed: each tile shows the AI-picked pack + why and a pack
  switcher**), the ingredient resolver and the product card's default pack ("✦ AI pack — …").
- **build_basket** (agent tool, app-side composite of `search_products` / `your_go_to_items` / `get_orders`): the model
  reads every basket line back (`summarizeBasket`): spinId, pack, qty, price, MRP, reason, substitute / cap / missing,
  total vs budget, sponsored counts.
- **Usuals briefing**: `your_go_to_items` names + stock, `get_orders` `createdAt` + `items[].name`
  ("ordered N days ago" per tile and in the briefing) → `/api/instamart/note` (AI) over those facts.
- **Cart review** (`src/shared/instamart-review.ts`): `items[].isInStockAndAvailable` (live substitute search →
  "Swap it in"), `removedOutOfStockItems` / `reducedQuantityItems` / `cartWarning` / `addressWarning` (warnings →
  chips), `maxQuantity`, `billBreakdown.lineItems` (fees, FREE lines), `toPay`, `mrp` vs `discountedFinalPrice`
  (savings), `storeId` count, `superData` → insights + one AI note.
- **Ready to order**: `selectedAddressDetails`, item count, `toPay`, `get_payment_options` `allMethods` /
  `platforms` / `swiggyMoney` / `cod` (names + icons), and **`agenticPaymentEligible: false` explained in the tray**.
  The model also gets `get_payment_options` as a read tool (raw JSON).
