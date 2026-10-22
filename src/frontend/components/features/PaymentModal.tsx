'use client';

// In-chat UPI payment for an order Swiggy has created in PENDING_PAYMENT
// (Food, Instamart, Dineout, Scenes). We are a widget-less ("headless") client,
// so per docs/swiggy-mcp/platform.md §6 we:
//   - hand the user Swiggy's own payment link (bridgeUrl: a scan-or-tap QR page;
//     upiIntentUrl to open a UPI app) — never a hand-built UPI URI or VPA;
//   - poll check_payment_status ONE request at a time (it is a ~19 s long-poll),
//     sleeping pollingIntervalInMs between calls, capped at maxTimeToPollForInMs;
//   - call confirm_order only on a terminal success that wasn't auto-confirmed,
//     or once at the cap while still pending;
//   - report "placed" only when Swiggy says so.
// Cash and Swiggy Money orders are final at place-order and never open this.

import { useCallback, useEffect, useRef, useState } from 'react';

import { PoweredBy } from '../navigation/PoweredBy';
import { isMobileDevice } from '@/frontend/utils/device';
import { useDialogA11y } from '@/frontend/hooks/useDialogA11y';
import type {
  PaymentConfirmResult,
  PaymentOptionsPayload,
  PaymentSession,
  PaymentStatusResult,
} from '@/shared/types';

export interface PaymentModalProps {
  session: PaymentSession | null;
  /** Kept for API compatibility; methods are chosen before the order is placed. */
  options?: PaymentOptionsPayload | null;
  onClose: () => void;
  /** Called once Swiggy confirms the order is placed. */
  onSuccess: (orderId: string, message: string) => void;
  /** Start a fresh attempt (re-fetch get_payment_options) after a failed payment. */
  onRetry?: () => void;
  /** Ignored: Food confirmation echoes the place-order response (session.echo). */
  addressId?: string;
  latitude?: number;
  longitude?: number;
}

type Phase =
  | 'waiting' // user is paying; we long-poll
  | 'confirming' // confirm_order in flight
  | 'success' // Swiggy says placed
  | 'failed' // terminal failure — no order
  | 'stopped' // terminal non-failure stop (refund underway / cancelled / cart changed)
  | 'unknown' // couldn't get a definitive answer — user must check the Swiggy app
  | 'login'; // session expired mid-payment

type StatusReply =
  | { kind: 'ok'; status: PaymentStatusResult }
  | { kind: 'auth' }
  | { kind: 'error'; message: string };

