# Swiggy Scenes MCP — tool contracts

Source: `docs/swiggy-mcp/builders-llms-full.txt` (Scenes reference ~L9858–12093, index ~L11418, "Pay with UPI end-to-end" ~L713–946, "Ship to production" ~L947–1120, "Widgets" ~L1121–1185, "Error codes" ~L3555–3600).
Only facts from those docs. Anything inferred is marked **(inferred)** / **(unclear)**.

- **Endpoint:** `POST https://mcp.swiggy.com/scenes` (MCP streamable HTTP, JSON-RPC `tools/call`). 15 tools.
- **Auth:** OAuth 2.1 bearer token. One token works across all four servers. User identity is never a tool argument. A 401 or JSON-RPC `-32001` means you re-run OAuth; never retry with the same token.
- **Widgets:** Scenes is `hasWidgets: true`. Widget HTML comes over MCP `resources/read` (`ui://widget/...`, advertised as `_meta.ui.resourceUri` on the tool). Clients without widgets render from `data`. Image/media fields are **removed** from Scenes responses, so build cards from the text fields.
- **Universal rule (every tool):** "Use returned identifiers and enum values exactly as provided; do not invent fallback IDs, status values, payment methods, or timestamps." Optional fields may be missing.

## Envelope and errors (all tools)

```jsonc
// success
{ "success": true, "data": { /* tool-specific */ }, "message": "optional human-readable" }
// failure
{ "success": false, "error": { "message": "…", "reportId"?: "ERR-…", "reportHint"?: "Run report_error …" } }
```

- There is no symbolic `error.code`. Classify by HTTP / JSON-RPC status plus the `error.message` prefix.
- **Bad input:** HTTP 400 with `Invalid …` / `Missing …`. Fix the args and do not retry.
- **Domain failure:** HTTP 200 with `success:false`. Mostly terminal (sold out, show gone). Surface it to the user and do not retry.
- **Upstream timeout or error:** 502, 503, 504, or `timeout` in the message. Back off exponentially (500ms doubling, max 5).
- **Internal:** 500 or `-32603`. Back off once, then `report_error`.
- **Rate limited:** 429 / `-32000`. Honour `Retry-After`.
- **Forbidden:** `-32003`.
- **Exceptions to the envelope:**
  - `get_event_booking_status` returns its payload under **`booking`**, not `data`.
  - `discover_events`, `get_events_collection`, `get_event_venue_info` and `list_event_shows` also echo `latitude`/`longitude` (and sometimes `eventId`/`venueId`) **alongside** `data`.
- **Retries:** reads are always safe. `place_event_order` is **not** safe to blind-retry: there is no idempotency key, so use check-then-retry (inferred for Scenes; the docs name the Food/IM/Dineout placers explicitly). `confirm_order` *is* idempotent for the same ids.
- The docs list no Scenes-specific error strings except "sold-out/unavailable show → non-retryable error" (create_event_cart).

---

## Discover stage

### get_saved_locations — read-only
List the user's saved addresses, ranked for selection. When there are several, confirm with the user and pass the chosen `id` as `addressId`. No coordinates are returned.

| param | type | req | notes |
|---|---|---|---|
| latitude | number | no | only if the client supplies it; must pair with longitude; never infer or ask |
| longitude | number | no | same |

```ts
data: { locations: Array<{ index: number; id: string; addressLine: string; phoneNumber: string; addressCategory?: string; addressTag?: string }> }
```

### discover_events — read-only
Use for genre/category queries and general browsing. Do **not** use it when the user names a specific artist (use `search_events`).

| param | type | req | notes |
|---|---|---|---|
| latitude | number | no* | *one of (lat+lng) **or** addressId is REQUIRED |
| longitude | number | no* | |
| addressId | string | no* | from `get_saved_locations`; server resolves coords |

```ts
data: {
  events: Array<{ eventId: string; eventName: string; venueName: string; area: string; date: string; price: string }>;
  collectionChips: Array<{ collectionIdentifier: string; label: string }>;
}
// + resolved `latitude`, `longitude` echoed alongside data → reuse for EVERY follow-up Scenes call
```

Gotchas:
- With no location, call `get_saved_locations` or ask for a city/area.
- **Genre query:** find the chip whose `label` matches the genre, then call `get_events_collection(collectionIdentifier)` immediately. Never use `search_events` for genres.
- `price` is a display **string**. Use cart totals for checkout.
- `eventId` goes to `get_event_details`.

### get_events_collection — read-only
Returns the full listing for one genre chip. Call it only with a chip id from `discover_events`.

