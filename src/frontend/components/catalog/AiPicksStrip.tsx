'use client';

// "AI picks" strip inside the ticket / slot pickers: 2–3 concrete options ranked
// deterministically from the picker's live data (shared/picker rank*Picks), with
// the model's one-line reason when the AI read supplied one. "Book this" fills
// the whole selection and opens the picker's final review / confirm step — the
// user still taps the final Confirm.

import type { AiPick } from '@/shared/types';

export interface AiPicksStripProps {
  picks: AiPick[];
  /** pick id → the model's reason (falls back to the deterministic one) */
  reasons?: Record<string, string>;
  onBook: (pick: AiPick) => void;
  disabled?: boolean;
  tone?: 'purple' | 'coral';
}

export function AiPicksStrip({ picks, reasons, onBook, disabled, tone = 'coral' }: AiPicksStripProps) {
  if (!picks.length) return null;
  const accent =
    tone === 'purple'
      ? {
          box: 'border-purple-500/25 bg-gradient-to-b from-purple-500/10 to-purple-500/[0.03]',
          label: 'text-purple-700 dark:text-purple-300',
          tag: 'bg-purple-500/15 text-purple-700 dark:text-purple-300',
          btn: 'bg-purple-600 hover:bg-purple-700 text-white',
        }
      : {
          box: 'border-coral/25 bg-gradient-to-b from-coral/10 to-coral/[0.03]',
          label: 'text-coral',
          tag: 'bg-coral/15 text-coral',
          btn: 'bg-coral hover:bg-coral-active text-on-primary',
        };
  return (
    <div className={`rounded-2xl border p-3.5 sm:p-4 ${accent.box}`}>
      <p className={`text-[10px] font-bold uppercase tracking-wider ${accent.label}`}>
        <span aria-hidden>✦ </span>AI picks
      </p>
      <ul className="mt-2.5 space-y-2">
        {picks.map((p) => (
          <li
            key={p.id}
            className="flex flex-col gap-2 rounded-xl bg-canvas/70 p-2.5 ring-1 ring-ink/5 sm:flex-row sm:items-center sm:gap-3"
          >
            <div className="min-w-0 flex-1">
              <span className={`inline-block rounded-full px-2 py-0.5 text-[10px] font-semibold ${accent.tag}`}>{p.label}</span>
              <p className="mt-1 text-[13px] font-semibold leading-snug text-ink [overflow-wrap:anywhere]">{p.title}</p>
              <p className="mt-0.5 text-[11px] leading-snug text-muted [overflow-wrap:anywhere]">{reasons?.[p.id] || p.why}</p>
            </div>
            <button
              type="button"
              disabled={disabled}
              onClick={() => onBook(p)}
              className={`w-full shrink-0 rounded-lg px-3.5 py-2 text-xs font-semibold shadow-xs transition-colors disabled:opacity-50 sm:w-auto ${accent.btn}`}
            >
              Book this
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

export default AiPicksStrip;
