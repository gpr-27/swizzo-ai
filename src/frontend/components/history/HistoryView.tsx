'use client';

// The History page — every past order in one dashboard, like the Swiggy app's
// "Orders" screen (not a chat thread). It replaces the chat area while open.
//  - Food + Instamart: GET /api/history (one request; each section loads or
//    fails on its own, with Swiggy's message and a Retry).
//  - Dineout + Scenes: Swiggy has no "list my bookings" tool, so we show the
//    bookings THIS app made (saved per user in localStorage, synced across
//    devices via /api/me/state when the server has a database) with their live
//    status from POST /api/history/bookings, and say so plainly.
// Filter chips + search, totals summary, loading skeletons, Refresh.
// Images: Swiggy's official photos only (restaurant covers, dish photos,
// Dineout restaurant photos); Scenes has none, so it gets the generated
// ScenesPoster art; anything else without a photo gets a plain placeholder.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { HistoryOrder, HistoryResponse, HistorySection } from '@/backend/history/history-map';
import { loadBookings, updateBookingStatuses, type SavedBooking } from '@/frontend/state/bookings';
import { pullNow } from '@/frontend/state/cloudSync';
import { BookingTrackerCard } from '../features/BookingTrackerCard';
import { ScenesPoster } from '../catalog/ScenesEventCard';
import { HistoryOrderCard, CARE_PHONE } from './HistoryOrderCard';
import { HistoryInsights } from './HistoryInsights';
import { buildHistoryInsights, orderOneLiners, type InsightAction } from '@/backend/history/insights';

type Filter = 'all' | 'food' | 'instamart' | 'dineout' | 'scenes';

const FILTERS: { id: Filter; label: string; emoji: string }[] = [
  { id: 'all', label: 'All', emoji: '🧾' },
  { id: 'food', label: 'Food', emoji: '🍽️' },
  { id: 'instamart', label: 'Instamart', emoji: '⚡' },
  { id: 'dineout', label: 'Dineout', emoji: '🥂' },
  { id: 'scenes', label: 'Scenes', emoji: '🎟️' },
];

interface BookingRow {
  saved: SavedBooking;
  status?: string;
  title?: string;
  details?: string;
  imageUrl?: string;
  error?: string;
}

type Load<T> = { kind: 'loading' } | { kind: 'ready'; data: T } | { kind: 'error'; message: string; needsLogin?: boolean };

export interface HistoryViewProps {
  userId?: string;
  addressId: string;
  lat?: number;
  lng?: number;
  /** Label of the tab to go back to ("Food", "Instamart"…). */
  backLabel: string;
  onClose: () => void;
  onLogin: () => void;
  onReorder: (order: HistoryOrder, images: Record<string, string>) => void;
  /** the AI summary's "Refill Instamart usuals" → open the Instamart tab (usuals board) */
  onOpenInstamart?: () => void;
}

const inr = (n: number) => `₹${Math.round(n).toLocaleString('en-IN')}`;

function matches(q: string, ...fields: (string | undefined)[]): boolean {
  if (!q) return true;
  const hay = fields.filter(Boolean).join(' ').toLowerCase();
  return q
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((w) => hay.includes(w));
}

function CardSkeleton() {
  return (
    <div className="rounded-2xl border border-hairline bg-surface-card/60 p-4" aria-hidden="true">
      <div className="flex gap-3">
        <div className="h-16 w-16 shrink-0 animate-pulse rounded-xl bg-surface-soft" />
        <div className="flex-1 space-y-2 pt-1">
          <div className="h-3.5 w-2/3 animate-pulse rounded bg-surface-soft" />
          <div className="h-3 w-1/3 animate-pulse rounded bg-surface-soft" />
          <div className="h-3 w-5/6 animate-pulse rounded bg-surface-soft" />
        </div>
      </div>
      <div className="mt-3 flex gap-2 border-t border-hairline pt-3">
        <div className="h-8 w-24 animate-pulse rounded-full bg-surface-soft" />
        <div className="h-8 w-28 animate-pulse rounded-full bg-surface-soft" />
      </div>
    </div>
  );
}

