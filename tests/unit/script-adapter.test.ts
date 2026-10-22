// The adapter that runs scripts/*.ts inside Vitest must turn ✗ lines, thrown
// assertions and non-zero exits into failures (otherwise a broken check would
// pass CI silently).
import { describe, expect, it } from "vitest";

import { runScript } from "../scripts/runScript";

describe("script adapter", () => {
  it("captures ✓ / ✗ check lines and the async exit code", async () => {
    const run = await runScript("../unit/fixtures/sample-check-script.ts", { exits: "always", timeoutMs: 5_000 });
    expect(run.checks.map((c) => [c.ok, c.label])).toEqual([
      [true, "passes"],
      [false, "fails { why: 'detail' }"],
    ]);
    expect(run.exitCode).toBe(1);
    expect(run.crash).toBeUndefined();
  });

  it("reports a thrown assertion as a crash", async () => {
    const run = await runScript("../unit/fixtures/sample-throw-script.ts", { exits: "never" });
    expect(String(run.crash)).toMatch(/math is broken/);
  });
});
