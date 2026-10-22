'use client';

// Dineout "View details" sheet — one get_restaurant_details call (via
// /api/dineout/details, cached server- and client-side) rendered as: masthead
// photo strip (every masthead photo), rating / cost / timings, address + map
// link, offers & deals with all their fields (% off, cover charge, offer group,
// category), bank offers, the restaurant's own perks, amenities and every menu
// image group Swiggy has. Only Swiggy's own data is shown.
// AI: an "AI read" panel (once details load) summarises every field Swiggy
// returned + a "Should I go?" line for the user's stated needs (one tool-free
// model call over this same data — /api/ai-read); "Book best slot" opens the
// slot picker pre-filled with its top AI pick (the user still confirms).
// Tap any photo or menu page for the full-screen gallery (Lightbox); a
// bill-split estimate uses Swiggy's cost for two; Share sends the restaurant.

import { useEffect, useRef, useState } from 'react';
import { useDialogA11y } from '@/frontend/hooks/useDialogA11y';
import { createPortal } from 'react-dom';
import type { DineoutOffer, DineoutRestaurant } from '@/shared/types';
import { BillSplit } from '@/frontend/components/features/BillSplit';
import { Lightbox, type LightboxImage } from '@/frontend/components/features/Lightbox';
import { directionsUrl } from '@/frontend/utils/maps';
import { shareOrCopy, whatsappUrl } from '@/frontend/utils/webShare';
import { DineoutPlaceholder, dineoutPlace } from './DineoutRestaurantCard';
import { DINEOUT_WALK_IN_LABEL, useDineoutNoSlots } from '@/frontend/state/dineoutAvailability';
import { currentNeeds } from '@/frontend/state/userNeeds';
import { dineoutFacts, dineoutFitLine, readNeeds } from '@/shared/aiRead';
import { AiReadPanel } from './AiReadPanel';

export interface DineoutDetailsSheetProps {
  restaurant: DineoutRestaurant;
  onClose: () => void;
  /** autoPick: open the slot picker already filled with its best AI pick */
  onReserve?: (restaurant: DineoutRestaurant, opts?: { autoPick?: boolean }) => void;
}

// Per-tab memo so re-opening a sheet never refetches.
const detailsMemo = new Map<string, DineoutRestaurant>();

type LoadState = { status: 'idle' | 'loading' | 'ready' } | { status: 'error'; message: string };

/** Search/render card + details: details win, but keep the card's rating count, headline offer and highlights. */
function merge(card: DineoutRestaurant, details: DineoutRestaurant): DineoutRestaurant {
  return {
    ...card,
    ...Object.fromEntries(Object.entries(details).filter(([, v]) => v !== undefined && !(Array.isArray(v) && v.length === 0))),
    rating: details.rating ?? card.rating,
    ratingCount: card.ratingCount ?? details.ratingCount,
    offerHeadline: card.offerHeadline,
    highlights: card.highlights,
    vendorHighlights: card.vendorHighlights ?? details.vendorHighlights,
    bankOffers: card.bankOffers ?? details.bankOffers,
    // details deals restate the card's short render offers ("Flat 15% off" →
    // "Flat 15% off on Total Bill"); keep the card's only when details has none.
    offerDetails: details.offerDetails ?? (details.dealDetails?.length ? undefined : card.offerDetails),
    distance: card.distance ?? details.distance,
    latitude: card.latitude ?? details.latitude,
    longitude: card.longitude ?? details.longitude,
  } as DineoutRestaurant;
}

