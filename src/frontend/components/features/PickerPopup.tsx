'use client';

// Ticket / slot pickers are long (AI read, AI picks, dates, shows, tiers…), so in
// the chat they show as ONE short card; tapping it opens the picker in a popup.
// The picker itself stays mounted the whole time — it keeps polling live seats
// and answering chat selections (pickerBridge) — and the popup just shows or
// hides it. Chat selections / "Book best" / a card tap open it via the bridge.

import { useEffect, useRef, useState } from 'react';
import { useDialogA11y } from '@/frontend/hooks/useDialogA11y';
import { watchPickerOpen } from '@/frontend/utils/pickerBridge';

export interface PickerPopupProps {
  messageId: string;
  title: string;
  /** one line under the title (venue · dates …) */
  subtitle?: string;
  /** what the card's button says */
  cta: string;
  emoji?: string;
  children: React.ReactNode;
}

export function PickerPopup({ messageId, title, subtitle, cta, emoji = '🎟️', children }: PickerPopupProps) {
  const [open, setOpen] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  useDialogA11y(open, panelRef, () => setOpen(false));

  useEffect(() => {
    const w = watchPickerOpen(messageId, () => setOpen(true));
    if (w.waiting) queueMicrotask(() => setOpen(true));
    return w.stop;
  }, [messageId]);

  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open]);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        className="flex w-full max-w-lg items-center gap-3 rounded-2xl border border-hairline bg-surface-card/60 p-3 text-left transition-colors hover:border-coral/40"
      >
        <span aria-hidden className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-purple-500/10 text-xl">
          {emoji}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-semibold text-ink">{title}</span>
          {subtitle && <span className="block truncate text-xs text-muted">{subtitle}</span>}
        </span>
        <span className="shrink-0 rounded-full bg-coral px-3.5 py-1.5 text-xs font-semibold text-on-primary">{cta}</span>
      </button>

      <div
        className={open ? 'fixed inset-0 z-40 flex items-end justify-center sm:items-center sm:p-4' : 'hidden'}
        role="presentation"
      >
        <button
          type="button"
          aria-label="Close"
          tabIndex={-1}
          onClick={() => setOpen(false)}
          className="absolute inset-0 bg-black/50 backdrop-blur-[2px]"
        />
        <div
          ref={panelRef}
          role="dialog"
          aria-modal="true"
          aria-label={title}
          className="relative flex max-h-[92dvh] w-full max-w-lg animate-rise flex-col overflow-hidden rounded-t-3xl border border-hairline bg-canvas shadow-card sm:rounded-3xl"
        >
          <div className="flex shrink-0 items-center justify-between gap-3 px-4 pb-1 pt-3">
            <span className="min-w-0 truncate text-sm font-semibold text-ink">{title}</span>
            <button
              type="button"
              onClick={() => setOpen(false)}
              aria-label="Close"
              className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-hairline bg-surface-card/70 text-body hover:border-coral/50 hover:text-ink"
            >
              <span aria-hidden>✕</span>
            </button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:px-3">{children}</div>
        </div>
      </div>
    </>
  );
}

export default PickerPopup;
