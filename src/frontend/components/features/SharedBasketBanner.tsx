'use client';

// When the page is opened via a shared-basket link (`?basket=…`), this banner
// slides in over the conversation to ask before loading someone else's basket
// into the cart — never silent. Shows what's inside (service, item count, a few
// names) so the user knows what they're accepting.

import type { DecodedBasket } from '@/frontend/utils/share';

export function SharedBasketBanner({
  basket,
  onLoad,
  onDismiss,
}: {
  basket: DecodedBasket;
  onLoad: () => void;
  onDismiss: () => void;
}) {
  const names = basket.items
    .map((i) => i.name)
    .filter(Boolean)
    .slice(0, 3)
    .join(', ');
  const more = basket.count - Math.min(3, basket.items.length);
  const serviceLabel = basket.service === 'food' ? 'Food' : 'Instamart';
  const where =
    basket.service === 'food' && basket.restaurantName
      ? ` from ${basket.restaurantName}`
      : '';

  return (
    <div className="pointer-events-none absolute inset-x-0 top-0 z-20 flex justify-center px-4 pt-3">
      <div
        role="region"
        aria-label="Shared basket"
        aria-live="polite"
        className="pointer-events-auto w-full max-w-xl animate-rise overflow-hidden rounded-xl border border-hairline bg-canvas shadow-card"
      >
        <div className="flex items-start gap-3 px-4 py-3.5">
          <span className="mt-0.5 inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-coral/10 text-coral">
            <svg
              viewBox="0 0 24 24"
              className="h-5 w-5"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.7"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M2.5 7h19l-1.7 9.2a2 2 0 0 1-2 1.8H6.2a2 2 0 0 1-2-1.8L2.5 7Z" />
              <path d="M8 7l2-3.5M16 7l-2-3.5" />
            </svg>
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-ink">
              A shared {serviceLabel} basket is ready
            </p>
            <p className="mt-0.5 truncate text-xs text-muted-soft">
              {basket.count} {basket.count === 1 ? 'item' : 'items'}
              {where}
              {names ? ` · ${names}` : ''}
              {more > 0 ? ` +${more} more` : ''}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2 border-t border-hairline px-4 py-2.5">
          <button
            type="button"
            onClick={onLoad}
            className="rounded-md bg-coral px-4 py-2 text-sm font-medium text-on-primary transition-colors hover:bg-coral-active"
          >
            Load this basket
          </button>
          <button
            type="button"
            onClick={onDismiss}
            className="rounded-md px-3 py-2 text-sm text-muted transition-colors hover:text-ink"
          >
            Dismiss
          </button>
          <span className="ml-auto text-[11px] text-muted-soft">
            Replaces your current cart
          </span>
        </div>
      </div>
    </div>
  );
}

export default SharedBasketBanner;
