// Server-only per-user Swiggy session, kept in an AES-256-GCM encrypted httpOnly
// cookie (no server-side or on-disk token store, so it works on serverless).
// Holds access token, refresh token and expiry; refreshes proactively when
// ≤ 60 s remain and on demand after a 401 (docs/swiggy-mcp/platform.md §2.6–2.7).
// Also seals the short-lived OAuth `state` + PKCE verifier cookie.

import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from "node:crypto";

import { OAuthTokenError, oauthConfig, refreshTokens, type TokenSet } from "./oauth";

export const SESSION_COOKIE = "swiggy_session";
export const OAUTH_STATE_COOKIE = "swiggy_oauth";
// Pre-encryption cookies from older builds; always cleared, never trusted.
const LEGACY_COOKIES = ["swiggy_token", "swiggy_logged_out", "swiggy_pkce_verifier"];

const REFRESH_SKEW_MS = 60_000;
const OAUTH_STATE_TTL_MS = 10 * 60_000;

export interface SwiggySession {
  accessToken: string;
  /** Omitted when equal to the access token (Swiggy currently returns the same value). */
  refreshToken?: string;
  /** Epoch ms. */
  expiresAt: number;
  userId?: string;
}

/* ------------------------------- encryption -------------------------------- */

let devKey: Buffer | undefined;

function key(): Buffer {
  const secret = process.env.SESSION_SECRET?.trim();
  if (secret && secret.length >= 32) return createHash("sha256").update(secret).digest();
  if (process.env.NODE_ENV === "production") {
    throw new Error("SESSION_SECRET (≥ 32 chars) must be set in production");
  }
  if (!devKey) {
    console.warn("[session] SESSION_SECRET missing — using a per-process key; sessions reset on restart.");
    devKey = randomBytes(32);
  }
  return devKey;
}

function seal(value: unknown): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const body = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return `v1.${Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64url")}`;
}

function unseal<T>(sealed: string | undefined): T | null {
  if (!sealed?.startsWith("v1.")) return null;
  try {
    const raw = Buffer.from(sealed.slice(3), "base64url");
    const decipher = createDecipheriv("aes-256-gcm", key(), raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));
    const text = Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8");
    return JSON.parse(text) as T;
  } catch {
    return null; // tampered, old key, or garbage
  }
}

/* --------------------------------- cookies --------------------------------- */

type CookieStore = Awaited<ReturnType<typeof import("next/headers").cookies>>;

async function cookieStore(): Promise<CookieStore | null> {
  try {
    const { cookies } = await import("next/headers");
    return await cookies();
  } catch {
    return null; // outside a request (build, background job)
  }
}

function secureCookies(): boolean {
  return process.env.NODE_ENV === "production" || oauthConfig().appBaseUrl.startsWith("https://");
}

interface SealedSession {
  at: string;
  rt?: string;
  exp: number;
  uid?: string;
}

function fromTokenSet(set: TokenSet, previous?: SwiggySession): SwiggySession {
  const refreshToken = set.refreshToken && set.refreshToken !== set.accessToken ? set.refreshToken : undefined;
  return {
    accessToken: set.accessToken,
    refreshToken,
    expiresAt: set.expiresAt,
    userId: set.userId ?? previous?.userId,
  };
}

/** Persist the session cookie. Returns false when cookies can't be written here. */
function writeSession(store: CookieStore, session: SwiggySession): boolean {
  // Lives exactly as long as the Swiggy token, capped at 30 days.
  const maxAge = Math.min(Math.floor((session.expiresAt - Date.now()) / 1000), 30 * 86_400);
  if (maxAge <= 0) return false;
  try {
    const payload: SealedSession = {
      at: session.accessToken,
      rt: session.refreshToken,
      exp: session.expiresAt,
      uid: session.userId,
    };
    store.set(SESSION_COOKIE, seal(payload), {
      httpOnly: true,
      secure: secureCookies(),
      sameSite: "lax",
      path: "/",
      maxAge,
    });
    for (const name of LEGACY_COOKIES) if (store.get(name)) store.delete(name);
    return true;
  } catch {
    return false; // e.g. response already streaming
  }
}

/** Store tokens from a fresh authorization-code exchange. */
export async function saveSession(set: TokenSet): Promise<void> {
  const store = await cookieStore();
  if (!store || !writeSession(store, fromTokenSet(set))) {
    throw new Error("Could not write the Swiggy session cookie");
  }
}

/** Remove the session cookie (and any legacy token cookies). */
export async function clearSession(): Promise<void> {
  const store = await cookieStore();
  if (!store) return;
  try {
    store.delete(SESSION_COOKIE);
    for (const name of LEGACY_COOKIES) store.delete(name);
  } catch {
    // not writable in this context
  }
}

