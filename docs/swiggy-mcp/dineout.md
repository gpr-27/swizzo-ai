# Swiggy Dineout MCP — tool contracts

Source: `docs/swiggy-mcp/builders-llms-full.txt` (Builders Club docs), Dineout reference
(lines ~1865–3601) plus recipes "Book a table" (~244), "Plan my evening" (~346),
"Pay with UPI end-to-end" (~713), "Ship to production" (~947). Only documented facts
below. **[CONFLICT]** marks places where a recipe contradicts the tool reference (the
reference page is the more specific source; prefer it). **[UNCLEAR]** marks gaps.

- Endpoint: `POST https://mcp.swiggy.com/dineout` (streamable HTTP, `Authorization: Bearer <token>`).
- Index lists **11 tools**: search_restaurants_dineout, get_restaurant_details, get_available_slots,
  create_cart, book_table, get_payment_options, check_payment_status, confirm_order,
  get_booking_status, cancel_booking, report_error. (Changelog says "Dineout (12 tools)" at
  v1.0; `get_saved_locations` is **not documented** anywhere for Dineout. [UNCLEAR])
- Session credentials come from the authenticated MCP session — never pass user/token args.
- Dineout has **no saved-address lookup**: it takes lat/lng of the city/area. "Don't try to
  pass an addressId to Dineout search." (combined recipe)

## Response envelope (all tools)

```jsonc
{ "success": true,  "data": { /* tool payload */ }, "message": "optional text" }
{ "success": false, "error": { "message": "…", "reportId": "ERR-…"?, "reportHint": "…"? } }
```

- `success:false` arrives with HTTP 200 ("Domain failure") — it is NOT a transport error. Read
  `error.message`; most are terminal (slot gone, restaurant closed) — surface, don't retry.
- `get_available_slots` text content holds only a per-date *summary* for later dates; "the
  **structuredContent** has the exact slotId/itemId/reservationTime". Always read
  `structuredContent`, never parse text.
- Global rule in every schema note: *use returned identifiers and enum values exactly as
  provided; do not invent fallback IDs, status values, payment methods, or timestamps.*

## Error classification (errors page)

No symbolic `error.code`. Classify by message prefix + HTTP / JSON-RPC code.

| Bucket | Detect | React |
| --- | --- | --- |
| Auth | HTTP 401 / JSON-RPC `-32001` | Re-run OAuth; never retry same token |
| Forbidden | JSON-RPC `-32003` | — |
| Bad input | HTTP 400, message `Invalid …` / `Missing …` | Fix args, don't retry |
| Upstream timeout | HTTP 504 / message contains `timeout` | Backoff, ≤5 retries |
| Upstream error | HTTP 502/503 | Backoff, ≤5 retries |
| Domain failure | HTTP 200 + `success:false` | Show `message`; don't retry |
| Internal | HTTP 500 / `-32603` | Backoff once; then `report_error` |
| Rate limit | HTTP 429 / `-32000`, `Retry-After` header | Wait `Retry-After`, don't stack backoff |

Backoff: 500ms doubling to 8s, jitter, cap 5; user-facing total budget 30s.
Recipe-level Dineout errors (book-a-table recipe; not in reference schemas):
`SLOT_UNAVAILABLE` → refetch slots, offer alternatives; `RESTAURANT_NOT_BOOKABLE` → suggest
walk-in/Food; `BOOKING_WINDOW_CLOSED` → offer next available day. [UNCLEAR whether these are
literal message strings.]

## Idempotency (ship-to-production)

| Tool | Behaviour | Retry |
| --- | --- | --- |
| search_restaurants_dineout, get_restaurant_details, get_available_slots, get_payment_options, check_payment_status, get_booking_status | read-only | always safe |
| book_table | mutating, **NOT idempotent**, no server idempotency key | never blind-retry. On 5xx/network error: wait 2–5s, check `get_booking_status`, retry only if it did not go through |
| create_cart | mutating | not documented [UNCLEAR] — treat as non-blind-retry |
| confirm_order | mutating, **idempotent** for same orderId/paasId | retry only on transient failure |
| cancel_booking | mutating, destructive | confirm with user first; no blind retry |
| report_error | mutating | — |