| param | type | req | notes |
|---|---|---|---|
| collectionIdentifier | string | **yes** | the docs describe it as "numeric", but it is typed string (example `"1042"`) |
| latitude / longitude | number | no | same location used for discover |
| addressId | string | no | |

```ts
data: { events: Array<{ eventId: string; eventName: string; venueName: string; area: string; date: string; price: string }> }
// + latitude/longitude echoed alongside data
```

### search_events — read-only
An auto-suggest search for a **specific artist or exact show title**. It returns at most 4 suggestions.

| param | type | req | notes |
|---|---|---|---|
| query | string | **yes** | artist / show name |
| latitude / longitude | number | no | |
| addressId | string | no | |

```ts
data: { suggestions: Array<{ eventId: string; eventName: string; location: string }> }   // ≤ 4
```

Gotchas:
- Genre words return 1 result or nothing.
- An empty `suggestions` list means no match. Tell the user and offer `discover_events`. Do **not** retry the same query.
- The key is `suggestions`, not `events`, and there is no venue, date or price.

### get_event_details — read-only
This is the **only** source of `venueId`. Always call it between discover/search and `list_event_shows`.

| param | type | req | notes |
|---|---|---|---|
| eventId | string | **yes** | |
| latitude / longitude | number | no | same as used for discover |

```ts
data: {
  eventId: string; eventName: string; venueId: string; venueName: string; area: string;
  formattedAddress: string; venueLat: string; venueLng: string; upcomingDate: string; price: string;
}
```

Gotchas:
- `venueLat`/`venueLng` are **strings** describing the venue, not the user. Keep passing the user's coordinates.
- `venueId` is needed by `list_event_shows` (scoping) and `create_event_cart`.

### get_event_venue_info — read-only (NOT in the booking flow)
For browsing which venues host an event. Skip it if you are about to call `list_event_shows`.

| param | type | req | notes |
|---|---|---|---|
| eventId | string | **yes** | |
| venueId | string | no | omit for all venues |
| latitude / longitude | number | no | |
| dateSummaryStartTime / dateSummaryEndTime | string ISO-8601 | no | default now / now+30d |
| showStartTime / showEndTime | string ISO-8601 | no | default now / now+5d |

```ts
data: {   // live payload, snake_case
  venue_details?: { venue_id?: string; name?: string; address?: string; city?: string; lat_lng?: { latitude: number; longitude: number } };
  event_info?: { event_id?: string; title?: string; description?: string; genre?: string; language?: string; duration_minutes?: number };
}
// + eventId, and optional venueId/latitude/longitude echoed alongside data
```

---

## Tickets stage

### list_event_shows — read-only
Step 3 of booking. Returns shows grouped by date, with times, seats and ticket types with prices, plus venue details.

| param | type | req | notes |
|---|---|---|---|
| eventId | string | **yes** | |
| venueId | string | no (but required to book) | from `get_event_details`; without it the listing spans venues and is "not safe to book from" |
| latitude / longitude | number | no | |
| dateSummaryStartTime / End | string ISO-8601 | no | window ≤ 30 days |
| showStartTime / End | string ISO-8601 | no | window ≤ 5 days, ≤ 100 shows |

```ts
data: {
  eventShowListing: {
    dateSummary?: unknown;
    venueDetails?: { venueId?: string; name?: string; address?: string; city?: string; latLng?: { latitude?: number; longitude?: number } };
    eventInfo?: { eventId?: string; title?: string; description?: string; genre?: string; language?: string; durationMinutes?: number };
    dateGroupedEventShow?: Array<{
      date?: string;
      eventShow?: Array<{
        showId?: number;                                   // NUMBER
        timeRange?: { startTime?: string; endTime?: string }; // no TZ offset — do not parse
        show_time_unix?: number;                           // epoch SECONDS → create_event_cart.showTime verbatim
        show_time_ist?: string;                            // display verbatim, e.g. "Thu, 10 Jul, 7:30 pm"
        availableSeats?: number;                           // per SHOW
        tickets?: Array<{ ticketId?: string; ticketTitle?: string; price?: number }>;
      }>;
    }>;
  };
}
// + eventId, latitude, longitude (+ venueId if scoped) echoed alongside data
```

Gotchas:
- Every field is optional (live passthrough).
- Started shows are removed and empty date groups are dropped. An empty result means nothing is bookable in the window.
- Copy `showId` and `tickets[].ticketId` from the exact selection. Never derive them from the time or venue name.

### create_event_cart — MUTATING
Creates the cart for one show and ticket after the user picks a show and ticket and confirms the guest count.

