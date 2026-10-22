// Vitest — one runner for everything that needs no network (`npm test`) plus
// an opt-in live project (`npm run test:live`, read-only Swiggy tools only).
//   node        scripts/*.ts checks (run 1:1), pure helpers, API route handlers
//   components  React Testing Library + jsdom on recorded LIVE payloads
//   live        real read-only Swiggy calls — skipped unless SWIGGY_TOKEN is set
// See docs/TESTING.md.
import { fileURLToPath } from "node:url";

import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

const src = fileURLToPath(new URL("./src", import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: { alias: [{ find: /^@\//, replacement: `${src}/` }] },
  test: {
    testTimeout: 30_000,
    hookTimeout: 30_000,
    restoreMocks: true,
    unstubGlobals: true,
    unstubEnvs: true,
    coverage: {
      provider: "v8",
      include: ["src/**/*.{ts,tsx}"],
      exclude: ["src/**/*.d.ts"],
      reporter: ["text-summary", "html", "lcov", "json-summary"],
      reportsDirectory: "coverage",
      // ratchet: a little under today's numbers (Oct 2026: lines 38.8%, statements
      // 37.5%, functions 35.4%, branches 32.5%) so coverage can't silently drop
      thresholds: { lines: 36, statements: 35, functions: 33, branches: 30 },
    },
    projects: [
      {
        extends: true,
        test: {
          name: "node",
          environment: "node",
          include: ["tests/scripts/**/*.test.ts", "tests/unit/**/*.test.ts", "tests/api/**/*.test.ts"],
          setupFiles: ["tests/setup/no-network.ts"],
        },
      },
      {
        extends: true,
        test: {
          name: "components",
          environment: "jsdom",
          include: ["tests/components/**/*.test.tsx"],
          setupFiles: ["tests/setup/no-network.ts", "tests/setup/dom.ts"],
        },
      },
      {
        extends: true,
        test: {
          name: "live",
          environment: "node",
          include: ["tests/live/**/*.test.ts"],
          testTimeout: 120_000,
        },
      },
    ],
  },
});
