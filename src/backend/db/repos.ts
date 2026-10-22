// Repository layer: every read/write of user state goes through here. All
// functions take the internal users.id (from ensureUser) so one account can
// never touch another's rows. Conflict rule everywhere: an incoming record
// replaces the stored one only when its updatedAt is strictly newer.

import { and, desc, eq, gt, inArray, isNotNull, lt, notInArray, sql } from "drizzle-orm";

import {
  SYNC_LIMITS,
  type SyncBooking,
  type SyncPlanRun,
  type SyncPreferences,
  type SyncPreferencesData,
  type SyncSession,
} from "@/shared/persistence";

import type { Db } from "./client";
import { auditLog, bookings, chatMessages, chatSessions, planRuns, preferences, users } from "./schema";

const toDate = (ms: number | undefined): Date | null =>
  typeof ms === "number" && Number.isFinite(ms) && ms > 0 ? new Date(ms) : null;
const toMs = (d: Date | null | undefined): number | undefined => (d ? d.getTime() : undefined);
const opt = <T>(v: T | null | undefined): T | undefined => (v === null ? undefined : v);
const clip = (s: string | undefined, n: number = SYNC_LIMITS.textField): string | undefined =>
  typeof s === "string" ? s.slice(0, n) : undefined;

/* ---------------------------------- users ---------------------------------- */

// swiggyUserId → users.id, so most requests skip the upsert.
const g = globalThis as unknown as { __swizzoUserIds?: Map<string, { id: string; until: number }> };
const userIds = (g.__swizzoUserIds ??= new Map());
const USER_CACHE_MS = 10 * 60_000;

/** Find-or-create the user row for a Swiggy account; bumps last_seen_at. */
export async function ensureUser(db: Db, swiggyUserId: string): Promise<string> {
  const now = Date.now();
  const hit = userIds.get(swiggyUserId);
  if (hit && hit.until > now) return hit.id;
  const [row] = await db
    .insert(users)
    .values({ swiggyUserId })
    .onConflictDoUpdate({ target: users.swiggyUserId, set: { lastSeenAt: sql`now()` } })
    .returning({ id: users.id });
  if (userIds.size > 5_000) userIds.clear();
  userIds.set(swiggyUserId, { id: row.id, until: now + USER_CACHE_MS });
  return row.id;
}

/** Look up without creating (audit log: never create users from a tool call). */
export async function findUserId(db: Db, swiggyUserId: string): Promise<string | null> {
  const hit = userIds.get(swiggyUserId);
  if (hit && hit.until > Date.now()) return hit.id;
  const [row] = await db.select({ id: users.id }).from(users).where(eq(users.swiggyUserId, swiggyUserId)).limit(1);
  return row?.id ?? null;
}

/** Delete an account and (via ON DELETE CASCADE) all of its state. Audit rows keep a null user. */
export async function deleteUser(db: Db, userId: string): Promise<void> {
  await db.delete(users).where(eq(users.id, userId));
  for (const [k, v] of userIds) if (v.id === userId) userIds.delete(k);
}

/* --------------------------------- bookings -------------------------------- */

function bookingRow(userId: string, b: SyncBooking) {
  return {
    userId,
    kind: b.kind,
    orderId: b.orderId.slice(0, 200),
    title: clip(b.title, 300) ?? "",
    details: clip(b.details) ?? null,
    restaurantId: clip(b.restaurantId, 100) ?? null,
    eventId: clip(b.eventId, 100) ?? null,
    startsAt: toDate(b.startsAt),
    partySize: typeof b.party === "number" ? Math.round(b.party) : null,
    amount: typeof b.amount === "number" ? b.amount : null,
    lat: typeof b.lat === "number" ? b.lat : null,
    lng: typeof b.lng === "number" ? b.lng : null,
    lastStatus: clip(b.status, 100) ?? null,
    lastStatusAt: toDate(b.statusAt),
    createdAt: toDate(b.createdAt) ?? new Date(),
    updatedAt: toDate(b.updatedAt) ?? new Date(),
  };
}

