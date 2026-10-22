// Bill-split estimates for Dineout (Swiggy's "cost for two") and Scenes
// (ticket price × count). Pure math over Swiggy's own numbers — the UI labels
// every figure "estimate"; Swiggy's bill / cart is the real amount.

/** "₹1,000 for two" / "₹1800 for two" → 1000 / 1800 (rupees for 2 people); undefined if absent. */
export function parseCostForTwo(text: string | undefined): number | undefined {
  if (!text) return undefined;
  const m = /₹\s*([\d,]+(?:\.\d+)?)/.exec(text) ?? /([\d,]{2,}(?:\.\d+)?)/.exec(text);
  if (!m) return undefined;
  const n = Number(m[1].replace(/,/g, ''));
  if (!Number.isFinite(n) || n <= 0) return undefined;
  // "for one" / "per person" strings exist on some cards → normalise to two.
  return /\b(for one|per person|for 1)\b/i.test(text) ? n * 2 : n;
}

export interface DineoutSplit {
  guests: number;
  perPerson: number; // before discount
  total: number; // before discount
  discountPct?: number;
  totalAfterDiscount?: number;
  perPersonAfterDiscount?: number;
  bookingFee?: number; // a paid prebook deal's fee (added on top, per Swiggy)
  payers: number;
  perPayer: number; // what each payer settles (after discount + fee)
}

/**
 * Dineout estimate: (costForTwo / 2) × guests, minus the deal's bill discount,
 * plus a paid deal's booking fee, split across `payers` (default: every guest).
 */
export function dineoutSplit(args: {
  costForTwo: number;
  guests: number;
  payers?: number;
  discountPct?: number;
  bookingFee?: number;
}): DineoutSplit {
  const guests = Math.max(1, Math.round(args.guests));
  const payers = Math.max(1, Math.min(guests, Math.round(args.payers ?? guests)));
  const perPerson = args.costForTwo / 2;
  const total = round(perPerson * guests);
  const pct = args.discountPct && args.discountPct > 0 && args.discountPct < 100 ? args.discountPct : undefined;
  const after = pct ? round(total * (1 - pct / 100)) : undefined;
  const fee = args.bookingFee && args.bookingFee > 0 ? args.bookingFee : undefined;
  const grand = (after ?? total) + (fee ?? 0);
  return {
    guests,
    perPerson: round(perPerson),
    total,
    discountPct: pct,
    totalAfterDiscount: after,
    perPersonAfterDiscount: after !== undefined ? round(after / guests) : undefined,
    bookingFee: fee,
    payers,
    perPayer: round(grand / payers),
  };
}

/** How many people one ticket admits, from Swiggy's tier name ("Entry Pass For Two" → 2). */
export function admitsPerTicket(ticketName: string | undefined): number {
  const t = (ticketName || '').toLowerCase();
  const words: Record<string, number> = { one: 1, single: 1, two: 2, couple: 2, duo: 2, pair: 2, three: 3, four: 4, five: 5, six: 6, group: 0 };
  const m = /\b(?:for|admits?|pass(?:\s+for)?)\s+(\d+|one|two|three|four|five|six)\b/.exec(t);
  if (m) return /^\d+$/.test(m[1]) ? Math.max(1, Number(m[1])) : words[m[1]] || 1;
  if (/\b(couple|duo|pair)\b/.test(t)) return 2;
  const n = /\b(\d+)\s*(?:people|persons|pax|guests)\b/.exec(t);
  return n ? Math.max(1, Number(n[1])) : 1;
}

export interface ScenesSplit {
  tickets: number;
  people: number;
  total: number;
  perPerson: number;
}

/** Scenes estimate: price × tickets (+ cover), spread over everyone admitted. */
export function scenesSplit(args: { price: number; tickets: number; admits?: number; coverCharge?: number }): ScenesSplit {
  const tickets = Math.max(1, Math.round(args.tickets));
  const people = tickets * Math.max(1, Math.round(args.admits ?? 1));
  const total = round((args.price + (args.coverCharge ?? 0)) * tickets);
  return { tickets, people, total, perPerson: round(total / people) };
}

function round(n: number): number {
  return Math.round(n);
}

export function formatINR(n: number): string {
  return `₹${Math.round(n).toLocaleString('en-IN')}`;
}
