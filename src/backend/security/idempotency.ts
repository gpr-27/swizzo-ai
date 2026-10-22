// Double-submit protection for order / booking / payment routes. A key is
// (session, action, Idempotency-Key header || sha256(body)). While a request
// with that key is running, a second one gets 409 instead of a second
// place_order. A completed success — or an ambiguous outcome ("may have been
// placed") — is replayed verbatim for REPLAY_MS, so a double tap or a network
// retry never places twice. Definite failures (4xx validation, Swiggy
// rejections) release the key so the user can fix and retry.
//
// The store is pluggable like the rate limiter (memory by default).

import { createHash } from "node:crypto";

export interface StoredResponse {
  status: number;
  headers: [string, string][];
  body: string;
  until: number;
}

export interface IdempotencyStore {
  /** Atomically claim `key`. false when it is already held or a result exists. */
  claim(key: string, ttlMs: number, nowMs: number): Promise<boolean> | boolean;
  get(key: string, nowMs: number): Promise<StoredResponse | null> | StoredResponse | null;
  put(key: string, value: StoredResponse): Promise<void> | void;
  release(key: string): Promise<void> | void;
}

export class MemoryIdempotencyStore implements IdempotencyStore {
  private held = new Map<string, number>();
  private results = new Map<string, StoredResponse>();

  claim(key: string, ttlMs: number, nowMs: number): boolean {
    this.sweep(nowMs);
    if (this.results.has(key)) return false;
    const until = this.held.get(key);
    if (until && until > nowMs) return false;
    this.held.set(key, nowMs + ttlMs);
    return true;
  }
  get(key: string, nowMs: number): StoredResponse | null {
    const hit = this.results.get(key);
    return hit && hit.until > nowMs ? hit : null;
  }
  put(key: string, value: StoredResponse): void {
    this.held.delete(key);
    this.results.set(key, value);
  }
  release(key: string): void {
    this.held.delete(key);
  }
  private sweep(nowMs: number): void {
    for (const [k, until] of this.held) if (until <= nowMs) this.held.delete(k);
    for (const [k, v] of this.results) if (v.until <= nowMs) this.results.delete(k);
  }
}

const g = globalThis as unknown as { __swizzoIdemStore?: IdempotencyStore };
export function setIdempotencyStore(store: IdempotencyStore): void {
  g.__swizzoIdemStore = store;
}
function store(): IdempotencyStore {
  return (g.__swizzoIdemStore ??= new MemoryIdempotencyStore());
}

/** Longest a placement may run before its lock lapses (Swiggy calls + recovery). */
const HOLD_MS = 120_000;
const REPLAY_MS = 60_000;

export function idempotencyKey(session: string, action: string, headerKey: string | null, bodyText: string): string {
  const basis = headerKey && /^[\w.:-]{8,128}$/.test(headerKey) ? `h:${headerKey}` : `b:${bodyText}`;
  return `idem:${session}:${action}:${createHash("sha256").update(basis).digest("hex").slice(0, 32)}`;
}

/** Results worth replaying: success, or "we don't know whether it was placed". */
function replayable(status: number, body: string): boolean {
  if (status >= 200 && status < 300) return true;
  return /"(?:ambiguous|unknown)"\s*:\s*true/.test(body);
}

export function duplicateResponse(): Response {
  const message = "This order is already being processed — please wait for it to finish.";
  return Response.json(
    { ok: false, code: "duplicate_submit", error: message, message, duplicateSubmit: true },
    { status: 409, headers: { "Cache-Control": "no-store" } },
  );
}

/** Run `fn` at most once per key; concurrent duplicates get 409, recent repeats a replay. */
export async function runOnce(key: string, fn: () => Promise<Response>): Promise<Response> {
  const s = store();
  const now = Date.now();
  const prior = await s.get(key, now);
  if (prior) {
    const headers = new Headers(prior.headers);
    headers.set("Idempotent-Replay", "true");
    return new Response(prior.body, { status: prior.status, headers });
  }
  if (!(await s.claim(key, HOLD_MS, now))) return duplicateResponse();
  let res: Response;
  try {
    res = await fn();
  } catch (err) {
    await s.release(key);
    throw err;
  }
  // Streaming responses aren't buffered for replay — they're just de-duplicated while running.
  const type = res.headers.get("content-type") ?? "";
  if (!type.includes("json")) {
    await s.release(key);
    return res;
  }
  const body = await res.text();
  if (replayable(res.status, body)) {
    await s.put(key, { status: res.status, headers: [...res.headers.entries()], body, until: Date.now() + REPLAY_MS });
  } else {
    await s.release(key);
  }
  return new Response(body, { status: res.status, headers: res.headers });
}
