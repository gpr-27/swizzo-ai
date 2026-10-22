'use client';

// Per-tab memory of Dineout restaurants whose live get_available_slots came back
// with ZERO slots — Swiggy lists them but takes no table bookings (typically
// partnerType "NPR"). Cards read it so a failed "Reserve" turns into the same
// honest "Walk-in only" badge instead of offering the button again.

import { useSyncExternalStore } from 'react';

const noSlots = new Set<string>();
const listeners = new Set<() => void>();

export function markDineoutNoSlots(restaurantId: string): void {
  if (noSlots.has(restaurantId)) return;
  noSlots.add(restaurantId);
  for (const l of listeners) l();
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** true once a slot fetch for this restaurant returned no bookable slots. */
export function useDineoutNoSlots(restaurantId: string): boolean {
  return useSyncExternalStore(
    subscribe,
    () => noSlots.has(restaurantId),
    () => false,
  );
}

/** Shown wherever "Reserve" would be for a restaurant Swiggy takes no bookings for. */
export const DINEOUT_WALK_IN_LABEL = 'Walk-in only — no table booking on Swiggy';
