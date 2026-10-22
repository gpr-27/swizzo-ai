'use client';

// Shows the first N items of a list with a "Load more" button that reveals more
// in steps — the same progressive pattern as the Instamart product grid, so Food
// and Dineout results don't dump everything at once.

import { useState, type ReactNode } from 'react';

interface RevealListProps<T> {
  items: T[];
  initial?: number;
  step?: number;
  className?: string; // applied to the items container (e.g. a grid)
  children: (item: T, index: number) => ReactNode;
  label?: string; // optional header above the list
}

export function RevealList<T>({
  items,
  initial = 4,
  step = 4,
  className,
  children,
  label,
}: RevealListProps<T>) {
  const [visible, setVisible] = useState(initial);
  const shown = items.slice(0, visible);
  const remaining = items.length - shown.length;

  return (
    <div>
      {label && (
        <h3 className="mb-2.5 font-display text-lg text-ink">{label}</h3>
      )}
      <div className={className}>
        {shown.map((item, i) => children(item, i))}
      </div>
      {remaining > 0 && (
        <div className="mt-3 flex justify-center">
          <button
            type="button"
            onClick={() => setVisible((v) => v + step)}
            className="inline-flex items-center gap-1.5 rounded-full border border-hairline bg-canvas px-4 py-2 text-sm font-medium text-ink transition-colors hover:border-cream-strong hover:bg-surface-card"
          >
            Load more
            <span className="text-muted-soft">({remaining} more)</span>
            <span aria-hidden className="text-coral">↓</span>
          </button>
        </div>
      )}
    </div>
  );
}

export default RevealList;
