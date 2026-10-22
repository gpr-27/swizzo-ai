// Token-bucket rate limiting, per session and per client IP, to protect LLM
// spend and Swiggy's own rate limits. The default store is in-memory (correct
// per serverless instance — a warm instance serves many requests, so bursts are
// still capped). For a fleet-wide limit, call setRateLimitStore() at startup
// with a shared implementation (Redis / Postgres); the interface is one atomic
// `take`.

export interface BucketRule {
  /** Max tokens (burst). */
  capacity: number;
  /** Tokens added back per minute (sustained rate). */
  refillPerMinute: number;
}

export interface TakeResult {
  ok: boolean;
  remaining: number;
  /** When !ok: ms until `cost` tokens are available again. */
  retryAfterMs: number;
}

/** Pluggable backing store. `take` must be atomic per key. */
export interface RateLimitStore {
  take(key: string, rule: BucketRule, cost: number, nowMs: number): Promise<TakeResult> | TakeResult;
}

/* ------------------------------ memory store ------------------------------- */

export class MemoryRateLimitStore implements RateLimitStore {
  private buckets = new Map<string, { tokens: number; at: number }>();

  constructor(private readonly maxKeys = 20_000) {}

  take(key: string, rule: BucketRule, cost: number, nowMs: number): TakeResult {
    const perMs = rule.refillPerMinute / 60_000;
    const prev = this.buckets.get(key);
    let tokens = prev ? Math.min(rule.capacity, prev.tokens + (nowMs - prev.at) * perMs) : rule.capacity;
    const ok = tokens >= cost;
    if (ok) tokens -= cost;
    // refresh insertion order (LRU) and bound memory
    this.buckets.delete(key);
    this.buckets.set(key, { tokens, at: nowMs });
    if (this.buckets.size > this.maxKeys) {
      const oldest = this.buckets.keys().next().value;
      if (oldest !== undefined) this.buckets.delete(oldest);
    }
    const retryAfterMs = ok ? 0 : perMs > 0 ? Math.ceil((cost - tokens) / perMs) : 60_000;
    return { ok, remaining: Math.floor(tokens), retryAfterMs };
  }

  /** Test helper. */
  reset(): void {
    this.buckets.clear();
  }
}

const g = globalThis as unknown as { __swizzoRateStore?: RateLimitStore };

export function setRateLimitStore(store: RateLimitStore): void {
  g.__swizzoRateStore = store;
}

export function rateLimitStore(): RateLimitStore {
  return (g.__swizzoRateStore ??= new MemoryRateLimitStore());
}

/* --------------------------------- policies -------------------------------- */

/**
 * Named policies. Each has a per-session and a per-IP bucket; a request must
 * pass both. Numbers are generous for one human using the UI and tight for a
 * script. Override any of them with env RATE_LIMIT_<NAME>="cap/perMin[,ipCap/ipPerMin]".
 */
export const RATE_POLICIES = {
  /** POST /api/chat — a full LLM turn with tools. */
  chat: { session: { capacity: 20, refillPerMinute: 10 }, ip: { capacity: 40, refillPerMinute: 20 } },
  /** One-shot LLM reads: ai-read, briefing, food-ai, instamart note/basket, history insights. */
  ai: { session: { capacity: 40, refillPerMinute: 30 }, ip: { capacity: 80, refillPerMinute: 60 } },
  /** Cart / address / report mutations (UI coalesces taps). */
  mutate: { session: { capacity: 60, refillPerMinute: 60 }, ip: { capacity: 120, refillPerMinute: 120 } },
  /** Order placement, bookings, payment confirm, deal / ticket carts. */
  order: { session: { capacity: 10, refillPerMinute: 6 }, ip: { capacity: 20, refillPerMinute: 12 } },
  /** Swiggy read routes (search, menus, slots, status polls). */
  read: { session: { capacity: 120, refillPerMinute: 120 }, ip: { capacity: 240, refillPerMinute: 240 } },
  /** OAuth login / callback (per IP only; there is no session yet). */
  auth: { session: { capacity: 20, refillPerMinute: 10 }, ip: { capacity: 20, refillPerMinute: 10 } },
} satisfies Record<string, { session: BucketRule; ip: BucketRule }>;

export type RatePolicy = keyof typeof RATE_POLICIES;

function parseRule(spec: string | undefined): BucketRule | undefined {
  const m = spec?.trim().match(/^(\d+)\/(\d+)$/);
  return m ? { capacity: Number(m[1]), refillPerMinute: Number(m[2]) } : undefined;
}

export function policyRules(name: RatePolicy): { session: BucketRule; ip: BucketRule } {
  const base = RATE_POLICIES[name];
  const env = process.env[`RATE_LIMIT_${name.toUpperCase()}`];
  if (!env) return base;
  const [s, ip] = env.split(",");
  return { session: parseRule(s) ?? base.session, ip: parseRule(ip) ?? base.ip };
}

export function rateLimitDisabled(): boolean {
  return process.env.RATE_LIMIT_DISABLED === "true" && process.env.NODE_ENV !== "production";
}

/**
 * Take one token from `policy` for this IP (and session, when known).
 * Returns null when allowed, else the retry-after in ms.
 */
export async function consumeRateLimit(
  policy: RatePolicy,
  ids: { ip: string; session?: string | null },
  cost = 1,
): Promise<number | null> {
  if (rateLimitDisabled()) return null;
  const rules = policyRules(policy);
  const store = rateLimitStore();
  const now = Date.now();
  const ipRes = await store.take(`rl:${policy}:ip:${ids.ip}`, rules.ip, cost, now);
  if (!ipRes.ok) return ipRes.retryAfterMs;
  if (ids.session) {
    const sRes = await store.take(`rl:${policy}:s:${ids.session}`, rules.session, cost, now);
    if (!sRes.ok) return sRes.retryAfterMs;
  }
  return null;
}
