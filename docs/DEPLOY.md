# Deploying Swizzo to Vercel

Swizzo is a Next.js 16 App Router app. Every route runs on the **Node.js runtime**; nothing uses Edge.
Project config lives in `vercel.json`:

- region `bom1` (Mumbai), close to Swiggy's MCP servers. A chat turn makes several MCP round trips.
- function `maxDuration`: `/api/chat` 120 s (streamed NDJSON), `/api/payments/status` 45 s (long-poll),
  `/api/instamart/basket` 60 s. The same values are exported as route segment config.
- cache headers for static images and fonts. Security headers and CSP come from `next.config.ts`.

The server does no filesystem writes at runtime. `SWIGGY_DEBUG_DUMP` is ignored on Vercel and in production.

---

## 1. Create the project

1. Push the repo to GitHub, GitLab or Bitbucket.
2. Vercel → **Add New… → Project** → import the repo. Vercel detects Next.js; keep the default build
   (`next build`) and output settings.
3. Under **Settings → Functions**, leave **Fluid compute** on (the default). The region comes from
   `vercel.json` (`bom1`).

## 2. Environment variables

Add these under **Settings → Environment Variables**. Set them for **Production**, and for **Preview**
if you want previews to work. `.env.example` explains every variable.

| Variable | Required | Value |
| --- | --- | --- |
| `APP_BASE_URL` | **yes** | `https://<your-domain>`, with no trailing slash. Must be `https://` in production. |
| `SESSION_SECRET` | **yes** | 32+ random bytes, generated as shown below. Changing it logs everyone out. |
| `ANTHROPIC_API_KEY` / `GROQ_API_KEY` / `GROQ_API_KEY_2` / `GEMINI_API_KEY` / `GEMINI_API_KEY_2` | at least one | LLM provider chain keys (tried in that order) |
| `SWIGGY_OAUTH_CLIENT_ID` | **yes** for prod | The client id Swiggy issues for your domain. `swiggy-mcp` only works on localhost. |
| `SWIGGY_ENABLE_ORDERS` | no | `true` places real orders and bookings. Any other value means ordering is disabled, and the server says so honestly. Start with `false`. |
| `DATABASE_URL` | no | Postgres for server-side persistence (see `docs/DATABASE.md`). Unset means browser-only storage. |
| `NEXT_PUBLIC_VERCEL_ANALYTICS` | no | `1` loads Vercel Web Analytics and Speed Insights. First enable both under the project's **Analytics** and **Speed Insights** tabs. |
| `LOG_LEVEL` | no | `info` by default. Use `debug` only for short investigations. |

Generate `SESSION_SECRET`:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

Never prefix a secret with `NEXT_PUBLIC_`. Only `NEXT_PUBLIC_VERCEL_ANALYTICS` is public, and it is a flag.

## 3. Domain and the Swiggy redirect URI

1. **Settings → Domains** → add your domain (for example `swizzo.example.com`) and follow the DNS steps.
2. Set `APP_BASE_URL=https://swizzo.example.com`.
3. Send Swiggy (builders@swiggy.in, see `docs/swiggy-mcp/PRODUCTION-ACCESS.md`) this **exact** redirect URI:

   ```
   https://<your-domain>/api/auth/callback
   ```

   Swiggy matches it exactly: scheme, host, path, and no trailing slash. Until Swiggy allowlists it,
   login works only on `http://localhost:3000`.
4. Put the client id Swiggy returns into `SWIGGY_OAUTH_CLIENT_ID`, then redeploy.

Preview deployments get their own `*.vercel.app` URLs, which Swiggy will not allowlist. Login therefore
works only on the production domain. Everything else in a preview (health, UI) still works.

## 4. Deploy

- Git: push to the production branch, or open a PR to get a Preview.
- CLI: `vercel` for a preview, `vercel --prod` for production.

## 5. Post-deploy smoke test

Run against `https://<your-domain>`:

1. `curl -s https://<your-domain>/api/health` returns `{"ok":true,"status":"alive",…}`.
2. `curl -s https://<your-domain>/api/ready` returns **200** with `"status":"ready"`.
   A **503** response lists the missing or invalid variables by name. Fix them and redeploy.
   `features` shows which LLM providers, ordering and DB are on. `circuits` should be empty.
