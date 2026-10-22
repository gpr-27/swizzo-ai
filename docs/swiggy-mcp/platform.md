# Swiggy MCP platform contract (auth, payments, errors, limits, go-live)

Distilled from `docs/swiggy-mcp/builders-llms-full.txt` (Swiggy Builders Club docs) plus the
live metadata at `https://mcp.swiggy.com/.well-known/*` (fetched 2026-10-22). Line refs (`L1234`)
point into `builders-llms-full.txt`. Where two doc pages disagree, both are quoted and the
stricter reading is marked **Use**.

---

## 1. Servers

| Server | URL | Place-order tool | Notes |
| --- | --- | --- | --- |
| Food | `https://mcp.swiggy.com/food` | `place_food_order` | UPI, Cash, Swiggy Money |
| Instamart | `https://mcp.swiggy.com/im` | `checkout` | UPI, Cash, Swiggy Money, multi-store |
| Dineout | `https://mcp.swiggy.com/dineout` | `book_table` | FREE or paid-deal UPI |
| Scenes | `https://mcp.swiggy.com/scenes` | `place_event_order` | FREE or UPI, never Cash |
| Staging | `https://mcp-staging.swiggy.com/{server}` | same | seeded data, granted during access review (L1266) |

Transport: MCP streamable HTTP, JSON-RPC 2.0. Every call carries `Authorization: Bearer <access_token>`.
Server version is reported in `initialize` → `serverInfo.version` (currently `0.1.0`, L1812).

---

## 2. OAuth 2.1 + PKCE

### 2.1 Endpoints (live metadata confirmed)

```
issuer                  https://mcp.swiggy.com/auth
authorization_endpoint  https://mcp.swiggy.com/auth/authorize      (GET)
token_endpoint          https://mcp.swiggy.com/auth/token          (POST, JSON body)
registration_endpoint   https://mcp.swiggy.com/auth/register       (POST, RFC 7591 DCR)
logout                  https://mcp.swiggy.com/auth/logout         (POST, Bearer header)
AS metadata             https://mcp.swiggy.com/.well-known/oauth-authorization-server  (RFC 8414)
PR metadata             https://mcp.swiggy.com/.well-known/oauth-protected-resource    (RFC 9728)
scopes_supported        mcp:tools mcp:resources mcp:prompts
grant_types_supported   authorization_code refresh_token
code_challenge_methods  S256 only
token_endpoint_auth     none | client_secret_post | client_secret_basic   (use "none": public client + PKCE)
```

`/auth/send-otp` and `/auth/verify-otp` are internal to the consent UI and are **not** callable (L12142).

### 2.2 client_id

- There is no client ID to apply for. Clients self-register with **Dynamic Client Registration** at
  `POST /auth/register`, and the `client_id` comes back in that response (L12146, L13112, L13143).
- Our current hardcoded `client_id=swiggy-mcp` is an undocumented value that happens to work on
  localhost. For production, register once with DCR and put the returned id in env
  (`SWIGGY_OAUTH_CLIENT_ID`). The redirect URI must still be allowlisted by Swiggy (§2.4).

DCR request (RFC 7591 shape; Mastra example at L12854 uses these fields):

```json
POST https://mcp.swiggy.com/auth/register
Content-Type: application/json
{
  "client_name": "swiggy-chat",
  "redirect_uris": [
    "http://localhost:3000/api/auth/callback",
    "https://<app>.vercel.app/api/auth/callback"
  ],
  "grant_types": ["authorization_code", "refresh_token"],
  "response_types": ["code"],
  "token_endpoint_auth_method": "none"
}
→ { "client_id": "...", ... }
```

### 2.3 Authorize → token

1. Generate `code_verifier = base64url(32 random bytes)` and `code_challenge = base64url(sha256(verifier))`.
   Use a fresh pair **per user per login** (L13119).
