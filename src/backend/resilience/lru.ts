// A drop-in bounded Map for module-level caches: least-recently-used eviction
// past `max` entries, optional TTL (expired entries read as absent and are
// removed), and an `onEvict` hook (e.g. close an MCP client). Server processes
// live for hours on Vercel Fluid compute and in `next dev`, so every
// process-wide cache must be bounded — an unbounded Map keyed by user / query
// grows until the process runs out of memory.

export interface BoundedMapOptions<K, V> {
  /** Maximum number of entries; the least recently used is evicted beyond it. */
  max: number;
  /** Entries older than this (since last `set`) read as missing. */
  ttlMs?: number;
  /** Called for entries evicted by size or TTL (not for explicit delete/clear). */
  onEvict?: (key: K, value: V) => void;
}

export class BoundedMap<K, V> extends Map<K, V> {
  private readonly max: number;
  private readonly ttlMs?: number;
  private readonly onEvict?: (key: K, value: V) => void;
  private readonly stamps = new Map<K, number>();

  constructor(opts: BoundedMapOptions<K, V>) {
    super();
    this.max = Math.max(1, Math.floor(opts.max));
    this.ttlMs = opts.ttlMs;
    this.onEvict = opts.onEvict;
  }

  private expired(key: K, now = Date.now()): boolean {
    if (!this.ttlMs) return false;
    const at = this.stamps.get(key);
    return at !== undefined && now - at > this.ttlMs;
  }

  private evict(key: K): void {
    const value = super.get(key) as V;
    super.delete(key);
    this.stamps.delete(key);
    try {
      this.onEvict?.(key, value);
    } catch {
      // eviction hooks are best-effort
    }
  }

  override get(key: K): V | undefined {
    if (!super.has(key)) return undefined;
    if (this.expired(key)) {
      this.evict(key);
      return undefined;
    }
    // Refresh recency without touching the TTL stamp.
    const value = super.get(key) as V;
    super.delete(key);
    super.set(key, value);
    return value;
  }

  override has(key: K): boolean {
    if (!super.has(key)) return false;
    if (this.expired(key)) {
      this.evict(key);
      return false;
    }
    return true;
  }

  override set(key: K, value: V): this {
    // `stamps` is undefined while Map's constructor runs (no initial entries are passed).
    if (!this.stamps) return super.set(key, value);
    if (super.has(key)) super.delete(key);
    super.set(key, value);
    this.stamps.set(key, Date.now());
    while (super.size > this.max) {
      const oldest = super.keys().next().value as K;
      this.evict(oldest);
    }
    return this;
  }

  override delete(key: K): boolean {
    this.stamps.delete(key);
    return super.delete(key);
  }

  override clear(): void {
    this.stamps.clear();
    super.clear();
  }

  /** Drop every expired entry now (iteration otherwise still yields them). */
  prune(): void {
    if (!this.ttlMs) return;
    const now = Date.now();
    for (const key of [...super.keys()]) if (this.expired(key, now)) this.evict(key);
  }
}
