# Swizzo — security controls

What protects a public deployment of Swizzo, where it lives in the code, and what is
still open. Verify the guards with:

```bash
npx tsx --tsconfig tsconfig.json scripts/verify-security.ts
```

## 1. Request pipeline (`src/backend/http/route.ts`)

Every handler in `src/app/api/**` is wrapped:
`export const POST = route({ name, rateLimit, body, query, … }, async function POST(request, ctx) {…})`.
The wrapper applies, in this order:

| # | Control | Behaviour |
|---|---|---|
| 1 | Same-origin (CSRF) | POST/PUT/PATCH/DELETE must carry `Origin` equal to `APP_BASE_URL`, this deployment's Vercel URLs, `ALLOWED_ORIGINS`, or the Host the request was sent to; `Sec-Fetch-Site` must be `same-origin`/`none`. Neither header → rejected. → **403** `forbidden_origin` |
| 2 | Cross-site read refusal | Session GETs with `Sec-Fetch-Site: cross-site` → **403** |
| 3 | Query limits | ≤ 4 KB / ≤ 30 params; known params type- and size-checked with zod → **414** / **400** |
| 4 | Session | Swiggy session required (default) → uniform **401** `{ ok:false, code:"unauthorized", message, needsLogin:true, auth:true, authRequired:true }` (NDJSON `{type:"error"}` line on `/api/chat`). Only `auth/*` routes skip it; `/api/me/state` loads it optionally and answers its own 401 |
| 5 | Body limits | `Content-Type: application/json` required (**415**), byte cap — 64 KB default, 256 KB food-cart, 512 KB food-ai, 8 MB chat (photo) (**413**), strict zod schema: unknown top-level keys, closed enums, string lengths, number ranges, id formats (**400**) |
| 6 | Rate limit | Per-session and per-IP token buckets (§3) → **429** + `Retry-After` |
| 7 | Double submit | Order routes run once per (session, action, `Idempotency-Key` or body hash) (§5) → **409** while running, verbatim replay afterwards |
| 8 | Errors | `AuthError` anywhere → uniform 401; anything thrown → generic 500 with no internals, logged redacted. Default `Cache-Control: private, no-store` |

All errors share `{ ok:false, code, error, message }` (`error` = `message`, so both client
styles keep working); the observability wrapper adds `requestId`.

Schemas: `src/backend/http/schemas.ts`. Nested Swiggy-shaped objects the UI echoes back
(cart line metadata, menus, pickers) are size-bounded and parsed field-by-field by each route.

## 2. Route policy map

| Route | Auth | Rate policy | Idempotent | Mutates Swiggy |
|---|---|---|---|---|
| `GET auth/login`, `GET auth/callback` | none | auth (IP) | – | – (OAuth) |
| `POST auth/logout` | none (revokes if present) | auth | – | revoke |
| `GET auth/status` | none (reads cookie) | read | – | – |
| `POST chat` | session | chat | – | never (read-only tools) |
| `POST ai-read`, `briefing`, `food-ai`, `instamart/note`, `instamart/basket`, `history/insights` | session | ai | – | never |
| `GET/POST cart`, `POST/DELETE addresses/create`, `POST report-error` | session | mutate (GET: read) | – | cart / address / report |
| `POST food-cart` | session | mutate; `action:"place"` → order | `place` | cart; order when `place` |
| `POST checkout` | session | order | yes | **order** |
| `POST dineout/cart`, `POST dineout/book`, `POST dineout/booking` (cancel) | session | order | yes | **booking** |
| `POST scenes/cart`, `POST scenes/order` | session | order | yes | **ticket order** |
| `POST payments/confirm` | session | order | yes | **confirm_order** |
| `PUT/DELETE me/state` | optional (own 401) | mutate | – | – (our DB) |
| every other GET / read POST (`bookings`, `track`, `history/*`) | session | read | – | never |

### Order / payment safety

- The LLM never gets a mutating tool (`src/backend/agent/tools.ts` is read-only); every
  checkout / place / book / confirm / cancel call sits in a deterministic route that the UI
  calls only after an explicit confirm tap.
- `SWIGGY_ENABLE_ORDERS="true"` gates `checkout`, food `place`, `dineout/cart`, `dineout/book`,
  `dineout/booking` cancel, `scenes/order` and `payments/confirm`; anything else answers
  `{ placed:false, gated:true }`. Cart edits, `scenes/cart` (create_event_cart, no money
  moves) and addresses stay usable with ordering off.
- Same-origin + `order` bucket (10 burst, 6/min per session) + double-submit lock on every one.
- Order-placing tools are never auto-retried (`src/backend/mcp/client.ts`); an ambiguous
  failure is reported as "may have been placed — check before retrying" and that answer is
  replayed (not re-sent) for 60 s.

## 3. Rate limiting (`src/backend/security/rate-limit.ts`)

