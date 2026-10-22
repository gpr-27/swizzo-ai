'use client';

// Plan tab — the LIVE plan panel (right tray on desktop, drawer on mobile).
// A vertical timeline of the current itinerary with a live status per step
// (planned → searching → options → picked → waiting for you → booked / added →
// done, or failed + the AI's replan), the run controls (Run plan for me /
// Pause / Resume / Skip / Replan) and a timestamped activity log of every
// action the AI took. Every fact comes from the thread's real Swiggy data
// (src/frontend/plan/planRun.ts); booking statuses refresh from /api/bookings.
// Nothing here books, pays or orders: Confirm buttons hand over to the step's
// own picker / cart, where the user taps the final Swiggy confirm.

import { useRef, useState } from 'react';
import { SERVICE_META, type ItineraryDomain } from '@/shared/types';
import type { PlanRun } from '@/frontend/hooks/usePlanRun';
import { nextDayName, type StepStatus, type StepView } from '@/frontend/plan/planRun';
import { useLivePoll } from '@/frontend/utils/useLivePoll';
import { LiveStamp } from '@/frontend/components/features/LiveStamp';

const DOMAIN: Record<ItineraryDomain, { emoji: string; label: string }> = {
  scenes: { emoji: SERVICE_META.scenes.emoji, label: 'Scenes' },
  dineout: { emoji: SERVICE_META.dineout.emoji, label: 'Dineout' },
  food: { emoji: SERVICE_META.food.emoji, label: 'Food' },
  instamart: { emoji: SERVICE_META.instamart.emoji, label: 'Instamart' },
  other: { emoji: '📍', label: 'Outing' },
};

