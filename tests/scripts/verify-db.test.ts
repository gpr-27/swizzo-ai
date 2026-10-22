// scripts/verify-db.ts, run unchanged inside Vitest (each printed check = one test).
// Offline parts only here (no DATABASE_URL); CI's `db` job runs it against Postgres.
import { scriptSuite } from "./runScript";

await scriptSuite("verify-db", { exits: "onFailure", doneWhen: /^\s*verify-db: \d+ checks passed/, env: { DATABASE_URL: undefined } });
