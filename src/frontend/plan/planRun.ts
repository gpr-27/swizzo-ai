// Plan tab — the LIVE plan model (pure, no React / DOM), so
// scripts/verify-plan.ts can exercise the whole run state machine directly.
//
//  derivePlan()  → the current itinerary + a live status per step, computed
//                  from what is REALLY in the thread: the cards the planner
//                  found, the pickers opened (their live snapshot), the cart
//                  proposals, Swiggy's booking trackers and saved bookings.
//                  Nothing is estimated — a fact is shown only when a tool
//                  returned it.
//  decideNext()  → what the autonomous run does next. It only ever OPENS a
//                  picker (read-only slot / show listing), ASKS the planner for
//                  picks (read-only tools) or REPLANS a failed step; it STOPS
//                  at every irreversible step (book_table, create_cart,
//                  create_event_cart, cart adds, place order, payment) until
//                  the user taps Confirm, then continues by itself.

import { findDateIn, parseClock } from '@/shared/picker';
import type {
  ActivePicker,
  ChatMessage,
  DineoutActivePicker,
  DineoutRestaurant,
  PickerSelectFields,
  ScenesActivePicker,
  Itinerary,
  ItineraryDomain,
  ItineraryStep,
  MenuItem,
  ScenesEvent,
} from '@/shared/types';

/* --------------------------------- types --------------------------------- */

export type StepStatus =
  | 'planned' // nothing done yet
  | 'searching' // a picker / planner turn is loading for this step
  | 'options' // live options loaded (slots / shows), nothing picked yet
  | 'picked' // the AI's choice is selected; its read is still being written
  | 'confirm' // waiting for the user's tap (Confirm / Add / payment)
  | 'booked' // booked / added / paid on Swiggy
  | 'done' // finished (or a stop with nothing to book that the run passed)
  | 'failed' // sold out / walk-in only / no slots / out of stock …
  | 'skipped' // the user skipped it
  | 'info'; // a stop with no Swiggy service (mall, travel)

/** Statuses the run moves past. */
export const TERMINAL: ReadonlySet<StepStatus> = new Set(['booked', 'done', 'skipped', 'info']);

export const MAX_AUTO_REPLANS = 1; // per step, automatic; "Replan step" by hand is unlimited
export const OPEN_TIMEOUT_MS = 75_000; // a picker that never loaded → failed
export const DINEOUT_SPACING_MS = 6_000; // Dineout rate-limits (~7 searches then 429)
const MAX_LOG = 80;

export interface PlanLogEntry {
  at: number;
  text: string;
  tone?: 'info' | 'ok' | 'wait' | 'warn' | 'you';
  step?: number;
}

/** The last thing the run (or a panel tap) did for a step. */
export interface StepAct {
  kind: 'open' | 'ask' | 'replan';
  at: number;
  ref?: string;
}

/** Everything the run remembers (persisted per chat session). Keys are step indexes. */
export interface PlanRunState {
  v: 1;
  planIds: string[]; // itinerary message ids that belong to this plan (oldest first)
  startedAt: number; // when this plan first appeared (scopes saved bookings)
  mode: 'idle' | 'running' | 'paused' | 'done';
  skipped: number[];
  acted: Record<string, StepAct>;
  replans: Record<string, number>;
  failedRefs: Record<string, { ref?: string; reason: string }>;
  replaced: Record<string, { from: string; reason?: string }>;
  lastLogged: Record<string, string>;
  log: PlanLogEntry[];
  note?: string;
  lastDineoutAt?: number;
}

export function emptyRun(): PlanRunState {
  return {
    v: 1,
    planIds: [],
    startedAt: 0,
    mode: 'idle',
    skipped: [],
    acted: {},
    replans: {},
    failedRefs: {},
    replaced: {},
    lastLogged: {},
    log: [],
  };
}

/** Parse a persisted run (anything malformed → a fresh run). */
export function reviveRun(raw: unknown): PlanRunState {
  const r = raw as Partial<PlanRunState> | null;
  if (!r || typeof r !== 'object' || r.v !== 1 || !Array.isArray(r.planIds)) return emptyRun();
  const base = emptyRun();
  return {
    ...base,
    ...r,
    skipped: Array.isArray(r.skipped) ? r.skipped.filter((n) => typeof n === 'number') : [],
    log: Array.isArray(r.log) ? r.log.slice(-MAX_LOG) : [],
    // a run never resumes by itself after a reload — the user taps Resume
    mode: r.mode === 'running' ? 'paused' : r.mode ?? 'idle',
    note: r.mode === 'running' ? 'Paused after the page reloaded — tap Resume to carry on.' : r.note,
  };
}

export function withLog(run: PlanRunState, entry: Omit<PlanLogEntry, 'at'> & { at?: number }): PlanRunState {
  const e: PlanLogEntry = { at: entry.at ?? Date.now(), text: entry.text, ...(entry.tone ? { tone: entry.tone } : {}), ...(entry.step !== undefined ? { step: entry.step } : {}) };
  return { ...run, log: [...run.log, e].slice(-MAX_LOG) };
}

export type StepConfirm =
  | { kind: 'picker'; messageId: string; label: string }
  | { kind: 'proposals'; items: { messageId: string; pid: string }[]; label: string }
  | { kind: 'basket'; messageId: string; label: string }
  | { kind: 'payment'; label: string };

export interface StepView {
  index: number;
  step: ItineraryStep;
  status: StepStatus;
  label: string; // short status line ("Waiting for you to confirm")
  name: string; // the real venue / restaurant / dish name (else the step title)
  facts: string[]; // real details only (area, distance, rating, price, party)
  imageUrl?: string;
  pick?: { title: string; why?: string };
  reason?: string; // why it failed
  replacedFrom?: { from: string; reason?: string };
  booking?: { kind: 'dineout' | 'scenes' | 'food' | 'instamart'; orderId?: string; status: string };
  pickerId?: string;
  confirm?: StepConfirm;
  spent?: number; // ₹ Swiggy charged (bookings) — real only
  lined?: number; // ₹ picked / in cart, not yet paid — real only
  next?: 'open' | 'ask' | null; // what "Do this step" / the run does from 'planned'
  date?: string;
  party?: number;
}

export interface PlanView {
  planId: string;
  itinerary: Itinerary;
  steps: StepView[];
  title: string;
  date?: string;
  party?: number;
  budget?: number;
  spent: number;
  lined: number;
  doneCount: number;
  actionable: number;
  current: number; // index of the step the run works on, -1 when all handled
  nowLine: string;
}

export interface SavedBookingLike {
  kind: 'dineout' | 'scenes';
  orderId: string;
  title: string;
  createdAt: number;
}

