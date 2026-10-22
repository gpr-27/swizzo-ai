// Required Swiggy Builders Club attribution: square logo + the exact phrase
// "Powered by Swiggy" (Food) / "Powered by Instamart" / "Powered by Dineout",
// next to each service's results, cart, order/booking and confirmation.
// Brand rules (docs/swiggy-mcp/platform.md §8): logo 32px (24px compact) at
// its 1:1 ratio, text 16px (14px compact), 8px gap, 8px clear space, full
// opacity, ≥ 4.5:1 contrast. The logo is decorative because the phrase is
// live text. Keep buttons/controls OUTSIDE this badge.
//
// Logos in /public/brand/*-square.png are the official artwork from
// https://mcp.swiggy.com/builders/docs/operate/brand-guidelines (cropped from
// the published lockups). Scenes has no published badge yet, so it uses the
// Swiggy attribution until Swiggy says otherwise.

import type { Service } from '@/shared/types';

const BRAND: Record<Service, { label: string; logo: string }> = {
  food: { label: 'Powered by Swiggy', logo: '/brand/food-square.png' },
  instamart: { label: 'Powered by Instamart', logo: '/brand/instamart-square.png' },
  dineout: { label: 'Powered by Dineout', logo: '/brand/dineout-square.png' },
  scenes: { label: 'Powered by Swiggy', logo: '/brand/food-square.png' },
  // Plan composes all four Swiggy services.
  plan: { label: 'Powered by Swiggy', logo: '/brand/food-square.png' },
};

export interface PoweredByProps {
  service: Service;
  /** compact = 24px logo / 14px text (minimums); default 32px / 16px. */
  compact?: boolean;
  className?: string;
}

export function PoweredBy({ service, compact = false, className = '' }: PoweredByProps) {
  const brand = BRAND[service];
  const logo = compact ? 24 : 32;
  return (
    <span
      className={`inline-flex max-w-full shrink-0 items-center gap-2 p-2 align-middle ${className}`}
      data-attribution={service}
    >
      {/* eslint-disable-next-line @next/next/no-img-element -- fixed-size brand artwork, must not be re-encoded */}
      <img decoding="async"
        src={brand.logo}
        alt=""
        aria-hidden="true"
        width={logo}
        height={logo}
        className="shrink-0 rounded-[20%] object-contain"
        style={{ width: logo, height: logo }}
      />
      <span
        className="font-medium leading-tight text-ink whitespace-nowrap"
        style={{ fontSize: compact ? 14 : 16 }}
      >
        {brand.label}
      </span>
    </span>
  );
}

export default PoweredBy;
