'use client';

// "Your usuals" — the Instamart front door. Photos of household repeats, a thin
// tonight row (cook / order the usual / going out), and "Review shop" that only
// pushes the draft into the existing cart (never checkout).

import { useMemo, useState } from 'react';
import type { FoodRestaurant, Product, Variation } from '@/shared/types';
import { PriceTag } from '../navigation/PriceTag';
import { ProductBadges, ProductFacts, VegDot, unitPriceLabel } from '../catalog/ProductCard';
import type { UsualLine, UsualsBriefing, UsualsStatus } from '@/frontend/hooks/useUsuals';

export type TonightChoice = 'cook' | 'order' | 'out' | null;

export interface UsualsBoardProps {
  status: UsualsStatus;
  items: UsualLine[];
  /** Section honesty: "again" = no Due math; "mixed" = some Due lines. */
  label: 'again' | 'mixed';
  foodUsual: FoodRestaurant[];
  tonight: TonightChoice;
  onTonight: (choice: TonightChoice) => void;
  onReviewShop: (selected: { product: Product; variation: Variation }[]) => void;
  onOpenFoodRestaurant: (r: FoodRestaurant) => void;
  onFoodFallback: () => void;
  reviewing?: boolean;
  /** AI briefing over the usuals (your_go_to_items + get_orders facts) */
  briefing?: UsualsBriefing;
  /** one tap: build the usuals refill as ONE AI basket card in the chat */
  onRefill?: () => void;
}

function weekdayReviewLabel(): string {
  const day = new Date().toLocaleDateString('en-IN', { weekday: 'long' });
  return `Review ${day} shop`;
}

function pickVariation(p: Product, spinId: string): Variation | undefined {
  return p.variations.find((v) => v.spinId === spinId) ?? p.variations[0];
}