export interface DeriveInput {
  messages: ChatMessage[];
  run: PlanRunState;
  snapshot: (messageId: string) => ActivePicker | null;
  liveStatus?: Record<string, string>; // orderId → Swiggy's latest status (/api/bookings)
  bookings?: SavedBookingLike[]; // bookings this app saved (orderId even for UPI flows)
  foodCart?: { items: { menuItemId: string; name: string; quantity: number }[]; toPay: number };
  instamartCart?: { items: { spinId: string; name: string; quantity: number }[]; total: number };
  paymentOpen?: boolean;
  sending?: boolean;
  budget?: number; // the app's budget setting (fallback when the plan names none)
  now: number;
}

/* -------------------------------- helpers -------------------------------- */

const BAD = /cancel|fail|reject|refund|expired|no.?show/i;
const PENDING_PAY = /pending.?payment|awaiting.?payment|payment.?pending/i;
const COMPLETE = /complet|visited|attended|delivered/i;

const plain = (s: string, max = 160) =>
  s
    .replace(/[*_`#>]/g, '')
    .replace(/⚠️/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);

/** The first sentence of a model read (the picker's AI read → the pick's "why"). */
export function firstSentence(s: string | undefined, max = 140): string | undefined {
  if (!s) return undefined;
  const t = plain(s, 400);
  if (!t) return undefined;
  const m = t.match(/^(.{12,}?[.!?])(?:\s|$)/);
  return (m ? m[1] : t).slice(0, max);
}

const norm = (s: string | undefined) => (s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const mentions = (hay: string | undefined, needle: string | undefined) => {
  const n = norm(needle);
  return !!n && n.length >= 3 && norm(hay).includes(n);
};

/** Dineout's rate-limit / busy answer — retried later, never replanned (a replan = another search). */
export const isBusy = (reason: string | undefined) => /busy|try again in a|too many|rate.?limit|429/i.test(reason ?? '');
export const BUSY_RETRY_MS = 30_000;
export const MAX_BUSY_RETRIES = 2;

const inr = (n: number) => `₹${Math.round(n).toLocaleString('en-IN')}`;

/** Latest-first search over every message for a card list item. */
function findCard<T>(messages: ChatMessage[], pick: (m: ChatMessage) => T[] | undefined, match: (x: T) => boolean): T | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const hit = pick(messages[i])?.find(match);
    if (hit) return hit;
  }
  return undefined;
}

function findDish(messages: ChatMessage[], id: string): MenuItem | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    for (const g of m.dishGroups ?? []) {
      const d = g.dishes.find((x) => x.id === id);
      if (d) return d;
    }
    for (const c of m.menu?.categories ?? []) {
      const d = c.items.find((x) => x.id === id);
      if (d) return d;
    }
  }
  return undefined;
}

function findProduct(messages: ChatMessage[], spinId: string) {
  for (let i = messages.length - 1; i >= 0; i--) {
    for (const g of messages[i].productGroups ?? []) {
      for (const p of g.products) {
        const v = p.variations.find((x) => x.spinId === spinId);
        if (v) return { product: p, variation: v };
      }
    }
  }
  return undefined;
}

/** Pending cart proposals on one turn for one cart (Plan's ADD lines). */
export function pendingFor(message: ChatMessage, target: 'food' | 'instamart') {
  return (message.proposals ?? []).filter(
    (p) => p.status === 'pending' && p.kind !== 'remove' && (p.target ? p.target === target : target === 'instamart'),
  );
}

/** Index of the first step not yet done that has something to do, or -1. */
export function nextStepIndex(steps: { domain: ItineraryDomain }[], done: ReadonlySet<number>): number {
  return steps.findIndex((s, i) => !done.has(i) && s.domain !== 'other');
}

/** "go ahead", "do it", "run the plan for me" … (a whole message, nothing else). */
export function isRunCommand(text: string): boolean {
  return /^\s*(?:(?:ok(?:ay)?|yes|yep|sure|great|perfect)[,!. ]+)?(?:please[, ]+)?(?:go ahead|do it|run (?:the |my |this )?plan(?: for me)?|start (?:the |my )?plan|carry on|continue the plan|book (?:it|everything) for me)(?: please)?[\s!.]*$/i.test(
    text,
  );
}

/** What the picker's AI read fills in: this stop's time + details + the plan. */
export function planIntentFor(step: ItineraryStep, itinerary: Itinerary): string {
  const what = [step.title, step.detail].filter(Boolean).join(' — ');
  const who = itinerary.party ? `${itinerary.party} people` : '';
  return [step.time, itinerary.date, what, who, itinerary.title && `(${itinerary.title})`].filter(Boolean).join(' · ');
}

/** The read-only planner turn that proposes Food / Instamart picks for a step. */
export function askPrompt(step: ItineraryStep): { text: string; display: string } {
  const what = [step.title, step.detail].filter(Boolean).join(' — ');
  if (step.domain === 'food') {
    return {
      text: `[Plan run] For this plan, find the best delivery dish for: ${what}. Call search_menu, then propose the best pick with an ADD: line (I'll approve it) and keep the itinerary as is.`,
      display: `Pick dinner for the plan`,
    };
  }
  return {
    text: `[Plan run] For this plan, search Instamart for: ${what}. Propose the best 1-3 in-stock picks with ADD: lines (I'll approve them) and keep the itinerary as is.`,
    display: `Pick snacks for the plan`,
  };
}

/** The read-only planner turn that replaces ONE step (failure or the user's ask). */
export function replanPrompt(index: number, step: ItineraryStep, reason: string): { text: string; display: string } {
  const what = [step.time, step.domain, `"${step.title}"`, step.detail].filter(Boolean).join(' · ');
  const extra =
    step.domain === 'dineout'
      ? ' Pick a restaurant that TAKES TABLE BOOKINGS on Swiggy (not walk-in only) and reuse restaurant cards already shown in this chat when one fits — Dineout searches are rate-limited, so search at most once.'
      : step.domain === 'scenes'
        ? ' Pick an event with shows on the plan date that are not sold out; reuse event cards already shown when one fits.'
        : ' Propose the new pick with ADD: lines (I approve them) — in stock only.';
  return {
    text: `[Plan run] Replan step ${index + 1} only (${what}). Reason: ${reason}. Find the best REAL alternative for just this step.${extra} Keep every other step, time and id exactly as they are and re-emit the FULL plan: PLAN TITLE, PLAN INFO and every ITINERARY line. Never book anything.`,
    display: `Replan step ${index + 1}: ${reason.slice(0, 70)}`,
  };
}

