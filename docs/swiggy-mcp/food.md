# Swiggy Food MCP — tool contracts

Source: `docs/swiggy-mcp/builders-llms-full.txt` (Swiggy Builders Club docs). Food reference ≈ lines 3602–6962, Food index ≈ 5808, recipe "Order food end-to-end" ≈ 446–592, "Pay with UPI" ≈ 713–944, "Multi-turn cart state" ≈ 7–93, "Ship to production" ≈ 947–1120, errors ≈ 3555–3600.
Only documented facts below. **[UNCERTAIN]** marks gaps or places where the docs contradict themselves.

- Endpoint: `POST https://mcp.swiggy.com/food` (MCP streamable HTTP, OAuth bearer). Session identity comes from the token; never pass user id/token as args.
- Tool count: the index says **19** tools. The changelog says "Food (20 tools)". `create_address` / `delete_address` have Food reference pages but are **not** in the Food index. **[UNCERTAIN]** Treat `tools/list` as the source of truth.

## Envelope and errors (all tools)

```
success: { success: true, data: <tool payload>, message?: string }
failure: { success: false, error: { message: string, reportId?: string, reportHint?: string } }
```

- There is **no symbolic `error.code`**. Classify failures by `error.message` plus HTTP status / JSON-RPC code:
  - **Auth:** HTTP 401 / JSON-RPC `-32001`. Re-run OAuth. Never retry with the same token.
  - **Bad input:** HTTP 400 with a message starting `Invalid …` / `Missing …`. Fix the arguments. Do not retry.
  - **Upstream timeout:** HTTP 504 or a message containing `timeout`. Use backoff, max 5 retries.
  - **Upstream error:** HTTP 502/503. Use backoff, max 5 retries.
  - **Domain failure:** HTTP 200 with `success:false` (out of stock, restaurant closed, slot gone, …). Mostly terminal. Surface it to the user. **Do not retry.**
  - **Internal:** HTTP 500 / `-32603`. Back off once, then escalate via `report_error`.
  - **Rate limit:** HTTP 429 + `Retry-After` (JSON-RPC `-32000`). Wait exactly `Retry-After`. Don't stack it on top of exponential backoff. There are no `X-RateLimit-*` headers.
  - JSON-RPC `-32003` means forbidden.
- **Backoff:** 500 ms, doubling up to 8 s, with jitter, capped at 5 retries. User-facing retry budget is ≤ 30 s of wall-clock time.
- **Retry safety by class** (Ship to production):

  | Class | Tools | Safe to retry? |
  | --- | --- | --- |
  | Reads | all reads | Always |
  | Cart mutations | `update_food_cart`, `flush_food_cart` | Yes ("set absolute cart state, not a delta") |
  | Coupon | `apply_food_coupon` | Yes |
  | Tracking | `track_food_order` | Always |
  | Order placement | `place_food_order` | **NO** |

  `place_food_order` has no server-side idempotency and no `Idempotency-Key`. On a 5xx or network error:
  1. Wait 2–5 s.
  2. Call `get_food_orders` and check whether the order went through.
  3. If it did, treat the failure as a success. Only otherwise retry.

  Never wrap `place_food_order` in a generic retry.
- **Session hygiene** (rate-limits page):
  - Use one persistent MCP session per user.
  - **Never** run a new `initialize` handshake per tool call.
  - Initialize servers sequentially, not in parallel.
  - Keep concurrency reasonable.
  - Don't poll `track_*` faster than every 10 s.
- **Observability:** generate and log your own correlation id per call. The transport is stateless and returns no session id.
- **Common schema rules:**
  - Optional fields may be absent.
  - Use returned ids and enums **exactly**.
  - Never invent fallback ids, statuses, payment methods or timestamps.

## Tools

Legend: **R** = read-only, **M** = mutating. "Idempotent" follows the retry table above.

### Discover

#### `get_addresses` — R, idempotent
List the user's saved addresses with a server-side default resolution.

**Input**

