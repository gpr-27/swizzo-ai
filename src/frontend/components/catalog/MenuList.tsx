'use client';

// The restaurant menu, rendered as a framed cream card inside the chat thread.
// A serif "Menu · {name}" header, then one section per category (a quiet
// uppercase caption) of menu item rows. Each row shows the veg/non-veg marker,
// name, an optional rating chip and Bestseller flag, a clamped description, the
// serif price and a coral Add control (which becomes a "✓ n" chip once in cart).
//
// Like the Instamart product grid, each category shows only a focused first few
// dishes with a per-section "Load more" that reveals the next few — a pure
// client-side reveal over the already-fetched menu, never a wall of every dish.

import { useState } from 'react';
import type { FoodCartSelection, FoodRestaurant, MenuItem, MenuListProps } from '@/shared/types';
import { Badge } from '../navigation/Badge';
import { DetailSheet } from '@/frontend/components/features/DetailSheet';
import { Lightbox } from '@/frontend/components/features/Lightbox';
import { FoodCustomizer, hasCustomOptions } from './FoodCustomizer';
import { MenuAiRead } from './MenuAiRead';

// A focused 2–3 picks up front per category, expanding a few at a time.
const INITIAL_ITEMS = 3;
const STEP = 3;

function inr(n: number): string {
  return `₹${Math.round(n).toLocaleString('en-IN')}`;
}

// Some Swiggy dish descriptions state nutrition, e.g.
// "[Energy: 303.22 kcal, Protein: 10.18g, Carbohydrates: 58.09g, Fat: 2.87g]".
function parseMacros(
  desc?: string,
): { kcal?: number; protein?: number } | null {
  if (!desc) return null;
  const kcal = desc.match(/([\d.]+)\s*k?cal/i);
  const protein = desc.match(/protein[:\s]+([\d.]+)\s*g/i);
  if (!kcal && !protein) return null;
  return {
    kcal: kcal ? Math.round(Number(kcal[1])) : undefined,
    protein: protein ? Math.round(Number(protein[1])) : undefined,
  };
}

function cleanDesc(desc?: string): string {
  if (!desc) return '';
  // Drop the nutrition bracket; the macros render as their own chip.
  return desc.replace(/\[[^\]]*(?:kcal|energy|protein|carb|fat)[^\]]*\]/gi, '').trim();
}

function Sparkle({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="currentColor" aria-hidden="true">
      <path d="M12 1.5c.55 5.3 4.7 9.45 10 10-5.3.55-9.45 4.7-10 10-.55-5.3-4.7-9.45-10-10 5.3-.55 9.45-4.7 10-10Z" />
    </svg>
  );
}

// Classic Indian veg / non-veg square: coloured border with a centred dot.
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

// The restaurant header from get_restaurant_menu `restaurant{}`: Swiggy's photo,
// rating (+ count), delivery SLA, cost for two, cuisines, area/city and address,
// plus open/closed. Only fields Swiggy returned are shown.
function RestaurantHeader({ r, totalCategories }: { r: FoodRestaurant; totalCategories?: number }) {
  const [broken, setBroken] = useState(false);
  const facts = [
    r.rating > 0 ? `★ ${r.rating.toFixed(1)}${r.ratingCount ? ` (${r.ratingCount})` : ''}` : '',
    r.etaRange,
    r.distanceKm > 0 ? `${r.distanceKm} km` : '',
    r.costForTwo,
  ].filter(Boolean);
  const place = [r.area, r.city].filter(Boolean).join(', ');
  return (
    <div className="mb-3 flex gap-3 rounded-xl border border-hairline/70 bg-surface-soft/40 p-3">
      {r.imageUrl && !broken && (
        // eslint-disable-next-line @next/next/no-img-element
        <img decoding="async"
          src={r.imageUrl}
          alt={r.name}
          loading="lazy"
          onError={() => setBroken(true)}
          className="h-16 w-16 shrink-0 rounded-lg object-cover"
        />
      )}
      <div className="min-w-0 flex-1 text-xs">
        <div className="flex flex-wrap items-center gap-1.5">
          {r.availability === 'CLOSED' || r.availability === 'UNAVAILABLE' ? (
            <span className="rounded-full bg-dark/80 px-2 py-0.5 text-[10px] font-semibold uppercase text-on-dark">Closed now</span>
          ) : r.availability === 'OPEN' ? (
            <span className="rounded-full bg-success/15 px-2 py-0.5 text-[10px] font-semibold uppercase text-success-ink">Open</span>
          ) : null}
          {r.sponsored && (
            <span className="rounded-full border border-hairline px-1.5 py-0.5 text-[10px] text-muted" title="Promoted listing on Swiggy">
              Ad
            </span>
          )}
          {facts.length > 0 && <span className="text-body">{facts.join(' · ')}</span>}
        </div>
        {r.cuisines.length > 0 && <p className="mt-1 line-clamp-1 text-muted">{r.cuisines.join(' · ')}</p>}
        {(place || r.address) && (
          <p className="mt-0.5 line-clamp-2 text-[11px] text-muted-soft" title={r.address}>
            {r.address || place}
          </p>
        )}
        {totalCategories ? (
          <p className="mt-0.5 text-[11px] text-muted-soft">{totalCategories} menu categories</p>
        ) : null}
      </div>
    </div>
  );
}