const WEEKDAY = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** "Sat 24 Oct" → "Sunday" (the day after the plan's date), else undefined. */
export function nextDayName(date: string | undefined): string | undefined {
  const m = (date ?? '').toLowerCase().match(/\b(sun|mon|tue|wed|thu|fri|sat)/);
  if (!m) return undefined;
  const i = WEEKDAY.findIndex((d) => d.toLowerCase().startsWith(m[1]));
  return WEEKDAY[(i + 1) % 7];
}

/** Read-only planner turns for a requested-but-unavailable part of the plan. */
export function unavailablePrompt(
  u: { what: string; why: string },
  kind: 'other' | 'day',
  itinerary: Itinerary,
): { text: string; display: string } {
  const show = /show|comedy|gig|concert|event|play|standup|stand-up|music|movie|screening/i.test(u.what);
  if (kind === 'other') {
    return {
      text: `[Plan run] I asked for ${u.what}, but ${u.why}. Find a different kind of ${show ? 'show or event on Swiggy Scenes' : 'option'} for the same date and area that fits this outing, add it as a step at a sensible time, keep every other step, time and id exactly as they are, and re-emit the FULL plan (PLAN TITLE, PLAN INFO, every ITINERARY line). If nothing fits either, say so with an UNAVAILABLE line. Never book anything.`,
      display: show ? 'Try another kind of show' : `Try another option for ${u.what}`,
    };
  }
  const day = nextDayName(itinerary.date) ?? 'the next day';
  return {
    text: `[Plan run] Look for ${u.what} on ${day} instead (same area and party). If Swiggy has one, move the outing to ${day}: re-check only the steps whose availability depends on the date (search at most once per service) and re-emit the FULL plan (PLAN TITLE, PLAN INFO, every ITINERARY line). If there is still none, keep the plan and say so with an UNAVAILABLE line. Never book anything.`,
    display: `Try ${day}`,
  };
}

/* -------------------- the plan step's own pick (no LLM) ------------------- */
// When the run opens a picker for a plan step, ONE selection is applied: the
// step's date, the open slot / show nearest the step's time and the party
// size; Dineout prefers a FREE table (highest % off among free) over a paid
// deal unless the plan asked for a paid one. The AI read only explains it.

export interface PlanTarget {
  dateText: string; // where the step's date lives ("Sat 24 Oct", "tonight")
  time?: string; // "7:30 PM"
  party?: number;
  wantPaid?: boolean;
}

export function planTargetFor(step: ItineraryStep, itinerary: Itinerary): PlanTarget {
  const words = [step.title, step.detail].filter(Boolean).join(' ');
  return {
    dateText: [itinerary.date, step.detail, step.title].filter(Boolean).join(' · '),
    ...(step.time ? { time: step.time } : {}),
    ...(itinerary.party ? { party: itinerary.party } : {}),
    ...(/\b(?:prebook|pre-book|paid deal|cover charge|buffet deal)\b/i.test(words) ? { wantPaid: true } : {}),
  };
}

export interface PlanPick {
  sel: PickerSelectFields;
  title: string;
  why: string;
}

type DayHit = { day?: { date: string; label: string }; missing?: string };
function planDay<D extends { date: string; label: string }>(dates: D[], t: PlanTarget, nowMs: number, open: (d: D) => boolean): DayHit & { day?: D } {
  const hit = findDateIn(t.dateText, dates.map((d) => d.date), nowMs);
  if (hit?.key) {
    const day = dates.find((d) => d.date === hit.key);
    return day && open(day) ? { day } : { missing: day?.label ?? hit.key };
  }
  if (hit?.wanted) return { missing: hit.wanted };
  const day = dates.find(open);
  return day ? { day } : {};
}

function nearest(labels: string[], time: string | undefined): string | undefined {
  const want = time ? parseClock(time) : null;
  if (want === null) return labels[0];
  let best: string | undefined;
  let gap = Infinity;
  for (const l of labels) {
    const m = parseClock(l);
    if (m === null) continue;
    const g = Math.abs(m - want);
    if (g < gap) {
      gap = g;
      best = l;
    }
  }
  return best ?? labels[0];
}

/** The Dineout selection for a plan step, or {error} when its date has no open slot. */
export function planPickDineout(snap: DineoutActivePicker, t: PlanTarget, nowMs: number): PlanPick | { error: string } | null {
  const times = (d: DineoutActivePicker['dates'][number]) => Object.values(d.meals).flat();
  const { day, missing } = planDay(snap.dates, t, nowMs, (d) => times(d).length > 0);
  if (!day) return missing ? { error: `No open table slots on ${missing}` } : null;
  const time = nearest(times(day), t.time);
  if (!time) return null;
  const byOff = (a: { discount?: number }, b: { discount?: number }) => (b.discount ?? 0) - (a.discount ?? 0);
  const free = day.deals.filter((d) => d.free).sort(byOff);
  const paid = day.deals.filter((d) => !d.free).sort(byOff);
  const deal = t.wantPaid ? (paid[0] ?? free[0]) : (free[0] ?? paid[0]);
  const guests = t.party ?? snap.guests;
  const dealText = deal ? (deal.free ? `free table${deal.discount ? ` · ${deal.discount}% off` : ''}` : deal.title) : '';
  return {
    sel: {
      date: day.date,
      time,
      guests,
      ...(deal ? { deal: deal.title } : {}),
      // a free table → the picker's Confirm summary (book_table only on the user's tap)
      ...(deal?.free ? { confirm: true } : {}),
    },
    title: [day.label, time, dealText, `${guests} guest${guests === 1 ? '' : 's'}`].filter(Boolean).join(' · '),
    why: [
      t.time ? `Nearest open slot to the plan's ${t.time} on ${day.label}` : `First open slot on ${day.label}`,
      deal
        ? deal.free
          ? `a free table${deal.discount ? ` with ${deal.discount}% off` : ''}${free.length > 1 || paid.length ? ' — the best free deal' : ''}`
          : `${deal.title}${t.wantPaid ? ' (the plan asked for a paid deal)' : ' (no free table that day)'}`
        : '',
    ]
      .filter(Boolean)
      .join(', '),
  };
}

/** The Scenes selection for a plan step, or {error} when its date has no show on sale. */
export function planPickScenes(snap: ScenesActivePicker, t: PlanTarget, nowMs: number): PlanPick | { error: string } | null {
  const onSale = (d: ScenesActivePicker['dates'][number]) => d.shows.filter((s) => !s.soldOut);
  const { day, missing } = planDay(snap.dates, t, nowMs, (d) => onSale(d).length > 0);
  if (!day) return missing ? { error: `No shows on sale on ${missing}` } : null;
  const shows = onSale(day);
  const label = nearest(shows.map((s) => s.timeLabel), t.time);
  const show = shows.find((s) => s.timeLabel === label) ?? shows[0];
  const tickets = snap.tickets
    .filter((x) => !x.onlyOn || x.onlyOn.includes(day.date))
    .sort((a, b) => (a.price ?? Infinity) - (b.price ?? Infinity));
  const ticket = tickets[0];
  const party = t.party ?? 1;
  const qty = ticket && /\b(?:for (?:two|2)|couple|duo|pair)\b/i.test(ticket.name) ? Math.ceil(party / 2) : party;
  return {
    sel: { date: day.date, showId: show.showId, time: show.timeLabel, ...(ticket ? { ticketName: ticket.name, qty } : {}) },
    title: [day.label, show.timeLabel, ticket ? `${qty}× ${ticket.name}` : ''].filter(Boolean).join(' · '),
    why: [
      t.time ? `Show nearest the plan's ${t.time} on ${day.label}` : `First show on sale on ${day.label}`,
      ticket ? `${tickets.length > 1 ? 'the lowest-priced' : 'the'} ticket for ${party}` : '',
    ]
      .filter(Boolean)
      .join(', '),
  };
}

/** The pick for whichever picker this is (what the run applies once it loads). */
export function planPickFor(snap: ActivePicker, t: PlanTarget, nowMs: number): PlanPick | { error: string } | null {
  return snap.kind === 'dineout' ? planPickDineout(snap, t, nowMs) : planPickScenes(snap, t, nowMs);
}

/* -------------------------------- derive --------------------------------- */

/** The latest itinerary turn in the thread (the plan the panel tracks). */
export function latestItinerary(messages: ChatMessage[]): ChatMessage | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.itinerary && m.itinerary.steps.length) return m;
  }
  return undefined;
}

