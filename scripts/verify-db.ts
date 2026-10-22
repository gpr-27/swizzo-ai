// Database & persistence checks.
//  1. Fallback (always): without DATABASE_URL the app has no DB, the audit hook
//     is a no-op and /api/me/state answers { enabled:false }.
//  2. Audit-log redaction (always): no names / phones / emails / addresses /
//     coordinates / tokens survive summarizeArgs; order & cart ids are kept.
//  3. Against a real Postgres (only when DATABASE_URL is set; skipped cleanly
//     otherwise): migrations apply (idempotently), repos round-trip, the
//     newer-updatedAt-wins rule, tombstones, bounds, account isolation, audit
//     rows. Every row it writes belongs to throwaway test users it deletes.
//  4. Client sync engine (always): migration push, server-wins merge, account
//     switch, disabled server — with a localStorage shim and scripted responses.
//
// Run:  npm run db:up && DATABASE_URL=postgres://swizzo:swizzo@localhost:5433/swizzo \
//         npx tsx --tsconfig tsconfig.json scripts/verify-db.ts
//       (without DATABASE_URL only parts 1–2 run)

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

import { buildAuditRow, extractIds, isMutatingTool, recordToolAudit, summarizeArgs } from "@/backend/db/audit";
import { closeDb, dbEnabled, getDb } from "@/backend/db/client";
import { swiggyUserIdFromToken } from "@/backend/db/identity";
import {
  boundMessages,
  deleteUser,
  ensureUser,
  getPreferences,
  listAudit,
  listBookings,
  listPlanRuns,
  listSessions,
  putPreferences,
  upsertBookings,
  upsertPlanRuns,
  upsertSessions,
} from "@/backend/db/repos";
import { SYNC_LIMITS } from "@/shared/persistence";

let passed = 0;
const ok = (name: string) => {
  passed++;
  console.log(`  ✓ ${name}`);
};

// An unsigned JWT-shaped string with only the claim shape Swiggy uses (sub).
// Never sent anywhere — only decoded locally by swiggyUserIdFromToken.
const fakeToken = (sub: string) =>
  `${Buffer.from('{"alg":"none"}').toString("base64url")}.${Buffer.from(JSON.stringify({ sub, exp: 9e9 })).toString("base64url")}.x`;

async function fallback(): Promise<void> {
  console.log("fallback (no DATABASE_URL)");
  const saved = process.env.DATABASE_URL;
  const savedPg = process.env.POSTGRES_URL;
  delete process.env.DATABASE_URL;
  delete process.env.POSTGRES_URL;
  try {
    assert.equal(dbEnabled(), false);
    assert.equal(getDb(), null);
    ok("getDb() → null");
    await recordToolAudit({ serverUrl: "https://mcp.swiggy.com/food", tool: "update_food_cart", args: { x: 1 }, status: "ok" });
    ok("recordToolAudit is a silent no-op");
    const { GET, PUT } = await import("@/app/api/me/state/route");
    // the route wrapper rejects cross-origin writes (CSRF), so act like the app
    const sameOrigin = { Origin: "http://localhost:3000", "Sec-Fetch-Site": "same-origin" };
    const res = await GET(new Request("http://localhost:3000/api/me/state"));
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { enabled: false });
    const put = await PUT(new Request("http://localhost:3000/api/me/state", { method: "PUT", headers: sameOrigin, body: JSON.stringify({ bookings: [] }) }));
    assert.deepEqual(await put.json(), { enabled: false });
    ok("GET/PUT /api/me/state → { enabled:false }");
    const bad = await PUT(new Request("http://localhost:3000/api/me/state", { method: "PUT", headers: sameOrigin, body: "{not json" }));
    assert.equal(bad.status, 400);
    ok("PUT rejects invalid JSON");
  } finally {
    if (saved !== undefined) process.env.DATABASE_URL = saved;
    if (savedPg !== undefined) process.env.POSTGRES_URL = savedPg;
  }
}

