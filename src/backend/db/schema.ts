// Postgres schema (Drizzle). Migrations are generated from this file into
// ./drizzle by `npm run db:generate` and applied by `npm run db:migrate`.
// See docs/DATABASE.md.
//
// Nothing here stores a Swiggy token: the access/refresh tokens live only in
// the AES-GCM sealed session cookie (src/backend/config/session.ts). A user is
// keyed by the stable Swiggy account id from the token's claims (`user_id`,
// else `sub` — see ./identity.ts).

import { sql } from "drizzle-orm";
import {
  bigserial,
  check,
  doublePrecision,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  /** Stable Swiggy account id (JWT `user_id`, else `sub`). Not a secret. */
  swiggyUserId: text("swiggy_user_id").notNull().unique(),
  createdAt: createdAt(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Dineout tables / Scenes tickets made in this app (Swiggy has no list-bookings tool). */
export const bookings = pgTable(
  "bookings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    orderId: text("order_id").notNull(),
    title: text("title").notNull(),
    details: text("details"),
    restaurantId: text("restaurant_id"),
    eventId: text("event_id"),
    /** Reservation / show start. */
    startsAt: timestamp("starts_at", { withTimezone: true }),
    partySize: integer("party_size"),
    /** Rupees, as Swiggy reported it. */
    amount: numeric("amount", { precision: 12, scale: 2, mode: "number" }),
    lat: doublePrecision("lat"),
    lng: doublePrecision("lng"),
    lastStatus: text("last_status"),
    lastStatusAt: timestamp("last_status_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("bookings_user_kind_order_uq").on(t.userId, t.kind, t.orderId),
    index("bookings_user_created_idx").on(t.userId, t.createdAt),
    check("bookings_kind_ck", sql`${t.kind} in ('dineout', 'scenes')`),
  ],
);

/** One chat thread (the client's ChatSession meta). Soft-deleted so deletes sync across devices. */
export const chatSessions = pgTable(
  "chat_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** The id the browser generated for the session. */
    clientId: text("client_id").notNull(),
    title: text("title").notNull().default(""),
    service: text("service").notNull(),
    messageCount: integer("message_count").notNull().default(0),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("chat_sessions_user_client_uq").on(t.userId, t.clientId),
    index("chat_sessions_user_updated_idx").on(t.userId, t.updatedAt),
  ],
);

/** Messages of a session, in order — the exact ChatMessage JSON the client renders. */
export const chatMessages = pgTable(
  "chat_messages",
  {
    sessionId: uuid("session_id")
      .notNull()
      .references(() => chatSessions.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    message: jsonb("message").notNull(),
  },
  (t) => [primaryKey({ columns: [t.sessionId, t.position] })],
);

export const preferences = pgTable("preferences", {
  userId: uuid("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  /** { preferences, allergies, budget, kcalGoal, proteinGoal } */
  data: jsonb("data").notNull(),
  updatedAt: updatedAt(),
});

/** Plan-tab run state per chat session (swiggy-planrun-v1:<sid> in the browser). */
export const planRuns = pgTable(
  "plan_runs",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    sessionClientId: text("session_client_id").notNull(),
    run: jsonb("run").notNull(),
    updatedAt: updatedAt(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.sessionClientId] })],
);

/** Every mutating Swiggy tool call the app makes. Args are redacted (./audit.ts). */
export const auditLog = pgTable(
  "audit_log",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
    server: text("server").notNull(),
    tool: text("tool").notNull(),
    argsSummary: jsonb("args_summary").notNull(),
    /** ok | tool_error | auth_error | error */
    status: text("status").notNull(),
    error: text("error"),
    orderId: text("order_id"),
    cartId: text("cart_id"),
    correlationId: text("correlation_id"),
    durationMs: integer("duration_ms"),
    createdAt: createdAt(),
  },
  (t) => [
    index("audit_log_user_created_idx").on(t.userId, t.createdAt),
    index("audit_log_order_idx").on(t.orderId),
  ],
);
