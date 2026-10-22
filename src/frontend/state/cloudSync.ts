'use client';

// Cross-device sync of the browser stores with GET/PUT /api/me/state.
//
//  - localStorage stays the source the UI reads (offline cache). Sync only
//    merges server copies into it and pushes local edits up.
//  - Merge rule: per record, the newer `updatedAt` wins; ties go to the server.
//  - First sync on a browser (or after an upgrade) pushes everything already in
//    localStorage — that is the migration of pre-database data.
//  - A different Swiggy account syncing in the same browser: the local caches
//    are replaced by that account's server copy (no cross-account leakage).
//  - Server without DATABASE_URL → { enabled:false }: sync turns itself off and
//    the app is exactly the localStorage-only app.

import type {
  MeStatePut,
  MeStateResponse,
  SyncBooking,
  SyncPlanRun,
  SyncPreferencesData,
  SyncSession,
} from '@/shared/persistence';
import { SYNC_LIMITS } from '@/shared/persistence';
import type { ChatMessage, ChatSession, Service } from '@/shared/types';

import { loadBookings, replaceBookings, type SavedBooking } from './bookings';
import { importSessions, loadAllSessions } from './history';
import { LOCAL_CHANGE_EVENT, SYNCED_EVENT, withoutNotifying, type LocalChange, type SyncedChange } from './syncBus';

const META_KEY = 'swizzo.sync.v1';
const PLANRUN_PREFIX = 'swiggy-planrun-v1:';
export const PREF_KEYS = {
  preferences: 'swiggy-preferences-v1',
  allergies: 'swiggy-allergies-v1',
  budget: 'swiggy-budget-v1',
  kcalGoal: 'swiggy-kcalgoal-v1',
  proteinGoal: 'swiggy-proteingoal-v1',
} as const;

const PUSH_DEBOUNCE_MS = 2_500;
const PULL_EVERY_MS = 5 * 60_000;
const PULL_SKEW_MS = 60_000;

interface Meta {
  account?: string;
  lastPull?: number;
  /** what the server has (per record updatedAt / content hash) */
  pushed: { sessions: Record<string, number>; bookings: Record<string, number>; planRuns: Record<string, string>; prefs?: number };
  /** local edit times for records without their own updatedAt */
  prefsAt?: number;
  planRunAt: Record<string, number>;
  /** sessions deleted locally, not yet acknowledged by the server */
  tombstones: Record<string, number>;
}

const emptyMeta = (): Meta => ({ pushed: { sessions: {}, bookings: {}, planRuns: {} }, planRunAt: {}, tombstones: {} });

function readMeta(): Meta {
  try {
    const raw = window.localStorage.getItem(META_KEY);
    const m = raw ? (JSON.parse(raw) as Partial<Meta>) : null;
    if (!m || typeof m !== 'object') return emptyMeta();
    const e = emptyMeta();
    return {
      ...e,
      ...m,
      pushed: { ...e.pushed, ...(m.pushed ?? {}) },
      planRunAt: m.planRunAt ?? {},
      tombstones: m.tombstones ?? {},
    };
  } catch {
    return emptyMeta();
  }
}

function writeMeta(m: Meta): void {
  try {
    window.localStorage.setItem(META_KEY, JSON.stringify(m));
  } catch {
    /* best-effort */
  }
}

function getItem(k: string): string | null {
  try {
    return window.localStorage.getItem(k);
  } catch {
    return null;
  }
}

function setItem(k: string, v: string): void {
  try {
    window.localStorage.setItem(k, v);
  } catch {
    /* storage full — the server copy is still there */
  }
}

/** djb2 — only to notice "this Plan run's JSON changed". */
function hash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return `${s.length}:${h >>> 0}`;
}

/* --------------------------------- mapping --------------------------------- */

const bookingKey = (b: { kind: string; orderId: string }) => `${b.kind}:${b.orderId}`;
const bookingAt = (b: SavedBooking) => b.updatedAt ?? b.createdAt;

const fin = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

function toSyncBooking(b: SavedBooking): SyncBooking {
  return {
    kind: b.kind,
    orderId: b.orderId,
    title: (b.title || '').slice(0, 1_000),
    details: b.details?.slice(0, SYNC_LIMITS.textField),
    restaurantId: b.restaurantId,
    eventId: b.eventId,
    startsAt: fin(b.startsAt) !== undefined ? Math.round(b.startsAt as number) : undefined,
    party: fin(b.party) !== undefined ? Math.round(b.party as number) : undefined,
    amount: fin(b.amount),
    lat: fin(b.lat),
    lng: fin(b.lng),
    status: b.status,
    statusAt: b.statusAt,
    createdAt: Math.round(b.createdAt),
    updatedAt: Math.round(bookingAt(b)),
  };
}