| param | type | req | notes |
|---|---|---|---|
| venueId | string | **yes** | from `get_event_details` |
| showId | **number** | **yes** | from `list_event_shows` |
| ticketId | string | **yes** | from `list_event_shows` `tickets[].ticketId` |
| showTime | number | **yes** | `show_time_unix` verbatim (unix **seconds**, must be in the future). **Never** convert `show_time`/ISO yourself |
| guestCount | number | **yes** | 1–20 |
| latitude | number | **yes** | user lat |
| longitude | number | **yes** | user lng |

```ts
data: {
  cart: {
    cartId?: string;
    cartKey: string;
    bill?: { billToPay?: number; skipPayment?: boolean; dineoutPricingInfo?: { billToPay?: number } };
  };
  cartKey: string;
  checkoutMode: "FREE" | "UPI" | "UNAVAILABLE";   // AUTHORITATIVE next step
}
// response `message` = authoritative text summary of the created cart
```

Branch on `checkoutMode`:
- **FREE:** show the summary and wait for explicit confirmation. Then call `place_event_order(paymentMethod:"FREE", …echoed selection)`. Do **not** call `get_event_cart` or any payment tool.
- **UPI:** show the summary and wait for explicit confirmation. Then call `get_payment_options(cartKey)`. Do **not** call `get_event_cart`.
- **UNAVAILABLE:** stop and explain that it cannot be booked.

A sold-out or unavailable show returns a **non-retryable** error. Show the message and ask the user to pick another show.

### get_event_cart — read-only (compatibility lookup, NOT in the normal flow)

| param | type | req |
|---|---|---|
| cartKey | string | **yes** |
| latitude | number | **yes** |
| longitude | number | **yes** |

```ts
data: {
  cart: {
    cartId?: string; cartKey: string;
    bill?: {
      skipPayment?: boolean;
      dineoutPricingInfo?: { billToPay?: number; totalFee?: number };
      charges?: Array<{ type?: string; value?: number; taxes?: { value?: number }; ctx?: { displayName?: string } }>;
    };
    items?: Array<{ quantity?: number; price?: number; bookingDate?: string; bookingSlot?: string; bookingSlotTime?: string;
                    ticketAttributes?: { ticketTitle?: string; effectivePrice?: number } }>;
    aggregatedItemsInfo?: { ticketTitle?: string; dateDisplayTitle?: string; timeDisplayTitle?: string; ticketCountTitle?: string };
    storesInfo?: Array<{ name?: string; address?: string }>;
  };
  cartKey: string; isFree: boolean; paymentAvailable: boolean;
}
```

- UPI carts only. A FREE cart cannot be read back.
- Do not call it after `create_event_cart` and do not retry it.
- Continue to payment only if `paymentAvailable === true`. Otherwise send the user to the Swiggy app.

---

## Payment stage (shared tools, Scenes variant)

### get_payment_options — read-only

| param | type | req | notes |
|---|---|---|---|
| cartKey | string | **yes for Scenes** | exact `cartKey` from `create_event_cart` |
| addressId | string | no | Food only — do not send for Scenes |

```ts
data: {
  platforms?: { mobile?: { groupName: string; methods: PaymentMethod[] };   // UPI apps (intent)
                desktop?: { groupName: string; methods: PaymentMethod[] } }; // scan-QR
  allMethods: PaymentMethod[];          // UPI only for Scenes — never Cash
  paymentAmount?: string | null;
  placeOrderToolName: "place_event_order";
  cartKey?: string;                     // echoed
}
type PaymentMethod = { id: string; groupName?: string; displayName?: string; kind?: "intent" | "qr"; iconUrl?: string; enabled?: boolean };
```

- Offer only the returned methods. Never invent one.
- **No Cash on Scenes.** Swiggy Money also does **not** apply to Scenes (Swiggy Money blog post).
- Never ask for a UPI ID/VPA (NPCI rule).
- Never ask which device the user is on.
- If UPI isn't available on Scenes, stop and tell the user the ticket cannot be paid for right now.

### place_event_order — MUTATING (Booking stage)

| param | type | req | notes |
|---|---|---|---|
| cartKey | string | **yes** | from `create_event_cart` |
| paymentMethod | `"UPI" \| "FREE"` | **yes** | `"UPI"` iff checkoutMode=UPI; `"FREE"` iff checkoutMode=FREE |
| intentApp | string | no | UPI app: the selected method `id` from `get_payment_options`, byte-for-byte (e.g. `"com.phonepe.app"`). Omit for QR |
| generateUPIQR | boolean | no | `true` for the scan-QR path (no intentApp) |
| venueId | string | FREE only | echo from create_event_cart args |
| showId | number | FREE only | echo |
| ticketId | string | FREE only | echo |
| showTime | number | FREE only | echo the `show_time_unix` used |
| guestCount | number | FREE only | echo |
| latitude / longitude | number | FREE only | echo |

