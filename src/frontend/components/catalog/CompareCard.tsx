'use client';

// "Choose best of both" — a premium side-by-side comparison matrix rendered
// deterministically from the CompareItem snapshot (image, name, pack/qty, price,
// MRP→savings, ₹/unit) as columns. The agent only supplies the verdict: which
// column wins, a one-line reason, and an optional per-item note. The winning
// column is ringed in coral with a "Winner" ribbon, and a single coral CTA adds
// it to the right cart instantly (the hook's add is optimistic — zero lag).

import { useState } from 'react';
import type { CompareItem, ComparisonResult } from '@/shared/types';
import { PriceTag } from '../navigation/PriceTag';

// Exact props per the build contract (this interface is NOT in the frozen
// types.ts, so it lives with its only component).
export interface CompareCardProps {
  items: CompareItem[];
  result?: ComparisonResult;
  onAddWinner: (item: CompareItem) => void;
}

// Money helper: round to whole rupees once we're at ₹100+, keep one decimal for
// the small per-unit figures so cheap-by-a-hair packs still read differently.
function inr(n: number): string {
  const v = n >= 100 ? Math.round(n) : Math.round(n * 10) / 10;
  return `₹${v.toLocaleString('en-IN')}`;
}

// Best-effort parse of a Swiggy pack label into a base-unit quantity so we can
// show a comparable ₹/unit. Handles "500 ml", "1 L", "250 g", "1 kg",
// "500 ml x 4", "6 x 100 g", "6 pcs". Returns null when it can't be read (e.g.
// food dishes, which carry no pack size) so we just omit that row for the item.
function parsePack(desc: string): { qty: number; unit: 'ml' | 'g' | 'pc' } | null {
  if (!desc) return null;
  const s = desc.toLowerCase().replace(/,/g, ' ').trim();
  const norm = (n: number, u: string): { qty: number; unit: 'ml' | 'g' | 'pc' } => {
    if (u === 'l') return { qty: n * 1000, unit: 'ml' };
    if (u === 'kg') return { qty: n * 1000, unit: 'g' };
    if (u === 'gm' || u === 'gms') return { qty: n, unit: 'g' };
    return { qty: n, unit: u === 'ml' ? 'ml' : 'g' };
  };
  const U = '(ml|l|kg|g|gm|gms)';
  let m: RegExpMatchArray | null;
  // "500 ml x 4" / "1 L x 6" — amount-unit then × count
  m = s.match(new RegExp(`([\\d.]+)\\s*${U}\\s*(?:x|×)\\s*([\\d.]+)`));
  if (m) {
    const b = norm(Number(m[1]), m[2]);
    return { qty: b.qty * Number(m[3]), unit: b.unit };
  }
  // "6 x 100 g" — count × amount-unit
  m = s.match(new RegExp(`([\\d.]+)\\s*(?:x|×)\\s*([\\d.]+)\\s*${U}`));
  if (m) {
    const b = norm(Number(m[2]), m[3]);
    return { qty: b.qty * Number(m[1]), unit: b.unit };
  }
  // "500 ml" / "1 L" / "250 g" / "1 kg"
  m = s.match(new RegExp(`([\\d.]+)\\s*${U}`));
  if (m) return norm(Number(m[1]), m[2]);
  // "6 pcs" / "10 pieces" / "4 N"
  m = s.match(/([\d.]+)\s*(?:x|×)?\s*(?:pcs?|pieces?|nos?|units?|n)\b/);
  if (m) return { qty: Number(m[1]), unit: 'pc' };
  return null;
}

// A normalized, comparable price-per-unit label (₹/L, ₹/kg, ₹/pc) or null.
function unitPriceLabel(item: CompareItem): string | null {
  const p = parsePack(item.quantityDescription);
  if (!p || !p.qty) return null;
  if (p.unit === 'ml') return `${inr((item.offerPrice / p.qty) * 1000)}/L`;
  if (p.unit === 'g') return `${inr((item.offerPrice / p.qty) * 1000)}/kg`;
  return `${inr(item.offerPrice / p.qty)}/pc`;
}