function SectionHeading({ title, count, note }: { title: string; count?: number; note?: string }) {
  return (
    <div className="mb-2.5 mt-6 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 first:mt-0">
      <h2 className="font-display text-lg text-ink">
        {title}
        {count !== undefined && <span className="ml-1.5 text-sm text-muted">({count})</span>}
      </h2>
      {note && <p className="text-[11px] text-muted">{note}</p>}
    </div>
  );
}

function Notice({ children, tone = 'muted' }: { children: React.ReactNode; tone?: 'muted' | 'error' }) {
  return (
    <div
      role={tone === 'error' ? 'alert' : undefined}
      className={`rounded-2xl border p-4 text-sm leading-relaxed ${
        tone === 'error'
          ? 'border-red-500/25 bg-red-500/5 text-red-700 dark:text-red-300'
          : 'border-dashed border-hairline bg-surface-soft/50 text-body'
      }`}
    >
      {children}
    </div>
  );
}

function BookingCard({ row }: { row: BookingRow }) {
  const { saved } = row;
  const title = row.title || saved.title;
  return (
    <article className="flex gap-3 rounded-2xl border border-hairline bg-surface-card/70 p-3.5 shadow-xs sm:p-4" aria-label={title}>
      <div className="shrink-0 pt-3">
        {saved.kind === 'scenes' ? (
          <ScenesPoster title={title} hint={row.details || saved.details} compact />
        ) : row.imageUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img decoding="async" src={row.imageUrl} alt="" loading="lazy" className="h-14 w-14 rounded-xl bg-surface-soft object-cover" />
        ) : (
          <span className="flex h-14 w-14 items-center justify-center rounded-xl bg-purple-500/10 text-2xl" aria-hidden="true">
            🥂
          </span>
        )}
      </div>
      <div className="min-w-0 flex-1 [&>div]:mt-0 [&>div]:border-0 [&>div]:bg-transparent [&>div]:p-0 [&>div]:shadow-none">
        {row.error && !row.status ? (
          <div>
            <p className="pt-3 text-sm font-semibold text-ink">{title}</p>
            <p className="mt-1 text-xs text-red-700 dark:text-red-400">{row.error}</p>
            <p className="mt-1 text-[11px] text-muted">Order #{saved.orderId}</p>
          </div>
        ) : (
          <BookingTrackerCard
            tracker={{
              kind: saved.kind,
              orderId: saved.orderId,
              title,
              status: row.status || 'Unknown',
              details: row.details || saved.details || '',
            }}
          />
        )}
        <p className="mt-1.5 text-[10px] text-muted">
          Booked in Swizzo · {new Date(saved.createdAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}
        </p>
      </div>
    </article>
  );
}

