// Circuit breakers: fail fast instead of making every user wait out a timeout
// against a server (Swiggy MCP) or an LLM key that is already down.
//
//   closed    → calls pass; `threshold` consecutive failures open the circuit
//   open      → calls are refused until `openUntil` (cooldown doubles on each
//               re-open, capped at `maxCooldownMs`)
//   half-open → after the cooldown calls pass again; one more failure re-opens
//               at once, a success closes it
//
// A 429 with Retry-After opens the circuit immediately for that long (capped),
// so we respect the server's rate limit instead of hammering it.
// Process-local by design: on serverless each instance learns on its own,
// which is fine for a fast-fail hint (it is never a correctness mechanism).

import { BoundedMap } from "./lru";

export interface BreakerOptions {
  /** Consecutive failures that open the circuit (default 3). */
  threshold?: number;
  /** First open period (default 15 s). */
  cooldownMs?: number;
  /** Longest open period, also the Retry-After cap (default 120 s). */
  maxCooldownMs?: number;
}

interface State {
  failures: number;
  openUntil: number;
  opens: number;
}

export type BreakerVerdict = { ok: true } | { ok: false; retryInMs: number };

export class CircuitBreaker {
  private readonly states = new BoundedMap<string, State>({ max: 1_000, ttlMs: 30 * 60_000 });
  private readonly threshold: number;
  private readonly cooldownMs: number;
  private readonly maxCooldownMs: number;

  constructor(
    readonly name: string,
    opts: BreakerOptions = {},
  ) {
    this.threshold = opts.threshold ?? 3;
    this.cooldownMs = opts.cooldownMs ?? 15_000;
    this.maxCooldownMs = opts.maxCooldownMs ?? 120_000;
  }

  /** May a call to `key` go out now? */
  check(key: string, now = Date.now()): BreakerVerdict {
    const s = this.states.get(key);
    if (!s || s.openUntil <= now) return { ok: true };
    return { ok: false, retryInMs: s.openUntil - now };
  }

  isOpen(key: string, now = Date.now()): boolean {
    return !this.check(key, now).ok;
  }

  success(key: string): void {
    if (this.states.has(key)) this.states.delete(key);
  }

  /**
   * Record a failure. `retryAfterMs` (from a 429 / 503 Retry-After) opens the
   * circuit right away for that long. Returns true when the circuit is now open.
   */
  failure(key: string, retryAfterMs?: number, now = Date.now()): boolean {
    const s = this.states.get(key) ?? { failures: 0, openUntil: 0, opens: 0 };
    s.failures++;
    let openFor = 0;
    if (retryAfterMs !== undefined && retryAfterMs > 0) {
      openFor = Math.min(retryAfterMs, this.maxCooldownMs);
    } else if (s.failures >= this.threshold) {
      openFor = Math.min(this.cooldownMs * 2 ** s.opens, this.maxCooldownMs);
    }
    if (openFor > 0) {
      s.openUntil = now + openFor;
      s.opens++;
    }
    this.states.set(key, s);
    return openFor > 0;
  }

  /** Snapshot of open circuits (for /api/ready-style diagnostics; keys only). */
  openKeys(now = Date.now()): Array<{ key: string; retryInMs: number }> {
    const out: Array<{ key: string; retryInMs: number }> = [];
    for (const [key, s] of this.states) if (s.openUntil > now) out.push({ key, retryInMs: s.openUntil - now });
    return out;
  }
}

/** Parse a Retry-After header (seconds or HTTP date) into ms. */
export function parseRetryAfter(value: string | null | undefined, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const secs = Number(value);
  if (Number.isFinite(secs) && secs >= 0) return secs * 1000;
  const at = Date.parse(value);
  return Number.isFinite(at) && at > now ? at - now : undefined;
}

/** Exponential backoff with full jitter: random in [base/2, base·2^attempt], capped. */
export function backoffMs(attempt: number, baseMs = 500, capMs = 8_000): number {
  const ceiling = Math.min(capMs, baseMs * 2 ** attempt);
  return Math.floor(ceiling / 2 + Math.random() * (ceiling / 2));
}

// Shared instances (globalThis so `next dev` hot reloads keep their state).
const g = globalThis as unknown as { __swizzoBreakers?: { mcp: CircuitBreaker; llm: CircuitBreaker } };
export const breakers = (g.__swizzoBreakers ??= {
  /** Keyed by MCP server URL (5xx / network / timeouts) or server|user (429). */
  mcp: new CircuitBreaker("swiggy-mcp", { threshold: 3, cooldownMs: 15_000 }),
  /** Keyed by provider#key (429, auth) or provider#key/model (5xx, timeouts). */
  llm: new CircuitBreaker("llm", { threshold: 2, cooldownMs: 30_000, maxCooldownMs: 300_000 }),
});
