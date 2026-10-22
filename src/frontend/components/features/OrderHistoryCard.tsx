'use client';

// Past / active Food & Instamart orders (all of them, newest first). Active
// orders get "Track this order"; Food orders get "Details", which expands the
// full get_food_order_details view inline (items + customisations, Swiggy's
// charge lines, total, payment, address). Instamart has no order-details tool
// on the live server — its row already shows the items get_orders returned.

import { useEffect, useState } from 'react';
import type { ChatMessage, OrderDetails, PastOrder } from '@/shared/types';
import { bookingStatusClass } from './BookingTrackerCard';
import { ReportProblemButton } from './ReportProblemButton';

type History = NonNullable<ChatMessage['orderHistory']>;

const CARE = 'To cancel or change a placed order, call Swiggy customer care at 080-67466729.';

function FoodOrderDetails({ orderId }: { orderId: string }) {
  const [state, setState] = useState<
    { kind: 'loading' } | { kind: 'ok'; d: OrderDetails } | { kind: 'error'; message: string; reportId?: string }
  >({ kind: 'loading' });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/orders/details?service=food&orderId=${encodeURIComponent(orderId)}`);
        const data = (await res.json().catch(() => ({}))) as {
          ok?: boolean;
          details?: OrderDetails;
          message?: string;
          reportId?: string;
        };
        if (cancelled) return;
        if (data.ok && data.details) setState({ kind: 'ok', d: data.details });
        else setState({ kind: 'error', message: data.message || 'Could not load this order.', reportId: data.reportId });
      } catch {
        if (!cancelled) setState({ kind: 'error', message: 'Could not reach the server.' });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [orderId]);

  if (state.kind === 'loading') return <p className="mt-2 text-xs text-muted">Loading order details…</p>;
  if (state.kind === 'error') {
    return (
      <div className="mt-2 text-xs text-red-700 dark:text-red-400">
        {state.message}
        <ReportProblemButton
          service="food"
          tool="get_food_order_details"
          errorMessage={state.message}
          flowDescription="order history → Details"
          toolContext={{ orderId }}
          reportId={state.reportId}
        />
      </div>
    );
  }
  const d = state.d;
  // Swiggy returned only text (no structured body): show it verbatim.
  if (d.text && d.items.length === 0) {
    return <p className="mt-2 whitespace-pre-line rounded-xl bg-canvas p-2.5 text-xs leading-relaxed text-body">{d.text}</p>;
  }
  return (
    <div className="mt-2 rounded-xl bg-canvas p-2.5 text-xs text-body">
      {d.items.length > 0 && (
        <ul className="space-y-1.5">
          {d.items.map((it, i) => (
            <li key={`${it.name}-${i}`} className="flex items-start justify-between gap-2">
              {it.imageUrl && (
                // Swiggy's own dish photo from the order details ("[image: …]")
                // eslint-disable-next-line @next/next/no-img-element
                <img decoding="async" src={it.imageUrl} alt="" loading="lazy" className="h-9 w-9 shrink-0 rounded-lg bg-surface-card object-cover" />
              )}
              <span className="min-w-0 flex-1">
                {it.isVeg !== undefined && (
                  <span
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
        <dl className="mt-2 space-y-0.5 border-t border-hairline pt-2 text-[11px] text-muted">
          {d.charges.map((c) => (
            <div key={c.label} className="flex justify-between gap-2">
              <dt className="capitalize">{c.label}</dt>
              <dd className="tabular-nums">{c.amount}</dd>
            </div>
          ))}
        </dl>
      )}
      {d.total && (
        <div className="mt-1.5 flex justify-between border-t border-hairline pt-1.5 font-semibold text-ink">
          <span>Total paid</span>
          <span className="tabular-nums">{d.total}</span>
        </div>
      )}
      <p className="mt-1.5 text-[11px] text-muted">
        {[d.paymentMethod && `Paid via ${d.paymentMethod}`, d.coupon && `Coupon ${d.coupon}`, d.deliveryAddress && `To ${d.deliveryAddress}`]
          .filter(Boolean)
          .join(' · ')}
      </p>
      {d.placedAt && <p className="mt-0.5 text-[11px] text-muted">Placed {d.placedAt}</p>}
      {d.cancellable && <p className="mt-1 text-[11px] font-medium text-amber-800 dark:text-amber-400">{CARE}</p>}
    </div>
  );
}

function OrderRow({ o, service, onAsk }: { o: PastOrder; service: History['service']; onAsk: (text: string) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <li className="flex gap-3 px-4 py-3">
      {o.imageUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img decoding="async" src={o.imageUrl} alt="" loading="lazy" className="h-12 w-12 shrink-0 rounded-xl object-cover bg-canvas" />
      ) : (
        <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-coral/10 text-lg" aria-hidden>
          {service === 'food' ? '🍽️' : '🛒'}
        </span>
      )}
      <div className="min-w-0 flex-1">
        <div className="flex items-start justify-between gap-2">
          <p className="truncate text-sm font-semibold text-ink">{o.title}</p>
          <span
            className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold capitalize ${bookingStatusClass(o.active ? 'PROCESSING' : o.status)}`}
          >
            {o.active ? 'On the way' : o.status.toLowerCase()}
          </span>
        </div>
        {o.items && <p className="mt-0.5 line-clamp-2 text-xs text-body">{o.items}</p>}
        <p className="mt-1 text-[11px] text-muted">
          {[
            o.placedAt,
            o.total,
            o.area,
            o.orderType && o.orderType.toLowerCase() !== 'regular' ? o.orderType : '',
            o.orderId ? `#${o.orderId}` : '',
          ]
            .filter(Boolean)
            .join(' · ')}
        </p>
        {/* Swiggy offers RATE_* actions on the order, but there is no rating tool — point to the app */}
        {o.rateActions && o.rateActions.length > 0 && (
          <p className="mt-1 text-[11px] text-muted">
            <span aria-hidden="true">★ </span>
            {o.rateActions.join(' · ')} — rate it in the Swiggy app
          </p>
        )}
        <div className="mt-1.5 flex flex-wrap gap-3">
          {o.active && o.orderId && (
            <button
              type="button"
              onClick={() => onAsk(`Track order ${o.orderId}`)}
              className="text-xs font-semibold text-coral hover:underline"
            >
              Track this order →
            </button>
          )}
          {service === 'food' && o.orderId && (
            <button
              type="button"
              onClick={() => setOpen((v) => !v)}
              aria-expanded={open}
              className="text-xs font-semibold text-muted hover:text-ink"
            >
              {open ? 'Hide details' : 'Details'}
            </button>
          )}
        </div>
        {open && o.orderId && <FoodOrderDetails orderId={o.orderId} />}
      </div>
    </li>
  );
}

export function OrderHistoryCard({ history, onAsk }: { history: History; onAsk: (text: string) => void }) {
  const label = history.service === 'food' ? 'Food orders' : 'Instamart orders';
  return (
    <div className="mt-3 overflow-hidden rounded-2xl border border-hairline bg-surface-card/60 shadow-xs animate-rise">
      <div className="flex items-center justify-between border-b border-hairline px-4 py-2.5">
        <h4 className="font-display text-sm font-semibold text-ink">{label}</h4>
        <span className="text-[11px] text-muted">
          {history.orders.length} order{history.orders.length === 1 ? '' : 's'} · newest first
        </span>
      </div>
      <ul className="divide-y divide-hairline">
        {history.orders.map((o) => (
          <OrderRow key={o.orderId || `${o.title}-${o.placedAt}`} o={o} service={history.service} onAsk={onAsk} />
        ))}
      </ul>
    </div>
  );
}

export default OrderHistoryCard;