| Param | Type | Required | Notes |
| --- | --- | --- | --- |
| `page` | number | no | 1-based, default 1 |
| `pageSize` | number | no | default 10, **max 10** |
| `explicitAddressId` | string | no | Id requested this turn. Wins over `selectedAddressId`. Only ids previously returned by this tool. |
| `selectedAddressId` | string | no | Earlier selection, used for continuity |
| `latitude` / `longitude` | number | no | Only from client context, never inferred, always paired |

**Output `data`**

```
addresses: { id, addressLine, phoneNumber, addressCategory?, addressTag? }[]
pagination: { page, pageSize, total, totalPages, hasMore }
resolution: {
  defaultAddressId?,
  resolutionSource: "explicit_user_address" | "user_selected_address" | "ranked_saved_address"
                  | "requested_address_not_found" | "no_saved_address",
  needsUserClarification: boolean,
  candidateAddressIds: string[],
  scoreUsed?
}
```

**Rules**
- Exactly one address: use it and tell the user which one.
- `ranked_saved_address` with several addresses: show the list and ask the user to confirm. **Don't call downstream tools yet.**
- `explicit_user_address` / `user_selected_address`: usable as-is.
- "No addresses" means only `pagination.total === 0`. An empty page with a non-zero total means the page is out of range.
- **The schema has no lat/lng.** The recipe says "never raw coordinates".
- **[UNCERTAIN]** The recipe shows `addresses.data.find(a => a.label)`. That doesn't match the schema (`data.addresses[]`, no `label`).

#### `search_restaurants` — R
Find restaurants for delivery.

**Input**

| Param | Type | Required | Notes |
| --- | --- | --- | --- |
| `query` | string | **yes** | Non-empty. Restaurant name or cuisine. |
| `addressId` | string | no* | Use this **or** the lat/lng pair |
| `latitude` / `longitude` | number | no* | Paired. Also works for guests. |
| `offset` | number | no | Default 0. Use `nextOffset` from the previous response. |

**Output `data`**

```
restaurants: {
  id?, name, cuisines: string[], avgRating?: number, totalRatings?: string, costForTwo?: string,
  areaName?, distanceKm?: number, deliveryTimeMinutes?: number, deliveryTimeRange?: string,
  veg?: boolean, offer?, imageUrl?,
  availabilityStatus?: "OPEN" | "CLOSED" | "UNAVAILABLE", nextOpenTime?
}[]
dishes: {
  id?, name, price?, isVeg?, description?, imageUrl?, category?, inStock?: boolean,
  restaurantId?, restaurantName?, restaurantRating?, restaurantAreaName?, deliveryTimeMinutes?
}[]
nextOffset?: string | number
query: string
totalRestaurants?
hasMore?
```

**Rules**
- Only recommend or add from restaurants with `availabilityStatus` `"OPEN"`.
- Results are sorted by a mix of distance, rating and relevance.
- **Always mention distance and ETA for far restaurants** (>5 km per the voice/chat guardrails).
- After showing results, let the user pick. Don't auto-call `search_menu`.
- Restaurant id is `restaurants[].id`. A dish's restaurant is `dishes[].restaurantId`.

#### `get_restaurant_menu` — R
Compact, **paginated browse** of a restaurant's menu.

**Input**

| Param | Type | Required | Notes |
| --- | --- | --- | --- |
| `restaurantId` | string | **yes** | |
| `addressId` | string | one of* | Location is required: `addressId` **or** the lat/lng pair |
| `latitude` / `longitude` | number | one of* | |
| `page` | number | no | default 1 |
| `pageSize` | number | no | Categories per page. Default 5, **max 8** (clamped). |

**Output `data`**

```
restaurant: {
  id, name, city?, areaName?, cuisines?, avgRating?, avgRatingString?, totalRatingsString?,
  costForTwoMessage?, isOpen?: boolean, deliveryTime?: number, slaString?, address?, imageUrl?
}
categories: (MenuCategory | MenuNestedCategory)[]
totalCategories, page, pageSize, hasMore
```

```
MenuCategory = {
  title, categoryId?, imageUrl?, totalItems?, hasMoreItems?,
  items: {
    id, name, description?, price?, inStock?: number, isVeg?, isBestseller?,
    rating?: string, imageUrl?, hasVariants?, hasAddons?
  }[]
}
MenuNestedCategory = { title, categoryId?, imageUrl?, subcategories: MenuCategory[], totalSubcategories? }
```

