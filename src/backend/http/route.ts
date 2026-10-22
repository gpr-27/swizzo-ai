// Shared API route wrapper: one place for the security controls every route
// needs, applied in a fixed order —
//
//   1. same-origin check for state-changing methods (CSRF; GET never mutates)
//      and a cross-site-read refusal for session GETs
//   2. query validation (size + zod schema)
//   3. Swiggy session (401 in one uniform shape when required and missing)
//   4. rate limit (per session + per IP token buckets, ./security/rate-limit)
//   5. body validation (JSON content type, byte cap, zod schema)
//   6. optional double-submit protection (./security/idempotency)
//   7. uniform 401 for AuthErrors and a redacted, generic 500 for anything thrown
//
// Handlers keep their own parsing: the validated body is re-attached to a
// fresh Request, so `await request.json()` inside a handler still works, and
// it is also available as `ctx.body`.
//
//   export const POST = route({ name: "api/cart", rateLimit: "mutate", body: CartBody }, async (request, ctx) => …);

import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import type { ZodType } from "zod";

import { isAuthError } from "@/backend/config/env";
import { getActiveSession, type SwiggySession } from "@/backend/config/session";
import { idempotencyKey, runOnce } from "@/backend/security/idempotency";
import { checkSameOrigin, isCrossSiteRead } from "@/backend/security/origin";
import { consumeRateLimit, type RatePolicy } from "@/backend/security/rate-limit";
import { installConsoleRedaction } from "@/backend/security/redact";
import { withObservability } from "@/backend/obs/route";

installConsoleRedaction();

export interface RouteContext<B = unknown, Q = unknown> {
  name: string;
  ip: string;
  session: SwiggySession | null;
  /** Stable, non-reversible per-user key (null when logged out). */
  sessionKey: string | null;
  body: B;
  query: Q;
  bodyText: string;
}

export interface RouteOptions<B, Q> {
  /** Log tag, e.g. "api/cart". */
  name: string;
  /** "session" (default): a Swiggy session is required. "optional": loaded if present. "none": not read. */
  auth?: "session" | "optional" | "none";
  /** Rate-limit policy, or a function of the validated body (null = no limit). */
  rateLimit?: RatePolicy | ((body: B) => RatePolicy | null);
  body?: ZodType<B>;
  query?: ZodType<Q>;
  /** Raw body byte cap (default 64 KB). */
  maxBodyBytes?: number;
  /** Errors as one NDJSON `{type:"error"}` line (the chat stream). */
  ndjson?: boolean;
  /** Double-submit protection: an action name, or a function of the body (null = none). */
  idempotent?: string | ((body: B) => string | null);
}

const DEFAULT_MAX_BODY = 64 * 1024;
const MAX_QUERY_CHARS = 4_096;
const MAX_QUERY_PARAMS = 30;
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

const als = new AsyncLocalStorage<RouteContext>();

/** The current route context (inside a wrapped handler), else undefined. */
export function currentRoute(): RouteContext | undefined {
  return als.getStore();
}

/** Run `fn` as if inside a route for `ctx` (tests, background work for one user). */
export function runInRouteContext<T>(ctx: RouteContext, fn: () => T): T {
  return als.run(ctx, fn);
}

/* --------------------------------- errors ---------------------------------- */

export const UNAUTHORIZED_MESSAGE = "Your Swiggy session expired — please log in again.";

/**
 * Uniform error body: `{ ok:false, code, error, message, ...extra }` — `error`
 * and `message` are the same human-readable text so both older client styles
 * (`data.error` / `data.message`) keep working.
 */
export function apiError(status: number, code: string, message: string, extra: Record<string, unknown> = {}, headers: Record<string, string> = {}): Response {
  return Response.json(
    { ok: false, code, error: message, message, ...extra },
    { status, headers: { "Cache-Control": "private, no-store", ...headers } },
  );
}

/** 401 in the one shape every client path understands. */
export function unauthorized(message = UNAUTHORIZED_MESSAGE): Response {
  return apiError(401, "unauthorized", message, { needsLogin: true, auth: true, authRequired: true });
}

function ndjsonError(status: number, code: string, message: string, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ type: "error", code, message }) + "\n", {
    status,
    headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store", ...headers },
  });
}

/* --------------------------------- helpers --------------------------------- */

export function clientIp(request: Request): string {
  const h = request.headers;
  const raw = h.get("x-real-ip") || h.get("x-vercel-forwarded-for") || h.get("x-forwarded-for") || "";
  const ip = raw.split(",")[0].trim().slice(0, 64);
  return ip || "unknown";
}

export function sessionKeyOf(session: SwiggySession): string {
  const basis = session.userId ? `u:${session.userId}` : `t:${session.accessToken}`;
  return createHash("sha256").update(basis).digest("hex").slice(0, 32);
}

class BodyTooLarge extends Error {}

async function readLimited(request: Request, max: number): Promise<string> {
  const declared = Number(request.headers.get("content-length") || "");
  if (Number.isFinite(declared) && declared > max) throw new BodyTooLarge();
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => {});
      throw new BodyTooLarge();
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function issueText(error: { issues: { path: PropertyKey[]; message: string }[] }): string {
  const first = error.issues[0];
  if (!first) return "Invalid request.";
  const path = first.path.map(String).join(".");
  return `Invalid request${path ? ` (${path})` : ""}: ${first.message}`;
}

/* --------------------------------- wrapper --------------------------------- */