[CONFLICT] book-a-table recipe says call get_booking_status "with the restaurant and slot",
but get_booking_status only accepts `orderId`. Without an orderId you cannot verify.

---

## 1. search_restaurants_dineout — Find, read-only

Inputs

| Param | Type | Req | Notes |
| --- | --- | --- | --- |
| `query` | string | yes | ONE term (name / cuisine / area / kind of place / vibe), not a sentence; no location words. Dish → its cuisine ("dosa" → "South Indian"). |
| `latitude` | number | yes | Of the city/area the user named. "near me" with no place → **ask**, don't guess. Bangalore 12.9716,77.5946 · Koramangala 12.9352,77.6245 · Indiranagar 12.9784,77.6408 · Mumbai 19.0760,72.8777 · Delhi 28.6139,77.2090 |
| `longitude` | number | yes | — |
| `entityType` | `"locality" \| "CUISINE" \| "RESTAURANT_CATEGORY" \| "ambience_tags"` | no | rarely needed |
| `limit` | number | no | default 10, max 30 |
| `filters` | string[] | no | `group:value` ids echoed verbatim from `availableFilters` of a previous response |
| `sortKey` | string | no | from `availableSorts` of a previous response |
| `offset` | number | no | from previous response for paging |

Output `data`

```ts
{
  restaurants: Array<{
    id: string;                // the restaurantId for all follow-ups
    name: string;
    cuisine: string[];         // NOTE singular "cuisine"
    locality: string;
    area: string;
    rating: { value: string; count: number };   // object, value is a STRING
    costForTwo: string;
    imageUrl?: string;
    distance?: string;         // string, not km number
    highlights?: string[];
    offers?: Array<{ offerTitle: string; offerDescription?: string }>;
    bankOffers?: Array<{ offerTitle: string }>;
    vendorHighlights?: Array<{ type: string; text: string }>;
    availableDeals?: Array<{ dealTitle: string; ticketId?: number }>;
  }>;
  latitude: number; longitude: number;   // reuse for details/slots/booking
  total: number; offset: number; nextOffset?: number;
}
```

Gotchas: empty result = nothing matched → tell the user, offer another term; **never present
unrelated restaurants**. Don't auto-call details/slots. `availableFilters` / `availableSorts`
are referenced by the inputs but not in the documented output schema [UNCLEAR]. Surface
distance when >10 km (guardrail). [CONFLICT] book-a-table recipe says "filter to availability
`AVAILABLE`" — no such field in the schema.

## 2. get_restaurant_details — Find, read-only

Inputs: `restaurantId` string (req, from search `id`), `latitude` number (req, same as search),
`longitude` number (req).

Output `data` — **doubly nested**:

```ts
{
  statusCode: number;
  statusMessage: string;
  data: {
    restaurantId: string;
    restaurant: {
      id: string; restaurantId: string; name: string;
      cuisines: string[];            // plural here
      locality: string; area: string; address: string;
      avgRating: number; totalRatings?: string;
      costForTwo: string; distance?: string;
      imageUrl?: string; mastheadImageUrls?: string[]; description?: string;
      timings: string;
      deals: Array<{
        id: string | number; title: string; description: string;
        discountPercentage: number; coverCharge: number; slotGroupName: string;
        offerCategory?: "prebooking" | "walkin";
        adjoiningSubtext?: string; secondarySubtext?: string; offerLogo?: string;
      }>;
      partnerType?: "PR" | "NPR";
    };
    menuImages: Array<{ imageUrl: string; label?: string }>;
    menuImageGroups: Array<{ title: string; images: Array<{ imageUrl: string; label?: string }> }>;
    amenities: string[];
    locationMapUrl?: string;
  };
}
// plus top-level latitude / longitude on the tool result, OUTSIDE data
```

Gotchas: call with the id from the previous search; don't re-search. Don't auto-call slots.
[CONFLICT] book-a-table recipe calls it with only `restaurantId` and reads `details.data.id`;
reference requires lat/lng and the id is at `data.data.restaurant.id`.

## 3. get_available_slots — Reserve, read-only

Inputs