**Rules**
- Pagination is over **categories**. When `hasMore` is true, call again with `page+1`. The message also says "Use page=2…".
- **≤10 dishes per category.** `hasMoreItems` / `totalItems` indicate more. Use `search_menu` for dishes beyond the cap.
- Nested categories carry `subcategories[]` (≤5 shown, plus `totalSubcategories`).
- `description` / `imageUrl` are truncated. **To order an item or see its customizations, use `search_menu`** with the item name and `restaurantId`.

#### `search_menu` — R
Dish search, either inside one restaurant or across restaurants. Returns full customizations needed for the cart.

**Input**

| Param | Type | Required | Notes |
| --- | --- | --- | --- |
| `query` | string | **yes** | Non-empty dish name |
| `addressId` | string | no* | Use this **or** the lat/lng pair |
| `latitude` / `longitude` | number | no* | |
| `restaurantIdOfAddedItem` | string | no | Scopes the search to one restaurant |
| `vegFilter` | `0 \| 1` | no | 1 = veg only. There is **no** non-veg-only filter. |
| `offset` | number | no | Use `nextOffset` |

**Output `data`**

```
items: MenuItemSummary[]
query
restaurantIdOfAddedItem?
totalItems
hasMore
nextOffset?: number
```

```
MenuItemSummary = {
  name, price?, isVeg?, menu_item_id?, inStock?: number,
  restaurant_id?, restaurant_name?, imageUrl?, rating?: string | number, totalRatings?,
  hasVariants?, hasAddons?, isBestseller?,
  variations?: { name?, price?, isVeg?, id?, groupId?, default?: number, inStock?: number }[],
  variantsV2?: {
    groupId, name,
    variations: { id, name, price?, inStock?, default? }[]
  }[],
  addons?: {
    groupId, groupName, minAddons?, maxAddons?, maxFreeAddons?,
    choices: { id, name, price }[]
  }[]
}
```

Note the **snake_case** fields: `menu_item_id`, `restaurant_id`, `restaurant_name`.

**Rules**
- Each item has **either** `variations` **or** `variantsV2`, never both. Use the same format in the cart.
- Addons listed here are *all* possible addons. Add the variant first, then pick from the cart's `valid_addons`.
- Cross-restaurant search: search inside the current restaurant first (`restaurantIdOfAddedItem`). If there are no or weak results, search without it and tell the user the options come from other restaurants.
- **Drill-in:** when the user picks a dish from a cross-restaurant search, re-call with `restaurantIdOfAddedItem` set to that dish's restaurant. This returns full variant and addon details.
- Don't auto-call `update_food_cart`. Wait for the user.

### Cart

Cart state lives **server-side, per authenticated session, single restaurant**:
- Adding from a different restaurant **flushes** the cart automatically. **Warn the user** before doing that.
- Carts have a TTL. A stale cart may return `CART_EXPIRED`. **[UNCERTAIN]** This is an error-message string; there are no codes.
- Call `get_food_cart` at the start of any cart turn and before placing an order.
- Don't cache cart state in agent memory.

#### `update_food_cart` — M, retry-safe ("sets absolute state")
Add or update cart contents.

**Input**

| Param | Type | Required | Notes |
| --- | --- | --- | --- |
| `restaurantId` | string | **yes** | |
| `cartItems` | object[] | **yes** | "items to add to cart with their customizations" |
| `addressId` | string | no* | Use this **or** the lat/lng pair |
| `latitude` / `longitude` | number | no* | |
| `restaurantName` | string | no | For display; the cart API doesn't always return it |
| `cutleryOptIn` | boolean | no | Omit to leave unchanged |

**[UNCERTAIN] `cartItems[]` element shape is not documented.**
- Schema notes say `menu_item_id` "is the Food menu item identifier used by `update_food_cart`".
- The description says items carry `variants` **or** `variantsV2` (same format as `search_menu`), plus `addons`.
- The recipe instead shows `items:[{itemId, quantity}]`. That contradicts the reference.

