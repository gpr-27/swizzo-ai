#!/usr/bin/env node
// Apply the SQL migrations in ./drizzle to the app database. Prefers the direct
// (unpooled) URL when set — DDL through pgbouncer is unreliable.
// Safe for CI / deploy: no URL → prints a notice and exits 0; concurrent
// deploys are serialised with a Postgres advisory lock; already-applied
// migrations are skipped (drizzle's __drizzle_migrations journal).
//
//   npm run db:migrate                                  (reads .env.local if present)
//   DATABASE_URL=postgres://… node scripts/db-migrate.mjs

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
for (const f of [".env.local", ".env"]) {
  const p = join(root, f);
  if (existsSync(p) && typeof process.loadEnvFile === "function") {
    try {
      process.loadEnvFile(p); // never overrides variables already set
    } catch {
      // unreadable env file — rely on the real environment
    }
  }
}

const url =
  process.env.DATABASE_URL_UNPOOLED?.trim() || // Neon (Vercel Marketplace)
  process.env.POSTGRES_URL_NON_POOLING?.trim() || // Supabase (Vercel Marketplace)
  process.env.DATABASE_URL?.trim() ||
  process.env.POSTGRES_URL?.trim();
if (!url) {
  console.log("[db:migrate] DATABASE_URL not set — skipping migrations (app runs localStorage-only).");
  process.exit(0);
}

const local = /@(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(url);
const sql = postgres(url, {
  max: 1,
  connect_timeout: 15,
  prepare: false,
  ssl: local || /sslmode=disable/.test(url) ? false : "require",
  onnotice: () => {},
});

const LOCK_ID = 727_001; // arbitrary, constant for this app
let host = "?";
try {
  host = new URL(url).host;
} catch {
  // ignore
}

try {
  console.log(`[db:migrate] migrating postgres @ ${host}`);
  await sql`select pg_advisory_lock(${LOCK_ID})`;
  try {
    await migrate(drizzle(sql), { migrationsFolder: join(root, "drizzle") });
  } finally {
    await sql`select pg_advisory_unlock(${LOCK_ID})`;
  }
  const [{ n }] = await sql`select count(*)::int as n from drizzle.__drizzle_migrations`;
  console.log(`[db:migrate] done — ${n} migration(s) applied in total`);
} catch (err) {
  console.error("[db:migrate] failed:", err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  await sql.end({ timeout: 5 });
}
