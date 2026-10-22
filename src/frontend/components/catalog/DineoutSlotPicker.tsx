'use client';

// Dineout slot picker — renders one get_available_slots result (up to 7 days from
// a single call; switching dates never refetches) and walks the documented
// booking flow (docs/swiggy-mcp/dineout.md):
//   FREE deal → confirm → book_table (via onBookSlot)
//   PAID deal → create_cart (/api/dineout/cart) → Booking Summary → "Proceed to
//               payment" → get_payment_options → pick UPI app / scan-QR →
//               book_table with UPI (via onBookSlot) → PaymentModal polls.
// Every id sent to Swiggy (slotId, itemId, reservationTime) is copied verbatim
// from the selected slot + deal.
//
// LIVE: while the picker is on screen, the tab is visible and the user is still
// choosing, the 7-day slots are re-read (GET /api/dineout/search?restaurantId=…)
// at most once every 60 s — Dineout is rate-limited, the server also caches
// slots for 60 s and honours its 429 cool-down (a busy reply pauses polling).
// Each date shows how many slots are open, free vs paid, and the top discount;
// changed slots flash.
//
// AI-FIRST: an "AI picks" strip ranks 2–3 concrete options from the live slots
// (Soonest / Best value / Prime time — shared/picker rankDineoutPicks; the
// model's AI read supplies the one-line reasons). "Book this" fills date, time,
// deal and guests and opens the final step (free: the confirm summary; paid:
// create_cart → Booking Summary). The chat drives the same path via
// pickerSelect events (utils/pickerBridge) — the user always taps the final
// Confirm / Pay; nothing books without it.

import { useEffect, useMemo, useRef, useState } from 'react';
import { AiPicksStrip } from '@/frontend/components/catalog/AiPicksStrip';
import { LiveStamp } from '@/frontend/components/features/LiveStamp';
import { ReportProblemButton } from '@/frontend/components/features/ReportProblemButton';
import { istDate, slotSummary } from '@/frontend/utils/bestDeal';
import { diffSlots, type Change } from '@/frontend/utils/liveDiff';
import { autoCartHeld, registerPicker } from '@/frontend/utils/pickerBridge';
import { useLivePoll } from '@/frontend/utils/useLivePoll';
import { revealPick } from '@/frontend/utils/revealPick';
import { isMobileDevice } from '@/frontend/utils/device';
import { buildDineoutActivePicker, oneTapPick, rankDineoutPicks, resolveDineoutPick } from '@/shared/picker';
import type {
  ActivePicker,
  PickerSelectFields,
  DineoutCart,
  DineoutDeal,
  DineoutSlot,
  DineoutSlotChoice,
  DineoutSlotsView,
  PaymentMethodItem,
  PaymentOptionsPayload,
} from '@/shared/types';

export interface DineoutSlotPickerProps {
  view: DineoutSlotsView;
  /** The chat message this picker lives in (chat → picker selections route by it). */
  messageId?: string;
  /** Books the choice; resolves true when the booking (or payment hand-off) went through. */
  onBookSlot?: (
    restaurantId: string,
    restaurantName: string,
    choice: DineoutSlotChoice,
    guestCount: number,
  ) => Promise<boolean> | void;
}

type Step = 'select' | 'summary' | 'payment';

const MAX_GUESTS = 20;

/** "Wed, 22 Oct" from a YYYY-MM-DD calendar date (IST date as given by Swiggy). */
function dateLabel(dateStr: string): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  if (!y || !m || !d) return dateStr || 'Date';
  const istToday = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  const [ty, tm, td] = istToday.split('-').map(Number);
  const days = Math.round((Date.UTC(y, m - 1, d) - Date.UTC(ty, tm - 1, td)) / 86_400_000);
  const label = new Date(y, m - 1, d).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' });
  return days === 0 ? `Today · ${label.split(', ').pop()}` : days === 1 ? `Tomorrow · ${label.split(', ').pop()}` : label;
}