interface Ctx extends DeriveInput {
  scope: ChatMessage[]; // messages from the plan's first itinerary turn on
  itinerary: Itinerary;
}

/** A turn sent at/after `at` has finished streaming. */
function replyDone(ctx: Ctx, at: number): boolean {
  if (ctx.sending) return false;
  return ctx.scope.some((m) => m.role === 'assistant' && !m.pending && (m.createdAt ?? 0) >= at - 1000);
}

function bookingFrom(
  ctx: Ctx,
  kind: 'dineout' | 'scenes',
  name: string,
  pickerAt: number,
): { orderId?: string; status: string; amount?: number } | null {
  // this app's tracker card (book_table / free tickets)
  for (let i = ctx.scope.length - 1; i >= 0; i--) {
    const t = ctx.scope[i].bookingTracker;
    if (t && t.kind === kind && (mentions(t.title, name) || mentions(t.place, name) || mentions(t.details, name))) {
      return { orderId: t.orderId, status: ctx.liveStatus?.[t.orderId] ?? t.status, amount: t.amount };
    }
  }
  // saved bookings (UPI flows have no tracker card until payment)
  const b = (ctx.bookings ?? []).find(
    (x) => x.kind === kind && x.createdAt >= Math.min(pickerAt, ctx.run.startedAt || pickerAt) && mentions(x.title, name),
  );
  if (b) {
    const paid = ctx.scope.some((m) => m.id.startsWith('pay-succ-') && m.text.includes(b.orderId.slice(-8)));
    return { orderId: b.orderId, status: ctx.liveStatus?.[b.orderId] ?? (paid ? 'CONFIRMED' : 'PENDING_PAYMENT') };
  }
  return null;
}

function applyBooking(v: StepView, b: { orderId?: string; status: string; amount?: number }, kind: 'dineout' | 'scenes', ctx: Ctx) {
  const status = b.status || 'PLACED';
  v.booking = { kind, orderId: b.orderId, status };
  if (BAD.test(status)) {
    v.status = 'failed';
    v.reason = `Swiggy says ${status.replace(/_/g, ' ').toLowerCase()}`;
    v.label = 'Booking not confirmed';
  } else if (PENDING_PAY.test(status)) {
    v.status = 'confirm';
    v.label = ctx.paymentOpen ? 'Waiting for your UPI payment' : 'Payment pending on Swiggy';
    v.confirm = { kind: 'payment', label: 'Complete the payment in the payment sheet' };
  } else if (COMPLETE.test(status)) {
    v.status = 'done';
    v.label = 'Done';
  } else {
    v.status = 'booked';
    v.label = kind === 'dineout' ? `Table booked · ${status.replace(/_/g, ' ').toLowerCase()}` : `Tickets booked · ${status.replace(/_/g, ' ').toLowerCase()}`;
  }
  if (typeof b.amount === 'number' && b.amount > 0 && v.status !== 'failed') v.spent = b.amount;
}

const pickSel = (t: PlanPick | { error: string } | null) => (t && 'sel' in t ? t.sel : undefined);
const sameClock = (a?: string, b?: string) => !!a && !!b && parseClock(a) === parseClock(b);

/** The pick's one-line why: the plan's own rule, or a note that it was changed. */
function whyFor(target: PlanPick | { error: string } | null, matches: boolean): string | undefined {
  if (!target || 'error' in target) return undefined;
  return matches ? target.why : `Changed from the plan's pick (${target.title})`;
}

function base(index: number, step: ItineraryStep): StepView {
  return { index, step, status: 'planned', label: 'Planned', name: step.title, facts: [], next: null };
}

/** Common overrides after the domain-specific booking check. Returns true if decided. */
function common(v: StepView, ctx: Ctx): boolean {
  const i = String(v.index);
  if (ctx.run.skipped.includes(v.index)) {
    v.status = 'skipped';
    v.label = 'Skipped';
    return true;
  }
  const act = ctx.run.acted[i];
  if (act?.kind === 'replan' && !replyDone(ctx, act.at)) {
    v.status = 'searching';
    v.label = 'Replanning this step…';
    return true;
  }
  const f = ctx.run.failedRefs[i];
  if (f && f.ref === v.step.ref) {
    v.status = 'failed';
    v.reason = f.reason;
    v.label = 'Needs a new option';
    return true;
  }
  return false;
}

