// Shared Payment stage across Swiggy Food, Instamart, Dineout and Scenes:
// get_payment_options → (per-service place-order) → check_payment_status →
// confirm_order. Contract: docs/swiggy-mcp/platform.md §6.
//
// Everything here reflects what Swiggy actually returned: no fallback method
// lists, no invented ids or links, no optimistic confirmations. Errors throw
// (AuthError / SwiggyToolError / transport) so routes can surface them.

import {
  SWIGGY_DINEOUT_MCP_URL,
  SWIGGY_FOOD_MCP_URL,
  SWIGGY_IM_MCP_URL,
  SWIGGY_SCENES_MCP_URL,
} from "@/backend/config/env";
import { bool, callTool, coerceToolPayload, isRecord, num, str } from "@/backend/mcp/client";
import { envelopeMessage } from "@/backend/mcp/payload";
import type {
  PaymentConfirmResult,
  PaymentMethodItem,
  PaymentOptionsPayload,
  PaymentSession,
  PaymentStatusResult,
  Service,
} from "@/shared/types";

export function urlForService(service: Service): string {
  switch (service) {
    case "food":
      return SWIGGY_FOOD_MCP_URL;
    case "dineout":
      return SWIGGY_DINEOUT_MCP_URL;
    case "scenes":
      return SWIGGY_SCENES_MCP_URL;
    case "instamart":
    default:
      return SWIGGY_IM_MCP_URL;
  }
}

const PLACE_ORDER_TOOL: Record<Service, string> = {
  food: "place_food_order",
  instamart: "checkout",
  dineout: "book_table",
  scenes: "place_event_order",
  // Plan never places orders itself — every order runs through its domain's flow.
  plan: "",
};

/** Thrown for calls that are missing the identifiers Swiggy requires. */
export class PaymentArgsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PaymentArgsError";
  }
}

/* --------------------------- get_payment_options --------------------------- */

/** The payment group to send as `paymentMethod` for a returned method. */
function groupOf(m: Record<string, unknown>): string {
  const id = str(m.id);
  const group = str(m.groupName).toUpperCase();
  if (id === "SwiggyPay" || group === "SWIGGYPAY") return "SwiggyPay";
  if (group === "COD" || group === "CASH" || id === "COD" || id === "Cash") return "Cash";
  return "UPI";
}

function toMethod(raw: unknown, surface?: "intent" | "qr"): PaymentMethodItem | null {
  if (!isRecord(raw)) return null;
  const id = str(raw.id);
  if (!id) return null;
  const paymentMethod = groupOf(raw);
  const kind =
    str(raw.kind) ||
    surface ||
    (paymentMethod === "SwiggyPay" ? "wallet" : paymentMethod === "Cash" ? "cod" : "");
  const displayName = str(raw.displayName) || id;
  return {
    id,
    name: displayName,
    displayName,
    paymentMethod,
    groupName: str(raw.groupName) || undefined,
    // A UPI app method's id goes into `intentApp`, byte-for-byte. Scan-QR
    // methods use generateUPIQR instead.
    intentApp: paymentMethod === "UPI" && kind !== "qr" && id !== "PayWithQR" ? id : undefined,
    kind: kind || undefined,
    isQr: kind === "qr" || undefined,
    iconUrl: str(raw.iconUrl) || undefined,
    enabled: raw.enabled !== false,
  };
}

function methods(list: unknown, surface?: "intent" | "qr"): PaymentMethodItem[] {
  return (Array.isArray(list) ? list : [])
    .map((m) => toMethod(m, surface))
    .filter((m): m is PaymentMethodItem => m !== null);
}

function availability(raw: unknown): { available: boolean; id?: string; displayName?: string } | undefined {
  if (!isRecord(raw)) return undefined;
  return {
    available: raw.available === true,
    id: str(raw.id) || undefined,
    displayName: str(raw.displayName) || undefined,
  };
}

/**
 * Live payment methods for the current cart/booking. Food: pass the cart's
 * `addressId`. Scenes: `cartKey` from create_event_cart is required.
 * Offer ONLY what this returns.
 */
export async function getPaymentOptions(
  service: Service,
  context: { addressId?: string; cartKey?: string },
): Promise<PaymentOptionsPayload> {
  const args: Record<string, unknown> = {};
  if (service === "food" && context.addressId) args.addressId = context.addressId;
  if (service === "scenes") {
    if (!context.cartKey) throw new PaymentArgsError("Scenes payment options need the event cartKey.");
    args.cartKey = context.cartKey;
  }

  const data = coerceToolPayload(await callTool(urlForService(service), "get_payment_options", args));
  return mapPaymentOptions(service, data);
}

