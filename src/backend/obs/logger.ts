// Structured server logger. One JSON object per line in production (Vercel log
// drains / `vercel logs` parse it), a compact one-liner in `next dev`.
// Every line carries the current requestId (see ./context.ts) when there is one.
//
// No PII: fields whose names look like credentials or personal data are
// replaced with "[redacted]", and free-text messages are scrubbed of bearer
// tokens, JWTs and phone numbers. Log identifiers (tool, server, model, ids
// Swiggy issues) — never addresses, phone numbers, names or tokens.
//
// LOG_LEVEL = debug | info | warn | error (default: info in production, debug in dev)
// LOG_FORMAT = json | pretty            (default: json in production, pretty in dev)

import { currentContext } from "./context";

export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogFields = Record<string, unknown>;

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const SENSITIVE_KEY =
  /token|secret|password|passwd|authorization|cookie|api[-_]?key|otp|phone|mobile|email|address(?!Id)|addressLine|lat$|lng$|latitude|longitude|name$/i;
// Identifier-ish keys that the SENSITIVE_KEY pattern would otherwise catch.
const SAFE_KEYS = new Set(["tool", "toolName", "provider", "model", "modelId", "route", "server", "event", "errName"]);

function minLevel(): number {
  const raw = process.env.LOG_LEVEL?.trim().toLowerCase() as LogLevel | undefined;
  if (raw && raw in ORDER) return ORDER[raw];
  return process.env.NODE_ENV === "production" ? ORDER.info : ORDER.debug;
}

function pretty(): boolean {
  const raw = process.env.LOG_FORMAT?.trim().toLowerCase();
  if (raw === "json") return false;
  if (raw === "pretty") return true;
  return process.env.NODE_ENV !== "production";
}

/** Strip credentials / phone numbers from free text (error messages etc.). */
export function scrub(text: string, max = 400): string {
  return text
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g, "[jwt]")
    .replace(/\b(sk|gsk|AIza)[-_A-Za-z0-9]{16,}/g, "[key]")
    .replace(/(?<!\d)(?:\+?91[-\s]?)?[6-9]\d{9}(?!\d)/g, "[phone]")
    .slice(0, max);
}

function sanitize(value: unknown, depth = 0): unknown {
  if (value == null || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "string") return scrub(value);
  if (value instanceof Error) return { name: value.name, message: scrub(value.message) };
  if (depth > 3) return "[…]";
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => sanitize(v, depth + 1));
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      // token COUNTS (inputTokens, outputTokens…) are metrics, not credentials
      const sensitive = !SAFE_KEYS.has(k) && !/Tokens$/.test(k) && SENSITIVE_KEY.test(k);
      out[k] = sensitive ? "[redacted]" : sanitize(v, depth + 1);
    }
    return out;
  }
  return String(value);
}

/** A loggable view of an unknown thrown value (name, scrubbed message, HTTP status). */
export function errorFields(err: unknown): LogFields {
  if (err instanceof Error) {
    const e = err as Error & { status?: unknown; statusCode?: unknown; code?: unknown };
    const status = typeof e.statusCode === "number" ? e.statusCode : typeof e.status === "number" ? e.status : undefined;
    return {
      errName: err.name,
      errMessage: scrub(err.message),
      ...(status !== undefined ? { errStatus: status } : {}),
      ...(typeof e.code === "string" || typeof e.code === "number" ? { errCode: e.code } : {}),
    };
  }
  return { errMessage: scrub(String(err)) };
}

function emit(level: LogLevel, msg: string, fields?: LogFields): void {
  if (ORDER[level] < minLevel()) return;
  const ctx = currentContext();
  const clean = fields ? (sanitize(fields) as LogFields) : {};
  const sink = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
  if (pretty()) {
    const kv = Object.entries(clean)
      .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
      .join(" ");
    sink(`[${level}] ${msg}${ctx?.requestId ? ` rid=${ctx.requestId.slice(-12)}` : ""}${kv ? ` ${kv}` : ""}`);
    return;
  }
  const line: LogFields = {
    t: new Date().toISOString(),
    level,
    msg,
    ...(ctx?.requestId ? { requestId: ctx.requestId } : {}),
    ...(ctx?.route ? { route: ctx.route } : {}),
    ...clean,
  };
  try {
    sink(JSON.stringify(line));
  } catch {
    sink(JSON.stringify({ t: line.t, level, msg, note: "unserializable fields" }));
  }
}

export const log = {
  debug: (msg: string, fields?: LogFields) => emit("debug", msg, fields),
  info: (msg: string, fields?: LogFields) => emit("info", msg, fields),
  warn: (msg: string, fields?: LogFields) => emit("warn", msg, fields),
  error: (msg: string, fields?: LogFields) => emit("error", msg, fields),
};
