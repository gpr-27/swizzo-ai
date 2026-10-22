'use client';

// "● LIVE · Updated 12s ago · ↻ Refresh" — the status line for a card that
// re-reads Swiggy while open. The dot pulses while auto-refresh is running and
// goes grey when paused (tab hidden / scrolled away / expired).

import { formatAgo } from '@/frontend/utils/time';
import { useNow } from '@/frontend/utils/useLivePoll';

export interface LiveStampProps {
  lastUpdated: number | null;
  live: boolean;
  refreshing: boolean;
  onRefresh: () => void;
  /** "every 45 s" — shown in the tooltip */
  cadence?: string;
  error?: string | null;
  className?: string;
}

export function LiveStamp({ lastUpdated, live, refreshing, onRefresh, cadence, error, className = '' }: LiveStampProps) {
  const now = useNow(5000);
  return (
    <div className={`flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted ${className}`}>
      <span
        className="inline-flex items-center gap-1.5 font-semibold uppercase tracking-wider"
        title={live ? `Auto-refreshing${cadence ? ` ${cadence}` : ''} while this is on screen` : 'Auto-refresh paused'}
      >
        <span className="relative flex h-2 w-2" aria-hidden>
          {live && <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-500 opacity-60" />}
          <span className={`relative inline-flex h-2 w-2 rounded-full ${live ? 'bg-emerald-500' : 'bg-muted-soft'}`} />
        </span>
        <span className={live ? 'text-emerald-700 dark:text-emerald-400' : ''}>{live ? 'Live' : 'Paused'}</span>
      </span>
      {lastUpdated && <span aria-live="off">· Updated {formatAgo(lastUpdated, now)}</span>}
      <button
        type="button"
        onClick={onRefresh}
        disabled={refreshing}
        className="inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 font-semibold text-coral hover:bg-coral/10 disabled:opacity-60"
        aria-label="Refresh availability now"
      >
        <span aria-hidden className={refreshing ? 'inline-block animate-spin' : ''}>
          ↻
        </span>
        {refreshing ? 'Checking…' : 'Refresh'}
      </button>
      {error && <span className="text-red-700 dark:text-red-400">· {error}</span>}
    </div>
  );
}

export default LiveStamp;