// Live slots carry no inventory field — a slot is bookable unless Swiggy
// explicitly says 0 left or every deal is sold out.
function slotBookable(s: DineoutSlot): boolean {
  return s.availableInventory !== 0 && s.deals.some((d) => !d.soldOut);
}

function dealPrice(d: DineoutDeal): string {
  if (d.isFree) return 'Free';
  if (d.bookingPrice && d.bookingPrice > 0) return `₹${d.bookingPrice.toLocaleString('en-IN')}`;
  return d.displayFee || 'Paid';
}

function inr(n?: number): string {
  return typeof n === 'number' && Number.isFinite(n) ? `₹${n.toLocaleString('en-IN')}` : '—';
}

/** UPI app (intent) + scan-QR choices from the live get_payment_options result only. */
function upiChoices(options: PaymentOptionsPayload | null): { apps: PaymentMethodItem[]; qr: PaymentMethodItem[] } {
  if (!options) return { apps: [], qr: [] };
  const mobile = options.platforms?.mobile?.methods ?? [];
  const desktop = options.platforms?.desktop?.methods ?? [];
  const all = options.allMethods ?? [];
  const usable = (m: PaymentMethodItem) => m.enabled !== false && m.paymentMethod !== 'Cash' && m.paymentMethod !== 'SwiggyPay';
  const apps = (mobile.length ? mobile : all.filter((m) => m.kind === 'intent')).filter(usable);
  const qr = (desktop.length ? desktop : all.filter((m) => m.kind === 'qr' || m.isQr)).filter(usable);
  // a UPI app link can't open on a laptop — offer scan-QR there when Swiggy has it
  if (!isMobileDevice() && qr.length) return { apps: [], qr };
  return { apps, qr };
}

const SLOTS_REFRESH_MS = 60_000;

