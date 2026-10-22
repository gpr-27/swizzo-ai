// POST /api/instamart/basket — build the one-card AI basket (READ-ONLY).
// Body: { addressId, fromUsuals?, items?: [{ query, quantity?, size? }],
// budget?, title?, allowSponsored?, vegOnly? }. Searches Swiggy in parallel
// (or reads your_go_to_items), picks the best real pack per item and returns
// { basket, note? }. Never touches the cart — the user approves on the card.

import { isAuthError } from "@/backend/config/env";
import { instamartNote } from "@/backend/agent/instamart-ai";
import { buildBasket, type BuildBasketArgs } from "@/backend/mcp/instamart-basket";
import { route, unauthorized } from "@/backend/http/route";
import { InstamartBasketBody } from "@/backend/http/schemas";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export const POST = route({ name: "api/instamart/basket", rateLimit: "ai", body: InstamartBasketBody }, async function POST(request: Request): Promise<Response> {
  let body: Partial<BuildBasketArgs> & { addressId?: string };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Bad request" }, { status: 400 });
  }
  const addressId = typeof body.addressId === "string" ? body.addressId : "";
  if (!addressId) return Response.json({ error: "Pick a delivery address first." }, { status: 400 });
  const items = Array.isArray(body.items) ? body.items : [];
  if (!body.fromUsuals && !items.length) return Response.json({ error: "Nothing to build" }, { status: 400 });

  try {
    const basket = await buildBasket(addressId, {
      fromUsuals: body.fromUsuals === true,
      items,
      ...(typeof body.budget === "number" && body.budget > 0 ? { budget: body.budget } : {}),
      ...(typeof body.title === "string" ? { title: body.title.slice(0, 80) } : {}),
      allowSponsored: body.allowSponsored === true,
      vegOnly: body.vegOnly === true,
    });
    // One AI line over the real basket facts (refill path; chat writes its own).
    const facts = [
      `${basket.lines.length} items, item total ₹${basket.itemTotal}${basket.mrpTotal > basket.itemTotal ? `, saving ₹${basket.mrpTotal - basket.itemTotal} vs MRP` : ""}`,
      basket.budget ? `budget ₹${basket.budget}` : "",
      ...basket.lines.slice(0, 8).map((l) => `${l.line.name} ${l.line.quantityDescription} ×${l.quantity}${l.kind === "substitute" ? ` (substitute: ${l.note})` : ""}${l.sponsored ? " (sponsored)" : ""}${l.lastOrdered ? ` (${l.lastOrdered})` : ""}`),
      ...(basket.missing ?? []).map((m) => `missing ${m.need}: ${m.why}`),
    ].filter(Boolean);
    const note = basket.lines.length ? await instamartNote("basket", facts, request.signal) : null;
    if (note) basket.note = note.text;
    return Response.json({ basket, ...(note ? { model: note.model } : {}) });
  } catch (err) {
    if (isAuthError(err)) return unauthorized();
    console.error("[api/instamart/basket] failed:", err);
    return Response.json({ error: err instanceof Error ? err.message : "Couldn't build the basket" }, { status: 502 });
  }
});
