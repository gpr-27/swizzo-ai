# Testing Swizzo

One runner (Vitest) for everything that needs no network, an opt-in live suite
for Swiggy's read-only tools, and Playwright against a production build.

| Command | What runs | Network |
| --- | --- | --- |
| `npm test` | scripts checks + unit + API routes + components (~770 tests, ~10 s) | none — `fetch` is blocked |
| `npm run test:coverage` | the same, with a v8 coverage report in `coverage/` | none |
| `npm run test:watch` | the same, in watch mode | none |
| `npm run test:live` | real **read-only** Swiggy MCP calls (skipped without `SWIGGY_TOKEN`) | Swiggy |
| `npm run test:e2e` | Playwright smoke on a production build (port 3200) | none (Swiggy never contacted) |
| `npm run test:e2e:live` | Playwright logged-in suite, read-only (skipped without `E2E_SWIGGY_COOKIE`) | Swiggy |
| `npm run typecheck` / `npm run lint` | `tsc --noEmit` / ESLint | none |

## Ground rules

- **Never a mutating Swiggy tool.** The API-route stub (`tests/api/fakeMcp.ts`)
  throws on any tool in `MUTATING_TOOLS`; the live suite refuses any tool not in
  `READ_TOOLS` before the call goes out; the logged-in Playwright suite aborts
  every state-changing app route (`tests/e2e/fixtures.ts → guardMutations`) and
  never taps Confirm / Pay / Checkout / Approve / Add / Book.
- **No invented product data.** Fixtures are recorded LIVE captures, turned into
  props by the app's own mappers (`tests/fixtures/live.ts`):
  `docs/swiggy-mcp/live/*.json`, `docs/swiggy-mcp/LIVE-SAMPLES.md`,
  `scripts/fixtures/**`, `tests/fixtures/*.json`. The one exception is the
  PaymentModal session (no UPI order is ever placed, so there is no capture):
  it follows the documented shape with `TEST-…` / `example.invalid` placeholders.
- **PII stays redacted.** `tests/unit/fixtures-redaction.test.ts` fails on any
  full phone number, e-mail, JWT or bearer token in a capture. Captures use
  "Test User", "[flat redacted]" and masked phones.
- **Never :3000.** E2E builds into `.next-e2e` (`NEXT_DIST_DIR`) and serves on
  `E2E_PORT` (default 3200), so it never touches a dev server's `.next`.

## Layout

```
vitest.config.mts          projects: node · components (jsdom) · live
playwright.config.ts       projects: smoke · smoke-mobile · logged-in
tests/
  setup/no-network.ts      blocks fetch, drops live credentials (offline suites)
  setup/dom.ts             jest-dom + jsdom gaps (IntersectionObserver, scrollIntoView, matchMedia)
  fixtures/live.ts         recorded live payloads → app mappers → props
  fixtures/fetch.ts        recording fetch stub for components (+ list of mutating routes)
  scripts/                 scripts/*.ts run 1:1 inside Vitest (runScript.ts)
  unit/                    adapter self-test, fixture redaction
  api/                     route handlers called with Request objects
    fakeMcp.ts             MCP SDK Client stand-in (recorded results, refuses mutating tools)
    fakeHeaders.ts         next/headers cookie jar (the real session sealing runs)
  components/              Testing Library on live payloads
  live/                    read-only Swiggy calls, LLM provider chain (opt-in)
  e2e/smoke, e2e/live      Playwright specs; e2e/serve.mjs builds + starts the server
```

### The historical check scripts

`scripts/verify-*.ts` and `scripts/test-*.ts` are unchanged and still run on their
own (`npx tsx --tsconfig tsconfig.json scripts/<name>.ts`). Under Vitest
(`tests/scripts/<name>.test.ts`) each script is imported as-is, its console output
captured, and **every `✓ / ✗ / ok` line it prints becomes its own test**, plus a
"ran to completion" test that fails on a thrown assertion, an unhandled rejection
or a non-zero exit. Nothing was ported by hand, so no check can be lost; a new
check added to a script shows up automatically. `verify-security` runs in a child
process (its redaction check reads `process.stdout`, which Vitest owns);
`verify-db` runs its offline parts here and the Postgres parts in CI's `db` job;
`verify-scenes` runs with `SWIGGY_TOKEN` removed (its live section runs in
`test:live`). `test-provider-chain.ts` (LLMs) and `test-mcp.mjs` (raw token
smoke) are live-only.

## What is covered

