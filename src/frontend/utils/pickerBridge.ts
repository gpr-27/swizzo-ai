// Chat → open picker bridge (client). Each mounted ticket / slot picker
// registers under its chat message id with
//   snapshot() — its live listing + current selection (sent with a chat turn)
//   apply(sel) — select inside its OWN live data (never books)
// The chat hook reads snapshots and routes `pickerSelect` stream events here.
// A selection for a picker that hasn't registered yet (its listing is still
// loading) waits and is applied once it registers.

import type { ActivePicker, PickerSelectFields } from '@/shared/types';

export interface PickerEntry {
  kind: 'scenes' | 'dineout';
  /** null once the picker finished (booked / payment started) */
  snapshot: () => ActivePicker | null;
  apply: (sel: PickerSelectFields) => void;
  /** the model's one-line reasons for the AI PICKS strip */
  reasons?: (r: { id: string; why: string }[]) => void;
  /** the selection of its top AI pick (one-tap "Book best" from results) */
  best?: () => PickerSelectFields | null;
}

const entries = new Map<string, PickerEntry>();
const pending = new Map<string, PickerSelectFields>();
const pendingReasons = new Map<string, { id: string; why: string }[]>();
const pendingBest = new Set<string>();
const pendingPlan = new Map<string, PlanPickResolver>();
const readyListeners = new Set<(messageId: string, kind: PickerEntry['kind']) => void>();

/** Called whenever a picker registers with its listing loaded (→ AI read on open). */
export function onPickerReady(fn: (messageId: string, kind: PickerEntry['kind']) => void): () => void {
  readyListeners.add(fn);
  return () => {
    readyListeners.delete(fn);
  };
}

// "Show this picker" requests. A picker lives in a popup (PickerPopup) that stays
// closed until the user taps its card — or until something the user just asked
// for (a card tap, a chat selection, "Book best") needs it on screen. Requests
// made before the popup mounts are remembered by message id.
const openRequested = new Set<string>();
const openListeners = new Map<string, Set<() => void>>();

export function requestPickerOpen(messageId: string): void {
  if (autoCartHold) return; // the Plan tab's autonomous run never pops a sheet
  const ls = openListeners.get(messageId);
  if (ls && ls.size) ls.forEach((fn) => fn());
  else openRequested.add(messageId);
}

/** Subscribe a popup to open requests; returns whether one was already waiting. */
export function watchPickerOpen(messageId: string, fn: () => void): { waiting: boolean; stop: () => void } {
  const waiting = openRequested.delete(messageId);
  let set = openListeners.get(messageId);
  if (!set) openListeners.set(messageId, (set = new Set()));
  set.add(fn);
  return {
    waiting,
    stop: () => {
      set.delete(fn);
      if (!set.size) openListeners.delete(messageId);
    },
  };
}

export function registerPicker(messageId: string, entry: PickerEntry): () => void {
  entries.set(messageId, entry);
  const waiting = pending.get(messageId);
  if (waiting) {
    pending.delete(messageId);
    queueMicrotask(() => entry.apply(waiting));
  }
  const why = pendingReasons.get(messageId);
  if (why) {
    pendingReasons.delete(messageId);
    queueMicrotask(() => entry.reasons?.(why));
  }
  if (pendingBest.has(messageId)) {
    pendingBest.delete(messageId);
    queueMicrotask(() => applyBest(entry));
  }
  const plan = pendingPlan.get(messageId);
  if (plan) {
    pendingPlan.delete(messageId);
    queueMicrotask(() => applyPlan(entry, plan));
  }
  queueMicrotask(() => readyListeners.forEach((fn) => fn(messageId, entry.kind)));
  return () => {
    if (entries.get(messageId) === entry) entries.delete(messageId);
  };
}

/** The open picker's snapshot, or null when it isn't mounted / is finished. */
export function pickerSnapshot(messageId: string): ActivePicker | null {
  try {
    return entries.get(messageId)?.snapshot() ?? null;
  } catch {
    return null;
  }
}

/** Hand a selection to the picker of `messageId` (queued if not mounted yet). */
export function sendToPicker(messageId: string, sel: PickerSelectFields): void {
  requestPickerOpen(messageId);
  const entry = entries.get(messageId);
  if (entry) entry.apply(sel);
  else pending.set(messageId, sel);
}

/** Hand the model's AI-pick reasons to a picker (queued if not mounted yet). */
export function sendReasons(messageId: string, reasons: { id: string; why: string }[]): void {
  const entry = entries.get(messageId);
  if (entry?.reasons) entry.reasons(reasons);
  else pendingReasons.set(messageId, reasons);
}

// While the Plan tab's autonomous run is active, a chat / AI-read PICK with
// confirm=1 only SELECTS — it never creates a cart by itself (Dineout paid
// create_cart / Scenes create_event_cart wait for the user's own tap).
let autoCartHold = false;
export function setAutoCartHold(on: boolean): void {
  autoCartHold = on;
}
export function autoCartHeld(): boolean {
  return autoCartHold;
}

/** Computes a plan step's ONE selection from the picker's live snapshot (null = leave it). */
export type PlanPickResolver = (snap: ActivePicker) => PickerSelectFields | null;

function applyPlan(entry: PickerEntry, resolve: PlanPickResolver): void {
  const snap = (() => {
    try {
      return entry.snapshot();
    } catch {
      return null;
    }
  })();
  const sel = snap ? resolve(snap) : null;
  if (sel) entry.apply(sel);
}

/**
 * Plan tab: fill the picker of `messageId` with the plan step's own selection
 * (its date, the slot / show nearest its time, its party, a free table first),
 * applied ONCE when the picker registers with its live listing. Selects only.
 */
export function sendPlanPick(messageId: string, resolve: PlanPickResolver): void {
  const entry = entries.get(messageId);
  if (entry) applyPlan(entry, resolve);
  else pendingPlan.set(messageId, resolve);
}

function applyBest(entry: PickerEntry): void {
  const sel = entry.best?.();
  if (sel) entry.apply(sel);
}

/**
 * One-tap AI booking from the results: fill the picker of `messageId` with its
 * top AI pick (queued until it registers with its live listing). It only
 * SELECTS — the user still taps the picker's final Confirm / Review.
 */
export function sendBestPick(messageId: string): void {
  requestPickerOpen(messageId);
  const entry = entries.get(messageId);
  if (entry) applyBest(entry);
  else pendingBest.add(messageId);
}
