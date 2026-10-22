'use client';

// Smart compare for Dineout: tick "Compare" on 2–3 restaurant cards → a tray
// appears → "Compare" opens a side-by-side sheet: photo, rating + count, cost
// for two, distance, headline offer / deals, highlights and amenities. Card
// data comes from render_restaurants_dineout; amenities / timings are filled
// from get_restaurant_details (via /api/dineout/details — cached server-side,
// fetched one at a time and only when the sheet opens, because Dineout is
// rate-limited). Best values per row are highlighted; nothing is invented —
// a missing value is shown as "—".
// AI verdict on top: "X wins on rating, Y on value" computed from these real
// rows (shared/aiRead dineoutCompareVerdict), plus a "For you" line from one
// tool-free model call over the same rows and the user's stated needs.

import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import type { DineoutRestaurant } from '@/shared/types';
import { useDialogA11y } from '@/frontend/hooks/useDialogA11y';
import { parseCostForTwo } from '@/frontend/utils/split';
import { AiReadPanel } from '@/frontend/components/catalog/AiReadPanel';
import { dineoutCompareVerdict, dineoutLine, headlineOffer } from '@/shared/aiRead';

export const MAX_COMPARE = 3;

/* --------------------------------- store --------------------------------- */

let picked: DineoutRestaurant[] = [];
const subs = new Set<() => void>();
const emit = () => subs.forEach((f) => f());

function subscribe(f: () => void) {
  subs.add(f);
  return () => {
    subs.delete(f);
  };
}

export function toggleDineoutCompare(r: DineoutRestaurant): 'added' | 'removed' | 'full' {
  if (picked.some((p) => p.id === r.id)) {
    picked = picked.filter((p) => p.id !== r.id);
    emit();
    return 'removed';
  }
  if (picked.length >= MAX_COMPARE) return 'full';
  picked = [...picked, r];
  emit();
  return 'added';
}

export function clearDineoutCompare() {
  picked = [];
  emit();
}

export function useDineoutCompare(): DineoutRestaurant[] {
  return useSyncExternalStore(
    subscribe,
    () => picked,
    () => picked,
  );
}

/* ----------------------------- compare toggle ---------------------------- */

export function CompareToggle({ restaurant }: { restaurant: DineoutRestaurant }) {
  const list = useDineoutCompare();
  const on = list.some((p) => p.id === restaurant.id);
  const full = !on && list.length >= MAX_COMPARE;
  return (
    <button
      type="button"
      onClick={() => toggleDineoutCompare(restaurant)}
      disabled={full}
      aria-pressed={on}
      title={full ? `Compare up to ${MAX_COMPARE} restaurants` : on ? 'Remove from compare' : 'Add to compare'}
      className={`inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-semibold backdrop-blur-sm transition-colors disabled:opacity-50 ${
        on ? 'bg-coral text-on-primary' : 'bg-black/60 text-white hover:bg-black/75'
      }`}
    >
      <span aria-hidden>{on ? '✓' : '⇆'}</span>
      {on ? 'Comparing' : 'Compare'}
    </button>
  );
}

/* ---------------------------------- tray --------------------------------- */

const detailsMemo = new Map<string, DineoutRestaurant>();

function num(text?: string): number | undefined {
  const m = text ? /([\d.]+)/.exec(text) : null;
  return m ? Number(m[1]) : undefined;
}

