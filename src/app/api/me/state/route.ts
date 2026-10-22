// /api/me/state — the signed-in Swiggy account's saved app state (bookings made
// in this app, chat sessions, preferences, Plan runs) for cross-device sync.
//   GET    ?since=<epoch ms>  → records changed after `since` (all when omitted)
//   PUT    MeStatePut          → upsert; a record wins only if its updatedAt is newer
//   DELETE                     → erase this account's saved state
// Without DATABASE_URL every method answers { enabled:false } and the browser
// keeps using localStorage only. See docs/DATABASE.md.

import { createHash } from "node:crypto";

import { z } from "zod";

import { getDb } from "@/backend/db/client";
import { currentSwiggyUserId } from "@/backend/db/identity";
import {
  deleteUser,
  ensureUser,
  getPreferences,
  listBookings,
  listPlanRuns,
  listSessions,
  putPreferences,
  upsertBookings,
  upsertPlanRuns,
  upsertSessions,
} from "@/backend/db/repos";
import { SYNC_LIMITS, type MeStateResponse } from "@/shared/persistence";
import { route } from "@/backend/http/route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 4_000_000;

const ms = z.number().int().nonnegative().max(8_640_000_000_000);
const id = z.string().trim().min(1).max(200);
const txt = (n: number) => z.string().max(n);
const finite = z.number().finite();

const bookingSchema = z.object({
  kind: z.enum(["dineout", "scenes"]),
  orderId: id,
  title: txt(1_000),
  details: txt(SYNC_LIMITS.textField).optional(),
  restaurantId: txt(200).optional(),
  eventId: txt(200).optional(),
  startsAt: ms.optional(),
  party: z.number().int().min(0).max(1_000).optional(),
  amount: finite.min(0).max(10_000_000).optional(),
  lat: finite.min(-90).max(90).optional(),
  lng: finite.min(-180).max(180).optional(),
  status: txt(200).optional(),
  statusAt: ms.optional(),
  createdAt: ms,
  updatedAt: ms,
});

const sessionSchema = z.object({
  id,
  title: txt(1_000),
  service: z.string().min(1).max(40),
  updatedAt: ms,
  messages: z.array(z.unknown()).max(2_000),
  deleted: z.boolean().optional(),
});

const putSchema = z.object({
  bookings: z.array(bookingSchema).max(SYNC_LIMITS.bookings).optional(),
  sessions: z.array(sessionSchema).max(SYNC_LIMITS.sessionsPerPut).optional(),
  preferences: z
    .object({
      data: z.object({
        preferences: txt(SYNC_LIMITS.textField),
        allergies: txt(SYNC_LIMITS.textField),
        budget: finite.min(0).max(10_000_000),
        kcalGoal: finite.min(0).max(100_000),
        proteinGoal: finite.min(0).max(10_000),
      }),
      updatedAt: ms,
    })
    .optional(),
  planRuns: z
    .array(z.object({ sessionId: id, run: z.record(z.string(), z.unknown()), updatedAt: ms }))
    .max(SYNC_LIMITS.planRuns)
    .optional(),
});

const accountTag = (swiggyId: string) => createHash("sha256").update(`swizzo:${swiggyId}`).digest("hex").slice(0, 16);

const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { "Cache-Control": "private, no-store" } });

type Ctx = { db: NonNullable<ReturnType<typeof getDb>>; userId: string; account: string };

/** The DB + user for this request, or the response to send when there is no DB / no session. */
async function context(): Promise<Ctx | Response> {
  const db = getDb();
  if (!db) return json({ enabled: false } satisfies MeStateResponse);
  const swiggyId = await currentSwiggyUserId();
  if (!swiggyId) return json({ enabled: true, authenticated: false } satisfies MeStateResponse, 401);
  const userId = await ensureUser(db, swiggyId);
  return { db, userId, account: accountTag(swiggyId) };
}

function dbError(op: string, err: unknown): Response {
  console.error(`[api/me/state] ${op} failed:`, err instanceof Error ? err.message : err);
  return json({ enabled: true, error: "Saved state is unavailable right now." }, 503);
}

// auth "optional": this route answers its own 401 / {enabled:false} shapes; the
// wrapper adds same-origin (PUT/DELETE), rate limiting and redacted errors.
export const GET = route({ name: "api/me/state", auth: "optional", rateLimit: "read" }, async function GET(request: Request): Promise<Response> {
  try {
    const ctx = await context();
    if (ctx instanceof Response) return ctx;
    const sinceRaw = Number(new URL(request.url).searchParams.get("since"));
    const since = Number.isFinite(sinceRaw) && sinceRaw > 0 ? sinceRaw : undefined;
    const serverTime = Date.now();
    const [bookings, sessions, preferences, planRuns] = await Promise.all([
      listBookings(ctx.db, ctx.userId, since),
      listSessions(ctx.db, ctx.userId, since),
      getPreferences(ctx.db, ctx.userId, since),
      listPlanRuns(ctx.db, ctx.userId, since),
    ]);
    return json({
      enabled: true,
      authenticated: true,
      account: ctx.account,
      serverTime,
      bookings,
      sessions,
      preferences,
      planRuns,
    } satisfies MeStateResponse);
  } catch (err) {
    return dbError("GET", err);
  }
});

export const PUT = route({ name: "api/me/state", auth: "optional", rateLimit: "mutate" }, async function PUT(request: Request): Promise<Response> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    return json({ error: "Payload too large" }, 413);
  }
  let body: unknown;
  try {
    const text = await request.text();
    if (text.length > MAX_BODY_BYTES) return json({ error: "Payload too large" }, 413);
    body = JSON.parse(text);
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }
  const parsed = putSchema.safeParse(body);
  if (!parsed.success) {
    return json({ error: "Invalid state payload", issues: parsed.error.issues.slice(0, 5).map((i) => i.path.join(".")) }, 400);
  }
  try {
    const ctx = await context();
    if (ctx instanceof Response) return ctx;
    const p = parsed.data;
    const [bookings, sessions, preferences, planRuns] = await Promise.all([
      p.bookings ? upsertBookings(ctx.db, ctx.userId, p.bookings) : 0,
      p.sessions ? upsertSessions(ctx.db, ctx.userId, p.sessions) : [],
      p.preferences ? putPreferences(ctx.db, ctx.userId, p.preferences) : false,
      p.planRuns ? upsertPlanRuns(ctx.db, ctx.userId, p.planRuns) : 0,
    ]);
    return json({ ok: true, enabled: true, written: { bookings, sessions, preferences, planRuns } });
  } catch (err) {
    return dbError("PUT", err);
  }
});

export const DELETE = route({ name: "api/me/state", auth: "optional", rateLimit: "mutate" }, async function DELETE(): Promise<Response> {
  try {
    const ctx = await context();
    if (ctx instanceof Response) return ctx;
    await deleteUser(ctx.db, ctx.userId);
    return json({ ok: true, enabled: true });
  } catch (err) {
    return dbError("DELETE", err);
  }
});
