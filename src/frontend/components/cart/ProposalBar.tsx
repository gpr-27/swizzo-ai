'use client';

// A sticky, always-visible bar pinned above the composer whenever the agent has
// proposed cart picks awaiting approval. It guarantees the user notices the
// "Approve to add" suggestion even if they've scrolled away from the message it
// belongs to — and lets them Add all / Dismiss in one tap without scrolling back.

export interface ProposalBarProps {
  count: number;
  onAddAll: () => void;
  onDismissAll: () => void;
}

export function ProposalBar({ count, onAddAll, onDismissAll }: ProposalBarProps) {
  if (count <= 0) return null;
  return (
    <div className="shrink-0 border-t border-coral/30 bg-coral/[0.06] px-4 py-2.5 sm:px-6">
      <div className="mx-auto flex max-w-2xl items-center gap-3">
        <span className="flex min-w-0 items-center gap-1.5 text-sm text-ink">
          <span className="text-coral" aria-hidden="true">
            ✦
          </span>
          <span className="truncate">
            {count} {count === 1 ? 'pick' : 'picks'} ready to add to your cart
          </span>
        </span>
        <div className="ml-auto flex shrink-0 items-center gap-2">
          <button
            type="button"
            onClick={onDismissAll}
            className="rounded-full px-3 py-1.5 text-xs text-muted transition-colors hover:text-ink"
          >
            Dismiss
          </button>
          <button
            type="button"
            onClick={onAddAll}
            className="rounded-full bg-coral px-4 py-1.5 text-xs font-medium text-on-primary transition-colors hover:bg-coral-active"
          >
            Add {count === 1 ? 'it' : 'all'}
          </button>
        </div>
      </div>
    </div>
  );
}

export default ProposalBar;