2. Redirect the browser to:
   ```
   https://mcp.swiggy.com/auth/authorize?response_type=code&client_id=<dcr id>
     &redirect_uri=<exact allowlisted URI>&code_challenge=<challenge>
     &code_challenge_method=S256&state=<random CSRF token>&scope=mcp:tools
   ```
   The docs' examples use `scope=mcp:tools`. The token response still grants all three scopes.
   Requesting `mcp:tools mcp:resources mcp:prompts` is also valid, and v1 says scopes are
   requested uniformly. `prompt=login` is **not documented**.
3. The user enters phone + OTP. Swiggy then sends `302 → redirect_uri?code=...&state=...`. **Verify `state`.**
4. Exchange within **120 s**. The code is single-use:
   ```json
   POST /auth/token  {"grant_type":"authorization_code","code":"...","code_verifier":"...",
                      "redirect_uri":"<same exact URI>","client_id":"<dcr id>"}
   → {"access_token":"eyJ...","refresh_token":"eyJ...","token_type":"Bearer",
      "expires_in":432000,"scope":"mcp:tools mcp:resources mcp:prompts"}
   ```
   (`client_id` in the body is shown in the delegated-auth example, L13156. Send it.)

### 2.4 Redirect URI rules (L12217, L1252, L12997)

- HTTPS is required. The one exception is `http://localhost` for local development.
- Matching is exact: no wildcards and no prefix matching. Every Vercel preview URL is a
  different URI, so allowlist **one stable production domain** only.
- Custom schemes are allowed only for known MCP clients (`cursor://`, `vscode://`, `claude://`, `windsurf://`), and platform schemes case by case.
- Open redirects are not allowed.
- New URIs are registered by email to **builders@swiggy.in**, or in the `/access` application form.
- If the URI doesn't match, the browser gets "stuck on /authorize" (L12318).

### 2.5 Token lifecycle (L12226, L13195)

| Item | Lifetime |
| --- | --- |
| Access token (from code) | 5 days (`expires_in: 432000`) |
| Token from a refresh | 30 days from each refresh (`expires_in: 2592000`); read `expires_in`, don't hardcode |
| User session | 30 days idle, sliding |
| Authorization code | 120 s, single-use |

The access token is a signed JWT (RS256) with claims `user_id`, transaction id, `iat` and `exp`.
Scopes are not in the claims. Tokens can be revoked server-side before `exp`.

### 2.6 Refresh grant (L12278–12300)

```json
POST https://mcp.swiggy.com/auth/token
Content-Type: application/json          (no Authorization header)
{"grant_type":"refresh_token","refresh_token":"<latest>","user_id":"<optional; must match>"}
→ 200 {"access_token":"...","token_type":"Bearer","expires_in":2592000,"refresh_token":"..."}
```

- The refresh token **rotates**. Persist the new `refresh_token` and discard the old one. Today it
  equals the new access token.
- The response has no `user_id`. Decode it from the JWT if you need it.
- Errors follow the OAuth shape `{error, error_description}`:
  - `400 invalid_request`: missing or malformed token. Do not retry.
  - `400 invalid_grant`: bad signature, expired token, or user_id mismatch. **Don't retry. Re-run authorization.**
  - `500 server_error`: retry with backoff.
- An expired token **cannot** be refreshed. Store `expires_at = now + expires_in` and refresh
  proactively when ≤ 60 s remain (L12306).

### 2.7 What to store (L12302)

- Store the access token and the refresh token per user, in secure storage: an encrypted httpOnly
  cookie or a server-side session store. Never share them across users (L13175).
- **Never** write tokens to disk in plaintext, never log them, and never send them over non-HTTPS.
- Don't put tokens in URLs. This is not stated in the doc, but it follows from the rules above:
  URLs end up in logs, history and `Referer`.

### 2.8 Logout

`POST https://mcp.swiggy.com/auth/logout` with `Authorization: Bearer <access_token>`. This revokes the
Swiggy session. Then delete the stored tokens (L13215).

