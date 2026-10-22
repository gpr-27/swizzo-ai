// Environment contract, validated once at server boot (src/instrumentation.ts)
// and on demand by /api/ready. Every variable the server reads is listed here
// with whether it is required; `.env.example` documents the same set.
//
// Reports only variable NAMES and problems — never values.

import { z } from "zod";

const isProd = () => process.env.NODE_ENV === "production";
const onVercel = () => Boolean(process.env.VERCEL);

const optionalString = z.string().trim().optional();
const flag = z.enum(["true", "false", "1", "0", ""]).optional();

export const envSchema = z.object({
  // ── LLM provider chain (at least one key required; see the refinement below) ──
  ANTHROPIC_API_KEY: optionalString,
  GROQ_API_KEY: optionalString,
  GROQ_API_KEY_2: optionalString,
  GEMINI_API_KEY: optionalString,
  GEMINI_API_KEY_2: optionalString,

  // ── Swiggy OAuth / session ──
  // Required in production (checked below); local dev falls back to http://localhost:3000.
  APP_BASE_URL: z.string().trim().url({ message: "must be an absolute URL, e.g. https://swizzo.example.com" }).optional(),
  // Required in production (checked below); local dev uses a per-process key.
  SESSION_SECRET: z.string().trim().min(32, { message: "must be at least 32 characters (32 random bytes, base64url)" }).optional(),
  SWIGGY_OAUTH_CLIENT_ID: optionalString,
  SWIGGY_OAUTH_REDIRECT_URI: z.string().trim().url().optional(),
  SWIGGY_MCP_BASE: z.string().trim().url().optional(),
  SWIGGY_AUTH_BASE: z.string().trim().url().optional(),
  SWIGGY_ENABLE_ORDERS: flag,
  SWIGGY_DEFAULT_ADDRESS_ID: optionalString,

  // ── Optional infrastructure ──
  DATABASE_URL: optionalString,
  DATABASE_URL_UNPOOLED: optionalString,
  DATABASE_POOL_MAX: z.string().regex(/^\d+$/, { message: "must be a whole number" }).optional(),

  // ── Security knobs ──
  ALLOWED_ORIGINS: optionalString,
  RATE_LIMIT_DISABLED: flag,

  // ── Observability ──
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).optional(),
  LOG_FORMAT: z.enum(["json", "pretty"]).optional(),
  NEXT_PUBLIC_VERCEL_ANALYTICS: flag,

  // ── Local debugging only ──
  SWIGGY_DEBUG_DUMP: optionalString,
});

export type AppEnv = z.infer<typeof envSchema>;

export interface EnvReport {
  ok: boolean;
  /** Required variables that are missing or invalid (names + reason, no values). */
  errors: string[];
  /** Non-fatal problems (unused in prod, insecure settings…). */
  warnings: string[];
  /** Which optional features are configured (booleans only). */
  features: {
    llmProviders: string[];
    orders: boolean;
    database: boolean;
    analytics: boolean;
  };
}

/** Validate `env` (default process.env). Never includes secret values in the report. */
export function checkEnv(env: Record<string, string | undefined> = process.env): EnvReport {
  const errors: string[] = [];
  const warnings: string[] = [];
  // Treat blank strings as unset (Vercel / .env files often carry `KEY=`).
  const cleaned = Object.fromEntries(Object.entries(env).filter(([, v]) => typeof v === "string" && v.trim() !== ""));
  const parsed = envSchema.safeParse(cleaned);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const name = String(issue.path[0] ?? "env");
      errors.push(issue.code === "invalid_type" ? `${name} is required` : `${name} ${issue.message}`);
    }
  }
  const v = (parsed.success ? parsed.data : cleaned) as Partial<AppEnv>;

  const llmProviders = [
    v.ANTHROPIC_API_KEY && "anthropic",
    (v.GROQ_API_KEY || v.GROQ_API_KEY_2) && "groq",
    (v.GEMINI_API_KEY || v.GEMINI_API_KEY_2) && "gemini",
  ].filter(Boolean) as string[];
  if (!llmProviders.length) {
    errors.push("At least one LLM key is required: ANTHROPIC_API_KEY, GROQ_API_KEY(_2) or GEMINI_API_KEY(_2)");
  }

  if (isProd() || onVercel()) {
    if (!v.SESSION_SECRET) errors.push("SESSION_SECRET is required in production (encrypts the session cookie)");
    // oauth.ts falls back to the Vercel production URL; a public deploy should set it explicitly.
    if (!v.APP_BASE_URL) {
      if (process.env.VERCEL_PROJECT_PRODUCTION_URL) warnings.push("APP_BASE_URL is unset — using https://$VERCEL_PROJECT_PRODUCTION_URL for the OAuth redirect");
      else errors.push("APP_BASE_URL is required in production (OAuth redirect = APP_BASE_URL/api/auth/callback)");
    }
    const base = v.APP_BASE_URL ?? "";
    if (base && !base.startsWith("https://")) {
      // Vercel preview / local `next start` on http://localhost is allowed, with a warning.
      if (onVercel() && process.env.VERCEL_ENV === "production") errors.push("APP_BASE_URL must use https:// in production");
      else warnings.push("APP_BASE_URL is not https:// — fine for local `next start`, not for a public deploy");
    }
    if (base.endsWith("/")) warnings.push("APP_BASE_URL should not end with a slash");
    if (v.SWIGGY_DEBUG_DUMP) warnings.push("SWIGGY_DEBUG_DUMP is set but ignored in production (no runtime file writes)");
    if (!v.SWIGGY_OAUTH_CLIENT_ID || v.SWIGGY_OAUTH_CLIENT_ID === "swiggy-mcp") {
      warnings.push("SWIGGY_OAUTH_CLIENT_ID is the localhost client id — production needs the id Swiggy issued for this domain");
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    features: {
      llmProviders,
      orders: v.SWIGGY_ENABLE_ORDERS === "true",
      database: Boolean(v.DATABASE_URL),
      analytics: v.NEXT_PUBLIC_VERCEL_ANALYTICS === "1" || v.NEXT_PUBLIC_VERCEL_ANALYTICS === "true",
    },
  };
}

/** Human-readable multi-line summary for the boot log. */
export function formatEnvReport(report: EnvReport): string {
  const lines: string[] = [];
  if (report.errors.length) {
    lines.push("Missing or invalid environment variables:");
    for (const e of report.errors) lines.push(`  ✗ ${e}`);
    lines.push("See .env.example and docs/DEPLOY.md.");
  }
  for (const w of report.warnings) lines.push(`  ! ${w}`);
  return lines.join("\n");
}