function redaction(): void {
  console.log("audit redaction");
  const args = {
    addressId: "addr_123",
    restaurantId: "4567",
    cartId: "cart-9",
    name: "Asha Rao",
    phone: "+91 98765 43210",
    email: "asha@example.com",
    addressLine: "12 MG Road, Bengaluru",
    lat: 12.97,
    lng: 77.59,
    latitude: 12.97,
    deliveryInstructions: "ring twice",
    note: "call 9876543210",
    paymentMethod: "UPI",
    upiVpa: "asha@okbank",
    couponCode: "SAVE50",
    access_token: "eyJabc.def.ghi",
    guestCount: 2,
    items: [
      { spinId: "S1", quantity: 2, customerName: "Asha" },
      { spinId: "S2", quantity: 1 },
    ],
    reservationTime: 1_760_000_000,
    freeText: "Asha +91 98765 43210",
  };
  const s = summarizeArgs(args);
  const json = JSON.stringify(s);
  for (const pii of ["Asha", "98765", "asha@", "MG Road", "12.97", "77.59", "ring twice", "okbank", "SAVE50", "eyJabc"]) {
    assert.ok(!json.includes(pii), `summary leaks ${pii}: ${json}`);
  }
  ok("no name / phone / email / address / coords / notes / VPA / coupon / token");
  assert.equal(s.addressId, "addr_123");
  assert.equal(s.restaurantId, "4567");
  assert.equal(s.cartId, "cart-9");
  assert.equal(s.paymentMethod, "UPI");
  assert.equal(s.guestCount, 2);
  assert.equal(s.reservationTime, 1_760_000_000);
  assert.deepEqual(s.items, { count: 2, items: [{ spinId: "S1", quantity: 2, customerName: "[redacted]" }, { spinId: "S2", quantity: 1 }] });
  ok("ids, counts, enums, quantities kept; arrays summarised");

  const ids = extractIds({ cartKey: "k" }, { structuredContent: { data: { orderId: "ORD-1", cart: { cartId: 77 } } } });
  assert.deepEqual(ids, { orderId: "ORD-1", cartId: "77" });
  const fromText = extractIds({}, { content: [{ type: "text", text: JSON.stringify({ success: true, data: { order_id: "X9" } }) }] });
  assert.equal(fromText.orderId, "X9");
  ok("order / cart ids extracted from args and replies");

  const row = buildAuditRow(
    {
      serverUrl: "https://mcp.swiggy.com/dineout",
      tool: "book_table",
      args,
      status: "tool_error",
      error: new Error("Slot no longer available for 9876543210 / a@b.co"),
      durationMs: 812.4,
    },
    null,
  );
  assert.equal(row.server, "dineout");
  assert.ok(row.error && !/9876543210|a@b\.co/.test(row.error), row.error ?? "");
  assert.equal(row.durationMs, 812);
  ok("error text masked, server label derived");

  for (const t of ["update_cart", "checkout", "place_food_order", "book_table", "create_event_cart", "place_event_order", "confirm_order", "update_food_cart"]) {
    assert.ok(isMutatingTool(t), t);
  }
  for (const t of ["search_products", "get_cart", "get_food_orders", "get_booking_status", "check_payment_status"]) {
    assert.ok(!isMutatingTool(t), t);
  }
  ok("mutating vs read-only tool classification");

  assert.equal(swiggyUserIdFromToken(fakeToken("123456789")), "123456789");
  assert.equal(swiggyUserIdFromToken("garbage"), null);
  ok("identity from token claims (sub)");

  const huge = boundMessages([{ id: "a", role: "user", text: "hi", image: "x".repeat(SYNC_LIMITS.messageBytes + 10) }]);
  assert.deepEqual(huge, [{ id: "a", role: "user", text: "hi", createdAt: undefined, truncated: true }]);
  const many = boundMessages(Array.from({ length: SYNC_LIMITS.messagesPerSession + 5 }, (_, i) => ({ id: String(i) })));
  assert.equal(many.length, SYNC_LIMITS.messagesPerSession);
  assert.deepEqual(many[0], { id: "5" });
  ok("messages bounded (count, per-message size)");
}