export function HistoryView({ userId, addressId, lat, lng, backLabel, onClose, onLogin, onReorder, onOpenInstamart }: HistoryViewProps) {
  const [filter, setFilter] = useState<Filter>('all');
  const [query, setQuery] = useState('');
  const [orders, setOrders] = useState<Load<HistoryResponse>>({ kind: 'loading' });
  const [bookings, setBookings] = useState<Load<BookingRow[]>>({ kind: 'loading' });
  const [refreshing, setRefreshing] = useState(false);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const reqId = useRef(0);
  const headingRef = useRef<HTMLHeadingElement>(null);

  const loadOrders = useCallback(async (): Promise<void> => {
    try {
      const res = await fetch(`/api/history${addressId ? `?addressId=${encodeURIComponent(addressId)}` : ''}`, {
        cache: 'no-store',
      });
      const data = (await res.json().catch(() => null)) as (HistoryResponse & { needsLogin?: boolean; message?: string }) | null;
      if (res.status === 401 || data?.needsLogin) {
        setOrders({ kind: 'error', needsLogin: true, message: data?.message || 'Your Swiggy session expired — please log in again.' });
      } else if (data && data.food && data.instamart) {
        setOrders({ kind: 'ready', data });
      } else {
        setOrders({ kind: 'error', message: 'Could not load your orders.' });
      }
    } catch {
      setOrders({ kind: 'error', message: 'Could not reach the server. Check your connection and retry.' });
    }
  }, [addressId]);

  const loadBookingRows = useCallback(async (): Promise<void> => {
    // bookings made on other devices arrive via the server copy (no-op without a DB)
    await pullNow();
    const saved = loadBookings(userId);
    if (!saved.length) {
      setBookings({ kind: 'ready', data: [] });
      return;
    }
    try {
      const res = await fetch('/api/history/bookings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          items: saved.map((b) => ({
            kind: b.kind,
            orderId: b.orderId,
            ...(b.restaurantId ? { restaurantId: b.restaurantId } : {}),
            ...(b.lat !== undefined && b.lng !== undefined ? { lat: b.lat, lng: b.lng } : {}),
          })),
          lat,
          lng,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        needsLogin?: boolean;
        message?: string;
        bookings?: { orderId: string; kind: string; ok: boolean; status?: string; title?: string; details?: string; imageUrl?: string; error?: string }[];
      };
      if (res.status === 401 || data.needsLogin) {
        setBookings({ kind: 'error', needsLogin: true, message: data.message || 'Your Swiggy session expired — please log in again.' });
        return;
      }
      const byId = new Map((data.bookings ?? []).map((r) => [`${r.kind}:${r.orderId}`, r]));
      updateBookingStatuses(userId, (data.bookings ?? []).filter((r) => r.ok));
      setBookings({
        kind: 'ready',
        data: saved.map((s) => {
          const r = byId.get(`${s.kind}:${s.orderId}`);
          return r?.ok
            ? { saved: s, status: r.status, title: r.title, details: r.details, imageUrl: r.imageUrl }
            : { saved: s, error: r?.error || data.message || 'Could not load this booking.' };
        }),
      });
    } catch {
      setBookings({ kind: 'error', message: 'Could not reach the server to check your bookings.' });
    }
  }, [userId, lat, lng]);

  const refresh = useCallback(async () => {
    const id = ++reqId.current;
    setRefreshing(true);
    await Promise.all([loadOrders(), loadBookingRows()]);
    if (id === reqId.current) {
      setRefreshing(false);
      setUpdatedAt(Date.now());
    }
  }, [loadOrders, loadBookingRows]);

  useEffect(() => {
    // Initial load (and reload when the account / address changes) — syncing
    // with Swiggy, an external system.
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch on mount
    void refresh();
  }, [refresh]);

  useEffect(() => {
    headingRef.current?.focus();
  }, []);

  const food: HistorySection | undefined = orders.kind === 'ready' ? orders.data.food : undefined;
  const im: HistorySection | undefined = orders.kind === 'ready' ? orders.data.instamart : undefined;
  const foodOrders = useMemo(() => (food?.ok ? food.orders : []), [food]);
  const imOrders = useMemo(() => (im?.ok ? im.orders : []), [im]);
  const bookingRows = useMemo(() => (bookings.kind === 'ready' ? bookings.data : []), [bookings]);

  const stats = useMemo(() => {
    const all = [...foodOrders, ...imOrders];
    const spent = all
      .filter((o) => o.tone !== 'cancelled' && o.totalValue !== null)
      .reduce((s, o) => s + (o.totalValue ?? 0), 0);
    return {
      orders: all.length,
      spent,
      active: all.filter((o) => o.active).length,
      bookings: bookingRows.length,
    };
  }, [foodOrders, imOrders, bookingRows]);

  // AI insights over the real rows (spend, go-to place/dish, usual time, active, bookings).
  const insights = useMemo(
    () =>
      orders.kind === 'ready'
        ? buildHistoryInsights(
            foodOrders,
            imOrders,
            bookingRows.map((b) => ({ kind: b.saved.kind, title: b.title || b.saved.title, status: b.status })),
          )
        : null,
    [orders.kind, foodOrders, imOrders, bookingRows],
  );
  const oneLiners = useMemo(() => {
    const m = orderOneLiners(foodOrders);
    for (const [k, v] of orderOneLiners(imOrders)) m.set(k, v);
    return m;
  }, [foodOrders, imOrders]);
  const [trackNonce, setTrackNonce] = useState<{ id: string; n: number } | null>(null);
  const onInsightAction = (a: InsightAction) => {
    if (a.kind === 'reorder') {
      const o = foodOrders.find((x) => x.orderId === a.orderId);
      if (o?.reorder) onReorder(o, {});
    } else if (a.kind === 'track') {
      setFilter('all');
      setQuery('');
      setTrackNonce((t) => ({ id: a.orderId, n: (t?.n ?? 0) + 1 }));
    } else if (a.kind === 'refill') {
      onOpenInstamart?.();
    } else {
      setFilter(bookingRows.every((b) => b.saved.kind === 'scenes') ? 'scenes' : bookingRows.every((b) => b.saved.kind === 'dineout') ? 'dineout' : 'all');
      setQuery('');
    }
  };

  const q = query.trim();
  const show = (f: Exclude<Filter, 'all'>) => filter === 'all' || filter === f;
  const filterOrders = (list: HistoryOrder[]) => list.filter((o) => matches(q, o.title, o.area, o.items, o.status, o.orderId));
  const visibleFood = filterOrders(foodOrders);
  const visibleIm = filterOrders(imOrders);
  const visibleBookings = bookingRows.filter(
    (b) => show(b.saved.kind) && matches(q, b.title, b.saved.title, b.details, b.saved.details, b.status, b.saved.orderId),
  );
  const active = [...(show('food') ? visibleFood : []), ...(show('instamart') ? visibleIm : [])].filter((o) => o.active);
  const pastFood = visibleFood.filter((o) => !o.active);
  const pastIm = visibleIm.filter((o) => !o.active);

  const counts: Record<Filter, number | undefined> = {
    all: orders.kind === 'ready' ? stats.orders + stats.bookings : undefined,
    food: food?.ok ? foodOrders.length : undefined,
    instamart: im?.ok ? imOrders.length : undefined,
    dineout: bookings.kind === 'ready' ? bookingRows.filter((b) => b.saved.kind === 'dineout').length : undefined,
    scenes: bookings.kind === 'ready' ? bookingRows.filter((b) => b.saved.kind === 'scenes').length : undefined,
  };

  const loginPrompt = (message: string) => (
    <Notice tone="error">
      {message}{' '}
      <button type="button" onClick={onLogin} className="font-semibold underline">
        Log in to Swiggy
      </button>
    </Notice>
  );

  const sectionError = (s: HistorySection | undefined, label: string) =>
    s && !s.ok ? (
      s.needsLogin ? (
        loginPrompt(s.error)
      ) : (
        <Notice tone="error">
          Couldn&apos;t load your {label} orders: {s.error}{' '}
          <button type="button" onClick={() => void refresh()} className="font-semibold underline">
            Retry
          </button>
        </Notice>
      )
    ) : null;

  const cards = (list: HistoryOrder[]) => (
    <div className="grid gap-3 xl:grid-cols-2">
      {list.map((o) => (
        <HistoryOrderCard
          key={`${o.service}-${o.orderId || `${o.title}-${o.placedAt}`}`}
          order={o}
          addressId={addressId}
          lat={lat}
          lng={lng}
          onReorder={o.service === 'food' ? onReorder : undefined}
          insight={oneLiners.get(o.orderId)}
          autoTrack={trackNonce && trackNonce.id === o.orderId ? trackNonce.n : undefined}
        />
      ))}
    </div>
  );

  const loading = orders.kind === 'loading';
  const noResults =
    !!q &&
    orders.kind === 'ready' &&
    bookings.kind === 'ready' &&
    active.length + (show('food') ? pastFood.length : 0) + (show('instamart') ? pastIm.length : 0) + visibleBookings.length === 0;

  return (
    <section className="flex min-h-0 flex-1 flex-col max-sm:overflow-y-auto" aria-labelledby="history-title">
      {/* Header */}
      <div className="shrink-0 border-b border-hairline bg-canvas/95 px-3 pb-3 pt-3 sm:px-6 sm:pt-4">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0 flex-1">
            <button
              type="button"
              onClick={onClose}
              className="mb-1 inline-flex items-center gap-1 text-xs font-semibold text-muted hover:text-ink"
            >
              <span aria-hidden="true">←</span> Back to {backLabel}
            </button>
            <h1 id="history-title" ref={headingRef} tabIndex={-1} className="font-display text-2xl text-ink outline-none sm:text-3xl">
              Your orders
            </h1>
            <p className="mt-0.5 text-xs text-muted">
              Food, Instamart, Dineout and Scenes in one place
              {updatedAt && !refreshing && (
                <> · updated {new Date(updatedAt).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' })}</>
              )}
            </p>
          </div>
          <button
            type="button"
            onClick={() => void refresh()}
            disabled={refreshing}
            aria-label={refreshing ? 'Refreshing orders' : 'Refresh orders'}
            className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-full border border-hairline bg-surface-card/70 px-2.5 text-xs font-semibold text-body shadow-xs hover:border-coral/50 hover:text-ink disabled:opacity-60 sm:px-3"
          >
            <svg
              viewBox="0 0 24 24"
              className={`h-4 w-4 ${refreshing ? 'motion-safe:animate-spin' : ''}`}
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M21 12a9 9 0 1 1-2.64-6.36M21 3v6h-6" />
            </svg>
            <span className="hidden sm:inline">{refreshing ? 'Refreshing…' : 'Refresh'}</span>
          </button>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close orders"
            className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-hairline bg-surface-card/70 text-base text-body shadow-xs hover:border-coral/50 hover:text-ink"
          >
            <span aria-hidden="true">✕</span>
          </button>
        </div>

        {/* Totals */}
        <dl className="mt-3 grid grid-cols-4 gap-1.5 sm:gap-2">
          {[
            { label: 'Orders', value: loading ? null : String(stats.orders) },
            { label: 'Spent', value: loading ? null : stats.spent ? inr(stats.spent) : '₹0', hint: 'excl. cancelled' },
            { label: 'Active now', value: loading ? null : String(stats.active) },
            { label: 'Bookings', value: bookings.kind === 'loading' ? null : String(stats.bookings) },
          ].map((t) => (
            <div key={t.label} className="min-w-0 rounded-xl border border-hairline bg-surface-card/60 px-2 py-1.5 sm:rounded-2xl sm:px-3 sm:py-2">
              <dt className="truncate text-[10px] text-muted sm:text-[11px]">
                {t.label}
                {t.hint && <span className="hidden sm:inline"> · {t.hint}</span>}
              </dt>
              <dd className="truncate font-display text-base font-bold tabular-nums text-ink sm:text-lg">
                {t.value ?? <span className="inline-block h-5 w-10 animate-pulse rounded bg-surface-soft align-middle" aria-label="Loading" />}
              </dd>
            </div>
          ))}
        </dl>

        {/* Filters + search */}
        <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center">
          <div role="group" aria-label="Filter orders" className="-mx-1 flex gap-1.5 overflow-x-auto px-1 pb-0.5">
            {FILTERS.map((f) => {
              const on = filter === f.id;
              return (
                <button
                  key={f.id}
                  type="button"
                  aria-pressed={on}
                  onClick={() => setFilter(f.id)}
                  className={`inline-flex shrink-0 items-center gap-1 rounded-full border px-3 py-1.5 text-xs font-semibold transition-colors ${
                    on
                      ? 'border-coral bg-coral text-on-primary shadow-xs'
                      : 'border-hairline bg-surface-card/60 text-body hover:border-coral/50 hover:text-ink'
                  }`}
                >
                  <span aria-hidden="true">{f.emoji}</span>
                  {f.label}
                  {counts[f.id] !== undefined && (
                    <span className={`tabular-nums ${on ? 'text-white/80' : 'text-muted'}`}>{counts[f.id]}</span>
                  )}
                </button>
              );
            })}
          </div>
          <label className="relative sm:ml-auto sm:w-64">
            <span className="sr-only">Search orders</span>
            <svg viewBox="0 0 24 24" className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
              <circle cx="11" cy="11" r="7" />
              <path d="m20 20-3.5-3.5" strokeLinecap="round" />
            </svg>
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search dishes, restaurants…"
              className="w-full rounded-full border border-hairline bg-surface-card/70 py-2 pl-9 pr-3 text-sm text-ink placeholder:text-muted focus:border-coral focus:outline-none"
            />
          </label>
        </div>
      </div>

      {/* Body */}
      <div className="px-3 py-4 max-sm:flex-none sm:min-h-0 sm:flex-1 sm:overflow-y-auto sm:px-6" aria-busy={refreshing}>
        <div className="mx-auto max-w-5xl pb-10">
          {orders.kind === 'error' && (orders.needsLogin ? loginPrompt(orders.message) : (
            <Notice tone="error">
              {orders.message}{' '}
              <button type="button" onClick={() => void refresh()} className="font-semibold underline">
                Retry
              </button>
            </Notice>
          ))}

          {insights && !q && filter === 'all' && <HistoryInsights insights={insights} onAction={onInsightAction} />}

          {noResults && <Notice>No orders match “{q}”.</Notice>}

          {loading && (
            <>
              <SectionHeading title="Loading your orders…" />
              <div className="grid gap-3 xl:grid-cols-2">
                {[0, 1, 2, 3].map((i) => (
                  <CardSkeleton key={i} />
                ))}
              </div>
            </>
          )}

          {active.length > 0 && (
            <>
              <SectionHeading title="Active now" count={active.length} note="Tap Track for the live status" />
              {cards(active)}
            </>
          )}

          {show('food') && orders.kind === 'ready' && (
            <>
              <SectionHeading title="Food" count={food?.ok ? pastFood.length : undefined} note="Your last 15 orders across all addresses" />
              {sectionError(food, 'Food')}
              {food?.ok && pastFood.length > 0 && cards(pastFood)}
              {food?.ok && foodOrders.length === 0 && <Notice>No Food orders yet. Your orders will show up here.</Notice>}
              {food?.ok && foodOrders.length > 0 && pastFood.length === 0 && !q && active.length > 0 && (
                <Notice>All your Food orders are active right now.</Notice>
              )}
            </>
          )}

          {show('instamart') && orders.kind === 'ready' && (
            <>
              <SectionHeading title="Instamart" count={im?.ok ? pastIm.length : undefined} note="Last 15 days" />
              {sectionError(im, 'Instamart')}
              {im?.ok && pastIm.length > 0 && cards(pastIm)}
              {im?.ok && imOrders.length === 0 && (
                <Notice>
                  No Instamart orders in the last 15 days. Swiggy only shares the last 15 days of Instamart orders — older
                  ones are in the Swiggy app.
                </Notice>
              )}
            </>
          )}

          {(show('dineout') || show('scenes')) && (
            <>
              <SectionHeading
                title={filter === 'dineout' ? 'Dineout bookings' : filter === 'scenes' ? 'Scenes tickets' : 'Bookings'}
                count={bookings.kind === 'ready' ? visibleBookings.length : undefined}
                note="Made in Swizzo"
              />
              {bookings.kind === 'loading' && (
                <div className="grid gap-3 xl:grid-cols-2">
                  <CardSkeleton />
                </div>
              )}
              {bookings.kind === 'error' &&
                (bookings.needsLogin ? loginPrompt(bookings.message) : (
                  <Notice tone="error">
                    {bookings.message}{' '}
                    <button type="button" onClick={() => void refresh()} className="font-semibold underline">
                      Retry
                    </button>
                  </Notice>
                ))}
              {bookings.kind === 'ready' && visibleBookings.length > 0 && (
                <div className="grid gap-3 xl:grid-cols-2">
                  {visibleBookings.map((b) => (
                    <BookingCard key={`${b.saved.kind}-${b.saved.orderId}`} row={b} />
                  ))}
                </div>
              )}
              {bookings.kind === 'ready' && visibleBookings.length === 0 && !q && (
                <Notice>
                  No {filter === 'scenes' ? 'Scenes tickets' : filter === 'dineout' ? 'Dineout tables' : 'table or ticket bookings'}{' '}
                  made in Swizzo yet.
                </Notice>
              )}
              <p className="mt-2 text-[11px] leading-relaxed text-muted">
                Swiggy doesn&apos;t let apps list your Dineout or Scenes bookings, so only the ones you made here appear.
                Bookings made in the Swiggy app are in the Swiggy app.
              </p>
            </>
          )}

          <p className="mt-8 border-t border-hairline pt-4 text-center text-[11px] text-muted">
            Need to cancel or report a problem with a placed order? Call Swiggy customer care at{' '}
            <a href={`tel:${CARE_PHONE.replace(/-/g, '')}`} className="font-semibold text-coral hover:underline">
              {CARE_PHONE}
            </a>
            .
          </p>
        </div>
      </div>
    </section>
  );
}

export default HistoryView;