export async function upsertBookings(db: Db, userId: string, list: SyncBooking[]): Promise<number> {
  if (!list.length) return 0;
  const rows = list.slice(0, SYNC_LIMITS.bookings).map((b) => bookingRow(userId, b));
  const res = await db
    .insert(bookings)
    .values(rows)
    .onConflictDoUpdate({
      target: [bookings.userId, bookings.kind, bookings.orderId],
      set: {
        title: sql`excluded.title`,
        details: sql`excluded.details`,
        restaurantId: sql`coalesce(excluded.restaurant_id, ${bookings.restaurantId})`,
        eventId: sql`coalesce(excluded.event_id, ${bookings.eventId})`,
        startsAt: sql`coalesce(excluded.starts_at, ${bookings.startsAt})`,
        partySize: sql`coalesce(excluded.party_size, ${bookings.partySize})`,
        amount: sql`coalesce(excluded.amount, ${bookings.amount})`,
        lat: sql`coalesce(excluded.lat, ${bookings.lat})`,
        lng: sql`coalesce(excluded.lng, ${bookings.lng})`,
        lastStatus: sql`coalesce(excluded.last_status, ${bookings.lastStatus})`,
        lastStatusAt: sql`coalesce(excluded.last_status_at, ${bookings.lastStatusAt})`,
        updatedAt: sql`excluded.updated_at`,
      },
      setWhere: sql`excluded.updated_at > ${bookings.updatedAt}`,
    })
    .returning({ id: bookings.id });
  await pruneBookings(db, userId);
  return res.length;
}

async function pruneBookings(db: Db, userId: string): Promise<void> {
  const keep = db
    .select({ id: bookings.id })
    .from(bookings)
    .where(eq(bookings.userId, userId))
    .orderBy(desc(bookings.createdAt))
    .limit(SYNC_LIMITS.bookings);
  await db.delete(bookings).where(and(eq(bookings.userId, userId), notInArray(bookings.id, keep)));
}

export async function listBookings(db: Db, userId: string, since?: number): Promise<SyncBooking[]> {
  const sinceDate = toDate(since);
  const rows = await db
    .select()
    .from(bookings)
    .where(sinceDate ? and(eq(bookings.userId, userId), gt(bookings.updatedAt, sinceDate)) : eq(bookings.userId, userId))
    .orderBy(desc(bookings.createdAt))
    .limit(SYNC_LIMITS.bookings);
  return rows.map((r) => ({
    kind: r.kind as SyncBooking["kind"],
    orderId: r.orderId,
    title: r.title,
    details: opt(r.details),
    restaurantId: opt(r.restaurantId),
    eventId: opt(r.eventId),
    startsAt: toMs(r.startsAt),
    party: opt(r.partySize),
    amount: opt(r.amount),
    lat: opt(r.lat),
    lng: opt(r.lng),
    status: opt(r.lastStatus),
    statusAt: toMs(r.lastStatusAt),
    createdAt: r.createdAt.getTime(),
    updatedAt: r.updatedAt.getTime(),
  }));
}

/* ------------------------------ chat sessions ------------------------------ */

/** Bound one session's messages: count, per-message size and total size. */
export function boundMessages(messages: unknown[]): unknown[] {
  const out: unknown[] = [];
  let total = 0;
  // keep the most recent messages when over the count cap
  for (const m of messages.slice(-SYNC_LIMITS.messagesPerSession)) {
    let json = JSON.stringify(m ?? null);
    let value: unknown = m;
    if (json.length > SYNC_LIMITS.messageBytes) {
      // e.g. an inline photo — keep a renderable text-only stub
      const r = (m && typeof m === "object" ? m : {}) as Record<string, unknown>;
      value = {
        id: r.id,
        role: r.role,
        text: typeof r.text === "string" ? r.text.slice(0, 8_000) : "",
        createdAt: r.createdAt,
        truncated: true,
      };
      json = JSON.stringify(value);
    }
    total += json.length;
    if (total > SYNC_LIMITS.sessionBytes) break;
    out.push(value);
  }
  return out;
}

