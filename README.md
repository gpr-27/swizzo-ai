# Swizzo — Swiggy AI Concierge

A chat concierge for all four Swiggy Builders Club MCP servers:

| Tab | Server | What you can do |
| --- | --- | --- |
| **Instamart** | `https://mcp.swiggy.com/im` | Search groceries, usuals, recipes → cart, checkout, track |
| **Food** | `https://mcp.swiggy.com/food` | Dishes across restaurants, menus, coupons, order, track |
| **Dineout** | `https://mcp.swiggy.com/dineout` | Find restaurants, pick a slot + deal, book a table |
| **Scenes** | `https://mcp.swiggy.com/scenes` | Discover events, pick a show + tickets, book |

The per-tool contracts the code follows are in [`docs/swiggy-mcp/`](docs/swiggy-mcp/)
(`instamart.md`, `food.md`, `dineout.md`, `scenes.md`, `platform.md`), extracted from the
official docs (copy in `docs/swiggy-mcp/builders-llms-full.txt`).

## How a chat turn works

1. The browser posts to `POST /api/chat`; the reply streams back as NDJSON
   (`ChatStreamEvent`s, see `src/shared/types.ts`).
2. `src/backend/agent/runner.ts` runs the LLM with the tab's **read-only** Swiggy tools
   (`src/backend/agent/tools.ts`). Tool results become cards immediately; the model's prose is
   parsed for control markers (`BEST:`, `ADD:`, `SUGGESTIONS:`, `STEPS:` …) in `agent.ts`.
3. Anything that changes real-world state — cart sync, placing orders, booking tables or
   tickets, payments — is **never** done by the model. Deterministic API routes call those
   tools only after the user confirms in the UI.
4. Every reply carries a `model` event, and the UI shows which model answered.

### LLM provider chain

`src/backend/agent/providers.ts` tries, strictly in order, moving on whenever a call fails
(rate limit, outage, rejected key, timeout, empty reply):

| # | Provider | Env var | Models |
| --- | --- | --- | --- |
| 1 | Anthropic | `ANTHROPIC_API_KEY` | `claude-haiku-5-5` |
| 2 | Groq | `GROQ_API_KEY` | `openai/gpt-oss-120b` → `openai/gpt-oss-20b` → `qwen/qwen3.8-27b` |
| 3 | Groq | `GROQ_API_KEY_2` | same three |
| 4 | Gemini | `GEMINI_API_KEY` | `gemini-3.5-flash` → `gemini-3.8-flash` → `gemini-flash-latest` |
| 5 | Gemini | `GEMINI_API_KEY_2` | same three |

A blank key is skipped; a 401/403 skips the rest of that key's models. Photo turns only use
vision-capable models. Verify the order with `npx tsx --env-file=.env.local scripts/test-provider-chain.ts`.

### Swiggy MCP client

`src/backend/mcp/client.ts` keeps one MCP session per (user, server), treats
`{ success:false }` replies as errors (shown to the user verbatim), retries only idempotent
tools (network / 5xx / 429 with `Retry-After`), and never retries order-placing tools.

## Environment (`.env.local`, git-ignored)

```bash
ANTHROPIC_API_KEY=...
GROQ_API_KEY=...
GROQ_API_KEY_2=...
GEMINI_API_KEY=...
GEMINI_API_KEY_2=...

APP_BASE_URL=http://localhost:3000   # OAuth redirect = <APP_BASE_URL>/api/auth/callback
SWIGGY_ENABLE_ORDERS=true            # anything else = ordering disabled (honest "not placed")
```

Auth/session variables (`SESSION_SECRET`, `SWIGGY_OAUTH_CLIENT_ID`, …) are documented in
[`docs/swiggy-mcp/PRODUCTION-ACCESS.md`](docs/swiggy-mcp/PRODUCTION-ACCESS.md).

## Run

```bash
npm install
npm run dev          # http://localhost:3000 → "Log in" → phone + OTP on Swiggy
npx tsc --noEmit && npm run lint
npm test             # offline: script checks, API routes, components (no network)
npm run test:e2e     # Playwright smoke on a production build (port 3200)
```

Live (read-only) suites, CI and fixtures: see [`docs/TESTING.md`](docs/TESTING.md).

Swiggy only lets `http://localhost:3000/api/auth/callback` sign in until a production
redirect URI is allowlisted. See `docs/swiggy-mcp/PRODUCTION-ACCESS.md` for what to send
`builders@swiggy.in`.

## Database (optional)

Postgres (Neon / Supabase via the Vercel Marketplace, or local Docker) holds bookings made in the
app, chat sessions, preferences, Plan runs and an audit log of every mutating Swiggy call, so they
follow the account across devices. Without `DATABASE_URL` the app runs exactly as before on browser
localStorage. Setup, schema and migrations: [`docs/DATABASE.md`](docs/DATABASE.md).

```bash
npm run db:up && DATABASE_URL=postgres://swizzo:swizzo@localhost:5433/swizzo npm run db:migrate
```

## Layout

```
src/app/api/…            thin route handlers (chat, cart, food-cart, dineout, scenes, payments, auth…)
src/backend/agent/       providers (LLM chain), runner (tool loop), tools, prompts, marker parsing
src/backend/mcp/         shared MCP client + per-server modules (instamart, food, dineout, scenes, payments)
src/frontend/            hooks (useSwiggyChat), components (chat, catalog, cart, features, navigation)
src/shared/types.ts      single source of truth for cards, stream events and API shapes
```
