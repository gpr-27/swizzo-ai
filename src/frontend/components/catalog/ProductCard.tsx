'use client';

// A single product as an editorial feature card: a light image tile up top
// (with a graceful monogram fallback), brand + name, an optional pack-size
// selector, then the serif price paired with an Add control. The selected
// variation is local state; everything else is driven by props.

import { useEffect, useRef, useState } from 'react';
import type { Product, ProductCardProps, Variation } from '@/shared/types';
import { PriceTag } from '../navigation/PriceTag';
import { choosePack } from '@/shared/instamart-packs';
import { DetailSheet } from '../features/DetailSheet';

/** FSSAI-style veg / non-veg mark from Swiggy's vegClassifier (food only). */
export function VegDot({ veg, className = '' }: { veg?: Variation['veg']; className?: string }) {
  if (!veg) return null;
  const color = veg === 'veg' ? '#3f8f52' : '#b5432f';
  return (
    <span
      role="img"
      aria-label={veg === 'veg' ? 'Vegetarian' : 'Non-vegetarian'}
      title={veg === 'veg' ? 'Veg' : 'Non-veg'}
      className={`inline-flex h-3 w-3 shrink-0 items-center justify-center rounded-[2px] border ${className}`}
      style={{ borderColor: color }}
    >
      <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: color }} />
    </span>
  );
}

/**
 * Swiggy's labels for a product: "⭐ Sponsored" for promoted listings (the
 * tool's display instructions ask for it — it replaces the "Ad" badge), then
 * its merchandising badges ("Bestseller", "Switch") in Swiggy's own colours.
 */
export function ProductBadges({ product, className = '' }: { product: Product; className?: string }) {
  const badges = (product.badges ?? []).filter((b) => b.type !== 'BADGE_TYPE_AD');
  if (!product.isPromoted && badges.length === 0) return null;
  return (
    <div className={`flex flex-wrap gap-1 ${className}`}>
      {product.isPromoted && (
        <span
          title="Featured / sponsored listing"
          className="rounded-full border border-hairline bg-canvas/95 px-1.5 py-0.5 text-[10px] font-medium text-muted shadow-soft"
        >
          ⭐ Sponsored
        </span>
      )}
      {badges.map((b) => {
        // Swiggy colours are dark brand fills (#238BF4, #002E99) — white text on
        // them; a translucent / missing colour falls back to a light chip.
        const solid = !!b.backgroundColor && /^#[0-9a-f]{3,8}$/i.test(b.backgroundColor);
        return (
          <span
            key={`${b.type}-${b.text}`}
            className={`rounded-full px-1.5 py-0.5 text-[10px] font-semibold shadow-soft ${
              solid ? 'text-white' : 'border border-hairline bg-canvas/95 text-muted'
            }`}
            style={solid ? { backgroundColor: b.backgroundColor } : undefined}
          >
            {b.text}
          </span>
        );
      })}
    </div>
  );
}

/** Rating + delivery time for the selected pack ("★ 4.4 (140.4k) · ⚡ 14 mins"). */
export function ProductFacts({ variation, className = '' }: { variation: Variation; className?: string }) {
  const { rating, sla } = variation;
  if (!rating && !sla) return null;
  return (
    <p className={`flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-muted ${className}`}>
      {rating && (
        <span title={rating.count ? `${rating.count} ratings` : undefined}>
          <span className="text-success-ink" aria-hidden="true">★</span> {rating.value}
          {rating.count ? <span className="text-muted-soft"> ({rating.count})</span> : null}
        </span>
      )}
      {sla && (
        <span title="Delivery time">
          <span aria-hidden="true">⚡</span> {sla}
        </span>
      )}
    </p>
  );
}

/** Swiggy's unit price ("8.7/piece", "42.5/100 g") as "₹8.7/piece". */
export function unitPriceLabel(v: Variation): string | undefined {
  const u = v.unitLevelPrice?.trim();
  if (!u) return undefined;
  return u.startsWith('₹') ? u : `₹${u}`;
}

