// Server boot hook (Next.js instrumentation): validate the environment once and
// log a clear list of what is missing, and report uncaught request errors as
// one structured log line each (no stack traces or PII reach the browser —
// that is app/error.tsx's job; this is for the logs).

import type { Instrumentation } from "next";

export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { checkEnv, formatEnvReport } = await import("@/backend/config/env-schema");
  const { log } = await import("@/backend/obs/logger");
  const report = checkEnv();
  const summary = formatEnvReport(report);
  if (!report.ok) {
    // Don't crash the server: /api/health stays up and /api/ready reports 503
    // with the same list, so a bad deploy is visible instead of a boot loop.
    log.error("env_invalid", { errors: report.errors, warnings: report.warnings });
    if (process.env.NODE_ENV !== "production") console.error(`\n${summary}\n`);
  } else {
    log.info("boot", {
      env: process.env.VERCEL_ENV ?? process.env.NODE_ENV,
      region: process.env.VERCEL_REGION,
      llmProviders: report.features.llmProviders,
      orders: report.features.orders,
      database: report.features.database,
      ...(report.warnings.length ? { warnings: report.warnings } : {}),
    });
  }
}

export const onRequestError: Instrumentation.onRequestError = async (err, request, context) => {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { errorFields, log } = await import("@/backend/obs/logger");
  const error = err as Error & { digest?: string };
  const header = (name: string) => {
    const v = request.headers[name];
    return Array.isArray(v) ? v[0] : v;
  };
  log.error("request_error", {
    method: request.method,
    // path only — query strings can carry ids / coordinates
    path: request.path.split("?")[0],
    routePath: context.routePath,
    routeType: context.routeType,
    digest: error.digest,
    requestId: header("x-vercel-id") ?? header("x-request-id"),
    ...errorFields(err),
  });
};