/* ------------------------------ refresh logic ------------------------------ */

const tokenHash = (t: string) => createHash("sha256").update(t).digest("hex").slice(0, 24);

// Refreshes whose cookie write may not have landed (streaming responses, races),
// keyed by the superseded access token, so the next request picks them up.
const g = globalThis as unknown as {
  __swiggyRefreshed?: Map<string, { session: SwiggySession; until: number }>;
  __swiggyRefreshInflight?: Map<string, Promise<SwiggySession | null>>;
};
const refreshed = (g.__swiggyRefreshed ??= new Map());
const inflight = (g.__swiggyRefreshInflight ??= new Map());

function rememberRefresh(oldAccessToken: string, session: SwiggySession): void {
  const now = Date.now();
  for (const [k, v] of refreshed) if (v.until < now) refreshed.delete(k);
  refreshed.set(tokenHash(oldAccessToken), { session, until: now + 10 * 60_000 });
}

/** Refresh once per token at a time. Resolves null when the grant is dead (re-authorize). */
function refreshOnce(current: SwiggySession): Promise<SwiggySession | null> {
  const k = tokenHash(current.accessToken);
  const running = inflight.get(k);
  if (running) return running;
  const p = (async () => {
    try {
      const set = await refreshTokens(current.refreshToken ?? current.accessToken);
      const next = fromTokenSet(set, current);
      rememberRefresh(current.accessToken, next);
      return next;
    } catch (err) {
      if (err instanceof OAuthTokenError && err.terminal) {
        console.warn(`[session] refresh rejected (${err.code}) — re-authorization required`);
        return null;
      }
      throw err; // transient: caller keeps the current token
    } finally {
      inflight.delete(k);
    }
  })();
  inflight.set(k, p);
  return p;
}

/**
 * The current user's Swiggy session, refreshed when ≤ 60 s remain (or when
 * `forceRefresh`, e.g. after a 401). Returns null when logged out or when the
 * session can no longer be refreshed.
 */
export async function getActiveSession(opts: { forceRefresh?: boolean } = {}): Promise<SwiggySession | null> {
  const store = await cookieStore();
  if (!store) return null;
  const sealed = unseal<SealedSession>(store.get(SESSION_COOKIE)?.value);
  if (!sealed?.at) return null;

  let session: SwiggySession = {
    accessToken: sealed.at,
    refreshToken: sealed.rt,
    expiresAt: sealed.exp,
    userId: sealed.uid,
  };
  const pending = refreshed.get(tokenHash(session.accessToken));
  if (pending && pending.session.expiresAt > session.expiresAt) {
    session = pending.session;
    writeSession(store, session);
  }

  const now = Date.now();
  if (session.expiresAt <= now) {
    // An expired token cannot be refreshed — the user must log in again.
    await clearSession();
    return null;
  }

  if (opts.forceRefresh || session.expiresAt - now <= REFRESH_SKEW_MS) {
    try {
      const next = await refreshOnce(session);
      if (!next) {
        await clearSession();
        return null;
      }
      writeSession(store, next);
      return next;
    } catch (err) {
      console.warn("[session] refresh failed transiently:", err instanceof Error ? err.message : err);
      if (opts.forceRefresh) return null;
      return session; // still valid for up to 60 s
    }
  }
  return session;
}

/* ---------------------------- OAuth state cookie --------------------------- */

interface OAuthState {
  s: string; // state
  v: string; // PKCE code_verifier
  t: number; // issued at
}

export async function saveOAuthState(state: string, codeVerifier: string): Promise<void> {
  const store = await cookieStore();
  if (!store) throw new Error("No request context for OAuth state");
  const payload: OAuthState = { s: state, v: codeVerifier, t: Date.now() };
  store.set(OAUTH_STATE_COOKIE, seal(payload), {
    httpOnly: true,
    secure: secureCookies(),
    sameSite: "lax", // must survive the top-level redirect back from Swiggy
    path: "/api/auth",
    maxAge: OAUTH_STATE_TTL_MS / 1000,
  });
}

/**
 * Verify the callback `state` against the sealed cookie and return the PKCE
 * verifier. Single-use: the cookie is deleted either way.
 */
export async function consumeOAuthState(state: string): Promise<string | null> {
  const store = await cookieStore();
  if (!store) return null;
  const saved = unseal<OAuthState>(store.get(OAUTH_STATE_COOKIE)?.value);
  try {
    store.delete({ name: OAUTH_STATE_COOKIE, path: "/api/auth" });
  } catch {
    // ignore
  }
  if (!saved || !state || Date.now() - saved.t > OAUTH_STATE_TTL_MS) return null;
  const a = Buffer.from(saved.s);
  const b = Buffer.from(state);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  return saved.v;
}