function deriveDineout(v: StepView, ctx: Ctx) {
  const { step } = v;
  const r: DineoutRestaurant | undefined = step.ref
    ? findCard(ctx.messages, (m) => m.dineoutRestaurants, (x) => x.id === step.ref)
    : undefined;
  if (r) {
    v.name = r.name;
    v.imageUrl = r.imageUrl;
    v.facts = [
      [r.locality, r.area].filter(Boolean).join(', '),
      r.distance ? `${r.distance} away` : '',
      typeof r.rating === 'number' ? `★ ${r.rating}` : '',
      r.costForTwo ?? '',
      r.offers?.[0] ?? '',
    ].filter(Boolean);
  }
  const name = r?.name ?? step.title;
  // the latest slot picker for this restaurant (a chat PICK may have moved it down)
  let pm: ChatMessage | undefined;
  for (let k = ctx.scope.length - 1; k >= 0; k--) {
    if (step.ref && ctx.scope[k].dineoutSlots?.restaurantId === step.ref) {
      pm = ctx.scope[k];
      break;
    }
  }
  const b = bookingFrom(ctx, 'dineout', name, pm?.createdAt ?? ctx.run.startedAt);
  if (b) return applyBooking(v, b, 'dineout', ctx);
  if (common(v, ctx)) return;

  // book_table came back with Swiggy's error (no tracker card)
  const failed = ctx.scope.find(
    (m) => m.id.startsWith('do-book-') && !m.bookingTracker && m.text.includes(name) && (m.createdAt ?? 0) >= (pm?.createdAt ?? 0),
  );
  if (failed) {
    v.status = 'failed';
    v.reason = plain(failed.text);
    v.label = 'Booking failed';
    return;
  }
  // the latest slot load that came back empty (walk-in only / busy / error) —
  // it counts only if nothing newer (a picker, or a retry) came after it
  const openAct = ctx.run.acted[String(v.index)];
  let tried: ChatMessage | undefined;
  for (let k = ctx.scope.length - 1; k > 0; k--) {
    const m = ctx.scope[k];
    if (
      m.id.startsWith('do-slots-') &&
      !m.id.startsWith('do-slots-u-') &&
      m.role === 'assistant' &&
      !m.pending &&
      !m.dineoutSlots &&
      !m.pickerMoved &&
      ctx.scope[k - 1]?.text === `Show table slots at ${name}`
    ) {
      tried = m;
      break;
    }
  }
  const triedAt = tried?.createdAt ?? 0;
  if (
    tried &&
    (!pm || triedAt > (pm.createdAt ?? 0)) &&
    !(openAct?.kind === 'open' && openAct.ref === step.ref && openAct.at > triedAt + 1000)
  ) {
    v.status = 'failed';
    v.reason = plain(tried.text);
    v.label = isBusy(v.reason) ? 'Dineout is busy' : 'No table slots';
    return;
  }
  if (pm) {
    v.pickerId = pm.id;
    const snap = ctx.snapshot(pm.id);
    if (snap && snap.kind === 'dineout') {
      const open = snap.dates.reduce((a, d) => a + Object.values(d.meals).reduce((x, t) => x + t.length, 0), 0);
      if (!open) {
        v.status = 'failed';
        v.reason = 'No open table slots on Swiggy for the next 7 days';
        v.label = 'Fully booked';
        return;
      }
      const sel = snap.selection;
      const guests = sel?.guests ?? snap.guests;
      v.party = guests;
      const target = planPickDineout(snap, planTargetFor(step, ctx.itinerary), ctx.now);
      if (!(sel?.time && sel.deal) && target && 'error' in target) {
        v.status = 'failed';
        v.reason = target.error;
        v.label = 'No table that day';
        return;
      }
      if (sel?.time && sel.deal) {
        const d = snap.dates.find((x) => x.date === sel.date);
        const deal = d?.deals.find((x) => x.title === sel.deal);
        v.date = d?.label;
        v.pick = {
          title: [
            d?.label,
            sel.time,
            deal ? (deal.free ? 'free table' : deal.title) : sel.deal,
            deal?.discount ? `${deal.discount}% off` : '',
            `${guests} guest${guests === 1 ? '' : 's'}`,
          ]
            .filter(Boolean)
            .join(' · '),
          // always about the CURRENT selection (never a stale model line)
          why: whyFor(target, sel.date === pickSel(target)?.date && sameClock(sel.time, pickSel(target)?.time) && sel.deal === pickSel(target)?.deal),
        };
        if (deal && !deal.free && deal.price) v.lined = deal.price;
        const reading = !!pm.status;
        v.status = reading ? 'picked' : 'confirm';
        v.label = reading ? 'Picked — reading live availability…' : 'Waiting for you to confirm';
        v.confirm = { kind: 'picker', messageId: pm.id, label: deal && !deal.free ? 'Review & pay in picker' : 'Confirm table' };
        return;
      }
      v.status = 'options';
      v.label = `${open} open slot${open === 1 ? '' : 's'} across ${snap.dates.filter((d) => Object.values(d.meals).some((t) => t.length)).length} days`;
      v.confirm = { kind: 'picker', messageId: pm.id, label: 'Choose a slot' };
      return;
    }
    if (!snap && pm.dineoutSlots) {
      v.status = 'options';
      v.label = 'Slot picker ready';
      v.confirm = { kind: 'picker', messageId: pm.id, label: 'Open slot picker' };
      return;
    }
  }
  const act = ctx.run.acted[String(v.index)];
  if (act?.kind === 'open' && act.ref === step.ref) {
    const loading = ctx.scope.some((m) => m.id.startsWith('do-slots-') && m.pending);
    if (loading || ctx.now - act.at < OPEN_TIMEOUT_MS) {
      v.status = 'searching';
      v.label = 'Checking live table slots…';
      return;
    }
    v.status = 'failed';
    v.reason = "Swiggy didn't return table slots in time";
    v.label = 'No table slots';
    return;
  }
  if (r?.bookable === false) {
    v.status = 'failed';
    v.reason = 'Walk-in only — Swiggy takes no table bookings at this restaurant';
    v.label = 'Walk-in only';
    return;
  }
  if (!r) {
    v.status = 'failed';
    v.reason = step.ref ? 'This restaurant card is no longer in the chat' : 'No bookable restaurant was found for this step';
    v.label = 'Needs a restaurant';
    return;
  }
  v.next = 'open';
  v.label = 'Ready to check live slots';
}

