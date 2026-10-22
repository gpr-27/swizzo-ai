'use client';

// One popup for "everything about this card": a bottom sheet on phones, a
// centred dialog from sm up. Cards stay short; tapping one opens this with the
// AI read / picks, pack sizes and the rest. Closes with ✕, Esc or a tap outside.

import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useDialogA11y } from '@/frontend/hooks/useDialogA11y';

export interface DetailSheetProps {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  /** pinned under the scrolling body (price + Add, confirm, …) */
  footer?: React.ReactNode;
}

export function DetailSheet({ title, onClose, children, footer }: DetailSheetProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  useDialogA11y(true, panelRef, onClose);

  // keep the page behind from scrolling while the sheet is open
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  if (typeof document === 'undefined') return null;
  return createPortal(
    <div className="fixed inset-0 z-[80] flex items-end justify-center sm:items-center sm:p-4" role="presentation">
      <button
        type="button"
        aria-label="Close details"
        tabIndex={-1}
        onClick={onClose}
        className="absolute inset-0 bg-black/50 backdrop-blur-[2px]"
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="relative flex max-h-[90dvh] w-full max-w-lg animate-rise flex-col overflow-hidden rounded-t-3xl border border-hairline bg-canvas shadow-card sm:rounded-3xl"
      >
        <div className="flex shrink-0 items-center justify-between gap-3 px-4 pb-1 pt-3 sm:px-5">
          <span aria-hidden className="absolute left-1/2 top-2 h-1 w-10 -translate-x-1/2 rounded-full bg-hairline sm:hidden" />
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="ml-auto inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-hairline bg-surface-card/70 text-body hover:border-coral/50 hover:text-ink"
          >
            <span aria-hidden>✕</span>
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4 sm:px-5">{children}</div>
        {footer && (
          <div className="shrink-0 border-t border-hairline bg-canvas px-4 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-3 sm:px-5">
            {footer}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}

export default DetailSheet;