const STATUS: Record<StepStatus, { chip: string; dot: string; text: string }> = {
  planned: { chip: 'bg-surface-card text-muted', dot: 'bg-muted-soft', text: 'Planned' },
  searching: { chip: 'bg-sky-500/10 text-sky-700 dark:text-sky-300', dot: 'bg-sky-500 animate-pulse', text: 'Searching' },
  options: { chip: 'bg-sky-500/10 text-sky-700 dark:text-sky-300', dot: 'bg-sky-500', text: 'Options ready' },
  picked: { chip: 'bg-violet-500/10 text-violet-700 dark:text-violet-300', dot: 'bg-violet-500 animate-pulse', text: 'Picked' },
  confirm: { chip: 'bg-amber-500/15 text-amber-800 dark:text-amber-300', dot: 'bg-amber-500 animate-pulse', text: 'Your turn' },
  booked: { chip: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300', dot: 'bg-emerald-500', text: 'Booked' },
  done: { chip: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300', dot: 'bg-emerald-600', text: 'Done' },
  failed: { chip: 'bg-red-500/10 text-red-700 dark:text-red-300', dot: 'bg-red-500', text: 'Needs a change' },
  skipped: { chip: 'bg-surface-card text-muted-soft', dot: 'bg-hairline', text: 'Skipped' },
  info: { chip: 'bg-surface-card text-muted', dot: 'bg-muted-soft', text: 'Stop' },
};

const TONE: Record<string, string> = {
  ok: 'text-emerald-700 dark:text-emerald-400',
  wait: 'text-amber-800 dark:text-amber-400',
  warn: 'text-red-700 dark:text-red-400',
  you: 'text-coral',
  info: 'text-muted-soft',
};

const inr = (n: number) => `₹${Math.round(n).toLocaleString('en-IN')}`;
const clock = (at: number) => new Date(at).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' });
const pretty = (s: string) => s.replace(/_/g, ' ').toLowerCase();
const PENDING = /pending|processing|initiated|awaiting/i;

function unavailableLabel(u: { what: string }, kind: 'other' | 'day', date?: string): string {
  if (kind === 'day') return `Try ${nextDayName(date) ?? 'another day'}`;
  return /show|comedy|gig|concert|event|play|standup|stand-up|music|movie|screening/i.test(u.what)
    ? 'Try another kind of show'
    : 'Try another option';
}

export interface LivePlanPanelProps {
  plan: PlanRun;
  /** scroll the chat to a message (a picker / basket) — closes the mobile drawer */
  onReveal: (messageId: string) => void;
  /** open a cart's own tab to check out */
  onOpenCart: (svc: 'food' | 'instamart') => void;
  highlight?: boolean;
}

export function LivePlanPanel({ plan, onReveal, onOpenCart, highlight }: LivePlanPanelProps) {
  const { view, run } = plan;
  const rootRef = useRef<HTMLDivElement>(null);
  const [logOpen, setLogOpen] = useState(true);
  const [menuFor, setMenuFor] = useState<number | null>(null);

  // Live booking statuses for the plan's tables / tickets (same cadence as the
  // chat's booking cards: 30 s while pending, 2 min otherwise; paused off-screen).
  const watch = plan.watch;
  const poll = useLivePoll(
    async (signal) => {
      if (!watch.length) return;
      const res = await fetch('/api/bookings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items: watch.map((w) => ({ kind: w.kind, orderId: w.orderId })) }),
        signal,
      });
      const data = (await res.json().catch(() => ({}))) as {
        bookings?: { orderId: string; ok: boolean; status?: string }[];
        message?: string;
      };
      if (Array.isArray(data.bookings)) {
        plan.setLiveStatus(data.bookings);
        return;
      }
      return data.message || 'Could not refresh bookings.';
    },
    {
      intervalMs: watch.some((w) => PENDING.test(w.status)) ? 30_000 : 120_000,
      enabled: watch.length > 0,
      ref: rootRef,
      immediate: true,
    },
  );

  if (!view) return null;
  const running = run.mode === 'running';
  const pct = view.actionable ? Math.round((view.doneCount / view.actionable) * 100) : 0;
  const total = view.budget;
  const used = view.spent + view.lined;

  const confirmStep = (s: StepView) => {
    const c = s.confirm;
    if (!c) return;
    if (c.kind === 'proposals') plan.approve(s.index);
    else if (c.kind === 'picker' || c.kind === 'basket') {
      plan.note(`You opened step ${s.index + 1} to confirm — ${s.name}`, s.index);
      onReveal(c.messageId);
    }
  };

  return (
    <div
      ref={rootRef}
      className={`flex min-h-full flex-col bg-canvas transition-shadow duration-500 ${highlight ? 'ring-2 ring-inset ring-emerald-500/60' : ''}`}
      aria-label="Live plan"
    >
      {/* ------------------------------ header ------------------------------ */}
      <div className="sticky top-0 z-10 space-y-3 border-b border-hairline bg-canvas/95 px-5 pb-4 pt-5 backdrop-blur">
        <div className="flex items-start gap-2.5">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-emerald-500/10 text-base" aria-hidden="true">
            🗺️
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5">
              <span className="text-[10px] font-bold uppercase tracking-wider text-emerald-700 dark:text-emerald-400">Live plan</span>
              {running && <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-500" aria-hidden="true" />}
            </div>
            <h3 className="truncate font-display text-lg font-bold leading-tight text-ink">{view.title}</h3>
            <p className="mt-0.5 text-[11px] text-muted">
              {[view.date, view.party ? `${view.party} people` : '', `${view.steps.length} stops`].filter(Boolean).join(' · ')}
            </p>
          </div>
        </div>

        {/* progress + budget */}
        <div className="space-y-1.5">
          <div className="flex items-center justify-between text-[11px]">
            <span className="font-semibold text-ink">
              {view.doneCount}/{view.actionable} steps done
            </span>
            <span className="text-muted">
              {used > 0 || total ? (
                <>
                  {view.spent > 0 && <span className="font-semibold text-ink">{inr(view.spent)} paid</span>}
                  {view.spent > 0 && view.lined > 0 && ' · '}
                  {view.lined > 0 && <span>{inr(view.lined)} lined up</span>}
                  {used === 0 && 'nothing paid yet'}
                  {total ? ` of ${inr(total)}` : ''}
                </>
              ) : (
                'real prices only'
              )}
            </span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-surface-card" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
            <div className="h-full rounded-full bg-emerald-500 transition-all duration-700" style={{ width: `${pct}%` }} />
          </div>
          {total && used > 0 ? (
            <div className="h-1 overflow-hidden rounded-full bg-surface-card" aria-hidden="true">
              <div
                className={`h-full rounded-full transition-all duration-700 ${used > total ? 'bg-red-500' : 'bg-coral/70'}`}
                style={{ width: `${Math.min(100, Math.round((used / total) * 100))}%` }}
              />
            </div>
          ) : null}
        </div>

        {/* what's happening now */}
        <div className="flex items-start gap-2 rounded-xl border border-hairline bg-surface-card/60 px-3 py-2">
          <span className="mt-0.5 text-xs" aria-hidden="true">
            {running ? '🤖' : run.mode === 'paused' ? '⏸️' : run.mode === 'done' ? '✅' : '💡'}
          </span>
          <p className="text-xs leading-relaxed text-body" aria-live="polite">
            {view.nowLine}
          </p>
        </div>

        {/* controls */}
        <div className="flex flex-wrap items-center gap-2">
          {run.mode === 'idle' || run.mode === 'done' ? (
            view.current >= 0 && (
              <button
                type="button"
                onClick={plan.start}
                className="inline-flex items-center gap-1.5 rounded-full bg-emerald-600 px-4 py-2 text-xs font-semibold text-white shadow-xs transition-colors hover:bg-emerald-700"
              >
                <span aria-hidden="true">▶</span> Run plan for me
              </button>
            )
          ) : running ? (
            <button
              type="button"
              onClick={plan.pause}
              className="inline-flex items-center gap-1.5 rounded-full border border-hairline bg-canvas px-3.5 py-1.5 text-xs font-semibold text-body hover:border-coral/60"
            >
              <span aria-hidden="true">⏸</span> Pause
            </button>
          ) : (
            <button
              type="button"
              onClick={plan.resume}
              className="inline-flex items-center gap-1.5 rounded-full bg-emerald-600 px-3.5 py-1.5 text-xs font-semibold text-white hover:bg-emerald-700"
            >
              <span aria-hidden="true">▶</span> Resume
            </button>
          )}
          {watch.length > 0 && (
            <LiveStamp
              lastUpdated={poll.lastUpdated}
              live={poll.live}
              refreshing={poll.refreshing}
              onRefresh={poll.refresh}
              cadence={watch.some((w) => PENDING.test(w.status)) ? 'every 30 s' : 'every 2 min'}
              error={poll.error}
            />
          )}
        </div>
      </div>

      {/* ------------- asked for, but Swiggy had nothing that fits ------------ */}
      {(view.itinerary.unavailable?.length ?? 0) > 0 && (
        <div className="space-y-2 px-5 pt-4">
          {view.itinerary.unavailable!.map((u, k) => (
            <div key={`${k}-${u.what}`} className="rounded-xl border border-dashed border-amber-500/50 bg-amber-500/[0.05] px-3 py-2.5">
              <p className="text-[10px] font-bold uppercase tracking-wider text-amber-700 dark:text-amber-300">Asked for · not available</p>
              <p className="mt-0.5 text-[13px] font-semibold text-ink first-letter:uppercase">{u.what}</p>
              <p className="mt-0.5 text-[11px] leading-relaxed text-body">{u.why}</p>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {(['other', 'day'] as const).map((kind) => (
                  <button
                    key={kind}
                    type="button"
                    disabled={plan.sending}
                    onClick={() => plan.tryUnavailable(k, kind)}
                    className="inline-flex items-center gap-1 rounded-full border border-hairline bg-canvas px-3 py-1 text-[11px] font-semibold text-body transition-colors hover:border-coral/60 disabled:opacity-50"
                  >
                    {unavailableLabel(u, kind, view.itinerary.date)}
                    <span aria-hidden="true">→</span>
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* ----------------------------- timeline ----------------------------- */}
      <ol className="px-5 py-4">
        {view.steps.map((s, i) => {
          const st = STATUS[s.status];
          const d = DOMAIN[s.step.domain];
          const isCur = i === view.current;
          const last = i === view.steps.length - 1;
          return (
            <li key={`${i}-${s.step.title}`} className="relative flex gap-3 pb-5 last:pb-0">
              <div className="w-12 shrink-0 pt-1 text-right text-[11px] font-semibold tabular-nums text-ink">{s.step.time ?? ''}</div>
              <div className="relative flex flex-col items-center">
                <span
                  className={`relative flex h-7 w-7 items-center justify-center rounded-full border text-sm ${
                    isCur ? 'border-emerald-500 bg-emerald-500/10' : 'border-hairline bg-canvas'
                  }`}
                  aria-hidden="true"
                >
                  {d.emoji}
                  <span className={`absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full ring-2 ring-canvas ${st.dot}`} />
                </span>
                {!last && <span className="mt-1 w-px flex-1 bg-hairline" aria-hidden="true" />}
              </div>
              <div
                className={`min-w-0 flex-1 rounded-xl border px-3 py-2.5 ${
                  isCur && s.status !== 'info' ? 'border-emerald-500/40 bg-emerald-500/[0.04] shadow-xs' : 'border-transparent'
                } ${s.status === 'skipped' ? 'opacity-60' : ''}`}
              >
                <div className="flex items-start gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className={`rounded-full px-2 py-px text-[10px] font-semibold ${st.chip}`}>{st.text}</span>
                      <span className="text-[10px] font-medium text-muted-soft">{d.label}</span>
                    </div>
                    <p className={`mt-1 text-[13px] font-semibold leading-snug ${s.status === 'skipped' ? 'text-muted line-through' : 'text-ink'}`}>
                      {s.name}
                    </p>
                    {s.name !== s.step.title && <p className="text-[11px] text-muted">{s.step.title}</p>}
                  </div>
                  {s.imageUrl && (
                    // eslint-disable-next-line @next/next/no-img-element -- Swiggy CDN photo, already sized
                    <img decoding="async" src={s.imageUrl} alt="" className="h-10 w-10 shrink-0 rounded-lg object-cover" loading="lazy" />
                  )}
                  {s.step.domain !== 'other' && (
                    <div className="relative">
                      <button
                        type="button"
                        aria-label={`More actions for step ${i + 1}`}
                        aria-expanded={menuFor === i}
                        onClick={() => setMenuFor(menuFor === i ? null : i)}
                        className="inline-flex h-6 w-6 items-center justify-center rounded-full text-muted hover:bg-surface-card"
                      >
                        ⋯
                      </button>
                      {menuFor === i && (
                        <div className="absolute right-0 top-7 z-20 w-40 overflow-hidden rounded-xl border border-hairline bg-canvas py-1 text-xs shadow-card">
                          {s.status === 'skipped' ? (
                            <MenuItem onClick={() => (plan.unskip(i), setMenuFor(null))}>Bring back step</MenuItem>
                          ) : (
                            s.status !== 'booked' &&
                            s.status !== 'done' && <MenuItem onClick={() => (plan.skip(i), setMenuFor(null))}>Skip step</MenuItem>
                          )}
                          {s.status !== 'booked' && s.status !== 'done' && (
                            <MenuItem onClick={() => (plan.replan(i), setMenuFor(null))}>Replan step</MenuItem>
                          )}
                          {s.pickerId && (
                            <MenuItem onClick={() => (onReveal(s.pickerId!), setMenuFor(null))}>Show in chat</MenuItem>
                          )}
                        </div>
                      )}
                    </div>
                  )}
                </div>

                {s.facts.length > 0 && (
                  <p className="mt-1 text-[11px] leading-relaxed text-body">{s.facts.join(' · ')}</p>
                )}
                {s.replacedFrom && (
                  <p className="mt-1 text-[11px] text-muted">
                    ↻ Replaced <span className="line-through">{s.replacedFrom.from}</span>
                    {s.replacedFrom.reason ? ` — ${s.replacedFrom.reason}` : ''}
                  </p>
                )}

                {s.pick && (
                  <div className="mt-2 rounded-lg bg-violet-500/[0.06] px-2.5 py-1.5">
                    <p className="text-[11px] font-semibold text-violet-700 dark:text-violet-300">
                      <span aria-hidden="true">✨</span> AI pick: {s.pick.title}
                    </p>
                    {s.pick.why && <p className="mt-0.5 text-[11px] leading-relaxed text-body">{s.pick.why}</p>}
                  </div>
                )}

                {s.status === 'failed' && s.reason && (
                  <div className="mt-2 rounded-lg bg-red-500/[0.06] px-2.5 py-1.5 text-[11px] leading-relaxed text-red-700 dark:text-red-300">
                    {s.reason}
                    {running && <span className="text-muted"> · the AI is finding an alternative</span>}
                  </div>
                )}

                {s.booking && (
                  <p className="mt-1.5 text-[11px] text-body">
                    <span className="font-semibold text-ink">{pretty(s.booking.status)}</span>
                    {s.booking.orderId && <span className="text-muted"> · order {s.booking.orderId}</span>}
                  </p>
                )}

                <p className="mt-1 text-[11px] text-muted">{s.label}</p>

                <StepButtons s={s} auto={running} onConfirm={() => confirmStep(s)} plan={plan} onOpenCart={onOpenCart} />
              </div>
            </li>
          );
        })}
      </ol>

      {/* ---------------------------- activity log --------------------------- */}
      <div className="border-t border-hairline px-5 py-3">
        <button
          type="button"
          onClick={() => setLogOpen((v) => !v)}
          aria-expanded={logOpen}
          className="flex w-full items-center justify-between text-xs font-semibold text-ink"
        >
          <span>
            Activity log <span className="font-normal text-muted">· {run.log.length}</span>
          </span>
          <span className="text-muted" aria-hidden="true">
            {logOpen ? '▾' : '▸'}
          </span>
        </button>
        {logOpen && (
          <ul className="mt-2 max-h-72 space-y-1.5 overflow-y-auto pr-1">
            {[...run.log].reverse().map((e, k) => (
              <li key={`${e.at}-${k}`} className="flex gap-2 text-[11px] leading-snug">
                <span className="w-14 shrink-0 tabular-nums text-muted-soft">{clock(e.at)}</span>
                <span className={`shrink-0 ${TONE[e.tone ?? 'info']}`} aria-hidden="true">
                  ●
                </span>
                <span className="min-w-0 text-body">{e.text}</span>
              </li>
            ))}
            {!run.log.length && <li className="text-[11px] text-muted">Nothing yet.</li>}
          </ul>
        )}
      </div>

      <p className="mt-auto border-t border-hairline px-5 py-3 text-[11px] leading-relaxed text-muted">
        🛡️ The AI searches, picks and fills each step by itself, but nothing is booked, added or paid until you tap
        confirm — tables, tickets, carts and payments stay yours.
      </p>
    </div>
  );
}

function MenuItem({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" onClick={onClick} className="block w-full px-3 py-1.5 text-left text-body hover:bg-surface-card">
      {children}
    </button>
  );
}

function StepButtons({
  s,
  auto,
  onConfirm,
  plan,
  onOpenCart,
}: {
  s: StepView;
  auto: boolean; // the run is on — it starts planned steps itself
  onConfirm: () => void;
  plan: PlanRun;
  onOpenCart: (svc: 'food' | 'instamart') => void;
}) {
  const btn =
    'inline-flex items-center gap-1 rounded-full px-3 py-1 text-[11px] font-semibold transition-colors disabled:opacity-50';
  const out: React.ReactNode[] = [];
  if (s.confirm && s.confirm.kind !== 'payment' && (s.status === 'confirm' || s.status === 'picked' || s.status === 'options')) {
    out.push(
      <button
        key="confirm"
        type="button"
        onClick={onConfirm}
        className={`${btn} ${s.status === 'confirm' ? 'bg-amber-500 text-white shadow-xs hover:bg-amber-600' : 'border border-hairline bg-canvas text-body hover:border-coral/60'}`}
      >
        {s.status === 'confirm' && <span aria-hidden="true">✓</span>}
        {s.confirm.label}
        <span aria-hidden="true">→</span>
      </button>,
    );
  }
  if (s.status === 'planned' && s.next && !auto) {
    out.push(
      <button key="do" type="button" onClick={() => plan.doStep(s.index)} className={`${btn} border border-hairline bg-canvas text-body hover:border-coral/60`}>
        {s.next === 'open' ? (s.step.domain === 'dineout' ? 'Check live slots' : 'Check shows') : 'Pick for me'}
        <span aria-hidden="true">→</span>
      </button>,
    );
  }
  if (s.status === 'failed') {
    out.push(
      <button key="replan" type="button" onClick={() => plan.replan(s.index)} className={`${btn} border border-hairline bg-canvas text-body hover:border-coral/60`}>
        ↻ Replan step
      </button>,
    );
    if (s.step.ref) {
      out.push(
        <button key="retry" type="button" onClick={() => plan.retry(s.index)} className={`${btn} text-muted hover:text-coral`}>
          Try again
        </button>,
      );
    }
  }
  if (s.status === 'booked' && (s.step.domain === 'food' || s.step.domain === 'instamart')) {
    const svc = s.step.domain;
    out.push(
      <button key="cart" type="button" onClick={() => onOpenCart(svc)} className={`${btn} border border-hairline bg-canvas text-body hover:border-coral/60`}>
        Checkout in {svc === 'food' ? 'Food' : 'Instamart'} <span aria-hidden="true">→</span>
      </button>,
    );
  }
  return out.length ? <div className="mt-2 flex flex-wrap gap-1.5">{out}</div> : null;
}

export default LivePlanPanel;
