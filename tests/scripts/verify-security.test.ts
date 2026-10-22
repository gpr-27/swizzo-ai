// scripts/verify-security.ts, run unchanged (child process: its redaction check
// reads process.stdout, which Vitest owns in-process). A ✗ / throw fails it.
import { scriptSuite } from "./runScript";

await scriptSuite("verify-security", { exits: "onFailure", mode: "child", timeoutMs: 120_000 });
