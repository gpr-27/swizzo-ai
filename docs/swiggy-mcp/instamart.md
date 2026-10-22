# Swiggy Instamart MCP — tool contracts

Source: `docs/swiggy-mcp/builders-llms-full.txt` (Swiggy Builders Club docs). Tool reference ≈ lines 6986–9855; Instamart index ≈ 8882–8943; recipes "Order groceries end-to-end" (593–711), "Pay with UPI end-to-end" (713–944), "Multi-turn cart state" (7–92), "Ship to production" (947–1119), "Error codes" (3555–3599), "Rate limits" (1631–1672).
Everything below is taken from those docs. Anything marked **[UNCERTAIN]** is a gap or contradiction in the docs, not a confirmed fact.

- **Endpoint:** `POST https://mcp.swiggy.com/im` (MCP streamable HTTP, JSON-RPC `tools/call`)
- **Tools:** 20 (index). An earlier changelog entry says 19 **[UNCERTAIN: count changed over time]**.
- **Auth:** the OAuth bearer token goes on the transport. Session credentials (user identity, access token) are **never** tool arguments. One token works on all four servers.
- **Widgets:** Instamart is flagged `hasWidgets: true`. Widget HTML is an MCP resource (`ui://widget/...`, e.g. `ui://widget/im-cart.html`) fetched with `resources/list` + `resources/read`. A widget-backed tool advertises it as `_meta.ui.resourceUri`. Clients without widget support render their own UI from `data`.

---

## 0. Shared envelope and errors

Every tool returns:

```ts
// success
{ success: true, data: /* tool-specific */, message?: string }
// failure
{ success: false, error: { message: string; reportId?: string; reportHint?: string } }
```

- `message` on success is user-facing. For `checkout` it carries the required Instamart branding (see checkout).
- There is **no symbolic `error.code`**. Classify failures by `error.message` text plus HTTP / JSON-RPC status:

| Bucket | Detect | React |
| --- | --- | --- |
| Auth failure | HTTP 401 / JSON-RPC `-32001` | Re-run OAuth. Never retry with the same token. |
| Bad input | HTTP 400, message starts `Invalid ...` / `Missing ...` | Fix the args. Do not retry. |
| Upstream timeout | HTTP 504 or message contains `timeout` | Exponential backoff, max 5 retries |
| Upstream error | HTTP 502/503 | Exponential backoff, max 5 retries |
| **Domain failure** | **HTTP 200 with `success: false`** | Read `message`. Most are terminal (out of stock, etc.): surface to the user, do not retry. |
| Internal | HTTP 500 / JSON-RPC `-32603` | Back off once. Escalate via `report_error`. |
| Rate limit | HTTP 429 + `Retry-After` / JSON-RPC `-32000` | Wait `Retry-After`. Don't stack it on top of backoff. |
| Forbidden | JSON-RPC `-32003` | — |

- Backoff: start at 500 ms, double up to 8 s, cap 5 retries, jitter. For user-facing flows, cap total retry wall-clock at 30 s.
- Instamart-specific messages from the recipe (no codes yet): item out of stock at this address, address not serviceable, minimum order not met (cart under ₹99), cart expired / abandoned. The recipe also names `ADDRESS_NOT_SERVICEABLE`, `MIN_ORDER_NOT_MET` and `CART_EXPIRED`. **[UNCERTAIN]** the error page says no symbolic codes exist, so treat these as message text, not fields.

### Idempotency classes (Ship to production)

| Class | Instamart tools | Blind retry safe? |
| --- | --- | --- |
| Pure reads | get_addresses, search_products, your_go_to_items, get_cart, list_coupons, get_payment_options, get_orders, get_order_details, recommend_address | Always |
| Cart mutations (absolute state) | update_cart, clear_cart | Yes. They set absolute state, not a delta. |
| Coupon | apply_coupon | Yes (the table lists `apply_food_coupon`; Instamart is by analogy **[UNCERTAIN]**) |
| Tracking | track_order, get_delivery_status | Always |
| **Order placement** | **checkout** | **NO.** On 5xx or network error: wait 2–5 s, call `get_orders`, and retry only if no order went through. No server idempotency and no `Idempotency-Key`. |
| Payment finalize | confirm_order | Idempotent for the same ids. Retry only on transient failure. |

