// Generic streamable-HTTP MCP client for every Swiggy server (food, im, dineout,
// scenes). Follows the Builders Club "Ship to production" guidance:
//   - one MCP session per (user token, server), reused across tool calls
//     instead of an `initialize` handshake per call;
//   - `{ success:false }` envelopes (HTTP 200) are errors, never data;
//   - only idempotent tools are retried, on network/5xx/429, honouring
//     Retry-After, inside a 30 s retry budget;
//   - auth failures (HTTP 401/419, JSON-RPC -32001) are thrown as AuthError so
//     the UI can ask the user to log in again.

import { createHash, randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StreamableHTTPClientTransport,
  StreamableHTTPError,
} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { McpError } from "@modelcontextprotocol/sdk/types.js";

import { AuthError, getSwiggyToken, refreshSwiggyToken } from "@/backend/config/env";
import { isMutatingTool, recordToolAudit } from "@/backend/db/audit";
import { errorFields, log } from "@/backend/obs/logger";
import { backoffMs, breakers, parseRetryAfter } from "@/backend/resilience/breaker";
import { BoundedMap } from "@/backend/resilience/lru";
import { coerceToolPayload } from "./payload";

// Re-export so the per-server modules can import everything from one place.
export { coerceToolPayload };

// Shape of an MCP CallToolResult (the bits we rely on).
export interface ToolResult {
  content?: Array<{ type?: string; text?: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

/** A Swiggy domain error (`{ success:false, error }` or an isError tool result). */
export class SwiggyToolError extends Error {
  constructor(
    message: string,
    readonly tool: string,
    readonly reportId?: string,
  ) {
    super(message);
    this.name = "SwiggyToolError";
  }
}

/**
 * Fast-fail: this Swiggy server failed repeatedly (or rate-limited us) moments
 * ago, so the call was not sent. A SwiggyToolError so every existing handler
 * shows its friendly message instead of a generic failure.
 */
export class SwiggyUnavailableError extends SwiggyToolError {
  constructor(
    tool: string,
    readonly retryInMs: number,
    serverUrl: string,
  ) {
    const secs = Math.max(1, Math.ceil(retryInMs / 1000));
    super(`Swiggy ${serverLabel(serverUrl)} isn't responding right now — please try again in about ${secs} s.`, tool);
    this.name = "SwiggyUnavailableError";
  }
}

function serverLabel(serverUrl: string): string {
  const tail = serverUrl.replace(/\/+$/, "").split("/").pop() ?? "";
  return { im: "Instamart", food: "Food", dineout: "Dineout", scenes: "Scenes" }[tail] ?? "MCP";
}

// Tools that change real-world state. Never retried automatically — on an
// ambiguous failure the caller must read state (get_*_orders / booking status)
// before trying again. Cart mutators are retry-safe per the docs and are not
// listed here.
const NON_IDEMPOTENT_TOOLS = new Set([
  "checkout",
  "place_food_order",
  "book_table",
  "cancel_booking",
  "create_cart",
  "create_event_cart",
  "place_event_order",
  "create_address",
  "delete_address",
  "apply_coupon",
  "apply_food_coupon",
  "report_error",
]);

// Long-poll tools: the server holds the request up to ~19 s.
const LONG_POLL_TOOLS = new Set(["check_payment_status"]);

// The post-payment path always goes out, even while the server's circuit is
// open: a paid order must get its confirm / status call.
const BREAKER_EXEMPT_TOOLS = new Set(["check_payment_status", "confirm_order"]);

const DEFAULT_TIMEOUT_MS = 30_000;
const LONG_POLL_TIMEOUT_MS = 28_000;
// The MCP `initialize` handshake (SDK default is 60 s).
const CONNECT_TIMEOUT_MS = 10_000;
const RETRY_BUDGET_MS = 30_000;
const SESSION_IDLE_MS = 5 * 60_000;
// Hard cap on live sessions per process (users × 4 servers); LRU-evicted and closed.
const MAX_SESSIONS = 400;

/* ------------------------------ session cache ------------------------------ */

interface Session {
  client: Client;
  connecting: Promise<Client>;
  lastUsed: number;
  retryAfterMs?: number;
}

// Survives Next.js dev hot reloads. Bounded: evicted / idle sessions are closed.
const g = globalThis as unknown as { __swiggyMcpSessionsV2?: BoundedMap<string, Session> };
const sessions = (g.__swiggyMcpSessionsV2 ??= new BoundedMap<string, Session>({
  max: MAX_SESSIONS,
  onEvict: (_key, s) => void s.client.close().catch(() => {}),
}));

function sessionKey(serverUrl: string, token: string): string {
  return `${serverUrl}|${createHash("sha256").update(token).digest("hex").slice(0, 16)}`;
}

function sweepIdle(now: number): void {
  for (const [key, s] of sessions) {
    if (now - s.lastUsed > SESSION_IDLE_MS) {
      sessions.delete(key);
      void s.client.close().catch(() => {});
    }
  }
}

// Idle sessions used to be swept only on the NEXT tool call, so a quiet process
// kept every MCP client (and its transport) alive forever. Sweep on a timer too
// (one per process — guarded on globalThis so dev hot reloads don't stack them;
// unref'd so it never keeps a serverless instance or `next build` alive).
const gsw = globalThis as unknown as { __swiggyMcpSweeper?: ReturnType<typeof setInterval> };
gsw.__swiggyMcpSweeper ??= setInterval(() => sweepIdle(Date.now()), 60_000);
gsw.__swiggyMcpSweeper.unref?.();

function dropSession(key: string): void {
  const s = sessions.get(key);
  if (!s) return;
  sessions.delete(key);
  void s.client.close().catch(() => {});
}

async function getSession(serverUrl: string, token: string): Promise<{ key: string; session: Session }> {
  const now = Date.now();
  sweepIdle(now);
  const key = sessionKey(serverUrl, token);
  const existing = sessions.get(key);
  if (existing) {
    existing.lastUsed = now;
    await existing.connecting;
    return { key, session: existing };
  }

  const client = new Client({ name: "swizzo-concierge", version: "1.0.0" }, { capabilities: {} });
  const session: Session = { client, connecting: Promise.resolve(client), lastUsed: now };
  // Capture Retry-After from 429s; the SDK error doesn't expose headers.
  const trackingFetch: typeof fetch = async (input, init) => {
    const res = await fetch(input, init);
    if (res.status === 429 || res.status === 503) {
      session.retryAfterMs = parseRetryAfter(res.headers.get("retry-after"));
    }
    return res;
  };
  const transport = new StreamableHTTPClientTransport(new URL(serverUrl), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
    fetch: trackingFetch,
  });
  session.connecting = client.connect(transport, { timeout: CONNECT_TIMEOUT_MS }).then(() => client);
  sessions.set(key, session);
  try {
    await session.connecting;
  } catch (err) {
    if (sessions.get(key) === session) sessions.delete(key);
    void client.close().catch(() => {});
    throw err;
  }
  return { key, session };
}

/* ------------------------------ error helpers ------------------------------ */

type ErrorClass = "auth" | "rate_limited" | "retryable" | "fatal";

function classify(err: unknown): { kind: ErrorClass; status?: number } {
  if (err instanceof AuthError) return { kind: "auth", status: 401 };
  if (err instanceof SwiggyToolError) return { kind: "fatal" };
  if (err instanceof StreamableHTTPError) {
    const status = err.code;
    if (status === 401 || status === 419) return { kind: "auth", status };
    if (status === 429) return { kind: "rate_limited", status };
    if (status !== undefined && status >= 500) return { kind: "retryable", status };
    return { kind: "fatal", status };
  }
  if (err instanceof McpError) {
    // Swiggy signals auth failure as JSON-RPC -32001; the SDK reuses that code
    // for its own client-side request timeout.
    if (err.code === -32001 && !/timed out/i.test(err.message)) return { kind: "auth", status: 401 };
    if (err.code === -32603 || err.code === -32000 || err.code === -32001) return { kind: "retryable" };
    return { kind: "fatal" };
  }
  const msg = err instanceof Error ? err.message : String(err);
  if (/invalid_token|jwt has expired|authentication required|\b401\b/i.test(msg)) return { kind: "auth", status: 401 };
  if (/fetch failed|ECONNRESET|ETIMEDOUT|socket hang up|network/i.test(msg)) return { kind: "retryable" };
  return { kind: "fatal" };
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new Error("aborted"));
    const onAbort = () => {
      clearTimeout(t);
      reject(signal?.reason ?? new Error("aborted"));
    };
    // Remove the listener when the timer wins, so long-lived signals don't accumulate them.
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Throw on `isError` results and `{ success:false }` envelopes; otherwise return the raw result. */
function assertToolSuccess(name: string, result: ToolResult): ToolResult {
  const body = result.structuredContent ?? parseFirstText(result.content);
  if (result.isError === true || (isRecord(body) && body.success === false)) {
    const errObj = isRecord(body) && isRecord(body.error) ? body.error : undefined;
    const message =
      (errObj && typeof errObj.message === "string" && errObj.message) ||
      (isRecord(body) && typeof body.message === "string" && body.message) ||
      firstText(result.content) ||
      `Swiggy ${name} failed`;
    const reportId = errObj && typeof errObj.reportId === "string" ? errObj.reportId : undefined;
    if (/invalid_token|jwt has expired|authentication required|session expired/i.test(message)) {
      throw new AuthError(message);
    }
    throw new SwiggyToolError(message, name, reportId);
  }
  return result;
}

function firstText(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined;
  for (const b of content) {
    if (isRecord(b) && b.type === "text" && typeof b.text === "string") return b.text;
  }
  return undefined;
}

function parseFirstText(content: unknown): unknown {
  const text = firstText(content);
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/* --------------------------------- callTool -------------------------------- */

export interface CallToolOptions {
  /** Override automatic retries (default: 2 for idempotent tools, 0 otherwise). */
  maxRetries?: number;
  signal?: AbortSignal;
  /** Use this bearer token instead of the request's session token. */
  token?: string;
}

/**
 * Call `name` on the Swiggy MCP server at `serverUrl` with the current user's
 * session token. Returns the raw CallToolResult (feed it to coerceToolPayload).
 * Throws AuthError (log in again), SwiggyToolError (domain failure — show its
 * message), or the transport error.
 * Mutating tools are recorded in the audit log (src/backend/db/audit.ts —
 * redacted args, outcome, order/cart ids; no-op without DATABASE_URL).
 */
export async function callTool(
  serverUrl: string,
  name: string,
  args: Record<string, unknown>,
  options: CallToolOptions = {},
): Promise<ToolResult> {
  if (!isMutatingTool(name)) return callToolUnaudited(serverUrl, name, args, options);
  const started = Date.now();
  const audit = async (status: "ok" | "tool_error" | "auth_error" | "error", result?: unknown, error?: unknown) =>
    recordToolAudit({
      serverUrl,
      tool: name,
      args,
      token: options.token ?? (await getSwiggyToken().catch(() => null)),
      status,
      result,
      error,
      durationMs: Date.now() - started,
    });
  try {
    const result = await callToolUnaudited(serverUrl, name, args, options);
    await audit("ok", result);
    return result;
  } catch (err) {
    await audit(err instanceof AuthError ? "auth_error" : err instanceof SwiggyToolError ? "tool_error" : "error", undefined, err);
    throw err;
  }
}

async function callToolUnaudited(
  serverUrl: string,
  name: string,
  args: Record<string, unknown>,
  options: CallToolOptions,
): Promise<ToolResult> {
  let token = options.token ?? (await getSwiggyToken());
  if (!token) throw new AuthError();
  let refreshedOnce = false;

  const idempotent = !NON_IDEMPOTENT_TOOLS.has(name) && !LONG_POLL_TOOLS.has(name);
  // Never auto-retry a non-idempotent tool, whatever the caller asked for.
  const maxRetries = idempotent ? (options.maxRetries ?? 2) : 0;
  const timeout = LONG_POLL_TOOLS.has(name) ? LONG_POLL_TIMEOUT_MS : DEFAULT_TIMEOUT_MS;
  const correlationId = randomUUID();
  const started = Date.now();
  const server = serverLabel(serverUrl);
  let attempt = 0;

  for (;;) {
    let key: string | undefined;
    let session: Session | undefined;
    // Fast-fail while this server (or this user's quota on it) is known to be down.
    const userKey = sessionKey(serverUrl, token);
    const verdict = breakers.mcp.check(serverUrl);
    const userVerdict = breakers.mcp.check(userKey);
    if ((!verdict.ok || !userVerdict.ok) && !BREAKER_EXEMPT_TOOLS.has(name)) {
      const retryInMs = Math.max(verdict.ok ? 0 : verdict.retryInMs, userVerdict.ok ? 0 : userVerdict.retryInMs);
      log.warn("tool_call", { tool: name, server, cid: correlationId, ms: Date.now() - started, ok: false, kind: "circuit_open", retryInMs });
      throw new SwiggyUnavailableError(name, retryInMs, serverUrl);
    }
    try {
      ({ key, session } = await getSession(serverUrl, token));
      const result = (await session.client.callTool({ name, arguments: args }, undefined, {
        timeout,
        signal: options.signal,
      })) as ToolResult;
      breakers.mcp.success(serverUrl);
      breakers.mcp.success(userKey);
      // Debug aid (local only): SWIGGY_DEBUG_DUMP=<file> appends every raw tool
      // result (JSONL). Never on Vercel / in production — no runtime fs writes there.
      if (process.env.SWIGGY_DEBUG_DUMP && process.env.NODE_ENV !== "production" && !process.env.VERCEL) {
        try {
          appendFileSync(
            process.env.SWIGGY_DEBUG_DUMP,
            JSON.stringify({ at: new Date().toISOString(), server: serverUrl, tool: name, args, result }) + "\n",
          );
        } catch {
          // best-effort
        }
      }
      const checked = assertToolSuccess(name, result);
      log.info("tool_call", { tool: name, server, cid: correlationId, ms: Date.now() - started, ok: true, attempts: attempt + 1 });
      return checked;
    } catch (err) {
      const { kind, status } = classify(err);
      const aborted = options.signal?.aborted === true;
      log.warn("tool_call", {
        tool: name,
        server,
        cid: correlationId,
        ms: Date.now() - started,
        ok: false,
        attempt: attempt + 1,
        kind: aborted ? "aborted" : kind,
        ...(status ? { status } : {}),
        ...errorFields(err),
      });
      // The server is struggling (not a domain "no", not the user leaving): count it.
      if (!aborted && kind === "rate_limited") breakers.mcp.failure(userKey, session?.retryAfterMs ?? 10_000);
      else if (!aborted && kind === "retryable") breakers.mcp.failure(serverUrl, status === 503 ? session?.retryAfterMs : undefined);
      if (kind === "auth") {
        if (key) dropSession(key);
        // Refresh once (grant_type=refresh_token), then retry the call once.
        if (!refreshedOnce && !options.token) {
          refreshedOnce = true;
          const fresh = await refreshSwiggyToken().catch(() => null);
          if (fresh && fresh !== token) {
            token = fresh;
            continue;
          }
        }
        throw err instanceof AuthError ? err : new AuthError("Swiggy session expired — please log in again.");
      }
      // A broken transport can't be reused.
      if (key && kind !== "fatal") dropSession(key);
      const elapsed = Date.now() - started;
      if (kind === "fatal" || attempt >= maxRetries || elapsed > RETRY_BUDGET_MS || options.signal?.aborted) {
        throw err;
      }
      const wait = kind === "rate_limited" ? (session?.retryAfterMs ?? backoffMs(attempt)) : backoffMs(attempt);
      // A Retry-After longer than the remaining budget: give up now rather than sleep past it.
      if (wait > RETRY_BUDGET_MS - elapsed) throw err;
      attempt++;
      await sleep(wait, options.signal);
    }
  }
}

/* ------------------------------ tool discovery ----------------------------- */

const TOOL_LIST_TTL_MS = 10 * 60_000;
const gt = globalThis as unknown as { __swiggyToolListsV2?: BoundedMap<string, { names: Set<string>; at: number }> };
const toolLists = (gt.__swiggyToolListsV2 ??= new BoundedMap({ max: 400, ttlMs: TOOL_LIST_TTL_MS }));

/**
 * Whether the live server exposes `name` for this user (MCP tools/list,
 * cached 10 min per user+server). Some documented tools are not rolled out to
 * every account (e.g. Dineout cancel_booking, Instamart list_coupons). Returns
 * `undefined` when the list can't be read, so callers can fall back to trying.
 */
export async function hasTool(serverUrl: string, name: string): Promise<boolean | undefined> {
  const token = await getSwiggyToken();
  if (!token) throw new AuthError();
  const key = sessionKey(serverUrl, token);
  const hit = toolLists.get(key);
  if (hit && Date.now() - hit.at < TOOL_LIST_TTL_MS) return hit.names.has(name);
  try {
    const { session } = await getSession(serverUrl, token);
    const names = new Set<string>();
    let cursor: string | undefined;
    do {
      const page = await session.client.listTools(cursor ? { cursor } : undefined, { timeout: DEFAULT_TIMEOUT_MS });
      for (const t of page.tools) names.add(t.name);
      cursor = page.nextCursor;
    } while (cursor);
    toolLists.set(key, { names, at: Date.now() });
    return names.has(name);
  } catch (err) {
    if (classify(err).kind === "auth") throw err instanceof AuthError ? err : new AuthError();
    log.warn("tools_list_failed", { server: serverLabel(serverUrl), ...errorFields(err) });
    return undefined;
  }
}

/** callTool + coerceToolPayload: the unwrapped `data` of a successful call. */
export async function callToolData(
  serverUrl: string,
  name: string,
  args: Record<string, unknown>,
  options?: CallToolOptions,
): Promise<unknown> {
  return coerceToolPayload(await callTool(serverUrl, name, args, options));
}

/* ------------------------------ value coercion ----------------------------- */

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function str(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

/**
 * Coerce an id that Swiggy may return as a string OR a number into a string.
 * (e.g. food cart `menu_item_id` comes back as a number — `str()` would blank
 * it, breaking cart matching.) Empty/object/array ids fall back.
 */
export function idStr(value: unknown, fallback = ""): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return fallback;
}

export function num(value: unknown, fallback = 0): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const clean = value.replace(/[^0-9.-]/g, "");
    if (clean) {
      const n = Number(clean);
      if (Number.isFinite(n)) return n;
    }
  }
  return fallback;
}

export function bool(value: unknown, fallback = false): boolean {
  return typeof value === "boolean" ? value : fallback;
}
