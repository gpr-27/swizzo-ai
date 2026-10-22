'use client';

// Shows messages the user queued by clicking more options while the concierge
// was still answering. They fire one after another; each pill reveals a cancel
// (×) on hover so a waiting message can be pulled back before it's sent.

export interface MessageQueueProps {
  items: { qid: string; label: string }[];
  onCancel: (qid: string) => void;
}

export function MessageQueue({ items, onCancel }: MessageQueueProps) {
  if (items.length === 0) return null;

  return (
    <div
      className="mx-4 mb-2 flex flex-wrap items-center gap-2 sm:mx-6"
      role="status"
      aria-live="polite"
    >
      <span className="inline-flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-soft">
        <span className="relative flex h-1.5 w-1.5">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-coral/60" />
          <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-coral" />
        </span>
        Queued
      </span>
      {items.map((it, i) => (
        <span
          key={it.qid}
          className="group inline-flex max-w-[14rem] items-center gap-1.5 rounded-full border border-hairline bg-surface-card/60 py-1 pl-2.5 pr-1.5 text-xs text-muted"
          title={it.label}
        >
          <span className="text-[10px] tabular-nums text-muted-soft">{i + 1}</span>
          <span className="min-w-0 truncate">{it.label}</span>
          <button
            type="button"
            onClick={() => onCancel(it.qid)}
            aria-label={`Cancel queued: ${it.label}`}
            // Always visible on touch (no hover there); hover-revealed from sm up.
            className="-my-1 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-muted-soft transition-opacity hover:bg-hairline hover:text-ink focus-visible:opacity-100 sm:h-5 sm:w-5 sm:opacity-0 sm:group-hover:opacity-100"
          >
            <svg viewBox="0 0 24 24" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </button>
        </span>
      ))}
    </div>
  );
}

export default MessageQueue;