function UsualTile({
  line,
  selected,
  onToggle,
  packId,
  onPack,
  priority = false,
}: {
  line: UsualLine;
  /** above-the-fold tile: load its photo eagerly (it is the page's LCP) */
  priority?: boolean;
  selected: boolean;
  onToggle: () => void;
  /** the pack shown / added — the AI pick unless the user switched */
  packId: string;
  onPack: (spinId: string) => void;
}) {
  const [imgBroken, setImgBroken] = useState(false);
  const v = pickVariation(line.product, packId);
  if (!v) return null;
  const packs = line.product.variations.filter((x) => x.inStock && x.spinId);
  const aiPick = packId === line.spinId;

  const monogram = (line.product.brand || line.product.name || '?')
    .trim()
    .charAt(0)
    .toUpperCase();
  const sizeLine = [line.product.brand, v.quantityDescription].filter(Boolean).join(' · ');
  const due = line.badge === 'due';
  const soldOut = line.inStock === false || !v.inStock;

  return (
    <div
      className={`flex flex-col overflow-hidden rounded-lg border transition-all duration-200 ${
        selected
          ? 'border-coral bg-canvas shadow-soft ring-1 ring-coral/30'
          : 'border-hairline bg-canvas/70 opacity-70 hover:border-cream-strong hover:opacity-100'
      }`}
    >
    <button
      type="button"
      onClick={onToggle}
      disabled={soldOut}
      aria-pressed={selected}
      className="group flex flex-1 flex-col text-left"
    >
      <div className="relative aspect-square overflow-hidden border-b border-hairline bg-surface-soft">
        {v.imageUrl && !imgBroken ? (
          <img decoding="async"
            src={v.imageUrl}
            alt={line.product.name}
            loading={priority ? 'eager' : 'lazy'}
            fetchPriority={priority ? 'high' : 'auto'}
            onError={() => setImgBroken(true)}
            className="h-full w-full object-contain p-2 mix-blend-multiply"
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center">
            <span className="font-display text-3xl text-muted-soft">{monogram}</span>
          </div>
        )}
        {soldOut && (
          <span className="absolute inset-x-2 bottom-2 rounded-full bg-ink/80 px-2 py-0.5 text-center text-[10px] font-semibold uppercase tracking-wide text-on-primary">
            Out of stock
          </span>
        )}
        <div className="absolute left-2 top-2 flex max-w-[calc(100%-2.75rem)] flex-wrap gap-1">
          {due && (
            <span className="rounded-full bg-coral px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-on-primary shadow-soft">
              Due
            </span>
          )}
          {/* Swiggy's labels: ⭐ Sponsored + Bestseller / Switch */}
          <ProductBadges product={line.product} />
        </div>
        <span
          className={`absolute right-2 top-2 inline-flex h-6 w-6 items-center justify-center rounded-full border text-xs shadow-soft ${
            selected
              ? 'border-coral bg-coral text-on-primary'
              : 'border-hairline bg-canvas text-muted'
          }`}
          aria-hidden="true"
        >
          {selected ? '✓' : '+'}
        </span>
      </div>
      <div className="flex flex-1 flex-col gap-1 p-3">
        <p className="line-clamp-2 font-display text-[15px] leading-snug text-ink">
          <VegDot veg={v.veg} className="mr-1.5 inline-flex align-middle" />
          {line.product.name}
        </p>
        {sizeLine && (
          <p className="line-clamp-1 text-[12px] text-muted">{sizeLine}</p>
        )}
        <ProductFacts variation={v} />
        {(v.offerPrice > 0 || v.mrp > 0) && (
          <div className="mt-auto pt-1">
            <PriceTag offerPrice={v.offerPrice || v.mrp} mrp={v.mrp} size="sm" />
            {unitPriceLabel(v) && (
              <p className="mt-0.5 text-[11px] tabular-nums text-muted-soft">{unitPriceLabel(v)}</p>
            )}
          </div>
        )}
        {line.lastOrdered && <p className="text-[11px] text-muted-soft">{line.lastOrdered}</p>}
      </div>
    </button>
      {/* The AI's pack choice (best value per unit) — switchable */}
      {!soldOut && (aiPick ? line.pickReason : true) && (
        <div className="border-t border-hairline px-3 pb-2.5 pt-2">
          <p className="line-clamp-3 text-[11px] leading-snug text-body" title={line.pickReason}>
            <span className="font-semibold text-coral">✦ {aiPick ? 'AI pack' : 'Your pack'}</span>
            {aiPick && line.pickReason ? ` — ${line.pickReason}` : ''}
          </p>
          {packs.length > 1 && (
            <div className="mt-1.5 flex flex-wrap gap-1">
              {packs.map((x) => {
                const on = x.spinId === packId;
                return (
                  <button
                    key={x.spinId}
                    type="button"
                    onClick={() => onPack(x.spinId)}
                    aria-pressed={on}
                    title={`${x.quantityDescription} · ₹${x.offerPrice}${x.unitLevelPrice ? ` · ₹${x.unitLevelPrice}` : ''}`}
                    className={`rounded-full border px-2 py-0.5 text-[10px] transition-colors ${
                      on ? 'border-coral bg-coral/10 text-coral' : 'border-hairline text-muted hover:border-coral/40'
                    }`}
                  >
                    {x.quantityDescription} · ₹{x.offerPrice}
                    {x.spinId === line.spinId ? ' ✦' : ''}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

const CHIP =
  'tap rounded-full border px-3.5 py-1.5 text-sm transition-colors disabled:opacity-50';

export function UsualsBoard({
  status,
  items,
  label,
  foodUsual,
  tonight,
  onTonight,
  onReviewShop,
  onOpenFoodRestaurant,
  onFoodFallback,
  reviewing,
  briefing,
  onRefill,
}: UsualsBoardProps) {
  // Pack the user switched to, by the line's AI-pick spinId (default = AI pick).
  const [packOf, setPackOf] = useState<Record<string, string>>({});
  // Draft selection keyed by spinId: every in-stock line is in by default and
  // the user opts lines OUT (derived, so a fresh list needs no reset effect).
  const [excluded, setExcluded] = useState<Set<string>>(() => new Set());
  const selected = useMemo(
    () =>
      new Set(
        status === 'ready'
          ? items.filter((i) => i.inStock !== false && !excluded.has(i.spinId)).map((i) => i.spinId)
          : [],
      ),
    [status, items, excluded],
  );

  const selectedCount = selected.size;
  const reviewLabel = useMemo(() => weekdayReviewLabel(), []);

  const toggle = (spinId: string) => {
    if (items.find((i) => i.spinId === spinId)?.inStock === false) return;
    setExcluded((prev) => {
      const next = new Set(prev);
      if (next.has(spinId)) next.delete(spinId);
      else next.add(spinId);
      return next;
    });
  };

  const handleReview = () => {
    const picks: { product: Product; variation: Variation }[] = [];
    for (const line of items) {
      if (!selected.has(line.spinId)) continue;
      const variation = pickVariation(line.product, packOf[line.spinId] ?? line.spinId);
      if (variation) picks.push({ product: line.product, variation });
    }
    if (picks.length) onReviewShop(picks);
  };

  const sectionTitle =
    label === 'mixed' ? 'Due now · then the rest' : 'You buy these again';

  const showOrderUsual = tonight === 'order';
  const cookHint = tonight === 'cook';

  return (
    <div className="flex h-full flex-col overflow-y-auto px-4 py-8 sm:px-6 animate-rise">
      <div className="mx-auto w-full max-w-2xl">
        <p className="text-[11px] font-medium uppercase tracking-[0.14em] text-muted">
          Instamart
        </p>
        <h1 className="mt-2 font-display text-3xl leading-tight text-ink sm:text-4xl">
          Your usuals
        </h1>
        <p className="mt-2 max-w-md text-[15px] text-muted">
          What this home buys again. Tap to leave something out, then review —
          nothing is ordered until you confirm.
        </p>

        {/* AI briefing — from your_go_to_items + get_orders, one-tap refill */}
        {status === 'ready' && briefing?.text && (
          <div className="mt-5 rounded-xl border border-coral/30 bg-gradient-to-r from-coral/10 via-amber-500/5 to-transparent p-4" role="status" aria-live="polite">
            <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-coral">✦ Swizzo&apos;s briefing</p>
            <p className="mt-1 text-[15px] leading-snug text-ink">{briefing.ai?.text ?? briefing.text}</p>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              {onRefill && (
                <button
                  type="button"
                  onClick={onRefill}
                  className="rounded-lg bg-coral px-4 py-2 text-sm font-semibold text-on-primary shadow-soft transition-colors hover:bg-coral-active"
                >
                  Refill my usuals
                </button>
              )}
              <span className="text-[11px] text-muted-soft">
                {briefing.ai ? `Written by ${briefing.ai.model} from your Swiggy data` : 'From your Swiggy go-to items & orders'}
              </span>
            </div>
          </div>
        )}

        {/* Tonight — three choices, not a chatbot */}
        <div className="mt-6 flex flex-wrap items-center gap-2">
          <span className="mr-1 text-xs font-medium uppercase tracking-wide text-muted-soft">
            Tonight
          </span>
          <button
            type="button"
            onClick={() => onTonight(tonight === 'cook' ? null : 'cook')}
            className={`${CHIP} ${
              tonight === 'cook'
                ? 'border-coral bg-coral/10 text-coral'
                : 'border-hairline bg-surface-card/60 text-body hover:border-coral hover:text-coral'
            }`}
          >
            Cook tonight
          </button>
          <button
            type="button"
            onClick={() => onTonight(tonight === 'order' ? null : 'order')}
            className={`${CHIP} ${
              tonight === 'order'
                ? 'border-coral bg-coral/10 text-coral'
                : 'border-hairline bg-surface-card/60 text-body hover:border-coral hover:text-coral'
            }`}
          >
            Order the usual
          </button>
          <button
            type="button"
            onClick={() => onTonight('out')}
            className={`${CHIP} border-hairline bg-surface-card/60 text-body hover:border-coral hover:text-coral`}
          >
            Going out
          </button>
        </div>

        {cookHint && (
          <p className="mt-3 text-sm text-body">
            Add only what you&apos;re missing — leave the rest off the draft.
          </p>
        )}

        {showOrderUsual && (
          <div className="mt-4 rounded-lg border border-hairline bg-surface-soft/80 p-3">
            {foodUsual.length > 0 ? (
              <>
                <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted">
                  Places you reorder
                </p>
                <div className="flex flex-col gap-2 sm:flex-row">
                  {foodUsual.map((r) => (
                    <button
                      key={r.id}
                      type="button"
                      onClick={() => onOpenFoodRestaurant(r)}
                      className="flex min-w-0 flex-1 items-center gap-3 rounded-md border border-hairline bg-canvas px-3 py-2 text-left transition-colors hover:border-coral"
                    >
                      <div className="h-10 w-10 shrink-0 overflow-hidden rounded-md bg-surface-soft">
                        {r.imageUrl ? (
                          <img decoding="async"
                            src={r.imageUrl}
                            alt=""
                            className="h-full w-full object-cover"
                          />
                        ) : (
                          <div className="flex h-full w-full items-center justify-center font-display text-sm text-muted-soft">
                            {r.name.charAt(0)}
                          </div>
                        )}
                      </div>
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium text-ink">{r.name}</p>
                        <p className="truncate text-xs text-muted">
                          {[r.cuisines.slice(0, 2).join(' · '), r.area]
                            .filter(Boolean)
                            .join(' · ') || 'Open in Food'}
                        </p>
                      </div>
                    </button>
                  ))}
                </div>
              </>
            ) : (
              <button
                type="button"
                onClick={onFoodFallback}
                className="w-full text-left text-sm text-body hover:text-coral"
              >
                No recent Food orders here yet — open Food to pick a usual place →
              </button>
            )}
          </div>
        )}

        {/* Board body */}
        <div className="mt-8">
          {status === 'loading' && (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              {Array.from({ length: 6 }).map((_, i) => (
                <div
                  key={i}
                  className="aspect-[3/4] animate-pulse rounded-lg bg-surface-card"
                />
              ))}
            </div>
          )}

          {(status === 'empty' || status === 'error') && (
            <div className="rounded-lg border border-dashed border-hairline bg-surface-soft/50 px-5 py-10 text-center">
              <p className="font-display text-xl text-ink">
                Order once, and your usuals will show up here
              </p>
              <p className="mt-2 text-sm text-muted">
                Use the note below for milk, eggs, or anything you need tonight.
              </p>
            </div>
          )}

          {status === 'ready' && (
            <>
              <div className="mb-3 flex items-baseline justify-between gap-2">
                <h2 className="text-sm font-medium text-body">{sectionTitle}</h2>
                <span className="text-xs text-muted">
                  {selectedCount} of {items.length} in draft
                </span>
              </div>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                {items.map((line, i) => (
                  <UsualTile
                    key={line.spinId}
                    priority={i < 2}
                    line={line}
                    selected={selected.has(line.spinId)}
                    onToggle={() => toggle(line.spinId)}
                    packId={packOf[line.spinId] ?? line.spinId}
                    onPack={(spinId) => setPackOf((prev) => ({ ...prev, [line.spinId]: spinId }))}
                  />
                ))}
              </div>
            </>
          )}
        </div>

        {status === 'ready' && (
          <div className="sticky bottom-0 mt-8 border-t border-hairline bg-canvas/95 py-4 backdrop-blur-sm">
            <button
              type="button"
              disabled={selectedCount === 0 || reviewing}
              onClick={handleReview}
              className="w-full rounded-xl bg-coral px-5 py-3.5 text-[15px] font-semibold text-on-primary shadow-soft transition-all hover:bg-coral-active disabled:cursor-not-allowed disabled:bg-coral-disabled disabled:text-muted"
            >
              {reviewing ? 'Adding to cart…' : reviewLabel}
            </button>
            <p className="mt-2 text-center text-xs text-muted">
              Opens your cart to review. Does not place an order.
            </p>
          </div>
        )}

        <p className="mt-6 text-center text-xs text-muted-soft">
          Need something odd? Use the note below — chat still works.
        </p>
      </div>
    </div>
  );
}

export default UsualsBoard;
