// The serif price treatment used on product cards. Shows the offer price in
// the display serif (ink); when there's a discount it adds the struck-through
// MRP and a teal savings pill ("23% OFF" for meaningful cuts, else "Save ₹N").

import { Badge } from './Badge';

export interface PriceTagProps {
  offerPrice: number;
  mrp: number;
  size?: 'sm' | 'md';
}

function inr(n: number): string {
  return `₹${Math.round(n).toLocaleString('en-IN')}`;
}

export function PriceTag({ offerPrice, mrp, size = 'md' }: PriceTagProps) {
  const hasDiscount = mrp > offerPrice && mrp > 0;
  const pct = hasDiscount ? Math.round(((mrp - offerPrice) / mrp) * 100) : 0;

  const priceClass = size === 'sm' ? 'text-base' : 'text-lg';
  const mrpClass = size === 'sm' ? 'text-xs' : 'text-[13px]';

  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
      <span className={`font-display ${priceClass} leading-none text-ink`}>
        {inr(offerPrice)}
      </span>

      {hasDiscount && (
        <>
          <span className={`${mrpClass} text-muted-soft line-through`}>
            {inr(mrp)}
          </span>
          <Badge tone="teal">
            {pct >= 5 ? `${pct}% OFF` : `Save ${inr(mrp - offerPrice)}`}
          </Badge>
        </>
      )}
    </div>
  );
}

export default PriceTag;