| Param | Type | Req | Notes |
| --- | --- | --- | --- |
| `restaurantId` | string | yes | from search/details |
| `date` | string | yes | `YYYY-MM-DD` **or** epoch as numeric string. Returns up to **7 days** from this date |
| `latitude` | number | yes | — |
| `longitude` | number | yes | — |

[CONFLICT] recipes pass `guestCount` here; it is **not** an input in the reference (only
appears optionally in the output).

Output `data`

```ts
{
  slots: Array<{
    slotId: number;               // NUMBER
    displayTime: string;          // "10:00 AM"
    reservationTime: number;      // epoch (example 1735675200 = seconds)
    slotGroupName: string;        // "Breakfast" | "Lunch" | "Dinner"
    availableInventory: number;
    dateStr?: string;             // YYYY-MM-DD the slot belongs to
    isFree?: boolean;
    subText?: string; daySubtext?: string;
    deals: Array<{
      itemId: string;             // "restaurantId-ticketId"
      ticketId: string;
      slotId: number;
      title?: string;
      discountPercentage?: number;
      displayFee?: string;
      bookingPrice?: number;      // >0 => PAID prebook deal, even if title reads like a discount
      isFree?: boolean;
      availableInventory?: number;
      dealCategory?: string;
      isOneExclusive?: boolean;
      soldOut?: boolean;
    }>;
  }>;
  restaurantId: string; date: string; restaurantName?: string; guestCount?: number;
  latitude: number; longitude: number;
}
```

Rules (tool description):
- One call covers 7 days; when the user switches date in the UI, **do NOT call again** —
  filter the already-loaded slots by `dateStr`.
- Surface BOTH free (`isFree=true`) and paid (`isFree=false` / `bookingPrice>0`) deals.
- Pick the slot with `dateStr`=requested date AND `displayTime`=requested time; take the
  chosen **deal's** `slotId` + `itemId` and the **slot's** `reservationTime`. Copy exactly;
  never derive from display time / name.
- A per-date meal window in the summary means every 15-min time in the range is bookable;
  trust it.
- `availableInventory` is live and time-sensitive; reconfirm if the user waits.
- Don't auto-call book_table; wait for the user to pick.
- IST for display (all restaurants in India).

## 4. create_cart — Reserve, mutating (PAID deals only)

Inputs

| Param | Type | Req | Notes |
| --- | --- | --- | --- |
| `restaurantId` | string | yes | |
| `cartType` | `"DEAL_TICKET_PURCHASE" \| "DINEOUT"` | yes | booking = `DEAL_TICKET_PURCHASE`; `DINEOUT` = bill payment |
| `latitude` | number | yes | |
| `longitude` | number | yes | |
| `slotId` | number | yes for DEAL_TICKET_PURCHASE | `deals[].slotId` |
| `itemId` | string | yes for DEAL_TICKET_PURCHASE | `deals[].itemId` |
| `reservationTime` | number | yes for DEAL_TICKET_PURCHASE | `slot.reservationTime` |
| `guestCount` | number | yes for DEAL_TICKET_PURCHASE | 1–20 |
| `billAmount` | number | yes for DINEOUT | rupees |
| `source` | string | no | bill payment; default `"direct-payment-cart"` |

Output `data`

```ts
{
  cart: {
    cartId?: string; cartKey: string;
    cartType?: "DEAL_TICKET_PURCHASE" | "DINEOUT";
    restaurantId?: string;
    bill?: { billToPay?: number; skipPayment?: boolean; dineoutPricingInfo?: { billToPay?: number } };
  };
  cartKey: string;                          // pass to book_table
  availablePaymentMethods: string[];
  paymentOptions: {
    allMethods: PaymentMethod[];
    upiMethods?: PaymentMethod[];
    allGroups?: Array<{ group_name?: string; display_name?: string; methods?: PaymentMethod[] }>;
    paymentAmount?: string | null;
    markdown?: string;
  } | null;
  gpoError?: string;
}
type PaymentMethod = { id: string; groupName?: string; displayName?: string;
  kind?: "intent" | "qr"; iconUrl?: string; enabled?: boolean };
```

