'use client';

// The proactive briefing card on an empty tab: the AI's one-glance line (or
// the deterministic headline until/unless the AI phrasing is available), live
// status lines for active orders / bookings, and three chips tailored to the
// tab and the meal time. Every fact comes from the user's real Swiggy data.

import type { HomeBriefingData } from '@/frontend/hooks/useHomeBriefing';

export interface HomeBriefingProps {
  data: HomeBriefingData;
  onPick: (text: string, displayText?: string) => void;
  /** 'strip' = compact, left-aligned (above the Instamart usuals board) */
  variant?: 'hero' | 'strip';
  /** chips are rendered by the caller (EmptyState) — show only the text part */
  hideChips?: boolean;
}

export function HomeBriefing({ data, onPick, variant = 'hero', hideChips }: HomeBriefingProps) {
  const { briefing, ai } = data;
  const text = ai?.text || [briefing.greeting, briefing.headline].filter(Boolean).join(' — ');
  const strip = variant === 'strip';
  return (
    <section
      aria-label="Your briefing"
      className={`animate-rise rounded-2xl border border-coral/25 bg-gradient-to-br from-coral/[0.07] to-amber-500/[0.04] text-left shadow-xs ${
        strip ? 'mx-4 mt-4 p-3.5 sm:mx-6' : 'w-full max-w-lg p-4'
      }`}
    >
      <div className="flex items-start gap-2.5">
        <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-coral/15 text-xs text-coral" aria-hidden="true">
          ✦
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm leading-relaxed text-ink">{text}</p>
          {briefing.lines.length > 0 && (
            <ul className="mt-1.5 space-y-0.5">
              {briefing.lines.map((l) => (
                <li key={l} className="flex items-start gap-1.5 text-xs text-body">
                  <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-amber-500 motion-safe:animate-pulse" aria-hidden="true" />
                  <span>{l}</span>
                </li>
              ))}
            </ul>
          )}
          <p className="mt-1 text-[10px] text-muted">
            {ai ? `AI briefing · ${ai.model.label}` : 'Briefing'} · from your Swiggy orders &amp; bookings
          </p>
        </div>
      </div>
      {!hideChips && briefing.chips.length > 0 && (
        <div className="mt-2.5 flex flex-wrap gap-2">
          {briefing.chips.map((c) => (
            <button
              key={c.label}
              type="button"
              onClick={() => onPick(c.prompt, c.label)}
              className="rounded-full border border-hairline bg-canvas px-3 py-1.5 text-xs font-medium text-body transition-colors hover:border-coral hover:text-coral"
            >
              {c.label}
            </button>
          ))}
        </div>
      )}
    </section>
  );
}

export default HomeBriefing;
