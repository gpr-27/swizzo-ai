'use client';

// The AI basket: ONE card for a whole shop ("weekly groceries for 2, ₹1500",
// "refill my usuals"). Every line is a real Swiggy pack the AI picked, with
// its one-line why (₹/unit, rating, delivery time), honest Sponsored labels,
// substitutes for out-of-stock items and per-order caps. The user removes or
// swaps lines, watches the running total against the budget, and taps
// Approve all — only then does the cart change (update_cart via /api/cart).

import { useMemo, useState } from 'react';
import type { BasketLine, BasketPick, InstamartBasket } from '@/shared/types';
import { VegDot } from './ProductCard';

export type BasketAction =
  | { type: 'approve'; removed: string[]; chosen: Record<string, number> }
  | { type: 'dismiss' };

export interface BasketCardProps {
  basket: InstamartBasket;
  sending?: boolean;
  onAction: (action: BasketAction) => void;
  /** follow-up chat turn (e.g. "make it cheaper") */
  onAsk?: (text: string, displayText?: string) => void;
}

function inr(n: number): string {
  return `₹${Math.round(n).toLocaleString('en-IN')}`;
}

function Thumb({ src, alt }: { src?: string; alt: string }) {
  const [broken, setBroken] = useState(false);
  return (
    <div className="h-12 w-12 shrink-0 overflow-hidden rounded-md border border-hairline bg-surface-soft">
      {src && !broken ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img decoding="async" src={src} alt={alt} loading="lazy" onError={() => setBroken(true)} className="h-full w-full object-contain p-1 mix-blend-multiply" />
      ) : (
        <div className="flex h-full w-full items-center justify-center font-display text-sm text-muted-soft">
          {alt.charAt(0).toUpperCase()}
        </div>
      )}
    </div>
  );
}

function LineRow({
  line,
  removed,
  chosen,
  locked,
  onToggle,
  onChoose,
}: {
  line: BasketLine;
  removed: boolean;
  chosen?: number;
  locked: boolean;
  onToggle: () => void;
  onChoose: (i: number | undefined) => void;
}) {
  const p: BasketPick = chosen !== undefined && line.alternatives?.[chosen] ? line.alternatives[chosen] : line;
  const total = p.line.unitPrice * p.quantity;
  const save = Math.max(0, p.line.mrp - p.line.unitPrice) * p.quantity;
  return (
    <li className={`py-3 ${removed ? 'opacity-45' : ''}`}>
      <div className="flex items-start gap-3">
        <Thumb src={p.line.imageUrl} alt={p.line.name} />
        <div className="min-w-0 flex-1">
          <p className="text-[11px] uppercase tracking-wide text-muted-soft">
            {line.need}
            {line.lastOrdered && <span className="normal-case tracking-normal"> · {line.lastOrdered}</span>}
          </p>
          <p className={`flex items-center gap-1.5 text-[14px] leading-snug text-ink ${removed ? 'line-through' : ''}`}>
            <VegDot veg={p.veg} />
            <span className="line-clamp-2">
              {p.line.brand && !/category/i.test(p.line.brand) ? `${p.line.brand} · ` : ''}
              {p.line.name}
            </span>
          </p>
          <p className="mt-0.5 text-xs text-muted">
            {p.line.quantityDescription} × {p.quantity}
            {p.unitPrice && <span className="text-muted-soft"> · {p.unitPrice}</span>}
          </p>
          <div className="mt-1 flex flex-wrap gap-1">
            {p.sponsored && (
              <span className="rounded-full border border-hairline bg-canvas px-1.5 py-0.5 text-[10px] font-medium text-muted" title="Featured / sponsored listing">
                ⭐ Sponsored
              </span>
            )}
            {p.badges?.map((b) => (
              <span key={b} className="rounded-full bg-[#238BF4] px-1.5 py-0.5 text-[10px] font-semibold text-white">
                {b}
              </span>
            ))}
            {line.kind === 'substitute' && (
              <span className="rounded-full bg-accent-amber/15 px-1.5 py-0.5 text-[10px] font-semibold text-accent-amber">Substitute</span>
            )}
            {line.kind === 'overflow' && (
              <span className="rounded-full bg-accent-amber/15 px-1.5 py-0.5 text-[10px] font-semibold text-accent-amber">Top-up</span>
            )}
          </div>
          <p className="mt-1 text-[12px] leading-snug text-body">
            <span className="text-coral" aria-hidden="true">✦ </span>
            {chosen !== undefined ? `Your swap — ${p.reason}` : p.reason}
          </p>
          {line.note && <p className="mt-0.5 text-[11px] leading-snug text-accent-amber">{line.note}</p>}
          {line.capped && <p className="mt-0.5 text-[11px] leading-snug text-accent-amber">Swiggy: {line.capped}</p>}
          {!locked && !removed && !!line.alternatives?.length && (
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              <span className="text-[11px] text-muted-soft">Swap:</span>
              {chosen !== undefined && (
                <button type="button" onClick={() => onChoose(undefined)} className="rounded-full border border-coral/40 px-2 py-0.5 text-[11px] text-coral hover:bg-coral/10">
                  ← AI pick
                </button>
              )}
              {line.alternatives.map((a, i) =>
                i === chosen ? null : (
                  <button
                    key={a.line.spinId}
                    type="button"
                    onClick={() => onChoose(i)}
                    title={a.reason}
                    className="max-w-[14rem] truncate rounded-full border border-hairline px-2 py-0.5 text-[11px] text-muted hover:border-coral/40 hover:text-body"
                  >
                    {a.line.name} · {a.line.quantityDescription} · {inr(a.line.unitPrice)}
                    {a.sponsored ? ' ⭐' : ''}
                  </button>
                ),
              )}
            </div>
          )}
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          <span className="font-display text-[15px] tabular-nums text-ink">{inr(total)}</span>
          {save > 0 && <span className="text-[10px] tabular-nums text-accent-teal">save {inr(save)}</span>}
          {!locked && (
            <button
              type="button"
              onClick={onToggle}
              aria-label={removed ? `Put ${p.line.name} back` : `Remove ${p.line.name}`}
              className="mt-1 rounded-full border border-hairline px-2 py-0.5 text-[11px] text-muted hover:border-coral hover:text-coral"
            >
              {removed ? 'Undo' : 'Remove'}
            </button>
          )}
        </div>
      </div>
    </li>
  );
}

