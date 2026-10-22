'use client';

// Small shared pieces for the dark cart trays (Instamart + Food): a disclosure
// chevron, an ⓘ explainer toggle, and the compact "Pay with" row (up to 4
// method icons + "+N more", Scan QR first on desktop). Layout only — the data
// comes from Swiggy's get_payment_options via the callers.

import { useState, useSyncExternalStore } from 'react';
import { isMobileDevice } from '@/frontend/utils/device';

export function Chevron({ open, className = 'h-3.5 w-3.5' }: { open: boolean; className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={`${className} shrink-0 transition-transform duration-200 ${open ? 'rotate-180' : ''}`}
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}

const noopSubscribe = () => () => {};

/** Client-only device check without a hydration mismatch (server = desktop). */
export function useIsMobileDevice(): boolean {
  return useSyncExternalStore(noopSubscribe, isMobileDevice, () => false);
}

export interface PayMethod {
  label: string;
  iconUrl?: string;
  qr?: boolean;
}

const isQrMethod = (m: PayMethod) => m.qr || /\bqr\b|scan/i.test(m.label);

/** ⓘ button that toggles a small explainer paragraph (also a hover tooltip). */
export function InfoToggle({
  open,
  onToggle,
  label,
  text,
}: {
  open: boolean;
  onToggle: () => void;
  label: string;
  text: string;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      aria-label={label}
      title={text}
      className={`inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full transition-colors hover:text-on-dark ${
        open ? 'bg-white/10 text-on-dark' : 'text-on-dark-soft'
      }`}
    >
      <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <circle cx="12" cy="12" r="9" />
        <path d="M12 11v5M12 8h.01" />
      </svg>
    </button>
  );
}

function MethodPill({ m, withLabel }: { m: PayMethod; withLabel: boolean }) {
  if (m.iconUrl && !withLabel) {
    return (
      <span
        title={m.label}
        className="inline-flex h-6 w-7 shrink-0 items-center justify-center rounded-md bg-white/90"
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img decoding="async" src={m.iconUrl} alt={m.label} className="h-4 w-4 object-contain" />
      </span>
    );
  }
  return (
    <span
      title={m.label}
      className={`inline-flex h-6 min-w-0 items-center gap-1 rounded-md bg-white/10 px-1.5 text-[11px] text-on-dark ${
        withLabel ? '' : 'max-w-[88px]'
      }`}
    >
      {m.iconUrl && (
        // eslint-disable-next-line @next/next/no-img-element
        <img decoding="async" src={m.iconUrl} alt="" className="h-3.5 w-3.5 shrink-0 rounded-sm bg-white/90 object-contain" />
      )}
      <span className="truncate">{m.label}</span>
    </span>
  );
}

/**
 * "Pay with" — up to `max` methods inline (icons where Swiggy sends them) and a
 * "+N more" toggle that expands the full labelled list. On desktop a QR method
 * is listed first (UPI app links only open on a phone).
 */
export function PayMethodsRow({
  methods,
  emptyText,
  max = 4,
}: {
  methods: PayMethod[];
  emptyText: string;
  max?: number;
}) {
  const mobile = useIsMobileDevice();
  const [all, setAll] = useState(false);
  const ordered = mobile ? methods : [...methods.filter(isQrMethod), ...methods.filter((m) => !isQrMethod(m))];
  if (!ordered.length) return <span className="min-w-0 truncate text-[11px] text-on-dark-soft">{emptyText}</span>;
  const shown = all ? ordered : ordered.slice(0, max);
  const more = ordered.length - shown.length;
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-1">
      {shown.map((m) => (
        <MethodPill key={m.label} m={m} withLabel={all} />
      ))}
      {(more > 0 || all) && ordered.length > max && (
        <button
          type="button"
          onClick={() => setAll((v) => !v)}
          aria-expanded={all}
          className="inline-flex h-6 items-center rounded-md px-1.5 text-[11px] font-semibold text-on-dark-soft hover:text-on-dark"
        >
          {all ? 'Less' : `+${more} more`}
        </button>
      )}
    </span>
  );
}
