// GET /api/addresses — the account's saved delivery addresses (every page of
// get_addresses) plus Swiggy's `resolution` (which one to preselect, and
// whether the user must confirm). `?selectedAddressId=` passes the user's
// earlier pick for continuity.

import { isAuthError } from '@/backend/config/env';
import { getAddressBook } from '@/backend/mcp/swiggy-mcp';
import { route, unauthorized } from "@/backend/http/route";
import { AddressesQuery } from "@/backend/http/schemas";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = route({ name: "api/addresses", rateLimit: "read", query: AddressesQuery }, async function GET(request: Request): Promise<Response> {
  const selected = new URL(request.url).searchParams.get("selectedAddressId") || undefined;
  try {
    return Response.json(await getAddressBook(selected));
  } catch (err) {
    if (isAuthError(err)) {
      return unauthorized();
    }
    console.error("[api/addresses] failed:", err);
    return Response.json(
      { addresses: [], resolution: null, error: err instanceof Error ? err.message : "Couldn't load addresses" },
      { status: 502 },
    );
  }
});
