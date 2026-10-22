'use client';

// Local (browser) chat history. Full conversations — including the rendered
// card data — are saved to localStorage so they restore exactly on reload.
// Newest first; capped so storage can't grow without bound.

import { SERVICES, type ChatMessage, type ChatSession, type ChatSessionMeta } from '@/shared/types';
import { noteLocalChange } from './syncBus';

const KEY = 'swiggy-chat-history-v1';
const MAX_SESSIONS = 40;

/** Drop sessions whose service is no longer supported (e.g. old dineout/
 *  concierge threads) so the UI never renders or routes an unknown service. */
function isKnownService(s: ChatSession): boolean {
  return Boolean(s) && (SERVICES as string[]).includes(s.service);
}

function read(): ChatSession[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? (arr as ChatSession[]).filter(isKnownService) : [];
  } catch {
    return [];
  }
}

function write(list: ChatSession[]): void {
  if (typeof window === 'undefined') return;
  const trimmed = list.slice(0, MAX_SESSIONS);
  try {
    window.localStorage.setItem(KEY, JSON.stringify(trimmed));
  } catch {
    // Likely a quota error — keep only the most recent handful and retry once.
    try {
      window.localStorage.setItem(KEY, JSON.stringify(trimmed.slice(0, 12)));
    } catch {
      /* give up silently — history is best-effort */
    }
  }
}

export function loadSessionList(): ChatSessionMeta[] {
  return read()
    .map(({ id, title, service, updatedAt }) => ({
      id,
      title,
      service,
      updatedAt,
    }))
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export function loadSession(id: string): ChatSession | null {
  return read().find((s) => s.id === id) ?? null;
}

/** Content signature that ignores message ids + updatedAt — so merely REOPENING
 *  a saved session (which may re-key ids) is not mistaken for a real edit. */
function contentSig(title: string, service: string, messages: ChatMessage[]): string {
  // `id: undefined` is dropped by JSON.stringify, so ids never affect the sig.
  const stripped = messages.map((m) => ({ ...m, id: undefined }));
  return `${service}\u0000${title}\u0000${JSON.stringify(stripped)}`;
}

/**
 * Insert or update a session — but ONLY write (and bump updatedAt) when the
 * conversation content actually changed. Reopening a saved chat then settling
 * must not reorder history or refresh its timestamp. Returns true when it wrote
 * (so callers can skip refreshing their in-memory list on a no-op).
 */
export function upsertSession(session: ChatSession): boolean {
  if (!isKnownService(session)) return false;
  const all = read();
  const existing = all.find((s) => s.id === session.id);
  if (
    existing &&
    contentSig(existing.title, existing.service, existing.messages) ===
      contentSig(session.title, session.service, session.messages)
  ) {
    return false; // no real change — leave the stored session (and its updatedAt) alone
  }
  const list = all.filter((s) => s.id !== session.id);
  list.unshift(session);
  list.sort((a, b) => b.updatedAt - a.updatedAt);
  write(list);
  noteLocalChange({ entity: 'sessions', id: session.id });
  return true;
}

export function deleteSession(id: string): void {
  write(read().filter((s) => s.id !== id));
  noteLocalChange({ entity: 'sessions', id, deleted: true });
}

export function clearHistory(): void {
  const ids = read().map((s) => s.id);
  write([]);
  for (const id of ids) noteLocalChange({ entity: 'sessions', id, deleted: true });
}

/** Every stored session, full (cloud sync). */
export function loadAllSessions(): ChatSession[] {
  return read();
}

/**
 * Apply sessions from the server (cloud sync): `put` replaces/inserts by id,
 * `remove` drops ids. Does not announce changes (the server already has them).
 */
export function importSessions(put: ChatSession[], remove: string[] = []): void {
  if (!put.length && !remove.length) return;
  const drop = new Set([...remove, ...put.map((s) => s.id)]);
  const list = [...put.filter(isKnownService), ...read().filter((s) => !drop.has(s.id))];
  list.sort((a, b) => b.updatedAt - a.updatedAt);
  write(list);
}
