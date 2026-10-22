// POST /api/auth/logout — revoke the Swiggy session (POST /auth/logout with
// the bearer token) and drop this browser's encrypted session cookie.
// POST only, so a cross-site link/image can't log the user out.

import { revokeSwiggySession } from "@/backend/config/oauth";
import { clearSession, getActiveSession } from "@/backend/config/session";
import { route } from "@/backend/http/route";

export const dynamic = "force-dynamic";

export const POST = route({ name: "api/auth/logout", auth: "none", rateLimit: "auth" }, async function POST(): Promise<Response> {
  const session = await getActiveSession().catch(() => null);
  if (session) await revokeSwiggySession(session.accessToken);
  await clearSession();
  return Response.json({ success: true, message: "Logged out" });
});