async function database(): Promise<void> {
  if (!dbEnabled()) {
    console.log("database: SKIPPED (DATABASE_URL not set)");
    return;
  }
  console.log("database");
  const root = join(__dirname, "..");
  for (let i = 0; i < 2; i++) {
    execFileSync(process.execPath, [join(root, "scripts/db-migrate.mjs")], { stdio: "pipe", env: process.env });
  }
  ok("migrations apply (twice — idempotent)");

  const db = getDb();
  assert.ok(db);
  const { GET } = await import("@/app/api/me/state/route");
  const anon = await GET(new Request("http://localhost:3000/api/me/state"));
  assert.equal(anon.status, 401);
  const anonBody = (await anon.json()) as { enabled?: boolean; authenticated?: boolean };
  assert.equal(anonBody.enabled, true);
  assert.equal(anonBody.authenticated, false);
  ok("GET /api/me/state without a Swiggy session → 401 (never another user's data)");
  const subA = `test-${randomUUID()}`;
  const subB = `test-${randomUUID()}`;
  const a = await ensureUser(db, subA);
  const b = await ensureUser(db, subB);
  try {
    assert.equal(await ensureUser(db, subA), a);
    ok("ensureUser is idempotent");

    const t0 = Date.now() - 10_000;
    await upsertBookings(db, a, [
      { kind: "dineout", orderId: "T1", title: "Table", createdAt: t0, updatedAt: t0, party: 2, amount: 499.5, lat: 12.9, lng: 77.6, restaurantId: "R1", startsAt: t0 + 86_400_000 },
      { kind: "scenes", orderId: "T2", title: "Show", createdAt: t0, updatedAt: t0, eventId: "E1" },
    ]);
    let list = await listBookings(db, a);
    assert.equal(list.length, 2);
    const t1 = list.find((x) => x.orderId === "T1");
    assert.equal(t1?.amount, 499.5);
    assert.equal(t1?.party, 2);
    assert.equal(t1?.startsAt, t0 + 86_400_000);
    ok("bookings round-trip");

    await upsertBookings(db, a, [{ kind: "dineout", orderId: "T1", title: "STALE", createdAt: t0, updatedAt: t0 - 1 }]);
    assert.equal((await listBookings(db, a)).find((x) => x.orderId === "T1")?.title, "Table");
    await upsertBookings(db, a, [{ kind: "dineout", orderId: "T1", title: "Table", status: "CONFIRMED", statusAt: t0 + 5, createdAt: t0, updatedAt: t0 + 5 }]);
    list = await listBookings(db, a);
    const t1b = list.find((x) => x.orderId === "T1");
    assert.equal(t1b?.status, "CONFIRMED");
    assert.equal(t1b?.party, 2, "newer partial update keeps known fields");
    ok("older write ignored, newer wins (fields coalesced)");
    assert.equal((await listBookings(db, a, t0 + 1)).length, 1);
    ok("incremental pull (since)");
    assert.equal((await listBookings(db, b)).length, 0);
    ok("accounts are isolated");

    const msgs = [
      { id: "m1", role: "user", text: "biryani near me", createdAt: t0 },
      { id: "m2", role: "assistant", text: "Here are 3 places", createdAt: t0 + 1 },
    ];
    let written = await upsertSessions(db, a, [{ id: "S1", title: "Biryani", service: "food", updatedAt: t0, messages: msgs }]);
    assert.deepEqual(written, ["S1"]);
    let sessions = await listSessions(db, a);
    assert.equal(sessions.length, 1);
    assert.deepEqual(sessions[0].messages, msgs);
    ok("chat session + messages round-trip (verbatim JSON, order kept)");
    written = await upsertSessions(db, a, [{ id: "S1", title: "old", service: "food", updatedAt: t0 - 5, messages: [] }]);
    assert.deepEqual(written, []);
    assert.equal((await listSessions(db, a))[0].messages.length, 2);
    ok("stale session write ignored (server wins)");
    await upsertSessions(db, a, [{ id: "S1", title: "", service: "food", updatedAt: t0 + 10, messages: [], deleted: true }]);
    assert.equal((await listSessions(db, a)).length, 0, "tombstoned session hidden from full pull");
    sessions = await listSessions(db, a, t0);
    assert.equal(sessions[0]?.deleted, true, "tombstone visible to incremental pull");
    ok("delete syncs as a tombstone");

    assert.equal(await getPreferences(db, a), null);
    await putPreferences(db, a, { data: { preferences: "veg", allergies: "peanuts", budget: 800, kcalGoal: 2000, proteinGoal: 90 }, updatedAt: t0 });
    await putPreferences(db, a, { data: { preferences: "OLD", allergies: "", budget: 0, kcalGoal: 0, proteinGoal: 0 }, updatedAt: t0 - 1 });
    const prefs = await getPreferences(db, a);
    assert.equal(prefs?.data.preferences, "veg");
    assert.equal(prefs?.data.budget, 800);
    ok("preferences upsert, newer wins");

    await upsertSessions(db, a, [{ id: "S2", title: "Plan", service: "plan", updatedAt: t0, messages: [] }]);
    await upsertPlanRuns(db, a, [{ sessionId: "S2", run: { v: 1, planIds: ["p"], mode: "idle" }, updatedAt: t0 }]);
    const runs = await listPlanRuns(db, a);
    assert.deepEqual(runs.map((r) => r.run), [{ v: 1, planIds: ["p"], mode: "idle" }]);
    ok("plan runs round-trip");

    await recordToolAudit({
      serverUrl: "https://mcp.swiggy.com/food",
      tool: "place_food_order",
      args: { addressId: "A1", phone: "9876543210", paymentMethod: "UPI" },
      token: fakeToken(subA),
      status: "ok",
      result: { structuredContent: { data: { orderId: "ORD-777" } } },
      durationMs: 1234,
    });
    await recordToolAudit({ serverUrl: "https://mcp.swiggy.com/food", tool: "search_menu", args: {}, token: fakeToken(subA), status: "ok" });
    const audit = await listAudit(db, a);
    assert.equal(audit.length, 1, "only the mutating call is logged");
    assert.equal(audit[0].tool, "place_food_order");
    assert.equal(audit[0].orderId, "ORD-777");
    assert.equal(audit[0].status, "ok");
    assert.ok(!JSON.stringify(audit[0].argsSummary).includes("9876543210"));
    ok("audit row written for mutating call, redacted, read-only call skipped");
  } finally {
    await deleteUser(db, a);
    await deleteUser(db, b);
  }
  assert.equal((await listBookings(db, a)).length, 0);
  ok("deleteUser cascades");
  await closeDb();
}


