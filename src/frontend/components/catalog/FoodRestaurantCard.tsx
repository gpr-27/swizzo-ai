'use client';

// A restaurant as an editorial feature card for the Food service: a photographic
// hero tile (with a graceful monogram fallback), a serif name, the cuisines line,
// a compact chip row (rating · distance · ETA — only what Swiggy returned) and an
// optional offer flag, cost for two, area, and an "Ad" tag on Swiggy's promoted
// listings (name suffixed "(Ad)" in search_restaurants). Restaurants Swiggy reports CLOSED / UNAVAILABLE are dimmed
// with a badge (and next opening time) and a disabled CTA; far restaurants
// (> 5 km) get their distance called out. The single coral "View menu" button
// delegates to the parent via onViewMenu(restaurant). A card without a photo
// (or whose photo fails) backfills Swiggy's own restaurant image
// (get_restaurant_menu → restaurant.imageUrl, via /api/images/restaurant) once
// it scrolls into view; the monogram shows only when Swiggy has none.

import { useRef, useState, type ReactNode } from 'react';
import { useRestaurantImage } from '@/frontend/utils/useRestaurantImage';
import type { FoodRestaurantCardProps } from '@/shared/types';
import { FOOD_FAR_KM } from '@/shared/types';
import { Badge } from '../navigation/Badge';

export function FoodRestaurantCard({
  restaurant,
  onViewMenu,
}: FoodRestaurantCardProps) {
  const [failedSrc, setFailedSrc] = useState<string[]>([]);
  const cardRef = useRef<HTMLElement>(null);
  const ownOk = !!restaurant.imageUrl && !failedSrc.includes(restaurant.imageUrl);
  const backfill = useRestaurantImage({ kind: 'food', id: restaurant.id }, !ownOk && !!restaurant.id, cardRef);
  const photo = ownOk
    ? restaurant.imageUrl
    : backfill && !failedSrc.includes(backfill.imageUrl)
      ? backfill.imageUrl
      : '';

  const monogram = (restaurant.name || '?').trim().charAt(0).toUpperCase();
  const cuisines = restaurant.cuisines.join(' · ');
  const goodRating = restaurant.rating >= 4;
  const hasOffer = restaurant.offer.trim().length > 0;
  const closed = !restaurant.isOpen;
  const closedLabel = restaurant.availability === 'UNAVAILABLE' ? 'Unavailable' : 'Closed';
  const far = restaurant.distanceKm > FOOD_FAR_KM;
  const chips: { key: string; node: ReactNode }[] = [];
  if (restaurant.rating > 0) {
    chips.push({
      key: 'rating',
      node: (
        <span
          className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-medium ${
            goodRating ? 'bg-success/15 text-success-ink' : 'bg-surface-card text-body'
          }`}
        >
          <span aria-hidden="true">★</span>
          {restaurant.rating.toFixed(1)}
          {restaurant.ratingCount && (
            <span className="font-normal">({restaurant.ratingCount})</span>
          )}
        </span>
      ),
    });
  }
  if (restaurant.distanceKm > 0) {
    chips.push({
      key: 'distance',
      node: (
        <span className={far ? 'font-medium text-coral' : 'text-muted'}>
          {restaurant.distanceKm} km{far ? ' away' : ''}
        </span>
      ),
    });
  }
  if (restaurant.etaRange) {
    chips.push({ key: 'eta', node: <span className="text-muted">{restaurant.etaRange}</span> });
  }
  if (restaurant.costForTwo) {
    chips.push({ key: 'cost', node: <span className="text-muted">{restaurant.costForTwo}</span> });
  }

  return (
    <article
      ref={cardRef}
      className={`group flex h-full animate-rise flex-col overflow-hidden rounded-lg border border-hairline bg-canvas transition-all duration-200 hover:-translate-y-0.5 hover:border-cream-strong hover:shadow-card ${
        closed ? 'opacity-75' : ''
      }`}
    >
      {/* Hero tile */}
      <div className="relative aspect-[16/10] overflow-hidden border-b border-hairline bg-surface-soft">
        {photo ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img decoding="async"
            key={photo}
            src={photo}
            alt={restaurant.name}
            loading="lazy"
            onError={() => setFailedSrc((f) => [...f, photo])}
            className={`h-full w-full object-cover ${closed ? 'grayscale' : ''}`}
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center">
            <span className="font-display text-4xl text-muted-soft">{monogram}</span>
          </div>
        )}

        {hasOffer && (
          <Badge tone="amber" className="absolute bottom-2 left-2 shadow-soft">
            {restaurant.offer}
          </Badge>
        )}

        {/* Swiggy marks promoted listings "(Ad)" — disclosed, never hidden */}
        {restaurant.sponsored && (
          <span
            className="absolute right-2 top-2 rounded-full bg-canvas/90 px-2 py-0.5 text-[10px] font-medium text-muted shadow-soft"
            title="Promoted listing on Swiggy"
          >
            Ad
          </span>
        )}
        {restaurant.veg && (
          <span className="absolute left-2 top-2 rounded-full bg-success/90 px-2 py-0.5 text-[10px] font-semibold text-white shadow-soft">
            Pure veg
          </span>
        )}

        {closed && (
          <div className="absolute inset-0 flex items-center justify-center bg-canvas/45">
            <span className="rounded-full bg-dark/85 px-3 py-1 text-[11px] font-medium uppercase tracking-wide text-on-dark">
              {closedLabel}
            </span>
          </div>
        )}
      </div>

      {/* Body */}
      <div className="flex flex-1 flex-col p-4">
        <h3 className="line-clamp-1 font-display text-lg leading-tight text-ink">
          {restaurant.name}
        </h3>

        {cuisines && (
          <p className="mt-0.5 line-clamp-1 text-[13px] text-muted">{cuisines}</p>
        )}
        {restaurant.area && (
          <p className="mt-0.5 line-clamp-1 text-[12px] text-muted-soft">{restaurant.area}</p>
        )}

        {/* Chip row: rating · distance · ETA */}
        {chips.length > 0 && (
          <div className="mt-2.5 flex flex-wrap items-center gap-x-2 gap-y-1.5 text-xs">
            {chips.map((c, i) => (
              <span key={c.key} className="inline-flex items-center gap-2">
                {i > 0 && (
                  <span className="text-muted-soft" aria-hidden="true">·</span>
                )}
                {c.node}
              </span>
            ))}
          </div>
        )}

        {closed && restaurant.nextOpenTime && (
          <p className="mt-1.5 text-[12px] text-muted">Opens {restaurant.nextOpenTime}</p>
        )}

        {/* CTA */}
        <div className="mt-auto pt-4">
          <button
            type="button"
            onClick={() => onViewMenu(restaurant)}
            disabled={closed}
            className="w-full rounded-md bg-coral px-4 py-2.5 text-sm font-medium text-on-primary transition-colors hover:bg-coral-active active:bg-coral-active disabled:cursor-not-allowed disabled:bg-coral-disabled disabled:text-muted-soft"
          >
            {closed ? `Currently ${closedLabel.toLowerCase()}` : 'View menu'}
          </button>
        </div>
      </div>
    </article>
  );
}

export default FoodRestaurantCard;
