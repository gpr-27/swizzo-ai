// POST /api/checkout — place a REAL Instamart order with the `checkout` tool.
//
// Safety (docs/swiggy-mcp/instamart.md §4):
//   - server gate: SWIGGY_ENABLE_ORDERS="true", otherwise nothing is placed;
//   - the UI shows items + total + address + payment method and gets an
//     explicit yes before calling this route;
//   - we re-read get_cart first (address binding, unserviceable items, empty);
//   - checkout is NON-idempotent: never blind-retried. On an ambiguous
//     failure we wait, read get_orders, and only report success if a new
//     order really exists.
// Response: { placed, gated, ok, message, orderId?, orders?, paymentSession? }.
// A UPI order comes back PENDING_PAYMENT with a real PaymentSession (paasId,
// bridgeUrl, polling hints) for the payment modal to drive.

import { isAuthError } from '@/backend/config/env';
import { checkout, getCart, getOrders, sameAddressId, type CheckoutArgs } from '@/backend/mcp/swiggy-mcp';
import type { PaymentSession } from '@/shared/types';
import { route, unauthorized } from "@/backend/http/route";
import { CheckoutBody } from "@/backend/http/schemas";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface CheckoutBody {
  addressId?: string;
  paymentMethod?: string; // group: "UPI" | "Cash" | "COD" | "SwiggyPay"
  intentApp?: string; // the selected UPI app id from get_payment_options
  generateUPIQR?: boolean; // scan-QR (desktop) choice
  confirmDuplicate?: boolean; // only after a duplicate rejection the user accepted
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function str(v: unknown): string {
  if (typeof v === "string") return v;
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return "";
}
function num(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number(v.replace(/[^0-9.]/g, ""));
    if (v.trim() && Number.isFinite(n)) return n;
  }
  return undefined;
}