function deriveScenes(v: StepView, ctx: Ctx) {
  const { step } = v;
  const e: ScenesEvent | undefined = step.ref
    ? findCard(ctx.messages, (m) => m.scenesEvents, (x) => x.id === step.ref)
    : undefined;
  if (e) {
    v.name = e.title;
    v.facts = [
      [e.venueName, e.area].filter(Boolean).join(', '),
      typeof e.distanceKm === 'number' ? `${e.distanceKm.toFixed(1)} km away` : '',
      e.dateSummary ?? '',
      e.priceText ?? '',
    ].filter(Boolean);
  }
  const name = e?.title ?? step.title;
  let pm: ChatMessage | undefined;
  for (let k = ctx.scope.length - 1; k >= 0; k--) {
    if (step.ref && ctx.scope[k].scenesShows?.eventId === step.ref) {
      pm = ctx.scope[k];
      break;
    }
  }
  const b = bookingFrom(ctx, 'scenes', name, pm?.createdAt ?? ctx.run.startedAt);
  if (b) return applyBooking(v, b, 'scenes', ctx);
  if (common(v, ctx)) return;
  if (pm) {
    v.pickerId = pm.id;
    const snap = ctx.snapshot(pm.id);
    if (snap && snap.kind === 'scenes') {
      const shows = snap.dates.flatMap((d) => d.shows);
      if (!shows.length) {
        v.status = 'failed';
        v.reason = 'Swiggy lists no upcoming shows for this event';
        v.label = 'No shows';
        return;
      }
      if (shows.every((s) => s.soldOut)) {
        v.status = 'failed';
        v.reason = 'Every show is sold out on Swiggy';
        v.label = 'Sold out';
        return;
      }
      const sel = snap.selection;
      const target = planPickScenes(snap, planTargetFor(step, ctx.itinerary), ctx.now);
      if (!(sel?.showId && sel.ticketName) && target && 'error' in target) {
        v.status = 'failed';
        v.reason = target.error;
        v.label = 'No show that day';
        return;
      }
      if (sel?.showId && sel.ticketName) {
        const t = snap.tickets.find((x) => x.name === sel.ticketName);
        const d = snap.dates.find((x) => x.date === sel.date);
        const qty = sel.qty ?? 1;
        v.party = qty;
        v.date = d?.label;
        v.pick = {
          title: [d?.label, sel.timeLabel, `${qty}× ${sel.ticketName}`, typeof t?.price === 'number' ? (t.price ? `${inr(t.price)} each` : 'free') : '']
            .filter(Boolean)
            .join(' · '),
          why: whyFor(target, sel.showId === pickSel(target)?.showId && sel.ticketName === pickSel(target)?.ticketName && qty === pickSel(target)?.qty),
        };
        if (typeof t?.price === 'number' && t.price > 0) v.lined = t.price * qty;
        const reading = !!pm.status;
        v.status = reading ? 'picked' : 'confirm';
        v.label = reading ? 'Picked — reading live availability…' : 'Waiting for you to confirm';
        v.confirm = { kind: 'picker', messageId: pm.id, label: 'Review & confirm tickets' };
        return;
      }
      const from = Math.min(...snap.tickets.map((t) => t.price ?? Infinity));
      v.status = 'options';
      v.label = `${shows.filter((s) => !s.soldOut).length} show${shows.length === 1 ? '' : 's'} on sale${Number.isFinite(from) ? ` · from ${inr(from)}` : ''}`;
      v.confirm = { kind: 'picker', messageId: pm.id, label: 'Choose a show' };
      return;
    }
    // the picker loads its listing itself; it finished (payment sheet) or never loaded
    if (ctx.paymentOpen) {
      v.status = 'confirm';
      v.label = 'Waiting for your UPI payment';
      v.confirm = { kind: 'payment', label: 'Complete the payment in the payment sheet' };
      return;
    }
    const since = ctx.run.acted[String(v.index)]?.at ?? pm.createdAt ?? ctx.now;
    if (ctx.now - since < OPEN_TIMEOUT_MS) {
      v.status = 'searching';
      v.label = 'Loading shows & tickets…';
      return;
    }
    v.status = 'failed';
    v.reason = "Swiggy didn't return the shows for this event";
    v.label = 'No shows';
    return;
  }
  const act = ctx.run.acted[String(v.index)];
  if (act?.kind === 'open' && act.ref === step.ref && ctx.now - act.at < OPEN_TIMEOUT_MS) {
    v.status = 'searching';
    v.label = 'Opening the ticket picker…';
    return;
  }
  if (!e) {
    v.status = 'failed';
    v.reason = step.ref ? 'This event card is no longer in the chat' : 'No Swiggy event was found for this step';
    v.label = 'Needs an event';
    return;
  }
  v.next = 'open';
  v.label = 'Ready to check shows';
}

function deriveCart(v: StepView, ctx: Ctx, target: 'food' | 'instamart') {
  const { step } = v;
  if (target === 'food') {
    const d = step.ref ? findDish(ctx.messages, step.ref) : undefined;
    if (d) {
      v.name = d.name;
      v.imageUrl = d.imageUrl || undefined;
      v.facts = [d.restaurantName, `${inr(d.price)}`, d.veg ? 'veg' : 'non-veg', d.rating ? `★ ${d.rating}` : ''].filter(Boolean);
      if (d.inStock === false) {
        v.status = 'failed';
        v.reason = `${d.name} is out of stock on Swiggy right now`;
        v.label = 'Out of stock';
      }
    }
  } else {
    const p = step.ref ? findProduct(ctx.messages, step.ref) : undefined;
    if (p) {
      v.name = p.product.name;
      v.imageUrl = p.variation.imageUrl || undefined;
      v.facts = [p.variation.quantityDescription, inr(p.variation.offerPrice), p.variation.sla ?? ''].filter(Boolean);
      if (!p.variation.inStock) {
        v.status = 'failed';
        v.reason = `${p.product.name} is out of stock on Instamart`;
        v.label = 'Out of stock';
      }
    }
  }
  // proposals for this cart since the plan started (the planner's ADD lines)
  const props: { messageId: string; pid: string; name: string; detail?: string; status: string }[] = [];
  let basketMsg: ChatMessage | undefined;
  for (const m of ctx.scope) {
    for (const p of m.proposals ?? []) {
      if (p.kind === 'remove') continue;
      if ((p.target ?? 'instamart') !== target) continue;
      props.push({ messageId: m.id, pid: p.pid, name: p.name, detail: p.detail, status: p.status });
    }
    if (target === 'instamart' && m.basket) basketMsg = m;
  }
  const approved = props.filter((p) => p.status === 'approved');
  const pending = props.filter((p) => p.status === 'pending');
  const basketApproved = basketMsg?.basket?.status === 'approved';
  // a live order tracker in this thread (Food / Instamart)
  const tracked = [...ctx.scope].reverse().find((m) => m.tracker?.service === target);
  if (tracked?.tracker && (approved.length || basketApproved)) {
    v.status = COMPLETE.test(tracked.tracker.status) ? 'done' : 'booked';
    v.booking = { kind: target, status: tracked.tracker.status };
    v.label = `Ordered · ${tracked.tracker.status}${tracked.tracker.eta ? ` · ${tracked.tracker.eta}` : ''}`;
    return;
  }
  if (approved.length || basketApproved) {
    const cart = target === 'food' ? ctx.foodCart : ctx.instamartCart;
    const names = approved.map((p) => p.name);
    const inCart =
      target === 'food'
        ? (ctx.foodCart?.items ?? []).some((x) => x.menuItemId === step.ref || names.includes(x.name))
        : (ctx.instamartCart?.items ?? []).some((x) => x.spinId === step.ref || names.includes(x.name));
    v.status = 'booked';
    v.pick = { title: names.join(', ') || (basketMsg?.basket?.title ?? 'Basket') };
    const total = target === 'food' ? ctx.foodCart?.toPay : ctx.instamartCart?.total;
    v.label = inCart || basketApproved
      ? `Added to your ${target === 'food' ? 'Food' : 'Instamart'} cart${total && total > 0 ? ` · ${inr(total)} to pay at checkout` : ''}`
      : `Added to your ${target === 'food' ? 'Food' : 'Instamart'} cart`;
    if (cart && total && total > 0 && (inCart || basketApproved)) v.lined = total;
    return;
  }
  if (common(v, ctx)) return;
  if (v.status === 'failed') return; // out of stock
  if (pending.length) {
    v.status = 'confirm';
    const msg = ctx.scope.find((m) => m.id === pending[0].messageId);
    v.pick = {
      title: pending.map((p) => (p.detail ? `${p.name} (${p.detail})` : p.name)).join(', '),
      why: (step.ref && msg?.bestPicks?.[step.ref]) || undefined,
    };
    v.label = 'Waiting for you to add it';
    v.confirm = {
      kind: 'proposals',
      items: pending.map((p) => ({ messageId: p.messageId, pid: p.pid })),
      label:
        target === 'food'
          ? pending.length === 1
            ? `Add ${pending[0].name} to Food cart`
            : `Add ${pending.length} dishes to Food cart`
          : pending.length === 1
            ? `Add ${pending[0].name} to Instamart cart`
            : `Add ${pending.length} items to Instamart cart`,
    };
    return;
  }
  if (basketMsg?.basket?.status === 'pending' || (basketMsg?.basket && !basketMsg.basket.status)) {
    v.status = 'confirm';
    v.pick = { title: `${basketMsg.basket.title} · ${basketMsg.basket.lines.length} items · ${inr(basketMsg.basket.itemTotal)}` };
    v.label = 'Waiting for you to approve the basket';
    v.confirm = { kind: 'basket', messageId: basketMsg.id, label: 'Review basket in chat' };
    return;
  }
  const act = ctx.run.acted[String(v.index)];
  if (act?.kind === 'ask') {
    if (!replyDone(ctx, act.at)) {
      v.status = 'searching';
      v.label = target === 'food' ? 'Finding the best delivery dish…' : 'Finding the best snacks…';
      return;
    }
    v.status = 'failed';
    v.reason = props.length
      ? 'The proposal expired (page reloaded) or was dismissed'
      : `The planner found nothing to propose${target === 'food' ? ' for delivery' : ' on Instamart'}`;
    v.label = 'No pick yet';
    return;
  }
  v.next = 'ask';
  v.label = props.length ? 'Proposal expired — ready to re-pick' : 'Ready to pick';
}