### 2.9 Auth failure handling

| Signal | Meaning | Action |
| --- | --- | --- |
| HTTP 401 / JSON-RPC `-32001` | expired or invalid token | refresh once → retry the call once; if refresh fails, run the full authorization |
| HTTP 419 | session revoked | full re-auth (phone + OTP) |
| HTTP 403 / JSON-RPC `-32003` | scope too narrow / forbidden | re-auth with broader scope |
| "Cannot resolve session" | missing `Authorization` header | add the header |

Conflict: Ship-to-production (L1017) says "re-run OAuth, never retry with the same token", while
Authenticate (L12235, L12239) says "refresh first". **Use** refresh first, never resend the same
stale token, and fall back to authorization.

---

## 3. Connection & session hygiene (L1658)

- Use **one MCP session per user, not one per request.** Auth happens once per connection. **Never create
  a new `initialize` handshake per tool invocation.**
- Initialize servers **sequentially**: connect `/im`, wait, then `/food`, and so on. Not in parallel.
- Back off on auth errors. Don't tight-loop reconnects. If you stay blocked, email builders@swiggy.in.
- The HTTP transport is described as stateless, with no per-call session id returned (L1048). Generate
  your own **correlation id** per call and log it, then quote it with a timestamp in support tickets.
- Cache low-churn data: one `get_addresses` per session, plus restaurant metadata. Don't poll `track_*`
  faster than every **10 s**.

In practice, for a serverless Next.js app: cache a connected `Client` per (user-token-hash, server) in
module scope with an idle TTL, and reconnect only when the token changes or the transport errors.

---

## 4. Errors

### 4.1 Envelope (L3561)

```json
{ "success": false, "error": { "message": "...", "reportId": "ERR-...", "reportHint": "Run report_error..." } }
```

Success responses are `{ success: true, data, message? }`. There is **no symbolic `error.code`**. Classify by
HTTP status, JSON-RPC code and `error.message` prefix. Unknown future codes count as generic failures (L1832).

JSON-RPC transport codes: `-32001` unauthenticated/expired, `-32003` forbidden, `-32000` too many requests
or method not allowed, `-32603` internal.

### 4.2 Classification (L3585)