### Session hygiene (Rate limits)

- One MCP session per user. **Never run a new initialize handshake per tool call.** Initialize domains one after another, not in parallel.
- One `get_addresses` per session is plenty. Cache low-churn data.
- Don't poll `track_*` faster than every 10 s.
- `your_go_to_items` replaces 3–5 search calls for returning users.

### Global schema rules (repeated on every tool)

- Optional fields may be omitted depending on user, cart and order state and live availability.
- Use returned identifiers and enum values **exactly**. Never invent fallback IDs, status values, payment methods or timestamps.

---

## 1. Discover

### `get_addresses` — read-only, Stage Discover
Lists saved addresses, paginated at 10 per page.

| Param | Type | Req | Notes |
| --- | --- | --- | --- |
| `page` | number | no | 1-based, default 1 |
| `pageSize` | number | no | default 10, **max 10** |
| `explicitAddressId` | string | no | Address the user asked for in the current turn. Takes precedence over `selectedAddressId`. Only IDs returned earlier by get_addresses. |
| `selectedAddressId` | string | no | Choice made earlier in this conversation or UI. Continuity only. |
| `latitude` | number | no | Only when the client context provides it. Never infer it or ask for it. Must be paired with longitude. |
| `longitude` | number | no | Paired with latitude |

```ts
data: {
  addresses: Array<{ id: string; addressLine: string; phoneNumber: string; addressCategory?: string; addressTag?: string }>;
  pagination: { page: number; pageSize: number; total: number; totalPages: number; hasMore: boolean };
  resolution: {
    defaultAddressId?: string;
    resolutionSource: "explicit_user_address" | "user_selected_address" | "ranked_saved_address" | "requested_address_not_found" | "no_saved_address";
    needsUserClarification: boolean;
    candidateAddressIds: string[];
    scoreUsed?: number;
  };
}
```

Resolution workflow:
1. If there is exactly one address, use `defaultAddressId` without asking, and tell the user which address it is.
2. If there are several and `resolutionSource=ranked_saved_address`, `defaultAddressId` is only a suggestion. Show the list and ask the user to confirm. **Do not call downstream tools yet.**
3. With `explicit_user_address` or `user_selected_address`, use it unless the user now asks for another.
4. Only when `pagination.total === 0`, tell the user to add an address. An empty page with a non-zero total means the page is out of range.
- If `hasMore` is true, fetch `page=2` and so on.
- **No lat/lng is returned per address.** `track_order` needs coordinates. **[UNCERTAIN]** the docs give no direct source; `recommend_address` can geocode text, and the `get_orders` description mentions "delivery address coordinates" but its schema has none.
- Recipe snippet `addresses.data.find(a => a.label === "Home")` contradicts the schema (`data.addresses[]`, `addressTag`). Follow the schema.

### `create_address` — mutating, Stage Discover (shared Instamart/Food)

| Param | Type | Req | Notes |
| --- | --- | --- | --- |
| `fullAddress` | string | **yes** | Complete address as the user typed it |
| `addressLine` | string | **yes** | Street / building / house no. The **agent parses this out of fullAddress**. |
| `addressLine2` | string | **yes** | Apartment / floor / wing. Use `""` if none. |
| `locality` | string | no | Area / neighbourhood |
| `city` | string | **yes** | |
| `postalCode` | string | **yes** | |
| `latitude` / `longitude` | number | no | Auto-resolved from the address if omitted |
| `addressCategory` | `"HOME" \| "WORK" \| "OFFICE" \| "FRIENDS_AND_FAMILY" \| "OTHER"` | **yes** | Upper-case enum |
| `addressTag` | string | no | Free label, e.g. "My Home", "Mom's Place" |
| `userName` | string | **yes** | Account holder (the authenticated user) |
| `userPhone` | string | **yes** | Account holder phone |
| `receiverName` / `receiverPhone` | string | no | Only when delivering to someone else |

