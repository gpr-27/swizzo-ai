// Cart review + checkout readiness for the Instamart tray, computed ONLY from
// what Swiggy returned (get_cart / update_cart via CartState, and
// get_payment_options). The insights render immediately; their `facts` also
// feed one short AI note (/api/instamart/note). Pure — asserted in
// scripts/verify-food-instamart.ts.

import type { CartLine, CartState, PaymentOptionsPayload } from "./types";

export const IM_MIN_ORDER = 99;

export interface CartInsight {
  tone: "block" | "warn" | "good" | "info";
  text: string;
}

export interface CartChip {
  id: string;
  label: string;
  kind: "ask" | "trim" | "swap" | "remove";
  /** ask: the chat turn to send (hidden instruction) */
  text?: string;
  /** swap / remove: the cart line it acts on */
  spinId?: string;
}

export interface CartReview {
  key: string; // changes whenever the reviewed facts change
  headline: string; // deterministic one-liner (the AI note replaces it)
  insights: CartInsight[];
  chips: CartChip[];
  facts: string[]; // for the AI note
  unavailable: CartLine[]; // lines needing a substitute
  removedNames: string[]; // Swiggy removed these (out of stock) on the last update
}

function inr(n: number): string {
  return `₹${Math.round(n).toLocaleString("en-IN")}`;
}

export function payableOf(cart: CartState): number {
  const n = Number((cart.bill?.total ?? "").replace(/[^0-9.]/g, ""));
  return Number.isFinite(n) && n > 0 ? n : cart.subtotal;
}