Gotchas: for FREE deals **skip** create_cart. After create_cart show a Booking Summary
(`billToPay` as live total) and **STOP** until the user taps "Proceed to payment"; only then
show payment methods. `skipPayment` = price indicator. Refresh the cart if slot/guests change.

## 5. get_payment_options — Payment, read-only

Inputs: `addressId` string, optional, **Food only** (no Dineout-specific input documented;
no `cartKey` param).

Output `data`

```ts
{
  platforms?: {
    mobile?:  { groupName: string; methods: PaymentMethod[] };  // UPI apps (intent)
    desktop?: { groupName: string; methods: PaymentMethod[] };  // scan-QR
  };
  allMethods: PaymentMethod[];
  paymentAmount?: string | null;
  placeOrderToolName: "book_table";
}
```

Gotchas: offer only returned methods. UPI app → `paymentMethod:"UPI"` + `intentApp:<method.id>`
(never put an app id in `paymentMethod`). Scan-QR → `paymentMethod:"UPI"` + `generateUPIQR:true`.
Never ask for a UPI ID/VPA (NPCI). **"Dineout reservations are paid by UPI (or are free);
there is no Cash on delivery option."** [CONFLICT] Pay-with-UPI recipe says COD is the
fallback on Dineout; the Dineout reference says no COD.

## 6. book_table — Reserve, mutating, NOT idempotent

Inputs

| Param | Type | Req | Notes |
| --- | --- | --- | --- |
| `restaurantId` | string | yes | from search/details |
| `slotId` | number | yes | `slot.deals[].slotId` of the chosen deal |
| `itemId` | string | yes | `slot.deals[].itemId` ("restaurantId-ticketId") |
| `reservationTime` | number | yes | `slot.reservationTime` (unix) |
| `guestCount` | number | yes | 1–20 |
| `latitude` | number | yes | from search/details response |
| `longitude` | number | yes | |
| `paymentMethod` | `"Cash" \| "UPI"` | no | omit/"Cash" for FREE; "UPI" for paid |
| `cartKey` | string | no | paid only, from create_cart |
| `intentApp` | string | no | paid only, method id from payment options; omit when `generateUPIQR` |
| `generateUPIQR` | boolean | no | paid, desktop QR |

No `date`, `time`, `partySize`, `guestName`, `guestPhone`, `addressId` params exist.
[CONFLICT] book-a-table recipe calls it with only restaurantId/slotId/guestCount and reads
`booking.data.bookingId`; the reference requires all 7 fields and returns `orderId`.

Output `data` — union:

```ts
// FREE (confirmed in one step)
{ orderId: string; isDineout: true; restaurantName: string; restaurantLocation?: string;
  reservationDate: string; reservationTime: string; guestCount: number; status: string; }
// PAID UPI
{ orderId: string; paasId: string; transactionId: string; upiIntentUrl: string; bridgeUrl: string;
  isQrFlow: boolean; pollingIntervalInMs: number; maxTimeToPollForInMs: number;
  paymentMethod: "UPI"; status: "PENDING_PAYMENT"; isDineout: true;
  restaurantName?: string; restaurantLocation?: string; reservationDate?: string;
  reservationTime?: string; guestCount?: number; }
```

Note `reservationTime` in the OUTPUT is a **string** (display), unlike the numeric input.

Confirmation rules: message starting `"Confirm booking:"` = already confirmed via UI → call
immediately. Free-typed request → show summary and ask first. `bridgeUrl` is the headless
payment link (scan-or-tap page). Don't poll faster than `pollingIntervalInMs`; stop at
`maxTimeToPollForInMs`. Next: get_booking_status (free) / check_payment_status (paid).

## 7. check_payment_status — Payment, read-only (long-poll ~19s)

Inputs: `paasId` string **required** (from book_table; never a method name like "UPI" or
"PayWithQR" — if you have no real paasId, don't call); `orderId` string optional (pass when
you have it). `addressId`/`cartId`/`lat`/`lng` are Food-only.

Output `data`

```ts
{ paasId: string; status: string; terminal: boolean; isTerminalSuccess: boolean;
  isTerminalFailure: boolean; confirmed?: boolean; orderStatus?: string; cartTotal?: number;
  orderId?: string; addressId?: string; cartId?: string; lat?: number; lng?: number; }
```

