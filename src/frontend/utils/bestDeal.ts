// Dineout slot analytics over ONE get_available_slots result (7 days):
//  - bestDeal(): the slot + deal with the biggest bill discount (a free
//    reservation wins ties, then the lower booking fee, then the earlier time),
//    for "tonight" or the whole week;
//  - slotSummary(): live counts per date / meal (open slots, free vs paid
//    deals, sold out, top discount) for the date strip.
// Only Swiggy's numbers are compared; nothing is estimated.

import type { DineoutDeal, DineoutSlot } from '@/shared/types';

export interface BestDeal {
  slot: DineoutSlot;
  deal: DineoutDeal;
  discountPct: number; // 0 when the best is a plain free table
  fee: number; // booking fee (0 for free)
  reason: string; // "Flat 25% off the bill · ₹25 booking fee"
}

export function dealOpen(d: DineoutDeal): boolean {
  return !d.soldOut && d.availableInventory !== 0;
}

export function slotOpen(s: DineoutSlot): boolean {
  return s.availableInventory !== 0 && s.deals.some(dealOpen);
}

/** Today's YYYY-MM-DD in IST. */
export function istDate(nowMs: number = Date.now()): string {
  return new Date(nowMs).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
}

/** IST hour (0–23) of a unix-seconds reservation time. */
function istHour(unixSec: number): number {
  return new Date(unixSec * 1000 + 330 * 60_000).getUTCHours();
}

function fee(d: DineoutDeal): number {
  return d.isFree ? 0 : Math.max(0, d.bookingPrice ?? 0);
}

/** Higher is better. */
function better(a: { pct: number; fee: number; at: number }, b: { pct: number; fee: number; at: number }): boolean {
  if (a.pct !== b.pct) return a.pct > b.pct;
  if (a.fee !== b.fee) return a.fee < b.fee;
  return a.at < b.at;
}

export function bestDeal(
  slots: DineoutSlot[],
  opts: { scope?: 'tonight' | 'week'; nowMs?: number } = {},
): BestDeal | null {
  const now = opts.nowMs ?? Date.now();
  const today = istDate(now);
  let best: { slot: DineoutSlot; deal: DineoutDeal; pct: number; fee: number; at: number } | null = null;
  for (const s of slots) {
    if (s.reservationTime * 1000 <= now || !slotOpen(s)) continue;
    // "Tonight" = today's evening (Dinner window, or 5 PM onwards).
    if (opts.scope === 'tonight' && (s.dateStr !== today || !(/dinner/i.test(s.slotGroupName) || istHour(s.reservationTime) >= 17))) {
      continue;
    }
    for (const d of s.deals) {
      if (!dealOpen(d)) continue;
      const cand = { slot: s, deal: d, pct: d.discountPercentage ?? 0, fee: fee(d), at: s.reservationTime };
      if (!best || better(cand, best)) best = cand;
    }
  }
  if (!best) return null;
  const parts = [
    best.pct > 0 ? `${best.pct}% off the bill` : best.deal.isFree ? 'Free table reservation' : best.deal.title || 'Prebook deal',
    best.fee > 0 ? `₹${best.fee.toLocaleString('en-IN')} booking fee` : 'no booking fee',
  ];
  return { slot: best.slot, deal: best.deal, discountPct: best.pct, fee: best.fee, reason: parts.join(' · ') };
}

export interface DateSummary {
  date: string;
  total: number; // slots Swiggy listed
  open: number; // still bookable
  soldOut: number;
  free: number; // open slots with a free reservation
  paid: number; // open slots with a paid prebook deal
  maxDiscount: number;
  groups: { name: string; open: number; total: number }[];
}

export function slotSummary(slots: DineoutSlot[], nowMs: number = Date.now()): Map<string, DateSummary> {
  const out = new Map<string, DateSummary>();
  for (const s of slots) {
    const sum =
      out.get(s.dateStr) ??
      ({ date: s.dateStr, total: 0, open: 0, soldOut: 0, free: 0, paid: 0, maxDiscount: 0, groups: [] } as DateSummary);
    const past = s.reservationTime * 1000 <= nowMs;
    sum.total += 1;
    const open = !past && slotOpen(s);
    if (open) {
      sum.open += 1;
      if (s.deals.some((d) => dealOpen(d) && d.isFree)) sum.free += 1;
      if (s.deals.some((d) => dealOpen(d) && !d.isFree)) sum.paid += 1;
      for (const d of s.deals) if (dealOpen(d)) sum.maxDiscount = Math.max(sum.maxDiscount, d.discountPercentage ?? 0);
    } else if (!past) {
      sum.soldOut += 1;
    }
    const name = s.slotGroupName || 'Slots';
    const g = sum.groups.find((x) => x.name === name) ?? (sum.groups.push({ name, open: 0, total: 0 }), sum.groups[sum.groups.length - 1]);
    g.total += 1;
    if (open) g.open += 1;
    out.set(s.dateStr, sum);
  }
  return out;
}
