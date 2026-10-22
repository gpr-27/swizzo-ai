'use client';

// Fetches Instamart go-to items (+ optional Food reorder cards) for the board.

import { useCallback, useEffect, useState } from 'react';
import type { FoodRestaurant, Product } from '@/shared/types';

export type UsualBadge = 'due' | 'again';

export interface UsualLine {
  product: Product;
  badge: UsualBadge;
  spinId: string;
  /** false when nothing is in stock at this address (shown, not preselected). */
  inStock?: boolean;
  /** why the AI picked this pack (₹/unit, rating, ETA) */
  pickReason?: string;
  packCount?: number;
  lastOrdered?: string;
}

/** The AI briefing over the board: deterministic text first, AI words when they land. */
export interface UsualsBriefing {
  text: string;
  facts: string[];
  ai?: { text: string; model: string };
}

export type UsualsStatus = 'idle' | 'loading' | 'ready' | 'empty' | 'error';

interface UsualsResult {
  status: UsualsStatus;
  items: UsualLine[];
  label: 'again' | 'mixed';
  foodUsual: FoodRestaurant[];
  briefing?: UsualsBriefing;
}

/** One fetch of the board's data (no React state — the hook stores the result). */
async function fetchUsuals(addressId: string, signal: AbortSignal): Promise<UsualsResult> {
  try {
    const [usualsRes, foodRes] = await Promise.all([
      fetch(`/api/usuals?addressId=${encodeURIComponent(addressId)}`, { signal }),
      fetch(`/api/food-usuals?addressId=${encodeURIComponent(addressId)}`, { signal }),
    ]);
    if (usualsRes.status === 401) {
      return { status: 'error', items: [], label: 'again', foodUsual: [] };
    }
    const usualsData = usualsRes.ok
      ? ((await usualsRes.json()) as {
          items?: UsualLine[];
          label?: 'again' | 'mixed';
          briefing?: UsualsBriefing;
        })
      : { items: [], label: 'again' as const };
    const foodData = foodRes.ok
      ? ((await foodRes.json()) as { restaurants?: FoodRestaurant[] })
      : { restaurants: [] };

    const list = Array.isArray(usualsData.items) ? usualsData.items : [];
    return {
      status: list.length ? 'ready' : 'empty',
      items: list,
      label: usualsData.label === 'mixed' ? 'mixed' : 'again',
      foodUsual: Array.isArray(foodData.restaurants) ? foodData.restaurants : [],
      ...('briefing' in usualsData && usualsData.briefing?.text ? { briefing: usualsData.briefing } : {}),
    };
  } catch {
    return { status: 'error', items: [], label: 'again', foodUsual: [] };
  }
}

export function useUsuals(addressId: string, enabled: boolean) {
  // `idle` / `loading` are DERIVED from the request key (not set in the effect
  // body), so the effect only writes state from its async callback.
  const [nonce, setNonce] = useState(0);
  const key = enabled && addressId ? `${addressId}#${nonce}` : '';
  const [result, setResult] = useState<(UsualsResult & { key: string }) | null>(null);

  useEffect(() => {
    if (!key) return;
    const ac = new AbortController();
    void fetchUsuals(addressId, ac.signal).then(async (r) => {
      if (ac.signal.aborted) return;
      setResult({ ...r, key });
      // AI briefing over the real facts (keeps the deterministic line on failure).
      const b = r.briefing;
      if (!b?.facts.length) return;
      try {
        const res = await fetch('/api/instamart/note', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ kind: 'briefing', facts: b.facts }),
          signal: ac.signal,
        });
        const ai = (await res.json()) as { text?: string | null; model?: string };
        if (!ac.signal.aborted && ai.text) {
          setResult((prev) =>
            prev && prev.key === key && prev.briefing
              ? { ...prev, briefing: { ...prev.briefing, ai: { text: ai.text as string, model: ai.model ?? 'AI' } } }
              : prev,
          );
        }
      } catch {
        /* keep the deterministic briefing */
      }
    });
    return () => ac.abort();
  }, [key, addressId]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);
  const fresh = result && result.key === key ? result : null;
  const status: UsualsStatus = !key ? 'idle' : (fresh?.status ?? 'loading');

  return {
    status,
    items: fresh?.items ?? [],
    label: fresh?.label ?? 'again',
    foodUsual: fresh?.foodUsual ?? [],
    briefing: fresh?.briefing,
    reload,
  };
}