export function route<B = unknown, Q = unknown>(
  opts: RouteOptions<B, Q>,
  handler: (request: Request, ctx: RouteContext<B, Q>) => Promise<Response> | Response,
): (request: Request) => Promise<Response> {
  const fail = (status: number, code: string, message: string, extra: Record<string, unknown> = {}, headers: Record<string, string> = {}) =>
    opts.ndjson ? ndjsonError(status, code, message, headers) : apiError(status, code, message, extra, headers);
  const failAuth = () => (opts.ndjson ? ndjsonError(401, "unauthorized", UNAUTHORIZED_MESSAGE) : unauthorized());

  // Outermost: request id (x-request-id header + error bodies), latency log line.
  return withObservability(opts.name, async function wrapped(request: Request): Promise<Response> {
    const method = request.method.toUpperCase();
    const auth = opts.auth ?? "session";
    const ip = clientIp(request);

    // 1) CSRF / cross-origin
    if (!SAFE_METHODS.has(method)) {
      const verdict = checkSameOrigin(request);
      if (!verdict.ok) {
        console.warn(`[${opts.name}] rejected cross-origin ${method}: ${verdict.reason}`);
        return fail(403, "forbidden_origin", "This request must come from the Swizzo app.");
      }
    } else if (auth === "session" && isCrossSiteRead(request)) {
      return fail(403, "forbidden_origin", "This request must come from the Swizzo app.");
    }

    // 2) query
    const url = new URL(request.url);
    if (url.search.length > MAX_QUERY_CHARS || [...url.searchParams.keys()].length > MAX_QUERY_PARAMS) {
      return fail(414, "query_too_large", "The request URL is too long.");
    }
    let query = undefined as Q;
    if (opts.query) {
      const parsed = opts.query.safeParse(Object.fromEntries(url.searchParams));
      if (!parsed.success) return fail(400, "invalid_query", issueText(parsed.error));
      query = parsed.data;
    }

    // 3) session
    let session: SwiggySession | null = null;
    if (auth !== "none") {
      session = await getActiveSession().catch(() => null);
      if (!session && auth === "session") return failAuth();
    }
    const sessionKey = session ? sessionKeyOf(session) : null;

    // 5) body (read before the rate limit so the policy may depend on it)
    let body = undefined as B;
    let bodyText = "";
    let forward = request;
    if (!SAFE_METHODS.has(method) && opts.body) {
      const type = request.headers.get("content-type") ?? "";
      if (!/^application\/json\b/i.test(type.trim())) {
        return fail(415, "unsupported_media_type", "Send the request as application/json.");
      }
      try {
        bodyText = await readLimited(request, opts.maxBodyBytes ?? DEFAULT_MAX_BODY);
      } catch (err) {
        if (err instanceof BodyTooLarge) return fail(413, "payload_too_large", "That request is too large.");
        return fail(400, "invalid_body", "Couldn't read the request body.");
      }
      let json: unknown;
      try {
        json = JSON.parse(bodyText);
      } catch {
        return fail(400, "invalid_json", "Invalid JSON body.");
      }
      const parsed = opts.body.safeParse(json);
      if (!parsed.success) return fail(400, "invalid_body", issueText(parsed.error));
      body = parsed.data;
      forward = new Request(request.url, {
        method: request.method,
        headers: request.headers,
        body: bodyText,
        signal: request.signal,
      });
    }

    // 4) rate limit
    const policy = typeof opts.rateLimit === "function" ? opts.rateLimit(body) : opts.rateLimit;
    if (policy) {
      const retryMs = await consumeRateLimit(policy, { ip, session: sessionKey });
      if (retryMs !== null) {
        const retryAfterSec = Math.max(1, Math.ceil(retryMs / 1000));
        return fail(
          429,
          "rate_limited",
          "You're going a little fast — please wait a moment and try again.",
          { rateLimited: true, retryAfterSec },
          { "Retry-After": String(retryAfterSec) },
        );
      }
    }

    const ctx: RouteContext<B, Q> = { name: opts.name, ip, session, sessionKey, body, query, bodyText };
    const run = () => Promise.resolve(handler(forward, ctx));

    // 6) + 7)
    try {
      const action = typeof opts.idempotent === "function" ? opts.idempotent(body) : opts.idempotent;
      const res = await als.run(ctx as RouteContext, () =>
        action && sessionKey
          ? runOnce(idempotencyKey(sessionKey, action, request.headers.get("idempotency-key"), bodyText), run)
          : run(),
      );
      if (!res.headers.has("cache-control")) {
        try {
          res.headers.set("Cache-Control", "private, no-store");
        } catch {
          // immutable headers (e.g. Response.redirect) — fine
        }
      }
      return res;
    } catch (err) {
      if (isAuthError(err)) return failAuth();
      console.error(`[${opts.name}] unhandled error:`, err);
      return fail(500, "internal_error", "Something went wrong on our side. Please try again.");
    }
  });
}

/* ---------------------------- per-user module state ------------------------- */

/**
 * A Map whose keys are namespaced by the current user's session (via the route
 * context), so module-level caches keyed by Swiggy ids (e.g. addressId) can
 * never be read or written across users. Outside a route it uses "anon".
 */
export class UserScopedMap<V> {
  private inner = new Map<string, V>();
  constructor(private readonly maxEntries = 5_000) {}
  private k(key: string): string {
    return `${currentRoute()?.sessionKey ?? "anon"}\u0000${key}`;
  }
  get(key: string): V | undefined {
    return this.inner.get(this.k(key));
  }
  has(key: string): boolean {
    return this.inner.has(this.k(key));
  }
  set(key: string, value: V): this {
    const k = this.k(key);
    this.inner.delete(k);
    this.inner.set(k, value);
    if (this.inner.size > this.maxEntries) {
      const oldest = this.inner.keys().next().value;
      if (oldest !== undefined) this.inner.delete(oldest);
    }
    return this;
  }
  delete(key: string): boolean {
    return this.inner.delete(this.k(key));
  }
}
