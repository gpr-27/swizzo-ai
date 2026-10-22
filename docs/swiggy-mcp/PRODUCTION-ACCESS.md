# Getting production access (Swiggy Builders Club)

How to take swiggy-chat from `http://localhost:3000` to a Vercel production URL.
Contract details live in [platform.md](./platform.md) §2 (OAuth) and §10 (go-live).

Why this is needed: Swiggy's OAuth server only redirects to **exact-match allowlisted**
URIs. `http://localhost:3000/api/auth/callback` with `client_id=swiggy-mcp` works today.
A new origin such as `https://<app>.vercel.app/api/auth/callback` fails at `/auth/authorize`
until Swiggy allowlists it. You can't fix that in code. You request it by email or with the access form.

---

## 1. Before you apply

1. Get the full flow working on localhost with real data:
   login (phone + OTP) → address → search → cart → **explicit confirmation of items, total and address**
   → payment (UPI via Swiggy's payment page, or Cash) → confirmation → tracking.
   Keep the "Powered by Swiggy / Instamart / Dineout" attribution visible throughout.
2. Record a **2–4 minute screen capture** of that flow (Loom, Google Drive or unlisted YouTube).
   Reviewers say a video is the fastest way through review.
3. Pick the production domain. Use **one stable domain**, such as the Vercel production alias
   `https://<app>.vercel.app` or a custom domain. Don't use preview URLs: they change on every deploy
   and exact-match allowlisting means each one would need its own entry.
4. Decide where LLM inference runs. Our providers (Anthropic, Groq, Google) process outside India,
   which per Swiggy's data & compliance page requires a **DPA + SCCs** before production.
   Ask for their template in the same email.

## 2. Email / application text

Send to **builders@swiggy.in**, or paste into https://mcp.swiggy.com/builders/access/ (the form has the
same fields).