```ts
data:
  | { // FREE — placed immediately
      orderId: string; cartKey: string; status: string;   // "CONFIRMED" | "PROCESSING"
      paymentMethod: "FREE";
      restaurantName?: string; restaurantLocation?: string; reservationDate?: string; reservationTime?: string; guestCount?: number;
    }
  | { // UPI — NOT booked yet
      orderId: string; cartKey: string; paasId: string; transactionId: string;
      upiIntentUrl: string; bridgeUrl?: string; isQrFlow: boolean;
      pollingIntervalInMs: number; maxTimeToPollForInMs: number;
      status: "PENDING_PAYMENT";
      restaurantName?: string; restaurantLocation?: string; reservationDate?: string; reservationTime?: string; guestCount?: number;
    }
```

Gotchas:
- `PENDING_PAYMENT` means **not booked**. Never say "booked" until payment succeeds.
- FREE with `PROCESSING` means call `get_event_booking_status` before claiming success.
- For FREE, the returned `cartKey` is a recreated cart, so use the returned value.
- The venue and show fields come from a lookup that may fail. If they are missing, fall back to `get_event_booking_status`.
- `upiIntentUrl` is handled by the UI; the agent must not open it.
- Headless: share `data.bridgeUrl`, which opens a scan-or-tap page. It is present for both intent and QR. Read it from `data.bridgeUrl`, not from the message.
- `paasId` + `orderId` go to `check_payment_status`. `orderId` + `paasId` go to `confirm_order`.
- Not idempotent. On a network error, check `get_event_booking_status` before re-placing (inferred from the ship-to-production rule).

### check_payment_status — read-only (long-poll, ~19s server hold)

| param | type | req | notes |
|---|---|---|---|
| paasId | string | **yes** | the real `paasId` from `place_event_order`. Never pass a method name ("UPI", "PayWithQR", an app id). If you have no paasId, don't call |
| orderId | string | no | pass it when you have it |
| addressId / cartId / lat / lng | — | no | Food only — not for Scenes |

```ts
data: {
  paasId: string; status: string; terminal: boolean;
  isTerminalSuccess: boolean; isTerminalFailure: boolean;
  confirmed?: boolean; orderStatus?: string; cartTotal?: number; orderId?: string;
  addressId?: string; cartId?: string; lat?: number; lng?: number;
}
```

Rules:
- Poll every `pollingIntervalInMs` and stop at `maxTimeToPollForInMs` (both from place_event_order). Never tight-loop.
- `terminal:true` means stop polling.
- `isTerminalSuccess`: if `confirmed===true`, the order is already finalized, so do **not** call `confirm_order`. If it is not confirmed, call `confirm_order` once.
- `isTerminalFailure` (failed, cancelled, refund-initiated, cart-changed): do **not** confirm. Offer a fresh attempt (`get_payment_options`, then place again) where it makes sense.
- The recipe lists these `status` strings: `success`/`paid`, `failed`, `cancelled`, `cart_changed`, `refund-initiated`, `pending`. These come from the Food example. **(unclear)** whether Scenes uses the identical strings, so branch on the boolean flags.
- If you hit the cap while still pending, call `confirm_order` once (a late success reconciles server-side).
- Widget hosts auto-poll and auto-confirm. Do not start your own loop on a widget host.

### confirm_order — MUTATING, idempotent for the same ids

| param | type | req | notes |
|---|---|---|---|
| orderId | string | **yes** | from place_event_order |
| paasId | string | **yes for Scenes** | from the place_event_order UPI response |
| transactionId | string | no | |
| addressId / cartId / lat / lng | — | no | Food only; not used by Scenes |

```ts
data: { orderId: string; paasId?: string; orderStatus?: string;
        result: "success" | "failed" | "cancelled" | "cart_changed" | "refund_initiated" | "retry" }
```

- `success` means the ticket is booked.
- `failed`, `cancelled` and `refund_initiated` are final. Do not retry the same payment.
- `cart_changed` means the cart was repriced. Restart the booking from create_event_cart.
- `retry` means the outcome is unknown. Check status again before telling the user anything.
- Never call it after a terminal failure, and never call it when the payment was already `confirmed`.

