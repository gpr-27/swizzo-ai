# Database & persistence

Swizzo works **with or without** a database.

| `DATABASE_URL` | Behaviour |
| --- | --- |
| unset | Exactly the original app: chat sessions, bookings, preferences and Plan runs live in browser localStorage only. The server logs one line, `[db] DATABASE_URL not set — persistence disabled…`, and `/api/me/state` answers `{ enabled:false }`. |
| set | The same localStorage stores stay the UI's offline cache, and they also sync to Postgres per Swiggy account, so a booking made on your phone shows up in History on your laptop. Every mutating Swiggy tool call is written to `audit_log`. |

Stack: **Postgres** + **Drizzle ORM** (`drizzle-orm/postgres-js`) + **postgres.js**, with versioned SQL migrations from **drizzle-kit** in `./drizzle`.

## What is stored

| Table | Contents | Key |
| --- | --- | --- |
| `users` | one row per Swiggy account: `swiggy_user_id` (JWT `user_id` claim, else `sub`, the numeric Swiggy customer id), `created_at`, `last_seen_at` | `id` uuid; `swiggy_user_id` unique |
| `bookings` | Dineout tables / Scenes tickets made **in this app** (Swiggy has no list-bookings tool): `kind`, `order_id`, `title`, `details`, `restaurant_id`, `event_id`, `starts_at`, `party_size`, `amount` (₹), `lat`/`lng` (search coordinates used to fetch the restaurant photo), `last_status`, `last_status_at`, timestamps | unique (`user_id`, `kind`, `order_id`); newest 100 kept |
| `chat_sessions` | thread meta: browser `client_id`, `title`, `service`, `message_count`, `deleted_at` (tombstone) | unique (`user_id`, `client_id`); newest 60 live kept; tombstones kept for 30 days |
| `chat_messages` | the exact `ChatMessage` JSON the client renders, in order (`jsonb`) | (`session_id`, `position`); ≤ 300 per session, ≤ 200 KB each (bigger ones, e.g. inline photos, are stored as a text-only stub), ≤ 1.5 MB per session |
| `preferences` | `{ preferences, allergies, budget, kcalGoal, proteinGoal }` | `user_id` |
| `plan_runs` | the Plan tab's run state per chat session (`swiggy-planrun-v1:<sid>`) | (`user_id`, `session_client_id`) |
| `audit_log` | every mutating Swiggy call: `server`, `tool`, `args_summary` (redacted), `status` (`ok` / `tool_error` / `auth_error` / `error`), `error` (Swiggy's message, with phone numbers and emails masked), `order_id`, `cart_id`, `correlation_id`, `duration_ms`, `user_id`, `created_at` | bigserial; indexed by user+time and order id |

All user tables cascade on `users` delete (`DELETE /api/me/state` erases an account). Audit rows keep a null user.

**Tokens are never stored in the database.** The Swiggy access/refresh tokens stay only in the AES-256-GCM sealed httpOnly cookie (`src/backend/config/session.ts`). The DB holds only the account id read from the token's claims.

### Audit-log redaction (`src/backend/db/audit.ts`)

- **Audited tools:** `update_cart`, `clear_cart`, `checkout`, `apply_coupon`, `update_food_cart`, `flush_food_cart`, `apply_food_coupon`, `place_food_order`, `create_cart`, `book_table`, `cancel_booking`, `create_event_cart`, `place_event_order`, `create_address`, `delete_address`, `confirm_order`, `report_error`. Read-only tools are never logged.
- **How it's wired:** one wrapper around `callTool()` in `src/backend/mcp/client.ts`, so every route goes through it.
- **What's kept:** opaque ids (`addressId`, `restaurantId`, `spinId`, `cartId`…), quantities and counts, enums (payment method, type), dates/times, amounts. Arrays become `{ count, items }`.
- **What's dropped** (`"[redacted]"`): names, phones, emails, address lines, landmarks, notes/instructions, coordinates, UPI VPAs, coupon codes, tokens, any other free text, and any string that looks like a phone number, email or JWT.
- **Failure handling:** an audit write is capped at about 1.5 s and never fails the tool call.

## Sync rules (`src/frontend/state/cloudSync.ts`, `GET/PUT/DELETE /api/me/state`)

- **Where the UI reads from:** localStorage, always. Sync merges server copies in and pushes local edits out. Pushes are debounced by 2.5 s; pulls happen on login, when the tab becomes visible, every 5 min, and when the History page opens.
- **Conflicts:** each record has an `updatedAt`. The newer one wins; ties go to the server. The server enforces this in SQL (`ON CONFLICT … DO UPDATE … WHERE excluded.updated_at > stored.updated_at`), so a stale device can never overwrite newer data.
- **Deleting a chat** sends a tombstone, so it disappears on other devices too.
- **Migration:** the first sync on a browser pushes everything already in localStorage, so existing data moves up automatically.
- **Switching accounts:** if a different Swiggy account signs in on the same browser, the local caches are replaced by that account's server copy.
- **Requests:** `GET /api/me/state?since=<ms>` is incremental. `PUT` bodies are validated with zod and capped (≤ 8 sessions per request, ≤ 4 MB). Same-origin checks and rate limits come from the shared route wrapper.

## Local development

Docker (or colima: `colima start`) is required.

```bash
npm run db:up                    # postgres:17 on 127.0.0.1:5433 (docker-compose.yml)
export DATABASE_URL=postgres://swizzo:swizzo@localhost:5433/swizzo
npm run db:migrate               # apply ./drizzle migrations (idempotent)
npm run db:studio                # browse data (drizzle-kit studio)
npx tsx --tsconfig tsconfig.json scripts/verify-db.ts   # repos, migrations, fallback, redaction
```

To make `next dev` use it, put `DATABASE_URL=…` in `.env.local` and restart the dev server.

To change the schema, edit `src/backend/db/schema.ts`, run `npm run db:generate` (it writes a new `drizzle/NNNN_*.sql`), review the SQL, commit it, then run `npm run db:migrate`. Never edit an applied migration.

`npm run db:down` stops the container. The data volume `swizzo-pgdata` survives; add `-v` to wipe it.

## CI / deploy migrations

`npm run db:migrate` (`scripts/db-migrate.mjs`, plain Node, no tsx needed):

- **No database URL:** it prints a notice and exits 0, so CI and builds without a DB still pass.
- **URL choice:** it prefers the direct URL, `DATABASE_URL_UNPOOLED` (Neon) or `POSTGRES_URL_NON_POOLING` (Supabase), and falls back to `DATABASE_URL` / `POSTGRES_URL`.
- **Concurrent deploys:** they are serialised with a Postgres advisory lock. Applied migrations are tracked in `drizzle.__drizzle_migrations`.

On Vercel, set **Project → Settings → Build & Development → Build Command** to:

```
npm run db:migrate && npm run build
```

In GitHub Actions, add a step `run: npm run db:migrate` with `DATABASE_URL` taken from secrets, before deploy.

## Provision Postgres on Vercel (Neon via Marketplace), step by step

1. Open your project on vercel.com and go to the **Storage** tab, then **Create Database** (or **Marketplace → Neon**).
2. Choose **Neon (Serverless Postgres)** and click **Continue**. Accept the integration, pick the free plan, and pick a region close to your Vercel Functions region (e.g. `aws-ap-south-1`, Mumbai, for `bom1`).
3. Name the database (e.g. `swizzo`) and **Create**.
4. **Connect** it to the project for the environments you want (Production, plus Preview if you like). Vercel then adds the env vars automatically. The ones this app uses:
   - `DATABASE_URL`: the **pooled** connection (host contains `-pooler`). The app uses it at runtime.
   - `DATABASE_URL_UNPOOLED`: the direct connection. Migrations use it.
5. Check that **SESSION_SECRET** is set in Vercel (≥ 32 chars). It already is if login works in production.
6. Set the Build Command as described above (`npm run db:migrate && npm run build`) and **Redeploy**. The build log should show `[db:migrate] done — 1 migration(s) applied`, and the function logs `[db] persistence enabled (postgres @ …-pooler…)`.
7. Optional, for local work against Neon: `vercel env pull .env.local`, then `npm run db:migrate` / `npm run db:studio`.

Supabase instead: Marketplace → **Supabase** → connect. Vercel sets `POSTGRES_URL` (pooled, port 6543) and `POSTGRES_URL_NON_POOLING`, and the app reads both automatically.

Any other Postgres (RDS, Render…): set `DATABASE_URL` yourself. If the host is not `localhost`, TLS is required; append `?sslmode=disable` only for trusted private networks.

## Environment variables

| Var | Needed | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | to enable persistence | pooled Postgres URL used at runtime (`POSTGRES_URL` also accepted) |
| `DATABASE_URL_UNPOOLED` | recommended | direct URL for migrations / studio (`POSTGRES_URL_NON_POOLING` also accepted) |
| `DATABASE_POOL_MAX` | no (default 5) | connections per function instance |
| `SESSION_SECRET` | yes (already) | seals the session cookie. Not used for DB data, since no tokens are persisted. |

Runtime connection settings (`src/backend/db/client.ts`): `prepare: false` (required behind pgbouncer transaction pooling), small per-instance pool cached on `globalThis` (shared by Fluid Compute's concurrent requests), `idle_timeout` 20 s, TLS required for non-local hosts.

## Files

```
src/backend/db/schema.ts      tables (Drizzle)
src/backend/db/client.ts      getDb() → Drizzle | null (fallback), pool settings
src/backend/db/identity.ts    Swiggy account id from the session token
src/backend/db/repos.ts       repositories (users, bookings, sessions+messages, preferences, plan runs, audit)
src/backend/db/audit.ts       mutating-tool audit + redaction (wired in src/backend/mcp/client.ts callTool)
src/app/api/me/state/route.ts GET / PUT / DELETE sync API
src/shared/persistence.ts     wire types + limits shared by client and server
src/frontend/state/cloudSync.ts  client merge/push engine;  syncBus.ts  change events
src/frontend/hooks/useCloudSync.ts  starts sync on login (used by useSwiggyChat)
drizzle/                      versioned SQL migrations;  drizzle.config.ts
scripts/db-migrate.mjs        migration runner (CI / deploy);  scripts/verify-db.ts  tests
docker-compose.yml            local Postgres
```