**Output `data`**

```
data?: { cart_id?, result?, restaurant?, items?, item_count?, pricing?, offers? }
statusCode?
statusMessage?
```

The inner `data` has the same types as `get_food_cart` below.

**Rules**
- **Renders no UI.** Immediately call `get_food_cart` to show the cart.
- `coupon_applied` with `coupon_discount = 0` is only a *suggestion*, not an applied coupon.
- Quantity change on an item with addons or variants: **ask** whether the user wants the same add-ons. Don't replicate silently. Items without addons or variants can change directly.

#### `get_food_cart` — R
Read the current cart.

**Input**

| Param | Type | Required | Notes |
| --- | --- | --- | --- |
| `addressId` | string | **yes** | Used for delivery charges |
| `restaurantName` | string | no | For display |

**Output `data`**

```
data?: {
  cart_id?, result?,
  restaurant?: { id?, name?, area?, deliverySubtitle? } | null,
  items?: FoodCartItem[],
  item_count?,
  pricing?: FoodCartPricing,
  offers?: FoodCartOffers
}
addressId: string
availablePaymentMethods?: string[]
paymentOptions?: { allMethods: PaymentMethod[], upiMethods?, allGroups?, paymentAmount?, markdown? } | null
gpoError?: string
```

```
FoodCartItem = {
  menu_item_id, name, imageUrl?, quantity: number, is_veg?: boolean | string | number,
  subtotal: number, total: number, final_price: number, in_stock?: boolean,
  variants?: Sel[], addons?: (Sel & { quantity? })[], valid_addons?: AddonGroup[]
}
Sel        = { id?, name?, group_id?/groupId?, variation_id?/variationId?, price? }
AddonGroup = { group_id?/groupId?, name?, minAddons?, maxAddons?, choices?, addons? }
FoodCartPricing = { item_total, delivery_charge, delivery_charge_strikeoff?, taxes_and_charges, to_pay }
FoodCartOffers  = { coupon_applied?: string | null, coupon_discount?: number, free_delivery_applied?: boolean }
PaymentMethod   = { id, groupName?, displayName?, kind?: "intent" | "qr", iconUrl?, enabled? }
```

**Rules**
- Note the nesting: the cart is `data.data`, while `addressId` and payment fields sit on the outer `data`.
- `offers.coupon_applied` is a **string code**, not an object.
- A coupon counts as applied **only if `coupon_discount > 0`**.
- Use `to_pay` for checkout decisions. Don't sum components yourself.
- Prefer `valid_addons` over the menu's addon list.
- Pass the payment **group** in `paymentMethod` (e.g. `"UPI"`) and the app id in `intentApp`. Never put an app id in `paymentMethod`.

#### `flush_food_cart` — M, retry-safe
Empty the cart. Takes no arguments.

**Output `data`:** `{ statusCode?, statusMessage?, success?: boolean, message? }`

Use it explicitly when the user starts over.

#### `fetch_food_coupons` — R
List coupons for the cart.

**Input**

| Param | Type | Required | Notes |
| --- | --- | --- | --- |
| `restaurantId` | string | **yes** | |
| `addressId` | string | **yes** | |
| `couponCode` | string | no | Checks one specific coupon |

**Output `data`**

```
status_message?
coupon_sections: {
  title?, type?,
  coupons: {
    id?, applicable?: boolean, title?, subtitle?, description?, ribbon_text?,
    terms_and_conditions?: { title?, bullet_texts?: string[] } | null
  }[]
}[]
summary: { total_coupons, applicable_coupons, sections_count, filter_applied?: string }
```

**Rules**
- The server already filters to COD-compatible coupons. `filter_applied` is always `"COD only"`.
- `applicable: true` means the coupon can be applied to the current cart.
- **No numeric discount field is returned.** You learn the saving only from `apply_food_coupon` / the cart's `coupon_discount`.
- **[UNCERTAIN]** Which field holds the code to pass to `apply_food_coupon` is undocumented. `id` is the only identifier. The recipe uses `c.code` and `c.requiresOnlinePayment`, neither of which is in the schema.

#### `apply_food_coupon` — M, retry-safe
Apply a coupon to the cart.

