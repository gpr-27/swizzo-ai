// Postgres connection for Vercel Functions (Fluid Compute, Node runtime).
//
// Optional by design: when DATABASE_URL is unset, getDb() returns null and the
// app behaves exactly as before (browser localStorage only). One log line says
// which mode this process is in.
//
// Use the POOLED connection string (Neon "-pooler" host / Supabase port 6543):
// pgbouncer in transaction mode can't hold prepared statements, so they're off.
// A small per-instance pool is cached on globalThis so Fluid Compute's
// concurrent requests and Next dev hot reloads share it.

import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import * as schema from "./schema";

export type Db = PostgresJsDatabase<typeof schema>;

const g = globalThis as unknown as {
  __swizzoDb?: { url: string; db: Db; sql: postgres.Sql };
  __swizzoDbLogged?: boolean;
};

/** Pooled URL: DATABASE_URL (Neon integration), else POSTGRES_URL (Supabase integration). */
export function databaseUrl(): string {
  return process.env.DATABASE_URL?.trim() || process.env.POSTGRES_URL?.trim() || "";
}

/** True when a database is configured for this process. */
export function dbEnabled(): boolean {
  return databaseUrl().length > 0;
}

function logModeOnce(enabled: boolean, url?: string): void {
  if (g.__swizzoDbLogged) return;
  g.__swizzoDbLogged = true;
  if (enabled && url) {
    let host = "?";
    try {
      host = new URL(url).host;
    } catch {
      // unparsable URL — postgres() will report it
    }
    console.info(`[db] persistence enabled (postgres @ ${host})`);
  } else {
    console.info("[db] DATABASE_URL not set — persistence disabled, browser localStorage only");
  }
}

/** The shared Drizzle client, or null when no DATABASE_URL is configured. */
export function getDb(): Db | null {
  const url = databaseUrl();
  if (!url) {
    logModeOnce(false);
    return null;
  }
  if (g.__swizzoDb?.url === url) return g.__swizzoDb.db;
  logModeOnce(true, url);
  const local = /@(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(url);
  const sql = postgres(url, {
    max: Number(process.env.DATABASE_POOL_MAX) || 5,
    idle_timeout: 20,
    connect_timeout: 10,
    prepare: false,
    ssl: local || /sslmode=disable/.test(url) ? false : "require",
    onnotice: () => {},
  });
  const db = drizzle(sql, { schema });
  g.__swizzoDb = { url, db, sql };
  return db;
}

/** Close the pool (scripts/tests only). */
export async function closeDb(): Promise<void> {
  const cur = g.__swizzoDb;
  g.__swizzoDb = undefined;
  if (cur) await cur.sql.end({ timeout: 5 });
}