| Bucket | Detect | React | Retry? |
| --- | --- | --- | --- |
| Auth | 401 / `-32001` | refresh → re-auth | once, after refresh |
| Session revoked | 419 | full re-auth | no |
| Forbidden | 403 / `-32003` | re-auth with broader scope | no |
| Bad input | 400, message `Invalid ...` / `Missing ...` | fix the args | **no** |
| Rate limited | 429 / `-32000` + `Retry-After` | wait `Retry-After` seconds | yes (honor the header, don't stack backoff) |
| Upstream timeout | 504 or message contains `timeout` | exp backoff | yes, max 5 |
| Upstream error | 502 / 503 | exp backoff | yes, max 5 |
| Internal | 500 / `-32603` | backoff **once**, then `report_error` | once |
| Network/no status | fetch threw | exp backoff | yes, **reads/cart only** |
| Domain failure | HTTP 200, `success:false` (or `isError:true`) | show `message` to the user (out of stock, slot gone, closed) | **no** |

### 4.3 Idempotency classes (L957)

| Class | Tools | Blind retry? |
| --- | --- | --- |
| Pure reads | `get_addresses`, `search_*`, `get_*_cart`, `get_payment_options`, `get_*order*` | always |
| Cart mutations (absolute state) | `update_cart`, `update_food_cart`, `clear_cart`, `flush_food_cart` | yes |
| Coupons | `apply_food_coupon`, `apply_coupon` | yes |
| Tracking | `track_order`, `track_food_order`, `get_booking_status`, `get_event_booking_status` | always (≥10 s apart) |
| `confirm_order` | | idempotent for the same ids; retry on transient errors only (L4011, L13633) |
| `check_payment_status` | | read-only, but a **~19 s long-poll**; never stack retries on top of a poll |
| **Order placement** | `place_food_order`, `checkout`, `book_table`, `place_event_order` | **NO.** Use check-then-retry |

Check-then-retry for placement (L967). There is no `Idempotency-Key` and no server-side dedupe:
1. On a 5xx or network error, wait 2–5 s.
2. Look the order up with `get_food_orders` / `get_orders` / `get_booking_status` (or `get_event_booking_status`).
3. If it exists, treat the call as a success. Otherwise retry **once**.

Instamart `checkout` has `confirmDuplicate`. Set it **only** when a previous checkout was rejected as a
probable duplicate, the rejection told you to use it, and the user re-confirmed. Never use it to
retry a failed or timed-out checkout (L7327).

### 4.4 Backoff (L978, L3598)

- Delays are 500 ms → 1 s → 2 s → 4 s (→ 8 s cap), with +0–30 % jitter. Max 4 attempts (ship-to-prod) or
  5 retries (errors page). **Use** 4 attempts.
- On a 429, sleep `Retry-After` seconds (default 30 when the header is missing) **instead of** the backoff step.
- **Retry budget**: cap total retry wall-clock at **30 s** for user-facing flows, then fail loudly.
- The MCP TS SDK (`@modelcontextprotocol/sdk` 1.29) throws `StreamableHTTPError` with the HTTP status in
  **`err.code`**. The message is `"Streamable HTTP error: Error POSTing to endpoint: <body>"` and contains no
  status. Response headers (`Retry-After`) are not exposed. To read them, pass a custom `fetch` to
  `StreamableHTTPClientTransport`. JSON-RPC errors arrive as `McpError` with `err.code` (e.g. `-32001`).

### 4.5 report_error

`report_error` exists on all four servers. Use it for in-session, user-reported errors. It captures the tool,
the context and user notes, and pre-links the session id for Swiggy support (L1763).

---

## 5. Rate limits (L1631)

- There is no in-app limiter and no `X-RateLimit-*` headers. Per-user and aggregate caps are enforced at
  the gateway. When a cap is hit you get `429` + `Retry-After` (JSON-RPC `-32000`).
- Exact caps are not published. Email builders@swiggy.in before launching at scale, and 7 days before big traffic events.
- OTP send/verify have their own upstream throttle. Don't loop logins.
- Peak meal hours are 12:00–14:00 and 19:00–22:00 IST. A voice-style flow bursts 4–6 calls in 3 s.
  Keep concurrency reasonable and run sequences rather than fan-outs.

---

## 6. Payment stage (UPI / Cash / Swiggy Money)

### 6.1 The flow (L719)

```
cart ready → get_payment_options → [user picks + explicitly confirms items/total/address]
  → place-order (UPI → PENDING_PAYMENT, returns paasId/orderId/bridgeUrl/upiIntentUrl/polling hints)
  → check_payment_status (long-poll, capped) → confirm_order (only if needed) → track
Cash / SwiggyPay: place-order is final (normalizedStatus "success"); no polling, no confirm_order.
```

### 6.2 get_payment_options (`data: PaymentOptionsView`, L5517)

```ts
{ platforms?: { mobile?: {groupName, methods: PaymentMethod[]}, desktop?: {...} },
  cod?: {available, id, displayName}, swiggyMoney?: {available, id:"SwiggyPay", displayName},
  reservePay?: {...}, agenticPaymentEligible: boolean, allMethods: PaymentMethod[],
  paymentAmount?: string|null, addressId?: string, placeOrderToolName: string }
PaymentMethod = { id, groupName?, displayName?, kind?: "intent"|"qr", iconUrl?, enabled? }
```

Arguments by server:

| Server | Args |
| --- | --- |
| Food | `addressId` (the same one used for `get_food_cart`) |
| Instamart | none |
| Dineout | none |
| Scenes | **`cartKey`** (required, from `create_event_cart` when `checkoutMode=UPI`) |

Rules:
- **Offer only returned methods.** Don't invent or assume methods, ids or fallbacks (L5548, L5557).
- If UPI is unavailable, `platforms` is omitted and only Cash appears in `allMethods`.
- Offer Swiggy Money only when `swiggyMoney.available === true`. Food and Instamart only.
- Cash differs by server:
  - Food and Instamart: COD when `cod` is returned.
  - Scenes: never Cash.
  - Dineout: the schema notes say "UPI (or free); there is no Cash on delivery option" (L2900+), while
    the UPI recipe (L719) says COD is a fallback on Dineout. **Use** the live response. Free reservations
    use `paymentMethod` omitted or `"Cash"` on `book_table`.
- Never ask for a UPI ID / VPA (NPCI). UPI Collect and saved VPAs are not surfaced.
- Don't ask which device the user is on. Mobile = intent apps, desktop = scan-QR. Detect it yourself.

### 6.3 Place-order arguments

| Choice | Args |
| --- | --- |
| UPI app | `paymentMethod:"UPI"`, `intentApp:<method.id byte-for-byte>` (e.g. `"gpay://upi/"`, `"com.phonepe.app"`) |
| UPI scan-QR | `paymentMethod:"UPI"`, `generateUPIQR:true`, no `intentApp` |
| Cash | `paymentMethod:"Cash"` (Instamart also accepts `"COD"`) |
| Swiggy Money | `paymentMethod:"SwiggyPay"`, no `intentApp` or `generateUPIQR` |

Never put an app id in `paymentMethod`.

Per-server required args:
- **Food** `place_food_order`: `addressId`, plus optional `noteToRestaurant`. Coordinates are fetched server-side.
  There is no lat/lng input.
- **Instamart** `checkout`: `addressId`, plus optional `confirmDuplicate` (see §4.3).
- **Dineout** `book_table`: `restaurantId`, `slotId`, `itemId`, `reservationTime`, `guestCount` (1–20), `latitude`, `longitude`.
  A paid deal also needs `cartKey` from `create_cart(cartType:"DEAL_TICKET_PURCHASE")`.
- **Scenes** `place_event_order`: `cartKey` and `paymentMethod: "UPI" | "FREE"`. FREE also echoes `venueId`, `showId`,
  `ticketId`, `showTime`, `guestCount`, `latitude` and `longitude` from `create_event_cart`.

UPI response (Food, L5993):

```ts
{ orderId, paasId, transactionId, upiIntentUrl, bridgeUrl, isQrFlow, pollingIntervalInMs,
  maxTimeToPollForInMs, paymentMethod:"UPI", status:"PENDING_PAYMENT", normalizedStatus:"pending",
  totalAmount?, addressId, cartId, lat, lng }
```

The Instamart and Dineout UPI responses have the same payment fields. Instamart can also return the
multi-store shape `{orders[], orderCount, successCount, failureCount, allSucceeded}`.

- `bridgeUrl` is an opaque HTTPS page with a QR **and** an "Open in UPI app" button. It works on desktop
  and mobile, so you don't need to render your own QR. `upiIntentUrl` can be used for app launch or a
  locally rendered QR.
- **Never announce success on `PENDING_PAYMENT`.** Say something like "Complete the payment in your UPI app".
- Use the tool's `message` verbatim for branding on true success ("Swiggy order placed successfully",
  "Instamart order placed successfully").