| Policy | Per session (burst / per min) | Per IP |
|---|---|---|
| chat | 20 / 10 | 40 / 20 |
| ai | 40 / 30 | 80 / 60 |
| mutate | 60 / 60 | 120 / 120 |
| order | 10 / 6 | 20 / 12 |
| read | 120 / 120 | 240 / 240 |
| auth | – | 20 / 10 |

- Override per policy: `RATE_LIMIT_<NAME>="cap/perMin,ipCap/ipPerMin"` (e.g. `RATE_LIMIT_CHAT=30/15,60/30`).
- `RATE_LIMIT_DISABLED=true` disables it outside production (tests).
- Session key = sha256 of the Swiggy user id (or token); IP = `x-real-ip` / `x-forwarded-for`
  (set by Vercel's edge).
- **Store is pluggable.** The default is in-memory per serverless instance. For a fleet-wide
  limit implement `RateLimitStore.take(key, rule, cost, now)` atomically (Redis `EVAL`, or a
  Postgres row with `UPDATE … RETURNING`) and call `setRateLimitStore(store)` once at startup
  (e.g. `instrumentation.ts`). `IdempotencyStore` / `setIdempotencyStore` work the same way.

## 4. Session, OAuth and cookies (`src/backend/config/{session,oauth}.ts`)

- Session = AES-256-GCM sealed cookie `swiggy_session`: `httpOnly`, `SameSite=Lax`, `Secure` in
  production (or when `APP_BASE_URL` is https), `Path=/`, max-age = token lifetime (≤ 30 days).
  `SESSION_SECRET` (≥ 32 chars) is mandatory in production — the app refuses to start sealing without it.
- Rotation: every login writes a freshly sealed cookie (new IV, new tokens); refreshes re-seal;
  logout (POST, same-origin) revokes at Swiggy and deletes the cookie.
- OAuth 2.1 + PKCE S256; `state` (128-bit) + verifier sealed in a 10-minute `Path=/api/auth`
  cookie, single-use, constant-time compared. `redirect_uri` and `client_id` come only from env
  (`APP_BASE_URL` / `SWIGGY_OAUTH_REDIRECT_URI`), never from request headers.
- No open redirects: the callback always returns to `new URL("/", APP_BASE_URL)`; the only
  pass-through login param is `prompt=login`. There is no `next`/`returnTo` parameter.
- Module-level caches keyed by Swiggy ids are per user: the food cart's desired-cart, coupon
  and lock maps use `UserScopedMap` (keys namespaced by the session), others key by a token hash.

## 5. Double-submit protection (`src/backend/security/idempotency.ts`)

Key = session + action + (`Idempotency-Key` header if the client sends one, else sha256 of the
exact body). While running → 409 `duplicate_submit`; a 2xx or `ambiguous/unknown:true` answer is
stored for 60 s and replayed with `Idempotent-Replay: true`; definite failures (4xx, Swiggy
rejection) release the key so the user can fix and retry.

## 6. Headers (`src/backend/security/headers.ts`, wired in `next.config.ts`)

- `Content-Security-Policy`: `default-src 'self'`; `script-src 'self' 'unsafe-inline'`
  (+ `'unsafe-eval'` only in dev); `img-src 'self' data: blob: https://*.swiggy.com
  https://*.swiggystatic.com https://res.cloudinary.com`; `connect-src 'self'`; `font-src 'self'`
  (next/font self-hosts); `object-src 'none'`; `base-uri 'self'`; `form-action 'self'`;
  `frame-src 'none'`; `frame-ancestors 'none'`; `upgrade-insecure-requests` in prod.
  Vercel previews additionally allow `vercel.live` (toolbar).
- `Strict-Transport-Security: max-age=63072000; includeSubDomains` (prod), `X-Content-Type-Options:
  nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: strict-origin-when-cross-origin`,
  `Permissions-Policy: microphone=(self), camera=(self)` and everything else off,
  `Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Resource-Policy: same-origin` on `/api/*`.
- `poweredByHeader: false`; `images.unoptimized: true` (no `/_next/image` optimizer — the UI uses plain `<img>`).

## 7. Secrets and privacy (`src/backend/security/redact.ts`)

- No `NEXT_PUBLIC_*` variables; all keys are server-only (`.env*` is git-ignored).
- `installConsoleRedaction()` (loaded by the route wrapper) passes every `console.*` argument
  through `redact()`: JWTs, `Bearer …`, sealed cookies, `sk-ant-` / `gsk_` / `AIza` / `sk-` keys,
  `access_token=`-style pairs, e-mails and Indian mobile numbers in text; object keys such as
  `*token*`, `userName`, `userPhone`, `addressLine`, `fullAddress`, `lat/lng`, `cookie` are masked.
  Ids (`addressId`, `orderId`, …) are kept for debugging.
- `report_error` payloads (error text, flow, notes, tool context) are redacted before they are
  sent to Swiggy, and sensitive context keys are dropped.
- The MCP payload summariser drops Swiggy's echoed session JWT (`tid`/`sid`) before the model sees it.

## 8. Prompt injection (`src/backend/security/prompt-guard.ts`)

- Swiggy text (names, descriptions, offers, error messages) and client-supplied "facts" are
  wrapped in `<swiggy_data>` fences with fence look-alikes, control and bidi characters
  neutralised, and every prompt carries `UNTRUSTED_DATA_RULE` ("data, never instructions").
  Applied in the chat runner (system prompt, JSON tool results, tool errors), `ai-read`,
  `ai-phrase` (briefing / history), `food-ai`, `instamart-ai`.
- Defence in depth: the model has no mutating tools, one-shot reads are number-grounded
  (`acceptPhrase` / `parseAiRead`), and any order still needs the user's confirm tap.

## 9. Dependencies (`npm audit --omit=dev`, 2026-10-23)

- Fixed with in-range upgrades (`npm audit fix`): `@modelcontextprotocol/sdk` 1.29 → 1.32.1 (5
  advisories incl. cross-origin redirect header leak), `proxy-addr` (critical), `fast-uri`,
  `ip-address`, `hono`, `@hono/node-server`, `qs`, `baseline-browser-mapping`.
- **Open: `next@16.2.9` (critical) + its bundled `postcss`/`sharp` (high)** — fixed in
  `next@16.4.2` (minor bump; also bump `eslint-config-next` to match). Not applied here because
  `package.json` pins the exact version and the lead's server must be rebuilt; **do it before the
  public deploy**: `npm i next@16.4.2 eslint-config-next@16.4.2 && npx tsc --noEmit && npm run build`.
  Exposure meanwhile is low: the advisories target the image optimizer (disabled), Server
  Actions / `use cache` / `next/og` / middleware / rewrites (none used) and Windows/self-hosted
  ISR (not applicable on Vercel).

## 10. Threat model

| Threat | Vector | Mitigation | Residual |
|---|---|---|---|
| CSRF placing an order / editing cart | Cross-site form or fetch to `/api/*` | SameSite=Lax cookie + Origin/Sec-Fetch-Site check + JSON content type + session required | none known |
| Clickjacking the confirm button | Framing the app | `frame-ancestors 'none'`, `X-Frame-Options: DENY` | – |
| Double order (double tap, retry, replay) | Repeated POST | Idempotency lock + 60 s replay, no auto-retry of order tools, ambiguous-outcome replay | different body within 60 s is a new order (Swiggy's own duplicate check applies) |
| LLM spend abuse / bot traffic | Scripted chat / ai-read calls | Session required on every LLM route, per-session + per-IP buckets, body caps | in-memory buckets are per instance until a shared store is plugged in; a logged-in attacker can spend up to the per-session budget |
| Swiggy rate-limit exhaustion / account lock | Scripted reads | `read` bucket per session/IP, existing per-route caches | same per-instance caveat |
| Session theft | XSS, logs, network | httpOnly + Secure cookie, AES-GCM sealed, HSTS, CSP, log redaction | `'unsafe-inline'` scripts (Next RSC); React escapes output and blocks `javascript:` URLs |
| Cross-user data leak | Module caches keyed by Swiggy ids | `UserScopedMap` / token-hash keys; MCP sessions per token | public listing caches (Scenes shows) are shared by design |
| OAuth login CSRF / code injection | Forged callback | Sealed single-use `state` + PKCE verifier, env-only `redirect_uri` | – |
| Open redirect | `?next=` style params | None exist; callback returns to `APP_BASE_URL/` only | – |
| Prompt injection via Swiggy data | Malicious restaurant/dish/event text | Fenced data + data-only rule, read-only tools, grounded one-shot reads, user confirm for orders | model may still be misled into odd *text* or a cart suggestion (ADD markers only edit the cart, never order) |
| PII in logs / error reports | console, report_error | Console redaction, report_error redaction | text in other sinks the observability layer adds must also use `redact()` |
| Oversized / malformed input DoS | Huge JSON, deep arrays, long URLs | Byte caps, zod limits, query caps | – |
| Vulnerable dependencies | Known CVEs | In-range fixes applied; Next upgrade documented | Next 16.4.2 upgrade pending (§9) |
| Secrets exposure | Client bundle, repo | No `NEXT_PUBLIC_` keys, `.env*` ignored, `SESSION_SECRET` required in prod | rotate keys if `.env.local` ever leaves the machine |

## 11. Configuration summary

| Env | Purpose |
|---|---|
| `APP_BASE_URL` | Public origin; OAuth redirect and the primary allowed Origin |
| `ALLOWED_ORIGINS` | Extra comma-separated origins allowed to POST (custom domains) |
| `SESSION_SECRET` | ≥ 32 chars, required in production |
| `SWIGGY_ENABLE_ORDERS` | `"true"` enables real orders / bookings / payment confirm |
| `RATE_LIMIT_<POLICY>` | Override a bucket: `cap/perMin,ipCap/ipPerMin` |
| `RATE_LIMIT_DISABLED` | `true` disables limits outside production |