function fromSyncBooking(b: SyncBooking): SavedBooking {
  const out: SavedBooking = { kind: b.kind, orderId: b.orderId, title: b.title, createdAt: b.createdAt, updatedAt: b.updatedAt };
  for (const k of ['details', 'restaurantId', 'eventId', 'startsAt', 'party', 'amount', 'lat', 'lng', 'status', 'statusAt'] as const) {
    if (b[k] !== undefined && b[k] !== null) (out as unknown as Record<string, unknown>)[k] = b[k];
  }
  return out;
}

export function readLocalPreferences(): SyncPreferencesData {
  const num = (k: string) => Number(getItem(k) || 0) || 0;
  return {
    preferences: getItem(PREF_KEYS.preferences) ?? '',
    allergies: getItem(PREF_KEYS.allergies) ?? '',
    budget: num(PREF_KEYS.budget),
    kcalGoal: num(PREF_KEYS.kcalGoal),
    proteinGoal: num(PREF_KEYS.proteinGoal),
  };
}

function writeLocalPreferences(d: SyncPreferencesData): void {
  setItem(PREF_KEYS.preferences, d.preferences);
  setItem(PREF_KEYS.allergies, d.allergies);
  setItem(PREF_KEYS.budget, String(d.budget));
  setItem(PREF_KEYS.kcalGoal, String(d.kcalGoal));
  setItem(PREF_KEYS.proteinGoal, String(d.proteinGoal));
}

function localPlanRunIds(): string[] {
  const ids: string[] = [];
  try {
    for (let i = 0; i < window.localStorage.length; i++) {
      const k = window.localStorage.key(i);
      if (k?.startsWith(PLANRUN_PREFIX)) ids.push(k.slice(PLANRUN_PREFIX.length));
    }
  } catch {
    /* ignore */
  }
  return ids;
}

/** Wipe this browser's synced caches (another account is taking over). */
function clearLocalCaches(clientUserId: string | undefined): void {
  replaceBookings(clientUserId, []);
  importSessions([], loadAllSessions().map((s) => s.id));
  for (const k of Object.values(PREF_KEYS)) {
    try {
      window.localStorage.removeItem(k);
    } catch {
      /* ignore */
    }
  }
  for (const sid of localPlanRunIds()) {
    try {
      window.localStorage.removeItem(PLANRUN_PREFIX + sid);
    } catch {
      /* ignore */
    }
  }
}

/* --------------------------------- engine ---------------------------------- */

interface Engine {
  clientUserId: string | undefined;
  enabled: boolean;
  stopped: boolean;
  pushTimer?: number;
  pullTimer?: number;
  busy: Promise<void>;
}

let engine: Engine | null = null;