- For cancellation, don't call a tool. Tell the user to call Swiggy customer care at 080-67466729.

### 6.4 check_payment_status (L3800)

Args:
- `paasId` (**required**: the real transaction id, never `"UPI"` or `"PayWithQR"`), plus optional `orderId`.
- **Food also echoes `addressId`, `cartId`, `lat`, `lng`** from the place-order response. Without them the server
  can't auto-confirm and the order stays pending.

Returns `{ paasId, status, terminal, isTerminalSuccess, isTerminalFailure, confirmed?, orderStatus?, ... }`.

- Server long-poll is ~19 s. Without a widget, run **one call at a time**:
  `do { call; if terminal break; sleep(pollingIntervalInMs) } while (now < start + maxTimeToPollForInMs)`.
  Never tight-loop, and never fire overlapping polls.
- Branch on `data.status`:
  - `success` / `paid`: placed. If `confirmed` is not true, call `confirm_order`.
  - `failed`: don't confirm. Re-show `get_payment_options`.
  - `cancelled`: tell the user (refund if paid). Don't retry.
  - `cart_changed`: the order was **not** placed and this is not a payment failure. Ask the user to review the cart.
  - `refund-initiated`: tell the user and stop.
  - `pending`: keep waiting, with the cap.
- Prefer the flags (`terminal`, `isTerminalSuccess`, `isTerminalFailure`, `confirmed`) over string matching.
- **At the cap while still pending**, call `confirm_order` **once**. The backend marks the order failed if payment is
  still non-terminal, and a late success reconciles server-side.

