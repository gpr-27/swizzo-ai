'use client';

// The right-column cart tray — the app's dark "product chrome" moment. Layout is
// built so the cart LINES are the hero: a sticky one-row header (count, Swiggy
// One badge, share) with a one-line address that expands on tap, then a
// scrolling body — Swiggy's notices, the lines, a one-line "Swizzo's read" that
// expands into insights + chips (+ Analyse), the budget, and a compact
// "Pay with" row — and a sticky footer that always shows To Pay (bill rows on
// tap) and the coral Checkout CTA. Everything shown comes from Swiggy's cart.

import { useState } from 'react';
import type { CartLine, CartPanelProps, CartState } from '@/shared/types';
import type { CartReview } from '@/shared/instamart-review';
import { CartLineRow } from './CartLineRow';
import { BudgetMeter } from './BudgetMeter';
import { ShareBasketButton } from '../features/ShareBasketButton';
import { useCartReview } from '@/frontend/hooks/useCartReview';
import { Chevron, InfoToggle, PayMethodsRow } from './trayBits';

const MIN_CHECKOUT = 99;

function inr(n: number): string {
  return `₹${Math.round(n).toLocaleString('en-IN')}`;
}

// The REAL amount payable: parse Swiggy's grand total ("₹241" / "₹1,234.00")
// from the bill; fall back to the local subtotal only until the bill lands. The
// budget guardrail must measure against what you actually pay, not the subtotal.
function billTotalOf(cart: CartState): number {
  const t = cart.bill?.total;
  if (t) {
    const n = Number(t.replace(/[^0-9.]/g, ''));
    if (Number.isFinite(n) && n > 0) return n;
  }
  return cart.subtotal;
}

const GRAND_TOTAL = /^(grand total|to pay|total amount|bill total|order total)$/i;

/** One-line read of the cart: a blocker/warning verbatim, else "₹X to pay · …". */
function summaryOf(cart: CartState, review: CartReview): { text: string; tone: string } {
  const block = review.insights.find((i) => i.tone === 'block');
  if (block) return { text: block.text, tone: 'block' };
  const warn = review.insights.find((i) => i.tone === 'warn');
  if (warn) return { text: warn.text, tone: 'warn' };
  const parts = [`${cart.bill?.total || inr(cart.subtotal)} to pay`];
  if (cart.swiggyOne?.userStatus === 'SUPER') {
    const free = (cart.bill?.lines ?? []).filter((l) => l.value.trim().toUpperCase() === 'FREE').map((l) => l.label);
    const what = free.find((l) => /deliver/i.test(l)) ? 'delivery' : free[0]?.toLowerCase();
    if (what) parts.push(`${what} free with Swiggy One`);
  }
  const capped = cart.items.find((l) => l.maxQuantity && l.quantity >= l.maxQuantity);
  if (capped) parts.push(`${capped.brand || capped.name.split(/\s+/).slice(0, 2).join(' ')} at its per-order limit`);
  if (cart.savings > 0) parts.push(`saving ${inr(cart.savings)}`);
  return { text: parts.join(' · '), tone: 'info' };
}