/** 4. Client merge engine (cloudSync) against a scripted /api/me/state, with a localStorage shim. */
async function clientSync(): Promise<void> {
  console.log("client sync (cloudSync merge rules)");
  const store = new Map<string, string>();
  const ls = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    key: (i: number) => [...store.keys()][i] ?? null,
    get length() {
      return store.size;
    },
  };
  const et = new EventTarget();
  const gx = globalThis as unknown as Record<string, unknown>;
  const realFetch = globalThis.fetch;
  gx.window = Object.assign(globalThis, {
    localStorage: ls,
    addEventListener: et.addEventListener.bind(et),
    removeEventListener: et.removeEventListener.bind(et),
    dispatchEvent: et.dispatchEvent.bind(et),
  });
  gx.document = { visibilityState: "visible", addEventListener() {}, removeEventListener() {} };
  const puts: Record<string, unknown>[] = [];
  let server: Record<string, unknown> = { enabled: true, authenticated: true, account: "acctA", serverTime: 1000, bookings: [], sessions: [], preferences: null, planRuns: [] };
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    if (init?.method === "PUT") {
      puts.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      return new Response(JSON.stringify({ ok: true, enabled: true }), { status: 200 });
    }
    return new Response(JSON.stringify(server), { status: 200 });
  }) as typeof fetch;
  try {
    const { saveBooking, loadBookings } = await import("@/frontend/state/bookings");
    const { upsertSession, loadSessionList } = await import("@/frontend/state/history");
    const { startCloudSync, stopCloudSync, pullNow } = await import("@/frontend/state/cloudSync");
    type Put = { bookings?: { orderId: string }[]; sessions?: { id: string }[]; preferences?: { data: { preferences: string } } };

    ls.setItem("swiggy-preferences-v1", "veg");
    saveBooking(undefined, { kind: "dineout", orderId: "L1", title: "Local table", createdAt: 10 });
    upsertSession({ id: "s1", title: "Local chat", service: "food", updatedAt: 50, messages: [{ id: "m", role: "user", text: "hi", createdAt: 1 }] });
    await startCloudSync(undefined);
    const first = puts[0] as Put;
    assert.equal(puts.length, 1);
    assert.equal(first.bookings?.[0].orderId, "L1");
    assert.equal(first.sessions?.[0].id, "s1");
    assert.equal(first.preferences?.data.preferences, "veg");
    ok("first login migrates existing localStorage data to the server");

    server = {
      ...server,
      serverTime: 2000,
      bookings: [{ kind: "scenes", orderId: "R1", title: "Remote show", createdAt: 20, updatedAt: 20 }],
      sessions: [
        { id: "s1", title: "Edited elsewhere", service: "food", updatedAt: 99, messages: [] },
        { id: "s2", title: "Remote chat", service: "dineout", updatedAt: 80, messages: [] },
      ],
    };
    puts.length = 0;
    await pullNow();
    assert.deepEqual(loadBookings(undefined).map((b) => b.orderId).sort(), ["L1", "R1"]);
    assert.equal(loadSessionList().find((x) => x.id === "s1")?.title, "Edited elsewhere");
    assert.ok(loadSessionList().some((x) => x.id === "s2"));
    assert.equal(puts.length, 0, "no echo push");
    ok("server-newer records merge into localStorage (cross-device), no echo");

    server = { enabled: true, authenticated: true, account: "acctB", serverTime: 3000, bookings: [], sessions: [], preferences: null, planRuns: [] };
    await pullNow();
    assert.equal(loadBookings(undefined).length, 0);
    assert.equal(loadSessionList().length, 0);
    ok("a different account in the same browser replaces the local caches");
    stopCloudSync();

    server = { enabled: false };
    saveBooking(undefined, { kind: "dineout", orderId: "Z", title: "x", createdAt: 1 });
    puts.length = 0;
    await startCloudSync("u");
    assert.equal(puts.length, 0);
    stopCloudSync();
    ok("server without a DB → sync switches off, nothing is sent");
  } finally {
    globalThis.fetch = realFetch;
  }
}

void (async () => {
  try {
    await fallback();
    redaction();
    await database();
    await clientSync();
    console.log(`\nverify-db: ${passed} checks passed`);
  } catch (err) {
    console.error(err);
    await closeDb().catch(() => {});
    process.exit(1);
  }
})();