### 6.5 confirm_order (L3957)

| Server | Required args |
| --- | --- |
| Food | `orderId` + `addressId` + `lat` + `lng` (+ `cartId` recommended), **no paasId** |
| Instamart / Dineout / Scenes | `orderId` + `paasId` (+ `transactionId` optional) |

Returns `data.result: "success" | "failed" | "pending"`. Only `success` means placed. It is idempotent.
Don't call it after a failure, cancellation, refund or `confirmed=true`, and it is not needed for Cash or SwiggyPay.

### 6.6 Swiggy Money (L5559, blog L13371)

- Food and Instamart only.
- Offer it only if `swiggyMoney.available`. Availability does not mean the balance covers the total.
- After explicit confirmation, call place-order with `paymentMethod:"SwiggyPay"`. The wallet debits inline and the
  order is placed immediately. There is no polling and no `confirm_order`.
- Failure handling:
  - Confirmed debit failure: nothing was charged. Ask the user to top up in the app, refresh options, and offer
    another method. Don't auto-retry SwiggyPay.
  - Outcome unknown: **don't** claim nothing was charged. Ask the user to check recent orders and their balance first.
  - Order exists but payment is unsettled: share the order details and do not re-place.

### 6.7 Address creation (blog L13485)

`create_address` / `delete_address` are GA for all users, with no whitelist. Lat/lng are optional because the server
geocodes. Ask only for `fullAddress`, name, phone, category and tag, and parse the rest yourself. A geocode failure is an
`ExpectedBusinessError`: surface it and don't retry.

---

## 7. Widgets (L1121)

- Widgets are delivered **inline over MCP**. Widget-backed tools advertise `_meta.ui.resourceUri` (`ui://widget/...`).
  Fetch them with `resources/list` + `resources/read`, which returns HTML text plus CSP in `_meta.ui`. Render them in a
  sandboxed iframe hydrated with the tool's `data`. This needs the `mcp:resources` scope.
- There is no hosted widget URL, no `X-Swiggy-Widgets` header and no `?theme=`.
- Clients without widgets render from `data`, which is our current approach. **Our app is therefore a "headless" client
  for payments:** we own the poll loop and the final `confirm_order` (L826).

---

## 8. Brand & attribution (L1293) — our UI must

- Pair the service's **square logo** with the exact text: **"Powered by Swiggy"** (Food), **"Powered by Instamart"**
  (Groceries), **"Powered by Dineout"** (Dining). Scenes has no published badge, so ask builders@swiggy.in.
- Logo is 32×32 (24×24 min), text 16 px (14 px min), with an 8 px logo-text gap and 8 px clear space. Keep the 1:1 ratio
  and a corner radius of 20 % of the width. Contrast ≥ 4.5:1, full opacity, no recolouring or effects.
