'use client';

// One Food / Instamart order on the History page, like a row on the Swiggy
// app's Orders screen: photo, name, area, items, total, date, status badge.
//  - "View details" (Food) expands get_food_order_details inline (items with
//    photos + customisations, Swiggy's bill lines, payment, address).
//  - "Track" (active orders) reads the live status via /api/history/track and
//    links to Swiggy's own tracking page.
//  - "Reorder" (Food) hands the order's reorderMeta lines to the parent, which
//    confirms and loads them into the Food cart.
//  - "Help" — Swiggy has no cancel / complaint tool for placed orders, so we
//    point to customer care (080-67466729) instead of pretending.

import { useEffect, useRef, useState } from 'react';
import type { OrderDetails } from '@/shared/types';
import type { HistoryOrder, StatusTone } from '@/backend/history/history-map';
import { orderStatusLine } from '@/frontend/utils/travel';
import { useLivePoll } from '@/frontend/utils/useLivePoll';
import { ReportProblemButton } from '../features/ReportProblemButton';

export const CARE_PHONE = '080-67466729';

const TONE_CLASS: Record<StatusTone, string> = {
  active: 'bg-amber-500/10 text-amber-700 dark:text-amber-300',
  success: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
  cancelled: 'bg-red-500/10 text-red-700 dark:text-red-400',
  neutral: 'bg-surface-soft text-body',
};

export function StatusBadge({ label, tone }: { label: string; tone: StatusTone }) {
  return (
    <span className={`inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold ${TONE_CLASS[tone]}`}>
      {tone === 'active' && (
        <span className="h-1.5 w-1.5 rounded-full bg-amber-500 motion-safe:animate-pulse" aria-hidden="true" />
      )}
      {label}
    </span>
  );
}

type DetailsState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'ok'; d: OrderDetails }
  | { kind: 'error'; message: string; reportId?: string };

type TrackState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | {
      kind: 'ok';
      tracker: { status: string; eta?: string; partner?: string; items?: string; progress?: number } | null;
      trackUrl?: string;
      message?: string;
      at: number;
    }
  | { kind: 'error'; message: string };

export interface HistoryOrderCardProps {
  order: HistoryOrder;
  addressId: string;
  lat?: number;
  lng?: number;
  /** Reorder (Food): parent shows the confirm dialog. `images` = item photos from the loaded details, by item name. */
  onReorder?: (order: HistoryOrder, images: Record<string, string>) => void;
  /** AI one-liner about this order (insights.ts orderOneLiners) */
  insight?: string;
  /** bump to scroll here and start live tracking (the AI summary's "Track" action) */
  autoTrack?: number;
}