/** Review the cart. `budget` 0/undefined = no budget set. */
export function reviewCart(cart: CartState, budget?: number): CartReview {
  const insights: CartInsight[] = [];
  const chips: CartChip[] = [];
  const facts: string[] = [];
  const payable = payableOf(cart);
  const unavailable = [
    ...cart.items.filter((l) => l.inStock === false),
    ...(cart.unserviceable ?? []).filter((u) => !cart.items.some((l) => l.spinId === u.spinId && l.inStock === false)),
  ];
  const removedNames = (cart.warnings ?? [])
    .map((w) => w.match(/^(.+?) is out of stock and was removed\.$/)?.[1])
    .filter((x): x is string => !!x);

  facts.push(
    `${cart.itemCount} item${cart.itemCount === 1 ? "" : "s"} (${cart.items.map((l) => `${l.name} ${l.quantityDescription} ×${l.quantity}`).slice(0, 8).join(", ")})`,
    `item subtotal ${inr(cart.subtotal)}; ${cart.bill?.totalLabel || "To Pay"} ${cart.bill?.total || inr(cart.subtotal)}`,
  );
  for (const l of cart.bill?.lines ?? []) {
    if (!/^item total$/i.test(l.label.trim())) facts.push(`bill line: ${l.label} ${l.value}`);
  }

  // Blockers first.
  for (const u of unavailable) {
    insights.push({ tone: "block", text: `${u.name} is unavailable at this address — swap or remove it to check out.` });
    facts.push(`unavailable: ${u.name}`);
    chips.push({ id: `rm:${u.spinId}`, label: `Remove ${u.name.slice(0, 22)}`, kind: "remove", spinId: u.spinId });
  }
  for (const n of removedNames) {
    insights.push({ tone: "warn", text: `Swiggy removed ${n} (out of stock).` });
    facts.push(`Swiggy removed ${n} (out of stock)`);
    chips.push({
      id: `sub:${n}`,
      label: `Substitute for ${n.slice(0, 20)}`,
      kind: "ask",
      text: `${n} went out of stock and Swiggy removed it from my cart. Find the closest in-stock substitute (same type and size), say why in one line, and ADD it.`,
    });
  }
  for (const w of cart.warnings ?? []) {
    if (/is out of stock and was removed\.$|can't be delivered to this address\.$|is currently unavailable\.$/.test(w)) continue;
    insights.push({ tone: "warn", text: w });
    facts.push(`Swiggy notice: ${w}`);
  }
  const atCap = cart.items.filter((l) => l.maxQuantity && l.quantity >= l.maxQuantity);
  for (const l of atCap) {
    facts.push(`${l.name} is at Swiggy's per-order cap (${l.maxQuantityMessage || `max ${l.maxQuantity}`})`);
  }
  if (atCap.length) {
    insights.push({
      tone: "info",
      text: `${atCap.map((l) => l.name).slice(0, 2).join(", ")} ${atCap.length === 1 ? "is" : "are"} at Swiggy's per-order limit.`,
    });
    const l = atCap[0];
    chips.push({
      id: `cap:${l.spinId}`,
      label: `More than ${l.maxQuantity} ${l.name.slice(0, 16)}?`,
      kind: "ask",
      text: `${l.name} (${l.quantityDescription}) is capped at ${l.maxQuantity} per order ("${l.maxQuantityMessage ?? ""}"). I need more — propose the closest substitute pack or brand to cover the rest, with a one-line why, and ADD it.`,
    });
  }

  // Minimum order (Swiggy re-checks at checkout).
  if (cart.subtotal > 0 && cart.subtotal < IM_MIN_ORDER) {
    const short = IM_MIN_ORDER - cart.subtotal;
    insights.push({ tone: "block", text: `Add ${inr(short)} more — Instamart's minimum order is ₹99.` });
    facts.push(`below the ₹99 minimum by ${inr(short)}`);
    chips.push({
      id: "min",
      label: `Fill ${inr(short)} with usuals`,
      kind: "ask",
      text: `My Instamart cart is ${inr(cart.subtotal)}, ${inr(short)} under the ₹99 minimum. Suggest 1-2 everyday items I usually buy (check your_go_to_items) worth about ${inr(short)}–${inr(short + 60)} and ADD the best one.`,
    });
  }

  // Budget.
  if (budget && budget > 0) {
    if (payable > budget) {
      insights.push({ tone: "warn", text: `${inr(payable - budget)} over your ${inr(budget)} budget.` });
      facts.push(`To Pay is ${inr(payable - budget)} OVER the ${inr(budget)} budget`);
      chips.push({ id: "trim", label: `Trim to ${inr(budget)}`, kind: "trim" });
    } else {
      insights.push({ tone: "good", text: `${inr(budget - payable)} under your ${inr(budget)} budget.` });
      facts.push(`To Pay is ${inr(budget - payable)} under the ${inr(budget)} budget`);
    }
  }

  // Savings vs MRP.
  if (cart.savings > 0) {
    const mrp = cart.subtotal + cart.savings;
    insights.push({ tone: "good", text: `You save ${inr(cart.savings)} vs MRP (${Math.round((cart.savings / mrp) * 100)}%).` });
    facts.push(`saves ${inr(cart.savings)} vs MRP`);
  }

  // Stores, membership, fees.
  if (cart.storeCount && cart.storeCount > 1) {
    insights.push({ tone: "info", text: `Items come from ${cart.storeCount} stores — Swiggy places one order per store (separate deliveries).` });
    facts.push(`items from ${cart.storeCount} stores (one order each)`);
  }
  if (cart.swiggyOne?.userStatus === "SUPER") {
    const free = (cart.bill?.lines ?? []).filter((l) => l.value.trim().toUpperCase() === "FREE").map((l) => l.label);
    const plan = ["Swiggy", cart.swiggyOne.program || "One", cart.swiggyOne.offering].filter(Boolean).join(" ");
    insights.push({ tone: "good", text: `${plan} active${free.length ? ` — ${free.join(", ")} FREE` : ""}.` });
    facts.push(`${plan} membership active${free.length ? `; free: ${free.join(", ")}` : ""}`);
  }
  const fees = (cart.bill?.lines ?? []).filter(
    (l) => /fee|charge/i.test(l.label) && l.value.trim().toUpperCase() !== "FREE",
  );
  if (fees.length) {
    insights.push({ tone: "info", text: `Fees: ${fees.map((f) => `${f.label} ${f.value}`).join(" · ")}.` });
  }
  if (cart.boundAddressId) {
    insights.push({ tone: "info", text: "This cart was built for another address — it moves here (stock re-checked) at checkout." });
    facts.push("cart is bound to a different address and will move at checkout");
  }

  chips.push({
    id: "cheaper",
    label: "Cheaper swaps",
    kind: "ask",
    text: "Review my Instamart cart (call get_cart) and find 1-2 cheaper swaps with better value per unit for the same need. Say the saving in one line each and ADD the best swap; REMOVE what it replaces.",
  });

  const block = insights.find((i) => i.tone === "block");
  const headline = block
    ? block.text
    : insights.find((i) => i.tone === "warn")?.text ??
      `Looks good — ${cart.bill?.total || inr(cart.subtotal)} to pay${cart.savings > 0 ? `, saving ${inr(cart.savings)} vs MRP` : ""}.`;

  const key = [
    cart.items.map((l) => `${l.spinId}:${l.quantity}:${l.inStock === false ? 0 : 1}`).join(","),
    cart.bill?.total ?? "",
    (cart.warnings ?? []).join("|"),
    budget ?? 0,
  ].join("#");

  return { key, headline, insights, chips, facts, unavailable, removedNames };
}

/* ------------------------------ readiness --------------------------------- */

export interface Readiness {
  ready: boolean;
  blockers: string[];
  address?: string;
  items: number;
  toPay: string;
  methods: { label: string; iconUrl?: string }[];
  /** plain-English explanation of agenticPaymentEligible === false */
  agenticNote?: string;
}

/** "Ready to order" summary: cart + Swiggy's live payment methods. */
export function checkoutReadiness(
  cart: CartState,
  options: PaymentOptionsPayload | null,
  selectedAddressLine?: string,
): Readiness {
  const blockers: string[] = [];
  if (!cart.items.length) blockers.push("Cart is empty");
  if (cart.subtotal > 0 && cart.subtotal < IM_MIN_ORDER) blockers.push(`Below the ₹99 minimum`);
  if (cart.items.some((l) => l.inStock === false) || cart.unserviceable?.length) blockers.push("Unavailable items in the cart");
  const methods: { label: string; iconUrl?: string }[] = [];
  const seen = new Set<string>();
  const push = (label?: string, iconUrl?: string) => {
    const l = (label ?? "").trim();
    if (!l || seen.has(l)) return;
    seen.add(l);
    methods.push({ label: l, ...(iconUrl ? { iconUrl } : {}) });
  };
  if (options) {
    for (const m of options.allMethods ?? []) if (m.enabled !== false) push(m.displayName || m.name, m.iconUrl);
    for (const m of options.platforms?.mobile?.methods ?? []) if (m.enabled !== false) push(m.displayName || m.name, m.iconUrl);
    for (const m of options.platforms?.desktop?.methods ?? []) if (m.enabled !== false) push(m.displayName || m.name, m.iconUrl);
    if (options.swiggyMoney?.available === true) push(options.swiggyMoney.displayName || "Swiggy Money");
    if (options.cod?.available === true) push(options.cod.displayName || "Pay on delivery");
  }
  const d = cart.deliveryAddress;
  const address = d ? [d.label, [d.flatNo, d.address].filter(Boolean).join(", ")].filter(Boolean).join(" · ") : selectedAddressLine;
  return {
    ready: blockers.length === 0 && methods.length > 0,
    blockers,
    ...(address ? { address } : {}),
    items: cart.itemCount,
    toPay: cart.bill?.total || inr(cart.subtotal),
    methods,
    ...(options && options.agenticPaymentEligible === false
      ? {
          agenticNote:
            "Swiggy reports this account isn't eligible for assistant-completed payment (agenticPaymentEligible: false), so Swizzo never pays for you — you tap Checkout, pick a method and approve the payment yourself (in your UPI app / by QR, or pay on delivery when offered).",
        }
      : {}),
  };
}