/** Map a get_payment_options `data` payload (live shape: platforms / cod / swiggyMoney / allMethods). */
export function mapPaymentOptions(service: Service, data: unknown): PaymentOptionsPayload {
  const d = isRecord(data) ? data : {};
  const platforms = isRecord(d.platforms) ? d.platforms : {};
  const mobile = isRecord(platforms.mobile) ? platforms.mobile : undefined;
  const desktop = isRecord(platforms.desktop) ? platforms.desktop : undefined;
  const amount = num(d.paymentAmount, NaN);

  const cod = availability(d.cod);
  const swiggyMoney = availability(d.swiggyMoney);
  // Dineout (paid deals) and Scenes are UPI-only: never surface Cash or
  // Swiggy Money there, whatever the payload carries.
  const upiOnly = service === "dineout" || service === "scenes";
  const keep = (list: PaymentMethodItem[]) => (upiOnly ? list.filter((m) => m.paymentMethod === "UPI") : list);

  return {
    allMethods: keep(methods(d.allMethods)),
    platforms:
      mobile || desktop
        ? {
            ...(mobile ? { mobile: { groupName: str(mobile.groupName) || undefined, methods: methods(mobile.methods, "intent") } } : {}),
            ...(desktop ? { desktop: { groupName: str(desktop.groupName) || undefined, methods: methods(desktop.methods, "qr") } } : {}),
          }
        : undefined,
    cod: upiOnly ? undefined : cod,
    // Swiggy Money is a retail (Food / Instamart) method only.
    swiggyMoney: service === "food" || service === "instamart" ? swiggyMoney : undefined,
    paymentAmount: Number.isFinite(amount) ? amount : null,
    addressId: str(d.addressId) || undefined,
    placeOrderToolName: str(d.placeOrderToolName) || PLACE_ORDER_TOOL[service],
    agenticPaymentEligible: typeof d.agenticPaymentEligible === "boolean" ? d.agenticPaymentEligible : undefined,
  };
}

/* ------------------------ place-order → PaymentSession ---------------------- */

/**
 * Build a PaymentSession from a real place-order `data` payload. Returns null
 * unless it is a genuine UPI PENDING_PAYMENT response carrying a paasId and an
 * orderId (Cash / SwiggyPay orders are already final and need no session).
 * Per-service place-order code should hand the result to the payment modal.
 */
export function paymentSessionFromPlaceOrder(
  service: Service,
  data: unknown,
  extras: { amount?: number; title?: string; cartKey?: string } = {},
): PaymentSession | null {
  const d = isRecord(data) ? data : {};
  const status = str(d.status).toUpperCase();
  const normalized = str(d.normalizedStatus).toLowerCase();
  const orderId = str(d.orderId) || (typeof d.orderId === "number" ? String(d.orderId) : "");
  const paasId = str(d.paasId) || (typeof d.paasId === "number" ? String(d.paasId) : "");
  if (!orderId || !paasId) return null;
  if (status !== "PENDING_PAYMENT" && normalized !== "pending") return null;

  const lat = num(d.lat ?? d.latitude, NaN);
  const lng = num(d.lng ?? d.longitude, NaN);
  const interval = num(d.pollingIntervalInMs, NaN);
  const maxPoll = num(d.maxTimeToPollForInMs, NaN);
  const total = num(d.totalAmount ?? d.cartTotal ?? d.amount, NaN);

  return {
    orderId,
    paasId,
    transactionId: str(d.transactionId) || undefined,
    bridgeUrl: str(d.bridgeUrl) || undefined,
    upiIntentUrl: str(d.upiIntentUrl) || undefined,
    isQrFlow: bool(d.isQrFlow, false),
    echo: {
      addressId: str(d.addressId) || undefined,
      cartId: str(d.cartId) || undefined,
      lat: Number.isFinite(lat) ? lat : undefined,
      lng: Number.isFinite(lng) ? lng : undefined,
      cartKey: extras.cartKey || str(d.cartKey) || undefined,
    },
    paymentMethod: "UPI",
    status: "pending",
    // Swiggy's hints; the defaults only apply if a field is missing, and the
    // modal never polls faster than one in-flight long-poll at a time anyway.
    pollingIntervalInMs: Number.isFinite(interval) && interval > 0 ? interval : 3000,
    maxTimeToPollForInMs: Number.isFinite(maxPoll) && maxPoll > 0 ? maxPoll : 5 * 60_000,
    confirmed: false,
    amount: Number.isFinite(total) && total > 0 ? total : (extras.amount ?? 0),
    service,
    title: extras.title,
  };
}

/* --------------------------- check_payment_status --------------------------- */

export interface PaymentRefs {
  orderId: string;
  paasId?: string;
  transactionId?: string;
  addressId?: string;
  cartId?: string;
  lat?: number;
  lng?: number;
}

