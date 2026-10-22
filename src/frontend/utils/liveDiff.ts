// What changed between two LIVE reads, so refreshed pickers can flash the
// tiles whose availability moved ("7 left" → "5 left", sold out, re-opened).
// Pure; keyed by Swiggy's own ids.

import type { DineoutSlot, ScenesShow } from '@/shared/types';

export type Change = 'down' | 'up' | 'soldout' | 'reopened' | 'new';

/** Seats left fewer-or-equal than this → "Selling fast". */
export const SELLING_FAST = 5;

function cmp(prev: number | undefined, next: number | undefined, prevOpen: boolean, nextOpen: boolean): Change | null {
  if (prevOpen && !nextOpen) return 'soldout';
  if (!prevOpen && nextOpen) return 'reopened';
  if (prev === undefined || next === undefined || prev === next) return null;
  return next < prev ? 'down' : 'up';
}

/** Changes per `show:<showId>` and `ticket:<showId>:<ticketId>` key. */
export function diffShows(prev: ScenesShow[], next: ScenesShow[]): Map<string, Change> {
  const out = new Map<string, Change>();
  const before = new Map(prev.map((s) => [s.showId, s]));
  for (const s of next) {
    const p = before.get(s.showId);
    if (!p) {
      if (prev.length) out.set(`show:${s.showId}`, 'new');
      continue;
    }
    const c = cmp(p.availableSeats, s.availableSeats, p.onSale, s.onSale);
    if (c) out.set(`show:${s.showId}`, c);
    const pt = new Map(p.tickets.map((t) => [t.ticketId, t]));
    for (const t of s.tickets) {
      const q = pt.get(t.ticketId);
      if (!q) continue;
      const tc = cmp(q.availableInventory, t.availableInventory, q.onSale, t.onSale);
      if (tc) out.set(`ticket:${s.showId}:${t.ticketId}`, tc);
    }
  }
  return out;
}

/** Changes per DineoutSlot.key (open ↔ full, and a deal's inventory when Swiggy sends one). */
export function diffSlots(prev: DineoutSlot[], next: DineoutSlot[], isOpen: (s: DineoutSlot) => boolean): Map<string, Change> {
  const out = new Map<string, Change>();
  const before = new Map(prev.map((s) => [s.key, s]));
  for (const s of next) {
    const p = before.get(s.key);
    if (!p) continue;
    const inv = (x: DineoutSlot) =>
      x.availableInventory ??
      (x.deals.some((d) => d.availableInventory !== undefined)
        ? x.deals.reduce((n, d) => n + (d.availableInventory ?? 0), 0)
        : undefined);
    const c = cmp(inv(p), inv(s), isOpen(p), isOpen(s));
    if (c) out.set(s.key, c);
  }
  return out;
}

/** One-line human summary of a diff ("2 shows changed · 1 sold out"), or "". */
export function describeChanges(changes: Map<string, Change>): string {
  if (!changes.size) return '';
  let soldout = 0;
  let down = 0;
  let up = 0;
  for (const c of changes.values()) {
    if (c === 'soldout') soldout += 1;
    else if (c === 'down') down += 1;
    else up += 1;
  }
  return [
    down ? `${down} selling` : '',
    soldout ? `${soldout} sold out` : '',
    up ? `${up} freed up` : '',
  ]
    .filter(Boolean)
    .join(' · ');
}
