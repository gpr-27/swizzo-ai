'use client';

// A Dineout table / Scenes ticket booking card. Status is exactly what Swiggy
// reported. "Refresh" re-reads it (get_booking_status / get_event_booking_status
// via /api/bookings). Dineout bookings also get "Cancel booking", which asks
// "Cancel booking #…?" first and then calls cancel_booking — Swiggy hasn't
// rolled that tool out to every account, so the server says so (and points to
// the Dineout app / 080-67466729) instead of pretending. Scenes has no cancel
// tool at all.
//
// LIVE: while the card is on screen and the tab visible, a booking that isn't
// final re-reads its status every 30 s (pending / processing) or 2 min
// (confirmed), never faster than 10 s; a change raises a toast (and a browser
// notification when allowed). Bookings made here also get a countdown chip,
// Add to calendar, Directions, Share and a bill-split estimate.

import { useRef, useState } from 'react';
import type { ChatMessage } from '@/shared/types';
import { notify, notificationPermission, requestNotifications } from '@/frontend/utils/notify';
import { useOrigin } from '@/frontend/state/origin';
import { parseBookingWhen } from '@/frontend/utils/time';
import { bookingStatusLine, tripKm } from '@/frontend/utils/travel';
import { useLivePoll } from '@/frontend/utils/useLivePoll';
import { BillSplit } from './BillSplit';
import { BookingActions, CountdownChip } from './BookingActions';
import { LiveStamp } from './LiveStamp';
import { ReportProblemButton } from './ReportProblemButton';

export type BookingTrackerData = NonNullable<ChatMessage['bookingTracker']>;

/** Badge colour for a booking / order status exactly as Swiggy reported it. */
export function bookingStatusClass(status: string): string {
  const s = status.toLowerCase();
  if (/cancel|fail|reject|refund|expired/.test(s)) return 'bg-red-500/10 text-red-700 dark:text-red-400';
  if (/pending|processing|initiated|awaiting/.test(s)) return 'bg-amber-500/10 text-amber-800 dark:text-amber-400';
  if (/confirm|success|booked|completed|placed|paid/.test(s)) return 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400';
  return 'bg-surface-card text-body';
}

const FINAL = /cancel|fail|reject|refund|expired|complet|no.?show/i;
const PENDING = /pending|processing|initiated|awaiting/i;

const pretty = (status: string) => status.replace(/_/g, ' ').toLowerCase();

