'use client';

// A titled grid of product cards. Shows the first five results, then a single
// "Load more" affordance that first reveals locally-held products and, once
// those run out, asks the parent to fetch the next page (nextOffset). Designed
// to sit inside the chat thread, so cards stay compact (2 cols, 3 on wide).

import { useState } from 'react';
import type { Product, ProductGridProps } from '@/shared/types';
import { ProductCard } from './ProductCard';

const PAGE = 4;

/** Parse a Swiggy pack label into a comparable base quantity + unit. */
function packQty(desc: string): { qty: number; unit: 'ml' | 'g' | 'pc' } | null {
  if (!desc) return null;
  const s = desc.toLowerCase().replace(/,/g, ' ');
  const norm = (n: number, u: string): { qty: number; unit: 'ml' | 'g' | 'pc' } =>
    u === 'l'
      ? { qty: n * 1000, unit: 'ml' }
      : u === 'kg'
        ? { qty: n * 1000, unit: 'g' }
        : u === 'ml'
          ? { qty: n, unit: 'ml' }
          : { qty: n, unit: 'g' };
  const U = '(ml|l|kg|g|gm|gms)';
  let m = s.match(new RegExp(`([\\d.]+)\\s*${U}\\s*(?:x|×)\\s*([\\d.]+)`));
  if (m) { const b = norm(+m[1], m[2]); return { qty: b.qty * +m[3], unit: b.unit }; }
  m = s.match(new RegExp(`([\\d.]+)\\s*(?:x|×)\\s*([\\d.]+)\\s*${U}`));
  if (m) { const b = norm(+m[2], m[3]); return { qty: b.qty * +m[1], unit: b.unit }; }
  m = s.match(new RegExp(`([\\d.]+)\\s*${U}`));
  if (m) return norm(+m[1], m[2]);
  m = s.match(/([\d.]+)\s*(?:x|×)?\s*(?:pcs?|pieces?|nos?|units?|n)\b/);
  if (m) return { qty: +m[1], unit: 'pc' };
  return null;
}

/** The cheapest variation of a product (price + pack + whether any is in stock). */
function valueOf(
  p: Product,
): { price: number; pack: { qty: number; unit: string } | null; inStock: boolean } | null {
  const vs = (p.variations ?? []).filter((v) => v.inStock);
  const pool = vs.length ? vs : p.variations ?? [];
  if (!pool.length) return null;
  const v = pool.reduce((a, b) => (b.offerPrice < a.offerPrice ? b : a));
  return { price: v.offerPrice, pack: packQty(v.quantityDescription), inStock: vs.length > 0 };
}

/**
 * Go through ALL fetched results and drop the genuinely worthless ones: an item
 * another IN-STOCK item strictly BEATS — same-or-cheaper price AND a same-or-
 * bigger pack of the same unit (more for less). Flagged picks are never removed,
 * and a small set is left intact, so this only trims clear waste, never choice.
 */
function trimWorthless(products: Product[], isFlagged: (p: Product) => boolean): Product[] {
  // Only trim when there's a healthy set to spare; keep small sets whole so
  // pagination / "Load more" always has plenty of options to reveal.
  if (products.length <= 8) return products;

  // Cheapest price-per-unit per unit-type, among in-stock parseable items.
  const vals = products.map(valueOf);
  const unitPrice = (i: number): number | null => {
    const v = vals[i];
    return v && v.pack && v.pack.qty ? v.price / v.pack.qty : null;
  };
  const bestByUnit: Record<string, number> = {};
  products.forEach((_p, i) => {
    const v = vals[i];
    const u = unitPrice(i);
    if (v && v.inStock && v.pack && u != null && u > 0) {
      bestByUnit[v.pack.unit] = Math.min(bestByUnit[v.pack.unit] ?? u, u);
    }
  });

  // Conservatively drop only items that are clearly overpriced PER UNIT (≥40%
  // worse than the best comparable deal) — genuine waste — and cap removals to
  // ~a quarter of the set so "Load more" always still surfaces real choices.
  const maxRemove = Math.floor(products.length * 0.25);
  let removed = 0;
  const keep = products.filter((p, i) => {
    if (isFlagged(p)) return true;
    const v = vals[i];
    const u = unitPrice(i);
    if (!v || !v.pack || u == null) return true; // can't judge → keep
    const best = bestByUnit[v.pack.unit];
    if (best == null) return true;
    if (removed < maxRemove && u > best * 1.4) {
      removed += 1;
      return false;
    }
    return true;
  });
  return keep.length >= 6 ? keep : products;
}

function Sparkle({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="currentColor" aria-hidden="true">
      <path d="M12 1.5c.55 5.3 4.7 9.45 10 10-5.3.55-9.45 4.7-10 10-.55-5.3-4.7-9.45-10-10 5.3-.55 9.45-4.7 10-10Z" />
    </svg>
  );
}

