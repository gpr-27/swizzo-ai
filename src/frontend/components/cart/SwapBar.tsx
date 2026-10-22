'use client';

// Floating bar above the composer when the user taps "Change" on a cart line.
// Shows the item being replaced and lets them say — in their own words — what
// they'd prefer instead ("Amul", "something cheaper", "low-fat"). The concierge
// searches for the best match and the app swaps it in (old line out, match in).

import { useState } from 'react';
import type { SwapItem } from '@/shared/types';

export interface SwapBarProps {
  item: SwapItem | null;
  busy?: boolean;
  onSwap: (text: string) => void;
  onClear: () => void;
}

export function SwapBar({ item, busy, onSwap, onClear }: SwapBarProps) {
  const [q, setQ] = useState('');
  if (!item) return null;

  const submit = () => {
    if (busy) return;
    onSwap(q.trim());
    setQ('');
  };

  return (
    <div className="mx-4 mb-2 animate-rise rounded-lg border border-coral/30 bg-surface-card/70 px-3 py-2.5 shadow-soft sm:mx-6">
      <div className="flex items-center gap-3">
        <span className="shrink-0 text-xs font-medium uppercase tracking-wide text-muted">
          Change
        </span>
        <span className="inline-flex min-w-0 flex-1 items-center gap-1.5 rounded-full border border-hairline bg-canvas py-1 pl-1 pr-2.5 text-xs text-ink">
          <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center overflow-hidden rounded-full bg-surface-soft">
            {item.imageUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img decoding="async"
                src={item.imageUrl}
                alt=""
                className="h-full w-full object-contain mix-blend-multiply"
              />
            ) : null}
          </span>
          <span className="truncate">{item.name}</span>
        </span>
        <button
          type="button"
          onClick={onClear}
          aria-label="Cancel change"
          className="shrink-0 rounded-full p-1 text-muted-soft transition-colors hover:text-ink"
        >
          <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M18 6 6 18M6 6l12 12" />
          </svg>
        </button>
      </div>

      <div className="mt-2 flex items-center gap-2">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              submit();
            }
          }}
          autoFocus
          placeholder="Change to… e.g. “Amul”, “something cheaper”, “low-fat”"
          className="coral-ring min-w-0 flex-1 rounded-md border border-hairline bg-canvas px-3 py-1.5 text-sm text-ink placeholder:text-muted-soft"
        />
        <button
          type="button"
          onClick={submit}
          disabled={busy}
          className="shrink-0 rounded-md bg-coral px-3.5 py-1.5 text-sm font-medium text-on-primary transition-colors hover:bg-coral-active disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy ? 'Swapping…' : 'Swap it'}
        </button>
      </div>
    </div>
  );
}

export default SwapBar;
