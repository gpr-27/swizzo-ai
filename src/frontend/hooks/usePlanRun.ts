'use client';

// Plan tab — the live plan + its autonomous run (see src/frontend/plan/planRun.ts
// for the pure model). This hook:
//  - derives the live plan from the thread every render (and on a 2 s tick, so
//    picker selections made by chat / taps and timeouts show up),
//  - persists the run (mode, log, replans…) per chat session in localStorage,
//  - drives "Run plan for me": opens pickers pre-filled, asks the planner for
//    Food / Instamart picks, replans failed steps — and STOPS at every
//    irreversible step until the user taps Confirm (it never books, adds to a
//    cart, creates a cart or pays by itself).

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ActivePicker } from '@/shared/types';
import type { UseSwiggyChat } from '@/frontend/hooks/useSwiggyChat';
import { pickerSnapshot, setAutoCartHold } from '@/frontend/utils/pickerBridge';
import { loadBookings } from '@/frontend/state/bookings';
import { noteLocalChange } from '@/frontend/state/syncBus';
import {
  adoptItinerary,
  askPrompt,
  decideNext,
  derivePlan,
  emptyRun,
  latestItinerary,
  logTransitions,
  markActed,
  markFailed,
  planIntentFor,
  planPickFor,
  planTargetFor,
  replanPrompt,
  reviveRun,
  unavailablePrompt,
  withLog,
  type PlanRunState,
  type PlanView,
  type RunAction,
} from '@/frontend/plan/planRun';

const KEY = (sid: string) => `swiggy-planrun-v1:${sid}`;
const TICK_MS = 2000;

function loadRun(sid: string): PlanRunState {
  if (typeof window === 'undefined' || !sid) return emptyRun();
  try {
    const raw = window.localStorage.getItem(KEY(sid));
    return raw ? reviveRun(JSON.parse(raw)) : emptyRun();
  } catch {
    return emptyRun();
  }
}

export interface PlanRun {
  view: PlanView | null;
  run: PlanRunState;
  sending: boolean; // a chat turn is streaming (planner buttons wait)
  start: () => void;
  pause: () => void;
  resume: () => void;
  /** do a planned step now (open its picker / ask for picks) */
  doStep: (index: number) => void;
  /** clear a step's failure and try the same option again */
  retry: (index: number) => void;
  skip: (index: number) => void;
  unskip: (index: number) => void;
  replan: (index: number, reason?: string) => void;
  /** the user's tap on a Food / Instamart "Add to cart" confirm */
  approve: (index: number) => void;
  /** "Try another kind of show" / "Try Sunday" for a requested-but-unavailable part */
  tryUnavailable: (i: number, kind: 'other' | 'day') => void;
  /** a log line for a user tap the panel handled itself (e.g. "Confirm table" → picker) */
  note: (text: string, index?: number) => void;
  /** live booking rows from /api/bookings (the panel polls) */
  setLiveStatus: (rows: { orderId: string; status?: string; ok: boolean }[]) => void;
  watch: { kind: 'dineout' | 'scenes'; orderId: string; status: string }[];
}

