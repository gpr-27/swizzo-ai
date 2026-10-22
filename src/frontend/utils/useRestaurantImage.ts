'use client';

// Lazily backfill the OFFICIAL Swiggy photo for a restaurant card that arrived
// without one (or whose image failed to load): GET /api/images/restaurant.
// Only cards that are on screen ask; results are memoised per tab; Dineout
// lookups run one at a time and pause for 60 s after a 429 (Dineout is
// rate-limited), Food lookups run two at a time. No photo → null (the card
// keeps its neutral monogram tile — never a stock image).

import { useEffect, useState, type RefObject } from 'react';
import { getFoodAddressId } from '@/frontend/state/foodAddress';

export type ImageKind = 'dineout' | 'food';

export interface RestaurantImageRequest {
  kind: ImageKind;
  id: string;
  lat?: number; // Dineout: the coordinates the restaurant was searched with
  lng?: number;
  addressId?: string; // Food: the delivery address (defaults to the Food tab's)
}

export interface RestaurantImage {
  imageUrl: string;
  images?: string[];
  source?: string;
}

const memo = new Map<string, RestaurantImage | null>();
const pending = new Map<string, Promise<RestaurantImage | null>>();
const queues: Record<ImageKind, { running: number; max: number; waiting: (() => void)[]; pausedUntil: number }> = {
  dineout: { running: 0, max: 1, waiting: [], pausedUntil: 0 },
  food: { running: 0, max: 2, waiting: [], pausedUntil: 0 },
};

function memoKey(r: RestaurantImageRequest): string {
  return `${r.kind}|${r.id}`;
}

async function slot(kind: ImageKind): Promise<() => void> {
  const q = queues[kind];
  while (q.running >= q.max || Date.now() < q.pausedUntil) {
    if (Date.now() < q.pausedUntil) await new Promise((r) => setTimeout(r, q.pausedUntil - Date.now()));
    else await new Promise<void>((r) => q.waiting.push(r));
  }
  q.running += 1;
  return () => {
    q.running -= 1;
    q.waiting.shift()?.();
  };
}

/** One lookup (memoised + de-duplicated). Exported for non-hook callers. */
export function fetchRestaurantImage(r: RestaurantImageRequest): Promise<RestaurantImage | null> {
  const key = memoKey(r);
  if (memo.has(key)) return Promise.resolve(memo.get(key) ?? null);
  const inflight = pending.get(key);
  if (inflight) return inflight;
  const p = (async () => {
    const qs = new URLSearchParams({ kind: r.kind, id: r.id });
    if (r.kind === 'dineout') {
      if (typeof r.lat !== 'number' || typeof r.lng !== 'number') return null;
      qs.set('lat', String(r.lat));
      qs.set('lng', String(r.lng));
    } else {
      const addressId = r.addressId || getFoodAddressId();
      if (!addressId) return null;
      qs.set('addressId', addressId);
    }
    const release = await slot(r.kind);
    try {
      const res = await fetch(`/api/images/restaurant?${qs.toString()}`);
      if (res.status === 429) {
        queues[r.kind].pausedUntil = Date.now() + 60_000;
        return null; // not memoised: a later render may retry
      }
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean; imageUrl?: string | null; images?: string[]; source?: string };
      const out = data.ok && data.imageUrl ? { imageUrl: data.imageUrl, images: data.images, source: data.source } : null;
      if (res.ok) memo.set(key, out);
      return out;
    } catch {
      return null;
    } finally {
      release();
    }
  })();
  pending.set(key, p);
  void p.finally(() => pending.delete(key));
  return p;
}

/**
 * `needed` = the card has no usable image right now. Returns the backfilled
 * image once found (null while loading / when Swiggy has none).
 */
export function useRestaurantImage(
  req: RestaurantImageRequest | null,
  needed: boolean,
  ref?: RefObject<Element | null>,
): RestaurantImage | null {
  const key = req ? memoKey(req) : '';
  const [found, setFound] = useState<{ key: string; img: RestaurantImage | null }>(() => ({
    key,
    img: key ? (memo.get(key) ?? null) : null,
  }));
  const [visible, setVisible] = useState(!ref);

  useEffect(() => {
    const el = ref?.current;
    if (!el || !needed || typeof IntersectionObserver === 'undefined') {
      if (!el && ref) setVisible(true);
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setVisible(true);
          io.disconnect();
        }
      },
      { rootMargin: '200px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [ref, needed]);

  const reqJson = req ? JSON.stringify(req) : '';
  useEffect(() => {
    if (!needed || !visible || !reqJson) return;
    let cancelled = false;
    const r = JSON.parse(reqJson) as RestaurantImageRequest;
    void fetchRestaurantImage(r).then((img) => {
      if (!cancelled) setFound({ key: memoKey(r), img });
    });
    return () => {
      cancelled = true;
    };
  }, [needed, visible, reqJson]);

  return found.key === key ? found.img : null;
}
