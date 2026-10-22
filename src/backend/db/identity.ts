// The stable Swiggy account id behind an access token. Swiggy's JWT carries
// the customer id in `sub` (9-digit numeric) — `user_id` is preferred when a
// future token includes it. `session_id`/`tid` change per login and are not
// identities. The token is NOT verified here (Swiggy verifies at its edge on
// every MCP call); this only picks which row a request reads/writes, and the
// token came from our own sealed session cookie.

import { decodeJwtPayload } from "@/backend/config/oauth";
import { getActiveSession } from "@/backend/config/session";

export function swiggyUserIdFromToken(accessToken: string | undefined | null): string | null {
  if (!accessToken) return null;
  const claims = decodeJwtPayload(accessToken);
  if (!claims) return null;
  for (const k of ["user_id", "sub"] as const) {
    const v = claims[k];
    if ((typeof v === "string" && v.trim()) || (typeof v === "number" && Number.isFinite(v))) {
      return String(v).trim().slice(0, 128);
    }
  }
  return null;
}

/** The current request's Swiggy account id, or null when logged out. */
export async function currentSwiggyUserId(): Promise<string | null> {
  const session = await getActiveSession().catch(() => null);
  if (!session) return null;
  return session.userId || swiggyUserIdFromToken(session.accessToken);
}
