'use client';

// Floating bar above the composer when products/dishes are selected to compare.
// Shows the picks, lets you TYPE a question about them (e.g. "which is healthier?"),
// and a coral CTA — the concierge answers as a neat comparison table + verdict.
// An empty question falls back to "which is best?".

import { useState } from 'react';
import type { CompareItem } from '@/shared/types';

export interface CompareBarProps {
  items: CompareItem[];
  onCompare: (question?: string) => void;
  onClear: () => void;
  // a turn is streaming — disable "Ask" so the compare turn can't double-fire
  busy?: boolean;
}

export function CompareBar({ items, onCompare, onClear, busy }: CompareBarProps) {
  const [q, setQ] = useState('');
  if (items.length === 0) return null;

  const submit = () => {
    if (busy) return; // already streaming — ignore until the current turn ends
    onCompare(q.trim() || undefined);
    setQ('');
  };

  return (
    <div
      role="region"
      aria-label={`Compare ${items.length} selected ${items.length === 1 ? 'item' : 'items'}`}
      className="mx-4 mb-2 animate-rise rounded-lg border border-coral/30 bg-surface-card/70 px-3 py-2.5 shadow-soft sm:mx-6"
    >
      {/* Selected items */}
      <div className="flex items-center gap-3">
        <span className="shrink-0 text-xs font-medium uppercase tracking-wide text-muted">
          Compare {items.length}
        </span>
        <div className="flex min-w-0 flex-1 items-center gap-2 overflow-x-auto">
          {items.map((it) => (
            <span
              key={it.spinId}
              className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-hairline bg-canvas py-1 pl-1 pr-2 text-xs text-ink"
            >
              <span className="inline-flex h-5 w-5 items-center justify-center overflow-hidden rounded-full bg-surface-soft">
                {it.imageUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img decoding="async"
                    src={it.imageUrl}
                    alt=""
                    className="h-full w-full object-contain mix-blend-multiply"
                  />
                ) : null}
              </span>
              <span className="max-w-[8rem] truncate">{it.name}</span>
            </span>
          ))}
        </div>
        <button
          type="button"
          onClick={onClear}
          aria-label="Clear comparison"
          className="shrink-0 rounded-full p-1 text-muted-soft transition-colors hover:text-ink"
        >
          <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M18 6 6 18M6 6l12 12" />
          </svg>
        </button>
      </div>

      {/* Ask a question about the selection (optional) */}
      <div className="mt-2 flex items-center gap-2">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing) return;
            if (e.key === 'Enter') {
              e.preventDefault();
              submit();
            }
          }}
          placeholder={
            items.length === 1
              ? 'Ask about this — e.g. “is it healthy?”'
              : 'Ask about these — e.g. “which is healthier?” (or just compare)'
          }
          aria-label="Question about the selected items"
          enterKeyHint="send"
          className="coral-ring min-w-0 flex-1 rounded-md border border-hairline bg-canvas px-3 py-1.5 text-sm text-ink placeholder:text-muted-soft"
        />
        <button
          type="button"
          onClick={submit}
          disabled={busy}
          className="shrink-0 rounded-md bg-coral px-3.5 py-1.5 text-sm font-medium text-on-primary transition-colors hover:bg-coral-active disabled:cursor-not-allowed disabled:bg-coral-disabled disabled:text-muted-soft"
        >
          {busy
            ? 'Comparing…'
            : q.trim()
              ? 'Ask'
              : items.length === 1
                ? 'Is it good?'
                : 'Which is best?'}
        </button>
      </div>
    </div>
  );
}

export default CompareBar;