**Input**

| Param | Type | Required | Notes |
| --- | --- | --- | --- |
| `couponCode` | string | **yes** | The recipe's `code` key contradicts this; the reference wins |
| `addressId` | string | **yes** | |
| `cartId` | string | no | |

**Output `data`**

```
statusCode?
statusMessage?
data?: {
  cart_id?, result?,
  pricing?: { item_total?, delivery_fee?, packaging_fee?, taxes?, coupon_discount?, to_pay? },
  offers?: { coupon_applied?: string, coupon_discount?: number },
  item_count?
}
```

Pricing keys differ from `get_food_cart`: this tool returns `delivery_fee` / `packaging_fee` / `taxes`, while the cart uses `delivery_charge` / `taxes_and_charges`.

**Rules**
- **Applied only when `coupon_applied` is present and `coupon_discount > 0`.** A response with discount 0 is not an applied coupon.
- A coupon that requires online payment is not usable on the COD path.

### Payment (shared stage: `get_payment_options → place_food_order → check_payment_status → confirm_order`)

#### `get_payment_options` — R
Live payment methods for the cart.

**Input**

| Param | Type | Required | Notes |
| --- | --- | --- | --- |
| `addressId` | string | no | Food only. Pass the same id used for `get_food_cart`. It is echoed back. |

**Output `data`**

```
platforms?: {
  mobile?:  { groupName, methods: PaymentMethod[] },   // UPI app intents
  desktop?: { groupName, methods: PaymentMethod[] }    // scan-QR
}
cod?:         { available, id, displayName }
swiggyMoney?: { available, id, displayName }
reservePay?:  { available, id, displayName }
agenticPaymentEligible: boolean
allMethods: PaymentMethod[]
paymentAmount?: string | null
addressId?
placeOrderToolName: "place_food_order"
```

**Rules**
- **Offer only returned methods.** Never invent one.
- If UPI isn't available, `platforms` is omitted and only Cash appears in `allMethods`.
- **Choosing a method:**
  - UPI app: `paymentMethod:"UPI"` + `intentApp: <method.id>` (exact).
  - Scan-QR: `paymentMethod:"UPI"` + `generateUPIQR:true`.
  - Cash: pass the returned Cash/COD method.
  - Swiggy Money: `paymentMethod:"SwiggyPay"`, **only** if `swiggyMoney.available === true`. Never send `intentApp` / `generateUPIQR` with it.
- Never ask for a UPI ID / VPA (NPCI rule). Never ask the user which device they're on.

### Order

#### `place_food_order` — M, **NOT idempotent**
Place the order for the current cart. It is immediate only; there is no scheduled delivery in v1.

**Input**

| Param | Type | Required | Notes |
| --- | --- | --- | --- |
| `addressId` | string | **yes** | |
| `paymentMethod` | string | no | `"UPI"`, `"Cash"` (also `"COD"` per other server docs), or `"SwiggyPay"`. May be omitted **only** when Cash is the only available method. |
| `intentApp` | string | no | UPI app id from `get_payment_options` |
| `generateUPIQR` | boolean | no | Scan-QR |
| `noteToRestaurant` | string | no | Note to the kitchen, not for delivery instructions |

**Output `data`** — a union:

```
Cash / COD / SwiggyPay (placed immediately):
{
  orderId: string | null, status: string /* usually "CONFIRMED" */, normalizedStatus: "success",
  items: { item_id?, name?, quantity?, total?, subtotal?, final_price? }[],
  restaurantName, restaurantAddress, totalAmount, estimatedDelivery, deliveryAddress   // all nullable
}

UPI (NOT placed yet):
{
  orderId, paasId, transactionId, upiIntentUrl, bridgeUrl, isQrFlow,
  pollingIntervalInMs, maxTimeToPollForInMs,
  paymentMethod: "UPI", status: "PENDING_PAYMENT", normalizedStatus: "pending",
  totalAmount?, restaurantName?, restaurantAddress?, deliveryAddress?,
  addressId, cartId: string | null, lat: number, lng: number
}
```