function DetailsPanel({ state, orderId, onRetry }: { state: DetailsState; orderId: string; onRetry: () => void }) {
  if (state.kind === 'idle') return null;
  if (state.kind === 'loading') {
    return (
      <div className="mt-3 space-y-2 rounded-xl bg-canvas p-3" aria-busy="true" aria-label="Loading order details">
        {[0, 1, 2].map((i) => (
          <div key={i} className="flex items-center gap-2">
            <div className="h-9 w-9 shrink-0 animate-pulse rounded-lg bg-surface-soft" />
            <div className="h-3 flex-1 animate-pulse rounded bg-surface-soft" />
          </div>
        ))}
      </div>
    );
  }
  if (state.kind === 'error') {
    return (
      <div className="mt-3 rounded-xl border border-red-500/20 bg-red-500/5 p-3 text-xs text-red-700 dark:text-red-400" role="alert">
        {state.message}{' '}
        <button type="button" onClick={onRetry} className="font-semibold underline">
          Retry
        </button>
        <ReportProblemButton
          service="food"
          tool="get_food_order_details"
          errorMessage={state.message}
          flowDescription="History → View details"
          toolContext={{ orderId }}
          reportId={state.reportId}
        />
      </div>
    );
  }
  const d = state.d;
  // Swiggy returned only text (no parseable lines): show it verbatim.
  if (d.text && d.items.length === 0) {
    return <p className="mt-3 whitespace-pre-line rounded-xl bg-canvas p-3 text-xs leading-relaxed text-body">{d.text}</p>;
  }
  return (
    <div className="mt-3 rounded-xl bg-canvas p-3 text-xs text-body">
      {d.items.length > 0 && (
        <ul className="space-y-2">
          {d.items.map((it, i) => (
            <li key={`${it.name}-${i}`} className="flex items-start gap-2.5">
              {it.imageUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img decoding="async" src={it.imageUrl} alt="" loading="lazy" className="h-10 w-10 shrink-0 rounded-lg bg-surface-soft object-cover" />
              ) : (
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-surface-soft text-sm" aria-hidden="true">
                  🍽️
                </span>
              )}
              <span className="min-w-0 flex-1">
                {it.isVeg !== undefined && (
                  <span
                    role="img"
                    aria-label={it.isVeg ? 'Veg' : 'Non-veg'}
                    className={`mr-1.5 inline-block h-2 w-2 rounded-full align-middle ${it.isVeg ? 'bg-emerald-500' : 'bg-red-500'}`}
                  />
                )}
                <span className="font-medium text-ink">{it.name}</span>
                {it.quantity ? <span className="text-muted"> × {it.quantity}</span> : null}
                {it.customizations && <span className="block text-[11px] text-muted">{it.customizations}</span>}
              </span>
              {it.price && <span className="shrink-0 tabular-nums">{it.price}</span>}
            </li>
          ))}
        </ul>
      )}
      {d.charges.length > 0 && (
        <dl className="mt-2.5 space-y-0.5 border-t border-hairline pt-2 text-[11px] text-muted">
          {d.charges.map((c) => (
            <div key={c.label} className="flex justify-between gap-2">
              <dt className="capitalize">{c.label}</dt>
              <dd className="tabular-nums">{c.amount}</dd>
            </div>
          ))}
        </dl>
      )}
      {d.total && (
        <div className="mt-2 flex justify-between border-t border-hairline pt-2 font-semibold text-ink">
          <span>Total paid</span>
          <span className="tabular-nums">{d.total}</span>
        </div>
      )}
      <dl className="mt-2 space-y-1 text-[11px] text-muted">
        {d.placedAt && (
          <div className="flex gap-2">
            <dt className="w-16 shrink-0">Placed</dt>
            <dd className="text-body">{d.placedAt}</dd>
          </div>
        )}
        {d.paymentMethod && (
          <div className="flex gap-2">
            <dt className="w-16 shrink-0">Payment</dt>
            <dd className="text-body">{d.paymentMethod}</dd>
          </div>
        )}
        {d.coupon && (
          <div className="flex gap-2">
            <dt className="w-16 shrink-0">Coupon</dt>
            <dd className="text-body">{d.coupon}</dd>
          </div>
        )}
        {d.deliveryAddress && (
          <div className="flex gap-2">
            <dt className="w-16 shrink-0">Delivered to</dt>
            <dd className="text-body">{d.deliveryAddress}</dd>
          </div>
        )}
      </dl>
    </div>
  );
}