- **Scripts (≈700 checks):** parsers and mappers on live payloads for every
  domain, marker parsing, picker resolution, plan run state machine, follow-up
  rule, city coordinates, tool coverage (every live tool classified READ /
  MUTATING, the agent never gets a mutating tool), DB fallback + redaction,
  route-wrapper security.
- **API routes** (`tests/api`): `/api/chat` — NDJSON stream, the follow-up
  text-only rule (`src/backend/agent/followUp.ts`), cards still drawn for
  "show / any / cheaper / book" follow-ups and first messages, per-tab domain
  isolation of cart / catalog / bookings / picker, request validation, 401;
  `/api/bookings` — Dineout's nested `order` shape, per-row Swiggy failures, 401;
  `/api/addresses` — live addresses with city-centre coordinates,
  `selectedAddressId` pass-through, 401; auth — authorize URL from
  `APP_BASE_URL` (never the Host header) with PKCE S256 and a sealed httpOnly
  state cookie, forged-state callback, status logged in / out, CSRF refusal;
  `/api/health`, `/api/ready` (names only, never values).
- **Components** (`tests/components`): ProductCard pack picker (smallest pack by
  default, BEST flag override, manual pick wins, per-order cap); CartPanel (lines
  first, collapsed bill, sticky footer checkout, Swiggy One, address disclosure,
  unavailable-line block); DineoutRestaurantCard (Reserve vs walk-in-only for NPR
  and after an empty slot fetch); DineoutSlotPicker (live slots, AI picks, free
  table default, verbatim ids on Confirm, chat PICK apply + revealPick, best pick,
  plan auto-cart hold); ScenesShowPicker (default show/tier, PICK by tier name,
  unoffered-tier note, revealPick, seat re-validation before create_event_cart,
  auto-cart hold, count clamp); MessageBubble (`shownAbove` links, research folded
  under an itinerary); LivePlanPanel (step statuses from `derivePlan`, confirm
  hands over, replan/retry, booked with order id); PaymentModal (desktop QR vs
  mobile UPI link, sequential status poll, failure, 401).
- **E2E smoke** (`tests/e2e/smoke`): login gate, Login → Swiggy authorize URL
  with the right `redirect_uri` (request intercepted, never followed),
  `auth_error` clean-up, app shell with five tabs and keyboard switching (the
  shell's `/api/auth/status` + `/api/addresses` answered in the browser from the
  live capture), health / ready, 401s, CSRF, 404 page, security headers, a
  phone-sized viewport.

Coverage thresholds (`vitest.config.mts`) ratchet just under the current
numbers; raise them when you add tests.

## Live suites

```bash
# Read-only Swiggy MCP tools (addresses, search_products, get_cart, food/dineout/
# scenes search, plus verify-scenes' live section)
SWIGGY_TOKEN=<Swiggy MCP bearer access token> npm run test:live
# + the LLM provider chain (uses .env.local keys)
LIVE_LLM=1 npm run test:live
```

Logged-in Playwright (read-only): log in once on a local server, copy the
`swiggy_session` cookie value (DevTools → Application → Cookies), then run with
the **same** `SESSION_SECRET` that sealed it (Playwright's server reads it from
the environment or `.env.local`):

```bash
E2E_SWIGGY_COOKIE='v1.…' npm run test:e2e:live
E2E_SWIGGY_COOKIE='v1.…' E2E_CHAT=1 npm run test:e2e:live   # + one chat search (LLM keys needed)
E2E_BASE_URL=https://<deployment> E2E_SWIGGY_COOKIE='v1.…' npm run test:e2e:live   # against a deployment
```

`E2E_REBUILD=1` forces a fresh `next build` into `.next-e2e`; `E2E_PORT` changes
the port (3000 is refused).

## CI (`.github/workflows/`)

- `ci.yml` (push / PR, no secrets): **quality** (typecheck + lint) ·
  **test** (`npm run test:coverage`, summary in the job summary, `coverage/`
  artifact) · **e2e** (`next build` on dummy env → Playwright smoke on :3200,
  report artifact on failure, npm + Next + Playwright caches) · **db**
  (`npm run db:verify` against a Postgres 17 service).
- `live.yml` (manual + daily, secrets): `SWIGGY_TOKEN` → `test:live`;
  `E2E_SWIGGY_COOKIE` + `E2E_SESSION_SECRET` → logged-in E2E; any LLM key →
  provider chain. Each part skips itself when its secret is missing.

The workflows assume `swiggy-chat/` is the repository root.