const SUCCESS = new Set(["success", "paid"]);
const FAILURE = new Set(["failed", "failure", "cancelled", "canceled", "cart_changed", "refund-initiated", "refund_initiated"]);

/**
 * One check_payment_status iteration (a ~19 s server long-poll). Food also
 * echoes addressId / cartId / lat / lng so Swiggy can auto-confirm.
 */
export async function checkPaymentStatus(service: Service, refs: PaymentRefs): Promise<PaymentStatusResult> {
  if (!refs.paasId) throw new PaymentArgsError("paasId from the place-order response is required.");
  const args: Record<string, unknown> = { paasId: refs.paasId, orderId: refs.orderId };
  if (service === "food") {
    if (refs.addressId) args.addressId = refs.addressId;
    if (refs.cartId) args.cartId = refs.cartId;
    if (refs.lat != null) args.lat = refs.lat;
    if (refs.lng != null) args.lng = refs.lng;
  }

  const raw = await callTool(urlForService(service), "check_payment_status", args);
  const data = coerceToolPayload(raw);
  const d = isRecord(data) ? data : {};
  const status = (str(d.status) || "pending").toLowerCase();
  const isTerminalSuccess = bool(d.isTerminalSuccess, SUCCESS.has(status));
  const isTerminalFailure = bool(d.isTerminalFailure, FAILURE.has(status));
  return {
    status,
    terminal: bool(d.terminal, isTerminalSuccess || isTerminalFailure),
    isTerminalSuccess,
    isTerminalFailure,
    confirmed: d.confirmed === true,
    orderStatus: str(d.orderStatus) || undefined,
    message: envelopeMessage(raw) || str(d.message) || undefined,
  };
}

/* ------------------------------- confirm_order ------------------------------ */

/**
 * Finalize a UPI order: after a terminal success that was not auto-confirmed,
 * or once at the polling cap. Food: orderId + addressId + lat + lng (+ cartId),
 * no paasId. Instamart / Dineout / Scenes: orderId + paasId (+ transactionId).
 * Idempotent for the same identifiers.
 */
export async function confirmOrder(service: Service, refs: PaymentRefs): Promise<PaymentConfirmResult> {
  const args: Record<string, unknown> = { orderId: refs.orderId };
  if (service === "food") {
    if (!refs.addressId || refs.lat == null || refs.lng == null) {
      throw new PaymentArgsError("Food confirm_order needs addressId, lat and lng from place_food_order.");
    }
    args.addressId = refs.addressId;
    args.lat = refs.lat;
    args.lng = refs.lng;
    if (refs.cartId) args.cartId = refs.cartId;
  } else {
    if (!refs.paasId) throw new PaymentArgsError("confirm_order needs the paasId from the place-order response.");
    args.paasId = refs.paasId;
    if (refs.transactionId) args.transactionId = refs.transactionId;
  }

  // Idempotent per the docs, so one transient retry is safe.
  const raw = await callTool(urlForService(service), "confirm_order", args, { maxRetries: 1 });
  const data = coerceToolPayload(raw);
  const d = isRecord(data) ? data : {};
  return {
    result: (str(d.result) || "pending").toLowerCase(),
    orderId: str(d.orderId) || refs.orderId,
    orderStatus: str(d.orderStatus) || undefined,
    message: envelopeMessage(raw) || str(d.message) || undefined,
  };
}

/* ------------------------------ route helpers ------------------------------ */

/** Map a payment-stage failure to an HTTP status + user-facing message. */
export function paymentErrorResponse(err: unknown, fallback: string): Response {
  const e = err instanceof Error ? err : new Error(String(err));
  if (e.name === "AuthError") {
    return Response.json({ ok: false, needsLogin: true, message: e.message }, { status: 401 });
  }
  if (e instanceof PaymentArgsError) {
    return Response.json({ ok: false, message: e.message }, { status: 400 });
  }
  if (e.name === "SwiggyToolError") {
    // Swiggy's own message (out of stock, payment failed, …) — show it as-is.
    const reportId = (e as { reportId?: unknown }).reportId;
    return Response.json(
      { ok: false, message: e.message, ...(typeof reportId === "string" ? { reportId } : {}) },
      { status: 422 },
    );
  }
  console.error(`[payments] ${fallback}:`, e.message);
  return Response.json({ ok: false, message: `${fallback}. Please try again.` }, { status: 502 });
}

export const PAYMENT_SERVICES: readonly Service[] = ["food", "instamart", "dineout", "scenes"];

export function parseService(value: unknown): Service | null {
  return typeof value === "string" && (PAYMENT_SERVICES as readonly string[]).includes(value) ? (value as Service) : null;
}