export function HistoryOrderCard({ order, addressId, lat, lng, onReorder, insight, autoTrack }: HistoryOrderCardProps) {
  const [details, setDetails] = useState<DetailsState>({ kind: 'idle' });
  const [open, setOpen] = useState(false);
  const [track, setTrack] = useState<TrackState>({ kind: 'idle' });
  const [help, setHelp] = useState(false);
  const isFood = order.service === 'food';
  const panelId = `order-${order.service}-${order.orderId}`;

  const loadDetails = async (): Promise<OrderDetails | null> => {
    setDetails({ kind: 'loading' });
    try {
      const res = await fetch(`/api/orders/details?service=food&orderId=${encodeURIComponent(order.orderId)}`);
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        details?: OrderDetails;
        message?: string;
        reportId?: string;
      };
      if (data.ok && data.details) {
        setDetails({ kind: 'ok', d: data.details });
        return data.details;
      }
      setDetails({ kind: 'error', message: data.message || 'Could not load this order.', reportId: data.reportId });
    } catch {
      setDetails({ kind: 'error', message: 'Could not reach the server.' });
    }
    return null;
  };

  const toggleDetails = () => {
    const next = !open;
    setOpen(next);
    if (next && (details.kind === 'idle' || details.kind === 'error')) void loadDetails();
  };

  const cardRef = useRef<HTMLElement>(null);
  const [pollSec, setPollSec] = useState(30);
  // One /api/history/track read. `silent` = the live auto-refresh (keeps the
  // last good status on screen; errors go to the stamp, not the panel).
  const runTrack = async (silent = false): Promise<string | void> => {
    if (!silent) setTrack({ kind: 'loading' });
    try {
      const res = await fetch('/api/history/track', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ service: order.service, orderId: order.orderId, addressId, lat, lng }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        tracker?: { status: string; eta?: string; partner?: string; items?: string } | null;
        trackUrl?: string;
        message?: string;
        pollIntervalSec?: number;
      };
      if (typeof data.pollIntervalSec === 'number' && data.pollIntervalSec > 0) {
        setPollSec(Math.max(10, Math.round(data.pollIntervalSec)));
      }
      if (data.ok) {
        setTrack({ kind: 'ok', tracker: data.tracker ?? null, trackUrl: data.trackUrl, message: data.message, at: Date.now() });
        return;
      }
      if (!silent) setTrack({ kind: 'error', message: data.message || 'Could not track this order.' });
      return data.message || 'Could not track this order.';
    } catch {
      if (!silent) setTrack({ kind: 'error', message: 'Could not reach the server.' });
      return 'Could not reach the server.';
    }
  };

  // Once tracked, keep the status live while the card is on screen (Swiggy's
  // pollIntervalSec, never faster than 10 s) until it is delivered / cancelled.
  const liveDone = track.kind === 'ok' && !!track.tracker && /deliver(ed)?$|cancel|refund|fail|completed/i.test(track.tracker.status);
  useLivePoll(() => runTrack(true), {
    intervalMs: pollSec * 1000,
    enabled: order.active && track.kind === 'ok' && !liveDone,
    ref: cardRef,
    maxDurationMs: 60 * 60_000,
  });

  // The AI summary's "Track" action: scroll here and read the live status.
  const lastAuto = useRef(0);
  useEffect(() => {
    if (!autoTrack || autoTrack === lastAuto.current) return;
    lastAuto.current = autoTrack;
    cardRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    void runTrack();
    // runTrack is recreated each render; the nonce is the trigger
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoTrack]);

  // Reorder shows each dish's official photo, which only the order-details
  // text carries ("[image: url]") — load it first if needed (fast, read-only;
  // on failure the dialog still opens, with placeholders).
  const [preparing, setPreparing] = useState(false);
  const reorder = async () => {
    if (!onReorder) return;
    let d = details.kind === 'ok' ? details.d : null;
    if (!d) {
      setPreparing(true);
      d = await loadDetails();
      setPreparing(false);
    }
    const images: Record<string, string> = {};
    for (const it of d?.items ?? []) if (it.imageUrl) images[it.name.toLowerCase()] = it.imageUrl;
    onReorder(order, images);
  };

  const meta = [
    order.placedAt,
    order.itemCount ? `${order.itemCount} item${order.itemCount === 1 ? '' : 's'}` : '',
    order.orderType && order.orderType.toLowerCase() !== 'regular' ? order.orderType : '',
  ]
    .filter(Boolean)
    .join(' · ');
  const btn =
    'inline-flex min-h-9 items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-semibold transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-coral disabled:opacity-50';

  return (
    <article
      ref={cardRef}
      aria-labelledby={`${panelId}-title`}
      className="rounded-2xl border border-hairline bg-surface-card/70 p-3.5 shadow-xs transition-shadow hover:shadow-sm sm:p-4"
    >
      <div className="flex gap-3">
        {order.imageUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img decoding="async"
            src={order.imageUrl}
            alt=""
            loading="lazy"
            className="h-16 w-16 shrink-0 rounded-xl bg-surface-soft object-cover sm:h-[72px] sm:w-[72px]"
          />
        ) : (
          <span
            className="flex h-16 w-16 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-coral/15 to-amber-500/10 text-2xl sm:h-[72px] sm:w-[72px]"
            aria-hidden="true"
          >
            {isFood ? '🍽️' : '🛒'}
          </span>
        )}
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <h3 id={`${panelId}-title`} className="truncate text-sm font-semibold text-ink sm:text-[15px]">
                {order.title}
              </h3>
              {order.area && <p className="truncate text-[11px] text-muted">{order.area}</p>}
            </div>
            <StatusBadge label={order.active && order.tone === 'active' ? order.status || 'On the way' : order.status} tone={order.tone} />
          </div>
          {order.items && <p className="mt-1 line-clamp-2 text-xs text-body">{order.items}</p>}
          {insight && (
            <p className="mt-1 flex items-start gap-1 text-[11px] leading-snug text-coral">
              <span aria-hidden="true">✦</span>
              <span>{insight}</span>
            </p>
          )}
          {order.rateActions && order.rateActions.length > 0 && (
            <p className="mt-1 text-[11px] text-muted">
              <span aria-hidden="true">★ </span>
              {order.rateActions.join(' · ')} — rate it in the Swiggy app
            </p>
          )}
          <div className="mt-1.5 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
            <p className="text-[11px] text-muted">{meta}</p>
            {order.total && <p className="font-display text-sm font-bold tabular-nums text-ink">{order.total}</p>}
          </div>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-hairline pt-3">
        {order.active && (
          <button
            type="button"
            onClick={() => void runTrack()}
            disabled={track.kind === 'loading'}
            className={`${btn} border-amber-500/40 bg-amber-500/10 text-amber-800 hover:bg-amber-500/20 dark:text-amber-200`}
          >
            {track.kind === 'loading' ? 'Tracking…' : track.kind === 'ok' ? 'Refresh status' : 'Track order'}
          </button>
        )}
        {isFood && order.reorder && onReorder && (
          <button
            type="button"
            onClick={() => void reorder()}
            disabled={preparing}
            className={`${btn} border-coral bg-coral text-on-primary hover:bg-coral-active`}
            aria-label={`Reorder from ${order.title}`}
          >
            <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M3 12a9 9 0 0 1 15.5-6.2L21 8M21 3v5h-5M21 12a9 9 0 0 1-15.5 6.2L3 16M3 21v-5h5" />
            </svg>
            {preparing ? 'Preparing…' : 'Reorder'}
          </button>
        )}
        {isFood && (
          <button
            type="button"
            onClick={toggleDetails}
            aria-expanded={open}
            aria-controls={`${panelId}-details`}
            className={`${btn} border-hairline text-body hover:border-coral/50 hover:text-ink`}
          >
            {open ? 'Hide details' : 'View details'}
          </button>
        )}
        <button
          type="button"
          onClick={() => setHelp((v) => !v)}
          aria-expanded={help}
          className={`${btn} ml-auto border-transparent text-muted hover:text-ink`}
        >
          Help
        </button>
      </div>

      {track.kind === 'ok' && (
        <div className="mt-2.5 rounded-xl border border-amber-500/25 bg-amber-500/5 p-3 text-xs" role="status" aria-live="polite">
          {track.tracker ? (
            <>
              <p className="font-semibold text-ink">
                {track.tracker.status}
                {track.tracker.eta && <span className="font-normal text-body"> · arriving in about {track.tracker.eta}</span>}
              </p>
              {typeof track.tracker.progress === 'number' && (
                <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-amber-500/15" aria-label={`${track.tracker.progress}% done`}>
                  <div className="h-full rounded-full bg-amber-500" style={{ width: `${track.tracker.progress}%` }} />
                </div>
              )}
              <p className="mt-1 text-ink">
                <span className="text-coral" aria-hidden="true">✦ </span>
                {orderStatusLine(track.tracker, track.at)}
              </p>
              {track.tracker.partner && <p className="mt-0.5 text-body">{track.tracker.partner}</p>}
              {track.tracker.items && <p className="mt-0.5 text-muted">{track.tracker.items}</p>}
            </>
          ) : (
            <p className="text-body">{track.message || "Swiggy didn't return a live status right now."}</p>
          )}
          <div className="mt-2 flex flex-wrap items-center gap-3">
            {track.trackUrl && (
              <a
                href={track.trackUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="font-semibold text-coral hover:underline"
              >
                Open Swiggy tracking ↗
              </a>
            )}
            <span className="text-[11px] text-muted">
              Updated {new Date(track.at).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' })}
            </span>
          </div>
        </div>
      )}
      {track.kind === 'error' && (
        <p className="mt-2.5 text-xs text-red-700 dark:text-red-400" role="alert">
          {track.message}
        </p>
      )}

      {help && (
        <div className="mt-2.5 rounded-xl bg-surface-soft p-3 text-xs text-body">
          <p>
            To cancel, change or report a problem with this order, call Swiggy customer care at{' '}
            <a href={`tel:${CARE_PHONE.replace(/-/g, '')}`} className="font-semibold text-coral hover:underline">
              {CARE_PHONE}
            </a>
            . Swiggy doesn&apos;t let apps cancel placed orders.
          </p>
          <p className="mt-1 text-[11px] text-muted">Order #{order.orderId}</p>
        </div>
      )}

      {isFood && open && (
        <div id={`${panelId}-details`}>
          <DetailsPanel state={details} orderId={order.orderId} onRetry={() => void loadDetails()} />
        </div>
      )}
    </article>
  );
}

export default HistoryOrderCard;
