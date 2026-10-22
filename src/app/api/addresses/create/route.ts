// POST & DELETE /api/addresses/create — manage delivery addresses via the
// Swiggy create_address / delete_address tools (shared Food & Instamart).
// create_address takes the parsed components (addressLine, addressLine2,
// city, postalCode), an upper-case addressCategory and the account holder's
// name + phone — see docs/swiggy-mcp/instamart.md §1.

import { isAuthError } from "@/backend/config/env";
import {
  createAddress,
  deleteAddress,
  getAddresses,
  type AddressCategory,
} from "@/backend/mcp/swiggy-mcp";
import type { Address } from "@/shared/types";
import { route, unauthorized } from "@/backend/http/route";
import { AddressCreateBody, AddressDeleteQuery } from "@/backend/http/schemas";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CATEGORIES: AddressCategory[] = ["HOME", "WORK", "OFFICE", "FRIENDS_AND_FAMILY", "OTHER"];

function s(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}
function n(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

export const POST = route({ name: "api/addresses/create", rateLimit: "mutate", body: AddressCreateBody }, async function POST(request: Request): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return Response.json({ ok: false, message: "Invalid request." }, { status: 400 });
  }

  const category = s(body.addressCategory).toUpperCase() as AddressCategory;
  const input = {
    fullAddress: s(body.fullAddress),
    addressLine: s(body.addressLine),
    addressLine2: s(body.addressLine2),
    locality: s(body.locality) || undefined,
    city: s(body.city),
    postalCode: s(body.postalCode),
    addressCategory: category,
    addressTag: s(body.addressTag) || undefined,
    userName: s(body.userName),
    userPhone: s(body.userPhone),
    receiverName: s(body.receiverName) || undefined,
    receiverPhone: s(body.receiverPhone) || undefined,
    latitude: n(body.latitude),
    longitude: n(body.longitude),
  };

  const missing = (
    ["fullAddress", "addressLine", "city", "postalCode", "userName", "userPhone"] as const
  ).filter((k) => !input[k]);
  if (missing.length) {
    return Response.json({ ok: false, message: `Missing: ${missing.join(", ")}.` }, { status: 400 });
  }
  if (!CATEGORIES.includes(category)) {
    return Response.json({ ok: false, message: "Pick an address type." }, { status: 400 });
  }
  if (!/^\d{6}$/.test(input.postalCode)) {
    return Response.json({ ok: false, message: "Enter a valid 6-digit PIN code." }, { status: 400 });
  }

  try {
    const addressId = await createAddress(input);
    // Re-read so the UI gets Swiggy's own formatting for the new address.
    const saved = await getAddresses().catch(() => [] as Address[]);
    const address: Address = saved.find((a) => a.id === addressId) ?? {
      id: addressId,
      addressLine: input.fullAddress,
      addressTag: input.addressTag ?? "",
      addressCategory: category,
    };
    return Response.json({ ok: true, address, message: "Address saved to your Swiggy account." });
  } catch (err) {
    if (isAuthError(err)) return unauthorized();
    console.error("[api/addresses/create] error:", err);
    return Response.json(
      { ok: false, message: err instanceof Error ? err.message : "Failed to create address" },
      { status: 422 },
    );
  }
});

export const DELETE = route({ name: "api/addresses/delete", rateLimit: "mutate", query: AddressDeleteQuery }, async function DELETE(request: Request): Promise<Response> {
  const addressId = new URL(request.url).searchParams.get("addressId");
  if (!addressId) {
    return Response.json({ ok: false, message: "addressId is required." }, { status: 400 });
  }
  try {
    const result = await deleteAddress(addressId);
    return Response.json({ ok: true, result, message: result.statusMessage || "Address deleted." });
  } catch (err) {
    if (isAuthError(err)) return unauthorized();
    console.error("[api/addresses/delete] error:", err);
    return Response.json(
      { ok: false, message: err instanceof Error ? err.message : "Failed to delete address" },
      { status: 422 },
    );
  }
});
