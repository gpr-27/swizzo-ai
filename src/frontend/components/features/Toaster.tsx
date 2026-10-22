'use client';

// The in-app toast stack for live status changes (utils/notify.ts). Mounted
// once by the page; bottom-centre on mobile, bottom-right on desktop; each toast
// auto-dismisses after 6 s and is announced politely to screen readers.

import { useEffect, useState } from 'react';
import { onToast, type Toast } from '@/frontend/utils/notify';

const TONE: Record<NonNullable<Toast['tone']>, string> = {
  info: 'border-hairline',
  success: 'border-emerald-500/40',
  warn: 'border-amber-500/50',
  error: 'border-red-500/40',
};

const DOT: Record<NonNullable<Toast['tone']>, string> = {
  info: 'bg-coral',
  success: 'bg-emerald-500',
  warn: 'bg-amber-500',
  error: 'bg-red-500',
};

export function Toaster() {
  const [toasts, setToasts] = useState<Toast[]>([]);

  useEffect(
    () =>
      onToast((t) => {
        setToasts((prev) => [...prev.slice(-3), t]);
        window.setTimeout(() => setToasts((prev) => prev.filter((x) => x.id !== t.id)), 6000);
      }),
    [],
  );

  return (
    <div
      aria-live="polite"
      role="status"
      className="pointer-events-none fixed inset-x-0 bottom-28 z-[95] flex flex-col items-center gap-2 px-4 sm:inset-x-auto sm:right-4 sm:items-end"
    >
      {toasts.map((t) => {
        const tone = t.tone ?? 'info';
        return (
          <div
            key={t.id}
            className={`pointer-events-auto flex w-full max-w-sm items-start gap-3 rounded-2xl border bg-canvas px-4 py-3 shadow-card animate-rise ${TONE[tone]}`}
          >
            <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${DOT[tone]}`} aria-hidden />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold text-ink">{t.title}</p>
              {t.body && <p className="mt-0.5 text-xs leading-relaxed text-muted">{t.body}</p>}
            </div>
            <button
              type="button"
              onClick={() => setToasts((prev) => prev.filter((x) => x.id !== t.id))}
              aria-label="Dismiss notification"
              className="-mr-1 rounded-md p-1 text-xs text-muted hover:bg-surface-card hover:text-ink"
            >
              ✕
            </button>
          </div>
        );
      })}
    </div>
  );
}

export default Toaster;