/**
 * Upsert sessions (newer updatedAt wins). A session whose meta was accepted
 * has its messages replaced wholesale; tombstones drop the messages.
 * Returns the client ids that were written.
 */
export async function upsertSessions(db: Db, userId: string, list: SyncSession[]): Promise<string[]> {
  const written: string[] = [];
  for (const s of list.slice(0, SYNC_LIMITS.sessionsPerPut)) {
    const messages = s.deleted ? [] : boundMessages(Array.isArray(s.messages) ? s.messages : []);
    const updatedAt = toDate(s.updatedAt) ?? new Date();
    await db.transaction(async (tx) => {
      const [row] = await tx
        .insert(chatSessions)
        .values({
          userId,
          clientId: s.id.slice(0, 100),
          title: clip(s.title, 300) ?? "",
          service: s.service.slice(0, 40),
          messageCount: messages.length,
          deletedAt: s.deleted ? updatedAt : null,
          updatedAt,
        })
        .onConflictDoUpdate({
          target: [chatSessions.userId, chatSessions.clientId],
          set: {
            title: sql`excluded.title`,
            service: sql`excluded.service`,
            messageCount: sql`excluded.message_count`,
            deletedAt: sql`excluded.deleted_at`,
            updatedAt: sql`excluded.updated_at`,
          },
          setWhere: sql`excluded.updated_at > ${chatSessions.updatedAt}`,
        })
        .returning({ id: chatSessions.id });
      if (!row) return; // stored copy is newer — server wins
      await tx.delete(chatMessages).where(eq(chatMessages.sessionId, row.id));
      if (messages.length) {
        await tx.insert(chatMessages).values(messages.map((message, position) => ({ sessionId: row.id, position, message })));
      }
      written.push(s.id);
    });
  }
  if (written.length) await pruneSessions(db, userId);
  return written;
}

/** Keep the newest N live sessions; forget tombstones older than 30 days. */
async function pruneSessions(db: Db, userId: string): Promise<void> {
  const keep = db
    .select({ id: chatSessions.id })
    .from(chatSessions)
    .where(and(eq(chatSessions.userId, userId), sql`${chatSessions.deletedAt} is null`))
    .orderBy(desc(chatSessions.updatedAt))
    .limit(SYNC_LIMITS.sessions);
  await db
    .delete(chatSessions)
    .where(and(eq(chatSessions.userId, userId), sql`${chatSessions.deletedAt} is null`, notInArray(chatSessions.id, keep)));
  await db
    .delete(chatSessions)
    .where(
      and(
        eq(chatSessions.userId, userId),
        isNotNull(chatSessions.deletedAt),
        lt(chatSessions.deletedAt, new Date(Date.now() - 30 * 86_400_000)),
      ),
    );
}

export async function listSessions(db: Db, userId: string, since?: number): Promise<SyncSession[]> {
  const sinceDate = toDate(since);
  const metas = await db
    .select()
    .from(chatSessions)
    .where(
      sinceDate
        ? and(eq(chatSessions.userId, userId), gt(chatSessions.updatedAt, sinceDate))
        : and(eq(chatSessions.userId, userId), sql`${chatSessions.deletedAt} is null`),
    )
    .orderBy(desc(chatSessions.updatedAt))
    .limit(SYNC_LIMITS.sessions);
  if (!metas.length) return [];
  const msgs = await db
    .select()
    .from(chatMessages)
    .where(inArray(chatMessages.sessionId, metas.map((m) => m.id)))
    .orderBy(chatMessages.sessionId, chatMessages.position);
  const bySession = new Map<string, unknown[]>();
  for (const m of msgs) {
    const arr = bySession.get(m.sessionId) ?? [];
    arr.push(m.message);
    bySession.set(m.sessionId, arr);
  }
  return metas.map((s) => ({
    id: s.clientId,
    title: s.title,
    service: s.service,
    updatedAt: s.updatedAt.getTime(),
    messages: s.deletedAt ? [] : (bySession.get(s.id) ?? []),
    ...(s.deletedAt ? { deleted: true } : {}),
  }));
}

