'use client';

// The order-status card with LIVE refresh for an active Food / Instamart
// order: while it is on screen and the tab is visible it re-reads
// POST /api/track (track_order / get_delivery_status, track_food_order /
// get_food_delivery_status) at Swiggy's own pollIntervalSec — never faster
// than 10 s, default 30 s — and stops once the order is delivered or
// cancelled. A status change raises a toast, plus a browser notification when
// the user allowed it.

import { useRef, useState } from 'react';
import { getFoodAddressId } from '@/frontend/state/foodAddress';
import { notify, notificationPermission, requestNotifications } from '@/frontend/utils/notify';
import { orderStatusLine } from '@/frontend/utils/travel';
import { useLivePoll } from '@/frontend/utils/useLivePoll';
import { LiveStamp } from './LiveStamp';
import { OrderTracker, type OrderTrackerProps } from './OrderTracker';

const DONE = /deliver(ed)?$|cancel|refund|fail|completed/i;
const MIN_SEC = 10;
const DEFAULT_SEC = 30;

export interface LiveOrderTrackerProps extends OrderTrackerProps {
  /** which tracking route to poll; without it the card is static */
  service?: 'food' | 'instamart';
}

export function LiveOrderTracker({ service, ...initial }: LiveOrderTrackerProps) {
  const [state, setState] = useState<OrderTrackerProps>(initial);
  const [intervalSec, setIntervalSec] = useState(DEFAULT_SEC);
  const [perm, setPerm] = useState(() => notificationPermission());
  const [mountedAt] = useState(() => Date.now());
  const ref = useRef<HTMLDivElement>(null);
  const statusRef = useRef(initial.status);
  const done = DONE.test(state.status);

  const poll = useLivePoll(
    async (signal) => {
      const addressId = getFoodAddressId();
      const res = await fetch('/api/track', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ service, addressId }),
        signal,
      });
      if (res.status === 401) return 'Log in again to keep tracking';
      const data = (await res.json().catch(() => ({}))) as {
        tracker?: OrderTrackerProps | null;
        pollIntervalSec?: number;
      };
      if (typeof data.pollIntervalSec === 'number' && data.pollIntervalSec > 0) {
        setIntervalSec(Math.max(MIN_SEC, Math.round(data.pollIntervalSec)));
      }
      const t = data.tracker;
      if (!res.ok || !t?.status) return "Swiggy didn't return a status";
      if (t.status !== statusRef.current) {
        const before = statusRef.current;
        statusRef.current = t.status;
        notify({
          key: `order-${service}-${t.status}`,
          title: `${service === 'food' ? 'Food order' : 'Instamart order'}: ${t.status}`,
          body: [t.eta, before ? `was ${before}` : ''].filter(Boolean).join(' · ') || undefined,
          tone: /deliver/i.test(t.status) ? 'success' : /cancel|fail/i.test(t.status) ? 'error' : 'info',
        });
      }
      setState({
        status: t.status,
        eta: t.eta,
        partner: t.partner,
        items: t.items ?? state.items,
        trackUrl: t.trackUrl ?? state.trackUrl,
        progress: t.progress,
      });
    },
    {
      intervalMs: intervalSec * 1000,
      minIntervalMs: MIN_SEC * 1000,
      enabled: !!service && !done,
      ref,
      maxDurationMs: 90 * 60_000,
      initialUpdated: mountedAt,
    },
  );

  return (
    <div ref={ref}>
      <OrderTracker {...state} />
      {/* AI status line from Swiggy's own status / ETA / partner (no invented figures) */}
      {state.status && (
        <p className="mt-1.5 flex items-start gap-1.5 px-1 text-xs leading-relaxed text-ink" aria-live="polite">
          <span className="text-coral" aria-hidden="true">
            ✦
          </span>
          <span>{orderStatusLine(state, poll.lastUpdated ?? mountedAt)}</span>
        </p>
      )}
      {service && !done && (
        <div className="mt-1.5 flex flex-wrap items-center justify-between gap-2 px-1">
          <LiveStamp
            lastUpdated={poll.lastUpdated}
            live={poll.live}
            refreshing={poll.refreshing}
            onRefresh={poll.refresh}
            cadence={`every ${intervalSec} s`}
            error={poll.error}
          />
          {perm === 'default' && (
            <button
              type="button"
              onClick={async () => setPerm(await requestNotifications())}
              className="text-[11px] font-semibold text-muted hover:text-ink"
            >
              🔔 Notify me
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export default LiveOrderTracker;