**Rules**
- **Explicit confirmation is required before calling.** First show the `get_food_cart` summary, the payment method, and the full delivery address. Then ask "proceed?".
- On `PENDING_PAYMENT` **never** say the order is placed. Placement only happens after `confirm_order` succeeds (or `check_payment_status` reports `confirmed`).
- Headless clients share `data.bridgeUrl` with the user. It is an opaque HTTPS page with a QR and an "open UPI app" button.
- Echo `addressId`, `cartId`, `lat` and `lng` **from this response** into `check_payment_status` / `confirm_order`.
- If the SwiggyPay debit fails, nothing was charged. Tell the user to top up. Don't retry SwiggyPay.
- **Cancellation:** call no tool. Tell the user to call Swiggy customer care at **080-67466729**.
- **[UNCERTAIN]**
  - The `intentApp` param text says to leave it blank unless `get_food_cart` says otherwise, while the payment docs say to copy the method id.
  - The changelog lists "Cash-on-delivery only on Food ordering" as a v1 limitation, but the UPI and SwiggyPay docs say otherwise. Trust `get_payment_options`.

#### `check_payment_status` — R (long-poll ~19 s)
One poll iteration for a UPI payment.

**Input**

| Param | Type | Required | Notes |
| --- | --- | --- | --- |
| `paasId` | string | **yes** | Real transaction id from place-order. Never a method name like "UPI" or "PayWithQR". If you have no paasId, don't call. |
| `orderId` | string | no | |
| `addressId` / `cartId` / `lat` / `lng` | | no | **Food: echo from `place_food_order`.** Without them the order can't auto-confirm and stays pending. |

**Output `data`**

```
paasId, status: string, terminal: boolean, isTerminalSuccess: boolean, isTerminalFailure: boolean,
confirmed?, orderStatus?, cartTotal?, orderId?, addressId?, cartId?, lat?, lng?
```

**Statuses** (per the recipe):

| `status` | Meaning / action |
| --- | --- |
| `success` / `paid` | Placed. Check `confirmed`. |
| `failed` | Re-offer `get_payment_options`. Don't confirm. |
| `cancelled` | Tell the user. Don't retry. |
| `cart_changed` | Not placed. Review the cart and place again. |
| `refund-initiated` | Tell the user and stop. |
| `pending` | Keep waiting, capped. |

**Rules**
- On widget hosts, the widget polls. Self-hosted clients poll every `pollingIntervalInMs` for at most `maxTimeToPollForInMs`, and never tight-loop.

#### `confirm_order` — M, idempotent for the same ids
Finalize a paid UPI order.

**Input**

| Param | Type | Required | Notes |
| --- | --- | --- | --- |
| `orderId` | string | **yes** | |
| `addressId` | string | **yes for Food** | |
| `lat` / `lng` | number | **yes for Food** | |
| `cartId` | string | no | Recommended |
| `paasId` / `transactionId` | string | | Instamart/Dineout only. **Food does not use `paasId`.** |

Echo all values from the `place_food_order` response.

**Output `data`:** `{ orderId, paasId?, orderStatus?, result: "success" | "failed" | "pending" | string }`

**When to call**
- Only after a terminal success where `confirmed` is not true.
- Or once, when your poll cap is hit while still `pending`. A late success reconciles server-side.
- **Never** after `failed`, `cancelled`, `refund-initiated` or `cart_changed`.
- **Never** for Cash or SwiggyPay.

### Track

#### `get_food_orders` — R
Order history, newest first, across **all** addresses.

**Input**

| Param | Type | Required | Notes |
| --- | --- | --- | --- |
| `addressId` | string | **yes** | Only resolves coordinates. Does not filter. |
| `activeOnly` | boolean | no | Default false. Set it only when the user explicitly asks for active orders. |
| `orderCount` | number | no | Default 5, max 15 |

**Output `data`**

```
orders: {
  orderId, restaurantId, restaurantName, restaurantAreaName?, orderTotal: string,
  orderStatus, orderDeliveryStatus?, orderType, orderedItems: string, orderedTime: string,
  isActiveOrder: boolean, actions: OrderAction[]
}[]
statusMessage?
```

