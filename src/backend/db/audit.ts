// Audit trail of every MUTATING Swiggy tool call the app makes (cart edits,
// checkout / place-order, bookings, coupons, addresses, payment confirm…).
// Called once per callTool() from src/backend/mcp/client.ts.
//
// PII rules: args are reduced to an allowlist of opaque ids, counts, enums and
// small numbers. Names, phone numbers, emails, free text (notes, address
// lines), coordinates and anything token-like are never stored. Best-effort:
// a database failure is logged and never fails the tool call.

import { randomUUID } from "node:crypto";

import { getDb } from "./client";
import { swiggyUserIdFromToken } from "./identity";
import { ensureUser, insertAudit } from "./repos";

/** Tools that change real-world state (superset of client.ts NON_IDEMPOTENT_TOOLS). */
export const MUTATING_TOOLS = new Set([
  // Instamart
  "update_cart",
  "clear_cart",
  "checkout",
  "apply_coupon",
  // Food
  "update_food_cart",
  "flush_food_cart",
  "apply_food_coupon",
  "place_food_order",
  // Dineout
  "create_cart",
  "book_table",
  "cancel_booking",
  // Scenes
  "create_event_cart",
  "place_event_order",
  // Shared
  "create_address",
  "delete_address",
  "confirm_order",
  "report_error",
]);

export function isMutatingTool(name: string): boolean {
  return MUTATING_TOOLS.has(name);
}

// Keys never stored, whatever their value.
const DENY_KEY = /name|phone|mobile|email|address(?!_?id)|line|landmark|note|instruction|message|comment|text|lat|lng|lon|token|secret|password|otp|upi|vpa|card|coupon_?code/i;
// Keys stored as-is when scalar.
const ALLOW_KEY =
  /(^|_)id$|Id$|ids$|Ids$|quantity|qty|count|guests?|party|method|mode|type|kind|status|slot|date|time|amount|total|price|variant|size|action|operation|source|reservation|ticket|show|^code$/i;

const PHONE_OR_EMAIL = /(\+?\d[\d\s-]{8,}\d)|([^\s@]+@[^\s@]+\.[^\s@]+)/;

function scalar(v: unknown): string | number | boolean | null | undefined {
  if (typeof v === "number") return Number.isFinite(v) ? v : undefined;
  if (typeof v === "boolean") return v;
  if (v === null) return null;
  if (typeof v === "string") {
    if (v.length > 120 || PHONE_OR_EMAIL.test(v) || /^eyJ[\w-]+\./.test(v)) return "[redacted]";
    return v;
  }
  return undefined;
}

/**
 * Redact tool arguments down to a PII-free summary. Arrays become
 * `{ count, items? }` (items summarised the same way, first 20); nested objects
 * are walked two levels deep.
 */
export function summarizeArgs(args: Record<string, unknown>, depth = 0): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args ?? {})) {
    if (DENY_KEY.test(k) && !/(^|_)id$|Id$/.test(k)) {
      if (v !== undefined) out[k] = "[redacted]";
      continue;
    }
    if (Array.isArray(v)) {
      const items =
        depth < 2
          ? v
              .slice(0, 20)
              .map((x) => (x && typeof x === "object" && !Array.isArray(x) ? summarizeArgs(x as Record<string, unknown>, depth + 1) : scalar(x)))
          : undefined;
      out[k] = { count: v.length, ...(items ? { items } : {}) };
      continue;
    }
    if (v && typeof v === "object") {
      if (depth < 2) out[k] = summarizeArgs(v as Record<string, unknown>, depth + 1);
      continue;
    }
    if (!ALLOW_KEY.test(k)) {
      if (v !== undefined) out[k] = typeof v === "string" ? "[redacted]" : scalar(v);
      continue;
    }
    const s = scalar(v);
    if (s !== undefined) out[k] = s;
  }
  return out;
}

const ORDER_KEYS = ["orderId", "order_id", "orderID", "bookingId", "booking_id"];
const CART_KEYS = ["cartId", "cart_id", "cartID"];