export function BasketCard({ basket, sending, onAction, onAsk }: BasketCardProps) {
  const locked = basket.status === 'approved' || basket.status === 'dismissed';
  const [removed, setRemoved] = useState<Set<string>>(() => new Set(basket.removed ?? []));
  const [chosen, setChosen] = useState<Record<string, number>>(() => basket.chosen ?? {});

  const { total, mrp, count } = useMemo(() => {
    let t = 0;
    let m = 0;
    let c = 0;
    for (const l of basket.lines) {
      if (removed.has(l.id)) continue;
      const alt = chosen[l.id];
      const p = alt !== undefined && l.alternatives?.[alt] ? l.alternatives[alt] : l;
      t += p.line.unitPrice * p.quantity;
      m += Math.max(p.line.mrp, p.line.unitPrice) * p.quantity;
      c++;
    }
    return { total: t, mrp: m, count: c };
  }, [basket.lines, removed, chosen]);

  const budget = basket.budget ?? 0;
  const over = budget > 0 && total > budget;
  const pct = budget > 0 ? Math.min(100, Math.round((total / budget) * 100)) : 0;
  const sponsoredCount = basket.lines.filter((l) => l.sponsored && !removed.has(l.id)).length;

  const toggle = (id: string) =>
    setRemoved((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <section className="mt-3 overflow-hidden rounded-xl border border-coral/30 bg-canvas shadow-soft" aria-label={`AI basket: ${basket.title}`}>
      <header className="border-b border-hairline bg-gradient-to-r from-coral/10 via-amber-500/5 to-transparent px-4 py-3">
        <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-coral">
          ✦ AI basket{basket.source === 'usuals' ? ' · your usuals' : ''}
        </p>
        <div className="mt-0.5 flex items-baseline justify-between gap-3">
          <h3 className="font-display text-lg leading-tight text-ink">{basket.title}</h3>
          <span className="shrink-0 text-xs text-muted">
            {count} of {basket.lines.length} items
          </span>
        </div>
        <div className="mt-2 flex items-end justify-between gap-3">
          <div>
            <p className="font-display text-2xl leading-none tabular-nums text-ink">{inr(total)}</p>
            <p className="mt-1 text-[11px] text-muted">
              item total{mrp > total ? <span className="text-accent-teal"> · saves {inr(mrp - total)} vs MRP</span> : null} · fees from Swiggy&apos;s cart
            </p>
          </div>
          {budget > 0 && (
            <p className={`text-right text-xs font-medium ${over ? 'text-error' : 'text-success-ink'}`}>
              {over ? `${inr(total - budget)} over` : `${inr(budget - total)} under`}
              <span className="block text-[11px] font-normal text-muted">budget {inr(budget)}</span>
            </p>
          )}
        </div>
        {budget > 0 && (
          <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-hairline" role="meter" aria-valuemin={0} aria-valuemax={budget} aria-valuenow={Math.round(total)} aria-label="Basket total against budget">
            <div className={`h-full rounded-full ${over ? 'bg-error' : 'bg-coral'}`} style={{ width: `${pct}%` }} />
          </div>
        )}
        {(!!basket.skippedSponsored || sponsoredCount > 0) && (
          <p className="mt-2 text-[11px] text-muted">
            {basket.skippedSponsored ? `Skipped ${basket.skippedSponsored} sponsored listing${basket.skippedSponsored === 1 ? '' : 's'} for better value. ` : ''}
            {sponsoredCount ? `${sponsoredCount} pick${sponsoredCount === 1 ? ' is' : 's are'} ⭐ Sponsored (still the best fit).` : ''}
          </p>
        )}
      </header>

      <ul className="divide-y divide-hairline px-4">
        {basket.lines.map((l) => (
          <LineRow
            key={l.id}
            line={l}
            removed={removed.has(l.id)}
            chosen={chosen[l.id]}
            locked={locked}
            onToggle={() => toggle(l.id)}
            onChoose={(i) =>
              setChosen((prev) => {
                const next = { ...prev };
                if (i === undefined) delete next[l.id];
                else next[l.id] = i;
                return next;
              })
            }
          />
        ))}
      </ul>

      {!!basket.missing?.length && (
        <div className="border-t border-hairline bg-surface-soft/60 px-4 py-2.5">
          <p className="text-[11px] font-medium uppercase tracking-wide text-muted">Couldn&apos;t add</p>
          {basket.missing.map((m) => (
            <p key={m.need} className="mt-0.5 text-xs text-body">
              <span className="font-medium">{m.need}</span> — {m.why}
            </p>
          ))}
        </div>
      )}

      <footer className="border-t border-hairline px-4 py-3">
        {basket.status === 'approved' ? (
          <p className="text-sm font-medium text-success-ink" role="status">
            ✓ Added {basket.lines.filter((l) => !(basket.removed ?? []).includes(l.id)).length} items to your cart — review the bill there.
          </p>
        ) : basket.status === 'dismissed' ? (
          <p className="text-sm text-muted">Basket dismissed — nothing was added.</p>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                disabled={count === 0}
                onClick={() => onAction({ type: 'approve', removed: [...removed], chosen })}
                className="rounded-lg bg-coral px-4 py-2.5 text-sm font-semibold text-on-primary shadow-soft transition-colors hover:bg-coral-active disabled:cursor-not-allowed disabled:opacity-40"
              >
                Approve all · {count} {count === 1 ? 'item' : 'items'} · {inr(total)}
              </button>
              <button type="button" onClick={() => onAction({ type: 'dismiss' })} className="rounded-lg px-3 py-2.5 text-sm text-muted hover:text-ink">
                Dismiss
              </button>
              {onAsk && over && (
                <button
                  type="button"
                  disabled={sending}
                  onClick={() =>
                    onAsk(
                      `My "${basket.title}" basket is ${inr(total)}, over my ${inr(budget)} budget. Rebuild it with build_basket to fit the budget — cheaper packs or fewer extras, keep the essentials.`,
                      'Make it fit my budget',
                    )
                  }
                  className="rounded-full border border-coral/40 px-3 py-1.5 text-xs text-coral hover:bg-coral/10 disabled:opacity-50"
                >
                  Make it fit {inr(budget)}
                </button>
              )}
            </div>
            <p className="mt-2 text-[11px] text-muted-soft">
              Adds to your Instamart cart only — you still review the bill and tap Checkout. Instamart&apos;s minimum order is ₹99.
            </p>
          </>
        )}
      </footer>
    </section>
  );
}

export default BasketCard;