/** The whole live plan (null when the thread has no itinerary yet). */
export function derivePlan(input: DeriveInput): PlanView | null {
  const latest = latestItinerary(input.messages);
  if (!latest?.itinerary) return null;
  const itinerary = latest.itinerary;
  const firstId = input.run.planIds.find((id) => input.messages.some((m) => m.id === id));
  const start = Math.max(0, input.messages.findIndex((m) => m.id === (firstId ?? latest.id)));
  const ctx: Ctx = { ...input, scope: input.messages.slice(start), itinerary };

  const steps = itinerary.steps.map((step, index) => {
    const v = base(index, step);
    const rep = input.run.replaced[String(index)];
    if (rep) v.replacedFrom = rep;
    switch (step.domain) {
      case 'dineout':
        deriveDineout(v, ctx);
        break;
      case 'scenes':
        deriveScenes(v, ctx);
        break;
      case 'food':
        deriveCart(v, ctx, 'food');
        break;
      case 'instamart':
        deriveCart(v, ctx, 'instamart');
        break;
      default:
        v.status = 'info';
        v.label = 'Nothing to book';
        if (step.detail) v.facts = [step.detail];
    }
    if (step.domain !== 'other' && !v.facts.length && step.detail) v.facts = [step.detail];
    return v;
  });

  const current = steps.findIndex((s) => !TERMINAL.has(s.status));
  // stops with nothing to book read as done once the run is past them
  for (const s of steps) {
    if (s.status === 'info' && input.run.mode !== 'idle' && (current < 0 || s.index < current)) {
      s.status = 'done';
      s.label = 'Done';
    }
  }
  const actionable = steps.filter((s) => s.step.domain !== 'other');
  const doneCount = actionable.filter((s) => s.status === 'booked' || s.status === 'done').length;
  const spent = steps.reduce((a, s) => a + (s.spent ?? 0), 0);
  const lined = steps.reduce((a, s) => a + (s.lined ?? 0), 0);
  const view: PlanView = {
    planId: latest.id,
    itinerary,
    steps,
    title: itinerary.title || 'Your outing plan',
    date: itinerary.date ?? steps.find((s) => s.date)?.date,
    party: itinerary.party ?? steps.find((s) => s.party)?.party,
    budget: itinerary.budget ?? (input.budget && input.budget > 0 ? input.budget : undefined),
    spent,
    lined,
    doneCount,
    actionable: actionable.length,
    current,
    nowLine: '',
  };
  view.nowLine = nowLine(view, input.run, !!input.sending);
  return view;
}

/** The one-line "what's happening now" under the panel header. */
export function nowLine(view: PlanView, run: PlanRunState, sending: boolean): string {
  const cur = view.current >= 0 ? view.steps[view.current] : undefined;
  if (!cur) return view.actionable ? 'Every step is handled — enjoy the outing!' : 'Nothing to book in this plan.';
  const n = `Step ${cur.index + 1}`;
  if (run.mode === 'paused') return run.note || `Paused at ${n} — tap Resume to carry on.`;
  if (run.mode === 'idle') {
    if (cur.status === 'confirm') return `${n}: ${cur.label.toLowerCase()} — or tap Run plan for me.`;
    return 'Plan ready — tap Run plan for me and I’ll work through it, stopping only for your confirms.';
  }
  switch (cur.status) {
    case 'planned':
      return `${n}: starting ${cur.name}…`;
    case 'searching':
      return `${n}: ${cur.label.replace(/…$/, '')} for ${cur.name}…`;
    case 'options':
      return `${n}: live options loaded for ${cur.name} — choosing the best one…`;
    case 'picked':
      return `${n}: picked ${cur.pick?.title ?? cur.name} — reading availability…`;
    case 'confirm':
      return cur.confirm?.kind === 'payment'
        ? `${n}: waiting for your payment for ${cur.name}.`
        : `${n}: waiting for you — ${cur.confirm?.label ?? 'confirm'} (${cur.name}).`;
    case 'failed':
      return sending ? `${n}: replanning — ${cur.reason ?? 'it failed'}.` : `${n}: ${cur.reason ?? 'it failed'} — finding an alternative…`;
    default:
      return `${n}: ${cur.label}`;
  }
}

/* --------------------------------- decide -------------------------------- */

export type RunAction =
  | { type: 'none' }
  | { type: 'open'; index: number }
  | { type: 'retry'; index: number } // re-open the same picker (Dineout was busy)
  | { type: 'ask'; index: number }
  | { type: 'replan'; index: number; reason: string }
  | { type: 'wait'; index: number }
  | { type: 'pause'; index: number; reason: string }
  | { type: 'finish' };

/**
 * The autonomous run's next move. Never anything irreversible: 'open' loads a
 * picker (read-only) pre-filled with the AI's pick, 'ask' / 'replan' are
 * read-only planner turns, 'wait' stops for the user's Confirm.
 */