// `sending` (a chat turn streaming) is additive to the frozen CartPanelProps so
// the shell can gate the agent-triggering buttons (Analyse / Trim) without
// blocking the optimistic steppers. Cart sync uses `busy` only as a soft hint.
export function CartPanel({
  cart,
  busy,
  onIncrement,
  onDecrement,
  onRemove,
  onClear,
  onCheckout,
  onAnalyze,
  budget,
  onTrim,
  sending,
  onSwap,
  onShare,
  onAsk,
  onReplaceLine,
  selectedAddressLine,
}: CartPanelProps & {
  sending?: boolean;
  onSwap?: (line: CartLine) => void;
  onShare?: () => Promise<boolean> | boolean;
  /** AI chips: send a (hidden) chat turn */
  onAsk?: (text: string, displayText?: string) => void;
  /** AI substitute for an unavailable line */
  onReplaceLine?: (oldSpinId: string, line: Omit<CartLine, 'quantity'>, quantity: number) => void;
  /** the picked address, until Swiggy's cart reports its own */
  selectedAddressLine?: string;
}) {
  const isEmpty = cart.items.length === 0;
  // Instamart's documented ₹99 minimum (Swiggy re-checks it at checkout).
  const belowMin = cart.subtotal > 0 && cart.subtotal < MIN_CHECKOUT;
  // A cart bound to ANOTHER address doesn't block checkout: checkout first
  // pushes the cart (`set`) for the selected address, which moves it there
  // (clear_cart + update_cart, availability re-checked) before /api/checkout
  // re-verifies the binding.
  const movesAddress = !!cart.boundAddressId;
  const blocked =
    !!cart.unserviceable?.length ||
    cart.items.some((l) => l.inStock === false);
  const canCheckout = !busy && !isEmpty && !belowMin && !blocked;
  const payable = billTotalOf(cart);
  // AI review + "Ready to order" (only when the shell wires the AI actions in).
  const ai = useCartReview(cart, budget, !!onAsk, !!busy, selectedAddressLine);
  const toneClass = (t: string) =>
    t === 'block' ? 'text-red-300' : t === 'warn' ? 'text-amber-300' : t === 'good' ? 'text-accent-teal' : 'text-on-dark-soft';

  // Progressive disclosure — layout state only.
  const [addrOpen, setAddrOpen] = useState(false);
  const [readOpen, setReadOpen] = useState(false);
  const [billOpen, setBillOpen] = useState(false);
  const [agenticOpen, setAgenticOpen] = useState(false);

  const addr = cart.deliveryAddress;
  const addrStreet = addr ? [addr.flatNo, addr.address].filter(Boolean).join(', ') : '';
  const addrLine = addr
    ? [addr.name || addr.label, addrStreet].filter(Boolean).join(' · ')
    : selectedAddressLine ?? '';
  const summary = summaryOf(cart, ai.review);
  const billRows = (cart.bill?.lines ?? []).filter((l) => !GRAND_TOTAL.test(l.label.trim()));
  const toPay = cart.bill?.total || inr(cart.subtotal);
  const one = cart.swiggyOne?.userStatus === 'SUPER' ? cart.swiggyOne : undefined;

  return (
    <div className="sticky top-3 m-3 flex h-[calc(100%-1.5rem)] min-h-0 flex-col overflow-hidden rounded-2xl border border-white/10 bg-[#131315] text-white shadow-2xl backdrop-blur-xl transition-all duration-300">
      {/* Header — one row + a one-line address (sticky: outside the scroller) */}
      <header className="shrink-0 border-b border-white/[0.06] bg-gradient-to-b from-white/[0.04] to-transparent px-5 pb-2.5 pt-4">
        <div className="flex items-center gap-2">
          <h2 className="min-w-0 truncate font-display text-lg font-bold tracking-tight text-white">
            Your cart
            {!isEmpty && (
              <span className="ml-1.5 font-sans text-[13px] font-medium tracking-normal text-on-dark-soft">
                · {cart.itemCount} {cart.itemCount === 1 ? 'item' : 'items'}
              </span>
            )}
          </h2>
          {busy && <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-coral" aria-label="Syncing" />}
          {/* Swiggy One membership (get_cart superData) — explains free delivery */}
          {one && (
            <span
              title={`Swiggy ${[one.program, one.offering].filter(Boolean).join(' ')} member`}
              className="shrink-0 rounded-full border border-amber-300/40 bg-amber-300/10 px-1.5 py-px text-[9px] font-semibold uppercase tracking-wide text-amber-200"
            >
              {one.program || 'One'}
              {one.offering ? ` ${one.offering}` : ''}
            </span>
          )}
          {!isEmpty && onShare && (
            <span className="ml-auto shrink-0">
              <ShareBasketButton onShare={onShare} disabled={busy} iconOnly />
            </span>
          )}
        </div>

        {/* Where Swiggy's cart delivers (get_cart selectedAddressDetails) — tap for details */}
        {!isEmpty && addrLine && (
          <div className="mt-1">
            <button
              type="button"
              onClick={() => setAddrOpen((v) => !v)}
              aria-expanded={addrOpen}
              className="flex w-full min-w-0 items-center gap-1 text-left text-[12px] text-on-dark-soft hover:text-on-dark"
            >
              <svg viewBox="0 0 24 24" className="h-3 w-3 shrink-0" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M12 21s-7-6.2-7-11.5A7 7 0 0 1 19 9.5C19 14.8 12 21 12 21Z" />
                <circle cx="12" cy="9.5" r="2.5" />
              </svg>
              <span className="min-w-0 flex-1 truncate">
                To: <span className="text-on-dark">{addrLine}</span>
              </span>
              <Chevron open={addrOpen} className="h-3 w-3" />
            </button>
            {addrOpen && (
              <div className="mt-1 space-y-0.5 pl-4 text-[12px] leading-snug">
                {addr ? (
                  <>
                    {(addr.label || addr.category) && (
                      <p className="text-on-dark-soft">
                        {addr.label && <span className="font-semibold text-on-dark">{addr.label}</span>}
                        {addr.category && <span> · {addr.category.toLowerCase()}</span>}
                      </p>
                    )}
                    {addrStreet && <p className="text-on-dark">{addrStreet}</p>}
                    {(addr.name || addr.phone) && (
                      <p className="text-on-dark-soft">{[addr.name, addr.phone].filter(Boolean).join(' · ')}</p>
                    )}
                  </>
                ) : (
                  <p className="text-on-dark">{addrLine}</p>
                )}
              </div>
            )}
            {!!cart.storeCount && cart.storeCount > 1 && (
              <p className="mt-0.5 truncate pl-4 text-[11px] text-accent-amber" title="Swiggy places one order per store.">
                Items from {cart.storeCount} stores — one order per store
              </p>
            )}
          </div>
        )}
      </header>

      {/* Body */}
      {isEmpty ? (
        <div className="flex flex-1 flex-col items-center justify-center px-8 text-center">
          {!!cart.warnings?.length && (
            <div role="status" className="mb-4 space-y-1">
              {cart.warnings.map((w, i) => (
                <p key={`${i}-${w}`} className="text-[12px] leading-snug text-amber-300">
                  {w}
                </p>
              ))}
            </div>
          )}
          <svg viewBox="0 0 24 24" className="h-10 w-10 text-on-dark-soft/30" fill="currentColor" aria-hidden="true">
            <path d="M12 1.5c.55 5.3 4.7 9.45 10 10-5.3.55-9.45 4.7-10 10-.55-5.3-4.7-9.45-10-10 5.3-.55 9.45-4.7 10-10Z" />
          </svg>
          <p className="mt-4 text-[15px] text-on-dark">Your cart is empty</p>
          <p className="mt-1 text-sm text-on-dark-soft">
            Ask the concierge for something tasty.
          </p>
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-5">
          {/* Swiggy's own notices: removed / capped / unserviceable items, address warnings */}
          {!!cart.warnings?.length && (
            <div role="status" className="mt-3 space-y-0.5 rounded-lg bg-amber-400/[0.07] px-3 py-2">
              {cart.warnings.map((w, i) => (
                <p key={`${i}-${w}`} className="text-[12px] leading-snug text-amber-300">
                  {w}
                </p>
              ))}
            </div>
          )}

          {/* The lines — the hero */}
          <div className="divide-y divide-on-dark-soft/10">
            {cart.items.map((line) => (
              // Steppers stay live during background sync (optimistic) — `busy`
              // is only a soft hint, never a blocker. Zero perceived lag.
              <CartLineRow
                key={line.spinId}
                line={line}
                onIncrement={onIncrement}
                onDecrement={onDecrement}
                onRemove={onRemove}
                onSwap={onSwap}
              />
            ))}
          </div>

          {/* Swizzo's read — one line; tap for insights, chips and Analyse */}
          {(onAsk || onAnalyze) && (
            <section aria-label="AI cart review" className="mt-1 rounded-xl border border-white/[0.08] bg-white/[0.03]">
              <button
                type="button"
                onClick={() => setReadOpen((v) => !v)}
                aria-expanded={readOpen}
                className="flex w-full min-w-0 items-center gap-2 px-3 py-2.5 text-left"
              >
                <span className="shrink-0 text-amber-300" aria-hidden="true">✦</span>
                <span
                  className={`min-w-0 flex-1 truncate text-[12.5px] ${summary.tone === 'info' ? 'text-on-dark' : toneClass(summary.tone)}`}
                  title={summary.text}
                  aria-live="polite"
                >
                  {summary.text}
                </span>
                <span className="sr-only">Swizzo&apos;s read</span>
                <Chevron open={readOpen} className="h-3.5 w-3.5 text-on-dark-soft" />
              </button>

              {readOpen && (
                <div className="border-t border-white/[0.06] px-3 pb-3 pt-2">
                  <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-amber-300">Swizzo&apos;s read</p>
                  <p className="mt-1 text-[12.5px] leading-snug text-on-dark">{ai.note?.text ?? ai.review.headline}</p>
                  {ai.review.insights.length > 0 && (
                    <ul className="mt-1.5 space-y-0.5">
                      {ai.review.insights.slice(0, 5).map((i, k) => (
                        <li key={`${k}-${i.text}`} className={`text-[12px] leading-snug ${toneClass(i.tone)}`}>
                          • {i.text}
                        </li>
                      ))}
                    </ul>
                  )}
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {onAnalyze && (
                      <button
                        type="button"
                        onClick={onAnalyze}
                        disabled={busy || sending}
                        className="inline-flex items-center gap-1 rounded-full border border-amber-300/40 bg-amber-300/10 px-2.5 py-1 text-[11px] font-semibold text-amber-200 transition-colors hover:border-amber-300/70 disabled:opacity-40"
                      >
                        <span aria-hidden="true">✦</span> {sending ? 'Analysing…' : 'Analyse with AI'}
                      </button>
                    )}
                    {onAsk &&
                      ai.review.chips.map((c) => (
                        <button
                          key={c.id}
                          type="button"
                          disabled={(c.kind === 'ask' || c.kind === 'trim') && sending}
                          onClick={() => {
                            if (c.kind === 'remove' && c.spinId) onRemove(c.spinId);
                            else if (c.kind === 'trim') onTrim?.();
                            else if (c.text) onAsk(c.text, c.label);
                          }}
                          className="max-w-full truncate rounded-full border border-white/15 bg-white/5 px-2.5 py-1 text-[11px] text-white/85 transition-colors hover:border-coral/50 hover:text-white disabled:opacity-40"
                        >
                          {c.label}
                        </button>
                      ))}
                  </div>
                  {ai.note && <p className="mt-1.5 text-[10px] text-white/35">AI note by {ai.note.model} from Swiggy&apos;s cart data</p>}
                </div>
              )}

              {/* Substitutes for unavailable lines (live search) — always visible: they unblock checkout */}
              {onReplaceLine &&
                ai.review.unavailable.map((u) => {
                  const sub = ai.substitutes[u.spinId];
                  if (!sub) return null;
                  return (
                    <div key={u.spinId} className="mx-3 mb-3 rounded-lg border border-amber-300/25 bg-amber-300/[0.06] px-3 py-2">
                      <p className="text-[12px] leading-snug text-on-dark">
                        Swap <span className="font-semibold">{u.name}</span> → <span className="font-semibold">{sub.line.name}</span> ·{' '}
                        {sub.line.quantityDescription} · {inr(sub.line.unitPrice)}
                      </p>
                      <p className="mt-0.5 text-[11px] leading-snug text-on-dark-soft">{sub.reason}</p>
                      <button
                        type="button"
                        onClick={() => onReplaceLine(u.spinId, sub.line, u.quantity || 1)}
                        className="mt-1.5 rounded-full bg-amber-300 px-3 py-1 text-[11px] font-semibold text-[#131315] hover:bg-amber-200"
                      >
                        Swap it in
                      </button>
                    </div>
                  );
                })}
            </section>
          )}

          {budget != null && budget > 0 && (
            <div className="mt-3">
              {/* Measure the budget against the REAL payable total, not subtotal. */}
              <BudgetMeter
                budget={budget}
                spent={payable}
                onTrim={onTrim}
                disabled={sending}
              />
            </div>
          )}

          {/* Ready to order — status + Swiggy's live payment methods (compact) */}
          {onAsk && (
            <div className="mt-3" aria-label="Checkout readiness">
              <div className="flex min-w-0 items-center gap-1.5">
                {/* readiness as a glyph (full words for screen readers / hover) */}
                <span
                  title={ai.readiness.ready ? 'Ready to order' : ai.readiness.blockers.length ? 'Not ready yet' : 'Checking payment options…'}
                  className={`shrink-0 text-[12px] font-bold leading-none ${ai.readiness.ready ? 'text-accent-teal' : 'text-amber-300'}`}
                >
                  <span aria-hidden="true">{ai.readiness.ready ? '✓' : ai.readiness.blockers.length ? '!' : '…'}</span>
                  <span className="sr-only">
                    {ai.readiness.ready ? 'Ready to order' : ai.readiness.blockers.length ? 'Not ready yet' : 'Checking payment options'}
                  </span>
                </span>
                <span className="shrink-0 text-[11px] text-on-dark-soft">Pay with</span>
                <span className="min-w-0 flex-1">
                  <PayMethodsRow
                    methods={ai.readiness.methods}
                    emptyText={ai.paymentsLoaded ? 'No methods returned by Swiggy' : 'Loading from Swiggy…'}
                  />
                </span>
                {ai.readiness.agenticNote && (
                  <InfoToggle
                    open={agenticOpen}
                    onToggle={() => setAgenticOpen((v) => !v)}
                    label="How payment works"
                    text={ai.readiness.agenticNote}
                  />
                )}
              </div>
              {ai.readiness.blockers.length > 0 && (
                <p className="mt-1 text-[11px] leading-snug text-amber-300">{ai.readiness.blockers.join(' · ')}</p>
              )}
              {agenticOpen && ai.readiness.agenticNote && (
                <p className="mt-1.5 rounded-lg bg-white/[0.04] px-2.5 py-2 text-[11px] leading-snug text-on-dark-soft">
                  {ai.readiness.agenticNote}
                </p>
              )}
            </div>
          )}

          {/* Quiet footer links */}
          <div className="mb-3 mt-4 flex items-center justify-between gap-2 border-t border-white/[0.06] pt-2.5">
            <button
              type="button"
              onClick={onClear}
              disabled={busy}
              className="py-1 text-xs text-white/45 transition-colors hover:text-white/85 disabled:opacity-40"
            >
              Clear cart
            </button>
            <p className="text-[10px] text-white/30">Powered by Instamart</p>
          </div>
        </div>
      )}

      {/* Sticky checkout bar — To Pay (bill rows on tap) + Checkout */}
      {!isEmpty && (
        <footer
          className={`shrink-0 border-t border-on-dark-soft/15 bg-[#131315] px-5 pb-4 pt-3 ${
            busy ? 'opacity-70' : ''
          }`}
        >
          {(belowMin || blocked || movesAddress) && (
            <div className="mb-2 space-y-0.5 text-[11px] leading-snug text-accent-amber">
              {belowMin && <p>Add {inr(MIN_CHECKOUT - cart.subtotal)} more to checkout (₹99 minimum).</p>}
              {blocked && <p>Remove unavailable items to checkout.</p>}
              {movesAddress && !blocked && (
                <p
                  className="truncate"
                  title="This cart was set up for another delivery address — it moves here (with a fresh stock check) when you check out or change it."
                >
                  Cart was set up for another address — it moves here at checkout.
                </p>
              )}
            </div>
          )}

          {/* Real Swiggy bill: item total, handling, delivery, GST, … */}
          {billOpen && cart.bill && (
            <div className="mb-2 max-h-40 space-y-1 overflow-y-auto border-b border-on-dark-soft/15 pb-2">
              {billRows.map((l, i) => {
                const free = l.value.trim().toUpperCase() === 'FREE';
                return (
                  <div key={`${l.label}-${i}`} className="flex items-center justify-between gap-3 text-[13px]">
                    <span className="min-w-0 truncate text-on-dark-soft">{l.label}</span>
                    <span className={`shrink-0 ${free ? 'text-accent-teal' : 'text-on-dark'}`}>{l.value}</span>
                  </div>
                );
              })}
              {cart.savings > 0 && (
                <div className="flex items-center justify-between text-[13px]">
                  <span className="text-on-dark-soft">You save</span>
                  <span className="text-accent-teal">{inr(cart.savings)}</span>
                </div>
              )}
            </div>
          )}

          <div className="flex items-center justify-between gap-3">
            <div className="flex min-w-0 items-baseline gap-2">
              <span className="text-[13px] text-on-dark-soft">{cart.bill ? cart.bill.totalLabel || 'To Pay' : 'Subtotal'}</span>
              <span className="font-display text-xl leading-none text-on-dark">{cart.bill ? toPay : inr(cart.subtotal)}</span>
              {cart.savings > 0 && !billOpen && (
                <span className="truncate text-[11px] text-accent-teal">saved {inr(cart.savings)}</span>
              )}
            </div>
            {cart.bill && (
              <button
                type="button"
                onClick={() => setBillOpen((v) => !v)}
                aria-expanded={billOpen}
                className="inline-flex shrink-0 items-center gap-1 text-[12px] font-medium text-on-dark-soft hover:text-on-dark"
              >
                Bill details
                <Chevron open={billOpen} className="h-3 w-3" />
              </button>
            )}
          </div>

          <button
            type="button"
            onClick={onCheckout}
            disabled={!canCheckout}
            className="mt-2.5 w-full rounded-xl bg-gradient-to-r from-[#FF5200] via-[#FF6A3D] to-[#FF5200] px-4 py-3 text-sm font-bold text-white shadow-lg shadow-coral/25 transition-all hover:scale-[1.01] hover:shadow-coral/40 active:scale-[0.99] disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-40"
          >
            {busy ? 'Updating…' : `Checkout · ${toPay}`}
          </button>
        </footer>
      )}
    </div>
  );
}

export default CartPanel;