// `sending` is an internal extra (not part of the frozen ProductGridProps):
// MessageBubble is the only consumer, so we accept it as an optional add-on to
// gate the agent-triggering header buttons while a turn streams.
export function ProductGrid({
  products,
  query,
  nextOffset,
  loadingMore,
  sending,
  inCartQty,
  onAdd,
  onLoadMore,
  isSelected,
  onToggleCompare,
  bestReason,
  healthyReason,
  warnReason,
  onFindBest,
  onHealthier,
}: ProductGridProps & { sending?: boolean }) {
  const [visible, setVisible] = useState(PAGE);

  // Order the results by how well they match you: the agent's best (coral) +
  // healthiest (green) picks float to the very top, in-stock items rank above
  // out-of-stock ones (which sink to the bottom). Sponsored (isPromoted) items
  // get no extra boost — Swiggy's own order (ads included) breaks any tie.
  const isFlagged = (p: Product) => {
    const ids = (p.variations ?? []).map((v) => v.spinId);
    return ids.some(
      (id) => bestReason?.(id) !== undefined || healthyReason?.(id) !== undefined,
    );
  };
  const rankOf = (p: (typeof products)[number]) => {
    const ids = (p.variations ?? []).map((v) => v.spinId);
    const best = ids.some((id) => bestReason?.(id) !== undefined);
    const healthy = ids.some((id) => healthyReason?.(id) !== undefined);
    const inStock =
      p.inStock && (p.variations ?? []).some((v) => v.inStock);
    return (
      (best ? 100 : 0) +
      (healthy ? 40 : 0) +
      (inStock ? 20 : -100) // out-of-stock drops to the bottom
    );
  };
  // Drop duplicate products first — a paginated/appended page can re-include an
  // item already shown, which would crash React with a duplicate key (and render
  // the same card twice). Keep first occurrence; fall back to spinId/index when a
  // productId is missing so the de-dupe key is always unique.
  const seen = new Set<string>();
  const deduped = products.filter((p, i) => {
    const id = p.productId || p.variations?.[0]?.spinId || `idx-${i}`;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
  // First trim clearly-worthless results, then rank the keepers by match.
  const useful = trimWorthless(deduped, isFlagged);
  const ranked = useful
    .map((p, i) => ({ p, i }))
    .sort((a, b) => rankOf(b.p) - rankOf(a.p) || a.i - b.i)
    .map((x) => x.p);

  const shown = ranked.slice(0, visible);
  const hasMoreLocal = visible < useful.length;
  const canPaginate = nextOffset != null;
  const showLoadMore = hasMoreLocal || canPaginate;

  const handleLoadMore = () => {
    if (loadingMore) return;
    if (hasMoreLocal) {
      setVisible((v) => v + PAGE); // reveal already-fetched products
    } else if (canPaginate) {
      // Advance the window on THIS click too, so the about-to-arrive page is
      // revealed as soon as it lands — no second click needed. `shown` slices
      // safely past the current length until the fetch fills the extra slots.
      setVisible((v) => v + PAGE);
      onLoadMore?.(); // ask the parent for the next page
    }
  };

  return (
    <section>
      {/* Header */}
      <div className="mb-3 flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <Sparkle className="h-4 w-4 shrink-0 text-coral" />
          <h3 className="truncate font-display text-lg leading-tight text-ink">
            {query ? (
              <>
                Top picks for <span className="text-coral">“{query}”</span>
              </>
            ) : (
              'Suggestions'
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

      {/* Grid */}
      <div className="grid grid-cols-2 gap-3 xl:grid-cols-3">
        {shown.map((p, i) => (
          <div
            key={p.productId || p.variations?.[0]?.spinId || i}
            className="animate-rise"
            style={{ animationDelay: `${(i % PAGE) * 55}ms` }}
          >
            <ProductCard
              product={p}
              inCartQty={inCartQty}
              onAdd={onAdd}
              isSelected={isSelected}
              onToggleCompare={onToggleCompare}
              bestReason={bestReason}
              healthyReason={healthyReason}
              warnReason={warnReason}
            />
          </div>
        ))}
      </div>

      {/* Load more */}
      {showLoadMore && (
        <div className="mt-4 flex justify-center">
          <button
            type="button"
            onClick={handleLoadMore}
            disabled={loadingMore}
            className="inline-flex items-center gap-2 rounded-md border border-hairline bg-canvas px-4 py-2 text-sm text-ink transition-colors hover:border-coral hover:text-coral disabled:cursor-not-allowed disabled:opacity-60"
          >
            {loadingMore && (
              <svg viewBox="0 0 24 24" className="h-4 w-4 animate-spin text-muted" fill="none" aria-hidden="true">
                <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2.5" className="opacity-25" />
                <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
              </svg>
            )}
            {loadingMore ? 'Loading…' : 'Load more'}
          </button>
        </div>
      )}
    </section>
  );
}

export default ProductGrid;