```
OrderAction = {
  type, priority, title, isEnabled,
  reorderMeta?:     { orderItems: FoodReorderItem[], restaurantCoverImageId? },
  rateDeliveryMeta?: { ... }
}
FoodReorderItem = {
  menu_item_id?, item_id?, name?, quantity?,
  variants?: { variation_id?, group_id?, name?, price? }[],
  addons?:   { addon_id?, group_id?, name?, price? }[]
}
```

**Rules**
- This is the check used before retrying `place_food_order`.
- Live ETA comes from `track_food_order`, not from this tool.

#### `get_food_order_details` — R
Full detail for one order. **Input:** `orderId` (string, **required**).

**Output `data`**

```
order: {
  order_id: number, delivery_address, order_items, charges: Record<string, string>,
  is_coupon_applied, coupon_applied?, order_time, confirmed_time, customer_id,
  order_status, post_status, order_type,
  restaurant_id, restaurant_name, restaurant_address, restaurant_locality, restaurant_area_name?,
  restaurant_cuisine: string[], payment_method,
  order_total, item_total, order_tax, order_discount, coupon_discount, order_delivery_charge,
  is_cancellable, is_reorderable_order
}
statusMessage?
```

Many numeric values come back as **strings**:
- `delivery_address` has `lat` / `lng` as strings.
- `order_items[].quantity` / `total` / `final_price` are strings.
- Variant `variation_id` / `group_id` are **numbers** here.

#### `track_food_order` — R
Conversational tracking. **Input:** `orderId` (string, optional). Omit it to get all active orders.

**Output `data`**

```
orders: {
  orderId, title, subtitle, etaText?, orderStatus, progressPercentage?: string,
  pollingDuration?: string, icon?, businessLine?: { id, name? }
}[]
statusMessage?
```

Poll no faster than every 10 s.

#### `get_food_delivery_status` — R
Structured ETA polling. **Input:** `orderId` (string, **required**).

**Output `data`**

```
orderId
deliveryBy: number | null     // epoch ms
serverNow: number             // epoch ms
etaText?
cancelled?: boolean
delivered?: boolean
statusText?
pollIntervalSec: number
```

**Rules**
- Wait `pollIntervalSec` between calls.
- Stop when `cancelled` or `delivered` is true.
- The human-readable status is in `statusText`. There is no `status` field.

### Support / address management

#### `recommend_address` — R
Geocode free-text address.

**Input**

| Param | Type | Required |
| --- | --- | --- |
| `address` | string | **yes** |
| `postalCode` | string | **yes** |
| `city` | string | no |
| `locality` | string | no |

**Output `data`:** `{ latitude, longitude, formattedAddress }`

#### `report_error` — M
Build a diagnostic mailto link.

**Input**

| Param | Type | Required | Notes |
| --- | --- | --- | --- |
| `tool` | string | **yes** | |
| `errorMessage` | string | **yes** | |
| `domain` | string | no | |
| `flowDescription` | string | no | |
| `toolContext` | object | no | Include every id from the failed call: orderId, restaurantId, addressId, menu_item_id, couponCode, cartId, paymentMethod, … |
| `userNotes` | string | no | |

**Output `data`:** `{ reportLink, supportEmail, summary }`

#### `create_address` — M
Not listed in the Food index. **[UNCERTAIN]**

**Input**

| Param | Type | Required | Notes |
| --- | --- | --- | --- |
| `fullAddress` | string | **yes** | |
| `addressLine` | string | **yes** | |
| `addressLine2` | string | **yes** | Use `""` if none |
| `city` | string | **yes** | |
| `postalCode` | string | **yes** | |
| `addressCategory` | `"HOME" \| "WORK" \| "OFFICE" \| "FRIENDS_AND_FAMILY" \| "OTHER"` | **yes** | |
| `userName` | string | **yes** | |
| `userPhone` | string | **yes** | |
| `locality` | string | no | |
| `latitude` / `longitude` | number | no | Auto-geocoded if omitted |
| `addressTag` | string | no | |
| `receiverName` / `receiverPhone` | string | no | |

**Output `data`:** `{ addressId }`

The agent parses the address components from `fullAddress`. Never ask the user for them separately.