3. Check that a response carries an `x-request-id` header: `curl -sI https://<your-domain>/api/health`.
4. Open the site. The page renders with no console errors, and the theme toggle works.
5. **Log in**: you are redirected to Swiggy, enter phone + OTP, and land back on the app logged in
   (`/api/auth/status` → `authenticated:true`).
6. Instamart: search "milk". Product cards show photos. Add one to the cart; the tray updates.
7. Food: search a dish and open a menu. Dineout: search restaurants and open the slot picker.
   Scenes: search events.
8. Chat streaming: replies appear token by token, not all at once, and a model badge shows under the
   reply. Press **Stop** mid-reply; it stops.
9. With `SWIGGY_ENABLE_ORDERS=false`, try checkout. You should see the honest "ordering is disabled"
   message and no order placed. Enable real orders only once all of the above pass.
10. Vercel → **Logs**: lines are JSON with `msg` values such as `route`, `tool_call`, `llm_call` and
    `llm_turn`, plus a `requestId`. No tokens, phone numbers or addresses appear.
    `env_invalid` at boot means step 2 failed.

## 6. Observability

- **Logs** are structured JSON, one object per line:
  - `route`: method, status, ms. Streams also get a `route_stream_end` line with the full duration.
  - `tool_call`: tool, server, ms, ok, attempts.
  - `llm_call`: provider, key slot, model, ms, input/output/cached tokens, finish.
  - `llm_turn` and `llm_fallback`: which model answered and how many fallbacks it took.
  - `request_error`: uncaught errors, with the digest the error page shows as "Reference".

  Filter by `requestId`. Error responses return it in the body and in the `x-request-id` header.
  On Vercel it is the platform's `x-vercel-id`.
- **Circuit breakers**: after repeated 5xx responses or timeouts, or a 429 with Retry-After, a Swiggy
  server or LLM key is skipped for a cooldown so users get a fast, friendly "try again in N s".
  `/api/ready` → `circuits` lists what is open. Payment confirm and status calls are never blocked.
- **Analytics**: set `NEXT_PUBLIC_VERCEL_ANALYTICS=1` after enabling Web Analytics and Speed Insights
  in the project. No extra account is needed.

## 7. Rollback

- Vercel → **Deployments** → choose the last good deployment → **⋯ → Promote to Production**
  (an instant rollback with no rebuild). CLI: `vercel rollback <deployment-url>`, or `vercel promote <url>`.
- Environment variable changes apply only to **new** deployments. After fixing a variable, redeploy;
  promoting an older deployment keeps that deployment's variables.
- To stop real orders right away: set `SWIGGY_ENABLE_ORDERS=false` and redeploy. Ordering routes
  answer "ordering is disabled" from then on.
- A `SESSION_SECRET` rotation logs every user out. Do it only if the secret leaked.

## 8. Local production check (optional)

```bash
npm run build && npx next start -p 3001     # not :3000 if `next dev` is running there
curl -s localhost:3001/api/ready
```

`next start` runs with NODE_ENV=production, so `/api/ready` warns that `APP_BASE_URL` is not https.
That is expected locally.

## Troubleshooting `next dev` memory

If `next dev` grows towards the heap limit, run `npm run dev:heap` instead. It caps the heap at 4 GB
and writes a `.heapsnapshot` to the project root when it gets close. Open the snapshot in Chrome
DevTools → Memory and sort by *Retained size*.

## Live deployment (23 Oct 2026)
- Production: https://swizzo-ai.vercel.app (Vercel project `swizzo-ai`, region bom1). Vercel Authentication covers preview deployments only.
- Redirect URI sent to Swiggy: `https://swizzo-ai.vercel.app/api/auth/callback`
- Database: Supabase project `swizzo-ai` (ap-south-1). The schema (drizzle/0000_init + 0001_enable_rls) was applied through the Supabase connector, plus a `swizzo_app` role with RLS policies. **Do not run `npm run db:migrate` against it** (drizzle's migration table is not populated there); apply future migrations the same way, or record them first.
- `.vercelignore` keeps .env files, PDFs, docs and tests out of uploads.
