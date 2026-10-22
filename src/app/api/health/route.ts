// GET /api/health — liveness. Answers 200 as long as the function can run; it
// touches no env, session, database or Swiggy, so it is safe for uptime probes.

import { withObservability } from "@/backend/obs/route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withObservability("api/health", () =>
  Response.json(
    { ok: true, status: "alive", time: new Date().toISOString() },
    { headers: { "Cache-Control": "no-store" } },
  ),
);
