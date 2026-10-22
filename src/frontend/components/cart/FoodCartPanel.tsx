'use client';

// The Food service's right-column tray — the dark "product chrome" counterpart
// to CartPanel, laid out the same way so the order LINES stay the hero: a
// sticky one-row header (count + share) with the restaurant and delivery
// address on one truncated line each, a scrolling body — Swiggy's notice,
// parked carts, the lines, a one-line "Swizzo's read" (AI coupon + bill read +
// Analyse, tap to expand), coupons, cutlery, meters and a compact "Pay with"
// row — and a sticky footer with To pay (bill rows on tap) and Place order.
//
// Every price here is Swiggy's (get_food_cart) once synced; until then the panel
// says the prices aren't confirmed and won't let the order be placed. Swiggy's
// ₹1000 Builders Club cap and out-of-stock lines block placement too.

import { useState, type ReactNode } from 'react';
import type { Coupon, FoodCart, FoodCartLine, FoodCartPanelProps } from '@/shared/types';
import { FOOD_ORDER_CAP } from '@/shared/types';
import { BudgetMeter } from './BudgetMeter';
import { MacroMeter } from './MacroMeter';
import { ShareBasketButton } from '../features/ShareBasketButton';
import { useFoodContext } from '@/frontend/state/foodActions';
import { FoodAiRead, FoodCheckoutReady, FoodLineAddons } from './FoodCartAi';
import { Chevron } from './trayBits';

function inr(n: number): string {
  return `₹${Math.round(n).toLocaleString('en-IN')}`;
}

const STEP_BTN =
  'inline-flex h-7 w-7 items-center justify-center rounded-full border border-on-dark-soft/40 text-on-dark transition-colors hover:border-coral active:bg-coral active:text-on-primary disabled:cursor-not-allowed disabled:opacity-40';

