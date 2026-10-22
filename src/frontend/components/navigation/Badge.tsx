// A small pill label. Coral for editorial flags ("NEW" / "BESTSELLER"),
// cream for quiet category tags, amber/teal for tinted accents (e.g. savings).
// Purely presentational — no client state, so it can render on the server too.

import type { ReactNode } from 'react';

export type BadgeTone = 'coral' | 'cream' | 'amber' | 'teal';

export interface BadgeProps {
  children: ReactNode;
  tone?: BadgeTone;
  className?: string;
}

const TONE: Record<BadgeTone, string> = {
  // Loud, uppercase, tracked — the only place coral shouts on a card.
  coral: 'bg-coral text-on-primary uppercase tracking-wide',
  // Quiet cream chip for category-style tags.
  cream: 'bg-surface-card text-ink',
  // Tinted accents; the on-cream *-ink tokens keep the text legible on the soft
  // fill (and lift automatically in the dark theme).
  amber: 'bg-accent-amber/20 text-amber-ink',
  teal: 'bg-accent-teal/20 text-teal-ink',
};

export function Badge({ children, tone = 'cream', className = '' }: BadgeProps) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium leading-none ${TONE[tone]} ${className}`}
    >
      {children}
    </span>
  );
}

export default Badge;
