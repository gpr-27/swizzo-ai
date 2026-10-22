// GET /api/auth/login — start Swiggy OAuth 2.1 + PKCE (S256).
// redirect_uri and client_id come from env (oauthConfig), never from request
// headers, so they always exact-match Swiggy's allowlist.

import crypto from "node:crypto";
import { NextResponse } from "next/server";

import { oauthConfig } from "@/backend/config/oauth";
import { saveOAuthState } from "@/backend/config/session";
import { route } from "@/backend/http/route";
import { LoginQuery } from "@/backend/http/schemas";

export const dynamic = "force-dynamic";

export const GET = route({ name: "api/auth/login", auth: "none", rateLimit: "auth", query: LoginQuery }, async function GET(request: Request) {
  const { authBase, clientId, redirectUri, scope } = oauthConfig();

  const codeVerifier = crypto.randomBytes(32).toString("base64url");
  const codeChallenge = crypto.createHash("sha256").update(codeVerifier).digest("base64url");
  const state = crypto.randomBytes(16).toString("base64url");

  // Fresh verifier + CSRF state per login, sealed in a short-lived httpOnly cookie.
  await saveOAuthState(state, codeVerifier);

  const url = new URL(`${authBase}/authorize`);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("code_challenge", codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", state);
  url.searchParams.set("scope", scope);
  // "Switch account" asks Swiggy to show the phone/OTP form again. Not part of
  // the documented contract, so only sent when explicitly requested.
  if (new URL(request.url).searchParams.get("prompt") === "login") {
    url.searchParams.set("prompt", "login");
  }

  return NextResponse.redirect(url.toString());
});
