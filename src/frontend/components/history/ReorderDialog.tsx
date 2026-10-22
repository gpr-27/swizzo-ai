'use client';

// Confirm before a past Food order replaces the Food cart. Lists the real
// lines from the order's reorderMeta (name, variant, quantity, order-time
// price) and warns when it will replace a cart from another restaurant. Swiggy
// re-prices and re-checks availability once the cart syncs — we say so.

import { useRef } from 'react';
import { useDialogA11y } from '@/frontend/hooks/useDialogA11y';
import type { HistoryOrder } from '@/backend/history/history-map';

export interface ReorderDialogProps {
  order: HistoryOrder;
  images: Record<string, string>;
  currentCart: { restaurantName: string | null; itemCount: number };
  onConfirm: () => void;
  onCancel: () => void;
}

const inr = (n: number) => `₹${Math.round(n).toLocaleString('en-IN')}`;

export function ReorderDialog({ order, images, currentCart, onConfirm, onCancel }: ReorderDialogProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  useDialogA11y(true, panelRef, onCancel);
  const items = order.reorder?.items ?? [];
  const sameRestaurant =
    !!currentCart.restaurantName &&
    currentCart.restaurantName.trim().toLowerCase() === order.title.trim().toLowerCase();
  const replaces = currentCart.itemCount > 0;
  const estimate = items.reduce((s, i) => s + i.unitPrice * i.quantity, 0);

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center">
      <button
        type="button"
        aria-label="Close"
        tabIndex={-1}
        onClick={onCancel}
        className="absolute inset-0 bg-black/45 backdrop-blur-[1px]"
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="reorder-title"
        tabIndex={-1}
        className="relative z-10 max-h-[85dvh] w-full max-w-md overflow-y-auto rounded-t-3xl border border-hairline bg-canvas p-5 shadow-xl animate-rise sm:rounded-3xl"
      >
        <h2 id="reorder-title" className="font-display text-xl text-ink">
          Reorder from {order.title}?
        </h2>
        <p className="mt-1 text-xs text-muted">
          {[order.area, order.placedAt && `ordered ${order.placedAt}`].filter(Boolean).join(' · ')}
        </p>

        <ul className="mt-4 divide-y divide-hairline rounded-2xl border border-hairline bg-surface-card/60">
          {items.map((it) => {
            const img = images[it.name.toLowerCase()];
            const sub = [...it.variants.map((v) => v.name), ...it.addons.map((a) => a.name)].filter(Boolean).join(' · ');
            return (
              <li key={`${it.itemId}-${sub}`} className="flex items-center gap-3 px-3 py-2.5">
                {img ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img decoding="async" src={img} alt="" className="h-10 w-10 shrink-0 rounded-lg bg-surface-soft object-cover" />
                ) : (
                  <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-surface-soft text-sm" aria-hidden="true">
                    🍽️
                  </span>
                )}
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-ink">
                    {it.veg !== null && (
                      <span
                        role="img"
                        aria-label={it.veg ? 'Veg' : 'Non-veg'}
                        className={`mr-1.5 inline-block h-2 w-2 rounded-full align-middle ${it.veg ? 'bg-emerald-500' : 'bg-red-500'}`}
                      />
                    )}
                    {it.name}
                  </p>
                  {sub && <p className="text-[11px] text-muted">{sub}</p>}
                </div>
                <div className="shrink-0 text-right text-xs">
                  <p className="font-semibold text-ink">× {it.quantity}</p>
                  {it.unitPrice > 0 && <p className="tabular-nums text-muted">{inr(it.unitPrice * it.quantity)}</p>}
                </div>
              </li>
            );
          })}
        </ul>

        <p className="mt-3 text-[11px] leading-relaxed text-muted">
          {estimate > 0 && <>About {inr(estimate)} at the old prices, before fees. </>}
          Swiggy re-checks prices and availability in your cart — nothing is ordered until you check out.
        </p>
        {replaces && (
          <p className="mt-2 rounded-xl border border-amber-500/30 bg-amber-500/5 p-2.5 text-xs text-body" role="note">
            {sameRestaurant
              ? `This replaces the ${currentCart.itemCount} item${currentCart.itemCount === 1 ? '' : 's'} in your Food cart.`
              : `This replaces your Food cart from ${currentCart.restaurantName || 'another restaurant'} (${currentCart.itemCount} item${currentCart.itemCount === 1 ? '' : 's'}) — a Swiggy cart holds one restaurant.`}
          </p>
        )}

        <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-full border border-hairline px-4 py-2.5 text-sm font-semibold text-body hover:text-ink"
          >
            Not now
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className="rounded-full bg-coral px-5 py-2.5 text-sm font-semibold text-on-primary shadow-sm hover:bg-coral-active"
          >
            Add {items.reduce((n, i) => n + i.quantity, 0)} item{items.length === 1 && items[0].quantity === 1 ? '' : 's'} to cart
          </button>
        </div>
      </div>
    </div>
  );
}

export default ReorderDialog;