export function BookingTrackerCard({ tracker }: { tracker: BookingTrackerData }) {
  // Local re-reads layer over the prop, so the hook's own updates still show.
  const [override, setOverride] = useState<Partial<BookingTrackerData>>({});
  const live: BookingTrackerData = { ...tracker, ...override };
  const [busy, setBusy] = useState<'' | 'refresh' | 'cancel'>('');
  const [confirming, setConfirming] = useState(false);
  const [note, setNote] = useState<{ text: string; error?: boolean; reportId?: string; tool?: string } | null>(null);
  const [cancelUnavailable, setCancelUnavailable] = useState(false);
  const [showSplit, setShowSplit] = useState(false);
  const [notifyState, setNotifyState] = useState(() => notificationPermission());
  const cardRef = useRef<HTMLDivElement>(null);
  const [mountedAt] = useState(() => Date.now());
  const statusRef = useRef(live.status);
  const origin = useOrigin();

  // One get_booking_status / get_event_booking_status read. `silent` = the
  // auto-refresh (errors go to the live stamp, not the note).
  const readStatus = async (signal?: AbortSignal, silent = false): Promise<string | void> => {
    const res = await fetch('/api/bookings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: [{ kind: live.kind, orderId: live.orderId }] }),
      signal,
    });
    const data = (await res.json().catch(() => ({}))) as {
      bookings?: { ok: boolean; status?: string; title?: string; details?: string; error?: string }[];
      message?: string;
    };
    const row = data.bookings?.[0];
    if (row?.ok && row.status) {
      if (row.status !== statusRef.current) {
        const before = statusRef.current;
        statusRef.current = row.status;
        if (before) {
          const bad = FINAL.test(row.status) && !/complet/i.test(row.status);
          notify({
            key: `booking-${live.orderId}-${row.status}`,
            title: `${live.kind === 'dineout' ? 'Table booking' : 'Tickets'}: ${pretty(row.status)}`,
            body: `${row.title || live.title} · was ${pretty(before)}`,
            tone: bad ? 'error' : /confirm|success|booked/i.test(row.status) ? 'success' : 'info',
          });
        }
      }
      setOverride((o) => ({
        ...o,
        status: row.status as string,
        ...(row.title ? { title: row.title } : {}),
        ...(row.details ? { details: row.details } : {}),
      }));
      return;
    }
    const msg = row?.error || data.message || 'Could not refresh this booking.';
    if (!silent) {
      setNote({
        text: msg,
        error: true,
        tool: live.kind === 'dineout' ? 'get_booking_status' : 'get_event_booking_status',
      });
    }
    return msg;
  };

  const isFinal = FINAL.test(live.status);
  // The slot / show time when this app made the booking; else Swiggy's display text.
  const startsAt = live.startsAt ?? parseBookingWhen(live.details);
  // Long over (6 h past the start) → nothing left to watch.
  const over = !!startsAt && mountedAt > startsAt + 6 * 3_600_000;
  const poll = useLivePoll((signal) => readStatus(signal, true), {
    intervalMs: PENDING.test(live.status) ? 30_000 : 120_000,
    enabled: !isFinal && !over,
    ref: cardRef,
    initialUpdated: mountedAt,
  });

  const refresh = async () => {
    setBusy('refresh');
    setNote(null);
    try {
      await readStatus();
    } catch {
      setNote({ text: 'Could not reach the server.', error: true });
    } finally {
      setBusy('');
    }
  };

  const cancel = async () => {
    setBusy('cancel');
    setConfirming(false);
    setNote(null);
    try {
      const res = await fetch('/api/dineout/booking', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orderId: live.orderId, action: 'cancel' }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        status?: string;
        message?: string;
        unavailable?: boolean;
        gated?: boolean;
        reportId?: string;
      };
      if (data.ok && data.status) {
        setOverride((o) => ({ ...o, status: data.status }));
        setNote({ text: 'Swiggy cancelled this booking.' });
      } else {
        if (data.unavailable) setCancelUnavailable(true);
        setNote({
          text: data.message || 'Cancellation failed. Use the Swiggy Dineout app or call 080-67466729.',
          error: !data.unavailable && !data.gated,
          reportId: data.reportId,
          tool: 'cancel_booking',
        });
      }
    } catch {
      setNote({
        text: "We couldn't confirm whether Swiggy received this. Check the booking in the Swiggy Dineout app before trying again.",
        error: true,
      });
    } finally {
      setBusy('');
    }
  };

  const canCancel = live.kind === 'dineout' && !isFinal && !cancelUnavailable;
  const cancelled = /cancel|fail|reject|refund|expired/i.test(live.status);
  const facts = {
    kind: live.kind,
    orderId: live.orderId,
    title: live.title,
    status: live.status,
    details: live.details,
    startsAt,
    endsAt: live.endsAt,
    place: live.place,
    address: live.address,
    lat: live.lat,
    lng: live.lng,
    mapUrl: live.mapUrl,
    guests: live.guests,
  };
  // AI status line: Swiggy's status + booking time + the real venue distance
  // (Swiggy's map link / venue coordinates) → "leave by" estimate.
  const km = tripKm({ mapUrl: live.mapUrl, venue: { lat: live.lat, lng: live.lng }, origin });
  const aiLine = bookingStatusLine(
    { kind: live.kind, status: live.status, place: live.place, title: live.title, startsAt, km },
    poll.lastUpdated ?? mountedAt,
  );
  const canSplit =
    live.kind === 'dineout' ? !!live.costForTwo && !!live.guests : (live.amount ?? 0) > 0 || (live.unitPrice ?? 0) > 0;

  return (
    <div ref={cardRef} className="mt-3 rounded-2xl border border-hairline bg-surface-card/60 p-4 shadow-xs animate-rise">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="flex h-7 w-7 items-center justify-center rounded-xl bg-coral/10 text-sm">
            {live.kind === 'dineout' ? '🥂' : '🎟️'}
          </span>
          <div>
            <h4 className="font-display text-sm font-semibold text-ink">{live.title}</h4>
            <p className="text-[11px] text-muted">Order #{live.orderId.slice(-8)}</p>
          </div>
        </div>
        <span
          className={`rounded-full px-2.5 py-0.5 text-xs font-semibold capitalize ${bookingStatusClass(live.status)}`}
        >
          {live.status.replace(/_/g, ' ').toLowerCase()}
        </span>
      </div>
      {live.details && (
        <p className="mt-2.5 text-xs text-body border-t border-hairline pt-2.5 leading-relaxed">{live.details}</p>
      )}
      {aiLine && (
        <p className="mt-2 flex items-start gap-1.5 text-xs leading-relaxed text-ink" aria-live="polite">
          <span className="text-coral" aria-hidden="true">
            ✦
          </span>
          <span>{aiLine}</span>
        </p>
      )}
      {startsAt && !cancelled && <CountdownChip startsAt={startsAt} endsAt={live.endsAt} className="mt-2" />}

      <BookingActions booking={facts} cancelled={cancelled} />

      {canSplit && !cancelled && (
        <div className="mt-2">
          <button
            type="button"
            onClick={() => setShowSplit((v) => !v)}
            aria-expanded={showSplit}
            className="text-[11px] font-semibold text-muted hover:text-ink"
          >
            {showSplit ? 'Hide bill split' : '➗ Split the bill (estimate)'}
          </button>
          {showSplit && (
            <div className="mt-1.5">
              {live.kind === 'dineout' ? (
                <BillSplit kind="dineout" costForTwo={live.costForTwo} guests={live.guests ?? 2} />
              ) : (
                <BillSplit
                  kind="scenes"
                  tickets={live.guests ?? 1}
                  price={live.unitPrice}
                  total={live.amount}
                  ticketName={live.title}
                />
              )}
            </div>
          )}
        </div>
      )}

      {!isFinal && !over && (
        <div className="mt-2.5 flex flex-wrap items-center justify-between gap-2 border-t border-hairline pt-2">
          <LiveStamp
            lastUpdated={poll.lastUpdated}
            live={poll.live}
            refreshing={poll.refreshing || busy === 'refresh'}
            onRefresh={poll.refresh}
            cadence={PENDING.test(live.status) ? 'every 30 s' : 'every 2 min'}
            error={poll.error}
          />
          {notifyState === 'default' && (
            <button
              type="button"
              onClick={async () => setNotifyState(await requestNotifications())}
              className="text-[11px] font-semibold text-muted hover:text-ink"
            >
              🔔 Notify me of changes
            </button>
          )}
        </div>
      )}

      {confirming ? (
        <div className="mt-2.5 rounded-xl border border-red-500/30 bg-red-500/5 p-2.5 text-xs text-body">
          <p className="font-semibold text-ink">Cancel booking #{live.orderId}?</p>
          <p className="mt-0.5 text-muted">This can&apos;t be undone. Swiggy&apos;s cancellation terms for the deal apply.</p>
          <div className="mt-2 flex gap-2">
            <button
              type="button"
              onClick={cancel}
              className="rounded-full bg-red-600 px-3 py-1 text-xs font-semibold text-white hover:bg-red-700"
            >
              Yes, cancel it
            </button>
            <button
              type="button"
              onClick={() => setConfirming(false)}
              className="rounded-full border border-hairline px-3 py-1 text-xs font-semibold text-body hover:text-ink"
            >
              Keep booking
            </button>
          </div>
        </div>
      ) : (
        <div className="mt-2.5 flex flex-wrap items-center gap-3 text-xs">
          <button
            type="button"
            onClick={refresh}
            disabled={!!busy}
            className="font-semibold text-coral hover:underline disabled:opacity-50"
          >
            {busy === 'refresh' ? 'Refreshing…' : 'Refresh status'}
          </button>
          {canCancel && (
            <button
              type="button"
              onClick={() => setConfirming(true)}
              disabled={!!busy}
              className="font-semibold text-muted hover:text-red-600 disabled:opacity-50"
            >
              {busy === 'cancel' ? 'Cancelling…' : 'Cancel booking'}
            </button>
          )}
          {live.kind === 'scenes' && (
            <span className="text-[11px] text-muted">To cancel tickets, use the Swiggy app.</span>
          )}
        </div>
      )}

      {note && (
        <div className={`mt-2 text-[11px] leading-relaxed ${note.error ? 'text-red-700 dark:text-red-400' : 'text-muted'}`}>
          {note.text}
          {note.error && note.tool && (
            <ReportProblemButton
              service={live.kind}
              tool={note.tool}
              errorMessage={note.text}
              flowDescription={`booking card → ${note.tool}`}
              toolContext={{ orderId: live.orderId }}
              reportId={note.reportId}
            />
          )}
        </div>
      )}

      {live.kind === 'dineout' && (
        <div className="mt-2 text-right text-[10px] font-medium text-muted">Powered by Dineout</div>
      )}
    </div>
  );
}

export default BookingTrackerCard;