async function api(method: 'GET' | 'PUT', path: string, body?: MeStatePut): Promise<MeStateResponse | null> {
  try {
    const res = await fetch(path, {
      method,
      cache: 'no-store',
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = (await res.json().catch(() => null)) as MeStateResponse | null;
    if (!res.ok) return data && data.enabled === false ? data : null;
    return data;
  } catch {
    return null; // offline — try again on the next change / pull
  }
}

function emitSynced(change: SyncedChange): void {
  if (!change.bookings && !change.sessions && !change.preferences && !change.planRuns) return;
  window.dispatchEvent(new CustomEvent<SyncedChange>(SYNCED_EVENT, { detail: change }));
}

/** Merge a GET response into localStorage. Returns what changed locally. */
function applyServer(e: Engine, meta: Meta, s: MeStateResponse): SyncedChange {
  const changed: SyncedChange = { bookings: false, sessions: false, preferences: false, planRuns: false };
  withoutNotifying(() => {
    // bookings: union by kind+orderId, newer wins (server on ties)
    if (s.bookings?.length) {
      const local = new Map(loadBookings(e.clientUserId).map((b) => [bookingKey(b), b]));
      for (const sb of s.bookings) {
        const k = bookingKey(sb);
        const lb = local.get(k);
        meta.pushed.bookings[k] = Math.max(meta.pushed.bookings[k] ?? 0, sb.updatedAt);
        if (!lb || sb.updatedAt >= bookingAt(lb)) {
          if (!lb || JSON.stringify(toSyncBooking(lb)) !== JSON.stringify(sb)) changed.bookings = true;
          local.set(k, { ...lb, ...fromSyncBooking(sb) });
        }
      }
      if (changed.bookings) replaceBookings(e.clientUserId, [...local.values()]);
    }
    // sessions
    if (s.sessions?.length) {
      const local = new Map(loadAllSessions().map((x) => [x.id, x]));
      const put: ChatSession[] = [];
      const remove: string[] = [];
      for (const ss of s.sessions) {
        const ls = local.get(ss.id);
        meta.pushed.sessions[ss.id] = Math.max(meta.pushed.sessions[ss.id] ?? 0, ss.updatedAt);
        if (ss.deleted) {
          delete meta.tombstones[ss.id];
          if (ls && ls.updatedAt <= ss.updatedAt) remove.push(ss.id);
          continue;
        }
        const tomb = meta.tombstones[ss.id];
        if (tomb && tomb >= ss.updatedAt) continue; // deleted here after that edit
        if (!ls || ss.updatedAt >= ls.updatedAt) {
          if (!ls || ss.updatedAt !== ls.updatedAt) {
            put.push({ id: ss.id, title: ss.title, service: ss.service as Service, updatedAt: ss.updatedAt, messages: ss.messages as ChatMessage[] });
          }
        }
      }
      if (put.length || remove.length) {
        importSessions(put, remove);
        changed.sessions = true;
      }
    }
    // preferences
    if (s.preferences && s.preferences.updatedAt >= (meta.prefsAt ?? 0)) {
      if (JSON.stringify(readLocalPreferences()) !== JSON.stringify(s.preferences.data)) {
        writeLocalPreferences(s.preferences.data);
        changed.preferences = true;
      }
      meta.prefsAt = s.preferences.updatedAt;
      meta.pushed.prefs = s.preferences.updatedAt;
    }
    // plan runs
    for (const pr of s.planRuns ?? []) {
      if (pr.updatedAt < (meta.planRunAt[pr.sessionId] ?? 0)) continue;
      const json = JSON.stringify(pr.run);
      if (getItem(PLANRUN_PREFIX + pr.sessionId) !== json) {
        setItem(PLANRUN_PREFIX + pr.sessionId, json);
        changed.planRuns = true;
      }
      meta.planRunAt[pr.sessionId] = pr.updatedAt;
      meta.pushed.planRuns[pr.sessionId] = hash(json);
    }
  });
  return changed;
}

/** Push every local record newer than what the server is known to have. */
async function pushLocal(e: Engine, meta: Meta): Promise<void> {
  const body: MeStatePut = {};

  const bookings = loadBookings(e.clientUserId)
    .filter((b) => bookingAt(b) > (meta.pushed.bookings[bookingKey(b)] ?? 0))
    .slice(0, SYNC_LIMITS.bookings);
  if (bookings.length) body.bookings = bookings.map(toSyncBooking);

  // never synced before (migration): local prefs count as edited now
  if (meta.prefsAt === undefined && meta.pushed.prefs === undefined) meta.prefsAt = Date.now();
  if ((meta.prefsAt ?? 0) > (meta.pushed.prefs ?? 0)) {
    body.preferences = { data: readLocalPreferences(), updatedAt: meta.prefsAt as number };
  }

  const planRuns: SyncPlanRun[] = [];
  for (const sid of localPlanRunIds()) {
    const raw = getItem(PLANRUN_PREFIX + sid);
    if (!raw || raw.length > SYNC_LIMITS.planRunBytes) continue;
    const h = hash(raw);
    if (meta.pushed.planRuns[sid] === h) continue;
    try {
      const run = JSON.parse(raw) as unknown;
      if (!run || typeof run !== 'object') continue;
      const at = (meta.planRunAt[sid] ??= Date.now());
      planRuns.push({ sessionId: sid, run, updatedAt: at });
    } catch {
      /* corrupt entry — leave it local */
    }
  }
  if (planRuns.length) body.planRuns = planRuns.slice(0, SYNC_LIMITS.planRuns);

  const sessions: SyncSession[] = [
    ...Object.entries(meta.tombstones).map(([id, at]) => ({ id, title: '', service: 'plan', updatedAt: at, messages: [], deleted: true })),
    ...loadAllSessions()
      .filter((s) => s.updatedAt > (meta.pushed.sessions[s.id] ?? 0))
      .map((s) => ({ id: s.id, title: s.title, service: s.service, updatedAt: s.updatedAt, messages: s.messages as unknown[] })),
  ];

  // first request carries bookings/prefs/plan runs + the first batch of sessions
  let batch = sessions.splice(0, SYNC_LIMITS.sessionsPerPut);
  let first = true;
  while (first || batch.length) {
    const put: MeStatePut = first ? { ...body } : {};
    if (batch.length) put.sessions = batch;
    first = false;
    if (!put.bookings && !put.preferences && !put.planRuns && !put.sessions) break;
    const res = await api('PUT', '/api/me/state', put);
    if (!res) return; // offline / error: meta unchanged, retried later
    if (res.enabled === false) {
      e.enabled = false;
      return;
    }
    for (const b of put.bookings ?? []) meta.pushed.bookings[bookingKey(b)] = b.updatedAt;
    if (put.preferences) meta.pushed.prefs = put.preferences.updatedAt;
    for (const pr of put.planRuns ?? []) meta.pushed.planRuns[pr.sessionId] = hash(JSON.stringify(pr.run));
    for (const s of put.sessions ?? []) {
      meta.pushed.sessions[s.id] = s.updatedAt;
      if (s.deleted) delete meta.tombstones[s.id];
    }
    writeMeta(meta);
    batch = sessions.splice(0, SYNC_LIMITS.sessionsPerPut);
  }
}

/** Pull (incremental when possible), merge, then push what the server lacks. */
async function syncOnce(e: Engine, full = false): Promise<void> {
  if (e.stopped || !e.enabled) return;
  let meta = readMeta();
  const since = !full && meta.account && meta.lastPull ? meta.lastPull - PULL_SKEW_MS : undefined;
  let s = await api('GET', `/api/me/state${since ? `?since=${since}` : ''}`);
  if (!s) return;
  if (!s.enabled) {
    e.enabled = false; // no database on this server — localStorage only
    return;
  }
  if (!s.authenticated || !s.account) return;
  if (meta.account && meta.account !== s.account) {
    // another Swiggy account in this browser: its server copy replaces the caches
    withoutNotifying(() => clearLocalCaches(e.clientUserId));
    meta = emptyMeta();
    if (since) {
      s = await api('GET', '/api/me/state');
      if (!s?.enabled || !s.account) return;
    }
  }
  meta.account = s.account;
  const changed = applyServer(e, meta, s);
  if (s.serverTime) meta.lastPull = s.serverTime;
  writeMeta(meta);
  emitSynced(changed);
  await pushLocal(e, meta);
}

function run(e: Engine, task: () => Promise<void>): Promise<void> {
  e.busy = e.busy.then(task, task).catch(() => {});
  return e.busy;
}

function onLocalChange(ev: Event): void {
  const e = engine;
  const change = (ev as CustomEvent<LocalChange>).detail;
  if (!e || e.stopped || !e.enabled || !change) return;
  const meta = readMeta();
  const now = Date.now();
  if (change.entity === 'sessions' && change.deleted && change.id) meta.tombstones[change.id] = now;
  if (change.entity === 'preferences') meta.prefsAt = now;
  if (change.entity === 'planRuns' && change.id) {
    const raw = getItem(PLANRUN_PREFIX + change.id);
    // re-saving an unchanged run (e.g. on load) is not an edit
    if (raw && meta.pushed.planRuns[change.id] !== hash(raw)) meta.planRunAt[change.id] = now;
  }
  writeMeta(meta);
  window.clearTimeout(e.pushTimer);
  e.pushTimer = window.setTimeout(() => void run(e, () => pushLocal(e, readMeta())), PUSH_DEBOUNCE_MS);
}

function onVisible(): void {
  const e = engine;
  if (e && document.visibilityState === 'visible') void run(e, () => syncOnce(e));
}

/**
 * Start syncing for the signed-in user (idempotent). `clientUserId` is the id
 * the app already keys local bookings by (may be undefined → "anon").
 * Resolves after the first pull + push.
 */
export function startCloudSync(clientUserId: string | undefined): Promise<void> {
  if (typeof window === 'undefined') return Promise.resolve();
  if (engine && !engine.stopped && engine.clientUserId === clientUserId) return engine.busy;
  stopCloudSync();
  const e: Engine = {
    clientUserId,
    enabled: true,
    stopped: false,
    busy: Promise.resolve(),
  };
  engine = e;
  window.addEventListener(LOCAL_CHANGE_EVENT, onLocalChange);
  document.addEventListener('visibilitychange', onVisible);
  e.pullTimer = window.setInterval(() => {
    if (document.visibilityState === 'visible') void run(e, () => syncOnce(e));
  }, PULL_EVERY_MS);
  return run(e, () => syncOnce(e));
}

export function stopCloudSync(): void {
  const e = engine;
  if (!e) return;
  e.stopped = true;
  window.clearTimeout(e.pushTimer);
  window.clearInterval(e.pullTimer);
  window.removeEventListener(LOCAL_CHANGE_EVENT, onLocalChange);
  document.removeEventListener('visibilitychange', onVisible);
  engine = null;
}

/** Pull now (e.g. History page open) and wait. No-op when sync is off / unavailable. */
export function pullNow(): Promise<void> {
  const e = engine;
  if (!e || e.stopped || !e.enabled) return Promise.resolve();
  return run(e, () => syncOnce(e));
}