export function ProductCard({
  product,
  inCartQty,
  onAdd,
  isSelected,
  onToggleCompare,
  bestReason,
  healthyReason,
  warnReason,
}: ProductCardProps) {
  const variations = product.variations ?? [];

  // The variation the agent flagged (best / healthiest / warn), if any. Flags
  // arrive streamed in AFTER the card first renders, so we must surface that
  // pack — otherwise the badge/border only ever shows on variations[0].
  const flaggedId = variations.find(
    (v) =>
      bestReason?.(v.spinId) !== undefined ||
      healthyReason?.(v.spinId) !== undefined ||
      warnReason?.(v.spinId) !== undefined,
  )?.spinId;

  // The AI's pack when several exist: best value per unit among in-stock packs
  // (no bulk stock-up packs), with its one-line why.
  const aiPack = variations.length > 1 ? choosePack(product) : null;
  const aiPackId = aiPack?.variation.spinId;

  // Default to the flagged pack, else the AI pack, else the first. User taps win after.
  const [selectedId, setSelectedId] = useState(
    () => flaggedId ?? aiPackId ?? variations[0]?.spinId,
  );
  const userPickedRef = useRef(false);
  const [imgBroken, setImgBroken] = useState(false);
  const [open, setOpen] = useState(false);

  // When a flag lands later (mid-stream) and the user hasn't manually chosen a
  // pack, jump to the flagged pack so its badge + border actually render.
  useEffect(() => {
    if (flaggedId && !userPickedRef.current && flaggedId !== selectedId) {
      setSelectedId(flaggedId);
      setImgBroken(false);
    }
  }, [flaggedId, selectedId]);

  const selected: Variation | undefined =
    variations.find((v) => v.spinId === selectedId) ?? variations[0];

  const select = (v: Variation) => {
    userPickedRef.current = true; // a manual pick overrides auto-selection
    setSelectedId(v.spinId);
    setImgBroken(false); // a new variation may carry a different image
  };

  // Nothing to render if the product somehow has no buyable variation.
  if (!selected) return null;

  const qty = inCartQty(selected.spinId);
  const available = product.inStock && selected.inStock;
  // Swiggy's per-order cap for this pack, when it sets one.
  const atCap = !!selected.maxQuantity && qty >= selected.maxQuantity;
  const monogram = (product.brand || product.name || '?').trim().charAt(0).toUpperCase();
  const hasOptions = variations.length > 1;
  const picked = isSelected?.(selected.spinId) ?? false;
  const best = bestReason?.(selected.spinId);
  const healthy = healthyReason?.(selected.spinId);
  const warn = warnReason?.(selected.spinId);

  const marks = (
    <>
      {warn !== undefined ? (
        <div className="flex items-start gap-1.5 rounded-lg bg-error/10 px-2.5 py-2 text-xs leading-snug text-error">
          <span aria-hidden="true" className="mt-px">⚠</span>
          <span className="min-w-0 [overflow-wrap:anywhere]">
            <span className="font-semibold">Heads up</span>
            {warn ? ` — ${warn}` : ' — may not fit your needs'}
          </span>
        </div>
      ) : (
        <>
          {best !== undefined && (
            <div className="flex items-start gap-1.5 rounded-lg bg-coral/10 px-2.5 py-2 text-xs leading-snug text-coral">
              <span aria-hidden="true" className="mt-px">✦</span>
              <span className="min-w-0 [overflow-wrap:anywhere]">
                <span className="font-semibold">Best pick</span>
                {best ? ` — ${best}` : ''}
              </span>
            </div>
          )}
          {healthy !== undefined && (
            <div className="flex items-start gap-1.5 rounded-lg bg-success/10 px-2.5 py-2 text-xs leading-snug text-success-ink">
              <span aria-hidden="true" className="mt-px">🥗</span>
              <span className="min-w-0 [overflow-wrap:anywhere]">
                <span className="font-semibold">Healthiest</span>
                {healthy ? ` — ${healthy}` : ''}
              </span>
            </div>
          )}
        </>
      )}
    </>
  );

  // One short chip on the card itself; the reasons live in the details popup.
  const chip =
    warn !== undefined
      ? { text: '⚠ Heads up', cls: 'bg-error/10 text-error' }
      : best !== undefined
        ? { text: '✦ Best pick', cls: 'bg-coral/10 text-coral' }
        : healthy !== undefined
          ? { text: '🥗 Healthiest', cls: 'bg-success/10 text-success-ink' }
          : null;

  const addControl = !available ? (
    <span className="shrink-0 rounded-md bg-surface-card px-3 py-2 text-xs font-medium text-muted-soft">Unavailable</span>
  ) : qty > 0 ? (
    <button
      type="button"
      onClick={() => onAdd(product, selected)}
      disabled={atCap}
      title={atCap ? selected.maxQuantityMessage || `Max ${selected.maxQuantity} per order` : undefined}
      aria-label={`Add another ${product.name}, ${qty} in cart`}
      className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-md border border-coral/30 bg-coral/10 px-3 py-2 text-sm font-medium text-coral transition-colors hover:bg-coral/15 active:bg-coral-active active:text-on-primary disabled:cursor-not-allowed disabled:opacity-60"
    >
      <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M20 6 9 17l-5-5" />
      </svg>
      {qty} in cart
    </button>
  ) : (
    <button
      type="button"
      onClick={() => onAdd(product, selected)}
      className="tap shrink-0 rounded-md bg-coral px-4 py-2 text-sm font-medium text-on-primary transition-colors hover:bg-coral-active active:bg-coral-active"
    >
      Add
    </button>
  );

  const capNote = atCap ? (
    <p className="mt-1.5 text-[11px] leading-snug text-accent-amber">
      {selected.maxQuantityMessage || `Max ${selected.maxQuantity} per order`}
    </p>
  ) : null;

  return (
    <article
      className={`group flex h-full flex-col rounded-lg border bg-canvas p-3 transition-all duration-200 hover:-translate-y-0.5 hover:shadow-card ${
        warn
          ? 'border-error ring-1 ring-error/40'
          : best !== undefined
            ? 'border-coral ring-1 ring-coral/50'
            : healthy !== undefined
              ? 'border-success ring-1 ring-success/40'
              : picked
                ? 'border-coral ring-1 ring-coral/40'
                : 'border-hairline hover:border-cream-strong'
      }`}
    >
      {/* Image tile — tap anywhere on it to open the details popup */}
      <div
        onClick={() => setOpen(true)}
        className="relative mb-2 aspect-[5/4] cursor-pointer overflow-hidden rounded-md border border-hairline bg-surface-soft"
      >
        {selected.imageUrl && !imgBroken ? (
          // Plain <img> by design (no next/image): avoids remote-host config.
          <img decoding="async"
            src={selected.imageUrl}
            alt={product.name}
            loading="lazy"
            onError={() => setImgBroken(true)}
            className="h-full w-full object-contain p-2 mix-blend-multiply"
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center">
            <span className="font-display text-3xl text-muted-soft">{monogram}</span>
          </div>
        )}

        <ProductBadges product={product} className="absolute left-2 top-2 max-w-[calc(100%-2.5rem)]" />

        {onToggleCompare && available && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onToggleCompare(product, selected);
            }}
            aria-pressed={picked}
            aria-label={picked ? 'Remove from compare' : 'Add to compare'}
            title={picked ? 'Selected to compare' : 'Compare'}
            className={`tap absolute right-2 top-2 z-10 inline-flex h-6 w-6 items-center justify-center rounded-full border shadow-soft transition-colors ${
              picked
                ? 'border-coral bg-coral text-on-primary'
                : 'border-hairline bg-canvas/90 text-muted hover:border-coral hover:text-coral'
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
        {!available && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-canvas/55">
            <span className="rounded-full bg-surface-card px-2.5 py-1 text-[11px] font-medium uppercase tracking-wide text-muted">
              Out of stock
            </span>
          </div>
        )}
      </div>

      {(product.brand || selected.veg) && (
        <p className="flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-muted-soft">
          <VegDot veg={selected.veg} />
          <span className="truncate">{product.brand}</span>
        </p>
      )}
      <h3 className="mt-0.5 min-h-[2.5em] text-sm leading-snug text-ink">
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-haspopup="dialog"
          aria-label={`Details for ${product.name}`}
          className="line-clamp-2 w-full text-left"
        >
          {product.name}
        </button>
      </h3>
      <ProductFacts variation={selected} className="mt-0.5" />

      {chip && (
        <p className={`mt-1.5 w-fit max-w-full truncate rounded-full px-2 py-0.5 text-[10px] font-semibold ${chip.cls}`}>
          {chip.text}
        </p>
      )}

      <p className="mt-1 truncate text-xs text-muted">
        {selected.quantityDescription}
        {hasOptions && (
          <button type="button" onClick={() => setOpen(true)} className="ml-1 font-semibold text-coral">
            · {variations.length} sizes ›
          </button>
        )}
      </p>
      {capNote}

      <div className="mt-auto flex items-end justify-between gap-2 pt-2.5">
        <div className="min-w-0">
          <PriceTag offerPrice={selected.offerPrice} mrp={selected.mrp} size="sm" />
          {unitPriceLabel(selected) && (
            <p className="mt-0.5 truncate text-[11px] tabular-nums text-muted-soft">{unitPriceLabel(selected)}</p>
          )}
        </div>
        {addControl}
      </div>

      {open && (
        <DetailSheet
          title={product.name}
          onClose={() => setOpen(false)}
          footer={
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <PriceTag offerPrice={selected.offerPrice} mrp={selected.mrp} size="sm" />
                {unitPriceLabel(selected) && (
                  <p className="mt-0.5 text-[11px] tabular-nums text-muted-soft">{unitPriceLabel(selected)}</p>
                )}
              </div>
              {addControl}
            </div>
          }
        >
          <div className="relative aspect-[4/3] overflow-hidden rounded-xl border border-hairline bg-surface-soft">
            {selected.imageUrl && !imgBroken ? (
              <img decoding="async" src={selected.imageUrl} alt="" className="h-full w-full object-contain p-3 mix-blend-multiply" />
            ) : (
              <div className="flex h-full w-full items-center justify-center">
                <span className="font-display text-5xl text-muted-soft">{monogram}</span>
              </div>
            )}
            <ProductBadges product={product} className="absolute left-2 top-2" />
          </div>
          {(product.brand || selected.veg) && (
            <p className="mt-3 flex items-center gap-1.5 text-[11px] uppercase tracking-wide text-muted-soft">
              <VegDot veg={selected.veg} />
              <span>{product.brand}</span>
            </p>
          )}
          <h3 className="mt-0.5 font-display text-xl leading-snug text-ink [overflow-wrap:anywhere]">{product.name}</h3>
          <ProductFacts variation={selected} className="mt-1" />
          {(warn !== undefined || best !== undefined || healthy !== undefined) && (
            <div className="mt-3 flex flex-col gap-2">{marks}</div>
          )}
          {hasOptions && (
            <div className="mt-4">
              <p className="text-[11px] font-bold uppercase tracking-wider text-muted-soft">Pack size</p>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {variations.map((v) => {
                  const active = v.spinId === selected.spinId;
                  return (
                    <button
                      key={v.spinId}
                      type="button"
                      onClick={() => select(v)}
                      aria-pressed={active}
                      title={`${v.quantityDescription} · ₹${v.offerPrice}${v.inStock ? '' : ' · out of stock'}`}
                      className={`tap rounded-full border px-3 py-1.5 text-xs transition-colors ${
                        active
                          ? 'border-coral bg-coral/10 text-coral'
                          : 'border-hairline text-muted hover:border-coral/40 hover:text-body'
                      } ${v.inStock ? '' : 'line-through opacity-60'}`}
                    >
                      {v.quantityDescription}
                      <span className="ml-1 tabular-nums">₹{v.offerPrice}</span>
                      {v.spinId === aiPackId && (
                        <>
                          <span className="ml-1 text-coral" aria-hidden="true">✦</span>
                          <span className="sr-only"> (AI pick)</span>
                        </>
                      )}
                    </button>
                  );
                })}
              </div>
              {aiPack && selected.spinId === aiPackId && (
                <p className="mt-2 rounded-lg bg-coral/10 px-2.5 py-2 text-xs leading-snug text-body">
                  <span className="font-semibold text-coral">✦ AI pack</span> — {aiPack.why}
                </p>
              )}
            </div>
          )}
          {capNote}
        </DetailSheet>
      )}
    </article>
  );
}

export default ProductCard;
