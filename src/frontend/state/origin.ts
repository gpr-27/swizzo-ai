// The user's selected delivery address coordinates, for "leave by" lines on
// booking cards (the trip origin). Set by the page when the address changes;
// read by any card without threading props through the chat tree. Never sent
// anywhere — only used to measure the distance to a venue Swiggy returned.

import { useSyncExternalStore } from 'react';

export interface Origin {
  lat: number;
  lng: number;
}

let origin: Origin | null = null;
const listeners = new Set<() => void>();

export function setOrigin(lat: number | undefined, lng: number | undefined): void {
  const next =
    typeof lat === 'number' && typeof lng === 'number' && Number.isFinite(lat) && Number.isFinite(lng) && lat !== 0 && lng !== 0
      ? { lat, lng }
      : null;
  if (next?.lat === origin?.lat && next?.lng === origin?.lng) return;
  origin = next;
  listeners.forEach((l) => l());
}

export function getOrigin(): Origin | null {
  return origin;
}

export function useOrigin(): Origin | null {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => origin,
    () => null,
  );
}