function MenuItemCard({
  item,
  qty,
  onAdd,
  best,
  healthy,
  warn,
  picked,
  onToggleCompare,
  showRestaurant,
}: {
  item: MenuItem;
  qty: number;
  onAdd: (item: MenuItem, selection?: FoodCartSelection) => void;
  best?: string;
  healthy?: string;
  warn?: string;
  picked?: boolean;
  onToggleCompare?: (item: MenuItem) => void;
  showRestaurant?: boolean;
}) {
  const [imgBroken, setImgBroken] = useState(false);
  // customisable dishes open the variant / add-on picker instead of adding as-is
  const [customizing, setCustomizing] = useState(false);
  // tap the dish photo → full-screen zoom (Swiggy's own image, larger rendition)
  const [zoom, setZoom] = useState(false);
  // tap the dish name → popup with the full AI read, description and macros
  const [details, setDetails] = useState(false);

  const monogram = (item.name || '?').trim().charAt(0).toUpperCase();
  // flagged customisable AND (options not loaded yet, or Swiggy actually lists some);
  // a dish whose options came back empty adds straight to the cart
  const customisable =
    (item.hasVariants || item.hasAddons) && (!item.customization || hasCustomOptions(item.customization));
  const handleAdd = () => (customisable ? setCustomizing(true) : onAdd(item));
  const available = item.inStock;
  const macros = parseMacros(item.description);
  const desc = cleanDesc(item.description);

  return (
    <div
      className={`group relative flex gap-3 rounded-2xl border p-3 transition-all duration-300 sm:gap-4 sm:p-4 ${
        available
          ? 'border-hairline/80 bg-canvas hover:border-coral/40 hover:shadow-card hover:-translate-y-0.5'
          : 'border-hairline/40 bg-surface-soft/40 opacity-60'
      } ${
        best !== undefined
          ? 'ring-1 ring-coral/30 bg-coral/[0.02]'
          : picked
            ? 'ring-1 ring-coral/40 bg-coral/[0.04]'
            : ''
      }`}
    >
      {/* Details */}
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <VegMark veg={item.veg} />
          {item.bestseller && (
            <span className="inline-flex items-center gap-1 rounded-md bg-amber-500/10 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-amber-800 dark:text-amber-400 border border-amber-500/20">
              Bestseller
            </span>
          )}
          {showRestaurant && item.restaurantName && (
            <span className="inline-flex items-center gap-1 rounded-md bg-surface-soft px-2 py-0.5 text-[11px] font-medium text-ink/80 border border-hairline/60">
              <span className="text-coral">🏪</span> {item.restaurantName}
            </span>
          )}
        </div>

        <h4 className="mt-1.5 text-[15px] font-semibold leading-snug text-ink group-hover:text-coral transition-colors">
          <button type="button" onClick={() => setDetails(true)} aria-haspopup="dialog" className="line-clamp-2 w-full text-left">
            {item.name}
          </button>
        </h4>

        {warn !== undefined ? (
          <div className="mt-1 flex items-start gap-1 text-[11px] font-medium text-error">
            <span aria-hidden="true">⚠</span>
            <span className="min-w-0 truncate">Heads up{warn ? ` — ${warn}` : ''}</span>
          </div>
        ) : (
          <>
            {best !== undefined && (
              <div className="mt-1 flex items-start gap-1 text-[11px] font-semibold text-coral">
                <span aria-hidden="true">✦</span>
                <span className="min-w-0 truncate">Best pick{best ? ` — ${best}` : ''}</span>
              </div>
            )}
            {healthy !== undefined && (
              <div className="mt-1 flex items-start gap-1 text-[11px] font-semibold text-success-ink">
                <span aria-hidden="true">🥗</span>
                <span className="min-w-0 truncate">Healthiest{healthy ? ` — ${healthy}` : ''}</span>
              </div>
            )}
          </>
        )}

        <div className="mt-2 flex flex-wrap items-center gap-2">
          <span className="font-display text-base font-bold text-ink">
            {inr(item.price)}
          </span>

          {item.rating && (
            <span className="inline-flex items-center gap-1 rounded-full bg-success/15 px-2 py-0.5 text-xs font-bold text-success-ink">
              <span aria-hidden="true">★</span>
              {item.rating}
              {item.ratingCount && (
                <span className="font-normal opacity-70" title={`${item.ratingCount} ratings on Swiggy`}>
                  ({item.ratingCount})
                </span>
              )}
            </span>
          )}
          {item.category && (
            <span className="text-[11px] text-muted">{item.category}</span>
          )}

          {macros && (
            <span className="inline-flex items-center gap-1.5 rounded-full bg-surface-soft px-2 py-0.5 text-[11px] font-medium text-muted">
              {macros.kcal != null && <span>{macros.kcal} kcal</span>}
              {macros.kcal != null && macros.protein != null && (
                <span className="text-muted-soft">·</span>
              )}
              {macros.protein != null && <span>{macros.protein}g protein</span>}
            </span>
          )}
        </div>

        {desc && (
          <p className="mt-1.5 line-clamp-1 text-xs leading-relaxed text-muted-soft sm:line-clamp-2">
            {desc}
          </p>
        )}

        {customisable && (
          <p className="mt-1 text-[11px] font-medium text-muted">Customisable</p>
        )}

        {details && (
          <DetailSheet
            title={item.name}
            onClose={() => setDetails(false)}
            footer={
              <div className="flex items-center justify-between gap-3">
                <span className="font-display text-lg font-bold text-ink">{inr(item.price)}</span>
                {available ? (
                  <button
                    type="button"
                    onClick={() => {
                      setDetails(false);
                      handleAdd();
                    }}
                    className="rounded-lg bg-coral px-5 py-2.5 text-sm font-bold text-on-primary shadow-soft hover:bg-coral-active"
                  >
                    {qty > 0 ? `Add another · ${qty} in cart` : customisable ? 'Customise & add' : 'Add'}
                  </button>
                ) : (
                  <span className="text-sm font-semibold text-muted-soft">Sold out</span>
                )}
              </div>
            }
          >
            {item.imageUrl && !imgBroken && (
              // eslint-disable-next-line @next/next/no-img-element
              <img decoding="async" src={item.imageUrl} alt={item.name} className="aspect-[4/3] w-full rounded-xl object-cover" />
            )}
            <div className="mt-3 flex items-center gap-2">
              <VegMark veg={item.veg} />
              {item.rating && <span className="text-xs font-bold text-success-ink">★ {item.rating}{item.ratingCount ? ` (${item.ratingCount})` : ''}</span>}
              {item.restaurantName && <span className="text-xs text-muted">{item.restaurantName}</span>}
            </div>
            <h3 className="mt-1 font-display text-xl leading-snug text-ink [overflow-wrap:anywhere]">{item.name}</h3>
            {warn !== undefined && (
              <p className="mt-3 rounded-lg bg-error/10 px-2.5 py-2 text-xs text-error">⚠ Heads up{warn ? ` — ${warn}` : ''}</p>
            )}
            {warn === undefined && best !== undefined && (
              <p className="mt-3 rounded-lg bg-coral/10 px-2.5 py-2 text-xs text-coral">✦ <b>Best pick</b>{best ? ` — ${best}` : ''}</p>
            )}
            {warn === undefined && healthy !== undefined && (
              <p className="mt-2 rounded-lg bg-success/10 px-2.5 py-2 text-xs text-success-ink">🥗 <b>Healthiest</b>{healthy ? ` — ${healthy}` : ''}</p>
            )}
            {macros && (
              <p className="mt-3 text-xs text-muted">
                {macros.kcal != null && `${macros.kcal} kcal`}
                {macros.kcal != null && macros.protein != null && ' · '}
                {macros.protein != null && `${macros.protein}g protein`}
              </p>
            )}
            {desc && <p className="mt-3 text-sm leading-relaxed text-body">{desc}</p>}
          </DetailSheet>
        )}

        {zoom && item.imageUrl && (
          <Lightbox
            images={[{ src: item.imageUrl, alt: item.name, caption: `${inr(item.price)}${item.restaurantName ? ` · ${item.restaurantName}` : ''}` }]}
            title={item.name}
            onClose={() => setZoom(false)}
          />
        )}

        {customizing && (
          <FoodCustomizer
            item={item}
            onCancel={() => setCustomizing(false)}
            onConfirm={(selection) => {
              setCustomizing(false);
              onAdd(item, selection);
            }}
          />
        )}
      </div>

      {/* Thumb + Add */}
      <div className="flex w-24 shrink-0 flex-col items-center sm:w-28">
        <div className="relative aspect-square w-full overflow-hidden rounded-xl border border-hairline/80 bg-surface-soft shadow-xs">
          {onToggleCompare && (
            <button
              type="button"
              onClick={() => onToggleCompare(item)}
              aria-pressed={picked}
              aria-label={picked ? 'Remove from compare' : 'Add to compare'}
              title={picked ? 'Selected to compare' : 'Compare'}
              className={`absolute right-1 top-1 z-10 inline-flex h-6 w-6 items-center justify-center rounded-full border shadow-soft transition-all ${
                picked
                  ? 'border-coral bg-coral text-on-primary scale-105'
                  : 'border-hairline bg-canvas/90 text-muted hover:border-coral hover:text-coral hover:scale-105'
              }`}
            >
              {picked ? (
                <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M20 6 9 17l-5-5" />
                </svg>
              ) : (
                <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M16 3h5v5M21 3l-7 7M8 21H3v-5M3 21l7-7" />
                </svg>
              )}
            </button>
          )}
          {item.imageUrl && !imgBroken ? (
            <button
              type="button"
              onClick={() => setZoom(true)}
              className="block h-full w-full cursor-zoom-in"
              aria-label={`Enlarge photo of ${item.name}`}
            >
              <img decoding="async"
                src={item.imageUrl}
                alt={item.name}
                loading="lazy"
                onError={() => setImgBroken(true)}
                className="h-full w-full object-cover transition-transform duration-500 group-hover:scale-105"
              />
            </button>
          ) : (
            <div className="flex h-full w-full flex-col items-center justify-center bg-gradient-to-br from-surface-card to-surface-soft p-2 text-center select-none">
              <span className="text-xl mb-0.5">
                {item.veg ? '🥗' : '🍗'}
              </span>
              <span className="line-clamp-2 text-[10px] font-semibold text-muted text-center leading-tight">
                {item.name}
              </span>
            </div>
          )}
        </div>

        <div className="relative z-10 -mt-3.5 w-[90%]">
          {!available ? (
            <span className="block w-full cursor-not-allowed rounded-lg bg-surface-card px-3 py-1.5 text-center text-xs font-semibold text-muted-soft shadow-soft">
              Sold out
            </span>
          ) : qty > 0 ? (
            <button
              type="button"
              onClick={handleAdd}
              aria-label={`Add another ${item.name}, ${qty} in cart`}
              className="inline-flex w-full items-center justify-center gap-1.5 rounded-lg border border-coral bg-coral/10 px-3 py-1.5 text-xs font-bold text-coral shadow-sm transition-all hover:bg-coral hover:text-on-primary"
            >
              <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M20 6 9 17l-5-5" />
              </svg>
              {qty} in cart
            </button>
          ) : (
            <button
              type="button"
              onClick={handleAdd}
              className="w-full rounded-lg bg-coral px-3 py-1.5 text-xs font-bold uppercase tracking-wider text-on-primary shadow-soft transition-all hover:bg-coral-active hover:shadow-md active:scale-95"
            >
              ADD +
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

type RowCallbacks = Pick<
  MenuListProps,
  | 'inCartQty'
  | 'onAdd'
  | 'bestReason'
  | 'healthyReason'
  | 'warnReason'
  | 'isSelectedForCompare'
  | 'onToggleCompare'
  | 'showRestaurant'
>;

// One menu section (a single category, or the synthetic "Dishes" group for a
// cross-restaurant search). Holds its OWN reveal state so each section expands
// independently — tap "Load more" and the next few dishes of THIS section appear
// instantly from the already-fetched data. No network, no shared counter.
function MenuCategorySection({
  title,
  items,
  showCaption,
  first,
  cb,
  moreItems,
  totalItems,
  onSearchCategory,
}: {
  title: string;
  items: MenuItem[];
  showCaption: boolean;
  first: boolean;
  cb: RowCallbacks;
  moreItems?: number;
  totalItems?: number;
  onSearchCategory?: (categoryTitle: string) => void;
}) {
  const [visible, setVisible] = useState(INITIAL_ITEMS);
  const shown = items.slice(0, visible);
  const remaining = items.length - shown.length;

  return (
    <div className={first ? '' : 'mt-5 border-t border-hairline pt-4'}>
      {showCaption && (
        <p className="mb-0.5 text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-soft">
          {title}
          {totalItems ? (
            <span className="ml-1.5 font-normal normal-case tracking-normal">· {totalItems} dishes</span>
          ) : null}
        </p>
      )}

      <div className="divide-y divide-hairline">
        {shown.map((item, i) => (
          <div
            key={item.id}
            className="animate-rise"
            // Stagger only the freshly-revealed batch; already-shown rows keep
            // their identity (keyed by id) and don't re-animate.
            style={{ animationDelay: `${(i % STEP) * 45}ms` }}
          >
            <MenuItemCard
              item={item}
              qty={cb.inCartQty(item.id)}
              onAdd={cb.onAdd}
              best={cb.bestReason?.(item.id)}
              healthy={cb.healthyReason?.(item.id)}
              warn={cb.warnReason?.(item.id)}
              picked={cb.isSelectedForCompare?.(item.id) ?? false}
              onToggleCompare={cb.onToggleCompare}
              showRestaurant={cb.showRestaurant}
            />
          </div>
        ))}
      </div>

      {remaining > 0 && (
        <div className="mt-3 flex justify-center">
          <button
            type="button"
            onClick={() => setVisible((v) => v + STEP)}
            className="inline-flex items-center gap-1.5 rounded-full border border-hairline bg-canvas px-4 py-2 text-sm font-medium text-ink transition-colors hover:border-coral hover:text-coral"
          >
            Load more
            <span className="text-muted-soft">({remaining} more)</span>
            <span aria-hidden="true" className="text-coral">↓</span>
          </button>
        </div>
      )}

      {/* Swiggy caps each menu category; the rest are reachable via search_menu. */}
      {remaining <= 0 && moreItems && moreItems > 0 && onSearchCategory ? (
        <div className="mt-3 flex justify-center">
          <button
            type="button"
            onClick={() => onSearchCategory(title)}
            className="inline-flex items-center gap-1.5 rounded-full border border-hairline bg-canvas px-4 py-2 text-sm font-medium text-ink transition-colors hover:border-coral hover:text-coral"
          >
            {moreItems} more in {title}
            <span aria-hidden="true" className="text-coral">→</span>
          </button>
        </div>
      ) : null}
    </div>
  );
}

// `sending` is an internal extra (not part of the frozen MenuListProps):
// MessageBubble is the only consumer, so we accept it as an optional add-on to
// gate the agent-triggering header buttons while a turn streams.
export function MenuList({
  restaurantName,
  restaurant,
  totalCategories,
  totalItems,
  categories,
  sending,
  inCartQty,
  onAdd,
  bestReason,
  healthyReason,
  warnReason,
  onFindBest,
  onHealthier,
  isSelectedForCompare,
  onToggleCompare,
  heading,
  showRestaurant,
  onLoadMore,
  loadingMore,
  loadMoreLabel,
  onSearchCategory,
}: MenuListProps & { sending?: boolean }) {
  // Keep the category grouping (so each section reveals on its own), but dedupe
  // dishes ACROSS sections — Swiggy menus repeat items under "Recommended" etc.,
  // and we never want the same dish twice. First occurrence wins; empty sections
  // (everything already shown above) are dropped.
  const seen = new Set<string>();
  const sections: { title: string; items: MenuItem[]; moreItems?: number; totalItems?: number }[] = [];
  for (const c of categories) {
    const items: MenuItem[] = [];
    for (const it of c.items) {
      if (it.id && !seen.has(it.id)) {
        seen.add(it.id);
        items.push(it);
      }
    }
    if (items.length) {
      // Keep the relevance order but sink out-of-stock dishes to the bottom
      // (stable sort preserves order within the in-stock / OOS groups).
      items.sort((a, b) => Number(b.inStock) - Number(a.inStock));
      sections.push({ title: c.title, items, moreItems: c.moreItems, totalItems: c.totalItems });
    }
  }

  // A single section (a one-category menu, or the synthetic "Dishes" group for a
  // cross-restaurant search) already has the serif header above it — the caption
  // would just be noise. Show captions only when there are real sections.
  const showCaptions = sections.length > 1;

  const cb: RowCallbacks = {
    inCartQty,
    onAdd,
    bestReason,
    healthyReason,
    warnReason,
    isSelectedForCompare,
    onToggleCompare,
    showRestaurant,
  };

  return (
    <section className="animate-rise rounded-lg border border-hairline bg-canvas p-5">
      {/* Header */}
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <Sparkle className="h-4 w-4 shrink-0 text-coral" />
          <h3 className="truncate font-display text-lg leading-tight text-ink">
            {heading ? (
              heading
            ) : (
              <>
                Menu · <span className="text-coral">{restaurantName}</span>
              </>
            )}
          </h3>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {onHealthier && (
            <button
              type="button"
              onClick={onHealthier}
              disabled={sending}
              className="tap inline-flex items-center gap-1 rounded-full border border-success/40 px-2.5 py-1 text-xs font-medium text-success-ink transition-colors hover:bg-success/10 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <span aria-hidden="true">🥗</span> Healthier
            </button>
          )}
          {onFindBest && (
            <button
              type="button"
              onClick={onFindBest}
              disabled={sending}
              className="tap inline-flex items-center gap-1 rounded-full border border-coral/40 px-2.5 py-1 text-xs font-medium text-coral transition-colors hover:bg-coral/10 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <span aria-hidden="true">✦</span> Best pick
            </button>
          )}
        </div>
      </div>

      {restaurant && !heading && <RestaurantHeader r={restaurant} totalCategories={totalCategories} />}
      {/* AI read of a restaurant menu (tap or chat): picks, value, veg, unavailable + chips */}
      {!heading && <MenuAiRead restaurant={restaurant} categories={categories} onAdd={onAdd} />}
      {totalItems ? (
        <p className="mb-1 text-[11px] text-muted">Swiggy has {totalItems.toLocaleString('en-IN')} matches nearby</p>
      ) : null}

      {sections.map((s, i) => (
        <MenuCategorySection
          key={`${s.title}-${i}`}
          title={s.title}
          items={s.items}
          showCaption={showCaptions}
          first={i === 0}
          cb={cb}
          moreItems={s.moreItems}
          totalItems={s.totalItems}
          onSearchCategory={onSearchCategory && !sending ? onSearchCategory : undefined}
        />
      ))}

      {onLoadMore && (
        <div className="mt-4 flex justify-center border-t border-hairline pt-4">
          <button
            type="button"
            onClick={onLoadMore}
            disabled={loadingMore}
            className="inline-flex items-center gap-1.5 rounded-full border border-coral/40 bg-canvas px-4 py-2 text-sm font-medium text-coral transition-colors hover:bg-coral/10 disabled:cursor-wait disabled:opacity-60"
          >
            {loadingMore ? 'Loading…' : loadMoreLabel || 'More from this menu'}
            {!loadingMore && <span aria-hidden="true">↓</span>}
          </button>
        </div>
      )}
    </section>
  );
}

export default MenuList;