`data: { addressId: string }`
- Ask the user for: the full address, their name, phone, category, an optional tag, and whether it's for someone else (if so, receiver name and phone).
- **Never** ask for addressLine, addressLine2, city or postalCode separately. Parse them out of the full address.
- There are **no** `flatNo` / `landmark` params.

### `delete_address` — mutating, Stage Discover
| `addressId` | string | **yes** | From get_addresses |
`data: { statusCode: number; statusMessage: string }`. Deletion is permanent, so always confirm with the user first.

### `search_products` — read-only, Stage Discover

| Param | Type | Req | Notes |
| --- | --- | --- | --- |
| `query` | string | **yes** | Cannot be empty |
| `addressId` | string | no* | Signed-in mode (from get_addresses). Never invent one. |
| `latitude` | number | no* | Guest mode, -90..90 |
| `longitude` | number | no* | Guest mode, -180..180 |
| `offset` | number | no | Default 0 |
*Pass either addressId (signed in) or lat+lng (guest).

```ts
data: { nextOffset: string; products: SearchProduct[]; similarProducts?: SearchProduct[] }
type SearchProduct = {
  displayName: string; brand: string; inStock: boolean; isAvail: boolean;
  productId: string; parentProductId: string; isPromoted?: boolean;
  badges?: Array<{ type: string; text: string; backgroundColor?: string }>;
  variations: Array<{
    spinId: string; skuId: string; quantityDescription: string; displayName: string; brandName: string;
    price: { mrp: number; offerPrice: number; unitLevelPrice?: string };
    isInStockAndAvailable: boolean; imageUrl?: string;
    rating?: { value: string; count: string }; sla?: { value: string; unit: string };
    vegClassifier?: string; maxQuantity?: number; maxQuantityMessage?: string;
  }>;
}
```
- You add **variations** to the cart, never the parent product. Use the SKU-level ids (`spinId` + `skuId`) of the variation the user picked.
- "When adding a product, ALWAYS search first and **ask the user which variant they want**."
- Show `similarProducts` in a separate "Similar Items" section.
- `nextOffset` is a **string** but the `offset` param is a **number** **[UNCERTAIN: whether it's always numeric]**. Use it only for pagination.
- Treat `rating` as a display signal only, never as an id.
- Recipe snippet uses `products[0].variants[0]`. The schema field is `variations`.

### `your_go_to_items` — read-only, Stage Discover
| `addressId` | string | **yes** | From get_addresses |
| `offset` | number | no | default 0 |
`data: { nextOffset: string; products: SearchProduct[]; similarProducts?: SearchProduct[] }` (same product shape as search).
- "Pass **BOTH spinId and skuId** from the chosen variant when adding to cart via update_cart."

---

## 2. Cart

`InstamartCart`, shared by get_cart, update_cart and apply_coupon:

```ts
type InstamartCart = {
  selectedAddress?: string;
  selectedAddressDetails?: { id: string; address: string; area: string; name: string; mobile: string;
    annotation?: string; category?: string; flatNo?: string; city?: string };
  cartTotalAmount: string;                       // string, not number
  items: InstamartCartItem[];
  billBreakdown: { lineItems: Array<{ label: string; value: string }>; toPay: { label: string; value: string } };
  cartId?: string;
  addressWarning?: string;
  unserviceableItems?: InstamartCartItem[];
  cartAbsent?: boolean; cartAbsentReason?: string;
  cartWarning?: { statusCode: number; message: string };
  superData?: { program?: string; offering?: string };
}
type InstamartCartItem = {
  spinId: string; storeId?: string; skuId: string; productId: string;
  itemName: string; itemVariant?: string; quantity: number;
  isInStockAndAvailable: boolean; mrp: number; discountedFinalPrice: number;
  imageUrl?: string; maxQuantity?: number; maxQuantityMessage?: string;
}
```

### `get_cart` — read-only, Stage Cart, no params
`data: InstamartCart & { availablePaymentMethods?: string[]; paymentOptions?: { allMethods: {id, displayName?, enabled?}[]; upiMethods: {...}[]; allGroups: {group_name, display_name, methods:{id, displayName?}[]}[]; paymentAmount?: string|null; markdown?: string } | null; gpoError?: string }`
- The cart lives **server-side, keyed to the authenticated session**. Call get_cart at the top of every turn that touches the cart, and **always before checkout**: the user may have edited it in the Swiggy app, stock and prices change, coupons expire. "Don't cache cart state in your agent's memory."
- `cartId` is only for the immediate follow-up. Refresh after any change to items, address, slot or payment.
- For checkout decisions, use the payable total (`cartTotalAmount` / `billBreakdown.toPay`), never a sum of components.
- `isInStockAndAvailable` / `unserviceableItems` / quantity caps: show the reason and refresh before checkout.
- For payment, call `get_payment_options`. Don't assume the cart's payment list is complete.

### `update_cart` — mutating (idempotent: absolute state), Stage Cart

| Param | Type | Req | Notes |
| --- | --- | --- | --- |
| `items` | object[] | **yes** | Each item is `{ spinId, skuId, quantity }` from search_products / your_go_to_items |
| `selectedAddressId` | string | no* | Signed-in users (from get_addresses) |
| `latitude` / `longitude` | number | no* | Guest mode |

`data: InstamartCart & { removedOutOfStockItems?: InstamartCartItem[]; reducedQuantityItems?: Array<{ spinId; itemName; requestedQuantity; cappedQuantity; reason? }> }`
- **Replaces the entire cart.** Send the full desired list every time.
- The tool description says "Pass skuId, spinId, and quantity". The recipe snippet passes only `spinId` + `quantity` **[UNCERTAIN: whether skuId is enforced; send it]**. The per-item object schema isn't spelled out beyond "object[]".
- Show `removedOutOfStockItems` / `reducedQuantityItems` to the user.
- **Address-bound cart:** "An Instamart cart binds to the delivery address." To switch address, call `clear_cart` first.
- Carts have a TTL. A stale cart may surface "cart expired": rebuild it and confirm with the user.

### `clear_cart` — mutating (idempotent), Stage Cart, no params
`data: { verified: true } | { verified: null; acknowledged: true }`. If it can't verify the clear, it returns `success:false`.

### `list_coupons` — read-only, Stage Cart. *Not fully rolled out; may be missing from tools/list.*
| `addressId` | string | **yes** | |
Workflow: get_addresses → update_cart (cart must be non-empty) → list_coupons → show coupons → apply_coupon.
`data: { availableCoupons: Array<{ couponCode: string; title: string; description?: string; isApplicable: boolean; applicabilityStatus: string; applicabilityMessage?: string; tnc?: { title: string; bulletTexts?: string[] }; offerId?: string }> }`

### `apply_coupon` — mutating, Stage Cart. *Not fully rolled out.*
| `couponCode` | string | **yes** | Case-insensitive (upper-cased server-side) |
`data: InstamartCart`, with the discount in `billBreakdown.lineItems`. Treat a coupon as applied only when the returned cart shows it with a positive discount.

---

## 3. Payment

### `get_payment_options` — read-only, Stage Payment
| `addressId` | string | no | **Food only** (echoed for the picker). Not needed for Instamart. |

```ts
data: {
  platforms?: { mobile?: { groupName: string; methods: PaymentMethod[] }; desktop?: { groupName: string; methods: PaymentMethod[] } };
  cod?: { available: boolean; id: string; displayName: string };
  swiggyMoney?: { available: boolean; id: string; displayName: string };
  reservePay?: { available: boolean; id: string; displayName: string };
  agenticPaymentEligible: boolean;
  allMethods: PaymentMethod[];
  paymentAmount?: string | null;
  placeOrderToolName: "checkout";
}
type PaymentMethod = { id: string; groupName?: string; displayName?: string; kind?: "intent" | "qr"; iconUrl?: string; enabled?: boolean }
```
- Offer **only** the returned methods. Never invent or assume one.
- `platforms.mobile.methods` = UPI apps → `paymentMethod:"UPI"` + `intentApp: <method.id exactly>`.
- `platforms.desktop.methods` = scan-QR → `paymentMethod:"UPI"` + `generateUPIQR:true`.
- When UPI isn't available for the cart, `platforms` is omitted and only Cash appears, via `allMethods` / `cod`.
- Offer Swiggy Money only when `swiggyMoney.available === true`. Then pass `paymentMethod:"SwiggyPay"` (example: `swiggyMoney.id = "SwiggyPay"`, `allMethods[].groupName = "SWIGGYPAY"`).
- NPCI: **never ask for a UPI ID / VPA.** UPI Collect and saved VPAs are not surfaced.
- In widget mode the device is auto-detected. Never ask what device the user is on.

### `check_payment_status` — read-only, Stage Payment

| Param | Type | Req | Notes |
| --- | --- | --- | --- |
| `paasId` | string | **yes** | The `paasId` from the checkout response. Never a method name ("UPI", "PayWithQR", …). **If you have no real paasId, don't call this.** |
| `orderId` | string | no | Pass it when checkout returned one |
| `addressId`, `cartId`, `lat`, `lng` | — | no | **Food only** |

`data: { paasId: string; status: string; terminal: boolean; isTerminalSuccess: boolean; isTerminalFailure: boolean; confirmed?: boolean; orderStatus?: string; cartTotal?: number; orderId?: string; addressId?; cartId?; lat?; lng? }`
- This is a **long-poll (~19 s server hold)**. Poll at the place-order `pollingIntervalInMs`, capped at `maxTimeToPollForInMs`. Never tight-loop or run overlapping calls.
- When `terminal=true`, stop polling.
- `isTerminalSuccess`: then if `confirmed===true` the order is already finalized, so **don't** call confirm_order. Otherwise call confirm_order once.
- `isTerminalFailure` (failed / cancelled / refund-initiated / cart_changed): **never** call confirm_order. Offer a fresh attempt via get_payment_options, except on refund-initiated and cancelled, where you tell the user and stop.
- `status` values named in the recipe: `success`/`paid`, `failed`, `cancelled`, `cart_changed` (order NOT placed; re-review the cart), `refund-initiated`, `pending`.
- In widget clients, the widget polls and auto-confirms. A headless client owns the loop.

### `confirm_order` — mutating (idempotent for the same ids), Stage Payment
| `orderId` | string | **yes** | From checkout |
| `paasId` | string | **yes for IM** | From the checkout UPI response, echoed exactly |
| `transactionId` | string | no | From checkout (IM/Dineout) |
| `addressId`/`cartId`/`lat`/`lng` | — | no | Food only. Not used by Instamart. |
`data: { orderId: string; paasId?: string; orderStatus?: string; result: "success" | "failed" | "pending" | string }`
- Call it only after a terminal **success** that isn't already `confirmed`, or **once** when the poll cap is hit while still `pending` (a late success is reconciled server-side).
- **Cash/COD and SwiggyPay need no confirm_order.**
- Check `result`: `failed` means the order was not completed. `pending` means not ready.

---

## 4. Order

### `checkout` — mutating, **NON-idempotent**, Stage Order
"Place and confirm Swiggy Instamart grocery order." It handles multi-store carts (one order per store, partial success possible).

| Param | Type | Req | Notes |
| --- | --- | --- | --- |
| `addressId` | string | **yes** | From get_addresses. The user must have selected it. |
| `paymentMethod` | string | no | **Group**, one of `"UPI"`, `"Cash"`/`"COD"`, `"SwiggyPay"`. Never an app id. If omitted, it auto-defaults to the user's available method. |
| `intentApp` | string | no | UPI app id copied exactly (e.g. `"gpay://upi/"`). Only with `paymentMethod="UPI"`. Leave blank for Cash/COD/QR. |
| `generateUPIQR` | boolean | no | "Leave blank unless the runtime response of the preceding get_cart call explicitly tells you to enable it." (get_payment_options says: scan-QR → `UPI` + `generateUPIQR=true`.) |
| `confirmDuplicate` | boolean | no | Leave blank on the first try. Set true **only** if a previous checkout was rejected as a probable duplicate, that rejection said to re-checkout with confirmDuplicate, **and** the user confirmed. Never use it to retry a failed or timed-out checkout. |

```ts
data:
  | { orderId: string; status: string; paymentMethod: string; cartTotal?: number; addressId?: string; deliveryAddress?: string; deliveryLabel?: string }       // Cash/COD/SwiggyPay single store
  | { orders: Array<{ orderId?: string; status?: string; error?: string }>; orderCount: number; successCount: number; failureCount: number; allSucceeded: boolean; paymentMethod: string; cartTotal?: number } // multi-store
  | { orderId: string; transactionId: string; paasId: string; upiIntentUrl: string; bridgeUrl: string; isQrFlow: boolean;
      pollingIntervalInMs: number; maxTimeToPollForInMs: number; paymentMethod: "UPI"; status: "PENDING_PAYMENT";
      addressId?: string; cartTotal?: number; deliveryAddress?: string; deliveryLabel?: string }                                                              // UPI
```

**Mandatory pre-checkout UX (from the tool description):**
1. Call `get_cart` and show the items, costs and available payment method(s).
2. Say which payment method will be used.
3. State the address: "Your order will be delivered to: [full address details]".
4. If the cart spans several stores: "Your cart contains items from [N] different stores…".
5. Ask "Do you want to proceed with placing this order to this address?"
6. Wait for an explicit yes. 7. Never proceed without it. 8. For multi-store, report each order's result.

- **Branding:** on success, show the tool's `message` **as-is**. It reads "Instamart order placed successfully" and may include a payment-success line. Don't rephrase it.
- **Cancellation:** don't call any tool. Tell the user: "To cancel your order, please call Swiggy customer care at 080-67466729."
- **UPI:** the order is created in `PENDING_PAYMENT`. For headless clients, share `data.bridgeUrl` (an opaque HTTPS scan-or-tap page, the same link for intent and QR). Don't parse `message` to find it. Then poll check_payment_status and call confirm_order as above.
- **SwiggyPay:** the wallet is debited inline and the order is placed immediately. It returns the Cash shape with `paymentMethod:"SwiggyPay"`: no paasId, no polling, no confirm. If the debit fails, nothing was placed or charged (usually low balance): tell the user to top up in the Swiggy app, or use UPI/Cash. Don't retry SwiggyPay until they've topped up. If the outcome is unknown, don't claim nothing was charged; ask the user to check their orders and balance. If an order exists but payment is unsettled, don't place another.
- **Retry:** never blind-retry. On 5xx or network error: wait 2–5 s → `get_orders` → retry only if no order exists.

---

## 5. Track

### `get_orders` — read-only, Stage Track
| `count` | number | no | default 10, max recommended 20 |
| `orderType` | string | no | e.g. "DASH", "INSTAMART". Default "DASH". |
| `activeOnly` | boolean | no | true for active / ongoing orders. Default false. |
Returns orders from the **last 15 days**.
```ts
data: { orders: Array<{
  orderId: string; status: string; createdAt: string; updatedAt: string; estimatedDeliveryTime?: string;
  itemCount: number; totalAmount: number; deliveryAddress?: { id: string; addressLine: string; phoneNumber: string };
  paymentMethod?: string; orderType: string; isActive: boolean; currentStatus: string; statusMessage?: string;
  historyStatus: string; storeName?: string; items: Array<{ name: string; quantity: number; itemId?: string }>;
  billDetails?: { itemTotal: number; deliveryFee: number; packagingFee: number; grandTotal: number };
  paymentStatus?: string; refundStatus?: string }>; hasMore: boolean }
```
- Use it for history, "my usuals" and reorder. It's also the check-then-retry probe after a failed checkout.
- Cancellation: same customer-care message as checkout.

### `get_order_details` — read-only, Stage Track. *Not fully rolled out.*
| `orderId` | string | **yes** | |
`data: { orderId: string; status: string; totalBill: number; hasRefunds: boolean; items: Array<{ name: string; quantity: number; finalPrice: number; removed: boolean }>; bill: { lineItems: Array<{ name: string; amount: string }>; grandTotal: string } }`
For the store, address or live tracking, use get_orders or track_order instead.

### `track_order` — read-only, Stage Track. **PRIMARY tool for "where is my order".**
| `orderId` | string | **yes** | |
| `lat` | number | **yes** | Delivery-address latitude |
| `lng` | number | **yes** | Delivery-address longitude |
```ts
data: { orderId: string; orderTitle: string; orderSubtitle: string;
  status: { statusMessage: string; subStatusMessage?: string; etaMinutes?: number; etaText?: string };   // status is an OBJECT
  storeInfo?: { name: string; address: string }; deliveryInfo?: { addressLabel?: string; fullAddress: string };
  items: Array<{ name: string; quantity: number; price: string }>; itemCount: number; placedAt?: string;
  paymentInfo?: { message: string; amount?: string };
  mapInfo?: { storeLocation?: {latitude,longitude}; storeAnnotation?: string; deliveryLocation?: {latitude,longitude}; deliveryAnnotation?: string; riderLocation?: {latitude,longitude} };
  pollingIntervalSeconds: number }
```
- Poll no faster than `pollingIntervalSeconds`, and never faster than 10 s. The recipe puts ETA at typically 10–20 min after checkout.
- The recipe snippet calls it with only `orderId`. The params table requires `lat`/`lng`. **[UNCERTAIN: where lat/lng come from; see get_addresses note]**

### `get_delivery_status` — read-only, Stage Track
| `orderId` | string | **yes** | |
| `addressId` | string | **yes** | Coordinates are resolved automatically |
`data: { orderId: string; deliveryBy: number | null /* epoch ms */; serverNow: number /* epoch ms */; etaText?: string; cancelled?: boolean; delivered?: boolean; statusText?: string; pollIntervalSec: number }`
- Use it for structured ETA refreshes and countdowns (`deliveryBy - serverNow`). Wait `pollIntervalSec` between calls. Stop when `cancelled` or `delivered` is true.
- For a conversational answer, prefer `track_order`.

---

## 6. Support

### `recommend_address` — read-only, Stage Support
| `address` | string | **yes** | Free text |
| `postalCode` | string | **yes** | |
| `city` | string | no | |
| `locality` | string | no | |
`data: { latitude: number; longitude: number; formattedAddress: string }`. Use it to validate an address before create_address, or to get coordinates.

### `report_error` — **mutating**, Stage Support
| `tool` | string | **yes** | The tool that errored |
| `errorMessage` | string | **yes** | |
| `domain` | string | no | "im", auto-detected |
| `flowDescription` | string | no | |
| `toolContext` | object | no | **Always include** the ids from the failed call (orderId, addressId, spinId, couponCode, query, cartId, paymentMethod, …) |
| `userNotes` | string | no | |
`data: { reportLink: string /* mailto: */; supportEmail: string; summary: string }`. Show `summary` to the user.

---

## 7. Flow

```
get_addresses ──(resolve/confirm; none → create_address [recommend_address to validate])
   │
   ├─► your_go_to_items(addressId)   (reorder / usuals)
   └─► search_products(addressId, query[, offset])  → user picks a VARIATION
           │
           ▼
   update_cart(selectedAddressId, items:[{spinId, skuId, quantity}])  ← full replace; show removed/capped items
           │   (optional: list_coupons(addressId) → apply_coupon(couponCode))
           ▼
   get_cart  → show items, toPay, address; ₹99 min; unserviceable / out-of-stock warnings
           ▼
   get_payment_options → user picks a RETURNED method
           ▼
   explicit user confirmation (items + total + address + method)
           ▼
   checkout(addressId, paymentMethod[, intentApp | generateUPIQR])   ← NEVER blind-retry; on failure get_orders first
     ├─ Cash/COD/SwiggyPay → placed. Show message as-is. No confirm.
     ├─ multi-store → report each order
     └─ UPI → PENDING_PAYMENT: share bridgeUrl → check_payment_status(paasId, orderId) at pollingIntervalInMs, cap maxTimeToPollForInMs
                 ├─ terminal success & confirmed → done
                 ├─ terminal success & !confirmed → confirm_order(orderId, paasId[, transactionId])
                 ├─ terminal failure → no confirm; offer get_payment_options again (except refund-initiated / cancelled)
                 └─ cap hit while pending → confirm_order once
           ▼
   track_order(orderId, lat, lng)  /  get_delivery_status(orderId, addressId)   (≥10 s cadence; honor returned interval)
   get_orders / get_order_details for history and bills
```

## 8. Constraints (as documented)

- **₹99 minimum order.** Below it you get a "Minimum order not met" failure. The docs don't say whether this is against item total or payable total **[UNCERTAIN]**.
- **Address-bound cart.** Serviceability and stock vary by address. `clear_cart` before switching address.
- **Server-side cart is the source of truth.** Re-read it before mutating or confirming. Carts have a TTL ("cart expired").
- **Carts are per-server.** The Food cart doesn't affect Instamart. Orders are per-server too: `get_food_orders` won't show Instamart orders.
- **Payment methods:** UPI (app intent via `intentApp`, or scan-QR via `generateUPIQR`), Cash/COD (when returned), SwiggyPay (only if `swiggyMoney.available`). Cash is the fallback when UPI isn't available. `paymentMethod` is always the group name. No VPA collection.
- **Explicit user confirmation before checkout**, showing items, total, address and payment method.
- **Cancellation is not supported via MCP.** Use the customer-care message (080-67466729).
- **Attribution:** show "Powered by Instamart" at Discover (above results), Choose (product detail), Order (beside cart/checkout) and Track (with confirmation/status).
- **No fabricated values:** ids, statuses, payment methods and timestamps must come from responses.

## 9. Doc inconsistencies to be aware of

| Where | Says | Reference table says |
| --- | --- | --- |
| Recipe step 1 | `addresses.data.find(a => a.label…)` | `data.addresses[]`, `addressTag` |
| Recipe step 3 | `variants[0].spinId`, no skuId, no address | `variations[]`; description: pass spinId+skuId+quantity, `selectedAddressId` |
| Recipe step 5 | `checkout({ paymentMethod: "COD" })` | `addressId` **required** |
| Recipe step 6 | `track_order({ orderId })` | `lat`, `lng` **required** |
| check_payment_status `paasId` | required | Pay-with-UPI recipe's Food snippets differ (Food only) |
| Retry table | lists `apply_food_coupon` only | Instamart `apply_coupon` by analogy |