function findKey(value: unknown, keys: string[], depth = 0): string | undefined {
  if (!value || typeof value !== "object" || depth > 4) return undefined;
  if (Array.isArray(value)) {
    for (const v of value.slice(0, 10)) {
      const hit = findKey(v, keys, depth + 1);
      if (hit) return hit;
    }
    return undefined;
  }
  const rec = value as Record<string, unknown>;
  for (const k of keys) {
    const v = rec[k];
    if ((typeof v === "string" && v) || typeof v === "number") return String(v).slice(0, 200);
  }
  for (const v of Object.values(rec)) {
    const hit = findKey(v, keys, depth + 1);
    if (hit) return hit;
  }
  return undefined;
}

function resultBody(result: unknown): unknown {
  if (!result || typeof result !== "object") return undefined;
  const r = result as { structuredContent?: unknown; content?: Array<{ type?: string; text?: string }> };
  if (r.structuredContent && typeof r.structuredContent === "object") return r.structuredContent;
  const text = r.content?.find((c) => c?.type === "text" && typeof c.text === "string")?.text;
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** order / cart ids from the args first (what we acted on), then the reply. */
export function extractIds(args: Record<string, unknown>, result: unknown): { orderId?: string; cartId?: string } {
  const body = resultBody(result);
  return {
    orderId: findKey(args, ORDER_KEYS) ?? findKey(body, ORDER_KEYS),
    cartId: findKey(args, CART_KEYS) ?? findKey(body, CART_KEYS),
  };
}

export type AuditStatus = "ok" | "tool_error" | "auth_error" | "error";

export interface ToolAuditEvent {
  serverUrl: string;
  tool: string;
  args: Record<string, unknown>;
  token?: string | null;
  status: AuditStatus;
  error?: unknown;
  result?: unknown;
  correlationId?: string;
  durationMs?: number;
}

function serverName(url: string): string {
  try {
    return new URL(url).pathname.replace(/^\/+/, "") || url;
  } catch {
    return url.slice(0, 60);
  }
}

/** The row recordToolAudit would write (exported for tests). */
export function buildAuditRow(e: ToolAuditEvent, userId: string | null) {
  const { orderId, cartId } = extractIds(e.args, e.result);
  const errMsg = e.error instanceof Error ? e.error.message : e.error !== undefined ? String(e.error) : undefined;
  return {
    userId,
    server: serverName(e.serverUrl),
    tool: e.tool.slice(0, 80),
    argsSummary: summarizeArgs(e.args),
    status: e.status,
    // Swiggy's user-facing error text; masked if it echoes a phone/email.
    error: errMsg ? errMsg.replace(new RegExp(PHONE_OR_EMAIL, "g"), "[redacted]").slice(0, 300) : null,
    orderId: orderId ?? null,
    cartId: cartId ?? null,
    correlationId: e.correlationId ?? randomUUID(),
    durationMs: typeof e.durationMs === "number" ? Math.round(e.durationMs) : null,
  };
}

const AUDIT_TIMEOUT_MS = 1_500;

/**
 * Record one mutating tool call. No-op for read-only tools or when there is
 * no database. Never throws; waits at most ~1.5 s.
 */
export async function recordToolAudit(e: ToolAuditEvent): Promise<void> {
  if (!isMutatingTool(e.tool)) return;
  const db = getDb();
  if (!db) return;
  const write = (async () => {
    const swiggyId = swiggyUserIdFromToken(e.token);
    const userId = swiggyId ? await ensureUser(db, swiggyId) : null;
    await insertAudit(db, buildAuditRow(e, userId));
  })();
  try {
    await Promise.race([
      write,
      new Promise((_, reject) => setTimeout(() => reject(new Error("audit write timed out")), AUDIT_TIMEOUT_MS)),
    ]);
  } catch (err) {
    console.warn(`[db] audit tool=${e.tool} not recorded: ${err instanceof Error ? err.message : String(err)}`);
  }
  write.catch(() => {});
}
