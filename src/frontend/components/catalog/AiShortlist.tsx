'use client';

// "AI shortlist" on top of Dineout / Scenes search results: 2–3 ranked picks
// computed from the cards already loaded (shared/aiRead rankDineoutShortlist /
// rankScenesShortlist — rating value AND count, cost for two, distance, offers,
// bank offers, perks, highlights, bookable; for events date, venue, distance,
// shows). The concierge's BEST mark leads when it made one. "Book best slot" /
// "Best show" opens the picker already filled with its top AI pick — the user
// still taps the final Confirm / Review. No Swiggy call is made to build it.

import { useMemo, useState } from 'react';
import type { DineoutRestaurant, ScenesEvent } from '@/shared/types';
import { rankDineoutShortlist, rankScenesShortlist, readNeeds, REVIEWS_NOTE, type ShortlistItem } from '@/shared/aiRead';
import { currentNeeds } from '@/frontend/state/userNeeds';
import { useDineoutNoSlots } from '@/frontend/state/dineoutAvailability';
import { DineoutDetailsSheet } from './DineoutDetailsSheet';

type Opts = { autoPick?: boolean };

function Row({
  item,
  action,
  onAction,
  onDetails,
  tone,
}: {
  item: ShortlistItem;
  action?: string;
  onAction?: () => void;
  onDetails?: () => void;
  tone: 'coral' | 'purple';
}) {
  const btn = tone === 'purple' ? 'bg-purple-600 hover:bg-purple-700 text-white' : 'bg-coral hover:bg-coral-active text-on-primary';
  return (
    <li className="flex items-center justify-between gap-3">
      <div className="min-w-0 text-xs">
        <p className="truncate font-semibold text-ink">
          <span className="text-muted">{item.label} · </span>
          {item.name}
        </p>
        <p className="truncate text-[11px] text-body">{item.line}</p>
        <p className="truncate text-[11px] text-muted">{item.why}</p>
      </div>
      <div className="flex shrink-0 gap-1.5">
        {onDetails && (
          <button
            type="button"
            onClick={onDetails}
            className="rounded-lg border border-hairline px-2.5 py-1.5 text-[11px] font-semibold text-body hover:border-cream-strong hover:text-ink"
          >
            Details
          </button>
        )}
        {action && onAction && (
          <button type="button" onClick={onAction} className={`rounded-lg px-3 py-1.5 text-[11px] font-semibold shadow-xs transition-colors ${btn}`}>
            {action}
          </button>
        )}
      </div>
    </li>
  );
}

function Frame({ tone, children, note }: { tone: 'coral' | 'purple'; children: React.ReactNode; note?: string }) {
  const box = tone === 'purple' ? 'border-purple-500/30 bg-purple-500/5' : 'border-coral/30 bg-coral/5';
  const label = tone === 'purple' ? 'text-purple-700 dark:text-purple-300' : 'text-coral';
  return (
    <div className={`mb-3 rounded-xl border p-3 ${box}`}>
      <p className={`text-[11px] font-bold uppercase tracking-wider ${label}`}>
        <span aria-hidden>✦ </span>AI shortlist
      </p>
      <ul className="mt-2 space-y-2.5">{children}</ul>
      {note && <p className="mt-2 text-[10px] text-muted-soft">{note}</p>}
    </div>
  );
}

function DineoutRow({
  item,
  restaurant,
  onViewSlots,
  onDetails,
}: {
  item: ShortlistItem;
  restaurant: DineoutRestaurant;
  onViewSlots?: (r: DineoutRestaurant, opts?: Opts) => void;
  onDetails: () => void;
}) {
  const noSlots = useDineoutNoSlots(restaurant.id);
  const canBook = restaurant.bookable !== false && !noSlots && !!onViewSlots;
  return (
    <Row
      item={item}
      tone="coral"
      onDetails={onDetails}
      action={canBook ? 'Book best slot' : undefined}
      onAction={canBook ? () => onViewSlots?.(restaurant, { autoPick: true }) : undefined}
    />
  );
}

export function DineoutShortlist({
  restaurants,
  query,
  bestPicks,
  onViewSlots,
}: {
  restaurants: DineoutRestaurant[];
  query?: string;
  bestPicks?: Record<string, string>;
  onViewSlots?: (r: DineoutRestaurant, opts?: Opts) => void;
}) {
  const [needsText] = useState(() => `${currentNeeds()} ${query ?? ''}`);
  const list = useMemo(
    () => rankDineoutShortlist(restaurants, { needs: readNeeds(needsText), bestPicks }),
    [restaurants, needsText, bestPicks],
  );
  const [open, setOpen] = useState<DineoutRestaurant | null>(null);
  if (!list.length) return null;
  const byId = new Map(restaurants.map((r) => [r.id, r]));
  return (
    <>
      <Frame tone="coral" note={`Ranked from the ${restaurants.length} results above · ${REVIEWS_NOTE}`}>
        {list.map((item) => {
          const r = byId.get(item.id);
          return r ? <DineoutRow key={item.id} item={item} restaurant={r} onViewSlots={onViewSlots} onDetails={() => setOpen(r)} /> : null;
        })}
      </Frame>
      {open && (
        <DineoutDetailsSheet
          restaurant={open}
          onClose={() => setOpen(null)}
          onReserve={
            onViewSlots && open.bookable !== false
              ? (r, opts) => {
                  setOpen(null);
                  onViewSlots(r, opts);
                }
              : undefined
          }
        />
      )}
    </>
  );
}

export function ScenesShortlist({
  events,
  bestPicks,
  onViewShows,
}: {
  events: ScenesEvent[];
  bestPicks?: Record<string, string>;
  onViewShows?: (e: ScenesEvent, opts?: Opts) => void;
}) {
  const list = useMemo(() => rankScenesShortlist(events, { bestPicks }), [events, bestPicks]);
  if (!list.length) return null;
  const key = (id: string, venueId?: string) => `${id}|${venueId ?? ''}`;
  const byId = new Map(events.map((e) => [key(e.id, e.venueId), e]));
  return (
    <Frame tone="purple" note={`Ranked from the ${events.length} events below · Swiggy Scenes data`}>
      {list.map((item) => {
        const e = byId.get(key(item.id, item.venueId));
        return e ? (
          <Row
            key={key(item.id, item.venueId)}
            item={item}
            tone="purple"
            action={onViewShows ? 'Best show' : undefined}
            onAction={onViewShows ? () => onViewShows(e, { autoPick: true }) : undefined}
          />
        ) : null;
      })}
    </Frame>
  );
}

export default DineoutShortlist;
