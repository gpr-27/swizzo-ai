'use client';

// "AI read" panel for the Dineout details sheet, the Scenes ticket picker and
// the Dineout compare sheet. It shows the deterministic read of everything
// Swiggy returned right away (shared/aiRead dineoutFacts / scenesFacts /
// dineoutCompareVerdict), then asks /api/ai-read — one tool-free model call
// over that SAME loaded data, never a Swiggy call — for a sharper summary and a
// "Should I go?" line tuned to what the user asked for. Swiggy has no review
// text, so the panel says so and never shows any.

import { useEffect, useState } from 'react';
import { REVIEWS_NOTE } from '@/shared/aiRead';
import { currentNeeds } from '@/frontend/state/userNeeds';

export interface AiReadPanelProps {
  kind: 'dineout' | 'scenes' | 'compare';
  /** stable id of the data (restaurant / listing / compare set) — the AI read is memoised by it */
  cacheKey: string;
  /** deterministic one-liner (dineout / scenes) or verdict (compare) */
  summary: string;
  facts: string[];
  /** deterministic "Should I go?" line used until / unless the model answers */
  fallbackFit?: string;
  /** false while the data is still loading (no AI call yet) */
  ready?: boolean;
  tone?: 'coral' | 'purple';
}

type AiReply = { summary?: string; fit?: string; verdict?: string; model?: string };
const memo = new Map<string, AiReply | null>();

export function AiReadPanel({ kind, cacheKey, summary, facts, fallbackFit, ready = true, tone = 'coral' }: AiReadPanelProps) {
  const [needs] = useState(() => currentNeeds());
  const key = `${kind}|${cacheKey}|${needs}`;
  // re-render once the memo has this key's reply (the memo is the store)
  const [, bump] = useState(0);
  const ai = memo.has(key) ? memo.get(key) : undefined;
  const loading = ready && ai === undefined;

  useEffect(() => {
    if (!ready || memo.has(key)) return;
    const ctrl = new AbortController();
    fetch('/api/ai-read', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind, facts: [summary, ...facts].join('\n'), needs }),
      signal: ctrl.signal,
    })
      .then((r) => r.json().catch(() => ({})))
      .then((j: AiReply & { ok?: boolean }) => {
        const reply = j?.ok ? { summary: j.summary, fit: j.fit, verdict: j.verdict, model: j.model } : null;
        memo.set(key, reply);
        bump((n) => n + 1);
      })
      .catch((err) => {
        if ((err as { name?: string })?.name === 'AbortError') return;
        memo.set(key, null);
        bump((n) => n + 1);
      });
    return () => ctrl.abort();
    // facts / summary are derived from the same data as cacheKey
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, ready]);

  const accent =
    tone === 'purple'
      ? {
          box: 'border-purple-500/25 bg-gradient-to-b from-purple-500/10 to-purple-500/[0.03]',
          label: 'bg-purple-500/15 text-purple-700 dark:text-purple-300',
          fit: 'bg-purple-500/10 text-purple-700 dark:text-purple-300',
          dot: 'bg-purple-500/60',
        }
      : {
          box: 'border-coral/25 bg-gradient-to-b from-coral/10 to-coral/[0.03]',
          label: 'bg-coral/15 text-coral',
          fit: 'bg-coral/10 text-coral',
          dot: 'bg-coral/60',
        };
  const lead = kind === 'compare' ? summary : ai?.summary || summary;
  const fit = kind === 'compare' ? ai?.verdict : ai?.fit || fallbackFit;

  return (
    <section className={`rounded-2xl border p-3.5 sm:p-4 ${accent.box}`} aria-live="polite">
      <div className="flex items-center justify-between gap-2">
        <p className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider ${accent.label}`}>
          <span aria-hidden>✦</span>
          {kind === 'compare' ? 'AI verdict' : 'AI read'}
        </p>
        {ai?.model && <span className="min-w-0 truncate text-[10px] text-muted-soft">{ai.model}</span>}
      </div>
      <p className="mt-2.5 text-[13px] font-medium leading-relaxed text-ink [overflow-wrap:anywhere]">{lead}</p>
      {loading ? (
        <div className="mt-3 space-y-1.5" aria-hidden>
          <div className="h-2.5 w-full animate-pulse rounded-full bg-ink/10" />
          <div className="h-2.5 w-2/3 animate-pulse rounded-full bg-ink/10" />
        </div>
      ) : fit ? (
        <div className={`mt-3 rounded-xl px-3 py-2 ${accent.fit}`}>
          <p className="text-[10px] font-bold uppercase tracking-wider opacity-80">
            {kind === 'compare' ? 'For you' : 'Should I go?'}
          </p>
          <p className="mt-0.5 text-xs leading-relaxed text-body [overflow-wrap:anywhere]">{fit}</p>
        </div>
      ) : null}
      {facts.length > 0 && (
        <details className="group mt-3 text-[11px] text-muted">
          <summary className="flex cursor-pointer list-none items-center gap-1.5 font-semibold text-body [&::-webkit-details-marker]:hidden">
            <span aria-hidden className="text-[9px] transition-transform group-open:rotate-90">▶</span>
            Everything Swiggy shared ({facts.length})
          </summary>
          <ul className="mt-2 space-y-1.5 leading-relaxed">
            {facts.map((f) => (
              <li key={f} className="flex gap-2 [overflow-wrap:anywhere]">
                <span aria-hidden className={`mt-[7px] h-1 w-1 shrink-0 rounded-full ${accent.dot}`} />
                <span className="min-w-0">{f}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
      <p className="mt-3 border-t border-ink/10 pt-2 text-[10px] leading-snug text-muted-soft">{REVIEWS_NOTE}</p>
    </section>
  );
}

export default AiReadPanel;