export function CompareCard({ items, result, onAddWinner }: CompareCardProps) {
  const [added, setAdded] = useState(false);
  if (!items || items.length === 0) return null;

  const winnerId = result?.winnerId;
  const winner = winnerId
    ? items.find((it) => it.spinId === winnerId)
    : undefined;

  const addWinner = () => {
    if (!winner || added) return;
    onAddWinner(winner); // optimistic in the hook — instant tray update
    setAdded(true);
  };

  return (
    <section className="animate-rise rounded-lg border border-hairline bg-canvas p-5">
      {/* Header */}
      <div className="mb-3 flex items-center gap-2">
        <svg
          viewBox="0 0 24 24"
          className="h-4 w-4 shrink-0 text-coral"
          fill="currentColor"
          aria-hidden="true"
        >
          <path d="M12 1.5c.55 5.3 4.7 9.45 10 10-5.3.55-9.45 4.7-10 10-.55-5.3-4.7-9.45-10-10 5.3-.55 9.45-4.7 10-10Z" />
        </svg>
        <h3 className="font-display text-lg leading-tight text-ink">
          Side by side
        </h3>
      </div>

      {/* The matrix — items as aligned columns (scrolls on narrow screens).
          pt-4 leaves headroom so the "Winner" ribbon (which sits -top-2.5 above
          its card) isn't clipped by this scroll container's overflow. */}
      <div className="-mx-1 overflow-x-auto px-1 pb-1 pt-4">
        <div className="flex min-w-min gap-3">
          {items.map((it) => {
            const isWinner = !!winnerId && it.spinId === winnerId;
            const save = it.mrp > it.offerPrice ? it.mrp - it.offerPrice : 0;
            const unit = unitPriceLabel(it);
            const note = result?.notes?.[it.spinId];
            return (
              <div
                key={it.spinId}
                className={`relative flex w-40 shrink-0 flex-col rounded-lg border p-3 transition-colors ${
                  isWinner
                    ? 'border-coral bg-coral/[0.05] ring-1 ring-coral/40'
                    : 'border-hairline bg-surface-card/30'
                }`}
              >
                {isWinner && (
                  <span className="absolute -top-2.5 left-1/2 inline-flex -translate-x-1/2 items-center gap-1 whitespace-nowrap rounded-full bg-coral px-2.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-on-primary shadow-soft">
                    <span aria-hidden="true">✦</span> Winner
                  </span>
                )}

                {/* Image tile */}
                <div className="mb-2 mt-1 aspect-square w-full overflow-hidden rounded-md border border-hairline bg-surface-soft">
                  {it.imageUrl ? (
                    // Plain <img> by design (no next/image): avoids remote-host config.
                    // eslint-disable-next-line @next/next/no-img-element
                    <img decoding="async"
                      src={it.imageUrl}
                      alt={it.name}
                      loading="lazy"
                      className="h-full w-full object-contain p-1.5 mix-blend-multiply"
                    />
                  ) : (
                    <div className="flex h-full w-full items-center justify-center">
                      <span className="font-display text-2xl text-muted-soft">
                        {(it.brand || it.name || '?').trim().charAt(0).toUpperCase()}
                      </span>
                    </div>
                  )}
                </div>

                {/* Brand + name (reserved height so rows align across columns) */}
                {it.brand && (
                  <p className="text-[10px] uppercase tracking-wide text-muted-soft">
                    {it.brand}
                  </p>
                )}
                <h4 className="line-clamp-2 min-h-[2.5em] text-[13px] font-medium leading-snug text-ink">
                  {it.kind === 'food' && typeof it.veg === 'boolean' && (
                    <span
                      className={`mr-1 inline-block h-2.5 w-2.5 translate-y-px rounded-[2px] border align-middle ${
                        it.veg ? 'border-success' : 'border-error'
                      }`}
                      aria-hidden="true"
                    />
                  )}
                  {it.name}
                </h4>

                {/* Pack / qty */}
                <p className="mt-1 min-h-[1.1em] text-[11px] text-muted">
                  {it.quantityDescription || ' '}
                </p>

                {/* Price + MRP→savings */}
                <div className="mt-1.5">
                  <PriceTag offerPrice={it.offerPrice} mrp={it.mrp} size="sm" />
                </div>

                {/* Savings (reserved row) */}
                <p className="mt-1 min-h-[1.1em] text-[11px] font-medium text-teal-ink">
                  {save > 0 ? `Save ${inr(save)}` : ' '}
                </p>

                {/* Comparable ₹/unit (reserved row) */}
                <p className="mt-0.5 min-h-[1.1em] text-[11px] text-muted-soft">
                  {unit ? `${unit}` : ' '}
                </p>

                {/* Per-item qualitative note from the agent */}
                {note && (
                  <p className="mt-2 border-t border-hairline pt-2 text-[11px] leading-snug text-body">
                    {note}
                  </p>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* Verdict + Add-winner CTA */}
      {(result?.verdict || winner) && (
        <div className="mt-4 rounded-lg border border-coral/30 bg-coral/[0.06] p-3.5">
          {result?.verdict && (
            <p className="flex items-start gap-2 text-sm leading-relaxed text-body">
              <span className="mt-px text-coral" aria-hidden="true">
                ✦
              </span>
              <span>
                <span className="font-medium text-ink">Verdict</span> —{' '}
                {result.verdict}
              </span>
            </p>
          )}

          {winner && (
            <button
              type="button"
              onClick={addWinner}
              disabled={added}
              className="mt-3 inline-flex items-center gap-1.5 rounded-md bg-coral px-4 py-2 text-sm font-medium text-on-primary transition-colors hover:bg-coral-active disabled:cursor-default disabled:bg-coral/15 disabled:text-coral"
            >
              {added ? (
                <>
                  <svg
                    viewBox="0 0 24 24"
                    className="h-3.5 w-3.5"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <path d="M20 6 9 17l-5-5" />
                  </svg>
                  Added “{winner.name}”
                </>
              ) : (
                <>Add winner to cart</>
              )}
            </button>
          )}
        </div>
      )}
    </section>
  );
}

export default CompareCard;