export function DineoutDetailsSheet({ restaurant, onClose, onReserve }: DineoutDetailsSheetProps) {
  const memoKey = `${restaurant.id}|${restaurant.latitude}|${restaurant.longitude}`;
  const [data, setData] = useState<DineoutRestaurant>(() => {
    const memo = detailsMemo.get(memoKey);
    return memo ? merge(restaurant, memo) : restaurant;
  });
  const hasCoords = restaurant.latitude !== undefined && restaurant.longitude !== undefined;
  const needsFetch = !restaurant.hasDetails && !detailsMemo.has(memoKey);
  const [load, setLoad] = useState<LoadState>(() =>
    !needsFetch
      ? { status: 'ready' }
      : hasCoords
        ? { status: 'loading' }
        : { status: 'error', message: 'This restaurant has no search location to load details with.' },
  );

  useEffect(() => {
    if (!needsFetch || !hasCoords) return;
    const ctrl = new AbortController();
    const qs = new URLSearchParams({
      restaurantId: restaurant.id,
      lat: String(restaurant.latitude),
      lng: String(restaurant.longitude),
    });
    fetch(`/api/dineout/details?${qs.toString()}`, { signal: ctrl.signal })
      .then((res) => res.json().catch(() => ({})))
      .then((json) => {
        if (json?.ok && json.restaurant) {
          detailsMemo.set(memoKey, json.restaurant as DineoutRestaurant);
          setData(merge(restaurant, json.restaurant as DineoutRestaurant));
          setLoad({ status: 'ready' });
        } else {
          setLoad({ status: 'error', message: json?.message || 'Swiggy returned no details for this restaurant.' });
        }
      })
      .catch((err) => {
        if ((err as { name?: string })?.name === 'AbortError') return;
        setLoad({ status: 'error', message: 'Network error while loading details. Please try again.' });
      });
    return () => ctrl.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [memoKey, needsFetch, hasCoords]);

  const noSlots = useDineoutNoSlots(restaurant.id);
  const [gallery, setGallery] = useState<{ images: LightboxImage[]; index: number; title: string } | null>(null);
  // Focus in + Tab trap + focus return (Esc is handled below, gallery-first).
  // Paused while the photo lightbox (its own dialog) is open.
  const sheetRef = useRef<HTMLDivElement>(null);
  useDialogA11y(!gallery, sheetRef);
  const [splitGuests, setSplitGuests] = useState(2);
  const [shareNote, setShareNote] = useState('');

  // Esc closes (the gallery first, when open); lock page scroll while open.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && !gallery && onClose();
    document.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [onClose, gallery]);

  // Opened from a click, so this only renders in the browser.
  if (typeof document === 'undefined') return null;

  // The AI read: every real field, summarised (no review text exists on Swiggy).
  const read = dineoutFacts(data);
  const fitLine = dineoutFitLine(data, readNeeds(currentNeeds()));
  // Every photo Swiggy sent (lazy-loaded); the card photo leads when it isn't in the masthead.
  const masthead = data.mastheadImageUrls ?? [];
  const photos = data.imageUrl && !masthead.includes(data.imageUrl) ? [data.imageUrl, ...masthead] : masthead.length ? masthead : [];
  const place = dineoutPlace(data);
  const offerLines = [...(data.deals ?? []), ...(data.offers ?? [])].filter((o, i, a) => a.indexOf(o) === i);
  // Structured offers when we have them (all fields), else the plain lines.
  const offerItems: DineoutOffer[] = [...(data.dealDetails ?? []), ...(data.offerDetails ?? [])].filter(
    (o, i, a) => a.findIndex((x) => x.title === o.title && x.description === o.description) === i,
  );
  const offerGroups = new Map<string, DineoutOffer[]>();
  for (const o of offerItems) {
    const k = o.slotGroupName || '';
    offerGroups.set(k, [...(offerGroups.get(k) ?? []), o]);
  }
  const bank = (data.bankOffers ?? []).filter((b) => b !== data.offerHeadline?.title);
  const photoImages: LightboxImage[] = photos.map((src, i) => ({ src, alt: i === 0 ? data.name : `${data.name} photo ${i + 1}` }));
  const maps = directionsUrl({ mapUrl: data.locationMapUrl, name: data.name, address: data.address || place });
  const shareLines = [
    `🍽️ ${data.name}`,
    [data.rating ? `★ ${data.rating.toFixed(1)}` : '', data.costForTwo, data.cuisines.slice(0, 3).join(', ')].filter(Boolean).join(' · '),
    data.address || place,
    data.offerHeadline?.title || offerLines[0],
    maps,
    'On Swiggy Dineout',
  ].filter(Boolean);
  const share = async () => {
    const r = await shareOrCopy({ title: data.name, text: shareLines.join('\n') });
    if (r === 'copied') {
      setShareNote('Copied to clipboard');
      window.setTimeout(() => setShareNote(''), 2500);
    }
  };

  return createPortal(
    <div ref={sheetRef} className="fixed inset-0 z-[80] flex items-end justify-center sm:items-center" role="dialog" aria-modal="true" aria-label={data.name}>
      <button type="button" aria-label="Close details" tabIndex={-1} className="absolute inset-0 bg-black/50 backdrop-blur-[2px]" onClick={onClose} />
      <div className="relative flex max-h-[92vh] w-full max-w-xl flex-col overflow-hidden rounded-t-2xl border border-hairline bg-canvas shadow-card sm:rounded-2xl">
        {/* Photo strip */}
        <div className="relative h-52 shrink-0 bg-surface-card sm:h-60">
          {photos.length ? (
            <div className="flex h-full snap-x snap-mandatory overflow-x-auto">
              {photos.map((src, i) => (
                <button
                  key={src}
                  type="button"
                  onClick={() => setGallery({ images: photoImages, index: i, title: data.name })}
                  className="h-full w-full shrink-0 snap-center"
                  aria-label={`Open photo ${i + 1} of ${photos.length}`}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img decoding="async"
                    src={src}
                    alt={i === 0 ? data.name : `${data.name} photo ${i + 1}`}
                    className="h-full w-full object-cover"
                    loading={i === 0 ? 'eager' : 'lazy'}
                    referrerPolicy="no-referrer"
                  />
                </button>
              ))}
            </div>
          ) : (
            <DineoutPlaceholder name={data.name} />
          )}
          {photos.length > 1 && (
            <span className="absolute bottom-2 right-3 rounded-full bg-black/60 px-2 py-0.5 text-[10px] font-medium text-white">
              {photos.length} photos · tap to enlarge
            </span>
          )}
          <button
            type="button"
            onClick={onClose}
            className="absolute right-3 top-3 flex h-8 w-8 items-center justify-center rounded-full bg-black/60 text-white backdrop-blur-sm hover:bg-black/75"
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 pb-5 pt-4">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h2 className="font-display text-xl font-bold text-ink">{data.name}</h2>
              {data.cuisines.length > 0 && <p className="mt-0.5 text-xs text-muted">{data.cuisines.join(' · ')}</p>}
            </div>
            {typeof data.rating === 'number' && data.rating > 0 && (
              <div className="shrink-0 rounded-lg bg-success/10 px-2 py-1 text-center">
                <div className="text-sm font-bold text-success-ink">★ {data.rating.toFixed(1)}</div>
                {data.ratingCount ? (
                  <div className="text-[10px] text-muted">{data.ratingCount.toLocaleString('en-IN')} ratings</div>
                ) : null}
              </div>
            )}
          </div>

          {load.status !== 'loading' && (
            <div className="mt-3">
              <AiReadPanel
                kind="dineout"
                cacheKey={`${memoKey}|${data.hasDetails ? 'd' : 'c'}`}
                summary={read.summary}
                facts={read.facts}
                fallbackFit={fitLine}
              />
            </div>
          )}

          <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-body">
            {data.costForTwo && <span>{data.costForTwo}</span>}
            {data.timings && <span>🕒 {data.timings}</span>}
            {data.distance && <span>{data.distance} away</span>}
          </div>

          {(data.address || place) && (
            <div className="mt-3 rounded-xl border border-hairline bg-surface-card/60 p-3 text-xs">
              <div className="text-body">{data.address || place}</div>
              <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1">
                {maps && (
                  <a href={maps} target="_blank" rel="noopener noreferrer" className="font-semibold text-coral hover:underline">
                    🧭 Directions in Google Maps ↗
                  </a>
                )}
                <button type="button" onClick={share} className="font-semibold text-muted hover:text-ink">
                  ↗ Share
                </button>
                <a
                  href={whatsappUrl(shareLines.join('\n'))}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="font-semibold text-muted hover:text-ink"
                >
                  💬 WhatsApp
                </a>
                {shareNote && <span className="text-emerald-700 dark:text-emerald-400">{shareNote}</span>}
              </div>
            </div>
          )}

          {data.costForTwo && (
            <section className="mt-4">
              <div className="flex items-center justify-between gap-2">
                <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-soft">Split the bill</h3>
                <div className="flex items-center gap-1 text-[11px] text-muted">
                  <span>Guests</span>
                  <button
                    type="button"
                    aria-label="Fewer guests"
                    disabled={splitGuests <= 1}
                    onClick={() => setSplitGuests((n) => Math.max(1, n - 1))}
                    className="h-6 w-6 rounded-md border border-hairline text-ink disabled:opacity-30"
                  >
                    −
                  </button>
                  <span className="w-5 text-center font-semibold text-ink">{splitGuests}</span>
                  <button
                    type="button"
                    aria-label="More guests"
                    disabled={splitGuests >= 20}
                    onClick={() => setSplitGuests((n) => Math.min(20, n + 1))}
                    className="h-6 w-6 rounded-md border border-hairline text-ink disabled:opacity-30"
                  >
                    +
                  </button>
                </div>
              </div>
              <div className="mt-2">
                <BillSplit kind="dineout" costForTwo={data.costForTwo} guests={splitGuests} />
              </div>
            </section>
          )}

          {load.status === 'loading' && (
            <div className="mt-4 space-y-2" aria-live="polite">
              <div className="h-3 w-2/3 animate-pulse rounded bg-surface-card" />
              <div className="h-3 w-1/2 animate-pulse rounded bg-surface-card" />
              <div className="h-16 w-full animate-pulse rounded-xl bg-surface-card" />
            </div>
          )}
          {load.status === 'error' && (
            <div className="mt-4 rounded-xl border border-error/30 bg-error/5 px-3 py-2 text-xs text-error">{load.message}</div>
          )}

          {(data.offerHeadline || offerLines.length > 0 || offerItems.length > 0 || bank.length > 0) && (
            <section className="mt-4">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-soft">Offers</h3>
              <ul className="mt-2 space-y-1.5">
                {data.offerHeadline && (
                  <li className="flex flex-wrap items-center gap-x-2 gap-y-0.5 rounded-lg bg-coral/10 px-3 py-2 text-xs font-semibold text-coral">
                    {data.offerHeadline.logoUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img decoding="async" src={data.offerHeadline.logoUrl} alt="" className="h-4 w-4 object-contain" loading="lazy" />
                    ) : null}
                    {data.offerHeadline.logoText ? (
                      <span className="rounded bg-coral px-1 text-[9px] font-extrabold tracking-wide text-on-primary">
                        {data.offerHeadline.logoText}
                      </span>
                    ) : null}
                    <span>
                      {data.offerHeadline.title}
                      {data.offerHeadline.subtitle ? <span className="font-normal"> {data.offerHeadline.subtitle}</span> : null}
                    </span>
                    {data.offerHeadline.subtext ? (
                      <span className="ml-auto text-[11px] font-medium text-coral/80">{data.offerHeadline.subtext}</span>
                    ) : null}
                  </li>
                )}
                {offerItems.length > 0
                  ? [...offerGroups].map(([group, items]) => (
                      <li key={group || 'offers'} className="space-y-1.5">
                        {group && <div className="pt-1 text-[11px] font-medium text-muted">{group}</div>}
                        {items.map((o) => (
                          <div key={`${o.title}|${o.description ?? ''}`} className="rounded-lg border border-hairline px-3 py-2 text-xs">
                            <div className="flex items-start justify-between gap-2">
                              <span className="font-semibold text-ink">{o.title}</span>
                              {o.discountPercentage ? (
                                <span className="shrink-0 rounded bg-success/10 px-1.5 py-0.5 text-[10px] font-bold text-success-ink">
                                  {o.discountPercentage}% off
                                </span>
                              ) : null}
                            </div>
                            <div className="mt-0.5 flex flex-wrap gap-x-3 text-[11px] text-muted">
                              {o.description && <span>{o.description}</span>}
                              {o.coverCharge !== undefined && (
                                <span>{o.coverCharge > 0 ? `₹${o.coverCharge.toLocaleString('en-IN')} cover charge` : 'No cover charge'}</span>
                              )}
                              {o.offerCategory && <span className="capitalize">{o.offerCategory.replace(/[_-]+/g, ' ')}</span>}
                            </div>
                          </div>
                        ))}
                      </li>
                    ))
                  : offerLines.map((o) => (
                      <li key={o} className="rounded-lg border border-hairline px-3 py-2 text-xs text-body">
                        {o}
                      </li>
                    ))}
                {bank.map((b) => (
                  <li key={`bank-${b}`} className="rounded-lg border border-dashed border-coral/40 px-3 py-2 text-xs text-body">
                    🏦 Bank offer · {b}
                  </li>
                ))}
              </ul>
            </section>
          )}

          {data.vendorHighlights?.length ? (
            <section className="mt-4">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-soft">Perks</h3>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {data.vendorHighlights.map((v) => (
                  <span key={v} className="rounded-full border border-coral/30 bg-coral/10 px-2.5 py-1 text-[11px] font-medium text-coral">
                    🎁 {v}
                  </span>
                ))}
              </div>
            </section>
          ) : null}

          {(data.amenities?.length || data.highlights?.length) ? (
            <section className="mt-4">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-soft">Amenities</h3>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {/* details amenities + the card's highlights (e.g. "Pure veg"), de-duplicated */}
                {[...new Set([...(data.amenities ?? []), ...(data.highlights ?? [])])].map((a) => (
                  <span key={a} className="rounded-full border border-hairline bg-surface-card/60 px-2.5 py-1 text-[11px] text-body">
                    {a}
                  </span>
                ))}
              </div>
            </section>
          ) : null}

          {data.menuImageGroups?.length ? (
            <section className="mt-4">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-soft">Menu</h3>
              <div className="mt-2 space-y-3">
                {data.menuImageGroups.map((grp) => (
                  <div key={grp.title}>
                    <div className="text-[11px] font-medium text-muted">{grp.title}</div>
                    <div className="mt-1.5 flex gap-2 overflow-x-auto pb-1">
                      {grp.images.map((im, i) => (
                        <button
                          key={im.imageUrl}
                          type="button"
                          onClick={() =>
                            setGallery({
                              images: grp.images.map((g, j) => ({
                                src: g.imageUrl,
                                alt: g.label || `Menu page ${j + 1}`,
                                caption: g.label,
                              })),
                              index: i,
                              title: `${data.name} · ${grp.title}`,
                            })
                          }
                          className="block h-28 w-20 shrink-0 overflow-hidden rounded-lg border border-hairline bg-surface-card"
                          title={im.label}
                          aria-label={`Open ${grp.title} ${im.label || `page ${i + 1}`}`}
                        >
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img decoding="async" src={im.imageUrl} alt={im.label || 'Menu page'} className="h-full w-full object-cover" loading="lazy" referrerPolicy="no-referrer" />
                        </button>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </section>
          ) : null}
        </div>

        {(data.bookable === false || noSlots) ? (
          <div className="shrink-0 border-t border-hairline bg-canvas px-5 py-3">
            <div className="w-full rounded-xl border border-dashed border-hairline py-3 text-center text-xs font-medium text-muted">
              {DINEOUT_WALK_IN_LABEL}
            </div>
          </div>
        ) : onReserve && (
          <div className="shrink-0 border-t border-hairline bg-canvas px-5 py-3">
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => onReserve(data, { autoPick: true })}
                className="flex-1 rounded-xl bg-coral py-3 text-sm font-semibold text-on-primary shadow-xs transition-colors hover:bg-coral-active"
                title="Opens the slot picker with the best open slot already selected — you still confirm"
              >
                ✦ Book best slot
              </button>
              <button
                type="button"
                onClick={() => onReserve(data)}
                className="flex-1 rounded-xl border border-coral/40 py-3 text-sm font-semibold text-coral transition-colors hover:bg-coral/10"
              >
                Pick a time
              </button>
            </div>
          </div>
        )}
      </div>
      {gallery && (
        <Lightbox images={gallery.images} startIndex={gallery.index} title={gallery.title} onClose={() => setGallery(null)} />
      )}
    </div>,
    document.body,
  );
}

export default DineoutDetailsSheet;
