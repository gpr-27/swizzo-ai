// /api/cart — the Instamart cart. Swiggy's server-side cart (keyed to the
// user's session) is the source of truth: every response is built from the
// get_cart / update_cart reply, never from a local copy. The agent is
// read-only, so all cart mutations happen here.
//
// Instamart carts bind to ONE delivery address: before writing for a
// different address we clear_cart first (docs: "Address switch").

import { isAuthError } from '@/backend/config/env';
import {
  cartToState,
  clearCart,
  getCart,
  sameAddressId,
  updateCart,
  type InstamartCartView,
} from '@/backend/mcp/swiggy-mcp';
import { emptyCart } from '@/shared/types';
import type { CartLine, CartRequest, CartState } from '@/shared/types';
import { route, unauthorized } from "@/backend/http/route";
import { AddressOnlyQuery, CartBody } from "@/backend/http/schemas";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type LineMeta = Omit<CartLine, "quantity">;

function errorMessage(err: unknown): string {
  return err instanceof Error && err.message ? err.message : "Couldn't update your Instamart cart.";
}

/** Desired item set (spinId → {meta, quantity}) after applying `body` to `current`. */
function desiredItems(body: CartRequest, current: CartLine[]): Map<string, { line: LineMeta; quantity: number }> {
  const out = new Map<string, { line: LineMeta; quantity: number }>();
  for (const { quantity, ...line } of current) out.set(line.spinId, { line, quantity });
  const spinId = body.spinId;
  switch (body.action) {
    case "add": {
      if (body.line?.spinId) {
        const q = typeof body.quantity === "number" && body.quantity > 0 ? body.quantity : 1;
        const existing = out.get(body.line.spinId);
        out.set(body.line.spinId, { line: body.line, quantity: (existing?.quantity ?? 0) + q });
      }
      break;
    }
    case "increment": {
      const e = spinId ? out.get(spinId) : undefined;
      if (e) e.quantity += 1;
      break;
    }
    case "decrement": {
      const e = spinId ? out.get(spinId) : undefined;
      if (e) {
        e.quantity -= 1;
        if (e.quantity <= 0) out.delete(spinId!);
      }
      break;
    }
    case "remove":
      if (spinId) out.delete(spinId);
      break;
    case "clear":
      out.clear();
      break;
    case "set": {
      out.clear();
      for (const it of Array.isArray(body.items) ? body.items : []) {
        const q = typeof it?.quantity === "number" ? Math.floor(it.quantity) : 0;
        if (it?.line?.spinId && q > 0) out.set(it.line.spinId, { line: it.line, quantity: q });
      }
      break;
    }
  }
  // Respect Swiggy's per-item caps up front (update_cart would cap anyway).
  for (const e of out.values()) {
    if (e.line.maxQuantity && e.quantity > e.line.maxQuantity) e.quantity = e.line.maxQuantity;
  }
  return out;
}

export const GET = route({ name: "api/cart", rateLimit: "read", query: AddressOnlyQuery }, async function GET(request: Request): Promise<Response> {
  const addressId = new URL(request.url).searchParams.get("addressId") ?? "";
  try {
    const view = await getCart();
    return Response.json(cartToState(view, addressId));
  } catch (err) {
    if (isAuthError(err)) return unauthorized();
    console.error("[api/cart] get_cart failed:", err);
    return Response.json({ ...emptyCart(addressId), warnings: [errorMessage(err)] }, { status: 502 });
  }
});

export const POST = route({ name: "api/cart", rateLimit: "mutate", body: CartBody }, async function POST(request: Request): Promise<Response> {
  let body: CartRequest;
  try {
    body = (await request.json()) as CartRequest;
  } catch {
    return Response.json(emptyCart(""), { status: 400 });
  }
  const addressId = typeof body.addressId === "string" ? body.addressId : "";
  if (!addressId) {
    return Response.json({ ...emptyCart(""), warnings: ["Pick a delivery address first."] }, { status: 400 });
  }

  // Read before mutating (multi-turn cart state): the user may have edited the
  // cart in the Swiggy app, and we need to know which address it's bound to.
  let current: InstamartCartView;
  try {
    current = await getCart();
  } catch (err) {
    if (isAuthError(err)) return unauthorized();
    console.error("[api/cart] get_cart before update failed:", err);
    return Response.json({ ...emptyCart(addressId), warnings: [errorMessage(err)] }, { status: 502 });
  }

  // `set` sends the full desired set; incremental actions apply to the server cart.
  const desired = desiredItems(body, body.action === "set" ? [] : current.items);
  const meta = new Map<string, LineMeta>([...desired].map(([k, v]) => [k, v.line]));
  const notes: string[] = [];

  try {
    const switching = !!current.boundAddressId && !sameAddressId(current.boundAddressId, addressId) && !current.absent;
    if (desired.size === 0) {
      if (!current.absent) await clearCart();
      return Response.json(emptyCart(addressId));
    }
    if (switching) {
      // Avoid cross-address SKU mismatches: clear, then rebuild for the new address.
      await clearCart();
      notes.push("Moved your cart to the new delivery address — availability was re-checked.");
    }
    const view = await updateCart(
      addressId,
      [...desired.values()].map(({ line, quantity }) => ({
        spinId: line.spinId,
        skuId: line.skuId,
        quantity,
      })),
    );
    return Response.json(cartToState(view, addressId, meta, notes));
  } catch (err) {
    if (isAuthError(err)) return unauthorized();
    console.error("[api/cart] update failed:", err);
    // Show what Swiggy actually holds now, plus Swiggy's error message.
    const after = await getCart().catch(() => current);
    const state: CartState = cartToState(after, addressId, meta, [errorMessage(err)]);
    return Response.json(state, { status: 422 });
  }
});
