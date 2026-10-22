// GET /api/auth/callback — Swiggy redirects here with ?code&state.
// Verifies state against the sealed cookie, exchanges the code (single-use,
// 120 s) with the PKCE verifier, stores access + refresh tokens in the
// encrypted session cookie, and returns to the app's own base URL.

import { NextResponse } from "next/server";

import { exchangeAuthorizationCode, OAuthTokenError, oauthConfig } from "@/backend/config/oauth";
import { consumeOAuthState, saveSession } from "@/backend/config/session";
import { route } from "@/backend/http/route";
import { CallbackQuery } from "@/backend/http/schemas";

export const dynamic = "force-dynamic";

function backToApp(error?: string): NextResponse {
  const url = new URL("/", oauthConfig().appBaseUrl);
  if (error) url.searchParams.set("auth_error", error);
  return NextResponse.redirect(url);
}

export const GET = route({ name: "api/auth/callback", auth: "none", rateLimit: "auth", query: CallbackQuery }, async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const code = params.get("code");
  const state = params.get("state") || "";

  // Always consume the state cookie, even on error redirects.
  const verifier = await consumeOAuthState(state);

  const swiggyError = params.get("error");
  if (swiggyError) {
    console.warn(`[auth] authorization denied: ${swiggyError}`);
    return backToApp(swiggyError === "access_denied" ? "access_denied" : "authorize_failed");
  }
  if (!code) return backToApp("missing_code");
  if (!verifier) {
    // Missing/expired/mismatched state: possible CSRF or a stale tab.
    return backToApp("state_mismatch");
  }

  try {
    const tokens = await exchangeAuthorizationCode(code, verifier);
    await saveSession(tokens);
    return backToApp();
  } catch (err) {
    if (err instanceof OAuthTokenError) {
      console.error(`[auth] token exchange failed: ${err.status} ${err.code} — ${err.message}`);
    } else {
      console.error("[auth] token exchange error:", err instanceof Error ? err.message : err);
    }
    return backToApp("token_exchange_failed");
  }
});