export function decideNext(view: PlanView, run: PlanRunState, opts: { sending: boolean; now: number }): RunAction {
  if (run.mode !== 'running') return { type: 'none' };
  const cur = view.current >= 0 ? view.steps[view.current] : undefined;
  if (!cur) return { type: 'finish' };
  const i = cur.index;
  switch (cur.status) {
    case 'planned':
      if (cur.next === 'open') {
        if (cur.step.domain === 'dineout' && run.lastDineoutAt && opts.now - run.lastDineoutAt < DINEOUT_SPACING_MS) {
          return { type: 'none' };
        }
        return { type: 'open', index: i };
      }
      if (cur.next === 'ask') return opts.sending ? { type: 'none' } : { type: 'ask', index: i };
      return { type: 'none' };
    case 'failed': {
      if (opts.sending) return { type: 'none' };
      const reason = cur.reason || 'it could not go ahead';
      // Dineout busy (rate limit) → the same picker again a bit later, not a new search
      if (cur.step.domain === 'dineout' && isBusy(reason)) {
        const tries = run.replans[`${i}:busy`] ?? 0;
        if (tries < MAX_BUSY_RETRIES) {
          const since = opts.now - Math.max(run.acted[String(i)]?.at ?? 0, run.lastDineoutAt ?? 0);
          return since >= BUSY_RETRY_MS ? { type: 'retry', index: i } : { type: 'none' };
        }
        return { type: 'pause', index: i, reason: `Step ${i + 1}: Dineout is still busy — try again in a minute (tap Try again).` };
      }
      if ((run.replans[String(i)] ?? 0) < MAX_AUTO_REPLANS) return { type: 'replan', index: i, reason };
      return { type: 'pause', index: i, reason: `Step ${i + 1} needs you: ${reason}. Tap Replan step, Skip step, or pick another option.` };
    }
    case 'confirm':
      return { type: 'wait', index: i };
    default:
      return { type: 'none' };
  }
}

/* ------------------------------ run reducers ----------------------------- */

/** Record an action the run (or a tap) just started for a step. */
export function markActed(run: PlanRunState, index: number, kind: StepAct['kind'], ref: string | undefined, now: number): PlanRunState {
  const k = String(index);
  const next: PlanRunState = { ...run, acted: { ...run.acted, [k]: { kind, at: now, ...(ref ? { ref } : {}) } } };
  if (kind === 'replan') next.replans = { ...run.replans, [k]: (run.replans[k] ?? 0) + 1 };
  return next;
}

/** A failure the run replans away from: the same card stays failed after the replan. */
export function markFailed(run: PlanRunState, index: number, ref: string | undefined, reason: string): PlanRunState {
  return { ...run, failedRefs: { ...run.failedRefs, [String(index)]: { ...(ref ? { ref } : {}), reason } } };
}

/**
 * A new itinerary turn appeared. Same plan (run active, or same title) → it
 * joins the lineage and changed steps are logged as replans; otherwise it is a
 * brand-new plan and the run starts fresh.
 */
export function adoptItinerary(run: PlanRunState, prev: Itinerary | undefined, msg: ChatMessage, now: number): PlanRunState {
  const it = msg.itinerary!;
  if (run.planIds.includes(msg.id)) return run;
  const sameTitle = !!prev?.title && norm(prev.title) === norm(it.title);
  const continuing = run.planIds.length > 0 && (run.mode !== 'idle' || sameTitle || Object.keys(run.acted).length > 0);
  if (!continuing) {
    const fresh: PlanRunState = { ...emptyRun(), planIds: [msg.id], startedAt: now };
    const counts = [
      msg.scenesEvents?.length ? `${msg.scenesEvents.length} event${msg.scenesEvents.length === 1 ? '' : 's'}` : '',
      msg.dineoutRestaurants?.length ? `${msg.dineoutRestaurants.length} restaurant${msg.dineoutRestaurants.length === 1 ? '' : 's'}` : '',
      msg.dishGroups?.length ? `${msg.dishGroups.reduce((a, g) => a + g.dishes.length, 0)} dishes` : '',
      msg.productGroups?.length ? `${msg.productGroups.reduce((a, g) => a + g.products.length, 0)} products` : '',
    ].filter(Boolean);
    return withLog(fresh, {
      at: now,
      text: `Built “${it.title || 'your plan'}” — ${it.steps.length} stops${counts.length ? ` from live Swiggy results: ${counts.join(', ')}` : ''}`,
      tone: 'ok',
    });
  }
  let next: PlanRunState = { ...run, planIds: [...run.planIds, msg.id] };
  const changed: string[] = [];
  it.steps.forEach((s, i) => {
    const old = prev?.steps[i];
    if (!old || (old.ref === s.ref && norm(old.title) === norm(s.title))) return;
    const k = String(i);
    const reason = run.failedRefs[k]?.reason;
    next = {
      ...next,
      replaced: { ...next.replaced, [k]: { from: old.title, ...(reason ? { reason } : {}) } },
      lastLogged: { ...next.lastLogged, [k]: '' },
    };
    changed.push(`step ${i + 1}: ${old.title} → ${s.title}`);
  });
  return withLog(next, {
    at: now,
    text: changed.length ? `Plan updated — ${changed.join('; ')}` : 'Plan re-checked — every step kept',
    tone: changed.length ? 'ok' : 'info',
  });
}

/** One neat log line for a step's new status (or null when not worth a line). */
export function describeStep(v: StepView): { text: string; tone: PlanLogEntry['tone'] } | null {
  const n = `Step ${v.index + 1}`;
  switch (v.status) {
    case 'searching':
      return { text: `${n}: ${v.label.replace(/…$/, '')} — ${v.name}`, tone: 'info' };
    case 'options':
      return { text: `${n}: ${v.name} — ${v.label}`, tone: 'info' };
    case 'picked':
      return null; // the 'confirm' line carries the (final) pick
    case 'confirm':
      if (v.confirm?.kind === 'payment') return { text: `${n}: waiting for your payment — ${v.name}`, tone: 'wait' };
      return {
        text: `${n}: ${v.pick ? `${v.pick.title}${v.step.domain === 'dineout' || v.step.domain === 'scenes' ? ` at ${v.name}` : ''}${v.pick.why ? ` — ${v.pick.why}` : ''}. ` : ''}Waiting for you: ${v.confirm?.label ?? 'confirm'}`,
        tone: 'wait',
      };
    case 'booked':
      return {
        text: `${n}: ${v.label} — ${v.name}${v.booking?.orderId ? ` (order ${v.booking.orderId})` : ''}`,
        tone: 'ok',
      };
    case 'done':
      return v.step.domain === 'other' ? null : { text: `${n}: done — ${v.name}`, tone: 'ok' };
    case 'failed':
      return { text: `${n}: ${v.name} — ${v.reason ?? v.label}`, tone: 'warn' };
    case 'skipped':
      return { text: `${n}: skipped — ${v.name}`, tone: 'info' };
    default:
      return null;
  }
}

/** Log every step whose status line changed since the last log (dedup per step). */
export function logTransitions(run: PlanRunState, view: PlanView, now: number): PlanRunState {
  let next = run;
  for (const s of view.steps) {
    const d = describeStep(s);
    const k = String(s.index);
    const sig = d ? d.text : `:${s.status}`;
    if ((run.lastLogged[k] ?? '') === sig) continue;
    next = { ...next, lastLogged: { ...next.lastLogged, [k]: sig } };
    if (d) next = withLog(next, { at: now, text: d.text, tone: d.tone, step: s.index });
  }
  return next;
}
