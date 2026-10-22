'use client';

// Dineout search results in chat: the photo cards of one message plus Swiggy's
// own paging. search_restaurants_dineout answers "Found 28 restaurant(s) …,
// showing 10. 18 more available, call again with offset=10." — the header shows
// that total, and once every loaded card is revealed the "Load more" button
// fetches the next page (GET /api/dineout/search?…&offset=) and appends it.
// Swiggy rate-limits Dineout search, so pages are fetched only on a tap.
// On top: the AI shortlist (ranked from these same cards, no extra call) with
// one-tap "Book best slot".

import { useState } from 'react';
import type { DineoutPaging, DineoutRestaurant } from '@/shared/types';
import { DineoutRestaurantCard } from './DineoutRestaurantCard';
import { DineoutShortlist } from './AiShortlist';

export interface DineoutResultsProps {
  restaurants: DineoutRestaurant[];
  paging?: DineoutPaging;
  bestPicks?: Record<string, string>;
  /** autoPick: open the slot picker already filled with its best AI pick */
  onViewSlots?: (restaurant: DineoutRestaurant, opts?: { autoPick?: boolean }) => void;
}

const STEP = 4;

export function DineoutResults({ restaurants, paging, bestPicks, onViewSlots }: DineoutResultsProps) {
  const [extra, setExtra] = useState<DineoutRestaurant[]>([]);
  // undefined = use the message's paging; null = Swiggy said there is no more
  const [nextOffset, setNextOffset] = useState<number | null | undefined>(undefined);
  const [visible, setVisible] = useState(STEP);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const ids = new Set(restaurants.map((r) => r.id));
  // The agent's BEST pick leads; otherwise Swiggy's order. Later pages follow.
  const items = [
    ...[...restaurants].sort((a, b) => Number(!!bestPicks?.[b.id]) - Number(!!bestPicks?.[a.id])),
    ...extra.filter((r) => !ids.has(r.id)),
  ];
  const shown = items.slice(0, visible);
  const hidden = items.length - shown.length;
  const offset = nextOffset === undefined ? paging?.nextOffset : nextOffset ?? undefined;
  const canFetch = !!paging && offset !== undefined;
  const total = paging?.total;
  const moreOnSwiggy = total !== undefined && canFetch ? Math.max(0, total - (offset ?? 0)) : undefined;

  const loadPage = async () => {
    if (!paging || offset === undefined) return;
    setLoading(true);
    setError('');
    try {
      const qs = new URLSearchParams({
        query: paging.query,
        lat: String(paging.latitude),
        lng: String(paging.longitude),
        offset: String(offset),
      });
      const res = await fetch(`/api/dineout/search?${qs.toString()}`);
      const json = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        message?: string;
        restaurants?: DineoutRestaurant[];
        nextOffset?: number;
      };
      if (!json.ok) {
        setError(json.message || 'Could not load more restaurants.');
        return;
      }
      const page = json.restaurants ?? [];
      setExtra((prev) => [...prev, ...page.filter((r) => !prev.some((p) => p.id === r.id))]);
      setNextOffset(typeof json.nextOffset === 'number' && json.nextOffset > offset ? json.nextOffset : null);
      setVisible((v) => v + Math.max(STEP, page.length));
    } catch {
      setError('Network error while loading more restaurants.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div>
      <DineoutShortlist restaurants={restaurants} query={paging?.query} bestPicks={bestPicks} onViewSlots={onViewSlots} />
      {total !== undefined && total > restaurants.length && (
        <p className="mb-2 text-[11px] text-muted">
          {total} restaurants on Swiggy Dineout match “{paging?.query}”
        </p>
      )}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {shown.map((r) => (
          <DineoutRestaurantCard key={r.id} restaurant={r} onViewSlots={onViewSlots} bestReason={bestPicks?.[r.id]} />
        ))}
      </div>
      {(hidden > 0 || canFetch) && (
        <div className="mt-3 flex justify-center">
          <button
            type="button"
            disabled={loading}
            onClick={() => (hidden > 0 ? setVisible((v) => v + STEP) : void loadPage())}
            className="inline-flex items-center gap-1.5 rounded-full border border-hairline bg-canvas px-4 py-2 text-sm font-medium text-ink transition-colors hover:border-cream-strong hover:bg-surface-card disabled:opacity-60"
          >
            {loading ? 'Loading…' : 'Load more'}
            {!loading && (
              <span className="text-muted-soft">
                ({hidden > 0 ? hidden : moreOnSwiggy !== undefined ? moreOnSwiggy : 'more'} more)
              </span>
            )}
            <span aria-hidden className="text-coral">↓</span>
          </button>
        </div>
      )}
      {error && <p className="mt-2 text-center text-xs text-error">{error}</p>}
    </div>
  );
}

export default DineoutResults;
