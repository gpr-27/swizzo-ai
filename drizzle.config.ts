// drizzle-kit config: `npm run db:generate` (schema → SQL in ./drizzle),
// `npm run db:studio`. Migrations are applied by scripts/db-migrate.ts.
import { existsSync } from "node:fs";

import { defineConfig } from "drizzle-kit";

// Pick up DATABASE_URL from .env.local (never overrides the real environment).
for (const f of [".env.local", ".env"]) {
  if (existsSync(f)) {
    try {
      process.loadEnvFile(f);
    } catch {
      // ignore unreadable env files
    }
  }
}

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/backend/db/schema.ts",
  out: "./drizzle",
  dbCredentials: {
    // Migrations/studio prefer the direct (unpooled) URL when one is set.
    url:
      process.env.DATABASE_URL_UNPOOLED?.trim() ||
      process.env.POSTGRES_URL_NON_POOLING?.trim() ||
      process.env.DATABASE_URL?.trim() ||
      process.env.POSTGRES_URL?.trim() ||
      "postgres://swizzo:swizzo@localhost:5433/swizzo",
  },
  strict: true,
  verbose: true,
});