> **Subject:** Production access + OAuth redirect allowlist — swiggy-chat (Swiggy AI concierge)
>
> Hi Swiggy Builders team,
>
> I'd like to move my Builders Club integration from localhost to production. Details below.
>
> **Integration name:** swiggy-chat — Swiggy AI concierge
> **Organization / developer:** Gandra Praneeth Reddy (DEV Integration Agreement signed 19 Aug 2026)
> **Primary technical contact:** <your engineering email>  ·  **Incident contact:** <email / phone>
>
> **Use case:** A chat concierge on the web. Users connect their own Swiggy account (OAuth 2.1 + PKCE,
> phone + OTP on Swiggy's consent page), then ask in natural language to discover restaurants and
> dishes (Food), build grocery carts (Instamart), find and book tables (Dineout), and find event tickets
> (Scenes). Every order or booking shows the items, total, delivery address and payment method, and
> needs an explicit confirmation before we call the place-order tool. Payments use the shared Payment
> stage: `get_payment_options` → place-order → we share Swiggy's `bridgeUrl` → sequential
> `check_payment_status` capped at `maxTimeToPollForInMs` → `confirm_order` only when required. We
> never ask for a UPI ID. Cash and Swiggy Money are offered only when `get_payment_options` returns them.
>
> **Redirect URIs (exact match):**
> - `https://<production-domain>/api/auth/callback`  ← new, please allowlist
> - `http://localhost:3000/api/auth/callback`  ← existing (local development)
>
> **OAuth client:** we currently use `client_id=swiggy-mcp` on localhost. Should production keep it, or
> should we register via Dynamic Client Registration (`POST /auth/register`) with the redirect URIs above
> and send you the issued `client_id`?
>
> **Servers:** food, instamart (`/im`), dineout, scenes. **Scopes:** `mcp:tools mcp:resources mcp:prompts`.
>
> **Expected volume:** ~<N> orders/day, ~<N> tool calls/day, peak ~<N> QPS (mostly 12:00–14:00 and
> 19:00–22:00 IST). We'll tell you 7 days ahead of any launch or campaign.
>
> **Technical readiness:**
> - Per-user encrypted httpOnly session holding the access and refresh tokens. Proactive refresh at ≤ 60 s
>   left, and refresh-then-retry-once on 401 / `-32001`. Tokens are never shared between users, never
>   stored on disk, never logged.
> - One MCP session per user and server, reused across calls.
> - 429 handling honours `Retry-After`. Exponential backoff with jitter for idempotent tools only, with a
>   30 s budget.
> - Order placement is never blind-retried. We check-then-retry via `get_orders` / `get_food_orders` /
>   `get_booking_status`.
> - `{success:false}` errors show Swiggy's message to the user. A correlation id is logged on every call.
> - "Powered by Swiggy / Instamart / Dineout" attribution with the square logos, per the brand guidelines.
>
> **Data:** We don't persist Swiggy data beyond the session and don't use it for analytics or training.
> LLM inference runs with <provider(s)> in <region(s)>. Please share your DPA template so we can sign it
> before production.
>
> **Demo video:** <video link>
>
> Thanks,
> <name>

## 3. Vercel setup

Do this once the production domain is known. You can do it before Swiggy replies; login on that
domain only works after allowlisting.

1. Create or link the project: `vercel link`. Then pick the stable production domain
   (Project → Settings → Domains).
2. Add the env vars to the **Production** environment only:
   ```bash
   vercel env add APP_BASE_URL production           # https://<production-domain>  (no trailing slash)
   vercel env add SESSION_SECRET production         # node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
   vercel env add SWIGGY_OAUTH_CLIENT_ID production # swiggy-mcp, or the DCR-issued id Swiggy confirms
   vercel env add SWIGGY_ENABLE_ORDERS production   # "true" only after Swiggy confirms production access
   vercel env add ANTHROPIC_API_KEY production      # plus GROQ_API_KEY / GEMINI_API_KEY as used
   ```
   Optional:
   - `SWIGGY_OAUTH_REDIRECT_URI`, if the callback must differ from `${APP_BASE_URL}/api/auth/callback`.
   - `SWIGGY_MCP_BASE` + `SWIGGY_AUTH_BASE` (`https://mcp-staging.swiggy.com`, `…/auth`) for the
     staging phase.

   If `APP_BASE_URL` is unset, the app falls back to `https://$VERCEL_PROJECT_PRODUCTION_URL`. Set it
   explicitly anyway, because the redirect URI must match the allowlist byte for byte.
3. **Don't set `SWIGGY_TOKEN`.** The app ignores it, since tokens are per user. There is no shared token.
4. Preview deployments: their URLs aren't allowlisted, so login there will fail at `/auth/authorize`. If
   you need previews, assign a fixed branch alias (e.g. `staging-<app>.vercel.app`), add it to the
   allowlist request, and set `APP_BASE_URL` for the Preview environment to that alias.
5. Deploy with `vercel --prod`. Then check:
   - `GET /api/auth/login` redirects to `https://mcp.swiggy.com/auth/authorize?...&redirect_uri=https%3A%2F%2F<production-domain>%2Fapi%2Fauth%2Fcallback`.
   - After OTP you land on `https://<production-domain>/` and `GET /api/auth/status` shows
     `authenticated: true`.
   - The session cookie is `swiggy_session`, with httpOnly, Secure and SameSite=Lax.

## 4. If Swiggy asks for Dynamic Client Registration

Run this **once**, from your machine. It creates a client on Swiggy's side, so don't automate it.

```bash
curl -X POST https://mcp.swiggy.com/auth/register \
  -H 'Content-Type: application/json' \
  -d '{
    "client_name": "swiggy-chat",
    "redirect_uris": [
      "http://localhost:3000/api/auth/callback",
      "https://<production-domain>/api/auth/callback"
    ],
    "grant_types": ["authorization_code", "refresh_token"],
    "response_types": ["code"],
    "token_endpoint_auth_method": "none"
  }'
```

Put the returned `client_id` in `SWIGGY_OAUTH_CLIENT_ID` for Production, and send it to builders@swiggy.in.

## 5. After approval

- You get staging first (`mcp-staging.swiggy.com`). Point `SWIGGY_MCP_BASE` / `SWIGGY_AUTH_BASE` at it,
  and keep it green for **≥ 48 h**.
- Production follows. Then switch the bases back, set `SWIGGY_ENABLE_ORDERS=true`, and ramp traffic
  1 % → 10 % → 50 % → 100 % over ≥ 24 h.
- Subscribe the engineering alias to deprecation emails (email builders@swiggy.in).
- Work through the go-live checklist in [platform.md §10](./platform.md).