function formatINR(n: number): string {
  return `₹${n.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
}

function mmss(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** Interruptible sleep: resolves early on abort or when `wake` fires. */
function sleep(ms: number, signal: AbortSignal, wakeRef: { current: (() => void) | null }): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(t);
      wakeRef.current = null;
      resolve();
    };
    const t = setTimeout(done, ms);
    wakeRef.current = done;
    signal.addEventListener('abort', done, { once: true });
  });
}

export function PaymentModal({ session, onClose, onSuccess, onRetry }: PaymentModalProps) {
  const [phase, setPhase] = useState<Phase>('waiting');
  // Focus moves in, Tab is trapped, Esc closes (not while confirming), and
  // focus returns to the opener.
  const dialogRef = useRef<HTMLDivElement>(null);
  useDialogA11y(!!session, dialogRef, phase === 'confirming' ? undefined : onClose);
  const [statusText, setStatusText] = useState('Waiting for your UPI payment…');
  const [deadline, setDeadline] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const [polling, setPolling] = useState(false);
  const wakeRef = useRef<(() => void) | null>(null);
  // Latest onSuccess without restarting the poll loop when the parent re-renders.
  const onSuccessRef = useRef(onSuccess);
  useEffect(() => {
    onSuccessRef.current = onSuccess;
  }, [onSuccess]);

  const refs = useCallback(
    (s: PaymentSession) => ({
      service: s.service,
      orderId: s.orderId,
      paasId: s.paasId,
      transactionId: s.transactionId,
      addressId: s.echo?.addressId,
      cartId: s.echo?.cartId,
      lat: s.echo?.lat,
      lng: s.echo?.lng,
    }),
    [],
  );

  const checkStatus = useCallback(
    async (s: PaymentSession, signal: AbortSignal): Promise<StatusReply> => {
      const q = new URLSearchParams();
      for (const [k, v] of Object.entries(refs(s))) {
        if (v !== undefined && v !== null && v !== '' && k !== 'transactionId') q.set(k, String(v));
      }
      try {
        const res = await fetch(`/api/payments/status?${q.toString()}`, { signal, cache: 'no-store' });
        if (res.status === 401) return { kind: 'auth' };
        const data = (await res.json().catch(() => ({}))) as { ok?: boolean; status?: PaymentStatusResult; message?: string };
        if (res.ok && data.ok && data.status) return { kind: 'ok', status: data.status };
        return { kind: 'error', message: data.message || 'Payment status check failed' };
      } catch (err) {
        if (signal.aborted) throw err;
        return { kind: 'error', message: 'Network error while checking payment' };
      }
    },
    [refs],
  );

  /** confirm_order (idempotent): one retry on a transient failure. */
  const confirm = useCallback(
    async (s: PaymentSession, signal: AbortSignal): Promise<{ kind: 'ok'; result: PaymentConfirmResult } | { kind: 'auth' } | { kind: 'error'; message: string }> => {
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const res = await fetch('/api/payments/confirm', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(refs(s)),
            signal,
          });
          if (res.status === 401) return { kind: 'auth' };
          const data = (await res.json().catch(() => ({}))) as { ok?: boolean; result?: PaymentConfirmResult; message?: string };
          if (res.ok && data.ok && data.result) return { kind: 'ok', result: data.result };
          // 4xx (bad args, gated, Swiggy domain error) won't change on retry.
          if (res.status < 500) return { kind: 'error', message: data.message || 'Swiggy could not confirm the order' };
        } catch (err) {
          if (signal.aborted) throw err;
        }
        await sleep(2000, signal, { current: null });
      }
      return { kind: 'error', message: 'Could not reach Swiggy to confirm the order' };
    },
    [refs],
  );

  // The single sequential poll loop for this payment attempt.
  useEffect(() => {
    if (!session) return;
    const ctrl = new AbortController();
    const { signal } = ctrl;
    const s = session;
    const end = Date.now() + Math.max(30_000, s.maxTimeToPollForInMs);
    const interval = Math.max(1000, s.pollingIntervalInMs);

    const succeed = (message?: string) => {
      setPhase('success');
      setStatusText(message || 'Payment received — your order is confirmed.');
      setTimeout(() => {
        if (!signal.aborted) onSuccessRef.current(s.orderId, message || 'Payment received — your order is confirmed.');
      }, 1200);
    };

    const finalize = async (atCap: boolean) => {
      setPhase('confirming');
      setStatusText(atCap ? 'Payment window ended — finalizing with Swiggy…' : 'Payment received — confirming your order…');
      const r = await confirm(s, signal);
      if (signal.aborted) return;
      if (r.kind === 'auth') {
        setPhase('login');
        setStatusText('Your Swiggy session expired. Log in again, then check your orders in the Swiggy app.');
      } else if (r.kind === 'error') {
        setPhase('unknown');
        setStatusText(`${r.message}. If money was debited, Swiggy reconciles it automatically — check your orders in the Swiggy app before paying again.`);
      } else if (r.result.result === 'success') {
        succeed(r.result.message);
      } else if (r.result.result === 'cart_changed') {
        setPhase('stopped');
        setStatusText(r.result.message || 'Your cart changed (price or stock), so the order was not placed. Review the cart and place it again.');
      } else if (r.result.result === 'failed') {
        setPhase('failed');
        setStatusText(
          r.result.message ||
            (atCap ? 'The payment window expired and the order was not placed.' : 'Swiggy could not complete the order.'),
        );
      } else {
        setPhase('unknown');
        setStatusText(
          r.result.message ||
            'Payment is still being processed. A late payment is reconciled by Swiggy — check your orders in the Swiggy app before trying again.',
        );
      }
    };

    const run = async () => {
      setPhase('waiting');
      setStatusText('Waiting for your UPI payment…');
      setDeadline(end);
      let errors = 0;
      while (!signal.aborted) {
        setPolling(true);
        const reply = await checkStatus(s, signal);
        setPolling(false);
        if (signal.aborted) return;

        if (reply.kind === 'auth') {
          setPhase('login');
          setStatusText('Your Swiggy session expired. Log in again — if you already paid, Swiggy will still reconcile the order.');
          return;
        }
        if (reply.kind === 'ok') {
          errors = 0;
          const st = reply.status;
          if (st.isTerminalSuccess) {
            if (st.confirmed) succeed(st.message);
            else await finalize(false);
            return;
          }
          if (st.isTerminalFailure || st.terminal) {
            const status = st.status;
            if (status === 'refund-initiated' || status === 'refund_initiated') {
              setPhase('stopped');
              setStatusText(st.message || 'Your payment is being refunded by Swiggy. No order was placed.');
            } else if (status === 'cart_changed') {
              setPhase('stopped');
              setStatusText(st.message || 'Your cart changed (price or stock), so the order was not placed. Review the cart and place it again.');
            } else if (status === 'cancelled' || status === 'canceled') {
              setPhase('stopped');
              setStatusText(st.message || 'This order was cancelled. Any amount paid will be refunded.');
            } else {
              setPhase('failed');
              setStatusText(st.message || 'The payment failed. No order was placed.');
            }
            return;
          }
          if (st.message) setStatusText(st.message);
        } else {
          errors++;
          if (errors >= 3) setStatusText(`${reply.message} — still trying…`);
        }

        if (Date.now() >= end) {
          await finalize(true);
          return;
        }
        // Back off harder on repeated errors; never tight-loop the long-poll.
        await sleep(errors ? Math.min(interval * 2 ** errors, 15_000) : interval, signal, wakeRef);
      }
    };

    run().catch(() => {
      // aborted on close/unmount
    });
    return () => ctrl.abort();
  }, [session, checkStatus, confirm]);

  // Countdown display only (the loop owns the real deadline).
  useEffect(() => {
    if (!session || phase !== 'waiting') return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [session, phase]);

  // Laptop: a UPI app link can't open here, so show a QR to scan with the phone —
  // Swiggy's upi://pay link directly (any UPI app scans it), else Swiggy's payment
  // page (the phone opens it and launches the UPI app). Never a hand-built URI.
  const [qrImg, setQrImg] = useState<{ src: string; kind: 'upi' | 'page'; url: string } | null>(null);
  const qrTarget = !session || isMobileDevice()
    ? null
    : session.upiIntentUrl?.startsWith('upi://pay')
      ? { url: session.upiIntentUrl, kind: 'upi' as const }
      : session.bridgeUrl
        ? { url: session.bridgeUrl, kind: 'page' as const }
        : null;
  const qrUrl = qrTarget?.url;
  const qrKind = qrTarget?.kind;
  useEffect(() => {
    let cancelled = false;
    if (!qrUrl || !qrKind) return;
    void import('qrcode')
      .then((m) => m.toDataURL(qrUrl, { margin: 1, width: 360, errorCorrectionLevel: 'M' }))
      .then((src) => {
        if (!cancelled) setQrImg({ src, kind: qrKind, url: qrUrl });
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [qrUrl, qrKind]);
  // only the QR for this session's current link
  const qr = qrImg && qrImg.url === qrUrl ? qrImg : null;

  if (!session) return null;

  const busy = phase === 'confirming';
  const live = phase === 'waiting';
  const payLink = session.bridgeUrl;
  const appLink = session.upiIntentUrl;
  const remaining = deadline ? deadline - now : session.maxTimeToPollForInMs;

  return (
    <div ref={dialogRef} className="fixed inset-0 z-50 flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-labelledby="pay-title">
      <button
        type="button"
        aria-label="Close payment"
        tabIndex={-1}
        onClick={busy ? undefined : onClose}
        className="absolute inset-0 bg-ink/60 backdrop-blur-sm"
      />

      <div className="relative w-full max-w-md overflow-hidden rounded-3xl border border-hairline bg-canvas shadow-2xl animate-rise">
        <div className="border-b border-hairline bg-surface-card/60 px-6 py-4">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h3 id="pay-title" className="font-display text-base font-bold text-ink">
                Complete your UPI payment
              </h3>
              <p className="mt-0.5 break-all text-[12px] text-muted">
                {session.title ? `${session.title} · ` : ''}Order {session.orderId}
              </p>
            </div>
            <button
              type="button"
              onClick={onClose}
              disabled={busy}
              className="rounded-full p-1.5 text-muted hover:bg-surface-card hover:text-ink disabled:opacity-40"
              aria-label="Close"
            >
              <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                <path d="M18 6 6 18M6 6l12 12" />
              </svg>
            </button>
          </div>

          <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
            <PoweredBy service={session.service} compact className="-m-2" />
            {session.amount > 0 && (
              <span className="font-display text-xl font-bold tracking-tight text-ink">{formatINR(session.amount)}</span>
            )}
          </div>
        </div>

        <div className="space-y-4 p-6">
          <div
            className={`rounded-2xl px-4 py-3 text-sm ${
              phase === 'success'
                ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400'
                : phase === 'failed' || phase === 'login'
                  ? 'bg-rose-500/10 text-rose-700 dark:text-rose-400'
                  : phase === 'stopped' || phase === 'unknown'
                    ? 'bg-amber-500/10 text-amber-700 dark:text-amber-400'
                    : 'bg-surface-card text-body'
            }`}
            role="status"
            aria-live="polite"
          >
            <div className="flex items-start gap-2">
              {(live || busy) && (
                <span className="mt-1 inline-block h-3 w-3 shrink-0 animate-spin rounded-full border-2 border-coral border-t-transparent" aria-hidden="true" />
              )}
              <span>{statusText}</span>
            </div>
            {live && (
              <p className="mt-1 text-[12px] text-muted">
                Checking automatically · {mmss(remaining)} left
              </p>
            )}
          </div>

          {live && (
            <>
              {qr && (
                <div className="flex flex-col items-center gap-2 rounded-2xl border border-hairline bg-white p-4">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img decoding="async" src={qr.src} alt="Payment QR code" className="h-48 w-48" />
                  <p className="text-center text-[12px] leading-relaxed text-muted">
                    {qr.kind === 'upi'
                      ? 'Scan with any UPI app on your phone (Google Pay, PhonePe, Paytm…) to pay.'
                      : "Scan with your phone's camera — it opens Swiggy's payment page there and launches your UPI app."}
                  </p>
                </div>
              )}
              {payLink || appLink ? (
                <div className="space-y-2">
                  {payLink && (
                    <a
                      href={payLink}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="block w-full rounded-xl bg-coral py-3 text-center text-sm font-semibold text-on-primary shadow-xs transition-colors hover:bg-coral-active"
                    >
                      Open Swiggy payment page
                    </a>
                  )}
                  {appLink && !qr && (
                    <a
                      href={appLink}
                      className="block w-full rounded-xl border border-hairline py-2.5 text-center text-sm font-medium text-ink transition-colors hover:bg-surface-card"
                    >
                      Pay with a UPI app on this phone
                    </a>
                  )}
                  <p className="text-center text-[12px] leading-relaxed text-muted">
                    The payment page shows a QR to scan with any UPI app, or a button to open your UPI app on mobile.
                    Never share your UPI PIN.
                  </p>
                </div>
              ) : (
                <p className="rounded-xl bg-rose-500/10 px-4 py-3 text-sm text-rose-700 dark:text-rose-400">
                  Swiggy didn&apos;t return a payment link for this order. Close this and try again.
                </p>
              )}

              <button
                type="button"
                onClick={() => wakeRef.current?.()}
                disabled={polling}
                className="w-full text-center text-[12px] font-medium text-coral hover:underline disabled:cursor-default disabled:text-muted disabled:no-underline"
              >
                {polling ? 'Checking with Swiggy…' : "I've paid — check now"}
              </button>
            </>
          )}

          {(phase === 'failed' || phase === 'stopped') && (
            <div className="flex gap-2">
              {phase === 'failed' && onRetry && (
                <button
                  type="button"
                  onClick={onRetry}
                  className="flex-1 rounded-xl bg-coral py-2.5 text-sm font-semibold text-on-primary hover:bg-coral-active"
                >
                  Try another payment
                </button>
              )}
              <button
                type="button"
                onClick={onClose}
                className="flex-1 rounded-xl border border-hairline py-2.5 text-sm font-medium text-ink hover:bg-surface-card"
              >
                Close
              </button>
            </div>
          )}

          {(phase === 'unknown' || phase === 'login') && (
            <button
              type="button"
              onClick={onClose}
              className="w-full rounded-xl border border-hairline py-2.5 text-sm font-medium text-ink hover:bg-surface-card"
            >
              Close
            </button>
          )}

          {live && (
            <p className="text-center text-[11px] text-muted">
              Closing this stops the live check. If you&apos;ve already paid, Swiggy still reconciles the order.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

export default PaymentModal;
