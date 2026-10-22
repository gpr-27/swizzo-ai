'use client';

// Dineout restaurant card — shows only what Swiggy returned
// (render_restaurants_dineout / get_restaurant_details): the restaurant's own
// photo, rating ★ with count, cuisines, cost for two, distance, area/locality,
// headline offer (badge logo + text, subtitle, "+N offers"), bank offers, the
// restaurant's own perks (vendorHighlights) and highlights. No stock photos, ratings or offers are invented — a
// restaurant without a photo first has its OFFICIAL photo backfilled
// (get_restaurant_details → imageUrl / masthead, via /api/images/restaurant,
// only once the card scrolls into view); only if Swiggy has none does it get a
// plain monogram tile. "View details" opens the details sheet; "Reserve" opens
// the live slot picker; "Compare" adds it to the side-by-side compare tray.

import { useRef, useState } from 'react';
import type { DineoutRestaurant } from '@/shared/types';
import { CompareToggle } from '@/frontend/components/features/DineoutCompare';
import { useRestaurantImage } from '@/frontend/utils/useRestaurantImage';
import { DINEOUT_WALK_IN_LABEL, useDineoutNoSlots } from '@/frontend/state/dineoutAvailability';
import { DineoutDetailsSheet } from './DineoutDetailsSheet';

export interface DineoutRestaurantCardProps {
  restaurant: DineoutRestaurant;
  /** autoPick: open the slot picker already filled with its best AI pick */
  onViewSlots?: (restaurant: DineoutRestaurant, opts?: { autoPick?: boolean }) => void;
  bestReason?: string;
}

/** Plain, clearly-not-a-photo tile for restaurants Swiggy has no image for. */
export function DineoutPlaceholder({ name, className = '' }: { name: string; className?: string }) {
  return (
    <div
      className={`flex h-full w-full flex-col items-center justify-center gap-1 bg-gradient-to-br from-surface-soft via-canvas to-surface-card text-muted-soft ${className}`}
      aria-hidden
    >
      <svg viewBox="0 0 24 24" className="h-7 w-7 opacity-60" fill="none" stroke="currentColor" strokeWidth={1.5}>
        <path d="M7 3v8m-2-8v5a2 2 0 0 0 4 0V3M7 11v10M17 21V3c-1.7 0-3 2.2-3 5v5h3" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      <span className="font-display text-2xl font-bold leading-none">{name.trim().charAt(0).toUpperCase()}</span>
    </div>
  );
}

/** "Koramangala" or "Nexus Koramangala Mall, Koramangala" — de-duplicated area/locality. */
export function dineoutPlace(r: Pick<DineoutRestaurant, 'area' | 'locality'>): string {
  const { area, locality } = r;
  if (area && locality && area.toLowerCase().includes(locality.toLowerCase())) return area;
  if (area && locality && locality.toLowerCase().includes(area.toLowerCase())) return locality;
  return [area, locality].filter(Boolean).join(', ');
}