function normalizeMethod(m?: string): CheckoutArgs["paymentMethod"] | undefined {
  if (!m) return undefined;
  if (/^upi$/i.test(m)) return "UPI";
  if (/^(cash|cod)$/i.test(m)) return "Cash";
  if (/^swiggy ?pay$/i.test(m)) return "SwiggyPay";
  return undefined;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const POST = route({ name: "api/checkout", rateLimit: "order", body: CheckoutBody, idempotent: "instamart:checkout" }, async function POST(request: Request): Promise<Response> {
  let body: CheckoutBody = {};
  try {
    body = (await request.json()) as CheckoutBody;
  } catch {
    // empty body → fails the addressId check below
  }

  if (process.env.SWIGGY_ENABLE_ORDERS !== "true") {
    return Response.json({
      placed: false,
      gated: true,
      ok: false,
      message: "Ordering is disabled on this server",
    });
  }

  const addressId = typeof body.addressId === "string" ? body.addressId : "";
  if (!addressId) {
    return Response.json({ placed: false, gated: false, ok: false, message: "Pick a delivery address first." }, { status: 400 });
  }
  const paymentMethod = normalizeMethod(body.paymentMethod);
  if (body.paymentMethod && !paymentMethod) {
    return Response.json({ placed: false, gated: false, ok: false, message: "Unsupported payment method." }, { status: 400 });
  }

  // Re-read the authoritative cart right before placing.
  let cartTotal: number | undefined;
  try {
    const cart = await getCart();
    if (cart.absent) {
      return Response.json({ placed: false, gated: false, ok: false, message: "Your Instamart cart is empty." }, { status: 409 });
    }
    if (cart.boundAddressId && !sameAddressId(cart.boundAddressId, addressId)) {
      return Response.json(
        { placed: false, gated: false, ok: false, message: "Your cart is set up for a different delivery address. Re-open the cart to move it to this address." },
        { status: 409 },
      );
    }
    if (cart.unserviceable.length) {
      return Response.json(
        { placed: false, gated: false, ok: false, message: `Some items can't be delivered here: ${cart.unserviceable.map((u) => u.name).join(", ")}. Remove them to continue.` },
        { status: 409 },
      );
    }
    cartTotal = cart.payableTotal ?? undefined;
  } catch (err) {
    if (isAuthError(err)) return unauthorized();
    const message = err instanceof Error ? err.message : "Couldn't read your cart.";
    return Response.json({ placed: false, gated: false, ok: false, message }, { status: 502 });
  }

  const startedAt = Date.now();
  let result: Awaited<ReturnType<typeof checkout>>;
  try {
    result = await checkout({
      addressId,
      paymentMethod,
      intentApp: body.intentApp,
      generateUPIQR: body.generateUPIQR,
      confirmDuplicate: body.confirmDuplicate === true,
    });
  } catch (err) {
    if (isAuthError(err)) return unauthorized();
    const message = err instanceof Error ? err.message : "Checkout failed.";
    // A Swiggy domain failure (success:false) is definitive: nothing was placed.
    if (err instanceof Error && err.name === "SwiggyToolError") {
      return Response.json(
        { placed: false, gated: false, ok: false, message, duplicate: /duplicate/i.test(message) },
        { status: 422 },
      );
    }
    // Ambiguous (network / 5xx / timeout): the order may have gone through.
    console.error("[api/checkout] ambiguous checkout failure:", err);
    await sleep(3000);
    try {
      const recent = await getOrders({ count: 5, activeOnly: true });
      const fresh = recent.find((o) => {
        const t = Date.parse(str(o.createdAt));
        return Number.isFinite(t) && t >= startedAt - 60_000;
      });
      if (fresh) {
        return Response.json({
          placed: true,
          gated: false,
          ok: true,
          recovered: true,
          orderId: str(fresh.orderId),
          message: "Your Instamart order went through — the confirmation just took a while.",
        });
      }
      return Response.json(
        { placed: false, gated: false, ok: false, message: "Checkout didn't complete and no new order was found. You can try again." },
        { status: 502 },
      );
    } catch {
      return Response.json(
        { placed: false, gated: false, ok: false, unknown: true, message: "We couldn't confirm whether your order was placed. Check your recent orders in the Swiggy app before trying again." },
        { status: 502 },
      );
    }
  }

  const data = result.data;
  const message = result.message;

  // Multi-store cart → one order per store, possibly partial success.
  if (Array.isArray(data.orders)) {
    const orders = data.orders.filter(isRecord).map((o) => ({
      orderId: str(o.orderId) || undefined,
      status: str(o.status) || undefined,
      error: str(o.error) || undefined,
    }));
    const successCount = num(data.successCount) ?? orders.filter((o) => o.orderId && !o.error).length;
    return Response.json({
      placed: successCount > 0,
      gated: false,
      ok: successCount > 0,
      orders,
      allSucceeded: data.allSucceeded === true,
      message:
        message ||
        (data.allSucceeded === true
          ? `Instamart order placed successfully (${orders.length} stores).`
          : `${successCount} of ${orders.length} store orders were placed.`),
    });
  }

  const orderId = str(data.orderId);
  if (!orderId) {
    return Response.json(
      { placed: false, gated: false, ok: false, unknown: true, message: "Swiggy didn't return an order id. Check your recent orders in the Swiggy app before trying again." },
      { status: 502 },
    );
  }

  // UPI → PENDING_PAYMENT: hand the real payment fields to the payment modal.
  if (str(data.status) === "PENDING_PAYMENT" || str(data.paasId)) {
    const paasId = str(data.paasId);
    const pollingIntervalInMs = num(data.pollingIntervalInMs);
    const maxTimeToPollForInMs = num(data.maxTimeToPollForInMs);
    const bridgeUrl = str(data.bridgeUrl);
    if (!paasId || !pollingIntervalInMs || !maxTimeToPollForInMs) {
      return Response.json(
        { placed: false, gated: false, ok: false, unknown: true, orderId, message: "Swiggy started the order but didn't return payment details. Check the order in the Swiggy app." },
        { status: 502 },
      );
    }
    const upiIntentUrl = str(data.upiIntentUrl);
    const transactionId = str(data.transactionId);
    const paymentSession: PaymentSession = {
      orderId,
      paasId,
      ...(transactionId ? { transactionId } : {}),
      ...(bridgeUrl ? { bridgeUrl } : {}),
      ...(upiIntentUrl ? { upiIntentUrl } : {}),
      isQrFlow: data.isQrFlow === true,
      echo: { addressId: str(data.addressId) || addressId },
      paymentMethod: "UPI",
      status: "pending",
      pollingIntervalInMs,
      maxTimeToPollForInMs,
      confirmed: false,
      amount: num(data.cartTotal) ?? cartTotal ?? 0,
      service: "instamart",
      title: "Instamart order",
    };
    return Response.json({
      placed: false,
      gated: false,
      ok: true,
      pendingPayment: true,
      orderId,
      paymentSession,
      message: message || "Complete your UPI payment to place the Instamart order.",
    });
  }

  // Cash / COD / SwiggyPay: placed in one step — show Swiggy's message as-is.
  return Response.json({
    placed: true,
    gated: false,
    ok: true,
    orderId,
    status: str(data.status) || undefined,
    paymentMethod: str(data.paymentMethod) || paymentMethod,
    deliveryAddress: str(data.deliveryAddress) || undefined,
    message: message || "Instamart order placed successfully",
  });
});
