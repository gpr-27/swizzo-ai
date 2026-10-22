'use client';

// Instamart tray AI: after every cart change (once it settles) review the real
// cart, ask the AI for one short note over those facts, look up the closest
// in-stock substitute for any unavailable line, and refresh Swiggy's live
// payment methods for the "Ready to order" summary. Read-only calls only
// (/api/instamart/note, /api/search, /api/payments/options) — never checkout.

import { useEffect, useMemo, useRef, useState } from 'react';
import type { CartLine, CartState, PaymentOptionsPayload, Product } from '@/shared/types';
import { closestSubstitute, lineOf, toPick } from '@/shared/instamart-packs';
import { checkoutReadiness, reviewCart } from '@/shared/instamart-review';

const SETTLE_MS = 1_800;

export interface CartSubstitute {
  line: Omit<CartLine, 'quantity'>;
  reason: string;
}

export function useCartReview(
  cart: CartState,
  budget: number | undefined,
  enabled: boolean,
  busy: boolean,
  selectedAddressLine?: string,
) {
  const review = useMemo(() => reviewCart(cart, budget), [cart, budget]);
  const [ai, setAi] = useState<{ key: string; text: string; model: string } | null>(null);
  const [subs, setSubs] = useState<Record<string, CartSubstitute | null>>({});
  const [payments, setPayments] = useState<{ key: string; options: PaymentOptionsPayload | null } | null>(null);
  const looked = useRef(new Set<string>());
  const live = enabled && cart.items.length > 0 && !busy;

  // AI note + payment methods once the cart settles on a new state.
  useEffect(() => {
    if (!live) return;
    const key = review.key;
    const ac = new AbortController();
    const t = setTimeout(() => {
      void fetch('/api/instamart/note', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind: 'review', facts: [review.headline, ...review.facts] }),
        signal: ac.signal,
      })
        .then((r) => r.json())
        .then((d: { text?: string | null; model?: string }) => {
          if (d.text) setAi({ key, text: d.text, model: d.model ?? 'AI' });
        })
        .catch(() => {});
      void fetch('/api/payments/options?service=instamart', { signal: ac.signal })
        .then((r) => (r.ok ? r.json() : null))
        .then((d: { options?: PaymentOptionsPayload } | null) => setPayments({ key, options: d?.options ?? null }))
        .catch(() => {});
    }, SETTLE_MS);
    return () => {
      clearTimeout(t);
      ac.abort();
    };
  }, [live, review.key, review.headline, review.facts]);

  // Closest in-stock substitute for each unavailable line (once per line).
  useEffect(() => {
    if (!enabled || !cart.addressId) return;
    for (const u of review.unavailable) {
      if (looked.current.has(u.spinId)) continue;
      looked.current.add(u.spinId);
      void fetch(`/api/search?addressId=${encodeURIComponent(cart.addressId)}&query=${encodeURIComponent(u.name)}`)
        .then((r) => (r.ok ? r.json() : null))
        .then((d: { products?: Product[] } | null) => {
          const exclude = new Set(cart.items.map((l) => l.spinId));
          const c = closestSubstitute(u, d?.products ?? [], exclude);
          setSubs((prev) => ({
            ...prev,
            [u.spinId]: c
              ? { line: lineOf(c.product, c.variation), reason: `Closest in-stock match to ${u.name} · ${toPick(c).reason}` }
              : null,
          }));
        })
        .catch(() => setSubs((prev) => ({ ...prev, [u.spinId]: null })));
    }
  }, [enabled, cart.addressId, cart.items, review.unavailable]);

  const options = payments?.options ?? null;
  const readiness = useMemo(
    () => checkoutReadiness(cart, options, selectedAddressLine),
    [cart, options, selectedAddressLine],
  );

  return {
    review,
    // only show the AI note for the cart it was written about
    note: ai && ai.key === review.key ? ai : null,
    substitutes: subs,
    readiness,
    paymentsLoaded: payments !== null,
  };
}
