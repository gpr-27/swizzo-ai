'use client';

// Poll a LIVE Swiggy read while (and only while) it is useful:
//  - the card is on screen (IntersectionObserver on `ref`),
//  - the browser tab is visible (paused on visibilitychange → hidden),
//  - `enabled` is true (picker open, order still active, …).
// It never overlaps calls, never polls faster than `minIntervalMs`, refreshes
// once when the card becomes visible again after a pause if the data is stale,
// and stops after `maxDurationMs` of polling. `refresh()` is the manual
// "Refresh" button (it also respects the floor, so taps can't hammer Swiggy).

import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';

export interface LivePollOptions {
  intervalMs: number;
  enabled?: boolean;
  /** a hard floor between two calls (manual refresh included); default 10 s */
  minIntervalMs?: number;
  /** stop auto-polling after this long (default 30 min); manual refresh still works */
  maxDurationMs?: number;
  /** element whose visibility gates polling; omitted = always "visible" */
  ref?: RefObject<Element | null>;
  /** run once immediately on mount (default false — the card already has data) */
  immediate?: boolean;
  /** when the data the card shows was fetched (epoch ms), for "Updated Ns ago" */
  initialUpdated?: number;
}

export interface LivePoll {
  lastUpdated: number | null;
  refreshing: boolean;
  error: string | null;
  /** auto-polling is currently running (visible + enabled + not expired) */
  live: boolean;
  refresh: () => void;
  /** milliseconds until a manual refresh is allowed again */
  cooldownMs: () => number;
}

/** `fn` returns an error message (string) on failure, or nothing on success. */
export function useLivePoll(fn: (signal: AbortSignal) => Promise<string | void>, opts: LivePollOptions): LivePoll {
  const {
    intervalMs,
    enabled = true,
    minIntervalMs = 10_000,
    maxDurationMs = 30 * 60_000,
    ref,
    immediate = false,
    initialUpdated,
  } = opts;
  const fnRef = useRef(fn);
  useEffect(() => {
    fnRef.current = fn;
  });
  const [lastUpdated, setLastUpdated] = useState<number | null>(initialUpdated ?? null);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [onScreen, setOnScreen] = useState(!ref);
  const [tabVisible, setTabVisible] = useState(true);
  const [expired, setExpired] = useState(false);
  const inFlight = useRef<AbortController | null>(null);
  const lastCall = useRef(initialUpdated ?? 0);
  const startedAt = useRef(0);

  const run = useCallback(async () => {
    if (inFlight.current) return;
    if (Date.now() - lastCall.current < minIntervalMs) return;
    const ctrl = new AbortController();
    inFlight.current = ctrl;
    lastCall.current = Date.now();
    setRefreshing(true);
    try {
      const err = await fnRef.current(ctrl.signal);
      if (ctrl.signal.aborted) return;
      if (typeof err === 'string' && err) setError(err);
      else {
        setError(null);
        setLastUpdated(Date.now());
      }
    } catch (e) {
      if (!ctrl.signal.aborted) setError(e instanceof Error && e.message ? e.message : 'Could not refresh.');
    } finally {
      if (inFlight.current === ctrl) inFlight.current = null;
      setRefreshing(false);
    }
  }, [minIntervalMs]);

  // Tab visibility.
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const on = () => setTabVisible(document.visibilityState === 'visible');
    on();
    document.addEventListener('visibilitychange', on);
    return () => document.removeEventListener('visibilitychange', on);
  }, []);

  // On-screen visibility.
  useEffect(() => {
    const el = ref?.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver((entries) => setOnScreen(entries.some((e) => e.isIntersecting)), {
      threshold: 0.05,
    });
    io.observe(el);
    return () => io.disconnect();
  }, [ref]);

  const live = enabled && onScreen && tabVisible && !expired;

  useEffect(() => {
    if (!live) return;
    if (!startedAt.current) startedAt.current = Date.now();
    // Coming back after a pause with stale data → refresh right away.
    if ((immediate && !lastCall.current) || (lastCall.current && Date.now() - lastCall.current >= intervalMs)) void run();
    const id = window.setInterval(() => {
      if (Date.now() - startedAt.current > maxDurationMs) {
        setExpired(true);
        return;
      }
      void run();
    }, Math.max(intervalMs, minIntervalMs));
    return () => window.clearInterval(id);
  }, [live, intervalMs, minIntervalMs, maxDurationMs, immediate, run]);

  // Abort an in-flight read on unmount.
  useEffect(() => () => inFlight.current?.abort(), []);

  const refresh = useCallback(() => {
    setExpired(false);
    startedAt.current = Date.now();
    void run();
  }, [run]);

  const cooldownMs = useCallback(() => Math.max(0, minIntervalMs - (Date.now() - lastCall.current)), [minIntervalMs]);

  return { lastUpdated, refreshing, error, live, refresh, cooldownMs };
}

/** Re-render every `tickMs` (for "Updated 12s ago" / countdown chips). */
export function useNow(tickMs = 1000, enabled = true): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return;
    const id = window.setInterval(() => setNow(Date.now()), tickMs);
    return () => window.clearInterval(id);
  }, [tickMs, enabled]);
  return now;
}