export function DineoutRestaurantCard({ restaurant, onViewSlots, bestReason }: DineoutRestaurantCardProps) {
  const {
    name,
    cuisines,
    rating,
    ratingCount,
    costForTwo,
    distance,
    offers,
    offerDetails,
    offerHeadline,
    deals,
    imageUrl,
  } = restaurant;
  const [failedSrc, setFailedSrc] = useState<string[]>([]);
  const [detailsOpen, setDetailsOpen] = useState(false);
  // Swiggy lists it but takes no table bookings (partnerType "NPR"), or a live
  // slot fetch came back empty → no Reserve button, an honest badge instead.
  const noSlots = useDineoutNoSlots(restaurant.id);
  const walkIn = restaurant.bookable === false || noSlots;
  const cardRef = useRef<HTMLDivElement>(null);
  const ownOk = !!imageUrl && !failedSrc.includes(imageUrl);
  const backfill = useRestaurantImage(
    { kind: 'dineout', id: restaurant.id, lat: restaurant.latitude, lng: restaurant.longitude },
    !ownOk,
    cardRef,
  );
  const photo = ownOk ? imageUrl : backfill && !failedSrc.includes(backfill.imageUrl) ? backfill.imageUrl : '';
  const place = dineoutPlace(restaurant);
  const offer = offerHeadline
    ? {
        title: offerHeadline.title,
        sub: [offerHeadline.subtitle, offerHeadline.subtext].filter(Boolean).join(' · '),
        logo: offerHeadline.logoUrl,
        logoText: offerHeadline.logoText,
      }
    : deals?.[0] || offers?.[0]
      ? {
          title: (deals?.[0] || offers?.[0]) as string,
          sub: deals?.[0] ? '' : offerDetails?.[0]?.description ?? '',
          logo: undefined,
          logoText: undefined,
        }
      : null;
  return (
    <div
      ref={cardRef}
      className="group relative flex flex-col overflow-hidden rounded-xl border border-hairline bg-surface-card transition-all duration-200 hover:border-coral/40 hover:shadow-card"
    >
      {bestReason && (
        <div className="flex items-center gap-1.5 border-b border-coral/20 bg-coral/10 px-3 py-1 text-[11px] font-medium text-coral">
          <span>✦</span>
          <span className="truncate">{bestReason}</span>
        </div>
      )}

      {/* Photo (Swiggy's own) or a neutral monogram tile */}
      <div className="relative">
      <button
        type="button"
        onClick={() => setDetailsOpen(true)}
        className="relative block aspect-[2/1] w-full overflow-hidden bg-canvas text-left"
        aria-label={`View details for ${name}`}
      >
        {photo ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img decoding="async"
            key={photo}
            src={photo}
            alt={name}
            className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-105"
            loading="lazy"
            referrerPolicy="no-referrer"
            onError={() => setFailedSrc((f) => [...f, photo])}
          />
        ) : (
          <DineoutPlaceholder name={name} />
        )}
        <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/65 via-black/5 to-transparent" />

        {typeof rating === 'number' && rating > 0 ? (
          <div className="absolute right-2.5 top-2.5 flex items-center gap-1 rounded-md bg-black/70 px-2 py-0.5 text-xs font-semibold text-white backdrop-blur-sm">
            <span className="text-accent-amber">★</span>
            <span>{rating.toFixed(1)}</span>
            {ratingCount ? (
              <span className="font-normal opacity-75">({ratingCount.toLocaleString('en-IN')})</span>
            ) : null}
          </div>
        ) : (
          <div className="absolute right-2.5 top-2.5 rounded-md bg-black/60 px-2 py-0.5 text-[11px] font-medium text-white/90 backdrop-blur-sm">
            New
          </div>
        )}

        {offer && (
          <div className="absolute bottom-2 left-2.5 right-2.5 flex min-w-0 items-baseline gap-1.5 text-white">
            <span className="inline-flex shrink-0 items-center gap-1 rounded bg-coral px-1.5 py-0.5 text-[11px] font-bold shadow-xs">
              {offer.logo ? (
                // Swiggy's own offer badge (offerHeadline.logoUrl)
                // eslint-disable-next-line @next/next/no-img-element
                <img decoding="async" src={offer.logo} alt="" className="h-3.5 w-3.5 object-contain" loading="lazy" />
              ) : null}
              {offer.logoText ? (
                <span className="rounded-sm bg-white/25 px-1 text-[9px] font-extrabold tracking-wide">{offer.logoText}</span>
              ) : null}
              {offer.title}
            </span>
            {offer.sub && <span className="truncate text-[11px] font-medium text-white/85">{offer.sub}</span>}
          </div>
        )}
      </button>
        <div className="absolute left-2.5 top-2.5">
          <CompareToggle restaurant={photo && photo !== imageUrl ? { ...restaurant, imageUrl: photo } : restaurant} />
        </div>
      </div>

      {/* Details */}
      <div className="flex flex-1 flex-col p-3">
        <h3 className="line-clamp-1 font-display text-base font-bold text-ink">{name}</h3>
        {cuisines.length > 0 && <p className="mt-0.5 line-clamp-1 text-xs text-muted">{cuisines.join(' · ')}</p>}

        <div className="mt-2 flex items-center justify-between gap-2 text-xs text-muted-soft">
          <span className="truncate">{[place, distance].filter(Boolean).join(' · ')}</span>
          {costForTwo && <span className="shrink-0 font-medium text-body">{costForTwo}</span>}
        </div>

        {/* CTAs */}
        <div className="mt-auto flex gap-2 border-t border-hairline/60 pt-2.5">
          <button
            type="button"
            onClick={() => setDetailsOpen(true)}
            className="flex-1 rounded-lg border border-hairline py-2 text-xs font-semibold text-body transition-colors hover:border-coral/40 hover:text-ink"
          >
            View details
          </button>
          {walkIn ? (
            <span
              className="flex flex-1 items-center justify-center rounded-lg border border-dashed border-hairline px-2 py-1.5 text-center text-[10px] font-medium leading-tight text-muted"
              title="Swiggy lists this restaurant but doesn't take table reservations for it"
            >
              {DINEOUT_WALK_IN_LABEL}
            </span>
          ) : (
            <button
              type="button"
              disabled={!onViewSlots}
              onClick={() => onViewSlots?.(restaurant)}
              className="flex-1 rounded-lg bg-coral/10 py-2 text-xs font-semibold text-coral transition-colors hover:bg-coral hover:text-on-primary disabled:opacity-50"
            >
              Reserve →
            </button>
          )}
        </div>
      </div>

      {detailsOpen && (
        <DineoutDetailsSheet
          restaurant={photo && photo !== imageUrl ? { ...restaurant, imageUrl: photo } : restaurant}
          onClose={() => setDetailsOpen(false)}
          onReserve={
            onViewSlots && !walkIn
              ? (r, opts) => {
                  setDetailsOpen(false);
                  onViewSlots(r, opts);
                }
              : undefined
          }
        />
      )}
    </div>
  );
}

export default DineoutRestaurantCard;
