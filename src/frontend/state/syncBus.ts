// Tiny in-page event bus between the localStorage stores (bookings, history,
// preferences, Plan runs) and the cloud sync (./cloudSync.ts). The stores only
// announce "this changed"; whether anything is sent to a server is decided by
// cloudSync (nothing is, when the server has no database).

export type SyncEntity = 'bookings' | 'sessions' | 'preferences' | 'planRuns';

export interface LocalChange {
  entity: SyncEntity;
  /** session id / plan-run session id */
  id?: string;
  /** a chat session was deleted locally (tombstone it on the server) */
  deleted?: boolean;
}

export interface SyncedChange {
  bookings: boolean;
  sessions: boolean;
  preferences: boolean;
  planRuns: boolean;
}

export const LOCAL_CHANGE_EVENT = 'swizzo:local-change';
export const SYNCED_EVENT = 'swizzo:synced';

let muted = 0;

/** Announce a local write. Silent while cloudSync itself is writing server data. */
export function noteLocalChange(change: LocalChange): void {
  if (typeof window === 'undefined' || muted > 0) return;
  try {
    window.dispatchEvent(new CustomEvent<LocalChange>(LOCAL_CHANGE_EVENT, { detail: change }));
  } catch {
    // very old browsers — sync just won't push this change until the next full sync
  }
}

/** Run `fn` without announcing its writes (used when applying server data). */
export function withoutNotifying<T>(fn: () => T): T {
  muted++;
  try {
    return fn();
  } finally {
    muted--;
  }
}
