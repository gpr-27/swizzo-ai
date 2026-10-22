// Server-only Swiggy OAuth 2.1 + PKCE configuration and token-endpoint calls.
// Everything that must match Swiggy's exact-match redirect allowlist comes from
// env (APP_BASE_URL / SWIGGY_OAUTH_REDIRECT_URI), never from request headers.
// See docs/swiggy-mcp/platform.md §2.

export interface OAuthConfig {
  /** Public origin of this app, no trailing slash (e.g. https://<app>.vercel.app). */
  appBaseUrl: string;
  /** Exact redirect URI sent to /auth/authorize and /auth/token. */
  redirectUri: string;
  clientId: string;
  /** Swiggy auth base, e.g. https://mcp.swiggy.com/auth. */
  authBase: string;
  scope: string;
}

export function oauthConfig(): OAuthConfig {
  const vercelProd = process.env.VERCEL_PROJECT_PRODUCTION_URL?.trim();
  const appBaseUrl = (
    process.env.APP_BASE_URL?.trim() ||
    (vercelProd ? `https://${vercelProd}` : "") ||
    "http://localhost:3000"
  ).replace(/\/+$/, "");
  return {
    appBaseUrl,
    redirectUri: process.env.SWIGGY_OAUTH_REDIRECT_URI?.trim() || `${appBaseUrl}/api/auth/callback`,
    // "swiggy-mcp" is the client id Swiggy currently whitelists for localhost;
    // production uses the id returned by Dynamic Client Registration.
    clientId: process.env.SWIGGY_OAUTH_CLIENT_ID?.trim() || "swiggy-mcp",
    authBase: (process.env.SWIGGY_AUTH_BASE?.trim() || "https://mcp.swiggy.com/auth").replace(/\/+$/, ""),
    scope: "mcp:tools mcp:resources mcp:prompts",
  };
}

/** Token-endpoint result, normalised. `expiresAt` is epoch ms. */
export interface TokenSet {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
  userId?: string;
}

/** OAuth error from /auth/token (`{ error, error_description }`). */
export class OAuthTokenError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "OAuthTokenError";
  }

  /** invalid_grant / invalid_request: the grant is dead — re-run authorization, don't retry. */
  get terminal(): boolean {
    return this.code === "invalid_grant" || this.code === "invalid_request" || (this.status >= 400 && this.status < 500);
  }
}

/** Decode a JWT payload without verifying it (Swiggy verifies at its edge). */
export function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const part = token.split(".")[1];
  if (!part) return null;
  try {
    const parsed = JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function toTokenSet(data: Record<string, unknown>): TokenSet {
  const accessToken = typeof data.access_token === "string" ? data.access_token : "";
  if (!accessToken) throw new OAuthTokenError("server_error", "Swiggy returned no access_token", 502);
  const claims = decodeJwtPayload(accessToken);
  const expiresIn = typeof data.expires_in === "number" ? data.expires_in : Number(data.expires_in);
  const expFromClaim = typeof claims?.exp === "number" ? claims.exp * 1000 : undefined;
  const expiresAt = Number.isFinite(expiresIn) && expiresIn > 0 ? Date.now() + expiresIn * 1000 : (expFromClaim ?? Date.now() + 5 * 86_400_000);
  return {
    accessToken,
    refreshToken: typeof data.refresh_token === "string" && data.refresh_token ? data.refresh_token : undefined,
    expiresAt: expFromClaim ? Math.min(expiresAt, expFromClaim) : expiresAt,
    userId: typeof claims?.user_id === "string" || typeof claims?.user_id === "number" ? String(claims.user_id) : undefined,
  };
}

async function postToken(body: Record<string, unknown>): Promise<TokenSet> {
  const { authBase } = oauthConfig();
  const res = await fetch(`${authBase}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
    cache: "no-store",
  });
  const text = await res.text();
  let data: Record<string, unknown> = {};
  try {
    data = JSON.parse(text) as Record<string, unknown>;
  } catch {
    // non-JSON error body
  }
  if (!res.ok) {
    const code = typeof data.error === "string" ? data.error : res.status >= 500 ? "server_error" : "invalid_request";
    const desc = typeof data.error_description === "string" ? data.error_description : text.slice(0, 200);
    throw new OAuthTokenError(code, desc || `Token endpoint returned ${res.status}`, res.status);
  }
  return toTokenSet(data);
}

/** Exchange an authorization code (single-use, 120 s) for tokens. */
export function exchangeAuthorizationCode(code: string, codeVerifier: string): Promise<TokenSet> {
  const { redirectUri, clientId } = oauthConfig();
  return postToken({
    grant_type: "authorization_code",
    code,
    code_verifier: codeVerifier,
    redirect_uri: redirectUri,
    client_id: clientId,
  });
}

/** Refresh grant. The refresh token rotates — persist the returned one. */
export async function refreshTokens(refreshToken: string): Promise<TokenSet> {
  let attempt = 0;
  for (;;) {
    try {
      const set = await postToken({ grant_type: "refresh_token", refresh_token: refreshToken });
      return { ...set, refreshToken: set.refreshToken ?? refreshToken };
    } catch (err) {
      // Only 5xx / network is retryable; invalid_grant means re-authorize.
      const retryable = !(err instanceof OAuthTokenError) || err.status >= 500;
      if (!retryable || attempt >= 2) throw err;
      attempt++;
      await new Promise((r) => setTimeout(r, 500 * 2 ** (attempt - 1) + Math.random() * 150));
    }
  }
}

/** Best-effort server-side revoke (POST /auth/logout with the bearer token). */
export async function revokeSwiggySession(accessToken: string): Promise<void> {
  const { authBase } = oauthConfig();
  try {
    await fetch(`${authBase}/logout`, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(5_000),
      cache: "no-store",
    });
  } catch (err) {
    console.warn("[auth] Swiggy logout/revoke failed:", err instanceof Error ? err.message : err);
  }
}