export function DineoutSlotPicker({ view, messageId, onBookSlot }: DineoutSlotPickerProps) {
  const { restaurantId, restaurantName, latitude, longitude } = view;
  // The live copy of the slots (refreshed while open); starts as the chat card's.
  const [slots, setSlots] = useState<DineoutSlot[]>(view.slots);
  const [changes, setChanges] = useState<Map<string, Change>>(new Map());
  const [liveNote, setLiveNote] = useState('');
  const [mountedAt] = useState(() => Date.now());
  const rootRef = useRef<HTMLDivElement>(null);
  const slotsRef = useRef<DineoutSlot[]>(view.slots);

  const dates = useMemo(() => {
    const seen: string[] = [];
    for (const s of slots) if (s.dateStr && !seen.includes(s.dateStr)) seen.push(s.dateStr);
    return seen;
  }, [slots]);

  const [guestCount, setGuestCount] = useState(2);
  const [selectedDate, setSelectedDate] = useState<string>(() => dates[0] ?? '');
  // Slots are identified by key (date|reservationTime): every slot of a
  // restaurant shares the same deal slotId, so slotId cannot tell them apart.
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null);
  const [step, setStep] = useState<Step>('select');
  const [cart, setCart] = useState<DineoutCart | null>(null);
  const [options, setOptions] = useState<PaymentOptionsPayload | null>(null);
  const [methodId, setMethodId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // the Swiggy tool behind `error` (for "Report a problem"); null = not Swiggy's
  const [failed, setFailed] = useState<{ tool: string; reportId?: string } | null>(null);
  const [done, setDone] = useState(false);
  const [pickedFlash, setPickedFlash] = useState(false);
  // the model's one-line reasons for the AI picks (WHY: lines), by pick id
  const [pickReasons, setPickReasons] = useState<Record<string, string>>({});
  // a free table filled by "Book this" / chat: `${key}|${itemId}|${guests}` →
  // show the confirm summary while the selection still matches it
  const [readyKey, setReadyKey] = useState<string | null>(null);

  // Slots of the chosen date, grouped by meal window in Swiggy's order.
  const groups = useMemo(() => {
    const out: { name: string; slots: DineoutSlot[] }[] = [];
    for (const s of slots) {
      if (s.dateStr !== selectedDate) continue;
      const name = s.slotGroupName || 'Slots';
      const g = out.find((x) => x.name === name);
      if (g) g.slots.push(s);
      else out.push({ name, slots: [s] });
    }
    return out;
  }, [slots, selectedDate]);

  const slot = slots.find((s) => s.key === selectedKey) ?? null;
  const deal = slot?.deals.find((d) => d.itemId === selectedItemId) ?? null;
  const { apps, qr } = upiChoices(options);
  const locked = busy || done;

  // Live re-read of the same 7-day window (first date = today or the card's first date).
  const startDate = [istDate(), dates[0] ?? ''].sort().pop() || istDate();
  const poll = useLivePoll(
    async (signal) => {
      const qs = new URLSearchParams({
        restaurantId,
        date: startDate,
        lat: String(latitude),
        lng: String(longitude),
        ...(restaurantName ? { restaurantName } : {}),
      });
      const res = await fetch(`/api/dineout/search?${qs.toString()}`, { signal });
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean; slots?: DineoutSlot[]; message?: string; busy?: boolean };
      if (res.status === 429 || data.busy) return 'Dineout is busy — retrying in a minute';
      if (!res.ok || !data.ok || !Array.isArray(data.slots)) return data.message || 'Could not refresh slots';
      const next = data.slots;
      const diff = diffSlots(slotsRef.current, next, slotBookable);
      slotsRef.current = next;
      setSlots(next);
      setChanges(diff);
      if (diff.size) window.setTimeout(() => setChanges(new Map()), 4000);
      // The chosen slot / deal just went away → say so and clear it.
      if (selectedKey) {
        const still = next.find((s) => s.key === selectedKey);
        const d = still?.deals.find((x) => x.itemId === selectedItemId);
        if (!still || !slotBookable(still) || !d || d.soldOut) {
          setSelectedKey(null);
          setSelectedItemId(null);
          setLiveNote('The time you picked was just taken — please choose another slot.');
        }
      }
    },
    { intervalMs: SLOTS_REFRESH_MS, minIntervalMs: SLOTS_REFRESH_MS, enabled: step === 'select' && !done && !busy, ref: rootRef, initialUpdated: mountedAt },
  );

  const summary = useMemo(() => slotSummary(slots, poll.lastUpdated ?? mountedAt), [slots, poll.lastUpdated, mountedAt]);
  // 2–3 concrete recommendations ranked from the live slots (soonest / value / prime time)
  const aiPicks = useMemo(() => rankDineoutPicks(slots, { guests: guestCount }), [slots, guestCount]);

  const resetFlow = () => {
    setStep('select');
    setCart(null);
    setOptions(null);
    setMethodId(null);
    setError(null);
    setFailed(null);
  };

  const pickSlot = (s: DineoutSlot) => {
    if (locked) return;
    resetFlow();
    setLiveNote('');
    setSelectedKey(s.key);
    // Default to the free table booking when there is one; else the first open deal.
    const firstOpen = s.deals.find((d) => !d.soldOut && d.isFree) ?? s.deals.find((d) => !d.soldOut);
    setSelectedItemId(firstOpen ? firstOpen.itemId : null);
  };

  const slotArgs = () =>
    slot && deal
      ? {
          restaurantId,
          slotId: deal.slotId,
          itemId: deal.itemId,
          reservationTime: slot.reservationTime,
          guestCount,
          latitude,
          longitude,
        }
      : null;

  const book = async (payment?: DineoutSlotChoice['payment']) => {
    if (!slot || !deal || !onBookSlot) return;
    setBusy(true);
    setError(null);
    setFailed(null);
    try {
      const ok = await onBookSlot(
        restaurantId,
        restaurantName,
        { slot, deal, latitude, longitude, payment },
        guestCount,
      );
      if (ok) setDone(true);
    } finally {
      setBusy(false);
    }
  };

  // PAID: create_cart, then show the Booking Summary and STOP.
  // `o` = an explicit selection (AI pick / chat "book it") applied this same tick.
  const createCart = async (o?: { slot: DineoutSlot; deal: DineoutDeal; guests: number }) => {
    const args = o
      ? {
          restaurantId,
          slotId: o.deal.slotId,
          itemId: o.deal.itemId,
          reservationTime: o.slot.reservationTime,
          guestCount: o.guests,
          latitude,
          longitude,
        }
      : slotArgs();
    if (!args) return;
    setBusy(true);
    setError(null);
    setFailed(null);
    try {
      const res = await fetch('/api/dineout/cart', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(args),
      });
      const data = await res.json().catch(() => ({}));
      if (data?.ok && data.cart?.cartKey) {
        setCart(data.cart as DineoutCart);
        setStep('summary');
      } else {
        setError(data?.message || 'Swiggy could not create a booking cart for this deal.');
        setFailed({ tool: 'create_cart', reportId: data?.reportId });
      }
    } catch {
      setError('Network error while creating the booking cart. Please try again.');
    } finally {
      setBusy(false);
    }
  };

  // Chat / AI pick → picker: apply a selection to THIS picker's live slots.
  const applyPick = (sel: PickerSelectFields) => {
    if (locked) return;
    if (step !== 'select') resetFlow();
    const r = resolveDineoutPick(slotsRef.current, sel, { date: selectedDate });
    if (r.date) setSelectedDate(r.date);
    if (r.key) {
      setSelectedKey(r.key);
      setSelectedItemId(r.itemId ?? null);
    } else if (r.date && r.date !== selectedDate) {
      setSelectedKey(null);
      setSelectedItemId(null);
    }
    const guests = r.guests ?? guestCount;
    if (r.guests !== undefined) setGuestCount(r.guests);
    setLiveNote(r.notes.join(' '));
    setReadyKey(null);
    setPickedFlash(true);
    window.setTimeout(() => setPickedFlash(false), 2200);
    revealPick(rootRef.current);
    // "Book it": free → the confirm summary (book_table runs only on the user's
    // Confirm tap); paid → create_cart → Booking Summary (a cart, not a booking).
    if (sel.confirm && r.key && r.itemId) {
      const s = slotsRef.current.find((x) => x.key === r.key);
      const d = s?.deals.find((x) => x.itemId === r.itemId);
      if (s && d && !d.soldOut) {
        if (d.isFree) setReadyKey(`${s.key}|${d.itemId}|${guests}`);
        // (Plan run active: select only — the user taps Proceed for the paid cart)
        else if (!autoCartHeld()) void createCart({ slot: s, deal: d, guests });
      }
    }
  };
  const snapshot = (): ActivePicker | null =>
    messageId && !done
      ? buildDineoutActivePicker(messageId, { restaurantId, restaurantName }, slotsRef.current, {
          date: selectedDate,
          key: selectedKey ?? undefined,
          itemId: selectedItemId ?? undefined,
          guests: guestCount,
        })
      : null;
  // one-tap "Book best slot" from the results / details sheet → the top AI pick
  const best = () => (locked ? null : oneTapPick('dineout', aiPicks));
  const bridgeRef = useRef({ applyPick, snapshot, best });
  useEffect(() => {
    bridgeRef.current = { applyPick, snapshot, best };
  });
  useEffect(() => {
    if (!messageId) return;
    return registerPicker(messageId, {
      kind: 'dineout',
      snapshot: () => bridgeRef.current.snapshot(),
      apply: (sel) => bridgeRef.current.applyPick(sel),
      best: () => bridgeRef.current.best(),
      reasons: (list) => setPickReasons(Object.fromEntries(list.map((x) => [x.id, x.why]))),
    });
  }, [messageId]);
  const ready = !!slot && !!deal && deal.isFree && readyKey === `${slot.key}|${deal.itemId}|${guestCount}`;

  // "Proceed to payment" → live get_payment_options for Dineout.
  const loadPaymentOptions = async () => {
    setBusy(true);
    setError(null);
    setFailed(null);
    try {
      const res = await fetch('/api/payments/options?service=dineout');
      const data = await res.json().catch(() => ({}));
      const opts = (data?.options ?? null) as PaymentOptionsPayload | null;
      const choices = upiChoices(opts);
      if (data?.ok && opts && (choices.apps.length || choices.qr.length)) {
        setOptions(opts);
        setMethodId(null);
        setStep('payment');
      } else {
        setError(data?.message || 'Swiggy returned no UPI payment options for this booking right now.');
        setFailed({ tool: 'get_payment_options', reportId: data?.reportId });
      }
    } catch {
      setError('Network error while loading payment options. Please try again.');
    } finally {
      setBusy(false);
    }
  };

  const pay = () => {
    if (!cart || !methodId) return;
    const qrPick = qr.find((m) => m.id === methodId);
    const appPick = apps.find((m) => m.id === methodId);
    if (!qrPick && !appPick) return;
    void book({
      cartKey: cart.cartKey,
      amount: cart.billToPay,
      // UPI app: copy the method id into intentApp; scan-QR: generateUPIQR.
      ...(qrPick ? { generateUPIQR: true } : { intentApp: appPick?.intentApp || appPick?.id }),
    });
  };

  const isPaid = deal ? !deal.isFree : false;

  return (
    <div
      ref={rootRef}
      className={`relative w-full max-w-lg overflow-hidden rounded-2xl border border-hairline bg-canvas p-5 shadow-card animate-rise transition-shadow duration-500 ${
        pickedFlash ? 'ring-2 ring-coral ring-offset-2 ring-offset-canvas' : ''
      }`}
    >
      {/* Header */}
      <div className="border-b border-hairline pb-4">
        <span className="text-[11px] font-bold uppercase tracking-wider text-coral">Table Reservation</span>
        <h2 className="mt-0.5 font-display text-xl font-bold text-ink">{restaurantName || 'Restaurant'}</h2>
        {slots.length > 0 && (
          <LiveStamp
            className="mt-1.5"
            lastUpdated={poll.lastUpdated}
            live={poll.live}
            refreshing={poll.refreshing}
            onRefresh={poll.refresh}
            cadence="every 60 s"
            error={poll.error}
          />
        )}
      </div>

      {slots.length === 0 ? (
        <div className="mt-4 rounded-xl border border-dashed border-hairline p-4 text-center text-xs text-muted">
          Swiggy shows no bookable slots for the next 7 days.
        </div>
      ) : (
        <div className="mt-5 space-y-5">
          {/* AI picks — ranked from every live slot; "Book this" opens the final step */}
          {step === 'select' && !done && (
            <AiPicksStrip picks={aiPicks} reasons={pickReasons} disabled={locked} onBook={(p) => applyPick({ ...p.sel, confirm: true })} />
          )}

          {/* Guests */}
          <div>
            <label className="text-xs font-semibold uppercase tracking-wider text-muted-soft">Guests</label>
            <div className="mt-2 flex items-center gap-3">
              <button
                type="button"
                disabled={locked || step !== 'select' || guestCount <= 1}
                onClick={() => setGuestCount((n) => Math.max(1, n - 1))}
                className="flex h-9 w-9 items-center justify-center rounded-xl border border-hairline text-sm text-ink disabled:opacity-40"
                aria-label="Fewer guests"
              >
                −
              </button>
              <span className="min-w-[3ch] text-center text-sm font-semibold text-ink">{guestCount}</span>
              <button
                type="button"
                disabled={locked || step !== 'select' || guestCount >= MAX_GUESTS}
                onClick={() => setGuestCount((n) => Math.min(MAX_GUESTS, n + 1))}
                className="flex h-9 w-9 items-center justify-center rounded-xl border border-hairline text-sm text-ink disabled:opacity-40"
                aria-label="More guests"
              >
                +
              </button>
            </div>
          </div>

          {/* Dates — all from the one get_available_slots call */}
          <div>
            <label className="text-xs font-semibold uppercase tracking-wider text-muted-soft">Date</label>
            <div className="mt-2 flex items-center gap-2 overflow-x-auto pb-1">
              {dates.map((d) => {
                const sum = summary.get(d);
                const sel = selectedDate === d;
                // Swiggy's own headline for the day (slots[].daySubtext, e.g. "15% off")
                const daySub = slots.find((x) => x.dateStr === d && x.daySubtext)?.daySubtext;
                return (
                  <button
                    key={d}
                    type="button"
                    data-picked={sel ? 'true' : undefined}
                    disabled={locked || step !== 'select'}
                    onClick={() => {
                      setSelectedDate(d);
                      setSelectedKey(null);
                      setSelectedItemId(null);
                    }}
                    aria-label={`${dateLabel(d)}: ${sum ? `${sum.open} of ${sum.total} slots open` : ''}`}
                    className={`shrink-0 rounded-xl px-3 py-1.5 text-left text-xs font-medium transition-all disabled:opacity-60 ${
                      sel ? 'bg-ink text-canvas shadow-xs' : 'border border-hairline bg-surface-card/60 text-body hover:text-ink'
                    } ${sum && sum.open === 0 ? 'opacity-60' : ''}`}
                  >
                    <span className="block">{dateLabel(d)}</span>
                    {sum && (
                      <span className={`block text-[10px] font-normal ${sel ? 'text-canvas/75' : 'text-muted'}`}>
                        {sum.open === 0
                          ? 'Fully booked'
                          : `${sum.open} open${sum.free ? ` · ${sum.free} free` : ''}${!daySub && sum.maxDiscount ? ` · ≤${sum.maxDiscount}% off` : ''}`}
                      </span>
                    )}
                    {daySub && sum && sum.open > 0 && (
                      <span className={`block text-[10px] font-semibold ${sel ? 'text-canvas' : 'text-coral'}`}>{daySub}</span>
                    )}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Times grouped by meal window */}
          <div className="space-y-3">
            {groups.length === 0 && (
              <div className="rounded-xl border border-dashed border-hairline p-4 text-center text-xs text-muted">
                No slots on this date. Try another day.
              </div>
            )}
            {groups.map((g) => {
              const open = g.slots.filter(slotBookable).length;
              const paid = g.slots.filter((s) => s.deals.some((d) => !d.isFree && !d.soldOut)).length;
              return (
              <div key={g.name}>
                <div className="flex items-baseline justify-between gap-2 text-xs font-semibold uppercase tracking-wider text-muted-soft">
                  <span>{g.name}</span>
                  <span className="text-[10px] font-medium normal-case tracking-normal text-muted">
                    {open} of {g.slots.length} open{paid ? ` · ${paid} with paid deals` : ''}
                  </span>
                </div>
                <div className="mt-2 grid grid-cols-3 gap-2 sm:grid-cols-4">
                  {g.slots.map((s) => {
                    const open = slotBookable(s);
                    const isSel = s.key === selectedKey;
                    const hasFree = s.deals.some((d) => d.isFree && !d.soldOut);
                    const changed = changes.get(s.key);
                    const left = s.availableInventory ?? s.deals.reduce<number | undefined>(
                      (n, d) => (d.availableInventory === undefined ? n : (n ?? 0) + d.availableInventory),
                      undefined,
                    );
                    return (
                      <button
                        key={s.key}
                        type="button"
                        disabled={!open || locked || step !== 'select'}
                        onClick={() => pickSlot(s)}
                        className={`flex flex-col items-center justify-center rounded-xl p-2.5 text-center transition-all duration-500 ${
                          changed ? 'ring-2 ring-amber-400 ring-offset-1 ring-offset-canvas' : ''
                        } ${
                          !open
                            ? 'cursor-not-allowed border border-hairline bg-surface-card/30 opacity-40'
                            : isSel
                              ? 'border-2 border-coral bg-coral/10 font-bold text-coral shadow-xs'
                              : 'border border-hairline bg-surface-card/50 text-ink hover:border-coral/40'
                        }`}
                      >
                        <span className="text-xs font-semibold">{s.displayTime}</span>
                        <span className={`mt-0.5 line-clamp-1 text-[9px] ${isSel ? 'text-coral' : 'text-muted'}`}>
                          {!open
                            ? changed === 'soldout'
                              ? 'Just booked'
                              : 'Full'
                            : left !== undefined && left <= 5
                              ? `${left} left`
                              : s.subText || (hasFree ? 'Free' : 'Prebook')}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
              );
            })}
          </div>

          {/* Deals for the chosen slot — FREE and PAID both surfaced */}
          {slot && step === 'select' && (
            <div>
              <label className="text-xs font-semibold uppercase tracking-wider text-muted-soft">
                Deal for {slot.displayTime}
              </label>
              <div className="mt-2 space-y-2">
                {slot.deals.map((d) => (
                  <button
                    key={d.itemId}
                    type="button"
                    disabled={d.soldOut || locked}
                    onClick={() => setSelectedItemId(d.itemId)}
                    className={`flex w-full items-center justify-between gap-3 rounded-xl px-3 py-2 text-left text-xs transition-all disabled:opacity-40 ${
                      selectedItemId === d.itemId
                        ? 'border-2 border-coral bg-coral/10'
                        : 'border border-hairline bg-surface-card/50 hover:border-coral/40'
                    }`}
                  >
                    <span className="min-w-0">
                      <span className="block font-semibold text-ink">
                        {d.title || (d.isFree ? 'Table reservation' : 'Prebook deal')}
                      </span>
                      <span className="block text-[11px] text-muted">
                        {d.soldOut
                          ? 'Sold out'
                          : d.isFree
                            ? `Free reservation · no booking fee${d.discountPercentage ? ` · ${d.discountPercentage}% off the bill` : ''}`
                            : `Paid prebook${d.bookingPrice ? ` · ₹${d.bookingPrice.toLocaleString('en-IN')} booking fee` : ''}${
                                d.discountPercentage ? ` · ${d.discountPercentage}% off the bill` : ''
                              }`}
                      </span>
                    </span>
                    <span className={`shrink-0 font-bold ${d.isFree ? 'text-emerald-700' : 'text-coral'}`}>
                      {dealPrice(d)}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* PAID: Booking Summary after create_cart — stop until the user proceeds */}
          {step !== 'select' && slot && deal && cart && (
            <div className="rounded-xl border border-hairline bg-surface-card/60 p-3 text-xs">
              <div className="font-semibold text-ink">Booking summary</div>
              <div className="mt-1.5 space-y-0.5 text-body">
                <div>
                  {dateLabel(slot.dateStr)} · {slot.displayTime} · {guestCount} guest{guestCount === 1 ? '' : 's'}
                </div>
                <div>{deal.title || 'Prebook deal'}</div>
                <div className="pt-1 font-semibold text-ink">To pay: {inr(cart.billToPay)}</div>
              </div>
            </div>
          )}

          {/* PAID: UPI choices from get_payment_options (no Cash on Dineout) */}
          {step === 'payment' && (
            <div>
              <label className="text-xs font-semibold uppercase tracking-wider text-muted-soft">Pay with UPI</label>
              <div className="mt-2 grid grid-cols-2 gap-2">
                {[...apps, ...qr].map((m) => (
                  <button
                    key={m.id}
                    type="button"
                    disabled={locked}
                    onClick={() => setMethodId(m.id)}
                    className={`flex items-center gap-2 rounded-xl px-3 py-2 text-left text-xs transition-all ${
                      methodId === m.id
                        ? 'border-2 border-coral bg-coral/10'
                        : 'border border-hairline bg-surface-card/50 hover:border-coral/40'
                    }`}
                  >
                    {m.iconUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img decoding="async" src={m.iconUrl} alt="" className="h-5 w-5 rounded" />
                    ) : null}
                    <span className="truncate font-medium text-ink">
                      {m.displayName || m.name || (qr.includes(m) ? 'Scan UPI QR' : m.id)}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {liveNote && !error && (
            <div role="status" className="rounded-xl border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
              {liveNote}
            </div>
          )}

          {error && (
            <div className="rounded-xl border border-red-500/30 bg-red-500/5 px-3 py-2 text-xs text-red-700 dark:text-red-400">
              {error}
              {failed && (
                <ReportProblemButton
                  service="dineout"
                  tool={failed.tool}
                  errorMessage={error}
                  flowDescription={`slot picker → ${failed.tool}`}
                  toolContext={{ restaurantId, slotId: deal?.slotId, itemId: deal?.itemId, guestCount }}
                  reportId={failed.reportId}
                />
              )}
            </div>
          )}

          {/* "Book this" / chat filled a free table: the summary the user confirms */}
          {ready && step === 'select' && !done && slot && deal && (
            <div role="status" className="rounded-xl border border-emerald-500/40 bg-emerald-500/10 p-3 text-xs text-body">
              <p className="font-semibold text-ink">Ready to book — tap Confirm below</p>
              <p className="mt-0.5">
                {dateLabel(slot.dateStr)} · {slot.displayTime} · {guestCount} guest{guestCount === 1 ? '' : 's'} ·{' '}
                {deal.title || 'Table reservation'} (free)
              </p>
            </div>
          )}

          {/* Primary action per step */}
          {done ? (
            <div className="rounded-xl bg-emerald-500/10 py-3 text-center text-xs font-semibold text-emerald-700 dark:text-emerald-400">
              {isPaid ? 'Payment started — finish it in the payment window.' : 'Booking request sent — see the confirmation below.'}
            </div>
          ) : step === 'select' ? (
            <button
              type="button"
              data-picker-cta
              disabled={!slot || !deal || deal.soldOut || locked || !onBookSlot}
              onClick={() => (isPaid ? void createCart() : void book())}
              className={`w-full rounded-xl bg-coral py-3 text-xs font-semibold text-on-primary shadow-xs transition-all hover:bg-coral-active disabled:opacity-50 ${
                ready ? 'ring-2 ring-emerald-500 ring-offset-2 ring-offset-canvas' : ''
              }`}
            >
              {busy
                ? 'Please wait…'
                : !slot || !deal
                  ? 'Pick a time and deal'
                  : isPaid
                    ? `Continue · ${dealPrice(deal)} deal for ${guestCount}`
                    : `Confirm table for ${guestCount} · ${slot.displayTime}`}
            </button>
          ) : step === 'summary' ? (
            <div className="flex gap-2">
              <button
                type="button"
                disabled={locked}
                onClick={resetFlow}
                className="flex-1 rounded-xl border border-hairline py-3 text-xs font-semibold text-body"
              >
                Change
              </button>
              <button
                type="button"
                disabled={locked}
                onClick={() => void loadPaymentOptions()}
                className="flex-[2] rounded-xl bg-coral py-3 text-xs font-semibold text-on-primary shadow-xs hover:bg-coral-active disabled:opacity-50"
              >
                {busy ? 'Loading…' : 'Proceed to payment'}
              </button>
            </div>
          ) : (
            <div className="flex gap-2">
              <button
                type="button"
                disabled={locked}
                onClick={resetFlow}
                className="flex-1 rounded-xl border border-hairline py-3 text-xs font-semibold text-body"
              >
                Change
              </button>
              <button
                type="button"
                disabled={!methodId || locked}
                onClick={pay}
                className="flex-[2] rounded-xl bg-coral py-3 text-xs font-semibold text-on-primary shadow-xs hover:bg-coral-active disabled:opacity-50"
              >
                {busy ? 'Starting payment…' : `Pay ${inr(cart?.billToPay)} & book`}
              </button>
            </div>
          )}
        </div>
      )}

      <div className="mt-4 text-right text-[10px] font-medium text-muted">Powered by Dineout</div>
    </div>
  );
}

export default DineoutSlotPicker;
