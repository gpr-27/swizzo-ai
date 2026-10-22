// GET /api/search — deterministic product search used by the "Load more" button
// on a product grid and the ingredient fan-out. Returns
// { products, similarProducts, nextOffset } or { error } with Swiggy's message.

import { isAuthError } from '@/backend/config/env';
import { searchProducts } from '@/backend/mcp/swiggy-mcp';
import { route, unauthorized } from "@/backend/http/route";
import { SearchQuery } from "@/backend/http/schemas";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = route({ name: "api/search", rateLimit: "read", query: SearchQuery }, async function GET(request: Request): Promise<Response> {
  const params = new URL(request.url).searchParams;
  const addressId = params.get("addressId") ?? "";
  const query = (params.get("query") ?? "").trim();
  // search_products takes a numeric offset; nextOffset arrives as a string.
  const rawOffset = Number(params.get("offset"));
  const offset = Number.isFinite(rawOffset) && rawOffset > 0 ? rawOffset : 0;

  if (!addressId || !query) {
    return Response.json({ products: [], similarProducts: [], nextOffset: null }, { status: 400 });
  }

  try {
    return Response.json(await searchProducts(addressId, query, offset));
  } catch (err) {
    if (isAuthError(err)) return unauthorized();
    console.error("[api/search] failed:", err);
    return Response.json(
      {
        products: [],
        similarProducts: [],
        nextOffset: null,
        error: err instanceof Error ? err.message : "Search failed",
      },
      { status: 502 },
    );
  }
});
