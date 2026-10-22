// GET /api/auth/status — is this browser connected to Swiggy?
// Reads the encrypted session cookie (refreshing it when ≤ 60 s remain) and,
// at most every few minutes per session, verifies it live with get_addresses.
// Non-auth failures (429/5xx) report `degraded`, never a false "logged out".

import { createHash } from "node:crypto";

import { isAuthError } from "@/backend/config/env";
import { clearSession, getActiveSession } from "@/backend/config/session";
import { getAddresses } from "@/backend/mcp/swiggy-mcp";
import { route } from "@/backend/http/route";

export const dynamic = "force-dynamic";

const PROFILE_TTL_MS = 5 * 60_000;

interface Profile {
  name: string;
  addressCount: number;
  until: number;
}

const g = globalThis as unknown as { __swiggyProfiles?: Map<string, Profile> };
const profiles = (g.__swiggyProfiles ??= new Map<string, Profile>());

export const GET = route({ name: "api/auth/status", auth: "none", rateLimit: "read" }, async function GET(): Promise<Response> {
  const session = await getActiveSession().catch(() => null);
  if (!session) {
    return Response.json({ authenticated: false });
  }

  const user = {
    userId: session.userId ?? null,
    expiresAt: session.expiresAt,
  };
  const key = createHash("sha256").update(session.accessToken).digest("hex").slice(0, 24);
  const now = Date.now();
  for (const [k, p] of profiles) if (p.until < now) profiles.delete(k);

  const cached = profiles.get(key);
  if (cached) {
    return Response.json({
      authenticated: true,
      user: { ...user, name: cached.name, addressCount: cached.addressCount },
    });
  }

  try {
    const addresses = await getAddresses();
    let name = "Swiggy User";
    const firstLine = addresses[0]?.addressLine || "";
    if (firstLine.includes(":")) name = firstLine.split(":")[0].trim() || name;
    profiles.set(key, { name, addressCount: addresses.length, until: now + PROFILE_TTL_MS });
    return Response.json({
      authenticated: true,
      user: { ...user, name, addressCount: addresses.length },
    });
  } catch (err) {
    if (isAuthError(err)) {
      await clearSession();
      return Response.json({ authenticated: false, reason: "expired" });
    }
    console.warn("[api/auth/status] live check failed:", err instanceof Error ? err.message : err);
    return Response.json({ authenticated: true, degraded: true, user });
  }
});
