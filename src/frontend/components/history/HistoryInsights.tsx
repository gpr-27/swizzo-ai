'use client';

// The AI summary at the top of the History page. The numbers and the one-tap
// actions come from buildHistoryInsights() over the real rows on the page;
// the sentence on top is the deterministic headline until the AI phrasing
// (/api/history/insights — grounded in the same facts) arrives. Actions:
// Reorder (→ the existing ReorderDialog), Track (→ the order card's live
// status), Refill (→ the Instamart tab with its usuals board), bookings.

import { useEffect, useState } from 'react';
import type { GeneratedBy } from '@/shared/types';
import { insightFacts, type HistoryInsights as Insights, type InsightAction } from '@/backend/history/insights';

const inr = (n: number) => `₹${Math.round(n).toLocaleString('en-IN')}`;

// Facts → AI sentence, cached for the page's lifetime (same facts = no new call).
const phraseCache = new Map<string, { text: string; model?: GeneratedBy } | null>();

export interface HistoryInsightsProps {
  insights: Insights;
  onAction: (action: InsightAction) => void;
}

export function HistoryInsights({ insights, onAction }: HistoryInsightsProps) {
  const facts = insightFacts(insights);
  const key = facts.join('\n');
  const [ai, setAi] = useState<{ key: string; text: string; model?: GeneratedBy } | null>(null);

  useEffect(() => {
    if (!facts.length) return;
    const cached = phraseCache.get(key);
    if (cached !== undefined) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- cached AI phrase for these exact facts
      if (cached) setAi({ key, ...cached });
      return;
    }
    const ctrl = new AbortController();
    void (async () => {
      try {
        const res = await fetch('/api/history/insights', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ facts }),
          signal: ctrl.signal,
        });
        const data = (await res.json().catch(() => ({}))) as { text?: string; model?: GeneratedBy };
        const value = data.text ? { text: data.text, model: data.model } : null;
        phraseCache.set(key, value);
        if (value) setAi({ key, ...value });
      } catch {
        /* keep the deterministic headline */
      }
    })();
    return () => ctrl.abort();
    // `facts` is derived from `key`
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const text = ai && ai.key === key ? ai.text : insights.headline;
  const tiles = [
    insights.topRestaurants[0] && {
      label: 'Go-to restaurant',
      value: insights.topRestaurants[0].name,
      hint: `${insights.topRestaurants[0].count} order${insights.topRestaurants[0].count === 1 ? '' : 's'}`,
    },
    insights.topDishes[0] && {
      label: 'Most-ordered dish',
      value: insights.topDishes[0].name,
      hint: `${insights.topDishes[0].count}×`,
    },
    insights.topItems[0] && {
      label: 'Instamart staple',
      value: insights.topItems[0].name,
      hint: `${insights.topItems[0].count}×`,
    },
    insights.usual && {
      label: 'You usually order',
      value: insights.usual.slot === 'late-night' ? 'Late night' : insights.usual.slot.replace(/^./, (c) => c.toUpperCase()),
      hint: `${insights.usual.count} of ${insights.usual.of} orders`,
    },
    insights.spentOrders > 0 && {
      label: 'Spent',
      value: inr(insights.spent),
      hint: `${insights.spentOrders} orders${insights.since ? ` since ${insights.since}` : ''}${insights.cancelled ? ` · ${insights.cancelled} cancelled not counted` : ''}`,
    },
  ].filter(Boolean) as { label: string; value: string; hint: string }[];

  if (!facts.length && !insights.actions.length) return null;

  return (
    <section
      aria-label="AI summary of your orders"
      className="mb-5 overflow-hidden rounded-2xl border border-coral/25 bg-gradient-to-br from-coral/[0.06] to-amber-500/[0.04] p-4 shadow-xs"
    >
      <div className="flex items-start gap-2.5">
        <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-coral/15 text-sm text-coral" aria-hidden="true">
          ✦
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm leading-relaxed text-ink" aria-live="polite">
            {text}
          </p>
          <p className="mt-0.5 text-[10px] text-muted">
            {ai && ai.key === key && ai.model ? `AI summary · ${ai.model.label}` : 'Summary'} · from your real Swiggy orders
          </p>
        </div>
      </div>

      {tiles.length > 0 && (
        <dl className="mt-3 grid grid-cols-2 gap-2 lg:grid-cols-5">
          {tiles.map((t) => (
            <div key={t.label} className="min-w-0 rounded-xl border border-hairline bg-canvas/70 px-2.5 py-2">
              <dt className="text-[10px] uppercase tracking-wide text-muted">{t.label}</dt>
              <dd className="truncate text-[13px] font-semibold text-ink" title={t.value}>
                {t.value}
              </dd>
              <dd className="truncate text-[10px] text-muted">{t.hint}</dd>
            </div>
          ))}
        </dl>
      )}

      {insights.actions.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-2">
          {insights.actions.map((a) => (
            <button
              key={`${a.kind}-${'orderId' in a ? a.orderId : a.label}`}
              type="button"
              onClick={() => onAction(a)}
              className={`inline-flex min-h-9 items-center gap-1.5 rounded-full px-3.5 py-1.5 text-xs font-semibold transition-colors ${
                a.kind === 'reorder'
                  ? 'bg-coral text-on-primary hover:bg-coral-active'
                  : a.kind === 'track'
                    ? 'border border-amber-500/40 bg-amber-500/10 text-amber-800 hover:bg-amber-500/20 dark:text-amber-200'
                    : 'border border-hairline bg-canvas text-body hover:border-coral/50 hover:text-ink'
              }`}
            >
              <span aria-hidden="true">{a.kind === 'reorder' ? '↻' : a.kind === 'track' ? '📍' : a.kind === 'refill' ? '⚡' : '🥂'}</span>
              {a.label}
            </button>
          ))}
        </div>
      )}
    </section>
  );
}

export default HistoryInsights;
