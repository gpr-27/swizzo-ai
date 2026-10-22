// LIVE (opt-in): the LLM fallback order — scripts/test-provider-chain.ts, run
// unchanged in a child process. Needs LIVE_LLM=1 plus provider keys in the
// environment (or .env.local); no Swiggy tools are used.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { ROOT } from "../fixtures/live";

describe.skipIf(process.env.LIVE_LLM !== "1")("live LLM provider chain", () => {
  it("every step of the chain answers (✓ lines, no ✗)", () => {
    const envFile = join(ROOT, ".env.local");
    const out = execFileSync(
      "npx",
      ["tsx", "--tsconfig", "tsconfig.json", ...(existsSync(envFile) ? [`--env-file=${envFile}`] : []), "scripts/test-provider-chain.ts"],
      { cwd: ROOT, encoding: "utf8", timeout: 115_000 },
    );
    const lines = out.split("\n").filter((l) => /^[✓✗]/.test(l));
    expect(lines.length).toBeGreaterThanOrEqual(6);
    expect(lines.filter((l) => l.startsWith("✗"))).toEqual([]);
  }, 120_000);
});
