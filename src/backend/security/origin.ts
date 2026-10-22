// Same-origin enforcement for state-changing requests (CSRF defence in depth on
// top of the SameSite=Lax session cookie). A browser always sends `Origin` on
// POST/PUT/PATCH/DELETE fetches and `Sec-Fetch-Site` on every request, and a
// page on another site can forge neither.
//
// Allowed origins: APP_BASE_URL, this deployment's own Vercel URLs
// (VERCEL_URL / VERCEL_BRANCH_URL / VERCEL_PROJECT_PRODUCTION_URL), the
// request's own Host (covers previews, tunnels and localhost), and any extra
// comma-separated ALLOWED_ORIGINS.

import { oauthConfig } from "@/backend/config/oauth";

export type OriginVerdict = { ok: true } | { ok: false; reason: string };

function originOf(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const withScheme = /^https?:\/\//i.test(url) ? url : `https://${url}`;
    return new URL(withScheme).origin.toLowerCase();
  } catch {
    return null;
  }
}

/** Every origin this deployment answers on (from env only). */
export function allowedOrigins(): Set<string> {
  const out = new Set<string>();
  const add = (u: string | undefined) => {
    const o = originOf(u?.trim());
    if (o) out.add(o);
  };
  add(oauthConfig().appBaseUrl);
  add(process.env.VERCEL_URL);
  add(process.env.VERCEL_BRANCH_URL);
  add(process.env.VERCEL_PROJECT_PRODUCTION_URL);
  for (const extra of (process.env.ALLOWED_ORIGINS ?? "").split(",")) add(extra);
  return out;
}

/** The origin the request was addressed to (Host / X-Forwarded-Host + proto). */
export function requestOrigin(request: Request): string | null {
  const h = request.headers;
  const host = (h.get("x-forwarded-host") || h.get("host") || "").split(",")[0].trim();
  if (!host) return null;
  const proto =
    (h.get("x-forwarded-proto") || "").split(",")[0].trim() ||
    (() => {
      try {
        return new URL(request.url).protocol.replace(":", "");
      } catch {
        return "https";
      }
    })();
  return originOf(`${proto}://${host}`);
}

/**
 * Verdict for a state-changing request. Rejects cross-site / same-site
 * Sec-Fetch-Site, a foreign or `null` Origin, and requests that carry
 * neither header (not a browser fetch from our page).
 */
export function checkSameOrigin(request: Request): OriginVerdict {
  const site = request.headers.get("sec-fetch-site")?.toLowerCase();
  if (site && site !== "same-origin" && site !== "none") {
    return { ok: false, reason: `sec-fetch-site=${site}` };
  }
  const origin = request.headers.get("origin");
  if (origin) {
    const o = originOf(origin);
    if (!o) return { ok: false, reason: "origin=null" };
    if (allowedOrigins().has(o) || o === requestOrigin(request)) return { ok: true };
    return { ok: false, reason: "origin mismatch" };
  }
  // No Origin: only acceptable when the browser vouched for same-origin.
  if (site === "same-origin") return { ok: true };
  return { ok: false, reason: "missing origin" };
}

/** For GETs with session data: refuse obvious cross-site subresource / fetch reads. */
export function isCrossSiteRead(request: Request): boolean {
  const site = request.headers.get("sec-fetch-site")?.toLowerCase();
  return site === "cross-site";
}