`status` values (recipe): `success`/`paid` → placed (check `confirmed`); `failed` → don't
confirm, offer new attempt; `cancelled` → tell user, don't retry; `cart_changed` → not
placed, review & place again; `refund-initiated` → stop; `pending` → keep waiting (capped).
`terminal:true` → stop polling. `confirmed:true` → **do not** call confirm_order.

## 8. confirm_order — Payment, mutating, idempotent

Inputs (Dineout): `orderId` string **req**, `paasId` string **req for Dineout**,
`transactionId` string optional. (`addressId/cartId/lat/lng` are Food-only.)

Output `data`: `{ orderId: string; paasId?: string; orderStatus?: string; result: "success" | "failed" | "pending" | string }`

Call only after a successful terminal status that is not `confirmed`, or once at your poll cap
while still pending (backend marks failed if payment is non-terminal). Never after
failed/refund-initiated. `result:"failed"` means NOT placed.

## 9. get_booking_status — Manage, read-only

Inputs: `orderId` string req (from book_table).
[CONFLICT] book-a-table recipe uses `bookingId: booking.data.bookingId` — wrong; use `orderId`.
There is no "list my bookings" tool; without an orderId, ask the user.

Output `data`: `{ orderId: string; restaurantId: string; restaurantName: string; reservationDate: string; reservationTime: string; guestCount: number; dealTitle: string; status: string; restaurantLocation?: string }`
(status examples in description: confirmed / cancelled / completed.)

## 10. cancel_booking — Manage, mutating, destructive (partial rollout)

Inputs: `orderId` string req; `cancellationReason` string optional (not shown to user).
Output `data`: `{ orderId: string; status: "CANCELLED"; cancelledAt: string }`
May be absent from `tools/list` for some accounts. No orderId → don't call; ask. Always confirm
("Are you sure you want to cancel order <orderId>?"). On `success:false` → direct user to the
Swiggy Dineout app or customer care 080-67466729.

## 11. report_error — Support, mutating

Inputs: `tool` string req; `errorMessage` string req; `domain` string opt ("dineout");
`flowDescription` string opt; `toolContext` object opt (restaurantId, slotId, itemId,
guestCount, orderId, paymentMethod…); `userNotes` string opt.
Output `data`: `{ reportLink: string /* mailto: */; supportEmail: string; summary: string }`.

---

## The documented flow

```
search_restaurants_dineout(query, latitude, longitude)
  → data.restaurants[].id, data.latitude, data.longitude
get_restaurant_details(restaurantId, latitude, longitude)        [optional, on user pick]
get_available_slots(restaurantId, date=YYYY-MM-DD, latitude, longitude)
  → 7 days of slots; user picks dateStr + displayTime + ONE deal
  ├─ deal FREE (isFree=true / bookingPrice 0):
  │     book_table(restaurantId, slotId=deal.slotId, itemId=deal.itemId,
  │                reservationTime=slot.reservationTime, guestCount, latitude, longitude)
  │     → { orderId, status, reservationDate, reservationTime, … }   (confirmed in one step)
  └─ deal PAID (isFree=false / bookingPrice>0):
        create_cart(cartType="DEAL_TICKET_PURCHASE", restaurantId, latitude, longitude,
                    slotId, itemId, reservationTime, guestCount)
        → cartKey, cart.bill.billToPay  → show Booking Summary, STOP
        user taps "Proceed to payment" → get_payment_options() → user picks UPI app / QR
        book_table(…same 7 fields…, paymentMethod="UPI", cartKey, intentApp | generateUPIQR=true)
        → { status:"PENDING_PAYMENT", orderId, paasId, bridgeUrl, pollingIntervalInMs, maxTimeToPollForInMs }
        check_payment_status(paasId, orderId)  every pollingIntervalInMs, cap maxTimeToPollForInMs
        → terminal success & !confirmed → confirm_order(orderId, paasId)
get_booking_status(orderId)          → status card
cancel_booking(orderId)              → only after explicit user confirmation
```

Attribution: show "Powered by Dineout" with results, details/slots, booking summary and status.