export function usePlanRun(chat: UseSwiggyChat): PlanRun {
  const sid = chat.sessionId;
  const active = chat.service === 'plan';
  const [store, setStore] = useState<{ sid: string; run: PlanRunState }>(() => ({ sid: '', run: emptyRun() }));
  // a different chat session → its own saved run (adjusted during render, no effect)
  if (store.sid !== sid) setStore({ sid, run: loadRun(sid) });
  const run = store.sid === sid ? store.run : emptyRun();
  const update = useCallback((fn: (r: PlanRunState) => PlanRunState) => {
    setStore((s) => ({ ...s, run: fn(s.run) }));
  }, []);

  const [now, setNow] = useState(0);
  const [liveStatus, setLive] = useState<Record<string, string>>({});
  const latest = useMemo(() => latestItinerary(chat.messages), [chat.messages]);

  // the clock: picker snapshots, saved bookings and timeouts are re-read on it
  useEffect(() => {
    if (!active || !latest) return;
    const t0 = window.setTimeout(() => setNow(Date.now()), 0);
    const id = window.setInterval(() => setNow(Date.now()), TICK_MS);
    return () => {
      window.clearTimeout(t0);
      window.clearInterval(id);
    };
  }, [active, latest]);

  const userId = chat.auth.user?.userId ?? undefined;
  // eslint-disable-next-line react-hooks/exhaustive-deps -- re-read on every tick
  const bookings = useMemo(() => (latest ? loadBookings(userId) : []), [latest, userId, now]);

  const instamartTotal = Number(String(chat.cart.bill?.total ?? '').replace(/[^0-9.]/g, '')) || chat.cart.subtotal;
  const view = useMemo(
    () =>
      active && now
        ? derivePlan({
            messages: chat.messages,
            run,
            snapshot: pickerSnapshot,
            liveStatus,
            bookings,
            foodCart: { items: chat.foodCart.items, toPay: chat.foodCart.toPay },
            instamartCart: { items: chat.cart.items, total: instamartTotal },
            paymentOpen: !!chat.paymentSession,
            sending: chat.sending,
            budget: chat.budget,
            now,
          })
        : null,
    [active, now, chat.messages, run, liveStatus, bookings, chat.foodCart, chat.cart.items, instamartTotal, chat.paymentSession, chat.sending, chat.budget],
  );

  // A new itinerary turn → adopt it (same plan updated, or a brand-new plan),
  // then log every step whose status changed. Both are pure on the run and
  // applied during render (React's "adjust state while rendering" pattern).
  if (active && latest && store.sid === sid && now) {
    let next = run;
    if (!next.planIds.includes(latest.id)) {
      const prevId = [...next.planIds].reverse().find((id) => chat.messages.some((m) => m.id === id));
      const prev = prevId ? chat.messages.find((m) => m.id === prevId)?.itinerary : undefined;
      next = adoptItinerary(next, prev, latest, now);
    }
    if (view && next.planIds.includes(view.planId)) next = logTransitions(next, view, now);
    if (next !== run) setStore({ sid, run: next });
  }

  // persist per session
  useEffect(() => {
    if (!store.sid || !store.run.planIds.length) return;
    try {
      window.localStorage.setItem(KEY(store.sid), JSON.stringify(store.run));
      noteLocalChange({ entity: 'planRuns', id: store.sid });
    } catch {
      /* storage full / blocked — the run still works this session */
    }
  }, [store]);

  // While the run is active, chat / AI-read PICKs never create a cart by themselves.
  useEffect(() => {
    setAutoCartHold(active && run.mode === 'running');
    return () => setAutoCartHold(false);
  }, [active, run.mode]);

  /* ------------------------------ actions -------------------------------- */

  const chatRef = useRef(chat);
  useEffect(() => {
    chatRef.current = chat;
  });

  // Start one step's read-only work: open its picker pre-filled (Dineout /
  // Scenes) or ask the planner for picks (Food / Instamart).
  const startStep = useCallback(
    (v: PlanView, index: number, kind: 'open' | 'ask', by: 'run' | 'you') => {
      const c = chatRef.current;
      const s = v.steps[index];
      if (!s) return;
      const step = s.step;
      const t = Date.now();
      if (kind === 'open') {
        const intent = planIntentFor(step, v.itinerary);
        // ONE selection for this step (its date, nearest time, party, free table
        // first), applied when the listing loads — no generic best-pick first
        const target = planTargetFor(step, v.itinerary);
        const planPick = (snap: ActivePicker) => {
          const p = planPickFor(snap, target, Date.now());
          return p && 'sel' in p ? p.sel : null;
        };
        if (step.domain === 'dineout') {
          const r = c.messages.flatMap((m) => m.dineoutRestaurants ?? []).find((x) => x.id === step.ref);
          if (!r || r.bookable === false) return;
          update((run) =>
            withLog({ ...markActed(run, index, 'open', step.ref, t), lastDineoutAt: t }, {
              at: t,
              text: `Step ${index + 1}: checking live table slots at ${r.name}${step.time ? ` — will pick the open slot nearest ${step.time}, free table first` : ''}`,
              tone: by === 'you' ? 'you' : 'info',
              step: index,
            }),
          );
          c.openDineoutSlots(r, { planIntent: intent, planPick });
        } else if (step.domain === 'scenes') {
          const e = c.messages.flatMap((m) => m.scenesEvents ?? []).find((x) => x.id === step.ref);
          if (!e) return;
          update((run) =>
            withLog(markActed(run, index, 'open', step.ref, t), {
              at: t,
              text: `Step ${index + 1}: loading shows & tickets for ${e.title}${e.venueName ? ` at ${e.venueName}` : ''}`,
              tone: by === 'you' ? 'you' : 'info',
              step: index,
            }),
          );
          c.openScenesShows(e, { planIntent: intent, planPick });
        }
        return;
      }
      if (step.domain !== 'food' && step.domain !== 'instamart') return;
      if (c.sending) return;
      const p = askPrompt(step);
      update((run) =>
        withLog(markActed(run, index, 'ask', step.ref, t), {
          at: t,
          text: `Step ${index + 1}: asking the planner for the best ${step.domain === 'food' ? 'delivery dish' : 'Instamart picks'} — “${step.title}”`,
          tone: by === 'you' ? 'you' : 'info',
          step: index,
        }),
      );
      c.sendMessage(p.text, undefined, undefined, undefined, p.display);
    },
    [update],
  );

  const sendReplan = useCallback(
    (v: PlanView, index: number, reason: string, by: 'run' | 'you') => {
      const c = chatRef.current;
      const s = v.steps[index];
      if (!s || c.sending) return;
      const t = Date.now();
      const p = replanPrompt(index, s.step, reason);
      update((run) =>
        withLog(markFailed(markActed(run, index, 'replan', s.step.ref, t), index, s.step.ref, reason), {
          at: t,
          text: `Step ${index + 1}: replanning ${s.name} — ${reason}`,
          tone: by === 'you' ? 'you' : 'warn',
          step: index,
        }),
      );
      c.sendMessage(p.text, undefined, undefined, undefined, p.display);
    },
    [update],
  );

  // The engine: one move per state change while the run is on.
  const lastMove = useRef('');
  useEffect(() => {
    if (!view || run.mode !== 'running') return;
    const a: RunAction = decideNext(view, run, { sending: chat.sending, now: Date.now() });
    if (a.type === 'none' || a.type === 'wait') return;
    // the same move on unchanged state at most every 10 s (a bailed move — e.g. a
    // turn still streaming — is retried, a started one changes `acted`)
    const sig = `${a.type}:${'index' in a ? a.index : ''}:${view.planId}:${JSON.stringify(run.acted)}:${Math.floor(Date.now() / 10_000)}`;
    if (sig === lastMove.current) return;
    // dispatched from a callback (never synchronously in the effect body); a newer
    // state before it fires cancels it and the next render decides again
    const timer = window.setTimeout(() => {
      lastMove.current = sig;
      const t = Date.now();
      switch (a.type) {
        case 'open':
          startStep(view, a.index, 'open', 'run');
          break;
        case 'retry':
          update((r) => {
            const k = `${a.index}:busy`;
            return withLog({ ...r, replans: { ...r.replans, [k]: (r.replans[k] ?? 0) + 1 } }, {
              at: t,
              text: `Step ${a.index + 1}: Dineout was busy — trying the same restaurant again`,
              tone: 'info',
              step: a.index,
            });
          });
          startStep(view, a.index, 'open', 'run');
          break;
        case 'ask':
          startStep(view, a.index, 'ask', 'run');
          break;
        case 'replan':
          sendReplan(view, a.index, a.reason, 'run');
          break;
        case 'pause':
          update((r) => withLog({ ...r, mode: 'paused', note: a.reason }, { at: t, text: a.reason, tone: 'warn', step: a.index }));
          break;
        case 'finish':
          update((r) => withLog({ ...r, mode: 'done', note: undefined }, { at: t, text: 'Every step is handled — the run is complete', tone: 'ok' }));
          break;
      }
    }, 250);
    return () => window.clearTimeout(timer);
  }, [view, run, chat.sending, startStep, sendReplan, update]);

  /* ------------------------------ controls ------------------------------- */

  const start = useCallback(() => {
    const t = Date.now();
    lastMove.current = '';
    update((r) =>
      withLog({ ...r, mode: 'running', note: undefined }, {
        at: t,
        text: 'You started the run — I’ll work through each step and stop only for your confirms',
        tone: 'you',
      }),
    );
  }, [update]);
  const pause = useCallback(() => {
    update((r) => withLog({ ...r, mode: 'paused', note: 'Paused — tap Resume to carry on.' }, { text: 'You paused the run', tone: 'you' }));
  }, [update]);
  const resume = useCallback(() => {
    lastMove.current = '';
    update((r) => withLog({ ...r, mode: 'running', note: undefined }, { text: 'You resumed the run', tone: 'you' }));
  }, [update]);

  const doStep = useCallback(
    (index: number) => {
      const s = view?.steps[index];
      if (!view || !s?.next) return;
      startStep(view, index, s.next, 'you');
    },
    [view, startStep],
  );
  const retry = useCallback(
    (index: number) => {
      const s = view?.steps[index];
      if (!view || !s) return;
      const k = String(index);
      update((r) => {
        const failedRefs = { ...r.failedRefs };
        delete failedRefs[k];
        const replans = { ...r.replans };
        delete replans[`${k}:busy`];
        return withLog({ ...r, failedRefs, replans, mode: r.mode === 'paused' ? 'running' : r.mode, note: undefined }, {
          text: `You asked to try step ${index + 1} again — ${s.name}`,
          tone: 'you',
          step: index,
        });
      });
      lastMove.current = '';
      if (s.step.domain === 'dineout' || s.step.domain === 'scenes') startStep(view, index, 'open', 'you');
      else startStep(view, index, 'ask', 'you');
    },
    [view, startStep, update],
  );
  const skip = useCallback(
    (index: number) => {
      const s = view?.steps[index];
      update((r) =>
        withLog({ ...r, skipped: [...new Set([...r.skipped, index])], mode: r.mode === 'paused' && r.note ? 'running' : r.mode, note: undefined }, {
          text: `You skipped step ${index + 1}${s ? ` — ${s.name}` : ''}`,
          tone: 'you',
          step: index,
        }),
      );
      lastMove.current = '';
    },
    [view, update],
  );
  const unskip = useCallback(
    (index: number) => {
      update((r) => withLog({ ...r, skipped: r.skipped.filter((i) => i !== index) }, { text: `You brought back step ${index + 1}`, tone: 'you', step: index }));
    },
    [update],
  );
  const replan = useCallback(
    (index: number, reason?: string) => {
      if (!view) return;
      lastMove.current = '';
      sendReplan(view, index, reason || view.steps[index]?.reason || 'you asked for a different option', 'you');
    },
    [view, sendReplan],
  );
  const approve = useCallback(
    (index: number) => {
      const s = view?.steps[index];
      const c = chatRef.current;
      if (!s || s.confirm?.kind !== 'proposals') return;
      for (const it of s.confirm.items) c.approveProposal(it.messageId, it.pid);
      update((r) => withLog(r, { text: `You confirmed: ${s.confirm?.label}`, tone: 'you', step: index }));
    },
    [view, update],
  );
  const tryUnavailable = useCallback(
    (i: number, kind: 'other' | 'day') => {
      const c = chatRef.current;
      const u = view?.itinerary.unavailable?.[i];
      if (!view || !u || c.sending) return;
      const p = unavailablePrompt(u, kind, view.itinerary);
      update((r) => withLog(r, { text: `You asked: ${p.display} — ${u.what}`, tone: 'you' }));
      c.sendMessage(p.text, undefined, undefined, undefined, p.display);
    },
    [view, update],
  );
  const note = useCallback(
    (text: string, index?: number) => update((r) => withLog(r, { text, tone: 'you', ...(index !== undefined ? { step: index } : {}) })),
    [update],
  );

  const setLiveStatus = useCallback((rows: { orderId: string; status?: string; ok: boolean }[]) => {
    setLive((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const r of rows) {
        if (r.ok && r.status && next[r.orderId] !== r.status) {
          next[r.orderId] = r.status;
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, []);

  const watch = useMemo(
    () =>
      (view?.steps ?? []).flatMap((s) =>
        s.booking?.orderId && (s.booking.kind === 'dineout' || s.booking.kind === 'scenes') && s.status !== 'failed' && s.status !== 'done'
          ? [{ kind: s.booking.kind, orderId: s.booking.orderId, status: s.booking.status }]
          : [],
      ),
    [view],
  );

  return { view, run, sending: chat.sending, start, pause, resume, doStep, retry, skip, unskip, replan, approve, tryUnavailable, note, setLiveStatus, watch };
}