export function DineoutCompareTray() {
  const list = useDineoutCompare();
  const [open, setOpen] = useState(false);
  if (list.length === 0) return null;
  return (
    <>
      <div className="fixed inset-x-0 bottom-28 z-[70] flex justify-center px-4">
        <div className="flex w-full max-w-md items-center gap-3 rounded-2xl border border-hairline bg-canvas px-3 py-2.5 shadow-card animate-rise">
          <div className="flex -space-x-2">
            {list.map((r) => (
              <span key={r.id} className="h-8 w-8 overflow-hidden rounded-full border-2 border-canvas bg-surface-card">
                {r.imageUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img decoding="async" src={r.imageUrl} alt="" className="h-full w-full object-cover" referrerPolicy="no-referrer" />
                ) : (
                  <span className="flex h-full w-full items-center justify-center text-xs font-bold text-muted">{r.name.charAt(0)}</span>
                )}
              </span>
            ))}
          </div>
          <p className="min-w-0 flex-1 truncate text-xs text-body">
            <span className="font-semibold text-ink">{list.length}</span> of {MAX_COMPARE} picked
            {list.length < 2 ? ' · pick one more' : ''}
          </p>
          <button type="button" onClick={clearDineoutCompare} className="text-[11px] font-semibold text-muted hover:text-ink">
            Clear
          </button>
          <button
            type="button"
            disabled={list.length < 2}
            onClick={() => setOpen(true)}
            className="rounded-xl bg-coral px-3 py-2 text-xs font-semibold text-on-primary hover:bg-coral-active disabled:opacity-50"
          >
            Compare
          </button>
        </div>
      </div>
      {open && list.length >= 2 && <CompareSheet list={list} onClose={() => setOpen(false)} />}
    </>
  );
}

/* --------------------------------- sheet --------------------------------- */

