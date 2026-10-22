// Runs one of the historical scripts/*.ts check scripts inside Vitest, 1:1:
// the script is imported unchanged (so `npx tsx scripts/<name>.ts` keeps
// working exactly as before), its console output is captured, and every
// "✓ / ✗ / ok" check line it prints becomes its own Vitest test. A thrown
// assertion, an uncaught async error or a non-zero exit fails the suite.
//
// Usage (top level of a *.test.ts, so the checks exist at collection time):
//   await scriptSuite("verify-dineout", { exits: "always" });

import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { inspect } from "node:util";

import { describe, expect, it, vi } from "vitest";

export interface ScriptOptions {
  /**
   * How the script ends: "always" = it calls process.exit(code) when done
   * (possibly asynchronously); "never" = it is done when its module finished
   * evaluating; "onFailure" = it only exits on failure (finishes on a timer).
   */
  exits: "always" | "never" | "onFailure";
  /** For async scripts that only exit on failure: a line that marks success. */
  doneWhen?: RegExp;
  /** Env vars to set while the script runs (e.g. SWIGGY_TOKEN for live checks). */
  env?: Record<string, string | undefined>;
  /**
   * "child": run with `npx tsx` in a child process instead of in-process —
   * for scripts that inspect process.stdout themselves (Vitest owns the
   * worker's console). Same parsing; no coverage.
   */
  mode?: "inprocess" | "child";
  /** Max wait for an async script to finish. */
  timeoutMs?: number;
}

export interface ScriptRun {
  lines: string[];
  checks: { ok: boolean; label: string; detail: string }[];
  exitCode: number | undefined;
  crash: unknown;
}

const CHECK = /^\s*(✓|✗|ok )\s+(.*)$/;

function fmt(a: unknown): string {
  return typeof a === "string" ? a : inspect(a, { depth: 6, breakLength: 120 });
}

function runChild(name: string, opts: ScriptOptions): ScriptRun {
  const root = join(__dirname, "..", "..");
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const [k, v] of Object.entries(opts.env ?? {})) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }
  delete env.VITEST;
  delete env.NODE_OPTIONS;
  const r = spawnSync("npx", ["tsx", "--tsconfig", "tsconfig.json", `scripts/${name}.ts`], {
    cwd: root,
    env,
    encoding: "utf8",
    timeout: opts.timeoutMs ?? 60_000,
  });
  const lines = `${r.stdout ?? ""}\n${r.stderr ?? ""}`.split("\n");
  const checks = lines.map((l) => CHECK.exec(l)).filter(Boolean).map((m) => ({ ok: m![1] !== "✗", label: m![2].trim(), detail: "" }));
  return { lines, checks, exitCode: r.status ?? 1, crash: r.error ?? (r.status ? new Error(`exit ${r.status}:\n${lines.slice(-30).join("\n")}`) : undefined) };
}

export async function runScript(name: string, opts: ScriptOptions): Promise<ScriptRun> {
  if (opts.mode === "child") return runChild(name, opts);
  const lines: string[] = [];
  let onDone: () => void = () => {};
  const done = new Promise<void>((r) => (onDone = r));
  const capture = (...args: unknown[]) => {
    const line = args.map(fmt).join(" ");
    lines.push(line);
    if (opts.doneWhen?.test(line)) onDone();
  };
  const spies = [
    vi.spyOn(console, "log").mockImplementation(capture),
    vi.spyOn(console, "error").mockImplementation(capture),
    vi.spyOn(console, "warn").mockImplementation(() => {}),
    vi.spyOn(console, "info").mockImplementation(() => {}),
  ];
  let exitCode: number | undefined;
  let onExit: () => void = () => {};
  const exited = new Promise<void>((r) => (onExit = r));
  spies.push(
    vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      exitCode ??= code ?? 0;
      onExit();
      return undefined as never;
    }) as typeof process.exit),
  );
  const savedEnv: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(opts.env ?? {})) {
    savedEnv[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  const savedExitCode = process.exitCode;
  process.exitCode = undefined;

  let crash: unknown;
  const unhandled = (err: unknown) => {
    crash ??= err;
    onExit();
  };
  process.on("unhandledRejection", unhandled);
  try {
    await import(/* @vite-ignore */ name.includes("/") ? name : `../../scripts/${name}.ts`);
    if (opts.exits === "always" || opts.doneWhen) {
      const timeout = new Promise<void>((_, rej) =>
        setTimeout(() => rej(new Error(`${name} did not finish within ${opts.timeoutMs ?? 60_000} ms`)), opts.timeoutMs ?? 60_000),
      );
      await Promise.race([exited, done, timeout]);
    } else {
      // let queued microtasks / zero-delay timers (bridge checks, summaries) run
      await new Promise((r) => setTimeout(r, opts.exits === "onFailure" ? 100 : 10));
    }
  } catch (err) {
    crash ??= err;
  } finally {
    process.off("unhandledRejection", unhandled);
    for (const s of spies) s.mockRestore();
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    // scripts flag failures through process.exitCode too (verify-dineout)
    if (process.exitCode && exitCode === undefined) exitCode = Number(process.exitCode);
    process.exitCode = savedExitCode;
  }

  const checks: ScriptRun["checks"] = [];
  for (const line of lines) {
    const [first, ...rest] = line.split("\n");
    const m = CHECK.exec(first);
    if (m) checks.push({ ok: m[1] !== "✗", label: m[2].trim(), detail: rest.join("\n") });
  }
  return { lines, checks, exitCode, crash };
}

/** Registers one Vitest test per check line the script printed, plus a completion test. */
export async function scriptSuite(name: string, opts: ScriptOptions): Promise<void> {
  const run = await runScript(name, opts);
  describe(`scripts/${name}.ts`, () => {
    const seen = new Map<string, number>();
    for (const c of run.checks) {
      const n = (seen.get(c.label) ?? 0) + 1;
      seen.set(c.label, n);
      it(n > 1 ? `${c.label} (#${n})` : c.label, () => {
        if (!c.ok) throw new Error(`check failed: ${c.label}${c.detail ? `\n${c.detail}` : ""}`);
      });
    }
    it("ran to completion (no thrown assertion, exit code 0)", () => {
      if (run.crash) {
        const e = run.crash as Error;
        throw new Error(`${name} threw: ${e?.stack ?? String(e)}\n--- output ---\n${run.lines.join("\n")}`);
      }
      expect(run.exitCode ?? 0, run.lines.slice(-20).join("\n")).toBe(0);
    });
  });
}