#### `delete_address` — M
Permanent. Confirm with the user first. Not listed in the Food index. **[UNCERTAIN]**

**Input:** `addressId` (**required**). **Output `data`:** `{ statusCode, statusMessage }`

## Canonical flow

1. **Address.** Call `get_addresses`. Honour `resolution`: confirm with the user when `ranked_saved_address` has several candidates. If `total === 0`, use `create_address`.
2. **Discover.**
   - Restaurant intent: `search_restaurants {query, addressId}`. Keep only `availabilityStatus:"OPEN"` and surface distance for far ones.
   - Dish intent: `search_menu {query, addressId}` across restaurants, then drill in with `restaurantIdOfAddedItem`.
3. **Menu.** `get_restaurant_menu {restaurantId, addressId, page}` to browse. Paginate with `hasMore`. For orderable detail and customizations, use `search_menu` with `restaurantIdOfAddedItem`.
4. **Cart.**
   - Call `update_food_cart {restaurantId, restaurantName, addressId, cartItems}`, then **immediately** `get_food_cart {addressId}`.
   - Single restaurant: warn before a switch flushes the cart. Use `flush_food_cart` to start over.
   - Customized items take variants first, then `valid_addons`.
5. **Coupon (optional).**
   - Call `fetch_food_coupons {restaurantId, addressId}` and pick from `coupon_sections[].coupons` where `applicable:true`.
   - Call `apply_food_coupon {couponCode, addressId}`.
   - Re-read the cart. The coupon is applied only if `coupon_discount > 0`.
6. **Payment options.** `get_payment_options {addressId}`. Offer only the returned methods.
7. **Confirm and place.**
   - Call `get_food_cart` again. Check `pricing.to_pay ≤ ₹1000` (Builders Club cap).
   - Show items, total, payment method and the full delivery address. Wait for an explicit "yes".
   - Call `place_food_order {addressId, paymentMethod, intentApp | generateUPIQR, noteToRestaurant?}`.
   - On a transport or 5xx error, wait 2–5 s, check `get_food_orders`, and only then retry.
8. **UPI only.**
   - Share `bridgeUrl` (or let the widget render it).
   - Poll `check_payment_status {paasId, orderId, addressId, cartId, lat, lng}` every `pollingIntervalInMs`, capped at `maxTimeToPollForInMs`.
   - Call `confirm_order {orderId, addressId, cartId, lat, lng}` on success when `!confirmed`, or once at the cap if still pending.
9. **Track.**
   - `track_food_order {orderId}` for conversational updates.
   - `get_food_delivery_status {orderId}` for structured polling: wait `pollIntervalSec`, stop on `delivered` / `cancelled`. Never poll faster than every 10 s.

## Constraints (as documented)

- **Single-restaurant cart.** Switching restaurant flushes it automatically. Warn the user first.
- **₹1000 cart cap** for Builders Club orders. Check it against the cart total before placing. Tell the user before they add an item that breaks the cap.
- **Payment methods:**
  - `"UPI"` (with `intentApp` or `generateUPIQR`), `"Cash"`/COD, or `"SwiggyPay"` (only when `swiggyMoney.available`).
  - Always taken from `get_payment_options`.
  - Coupons from `fetch_food_coupons` are COD-compatible only.
  - **[UNCERTAIN]** The changelog says Food is COD-only in v1.
- **No scheduled orders.** `place_food_order` is immediate.
- **No cancellation tool.** Direct the user to 080-67466729.
- **Never place without explicit user confirmation** of items, total, payment method and address.
- **Never show raw ids, tokens or internal codes** in the UI or in speech.
- **Distance:** surface it for restaurants more than 5 km away.
- **Doc inconsistencies to be aware of:** the "Order food end-to-end" recipe uses several arg and field names that the reference contradicts:
  - `apply_food_coupon {code}`
  - `update_food_cart {items:[{itemId}]}`
  - `place_food_order {paymentMethod:"COD"}` with no `addressId`
  - `cart.data.total`
  - `addresses.data[]`
  - `fetch_food_coupons` with no args

  **The tool reference sections are authoritative.**