function CompareSheet({ list, onClose }: { list: DineoutRestaurant[]; onClose: () => void }) {
  const panelRef = useRef<HTMLDivElement>(null);
  useDialogA11y(true, panelRef, onClose);
  const [details, setDetails] = useState<Record<string, DineoutRestaurant>>(() =>
    Object.fromEntries(list.flatMap((r) => (detailsMemo.has(r.id) ? [[r.id, detailsMemo.get(r.id) as DineoutRestaurant]] : []))),
  );
  const [loading, setLoading] = useState(false);
  const [note, setNote] = useState('');

  // get_restaurant_details for amenities / timings — one at a time; stop on a 429.
  useEffect(() => {
    let cancelled = false;
    const todo = list.filter((r) => !r.hasDetails && !detailsMemo.has(r.id) && r.latitude !== undefined && r.longitude !== undefined);
    if (!todo.length) return;
    void (async () => {
      setLoading(true);
      for (const r of todo) {
        if (cancelled) break;
        try {
          const qs = new URLSearchParams({ restaurantId: r.id, lat: String(r.latitude), lng: String(r.longitude) });
          const res = await fetch(`/api/dineout/details?${qs.toString()}`);
          if (res.status === 429) {
            if (!cancelled) setNote('Dineout is busy — showing the card details only. Try again in a minute.');
            break;
          }
          const json = (await res.json().catch(() => ({}))) as { ok?: boolean; restaurant?: DineoutRestaurant };
          if (json.ok && json.restaurant) {
            detailsMemo.set(r.id, json.restaurant);
            if (!cancelled) setDetails((d) => ({ ...d, [r.id]: json.restaurant as DineoutRestaurant }));
          }
        } catch {
          /* keep the card data */
        }
      }
      if (!cancelled) setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [list]);

  const rows = list.map((r) => {
    const d = details[r.id];
    return {
      ...r,
      timings: r.timings ?? d?.timings,
      amenities: r.amenities?.length ? r.amenities : d?.amenities,
      deals: r.deals?.length ? r.deals : d?.deals,
      offers: r.offers?.length ? r.offers : d?.offers,
      rating: r.rating ?? d?.rating,
      address: r.address ?? d?.address,
      dealDetails: r.dealDetails?.length ? r.dealDetails : d?.dealDetails,
      bookable: d?.bookable ?? r.bookable,
    };
  });
  const ratings = rows.map((r) => r.rating ?? -1);
  const costs = rows.map((r) => parseCostForTwo(r.costForTwo) ?? Infinity);
  const dists = rows.map((r) => num(r.distance) ?? Infinity);
  const bestRating = Math.max(...ratings);
  const bestCost = Math.min(...costs);
  const bestDist = Math.min(...dists);
  const verdict = dineoutCompareVerdict(rows);
  const verdictFacts = rows.map((r) =>
    [
      r.name,
      dineoutLine(r),
      headlineOffer(r) ? `offer: ${headlineOffer(r)}` : '',
      r.bankOffers?.length ? `bank: ${r.bankOffers.join('; ')}` : '',
      r.vendorHighlights?.length ? `perks: ${r.vendorHighlights.join(', ')}` : '',
      r.timings ?? '',
      (r.amenities ?? r.highlights)?.length ? `amenities: ${(r.amenities ?? r.highlights ?? []).join(', ')}` : '',
    ]
      .filter(Boolean)
      .join(' | '),
  );
  const allAmenities = [...new Set(rows.flatMap((r) => r.amenities ?? r.highlights ?? []))].slice(0, 14);

  const cell = 'px-3 py-2 align-top text-xs text-body';
  const win = 'font-semibold text-emerald-700 dark:text-emerald-400';

  if (typeof document === 'undefined') return null;
  return createPortal(
    <div className="fixed inset-0 z-[85] flex items-end justify-center sm:items-center" role="presentation">
      <button type="button" aria-label="Close compare" className="absolute inset-0 bg-black/50 backdrop-blur-[2px]" onClick={onClose} />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="dineout-compare-title"
        className="relative flex max-h-[92vh] w-full max-w-3xl flex-col overflow-hidden rounded-t-2xl border border-hairline bg-canvas shadow-card sm:rounded-2xl"
      >
        <div className="flex items-center justify-between border-b border-hairline px-5 py-3">
          <div>
            <h2 id="dineout-compare-title" className="font-display text-lg font-bold text-ink">
              Compare restaurants
            </h2>
            <p className="text-[11px] text-muted">
              Swiggy Dineout data{loading ? ' · loading amenities…' : ''} · best value in each row is green
            </p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="rounded-lg p-1.5 text-muted hover:bg-surface-card hover:text-ink">
            ✕
          </button>
        </div>
        {note && <p className="border-b border-hairline bg-amber-500/10 px-5 py-2 text-[11px] text-amber-700 dark:text-amber-300">{note}</p>}
        {verdict && (
          <div className="border-b border-hairline px-5 py-3">
            <AiReadPanel
              kind="compare"
              ready={!loading}
              cacheKey={rows.map((r) => `${r.id}:${r.amenities?.length ?? 0}`).join(',')}
              summary={verdict}
              facts={verdictFacts}
            />
          </div>
        )}
        <div className="overflow-auto">
          <table className="w-full min-w-[520px] border-collapse">
            <thead>
              <tr>
                <th className="w-28 px-3 py-2" />
                {rows.map((r) => (
                  <th key={r.id} scope="col" className="px-3 py-2 text-left align-top">
                    <div className="aspect-[16/10] w-full overflow-hidden rounded-lg bg-surface-card">
                      {r.imageUrl ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img decoding="async" src={r.imageUrl} alt={r.name} className="h-full w-full object-cover" referrerPolicy="no-referrer" />
                      ) : null}
                    </div>
                    <div className="mt-1.5 line-clamp-2 font-display text-sm font-bold text-ink">{r.name}</div>
                    <div className="line-clamp-1 text-[11px] font-normal text-muted">{r.cuisines.join(' · ')}</div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-hairline">
              <tr>
                <th scope="row" className="px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wider text-muted-soft">Rating</th>
                {rows.map((r, i) => (
                  <td key={r.id} className={`${cell} ${ratings[i] === bestRating && bestRating > 0 ? win : ''}`}>
                    {r.rating ? `★ ${r.rating.toFixed(1)}` : '—'}
                    {r.ratingCount ? <span className="block text-[10px] font-normal text-muted">{r.ratingCount.toLocaleString('en-IN')} ratings</span> : null}
                  </td>
                ))}
              </tr>
              <tr>
                <th scope="row" className="px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wider text-muted-soft">Cost for two</th>
                {rows.map((r, i) => (
                  <td key={r.id} className={`${cell} ${costs[i] === bestCost && Number.isFinite(bestCost) ? win : ''}`}>
                    {r.costForTwo || '—'}
                  </td>
                ))}
              </tr>
              <tr>
                <th scope="row" className="px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wider text-muted-soft">Distance</th>
                {rows.map((r, i) => (
                  <td key={r.id} className={`${cell} ${dists[i] === bestDist && Number.isFinite(bestDist) ? win : ''}`}>
                    {r.distance || '—'}
                    {(r.area || r.locality) && <span className="block text-[10px] text-muted">{r.area || r.locality}</span>}
                  </td>
                ))}
              </tr>
              <tr>
                <th scope="row" className="px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wider text-muted-soft">Offers</th>
                {rows.map((r) => {
                  const head = r.offerHeadline
                    ? [r.offerHeadline.logoText, r.offerHeadline.title, r.offerHeadline.subtitle].filter(Boolean).join(' ')
                    : undefined;
                  const lines = [head, ...(r.deals ?? []), ...(r.offers ?? [])].filter(
                    (x, i, a): x is string => !!x && a.indexOf(x) === i,
                  );
                  return (
                    <td key={r.id} className={cell}>
                      {lines.length ? (
                        <ul className="space-y-1">
                          {lines.slice(0, 3).map((l) => (
                            <li key={l} className="rounded bg-coral/10 px-1.5 py-0.5 text-[11px] font-medium text-coral">
                              {l}
                            </li>
                          ))}
                        </ul>
                      ) : (
                        '—'
                      )}
                    </td>
                  );
                })}
              </tr>
              {rows.some((r) => r.bankOffers?.length) && (
                <tr>
                  <th scope="row" className="px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wider text-muted-soft">Bank offers</th>
                  {rows.map((r) => (
                    <td key={r.id} className={cell}>
                      {r.bankOffers?.length ? r.bankOffers.join(' · ') : '—'}
                    </td>
                  ))}
                </tr>
              )}
              {rows.some((r) => r.vendorHighlights?.length) && (
                <tr>
                  <th scope="row" className="px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wider text-muted-soft">Perks</th>
                  {rows.map((r) => (
                    <td key={r.id} className={cell}>
                      {r.vendorHighlights?.length ? r.vendorHighlights.join(' · ') : '—'}
                    </td>
                  ))}
                </tr>
              )}
              <tr>
                <th scope="row" className="px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wider text-muted-soft">Table booking</th>
                {rows.map((r) => (
                  <td key={r.id} className={`${cell} ${r.bookable ? win : ''}`}>
                    {r.bookable === false ? 'Walk-in only' : r.bookable ? 'Bookable on Swiggy' : '—'}
                  </td>
                ))}
              </tr>
              <tr>
                <th scope="row" className="px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wider text-muted-soft">Timings</th>
                {rows.map((r) => (
                  <td key={r.id} className={cell}>
                    {r.timings || '—'}
                  </td>
                ))}
              </tr>
              {allAmenities.map((a) => (
                <tr key={a}>
                  <th scope="row" className="px-3 py-1.5 text-left text-[11px] font-normal text-muted">{a}</th>
                  {rows.map((r) => {
                    const known = r.amenities?.length || r.highlights?.length;
                    const has = (r.amenities ?? r.highlights ?? []).includes(a);
                    return (
                      <td key={r.id} className="px-3 py-1.5 text-xs">
                        {has ? (
                          <span className="text-emerald-700 dark:text-emerald-400" aria-label="Yes">✓</span>
                        ) : known ? (
                          <span className="text-muted-soft" aria-label="Not listed">–</span>
                        ) : (
                          <span className="text-muted-soft">?</span>
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="border-t border-hairline px-5 py-2 text-right text-[10px] font-medium text-muted">Powered by Dineout</p>
      </div>
    </div>,
    document.body,
  );
}

export default DineoutCompareTray;