function VegMark({ veg }: { veg: boolean }) {
  return (
    <span
      className={`inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-[3px] border ${
        veg ? 'border-success' : 'border-error'
      }`}
      role="img"
      aria-label={veg ? 'Vegetarian' : 'Non-vegetarian'}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${veg ? 'bg-success' : 'bg-error'}`} />
    </span>
  );
}

function FoodCartLineRow({
  line,
  onIncrement,
  onDecrement,
  onRemove,
  onSwap,
  disabled,
}: {
  line: FoodCartLine;
  onIncrement: (menuItemId: string) => void;
  onDecrement: (menuItemId: string) => void;
  onRemove: (menuItemId: string) => void;
  onSwap?: (line: FoodCartLine) => void;
  disabled?: boolean;
}) {
  const [imgBroken, setImgBroken] = useState(false);
  const monogram = (line.name || '?').trim().charAt(0).toUpperCase();

  const soldOut = line.inStock === false;
  return (
    <div className={`flex gap-3 py-2.5 ${disabled || soldOut ? 'opacity-60' : ''}`}>
      {/* Thumb */}
      <div className="h-12 w-12 shrink-0 overflow-hidden rounded-lg bg-canvas">
        {line.imageUrl && !imgBroken ? (
          <img decoding="async"
            src={line.imageUrl}
            alt={line.name}
            loading="lazy"
            onError={() => setImgBroken(true)}
            className="h-full w-full object-cover"
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center">
            <span className="font-display text-lg text-muted-soft">{monogram}</span>
          </div>
        )}
      </div>

      {/* Details */}
      <div className="min-w-0 flex-1">
        <div className="flex items-start justify-between gap-2">
          <div className="flex min-w-0 items-start gap-1.5">
            <span className="mt-0.5">
              <VegMark veg={line.veg} />
            </span>
            <div className="min-w-0">
              <p className="line-clamp-2 text-[13px] font-medium leading-snug text-on-dark">{line.name}</p>
              {line.detail && (
                <p className="mt-0.5 line-clamp-1 text-[11px] text-on-dark-soft">{line.detail}</p>
              )}
              {soldOut && <p className="mt-0.5 text-[11px] font-medium text-coral">Out of stock — remove it</p>}
              {/* valid_addons for this portion + the AI's pick (editable) */}
              <FoodLineAddons line={line} disabled={disabled} />
            </div>
          </div>
          <button
            type="button"
            onClick={() => onRemove(line.menuItemId)}
            disabled={disabled}
            aria-label={`Remove ${line.name}`}
            className="-mr-1 -mt-1 shrink-0 rounded-full p-1 text-on-dark-soft transition-colors hover:text-on-dark disabled:opacity-40"
          >
            <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="mt-1.5 flex items-center justify-between gap-2">
          {/* Stepper */}
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => onDecrement(line.menuItemId)}
              disabled={disabled}
              aria-label={`Decrease ${line.name}`}
              className={STEP_BTN}
            >
              <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden="true">
                <path d="M5 12h14" />
              </svg>
            </button>
            <span className="w-5 text-center text-sm tabular-nums text-on-dark">
              {line.quantity}
            </span>
            <button
              type="button"
              onClick={() => onIncrement(line.menuItemId)}
              disabled={disabled}
              aria-label={`Increase ${line.name}`}
              className={STEP_BTN}
            >
              <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden="true">
                <path d="M12 5v14M5 12h14" />
              </svg>
            </button>

            {onSwap && (
              <button
                type="button"
                onClick={() => onSwap(line)}
                disabled={disabled}
                aria-label={`Change ${line.name}`}
                title="Change this for another option"
                className="ml-1 inline-flex items-center gap-1 rounded-full px-1.5 py-1 text-[11px] text-on-dark-soft transition-colors hover:text-coral disabled:opacity-40"
              >
                <svg viewBox="0 0 24 24" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M17 3v4h-4M3 11a5 5 0 0 1 9-3l5 4M7 21v-4h4M21 13a5 5 0 0 1-9 3l-5-4" />
                </svg>
                Change
              </button>
            )}
          </div>

          {/* Line total (Swiggy's subtotal struck through when the line is discounted) */}
          <span className="shrink-0 text-right font-display text-[15px] tabular-nums text-on-dark">
            {line.lineSubtotal !== undefined && line.lineFinal !== undefined && (
              <span className="mr-1.5 text-xs text-on-dark-soft line-through">{inr(line.lineSubtotal)}</span>
            )}
            {inr(line.price * line.quantity)}
          </span>
        </div>
      </div>
    </div>
  );
}

/**
 * "All coupons": the coupons Swiggy lists as applicable to this cart
 * (fetch_food_coupons — loaded only when opened) with an Apply each, plus a
 * code box. A coupon counts as applied only when the re-read cart shows a
 * positive discount (server side); a failed apply shows Swiggy's message.
 */
function CouponList({
  disabled,
  appliedCode,
  onList,
  onApply,
  aside,
}: {
  disabled: boolean;
  appliedCode?: string;
  /** rendered at the right of the toggle row (e.g. the cutlery switch) */
  aside?: ReactNode;
  onList: () => Promise<{ coupons: Coupon[]; message?: string; filter?: string }>;
  onApply: (code: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [coupons, setCoupons] = useState<Coupon[] | null>(null);
  const [message, setMessage] = useState<string | undefined>();
  const [filter, setFilter] = useState<string | undefined>();
  const [termsFor, setTermsFor] = useState<string | null>(null);
  const [code, setCode] = useState('');

  const toggle = async () => {
    const next = !open;
    setOpen(next);
    if (!next || coupons) return;
    setLoading(true);
    const res = await onList();
    setCoupons(res.coupons);
    setMessage(res.message);
    setFilter(res.filter);
    setLoading(false);
  };

  return (
    <div>
      <div className="flex items-center justify-between gap-3">
        <button
          type="button"
          onClick={toggle}
          aria-expanded={open}
          className="inline-flex items-center gap-1 text-xs font-semibold text-on-dark-soft hover:text-on-dark"
        >
          {open ? 'Hide coupons' : 'All coupons'} <Chevron open={open} className="h-3 w-3" />
        </button>
        {aside}
      </div>
      {open && (
        <div className="mt-2 space-y-1.5">
          {loading && <p className="text-xs text-on-dark-soft">Loading Swiggy coupons…</p>}
          {!loading && coupons && coupons.length === 0 && (
            <p className="text-xs text-on-dark-soft">{message || 'Swiggy lists no applicable coupons for this cart.'}</p>
          )}
          {/* fetch_food_coupons summary.filter_applied, e.g. "COD only" */}
          {!loading && filter && (
            <p className="text-[11px] text-on-dark-soft/80">Swiggy filter: {filter}</p>
          )}
          {coupons?.map((c) => {
            const isApplied = appliedCode?.toUpperCase() === c.code.toUpperCase();
            const notYet = c.applicable === false;
            const showTerms = termsFor === c.code;
            return (
              <div
                key={c.code}
                className={`rounded-md border border-on-dark-soft/15 px-3 py-1.5 ${notYet ? 'opacity-60' : ''}`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="min-w-0 text-xs text-on-dark">
                    <span className="font-semibold tracking-wide">{c.code}</span>
                    {c.ribbon && (
                      <span className="ml-1.5 rounded bg-coral/20 px-1 py-px text-[10px] font-semibold uppercase text-coral">
                        {c.ribbon}
                      </span>
                    )}
                    {c.section && <span className="ml-1.5 text-[10px] text-on-dark-soft">{c.section}</span>}
                    {(c.title || c.description) && (
                      <span className="block truncate text-on-dark-soft">{c.title || c.description}</span>
                    )}
                    {c.title && c.description && c.description !== c.title && (
                      <span className="block text-[11px] text-on-dark-soft/80">{c.description}</span>
                    )}
                    {c.subtitle && <span className="block text-[11px] text-amber-300/90">{c.subtitle}</span>}
                  </span>
                  <button
                    type="button"
                    onClick={() => onApply(c.code)}
                    disabled={disabled || isApplied || notYet}
                    title={notYet ? "Swiggy says this coupon doesn't apply to this cart yet" : undefined}
                    className="shrink-0 rounded-full border border-coral/50 px-2.5 py-0.5 text-[11px] font-semibold text-coral hover:bg-coral/10 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {isApplied ? 'Applied' : notYet ? 'Not yet' : 'Apply'}
                  </button>
                </div>
                {c.terms && c.terms.length > 0 && (
                  <>
                    <button
                      type="button"
                      onClick={() => setTermsFor(showTerms ? null : c.code)}
                      aria-expanded={showTerms}
                      className="mt-0.5 text-[10px] font-semibold text-on-dark-soft hover:text-on-dark"
                    >
                      {showTerms ? 'Hide terms' : 'Terms'}
                    </button>
                    {showTerms && (
                      <ul className="mt-1 list-disc space-y-0.5 pl-4 text-[10px] text-on-dark-soft">
                        {c.terms.map((t) => (
                          <li key={t}>{t}</li>
                        ))}
                      </ul>
                    )}
                  </>
                )}
              </div>
            );
          })}
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (code.trim()) onApply(code.trim());
            }}
          >
            <input
              value={code}
              onChange={(e) => setCode(e.target.value.toUpperCase())}
              placeholder="Have a code?"
              aria-label="Coupon code"
              maxLength={40}
              className="min-w-0 flex-1 rounded-md border border-on-dark-soft/20 bg-transparent px-2.5 py-1 text-xs text-on-dark placeholder:text-on-dark-soft focus:border-coral focus:outline-none"
            />
            <button
              type="submit"
              disabled={disabled || !code.trim()}
              className="shrink-0 rounded-full bg-coral px-3 py-1 text-xs font-medium text-on-primary hover:bg-coral-active disabled:cursor-not-allowed disabled:opacity-50"
            >
              Apply
            </button>
          </form>
        </div>
      )}
    </div>
  );
}

// `sending` (chat turn streaming) and `onApplyCoupon` are additive to the frozen
// FoodCartPanelProps: the shell threads `sending={hook.sending}` to gate the
// agent-triggering buttons and `onApplyCoupon={hook.applyBestCoupon}` for the
// one-tap coupon. Both are optional so existing call sites keep compiling.
export function FoodCartPanel({
  cart,
  busy,
  onIncrement,
  onDecrement,
  onRemove,
  onClear,
  onPlaceOrder,
  onAnalyze,
  budget,
  onTrim,
  kcalGoal = 0,
  proteinGoal = 0,
  kcal = 0,
  protein = 0,
  sending,
  onApplyCoupon,
  onListCoupons,
  onSetCutlery,
  onSwap,
  onShare,
  parkedCarts = [],
  onSwitchCart,
  onDiscardCart,
}: FoodCartPanelProps & {
  sending?: boolean;
  onApplyCoupon?: (couponCode?: string) => void;
  onListCoupons?: () => Promise<{ coupons: Coupon[]; message?: string; filter?: string }>;
  // cutlery on/off — sent to Swiggy as update_food_cart cutleryOptIn
  onSetCutlery?: (optIn: boolean) => void;
  onSwap?: (line: FoodCartLine) => void;
  onShare?: () => Promise<boolean> | boolean;
  // MULTI-CART: other restaurants' parked carts + switch/discard handlers
  parkedCarts?: FoodCart[];
  onSwitchCart?: (restaurantId: string) => void;
  onDiscardCart?: (restaurantId: string) => void;
}) {
  const isEmpty = cart.items.length === 0;
  // `synced === false` means Swiggy couldn't be reached: prices are unconfirmed.
  const unsynced = cart.synced === false;
  const overCap = cart.toPay > FOOD_ORDER_CAP;
  const hasSoldOut = cart.items.some((l) => l.inStock === false);
  const canPlace = !busy && !isEmpty && !unsynced && !overCap && !hasSoldOut;
  // free when Swiggy says so (offers.free_delivery_applied) or charges nothing
  const freeDelivery = !unsynced && (cart.freeDeliveryApplied === true || cart.deliveryCharge === 0);
  const applied = cart.appliedCoupon;
  // An applicable Swiggy coupon not yet applied (Swiggy gives no saving until applied).
  const bestCoupon = !applied && cart.bestCoupon ? cart.bestCoupon : null;
  const { addressLine } = useFoodContext();
  // Progressive disclosure — layout state only.
  const [billOpen, setBillOpen] = useState(false);
  const fromLine = [cart.restaurantArea, cart.deliverySubtitle].filter(Boolean).join(' · ');
  // cutlery on/off sits on the "All coupons" row
  const cutlery = onSetCutlery ? (
    <label
      className="flex shrink-0 cursor-pointer items-center gap-2 text-xs text-on-dark-soft"
      title={cart.cutleryOptIn === undefined ? "Restaurant's default" : cart.cutleryOptIn ? 'Requested' : 'Skipped — less plastic'}
    >
      <span>
        Send cutlery
        {cart.cutleryOptIn === undefined ? (
          <span className="text-on-dark-soft/70"> · default</span>
        ) : cart.cutleryOptIn === false ? (
          <span className="text-on-dark-soft/70"> · less plastic</span>
        ) : null}
      </span>
      <input
        type="checkbox"
        className="h-4 w-4 accent-coral"
        checked={cart.cutleryOptIn ?? false}
        disabled={busy}
        onChange={(e) => onSetCutlery(e.target.checked)}
        aria-label="Send cutlery with this order"
      />
    </label>
  ) : null;

  return (
    <div className="sticky top-3 m-3 flex h-[calc(100%-1.5rem)] min-h-0 flex-col overflow-hidden rounded-2xl border border-white/10 bg-[#131315] text-white shadow-2xl backdrop-blur-xl transition-all duration-300">
      {/* Header — one row + restaurant / address lines (sticky: outside the scroller) */}
      <header className="shrink-0 border-b border-white/[0.06] bg-gradient-to-b from-white/[0.04] to-transparent px-5 pb-2.5 pt-4">
        <div className="flex items-center gap-2">
          <h2 className="min-w-0 truncate font-display text-lg font-bold tracking-tight text-white">
            Your order
            {!isEmpty && (
              <span className="ml-1.5 font-sans text-[13px] font-medium tracking-normal text-on-dark-soft">
                · {cart.itemCount} {cart.itemCount === 1 ? 'item' : 'items'}
              </span>
            )}
          </h2>
          {busy && <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-coral" aria-label="Syncing" />}
          {!isEmpty && onShare && (
            <span className="ml-auto shrink-0">
              <ShareBasketButton onShare={onShare} disabled={busy} iconOnly />
            </span>
          )}
        </div>
        {cart.restaurantName && (
          <p className="mt-0.5 truncate text-[12px] text-on-dark-soft" title={[cart.restaurantName, fromLine].filter(Boolean).join(' · ')}>
            from <span className="font-semibold text-coral">{cart.restaurantName}</span>
            {fromLine && <span> · {fromLine}</span>}
          </p>
        )}
        {!isEmpty && addressLine && (
          <p className="mt-0.5 truncate text-[12px] text-on-dark-soft" title={addressLine}>
            To: <span className="text-on-dark">{addressLine}</span>
          </p>
        )}
      </header>

      {/* Real Swiggy messages (sync / coupon) */}
      {!isEmpty && cart.notice && (
        <div className="shrink-0 border-b border-white/5 bg-white/[0.02] px-5 py-1.5 text-[12px] leading-snug text-amber-300">
          {cart.notice}
        </div>
      )}

      {/* MULTI-CART: other restaurants' parked carts — tap to switch in (and place
          separately), × to discard. Swiggy holds one restaurant at a time. */}
      {parkedCarts.length > 0 && (
        <div className="flex shrink-0 items-center gap-2 border-b border-on-dark-soft/15 px-4 py-2">
          <p className="shrink-0 text-[10px] uppercase tracking-wide text-on-dark-soft">Other carts</p>
          <div className="flex min-w-0 gap-2 overflow-x-auto">
            {parkedCarts.map((c) => (
              <div
                key={c.restaurantId ?? c.restaurantName ?? 'cart'}
                className="flex shrink-0 items-center gap-1.5 rounded-full border border-on-dark-soft/25 bg-on-dark-soft/10 py-1 pl-3 pr-1.5 transition-colors hover:border-coral"
              >
                <button
                  type="button"
                  onClick={() => c.restaurantId && onSwitchCart?.(c.restaurantId)}
                  className="flex items-center gap-1.5 text-xs text-on-dark"
                  title={`Switch to ${c.restaurantName ?? 'this cart'}`}
                >
                  <span className="max-w-[120px] truncate">
                    {c.restaurantName ?? 'Cart'}
                  </span>
                  <span className="text-on-dark-soft">
                    · {c.itemCount} · {inr(c.toPay || c.itemTotal)}
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => c.restaurantId && onDiscardCart?.(c.restaurantId)}
                  aria-label={`Discard ${c.restaurantName ?? 'cart'}`}
                  className="rounded-full p-0.5 text-on-dark-soft transition-colors hover:text-on-dark"
                >
                  <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M18 6 6 18M6 6l12 12" />
                  </svg>
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Body */}
      {isEmpty ? (
        <div className="flex flex-1 flex-col items-center justify-center px-8 text-center">
          <svg viewBox="0 0 24 24" className="h-10 w-10 text-on-dark-soft/30" fill="currentColor" aria-hidden="true">
            <path d="M12 1.5c.55 5.3 4.7 9.45 10 10-5.3.55-9.45 4.7-10 10-.55-5.3-4.7-9.45-10-10 5.3-.55 9.45-4.7 10-10Z" />
          </svg>
          <p className="mt-4 text-[15px] text-on-dark">No items yet</p>
          <p className="mt-1 text-sm text-on-dark-soft">
            Open a menu and add something delicious.
          </p>
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-5">
          {/* The lines — the hero */}
          <div className="divide-y divide-on-dark-soft/10">
            {cart.items.map((line) => (
              // Steppers stay live during background sync (optimistic). Zero lag.
              <FoodCartLineRow
                key={line.menuItemId}
                line={line}
                onIncrement={onIncrement}
                onDecrement={onDecrement}
                onRemove={onRemove}
                onSwap={onSwap}
              />
            ))}
          </div>

          {/* Swizzo's read: AI coupon pass + bill read + Analyse, one line until tapped */}
          <FoodAiRead cart={cart} onAnalyze={onAnalyze} analyzeDisabled={busy || sending} sending={sending} />

          {/* One-tap apply for an applicable coupon Swiggy lists (not yet applied) */}
          {bestCoupon && !unsynced && (
            <div className="mt-2 flex items-center justify-between gap-2 rounded-lg border border-dashed border-coral/40 bg-coral/5 px-3 py-1.5">
              <span className="min-w-0 truncate text-[12px] text-on-dark" title={bestCoupon.title || bestCoupon.description || undefined}>
                <span className="font-semibold text-coral">Coupon</span>{' '}
                <span className="font-medium tracking-wide">{bestCoupon.code}</span>
                {(bestCoupon.title || bestCoupon.description) && (
                  <span className="text-on-dark-soft"> · {bestCoupon.title || bestCoupon.description}</span>
                )}
              </span>
              {onApplyCoupon && (
                <button
                  type="button"
                  onClick={() => onApplyCoupon()}
                  disabled={busy || sending}
                  className="shrink-0 rounded-full bg-coral px-3 py-1 text-xs font-medium text-on-primary transition-colors hover:bg-coral-active disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {sending ? 'Applying…' : 'Apply'}
                </button>
              )}
            </div>
          )}

          {/* All coupons + cutlery on one row (the coupon list expands below) */}
          {!unsynced && ((onApplyCoupon && onListCoupons) || onSetCutlery) && (
            <div className="mt-2.5">
              {onApplyCoupon && onListCoupons ? (
                <CouponList
                  disabled={busy || !!sending}
                  appliedCode={applied?.code}
                  onList={onListCoupons}
                  onApply={(code) => onApplyCoupon(code)}
                  aside={cutlery}
                />
              ) : (
                <div className="flex justify-end">{cutlery}</div>
              )}
            </div>
          )}

          {(kcalGoal > 0 || proteinGoal > 0) && (
            <div className="mt-3">
              {/* AI-estimated per-dish macros (hook.foodMacros); CTA when none yet. */}
              <MacroMeter
                kcalGoal={kcalGoal}
                proteinGoal={proteinGoal}
                kcal={kcal}
                protein={protein}
                hasItems={!isEmpty}
              />
            </div>
          )}

          {budget != null && budget > 0 && (
            <div className="mt-3">
              {/* toPay is already the real payable total (after any coupon). */}
              <BudgetMeter
                budget={budget}
                spent={cart.toPay}
                onTrim={onTrim}
                disabled={sending}
              />
            </div>
          )}

          {/* one compact "Ready to order" row — the user still taps Place order */}
          <FoodCheckoutReady cart={cart} busy={busy} />

          {/* Quiet footer link */}
          <div className="mb-3 mt-4 flex items-center justify-between gap-2 border-t border-white/[0.06] pt-2.5">
            <button
              type="button"
              onClick={onClear}
              disabled={busy}
              className="py-1 text-xs text-white/45 transition-colors hover:text-white/85 disabled:opacity-40"
            >
              Clear order
            </button>
          </div>
        </div>
      )}

      {/* Sticky place-order bar — To pay (bill rows on tap) + Place order */}
      {!isEmpty && (
        <footer
          className={`shrink-0 border-t border-on-dark-soft/15 bg-[#131315] px-5 pb-4 pt-3 ${
            busy ? 'opacity-70' : ''
          }`}
        >
          {(overCap || unsynced) && (
            <div className="mb-2 space-y-0.5 text-[11px] leading-snug text-amber-300">
              {overCap && <p>Swiggy limits these orders to {inr(FOOD_ORDER_CAP)} — remove something to place it.</p>}
              {unsynced && <p>Prices aren&apos;t confirmed by Swiggy yet — the order can be placed once your cart syncs.</p>}
            </div>
          )}

          {/* Mini-bill */}
          {billOpen && (
            <dl className="mb-2 space-y-1 border-b border-on-dark-soft/15 pb-2 text-[13px]">
              <div className="flex items-center justify-between">
                <dt className="text-on-dark-soft">Item total</dt>
                <dd className="tabular-nums text-on-dark">{inr(cart.itemTotal)}</dd>
              </div>
              <div className="flex items-center justify-between">
                <dt className="text-on-dark-soft">Taxes &amp; charges</dt>
                <dd className="tabular-nums text-on-dark">{unsynced ? '—' : inr(cart.taxes)}</dd>
              </div>
              <div className="flex items-center justify-between">
                <dt className="text-on-dark-soft">Delivery</dt>
                <dd className="tabular-nums">
                  {unsynced ? (
                    <span className="text-on-dark-soft">—</span>
                  ) : freeDelivery ? (
                    <span className="font-medium uppercase tracking-wide text-accent-teal">
                      {cart.deliveryChargeStrikeoff ? (
                        <span className="mr-1.5 normal-case text-on-dark-soft line-through">{inr(cart.deliveryChargeStrikeoff)}</span>
                      ) : null}
                      Free
                    </span>
                  ) : (
                    <span className="text-on-dark">
                      {cart.deliveryChargeStrikeoff ? (
                        <span className="mr-1.5 text-on-dark-soft line-through">{inr(cart.deliveryChargeStrikeoff)}</span>
                      ) : null}
                      {inr(cart.deliveryCharge)}
                    </span>
                  )}
                </dd>
              </div>
              {applied && (
                <div className="flex items-center justify-between gap-3">
                  <dt className="min-w-0 truncate text-accent-teal">Coupon · {applied.code}</dt>
                  <dd className="shrink-0 tabular-nums text-accent-teal">−{inr(applied.savings)}</dd>
                </div>
              )}
            </dl>
          )}

          <div className="flex items-center justify-between gap-3">
            <div className="flex min-w-0 items-baseline gap-2">
              <span className="shrink-0 text-[13px] text-on-dark-soft">To pay{unsynced ? ' (not confirmed)' : ''}</span>
              <span className="font-display text-xl leading-none text-on-dark">{inr(cart.toPay)}</span>
              {applied && applied.savings > 0 && !billOpen && (
                <span className="truncate text-[11px] text-accent-teal">saved {inr(applied.savings)}</span>
              )}
            </div>
            <button
              type="button"
              onClick={() => setBillOpen((v) => !v)}
              aria-expanded={billOpen}
              className="inline-flex shrink-0 items-center gap-1 text-[12px] font-medium text-on-dark-soft hover:text-on-dark"
            >
              Bill details
              <Chevron open={billOpen} className="h-3 w-3" />
            </button>
          </div>

          <button
            type="button"
            onClick={onPlaceOrder}
            disabled={!canPlace}
            className="mt-2.5 w-full rounded-xl bg-gradient-to-r from-[#FF5200] via-[#FF6A3D] to-[#FF5200] px-4 py-3 text-sm font-bold text-white shadow-lg shadow-coral/25 transition-all hover:scale-[1.01] hover:shadow-coral/40 active:scale-[0.99] disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-40"
          >
            {busy ? 'Updating…' : `Place order · ${inr(cart.toPay)}`}
          </button>
        </footer>
      )}
    </div>
  );
}

export default FoodCartPanel;
