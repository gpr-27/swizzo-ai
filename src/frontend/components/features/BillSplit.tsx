'use client';

// Bill-split ESTIMATE. Dineout: Swiggy's "cost for two" × guests, the deal's
// bill discount and a paid deal's booking fee, split across the people paying.
// Scenes: ticket price × tickets (+ cover), per person admitted. Always
// labelled an estimate — the restaurant's bill / Swiggy's cart is the real
// number.

import { useState } from 'react';
import { admitsPerTicket, dineoutSplit, formatINR, parseCostForTwo, scenesSplit } from '@/frontend/utils/split';

export type BillSplitProps =
  | {
      kind: 'dineout';
      costForTwo?: string;
      guests: number;
      discountPct?: number;
      bookingFee?: number;
      compact?: boolean;
    }
  | {
      kind: 'scenes';
      price?: number;
      tickets: number;
      ticketName?: string;
      coverCharge?: number;
      /** Swiggy's cart total when known (replaces price × tickets) */
      total?: number;
      compact?: boolean;
    };

function Stepper({ label, value, min, max, onChange }: { label: string; value: number; min: number; max: number; onChange: (n: number) => void }) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-[11px] text-muted">{label}</span>
      <div className="flex items-center rounded-lg border border-hairline bg-canvas">
        <button
          type="button"
          aria-label={`Fewer ${label.toLowerCase()}`}
          disabled={value <= min}
          onClick={() => onChange(Math.max(min, value - 1))}
          className="h-7 w-7 text-sm text-muted hover:text-ink disabled:opacity-30"
        >
          −
        </button>
        <span className="w-6 text-center text-xs font-semibold tabular-nums text-ink">{value}</span>
        <button
          type="button"
          aria-label={`More ${label.toLowerCase()}`}
          disabled={value >= max}
          onClick={() => onChange(Math.min(max, value + 1))}
          className="h-7 w-7 text-sm text-muted hover:text-ink disabled:opacity-30"
        >
          +
        </button>
      </div>
    </div>
  );
}

export function BillSplit(props: BillSplitProps) {
  const guestsDefault = props.kind === 'dineout' ? props.guests : props.tickets * admitsPerTicket(props.ticketName);
  const [payers, setPayers] = useState<number | null>(null);

  if (props.kind === 'dineout') {
    const cft = parseCostForTwo(props.costForTwo);
    if (!cft) return null;
    const people = Math.max(1, props.guests);
    const split = dineoutSplit({
      costForTwo: cft,
      guests: people,
      payers: payers ?? people,
      discountPct: props.discountPct,
      bookingFee: props.bookingFee,
    });
    return (
      <div className="rounded-xl border border-hairline bg-surface-card/50 p-3 text-xs">
        <div className="flex items-center justify-between gap-2">
          <span className="font-semibold text-ink">Bill split</span>
          <span className="rounded-full bg-amber-500/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-amber-700 dark:text-amber-300">
            Estimate
          </span>
        </div>
        <dl className="mt-2 space-y-1 text-body">
          <div className="flex justify-between gap-2">
            <dt>
              {props.costForTwo} × {people} guest{people === 1 ? '' : 's'}
            </dt>
            <dd className="tabular-nums">{formatINR(split.total)}</dd>
          </div>
          {split.discountPct && split.totalAfterDiscount !== undefined && (
            <div className="flex justify-between gap-2 text-emerald-700 dark:text-emerald-400">
              <dt>Deal: {split.discountPct}% off the bill</dt>
              <dd className="tabular-nums">−{formatINR(split.total - split.totalAfterDiscount)}</dd>
            </div>
          )}
          {split.bookingFee && (
            <div className="flex justify-between gap-2">
              <dt>Booking fee (paid to Swiggy)</dt>
              <dd className="tabular-nums">+{formatINR(split.bookingFee)}</dd>
            </div>
          )}
        </dl>
        <div className="mt-2 flex flex-wrap items-center justify-between gap-2 border-t border-hairline pt-2">
          <Stepper label="Paying" value={split.payers} min={1} max={people} onChange={setPayers} />
          <span className="font-display text-sm font-bold text-ink">
            ≈ {formatINR(split.perPayer)} <span className="text-[11px] font-normal text-muted">each</span>
          </span>
        </div>
        {!props.compact && (
          <p className="mt-1.5 text-[10px] leading-relaxed text-muted">
            From Swiggy&apos;s average cost for two; drinks, taxes and service charge vary. The restaurant&apos;s bill is final.
          </p>
        )}
      </div>
    );
  }

  const admits = admitsPerTicket(props.ticketName);
  const base =
    props.total !== undefined
      ? { tickets: props.tickets, people: props.tickets * admits, total: props.total, perPerson: props.total / (props.tickets * admits) }
      : props.price !== undefined
        ? scenesSplit({ price: props.price, tickets: props.tickets, admits, coverCharge: props.coverCharge })
        : null;
  if (!base || base.total <= 0) return null;
  const people = payers ?? base.people;
  return (
    <div className="rounded-xl border border-hairline bg-surface-card/50 p-3 text-xs">
      <div className="flex items-center justify-between gap-2">
        <span className="font-semibold text-ink">Split the tickets</span>
        <span className="rounded-full bg-amber-500/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-amber-700 dark:text-amber-300">
          {props.total !== undefined ? 'Swiggy total' : 'Estimate'}
        </span>
      </div>
      <p className="mt-1.5 text-body">
        {base.tickets} ticket{base.tickets === 1 ? '' : 's'}
        {admits > 1 ? ` (admits ${admits} each)` : ''} · {formatINR(base.total)}
      </p>
      <div className="mt-2 flex flex-wrap items-center justify-between gap-2 border-t border-hairline pt-2">
        <Stepper label="People" value={people} min={1} max={Math.max(guestsDefault, 1) * 2} onChange={setPayers} />
        <span className="font-display text-sm font-bold text-ink">
          ≈ {formatINR(base.total / Math.max(1, people))} <span className="text-[11px] font-normal text-muted">each</span>
        </span>
      </div>
      {!props.compact && props.total === undefined && (
        <p className="mt-1.5 text-[10px] text-muted">Ticket price × count; Swiggy confirms the final amount at checkout.</p>
      )}
    </div>
  );
}

export default BillSplit;
