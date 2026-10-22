'use client';

// One line in the cart, styled for the dark navy panel: a light product thumb,
// the name + pack size, a compact circular −/+ stepper, the serif line total,
// and a quiet × to remove. All mutations are delegated to the parent by spinId.

import { useState } from 'react';
import type { CartLine } from '@/shared/types';

export interface CartLineRowProps {
  line: CartLine;
  onIncrement: (spinId: string) => void;
  onDecrement: (spinId: string) => void;
  onRemove: (spinId: string) => void;
  onSwap?: (line: CartLine) => void; // "Change" — replace this line with an alternative
  disabled?: boolean;
}

function inr(n: number): string {
  return `₹${Math.round(n).toLocaleString('en-IN')}`;
}

const STEP_BTN =
  'inline-flex h-7 w-7 items-center justify-center rounded-full border border-on-dark-soft/40 text-on-dark transition-colors hover:border-coral active:bg-coral active:text-on-primary disabled:cursor-not-allowed disabled:opacity-40';

export function CartLineRow({
  line,
  onIncrement,
  onDecrement,
  onRemove,
  onSwap,
  disabled,
}: CartLineRowProps) {
  const [imgBroken, setImgBroken] = useState(false);
  const monogram = (line.brand || line.name || '?').trim().charAt(0).toUpperCase();
  // Swiggy's per-order cap for this SKU (update_cart would cap it anyway).
  const atCap = !!line.maxQuantity && line.quantity >= line.maxQuantity;

  const capNote = atCap && line.inStock !== false ? line.maxQuantityMessage || `Max ${line.maxQuantity} per order` : '';

  return (
    <div className={`flex gap-3 py-2.5 ${disabled ? 'opacity-60' : ''}`}>
      {/* Thumb */}
      <div className="h-12 w-12 shrink-0 overflow-hidden rounded-lg bg-canvas">
        {line.imageUrl && !imgBroken ? (
          <img decoding="async"
            src={line.imageUrl}
            alt={line.name}
            loading="lazy"
            onError={() => setImgBroken(true)}
            className="h-full w-full object-contain p-1 mix-blend-multiply"
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center">
            <span className="font-display text-lg text-muted-soft">{monogram}</span>
          </div>
        )}
      </div>

      {/* Details */}
      <div className="min-w-0 flex-1">
        <div className="flex items-start justify-between gap-2">
          <p className="line-clamp-2 text-[13px] font-medium leading-snug text-on-dark">{line.name}</p>
          <button
            type="button"
            onClick={() => onRemove(line.spinId)}
            disabled={disabled}
            aria-label={`Remove ${line.name}`}
            className="-mr-1.5 -mt-1 shrink-0 rounded-full p-1 text-on-dark-soft/70 transition-colors hover:text-on-dark disabled:opacity-40"
          >
            <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Pack · availability / Swiggy's per-order cap — one compact line */}
        {(line.quantityDescription || line.inStock === false || capNote) && (
          <p className="mt-0.5 truncate text-[11px] leading-snug text-on-dark-soft" title={capNote || undefined}>
            {line.quantityDescription}
            {line.inStock === false && (
              <span className="text-accent-amber">
                {line.quantityDescription ? ' · ' : ''}Unavailable at this address
              </span>
            )}
            {capNote && (
              <span className="text-accent-amber">
                {line.quantityDescription ? ' · ' : ''}
                {capNote}
              </span>
            )}
          </p>
        )}

        <div className="mt-1.5 flex items-center justify-between gap-2">
          {/* Stepper */}
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => onDecrement(line.spinId)}
              disabled={disabled}
              aria-label={`Decrease ${line.name}`}
              className={STEP_BTN}
            >
              <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden="true">
                <path d="M5 12h14" />
              </svg>
            </button>
            <span className="w-5 text-center text-sm tabular-nums text-on-dark">
              {line.quantity}
            </span>
            <button
              type="button"
              onClick={() => onIncrement(line.spinId)}
              disabled={disabled || atCap}
              title={atCap ? capNote : undefined}
              aria-label={`Increase ${line.name}`}
              className={STEP_BTN}
            >
              <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden="true">
                <path d="M12 5v14M5 12h14" />
              </svg>
            </button>

            {/* Change — replace this line with a brand/alternative the user names */}
            {onSwap && (
              <button
                type="button"
                onClick={() => onSwap(line)}
                disabled={disabled}
                aria-label={`Change ${line.name}`}
                title="Change this for another brand/option"
                className="ml-1 inline-flex items-center gap-1 rounded-full px-1.5 py-1 text-[11px] text-on-dark-soft transition-colors hover:text-coral disabled:opacity-40"
              >
                <svg viewBox="0 0 24 24" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M17 3v4h-4M3 11a5 5 0 0 1 9-3l5 4M7 21v-4h4M21 13a5 5 0 0 1-9 3l-5-4" />
                </svg>
                Change
              </button>
            )}
          </div>

          {/* Line total (MRP struck through when Swiggy discounts it) */}
          <span className="flex shrink-0 items-baseline gap-1.5 leading-tight">
            {line.mrp > line.unitPrice && (
              <span className="text-[11px] text-on-dark-soft line-through">
                {inr(line.mrp * line.quantity)}
              </span>
            )}
            <span className="font-display text-[15px] tabular-nums text-on-dark">
              {inr(line.unitPrice * line.quantity)}
            </span>
          </span>
        </div>
      </div>
    </div>
  );
}

export default CartLineRow;
