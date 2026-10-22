// Builds (once) and starts the production server for Playwright on E2E_PORT
// (default 3200), from its own dist dir (.next-e2e) so it never touches the
// .next of a dev / start server running on :3000.
//   E2E_REBUILD=1     force a fresh `next build`
//   E2E_SWIGGY_COOKIE set → keep SESSION_SECRET from the environment / .env.local
//                     (it must be the secret that sealed that cookie)
import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..", "..");
const port = process.env.E2E_PORT || "3200";
if (port === "3000") throw new Error("E2E must not use :3000 (the dev server's port)");
const distDir = ".next-e2e";

const env = {
  ...process.env,
  NEXT_DIST_DIR: distDir,
  NEXT_TELEMETRY_DISABLED: "1",
  APP_BASE_URL: process.env.E2E_APP_BASE_URL || `http://localhost:${port}`,
  SWIGGY_OAUTH_CLIENT_ID: process.env.SWIGGY_OAUTH_CLIENT_ID || "swiggy-mcp",
  // never place real orders from an E2E server
  SWIGGY_ENABLE_ORDERS: "false",
};
if (!process.env.E2E_SWIGGY_COOKIE) {
  // dummy secret: smoke tests never hold a real session
  env.SESSION_SECRET = "e2e-dummy-session-secret-not-for-production-000";
}

const npx = process.platform === "win32" ? "npx.cmd" : "npx";
if (process.env.E2E_REBUILD === "1" || !existsSync(join(root, distDir, "BUILD_ID"))) {
  console.log(`[e2e] next build → ${distDir}`);
  execFileSync(npx, ["next", "build"], { cwd: root, env, stdio: "inherit" });
}
console.log(`[e2e] next start -p ${port}`);
const child = spawn(npx, ["next", "start", "-p", port], { cwd: root, env, stdio: "inherit" });
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => child.kill(sig));
child.on("exit", (code) => process.exit(code ?? 0));
