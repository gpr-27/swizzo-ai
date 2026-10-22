'use client';

// A live order-status card dropped inline into the chat thread — the moment a
// meal is actually on its way. A coral-tinted scooter badge, the status set in
// serif with a pulsing coral dot beside it, the ETA in muted text, and a quiet
// partner + items line when we know them. Every field below `status` is
// optional, so the card stays composed even with only a status to show.

export interface OrderTrackerProps {
  status: string;
  eta?: string;
  partner?: string;
  items?: string;
  trackUrl?: string; // Food: Swiggy's own tracking page
  progress?: number; // Food: track_food_order progressPercentage (0–100)
}

export function OrderTracker({ status, eta, partner, items, trackUrl, progress }: OrderTrackerProps) {
  const detail = [partner, items].filter(Boolean).join(' · ');

  return (
    <div
      role="status"
      aria-label={`Order status: ${status}${eta ? `, ${eta}` : ''}`}
      className="animate-rise rounded-lg border border-hairline bg-canvas p-4 shadow-soft"
    >
      <div className="flex items-center gap-3.5">
        {/* Coral-tinted scooter badge */}
        <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-coral/10 text-coral">
          <svg viewBox="0 0 24 24" className="h-[22px] w-[22px]" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <circle cx="6" cy="17" r="2.6" />
            <circle cx="18" cy="17" r="2.6" />
            <path d="M15.4 17H8.6" />
            <path d="M15.4 17 12.2 9H10" />
            <path d="M16.2 7.8h2.6" />
            <path d="M17.6 7.8 18 14.4" />
          </svg>
        </span>

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="font-display text-lg leading-tight text-ink">
              {status}
            </span>
            {/* Pulsing coral dot */}
            <span className="relative flex h-2 w-2 shrink-0" aria-hidden="true">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-coral opacity-60" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-coral" />
            </span>
          </div>

          {eta && <p className="mt-0.5 text-sm text-muted">{eta}</p>}

          {detail && (
            <p className="mt-1 truncate text-xs text-muted-soft">{detail}</p>
          )}

          {typeof progress === 'number' && (
            <div
              className="mt-2 h-1.5 overflow-hidden rounded-full bg-coral/10"
              role="progressbar"
              aria-valuenow={progress}
              aria-valuemin={0}
              aria-valuemax={100}
            >
              <div className="h-full rounded-full bg-coral transition-all" style={{ width: `${progress}%` }} />
            </div>
          )}

          {trackUrl && (
            <a
              href={trackUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-1.5 inline-block text-xs font-semibold text-coral hover:underline"
            >
              Track on Swiggy ↗
            </a>
          )}
        </div>
      </div>
    </div>
  );
}

export default OrderTracker;