### get_event_booking_status — read-only (Booking stage)

| param | type | req |
|---|---|---|
| orderId | string | **yes** |

```ts
booking: {   // ← NOT under `data`
  orderId: string; restaurantId: string; restaurantName: string; restaurantLocation?: string;
  reservationDate: string; reservationTime: string; guestCount: number; dealTitle: string; status: string;
  bill?: { subTotal: number; totalBillAmount: number;
           charges: Array<{ name: string; totalCost: number }>;
           taxes: Array<{ name: string; totalCost: number }>;
           discounts: Array<{ name: string; totalCost: number }> };
}
```

- `restaurantName`/`restaurantLocation` are the venue.
- `reservationDate`/`reservationTime`/`guestCount` are the show date, show time and ticket count.
- `status: "PROCESSING"` means the booking is not final. Wait and re-check; never report it as confirmed.

---

## Support

### report_error — MUTATING
Generates a pre-filled `mailto:` report.

| param | type | req | notes |
|---|---|---|---|
| tool | string | **yes** | failing tool name |
| errorMessage | string | **yes** | what the user saw |
| domain | string | no | auto-detected |
| flowDescription | string | no | |
| toolContext | object | no | ALWAYS include ids from the failed call (orderId, cartKey, eventId, venueId, showId, ticketId, paymentMethod, guestCount…) |
| userNotes | string | no | |

```ts
data: { reportLink: string /* mailto: */; supportEmail: string; summary: string }
```

---

## The documented booking flow

```
(location) get_saved_locations → addressId           — or client lat/lng; one of them is REQUIRED for discover
   │
   ├─ genre / browse:  discover_events{lat,lng | addressId}
   │                     → events[] + collectionChips[]; reuse echoed latitude/longitude from here on
   │                   └─ genre: get_events_collection{collectionIdentifier: chip.collectionIdentifier, same location}
   └─ named artist:    search_events{query, lat,lng | addressId} → suggestions[] (≤4; empty → offer discover, no retry)
   ▼
get_event_details{eventId, latitude, longitude}        → venueId (ONLY source), venueName, formattedAddress, upcomingDate, price
   ▼
list_event_shows{eventId, venueId, latitude, longitude}
   → eventShowListing.dateGroupedEventShow[].eventShow[] : showId(number), show_time_ist (display), show_time_unix (pass),
     availableSeats, tickets[]{ticketId, ticketTitle, price}
   ▼  user picks show + ticket, confirms guestCount (1–20)
create_event_cart{venueId, showId, ticketId, showTime: show_time_unix, guestCount, latitude, longitude}
   → cartKey, checkoutMode, cart.bill.billToPay, response message (= summary)
   ├─ UNAVAILABLE → stop, explain
   ├─ FREE → show summary → explicit user "yes" →
   │        place_event_order{cartKey, paymentMethod:"FREE", venueId, showId, ticketId, showTime, guestCount, latitude, longitude}
   │        → status CONFIRMED (done) | PROCESSING → get_event_booking_status{orderId}
   └─ UPI → show summary (+ billToPay) → explicit user "yes" →
            get_payment_options{cartKey} → user picks a RETURNED method
            place_event_order{cartKey, paymentMethod:"UPI", intentApp:<method.id>}   (app)
                         or  {cartKey, paymentMethod:"UPI", generateUPIQR:true}         (scan-QR)
            → status PENDING_PAYMENT, orderId, paasId, transactionId, upiIntentUrl, bridgeUrl, isQrFlow,
              pollingIntervalInMs, maxTimeToPollForInMs
            ▼  (widget host: automatic; headless: share bridgeUrl + own capped loop)
            check_payment_status{paasId, orderId}   every pollingIntervalInMs, until terminal or maxTimeToPollForInMs
            ├─ isTerminalSuccess && confirmed → done
            ├─ isTerminalSuccess && !confirmed → confirm_order{orderId, paasId}
            ├─ isTerminalFailure → NO confirm; offer get_payment_options → place again
            └─ cap reached, still pending → confirm_order{orderId, paasId} once
            ▼
            confirm_order.result: success → booked | cart_changed → restart at create_event_cart |
                                  failed/cancelled/refund_initiated → final | retry → re-check status
   ▼
get_event_booking_status{orderId} → read `booking.*` (not data); PROCESSING ≠ confirmed
```

**Go-live checklist items relevant here:**
- No order is placed without user-visible confirmation of the items and total.
- Order placement uses check-then-retry.
- Explicit 401/`-32001` and timeout branches.
- A correlation id is logged per call.