- Placement goes with each service's content at every step: Discover (results heading), Choose (item/restaurant detail),
  Order (alongside cart, **before placing**), Track (confirmation + status). A global footer, tooltip or one-time message is
  **not enough**. Mixed screens need a badge per service.
- Accessibility: badge images get the label "Powered by X". If text sits next to the logo, make the logo
  decorative. Actions (Order, Book, Sign in) go in separate labelled controls.
- Don't use "official app", "certified" or endorsement claims, and don't merge services into a generic attribution. Spell
  Swiggy / Instamart / Dineout exactly.
- Download the assets from the brand guidelines page (PNG/SVG, light/dark badges).

---

## 9. Data & compliance (L1492)

- Swiggy is the Data Fiduciary (DPDP 2023) and we are a Processor. Use Swiggy data only for the user's immediate task.
  Analytics, training or ads need separate consent plus a DPA.
- Treat tool args and responses as PII. Log only what debugging needs, hash user ids at rest, and don't keep full bodies.
- If LLM inference runs outside India (our model providers do), a **signed DPA with Swiggy + SCCs** is required before
  production, and fields sent across the border should be minimised (L1528).
- Security issues go to security@swiggy.in (90-day disclosure).

---

## 10. Go-live checklist (L1091) + Swiggy's production access process (L1217)

### 10.1 Access process
1. Build on `http://localhost` (no approval needed).
2. **Record a short end-to-end demo video**: login (phone + OTP), discover, cart, explicit confirmation, payment,
   confirmation and tracking, with attribution visible. Loom, Drive or unlisted YouTube.
3. Apply at `https://mcp.swiggy.com/builders/access/` (or email builders@swiggy.in) with:
   - integration name + organization
   - **exact redirect URIs** (HTTPS, e.g. `https://<app>.vercel.app/api/auth/callback`) plus localhost for dev
   - servers: `food`, `instamart`, `dineout`, `scenes`
   - expected volume (orders/day, tool calls/day, peak QPS)
   - a one-paragraph use case
   - primary technical contact (an engineer's email)
   - the **video link**
4. During review Swiggy allowlists the redirect URIs. You get staging (`mcp-staging.swiggy.com`).
5. Production follows after **staging has been green for ≥ 48 h** and builders@swiggy.in confirms it.

### 10.2 Technical go-live checklist
- [ ] Production confirmed by builders@swiggy.in after ≥ 48 h green staging.
- [ ] Every redirect URI is allowlisted (exact match).
- [ ] Server list confirmed. Scopes are `mcp:tools mcp:resources mcp:prompts`.
- [ ] Retry logic as in §4. Explicit branches for 401/`-32001` (refresh → re-auth) and for upstream timeouts. 429 honours `Retry-After`.
- [ ] Order placement uses check-then-retry, never blind retry.
- [ ] No order is placed without user-visible confirmation of the items, total and address.
- [ ] Expected QPS benchmarked and below the ceiling.
- [ ] A correlation id is logged on every call. Metrics: latency p50/p95/p99, success rate, 4xx/5xx, refresh frequency.
- [ ] Incident contact (email + Slack) given to Swiggy for S0/S1.
- [ ] Data retention, deletion and consent align with §9 (DPA if inference runs offshore).
- [ ] Voice prompts shaped per voice-vs-chat (if any).
- [ ] Internal runbook for "Swiggy returns X".
- [ ] Rollout ramps 1 % → 10 % → 50 % → 100 % over ≥ 24 h.
- [ ] Brand launch checklist (§8) passes on mobile, dark mode and large text.
- [ ] Engineering alias subscribed to deprecation emails (SemVer, 6-month window).

### 10.3 SLOs (targets, L1675)
- Endpoints (incl. `/auth/*`) target 99.9 %.
- Latency p95:
  - reads < 600 ms
  - writes < 1000 ms
  - order placement < 2000 ms
- The first call of a session is slower.
- Support response: S0 ack < 30 min, S1 < 2 h (business hours). Email subject format: `[SEV-n] summary`.
