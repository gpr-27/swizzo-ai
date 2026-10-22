// Playwright E2E against a PRODUCTION build (`next build` → `next start`) on a
// spare port — never the :3000 dev server.
//   smoke      no Swiggy login needed (CI): landing, tabs, OAuth authorize URL,
//              error pages, health/ready, 401s. Swiggy is never contacted.
//   logged-in  opt-in (E2E_SWIGGY_COOKIE): READ-ONLY flows on a real account;
//              never taps Confirm / Pay / Checkout / Approve / Add, and every
//              state-changing app route is blocked at the network layer.
// E2E_BASE_URL=https://… runs against an existing deployment instead of
// starting a server. See docs/TESTING.md.
import { defineConfig, devices } from "@playwright/test";

const PORT = Number(process.env.E2E_PORT || 3200);
const external = process.env.E2E_BASE_URL?.replace(/\/+$/, "");
const baseURL = external || `http://localhost:${PORT}`;

export default defineConfig({
  testDir: "tests/e2e",
  outputDir: "test-results",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 2 : undefined,
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : [["list"]],
  timeout: 45_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "smoke", testDir: "tests/e2e/smoke", use: { ...devices["Desktop Chrome"] } },
    { name: "smoke-mobile", testDir: "tests/e2e/smoke", testMatch: /mobile\.spec\.ts/, use: { ...devices["Pixel 7"] } },
    { name: "logged-in", testDir: "tests/e2e/live", use: { ...devices["Desktop Chrome"] }, timeout: 120_000 },
  ],
  webServer: external
    ? undefined
    : {
        command: `node tests/e2e/serve.mjs`,
        url: `${baseURL}/api/health`,
        reuseExistingServer: !process.env.CI,
        timeout: 300_000,
        stdout: process.env.E2E_SERVER_LOGS ? "pipe" : "ignore",
        stderr: "pipe",
        env: { E2E_PORT: String(PORT) },
      },
});
