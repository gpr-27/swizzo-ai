// GET /api/ready — readiness: is this deployment configured to serve users?
// Checks the env contract (backend/config/env-schema.ts): required variables
// present, APP_BASE_URL https:// in production, at least one LLM key. Reports
// variable NAMES and booleans only — never values. Also lists open circuit
// breakers (which upstream is being fast-failed right now), without user keys.
// 200 when ready, 503 otherwise.

import { checkEnv } from "@/backend/config/env-schema";
import { withObservability } from "@/backend/obs/route";
import { breakers } from "@/backend/resilience/breaker";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function openCircuits() {
  return {
    // Server-wide circuits are keyed by MCP URL; per-user ones carry a token hash — omit those.
    swiggy: breakers.mcp
      .openKeys()
      .filter((c) => !c.key.includes("|"))
      .map((c) => ({ server: c.key.replace(/^https?:\/\/[^/]+/, ""), retryInSec: Math.ceil(c.retryInMs / 1000) })),
    llm: breakers.llm.openKeys().map((c) => ({ step: c.key, retryInSec: Math.ceil(c.retryInMs / 1000) })),
  };
}

export const GET = withObservability("api/ready", () => {
  const report = checkEnv();
  return Response.json(
    {
      ok: report.ok,
      status: report.ok ? "ready" : "misconfigured",
      ...(report.errors.length ? { errors: report.errors } : {}),
      ...(report.warnings.length ? { warnings: report.warnings } : {}),
      features: report.features,
      circuits: openCircuits(),
      deployment: {
        env: process.env.VERCEL_ENV ?? process.env.NODE_ENV ?? "development",
        region: process.env.VERCEL_REGION ?? null,
        commit: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? null,
      },
    },
    { status: report.ok ? 200 : 503, headers: { "Cache-Control": "no-store" } },
  );
});