/* ------------------------------- preferences ------------------------------- */

function cleanPrefs(d: Partial<SyncPreferencesData>): SyncPreferencesData {
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.round(v) : 0);
  return {
    preferences: clip(d.preferences) ?? "",
    allergies: clip(d.allergies) ?? "",
    budget: n(d.budget),
    kcalGoal: n(d.kcalGoal),
    proteinGoal: n(d.proteinGoal),
  };
}

export async function putPreferences(db: Db, userId: string, p: SyncPreferences): Promise<boolean> {
  const res = await db
    .insert(preferences)
    .values({ userId, data: cleanPrefs(p.data), updatedAt: toDate(p.updatedAt) ?? new Date() })
    .onConflictDoUpdate({
      target: preferences.userId,
      set: { data: sql`excluded.data`, updatedAt: sql`excluded.updated_at` },
      setWhere: sql`excluded.updated_at > ${preferences.updatedAt}`,
    })
    .returning({ userId: preferences.userId });
  return res.length > 0;
}

export async function getPreferences(db: Db, userId: string, since?: number): Promise<SyncPreferences | null> {
  const [row] = await db.select().from(preferences).where(eq(preferences.userId, userId)).limit(1);
  if (!row) return null;
  if (since && row.updatedAt.getTime() <= since) return null;
  return { data: cleanPrefs(row.data as Partial<SyncPreferencesData>), updatedAt: row.updatedAt.getTime() };
}

/* -------------------------------- plan runs -------------------------------- */

export async function upsertPlanRuns(db: Db, userId: string, list: SyncPlanRun[]): Promise<number> {
  const rows = list
    .slice(0, SYNC_LIMITS.planRuns)
    .filter((r) => r.run && typeof r.run === "object" && JSON.stringify(r.run).length <= SYNC_LIMITS.planRunBytes)
    .map((r) => ({
      userId,
      sessionClientId: r.sessionId.slice(0, 100),
      run: r.run,
      updatedAt: toDate(r.updatedAt) ?? new Date(),
    }));
  if (!rows.length) return 0;
  const res = await db
    .insert(planRuns)
    .values(rows)
    .onConflictDoUpdate({
      target: [planRuns.userId, planRuns.sessionClientId],
      set: { run: sql`excluded.run`, updatedAt: sql`excluded.updated_at` },
      setWhere: sql`excluded.updated_at > ${planRuns.updatedAt}`,
    })
    .returning({ sid: planRuns.sessionClientId });
  // a plan run without its chat session is dead weight
  await db
    .delete(planRuns)
    .where(
      and(
        eq(planRuns.userId, userId),
        sql`not exists (select 1 from ${chatSessions} cs where cs.user_id = ${planRuns.userId} and cs.client_id = ${planRuns.sessionClientId} and cs.deleted_at is null)`,
        lt(planRuns.updatedAt, new Date(Date.now() - 86_400_000)),
      ),
    );
  return res.length;
}

export async function listPlanRuns(db: Db, userId: string, since?: number): Promise<SyncPlanRun[]> {
  const sinceDate = toDate(since);
  const rows = await db
    .select()
    .from(planRuns)
    .where(sinceDate ? and(eq(planRuns.userId, userId), gt(planRuns.updatedAt, sinceDate)) : eq(planRuns.userId, userId))
    .orderBy(desc(planRuns.updatedAt))
    .limit(SYNC_LIMITS.planRuns);
  return rows.map((r) => ({ sessionId: r.sessionClientId, run: r.run, updatedAt: r.updatedAt.getTime() }));
}

/* -------------------------------- audit log -------------------------------- */

export type AuditInsert = typeof auditLog.$inferInsert;

export async function insertAudit(db: Db, row: AuditInsert): Promise<void> {
  await db.insert(auditLog).values(row);
}

export async function listAudit(db: Db, userId: string, limit = 50) {
  return db.select().from(auditLog).where(eq(auditLog.userId, userId)).orderBy(desc(auditLog.createdAt)).limit(limit);
}
