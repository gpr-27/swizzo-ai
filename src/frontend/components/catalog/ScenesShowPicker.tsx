'use client';

// Scenes ticket picker — the documented booking flow, step by step:
//   1. pick a date, a show (show_time_ist), a ticket tier (tickets[].id) and a
//      count within the show's purchaseRules.allowedCovers (≤ 20) and seats left
//   2. POST /api/scenes/cart  → create_event_cart → Swiggy's cart summary + checkoutMode
//   3. the user reviews that summary and explicitly confirms
//      FREE → POST /api/scenes/order {paymentMethod:"FREE", echoed selection}
//      UPI  → GET /api/payments/options?service=scenes&cartKey → the user picks a
//             RETURNED method → POST /api/scenes/order {paymentMethod:"UPI", intentApp | generateUPIQR}
//             → the real PENDING_PAYMENT session goes to the payment sheet
//      UNAVAILABLE → stop with Swiggy's message
// Bookable listings are always venue-scoped: without a venueId the picker
// re-fetches via get_event_details → list_event_shows{eventId, venueId}.
//
// LIVE: while the picker is open, on screen and the tab visible, the venue's
// list_event_shows is re-read every 45 s (GET /api/scenes/shows) — seats left
// per date (dateSummary.totalAvailableInventory), per show
// (maxAvailableInventory) and per ticket tier (availableInventory) stay current;
// changed tiles flash, ≤ 5 left reads "Selling fast", 0 reads "Sold out".
// Seats are re-validated with a fresh read right before create_event_cart.
//
// CHAT: the picker registers with the chat bridge (utils/pickerBridge) under its
// message id — the chat sends its live listing + selection with each turn, and a
// `pickerSelect` ("Sun 25 Oct, Entry Pass For Two") is applied HERE to this
// picker's own live data (resolveScenesPick): exact date, show by time/id,
// ticket by id/name, clamped count; a date with several shows waits for the
// user's tap; anything not offered shows an inline note. Never creates a cart.

import { useEffect, useMemo, useRef, useState } from 'react';
import { AiPicksStrip } from '@/frontend/components/catalog/AiPicksStrip';
import { AiReadPanel } from '@/frontend/components/catalog/AiReadPanel';
import { currentNeeds } from '@/frontend/state/userNeeds';
import { scenesFacts, scenesFitLine } from '@/shared/aiRead';
import { ScenesPoster } from '@/frontend/components/catalog/ScenesEventCard';
import { BillSplit } from '@/frontend/components/features/BillSplit';
import { CountdownChip } from '@/frontend/components/features/BookingActions';
import { LiveStamp } from '@/frontend/components/features/LiveStamp';
import { ReportProblemButton } from '@/frontend/components/features/ReportProblemButton';
import { diffShows, SELLING_FAST, type Change } from '@/frontend/utils/liveDiff';
import { directionsUrl } from '@/frontend/utils/maps';
import { autoCartHeld, registerPicker } from '@/frontend/utils/pickerBridge';
import { useLivePoll } from '@/frontend/utils/useLivePoll';
import { revealPick } from '@/frontend/utils/revealPick';
import { isMobileDevice } from '@/frontend/utils/device';
import { useDialogA11y } from '@/frontend/hooks/useDialogA11y';
import { buildScenesActivePicker, matchTicket, oneTapPick, rankScenesPicks, resolveScenesPick } from '@/shared/picker';
import type {
  ActivePicker,
  BookingTrackerExtras,
  PaymentMethodItem,
  PickerSelectFields,
  PaymentOptionsPayload,
  ScenesCart,
  ScenesEvent,
  ScenesOrderOutcome,
  ScenesShow,
  ScenesShowListing,
  ScenesTicket,
} from '@/shared/types';

const MAX_GUESTS = 20;

export interface ScenesShowPickerProps {
  /** A listing from list_event_shows (chat card). */
  listing?: ScenesShowListing;
  /** Or an event to load the bookable listing for. */
  event?: ScenesEvent;
  /** The chat message this picker lives in (chat → picker selections route by it). */
  messageId?: string;
  onClose?: () => void;
  /** Called once place_event_order succeeded (UPI → pending payment session; FREE → booking). */
  onOrderPlaced?: (
    eventId: string,
    eventTitle: string,
    outcome: ScenesOrderOutcome,
    ticketTitle: string,
    guestCount: number,
    /** show time, venue + price facts for the booking card (calendar, directions, split) */
    extra?: BookingTrackerExtras,
  ) => void;
}

const SHOWS_REFRESH_MS = 45_000;

/** "YYYY-MM-DD" → "Fri, 23 Oct" */
function shortDate(key: string): string {
  const [y, m, d] = key.split('-').map(Number);
  if (!y || !m || !d) return key;
  return new Date(Date.UTC(y, m - 1, d, 6)).toLocaleDateString('en-IN', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    timeZone: 'Asia/Kolkata',
  });
}

/** "7 left" · "Selling fast · 3 left" · "Sold out" */
function seatsText(left: number | undefined, onSale: boolean, unit = 'left'): string {
  if (!onSale || left === 0) return 'Sold out';
  if (left === undefined) return 'On sale';
  return left <= SELLING_FAST ? `Selling fast · ${left} ${unit}` : `${left} ${unit}`;
}

const FLASH = 'ring-2 ring-amber-400 ring-offset-1 ring-offset-canvas';

type Step = 'select' | 'review' | 'pay' | 'done';

function formatINR(n: number): string {
  return `₹${Math.round(n).toLocaleString('en-IN')}`;
}

/** "Fri, 23 Oct, 10:00 pm" → { day: "Fri, 23 Oct", time: "10:00 pm" } (display text is Swiggy's). */
function splitIst(ist: string): { day: string; time: string } {
  const i = ist.lastIndexOf(',');
  return i > 0 ? { day: ist.slice(0, i).trim(), time: ist.slice(i + 1).trim() } : { day: '', time: ist };
}

/** Shows grouped by their date group (Swiggy's order kept). */
function groupByDate(shows: ScenesShow[]): { key: string; label: string; shows: ScenesShow[] }[] {
  const groups = new Map<string, { key: string; label: string; shows: ScenesShow[] }>();
  for (const s of shows) {
    const { day } = splitIst(s.showTimeIst);
    const key = s.date || day || 'shows';
    const g = groups.get(key) ?? { key, label: day || s.date || 'Upcoming', shows: [] };
    g.shows.push(s);
    groups.set(key, g);
  }
  return [...groups.values()];
}

// A UPI cart older than this is re-checked with get_event_cart before paying.
const STALE_CART_MS = 3 * 60 * 1000;
// Wall-clock read for event handlers (kept out of render).
const nowMs = () => Date.now();

async function readJson(res: Response): Promise<Record<string, unknown>> {
  try {
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function errorText(data: Record<string, unknown>, res: Response, fallback: string): string {
  if (data.authRequired || res.status === 401) return 'Please log in to Swiggy again to book tickets.';
  return typeof data.message === 'string' && data.message ? data.message : fallback;
}

export function ScenesShowPicker({ listing: initialListing, event, messageId, onClose, onOrderPlaced }: ScenesShowPickerProps) {
  const eventId = initialListing?.eventId || event?.id || '';
  const latitude = initialListing?.latitude ?? event?.latitude;
  const longitude = initialListing?.longitude ?? event?.longitude;
  const needsFetch = !initialListing || !initialListing.venueId;
  // Why a venue-scoped listing can't be loaded at all (derived, not state).
  const loadBlocker = !needsFetch
    ? ''
    : !eventId
      ? 'This event has no id, so it cannot be booked here.'
      : typeof latitude !== 'number' || typeof longitude !== 'number'
        ? 'Your location is needed to load show times.'
        : '';

  const [listing, setListing] = useState<ScenesShowListing | null>(needsFetch ? null : initialListing ?? null);
  // Modal mode (onClose given): focus in, Tab trapped, Esc closes, focus returns.
  const modalRef = useRef<HTMLDivElement>(null);
  useDialogA11y(!!onClose, modalRef, onClose);
  const [loading, setLoading] = useState(needsFetch && !loadBlocker);
  const [error, setError] = useState('');
  // the Swiggy tool behind `error` (for "Report a problem"); null = not Swiggy's
  const [failed, setFailed] = useState<{ tool: string; reportId?: string } | null>(null);
  const failWith = (msg: string, tool: string, data: Record<string, unknown>) => {
    setError(msg);
    setFailed({ tool, reportId: typeof data.reportId === 'string' ? data.reportId : undefined });
  };
  const [step, setStep] = useState<Step>('select');
  const [busy, setBusy] = useState(false);

  const [selectedDate, setSelectedDate] = useState('');
  const [selectedShowId, setSelectedShowId] = useState('');
  const [selectedTicketId, setSelectedTicketId] = useState('');
  const [requestedGuests, setGuestCount] = useState(1);
  // A chat pick named a date with several shows: no show until the user taps one
  // (and the ticket they named is applied to that show then).
  const [awaitShow, setAwaitShow] = useState(false);
  const [pendingTicket, setPendingTicket] = useState<string | null>(null);
  const [pickedFlash, setPickedFlash] = useState(false);
  // the model's one-line reasons for the AI picks (WHY: lines), by pick id
  const [pickReasons, setPickReasons] = useState<Record<string, string>>({});

  const [cart, setCart] = useState<ScenesCart | null>(null);
  const cartAtRef = useRef(0); // when create_event_cart returned this cart
  const [methods, setMethods] = useState<{ apps: PaymentMethodItem[]; qr: PaymentMethodItem | null }>({
    apps: [],
    qr: null,
  });
  const [options, setOptions] = useState<PaymentOptionsPayload | null>(null);
  const [doneText, setDoneText] = useState('');
  const [changes, setChanges] = useState<Map<string, Change>>(new Map());
  const [liveNote, setLiveNote] = useState('');
  const [mountedAt] = useState(() => Date.now());
  const rootRef = useRef<HTMLDivElement>(null);
  const listingRef = useRef<ScenesShowListing | null>(listing);
  useEffect(() => {
    listingRef.current = listing;
  }, [listing]);

  /** One live list_event_shows read for the scoped venue; applies it and returns it. */
  const readShows = async (signal?: AbortSignal, fresh = false): Promise<ScenesShowListing | string> => {
    const cur = listingRef.current;
    if (!cur?.venueId || typeof cur.latitude !== 'number' || typeof cur.longitude !== 'number') return 'No venue to refresh';
    const qs = new URLSearchParams({
      eventId: cur.eventId || eventId,
      venueId: cur.venueId,
      lat: String(cur.latitude),
      lng: String(cur.longitude),
      ...(cur.eventTitle ? { title: cur.eventTitle } : {}),
      ...(fresh ? { fresh: '1' } : {}),
    });
    const res = await fetch(`/api/scenes/shows?${qs.toString()}`, { signal });
    const data = await readJson(res);
    if (!res.ok || !data.ok || !data.listing) return errorText(data, res, 'Could not refresh show times');
    const next = data.listing as ScenesShowListing;
    // Keep what the first (details-enriched) load knew when the re-read omits it.
    const merged: ScenesShowListing = {
      ...cur,
      ...next,
      eventTitle: next.eventTitle || cur.eventTitle,
      venueName: next.venueName ?? cur.venueName,
      venueAddress: next.venueAddress ?? cur.venueAddress,
      venueArea: next.venueArea ?? cur.venueArea,
      city: next.city ?? cur.city,
      dateSummary: cur.dateSummary,
      venueLatitude: next.venueLatitude ?? cur.venueLatitude,
      venueLongitude: next.venueLongitude ?? cur.venueLongitude,
    };
    const diff = diffShows(cur.shows, merged.shows);
    listingRef.current = merged;
    setListing(merged);
    setChanges(diff);
    if (diff.size) window.setTimeout(() => setChanges(new Map()), 4000);
    return merged;
  };

  // Load the venue-scoped, bookable listing when we weren't handed one.
  useEffect(() => {
    if (!needsFetch || loadBlocker) return;
    let cancelled = false;
    fetch(
      `/api/scenes/search?eventId=${encodeURIComponent(eventId)}&lat=${latitude}&lng=${longitude}`,
    )
      .then(async (res) => {
        const data = await readJson(res);
        if (cancelled) return;
        if (res.ok && data.ok && data.listing) {
          setListing(data.listing as ScenesShowListing);
        } else {
          failWith(errorText(data, res, 'Could not load show times.'), 'list_event_shows', data);
        }
      })
      .catch(() => {
        if (!cancelled) setError('Could not reach Swiggy. Please try again.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [needsFetch, loadBlocker, eventId, latitude, longitude]);

  const shows = useMemo(() => listing?.shows ?? [], [listing]);
  // 2–3 concrete recommendations ranked from the live listing (soonest / value / selling fast)
  const aiPicks = useMemo(() => (listing ? rankScenesPicks(listing) : []), [listing]);
  // AI read of everything Swiggy returned for this event (seating, age, dates, prices, seats, offer)
  const scenesRead = useMemo(() => (listing ? scenesFacts(listing) : { summary: '', facts: [] }), [listing]);
  const scenesFit = useMemo(() => (listing ? scenesFitLine(listing, currentNeeds()) : ''), [listing]);
  const dateGroups = useMemo(() => groupByDate(shows), [shows]);
  // Default to the first date / show / ticket that is actually on sale.
  const activeGroup =
    dateGroups.find((g) => g.key === selectedDate) ?? dateGroups.find((g) => g.shows.some((s) => s.onSale)) ?? dateGroups[0];
  const groupShows = activeGroup?.shows ?? [];
  const activeShow =
    awaitShow && !selectedShowId
      ? undefined
      : groupShows.find((s) => s.showId === selectedShowId) ?? groupShows.find((s) => s.onSale) ?? groupShows[0];
  const tickets = activeShow?.tickets ?? [];
  const activeTicket =
    tickets.find((t) => t.ticketId === selectedTicketId && t.onSale) ?? tickets.find((t) => t.onSale);
  const soldOut = !activeShow?.onSale || !activeTicket;
  // Bounds: the show's allowedCovers, the tier's and show's seats left, and the 20 cap.
  const minGuests = Math.max(1, activeShow?.minGuests ?? 1);
  const maxGuests = Math.max(
    minGuests,
    Math.min(
      MAX_GUESTS,
      activeShow?.maxGuests ?? MAX_GUESTS,
      activeTicket?.availableInventory ?? MAX_GUESTS,
      activeShow?.availableSeats ?? MAX_GUESTS,
    ),
  );
  // Clamp to the selection (derived, so switching shows never over-books).
  const guestCount = Math.min(Math.max(requestedGuests, minGuests), maxGuests);
  const estimate = activeTicket?.price !== undefined ? activeTicket.price * guestCount : undefined;
  // (createCart shadows these with an explicit selection when it has one)
  const activeShowNow = activeShow;
  const activeTicketNow = activeTicket;
  const guestCountNow = guestCount;
  const eventTitle = listing?.eventTitle || event?.title || 'Event';
  const venueName = listing?.venueName || event?.venueName;
  const where = [listing?.venueArea || event?.area, listing?.city || event?.city].filter(Boolean).join(', ');
  const venueLine = [venueName, where].filter(Boolean).join(' · ');
  const meta = [
    listing?.duration,
    listing?.ageGroup,
    listing?.languages?.map((l) => l.charAt(0).toUpperCase() + l.slice(1)).join(', '),
    listing?.seating,
    listing?.recurring
      ? `Recurring${listing.runUntilUnix ? ` · till ${new Date(listing.runUntilUnix * 1000).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short' })}` : ''}`
      : undefined,
    listing?.category,
    listing?.venueDistanceKm !== undefined ? `${listing.venueDistanceKm} km away` : undefined,
    listing?.startPrice !== undefined && listing.startPrice > 0 ? `From ${formatINR(listing.startPrice)}` : undefined,
  ].filter(Boolean) as string[];
  // eventInfo text Swiggy filled (artists / organiser / about / things to remember / terms).
  const eventAbout = [
    listing?.artists?.length ? `Artists: ${listing.artists.join(', ')}` : '',
    listing?.organizer ? `By ${listing.organizer}` : '',
    listing?.tour ? `Part of ${listing.tour}` : '',
    listing?.description ?? '',
    ...(listing?.thingsToRemember ?? []).map((t) => `• ${t}`),
    listing?.eventTnc ? `Terms: ${listing.eventTnc}` : '',
  ].filter(Boolean);

  const poll = useLivePoll(
    async (signal) => {
      const r = await readShows(signal);
      if (typeof r === 'string') return r;
      // The picked show / tier sold out under us → say so (selection re-defaults).
      const show = r.shows.find((x) => x.showId === activeShow?.showId);
      const tier = show?.tickets.find((t) => t.ticketId === activeTicket?.ticketId);
      if (activeShow && (!show?.onSale || (activeTicket && !tier?.onSale))) {
        setLiveNote('The show or ticket you picked just sold out — showing what is still available.');
      }
    },
    {
      intervalMs: SHOWS_REFRESH_MS,
      minIntervalMs: 10_000,
      enabled: step === 'select' && !loading && !!listing?.venueId,
      ref: rootRef,
      initialUpdated: mountedAt,
    },
  );
  const seatsByDate = new Map((listing?.dates ?? []).map((d) => [d.date, d]));
  const extraDates = (listing?.dates ?? []).filter((d) => !dateGroups.some((g) => g.key === d.date));
  const directions = directionsUrl({
    lat: listing?.venueLatitude ?? event?.venueLatitude,
    lng: listing?.venueLongitude ?? event?.venueLongitude,
    name: venueName,
    address: listing?.venueAddress || event?.venueAddress || where,
  });

  const resetToSelect = () => {
    setStep('select');
    setCart(null);
    setOptions(null);
    setMethods({ apps: [], qr: null });
    setError('');
    setFailed(null);
  };

  // Step 2: create_event_cart with the exact selection.
  // `o` = an explicit selection (AI pick / chat "book it") applied this same tick.
  const createCart = async (o?: { show: ScenesShow; ticket: ScenesTicket; guests: number }) => {
    const listing = listingRef.current;
    const activeShow = o?.show ?? activeShowNow;
    const activeTicket = o?.ticket ?? activeTicketNow;
    const guestCount = o?.guests ?? guestCountNow;
    if (!listing?.venueId || !activeShow || !activeTicket) return;
    if (typeof listing.latitude !== 'number' || typeof listing.longitude !== 'number') {
      setError('Your location is needed to book tickets.');
      return;
    }
    setBusy(true);
    setError('');
    setFailed(null);
    setLiveNote('');
    try {
      // Re-validate seats with a fresh read right before creating the cart.
      const fresh = await readShows(undefined, true).catch(() => 'skip');
      if (typeof fresh !== 'string') {
        const show = fresh.shows.find((x) => x.showId === activeShow.showId);
        const tier = show?.tickets.find((t) => t.ticketId === activeTicket.ticketId);
        const left = Math.min(tier?.availableInventory ?? Infinity, show?.availableSeats ?? Infinity);
        if (!show?.onSale || !tier?.onSale) {
          setError('That ticket just sold out. Please pick another show or ticket type.');
          return;
        }
        if (left < guestCount) {
          setError(`Only ${left} left for this ticket now — lower the count or pick another show.`);
          return;
        }
      }
      const res = await fetch('/api/scenes/cart', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          venueId: listing.venueId,
          showId: activeShow.showId,
          ticketId: activeTicket.ticketId,
          showTime: activeShow.showTimeUnix,
          guestCount,
          latitude: listing.latitude,
          longitude: listing.longitude,
        }),
      });
      const data = await readJson(res);
      if (res.ok && data.ok && data.cart) {
        setCart(data.cart as ScenesCart);
        cartAtRef.current = nowMs();
        setStep('review');
      } else {
        failWith(errorText(data, res, 'Swiggy could not create a cart for this show.'), 'create_event_cart', data);
      }
    } catch {
      setError('Could not reach Swiggy. Please try again.');
    } finally {
      setBusy(false);
    }
  };

  // Chat → picker: apply a selection to THIS picker's live listing.
  const applyPick = (sel: PickerSelectFields) => {
    const cur = listingRef.current;
    if (!cur || step === 'done' || busy) return;
    if (step !== 'select') resetToSelect();
    const r = resolveScenesPick(cur, sel, {
      date: activeGroup?.key,
      showId: selectedShowId || undefined,
      defaultShowId: activeShow?.showId,
    });
    const dateChanged = !!r.date && r.date !== activeGroup?.key;
    if (r.date) setSelectedDate(r.date);
    if (r.showId) {
      setSelectedShowId(r.showId);
      setAwaitShow(false);
    } else if (r.awaitShow) {
      setSelectedShowId('');
      setAwaitShow(true);
    } else if (dateChanged) setSelectedShowId('');
    if (r.ticketId) setSelectedTicketId(r.ticketId);
    else if (dateChanged || (r.showId && r.showId !== activeShow?.showId)) setSelectedTicketId('');
    setPendingTicket(r.pendingTicket ?? null);
    if (r.qty !== undefined) setGuestCount(r.qty);
    setLiveNote(r.notes.join(' '));
    setPickedFlash(true);
    window.setTimeout(() => setPickedFlash(false), 2200);
    revealPick(rootRef.current);
    // "Book it": everything resolved → straight to Review (create_event_cart =
    // a cart + Swiggy's summary only; the user still taps Confirm to book).
    // (Plan run active: select only — create_event_cart waits for the user's Review tap)
    if (sel.confirm && r.showId && r.ticketId && !r.awaitShow && !autoCartHeld()) {
      const show = cur.shows.find((x) => x.showId === r.showId);
      const ticket = show?.tickets.find((t) => t.ticketId === r.ticketId);
      if (show?.onSale && ticket?.onSale) {
        const min = Math.max(1, show.minGuests ?? 1);
        const max = Math.max(
          min,
          Math.min(MAX_GUESTS, show.maxGuests ?? MAX_GUESTS, ticket.availableInventory ?? MAX_GUESTS, show.availableSeats ?? MAX_GUESTS),
        );
        const guests = Math.min(Math.max(r.qty ?? requestedGuests, min), max);
        void createCart({ show, ticket, guests });
      }
    }
  };
  const snapshot = (): ActivePicker | null =>
    messageId && listingRef.current && step !== 'done'
      ? buildScenesActivePicker(messageId, listingRef.current, {
          date: activeGroup?.key,
          showId: activeShow?.showId,
          ticketId: activeTicket?.ticketId,
          qty: activeShow ? guestCount : undefined,
        })
      : null;
  // one-tap "Best show" from the event cards → the top AI pick (selected only;
  // the user still taps Review → Confirm)
  const best = () => (step === 'done' || busy ? null : oneTapPick('scenes', aiPicks));
  const bridgeRef = useRef({ applyPick, snapshot, best });
  useEffect(() => {
    bridgeRef.current = { applyPick, snapshot, best };
  });
  const hasListing = !!listing;
  useEffect(() => {
    if (!messageId || !hasListing) return;
    return registerPicker(messageId, {
      kind: 'scenes',
      snapshot: () => bridgeRef.current.snapshot(),
      apply: (sel) => bridgeRef.current.applyPick(sel),
      best: () => bridgeRef.current.best(),
      reasons: (list) => setPickReasons(Object.fromEntries(list.map((x) => [x.id, x.why]))),
    });
  }, [messageId, hasListing]);

  // Shared: place_event_order and hand the outcome up.
  const placeOrder = async (body: Record<string, unknown>) => {
    setBusy(true);
    setError('');
    setFailed(null);
    try {
      const res = await fetch('/api/scenes/order', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await readJson(res);
      const outcome = data.outcome as ScenesOrderOutcome | undefined;
      if (res.ok && data.ok && outcome) {
        const withOptions: ScenesOrderOutcome =
          outcome.kind === 'upi' ? { ...outcome, options: options ?? undefined } : outcome;
        onOrderPlaced?.(eventId, eventTitle, withOptions, activeTicket?.title || 'Ticket', guestCount, {
          startsAt: activeShow ? activeShow.showTimeUnix * 1000 : undefined,
          endsAt: activeShow?.endTimeUnix ? activeShow.endTimeUnix * 1000 : undefined,
          place: venueName,
          address: listing?.venueAddress || where || undefined,
          lat: listing?.venueLatitude,
          lng: listing?.venueLongitude,
          guests: guestCount,
          unitPrice: activeTicket?.price,
          amount: cart?.checkoutMode === 'UPI' ? cart.billToPay : undefined,
        });
        setDoneText(
          outcome.kind === 'upi'
            ? 'Complete the UPI payment in the payment sheet — your tickets are booked once Swiggy confirms the payment.'
            : outcome.booking.status.toUpperCase() === 'PROCESSING'
              ? 'Swiggy is still confirming this free booking.'
              : `Booking status: ${outcome.booking.status || 'placed'}.`,
        );
        setStep('done');
      } else {
        failWith(errorText(data, res, 'Swiggy could not place this booking.'), 'place_event_order', data);
      }
    } catch {
      setError("We couldn't confirm whether this booking went through. Please check your Swiggy app before trying again.");
    } finally {
      setBusy(false);
    }
  };

  // Step 3: explicit confirmation of Swiggy's cart summary.
  const confirmCart = async () => {
    if (!cart) return;
    if (cart.checkoutMode === 'FREE') {
      await placeOrder({ cartKey: cart.cartKey, paymentMethod: 'FREE', selection: cart.selection });
      return;
    }
    // UPI → live payment methods for this cart (Scenes: UPI apps + scan-QR, never Cash).
    setBusy(true);
    setError('');
    setFailed(null);
    try {
      // A cart that sat on the review step may have lapsed: re-check it with
      // get_event_cart first (read-only; Swiggy says pay only when paymentAvailable).
      if (nowMs() - cartAtRef.current > STALE_CART_MS) {
        const sel = cart.selection;
        const chk = await fetch(
          `/api/scenes/cart?cartKey=${encodeURIComponent(cart.cartKey)}&latitude=${sel.latitude}&longitude=${sel.longitude}`,
        );
        const cd = await readJson(chk);
        if (chk.ok && cd.ok && cd.paymentAvailable === false) {
          resetToSelect();
          setError('This cart has expired on Swiggy — pick the show and tickets again to get a fresh cart.');
          return;
        }
        cartAtRef.current = nowMs();
      }
      const res = await fetch(`/api/payments/options?service=scenes&cartKey=${encodeURIComponent(cart.cartKey)}`);
      const data = await readJson(res);
      const opts = (data.options ?? null) as PaymentOptionsPayload | null;
      const usable = (m: PaymentMethodItem) => m.enabled !== false && m.paymentMethod === 'UPI';
      const apps = (opts?.platforms?.mobile?.methods ?? []).filter((m) => usable(m) && !m.isQr && m.kind !== 'qr');
      const qr = (opts?.platforms?.desktop?.methods ?? []).find((m) => usable(m)) ?? null;
      if (!res.ok || !data.ok || !opts || (apps.length === 0 && !qr)) {
        setError(
          res.status === 401
            ? 'Please log in to Swiggy again to book tickets.'
            : "This ticket can't be paid for here right now. Please try again later or use the Swiggy app.",
        );
        return;
      }
      setOptions(opts);
      // a UPI app link can't open on a laptop — offer scan-QR there when Swiggy has it
      setMethods({ apps: !isMobileDevice() && qr ? [] : apps, qr });
      setStep('pay');
    } catch {
      setError('Could not load payment options. Please try again.');
    } finally {
      setBusy(false);
    }
  };

  const payWith = (method: { intentApp?: string; qr?: boolean }) => {
    if (!cart) return;
    void placeOrder({
      cartKey: cart.cartKey,
      paymentMethod: 'UPI',
      ...(method.qr ? { generateUPIQR: true } : { intentApp: method.intentApp }),
      amount: cart.billToPay,
      title: `${guestCount}× ${activeTicket?.title || 'Ticket'} · ${eventTitle}`,
    });
  };

  const header = (
    <div className="flex items-start justify-between gap-2 border-b border-hairline pb-4 sm:gap-4">
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 gap-3">
          <ScenesPoster compact title={eventTitle} hint={listing?.tags?.join(' ')} />
          <div className="min-w-0">
            <span className="text-[11px] font-bold uppercase tracking-wider text-purple-600 dark:text-purple-400">
              Swiggy Scenes · Tickets
            </span>
            <h2 className="mt-0.5 font-display text-lg font-bold leading-snug text-ink [overflow-wrap:anywhere]">{eventTitle}</h2>
            {venueLine && <p className="text-xs text-muted [overflow-wrap:anywhere]">📍 {venueLine}</p>}
            {listing?.venueAddress && listing.venueAddress !== venueName && (
              <p className="line-clamp-2 text-[11px] text-muted-soft [overflow-wrap:anywhere]" title={listing.venueAddress}>
                {listing.venueAddress}
              </p>
            )}
          </div>
        </div>
        <div className="min-w-0">
          {(directions || (activeShow && step === 'select')) && (
            <div className="mt-1 flex flex-wrap items-center gap-2">
              {directions && (
                <a
                  href={directions}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[11px] font-semibold text-purple-600 hover:underline dark:text-purple-400"
                >
                  🧭 Directions ↗
                </a>
              )}
              {activeShow && !loading && (
                <CountdownChip
                  startsAt={activeShow.showTimeUnix * 1000}
                  endsAt={activeShow.endTimeUnix ? activeShow.endTimeUnix * 1000 : undefined}
                />
              )}
            </div>
          )}
          {(meta.length > 0 || (listing?.tags?.length ?? 0) > 0) && (
            <div className="mt-1.5 flex flex-wrap gap-1">
              {meta.map((m) => (
                <span key={m} className="rounded-full bg-surface-card px-2 py-0.5 text-[10px] text-body">
                  {m}
                </span>
              ))}
              {listing?.tags?.map((t) => (
                <span key={t} className="rounded-full bg-purple-500/10 px-2 py-0.5 text-[10px] text-purple-700 dark:text-purple-300">
                  {t}
                </span>
              ))}
            </div>
          )}
          {listing?.rewards && (
            <p className="mt-1.5 flex items-center gap-1.5 text-[11px] font-medium text-emerald-700 dark:text-emerald-400">
              {listing.rewardsLogo ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img decoding="async" src={listing.rewardsLogo} alt="" className="h-4 w-4 rounded-sm" loading="lazy" />
              ) : (
                <span aria-hidden>✦</span>
              )}
              {listing.rewards}
            </p>
          )}
          {eventAbout.length > 0 && (
            <details className="mt-1.5 text-[11px] text-muted">
              <summary className="cursor-pointer font-semibold text-body">About this event</summary>
              <div className="mt-1 space-y-0.5 whitespace-pre-line leading-relaxed">
                {eventAbout.map((line) => (
                  <p key={line}>{line}</p>
                ))}
              </div>
            </details>
          )}
        </div>
      </div>
      {onClose && (
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="rounded-lg p-1.5 text-muted transition-colors hover:bg-surface-card hover:text-ink"
        >
          ✕
        </button>
      )}
    </div>
  );

  const shownError = error || loadBlocker;
  const errorBox = shownError ? (
    <div role="alert" className="rounded-xl border border-coral/30 bg-coral/5 p-3 text-xs text-coral">
      {shownError}
      {failed && shownError === error && (
        <ReportProblemButton
          service="scenes"
          tool={failed.tool}
          errorMessage={error}
          flowDescription={`ticket picker → ${failed.tool}`}
          toolContext={{ eventId, venueId: listing?.venueId, cartKey: cart?.cartKey, guestCount }}
          reportId={failed.reportId}
        />
      )}
    </div>
  ) : null;

  let body: React.ReactNode;
  if (loading) {
    body = (
      <div className="flex items-center justify-center py-6 text-xs text-muted">
        <span className="mr-2 inline-block h-4 w-4 animate-spin rounded-full border-2 border-purple-500 border-t-transparent" />
        Loading show times…
      </div>
    );
  } else if (step === 'done') {
    body = <p className="rounded-xl border border-hairline bg-surface-card/60 p-4 text-xs text-body">{doneText}</p>;
  } else if (step === 'review' && cart) {
    body = (
      <div className="space-y-4">
        <div className="rounded-xl border border-hairline bg-surface-card/60 p-4 text-xs text-body">
          <p className="mb-2 font-semibold text-ink">Review your booking</p>
          {cart.summary ? (
            <p className="whitespace-pre-wrap leading-relaxed">{cart.summary}</p>
          ) : (
            <p className="leading-relaxed">
              {guestCount}× {activeTicket?.title} · {activeShow?.showTimeIst}
            </p>
          )}
          {cart.checkoutMode === 'UPI' && cart.billToPay !== undefined && (
            <p className="mt-3 border-t border-hairline pt-2 font-display text-sm font-bold text-ink">
              To pay: {formatINR(cart.billToPay)}
            </p>
          )}
          {cart.checkoutMode === 'FREE' && (
            <p className="mt-3 border-t border-hairline pt-2 font-semibold text-emerald-700 dark:text-emerald-400">
              Free tickets — no payment needed
            </p>
          )}
        </div>
        {errorBox}
        <div className="flex gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={resetToSelect}
            className="flex-1 rounded-xl border border-hairline py-3 text-xs font-semibold text-body hover:border-purple-500/40 disabled:opacity-50"
          >
            Change
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={confirmCart}
            className="flex-[2] rounded-xl bg-purple-600 py-3 text-xs font-semibold text-white shadow-xs transition-all hover:bg-purple-700 disabled:opacity-50"
          >
            {busy ? 'Working…' : cart.checkoutMode === 'FREE' ? 'Confirm free booking' : 'Confirm & choose payment'}
          </button>
        </div>
      </div>
    );
  } else if (step === 'pay' && cart) {
    body = (
      <div className="space-y-4">
        <p className="text-xs font-semibold uppercase tracking-wider text-muted-soft">Pay with UPI</p>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {methods.apps.map((m) => (
            <button
              key={m.id}
              type="button"
              disabled={busy}
              onClick={() => payWith({ intentApp: m.id })}
              className="flex items-center gap-2 rounded-xl border border-hairline bg-surface-card/50 p-3 text-left text-xs font-semibold text-ink hover:border-purple-500/40 disabled:opacity-50"
            >
              {m.iconUrl && (
                // eslint-disable-next-line @next/next/no-img-element
                <img decoding="async" src={m.iconUrl} alt="" className="h-5 w-5 rounded" loading="lazy" />
              )}
              {m.displayName || m.name || m.id}
            </button>
          ))}
          {methods.qr && (
            <button
              type="button"
              disabled={busy}
              onClick={() => payWith({ qr: true })}
              className="flex items-center gap-2 rounded-xl border border-hairline bg-surface-card/50 p-3 text-left text-xs font-semibold text-ink hover:border-purple-500/40 disabled:opacity-50"
            >
              <span aria-hidden>▦</span>
              {methods.qr.displayName || methods.qr.name || 'Scan UPI QR'}
            </button>
          )}
        </div>
        {errorBox}
        <button
          type="button"
          disabled={busy}
          onClick={resetToSelect}
          className="w-full text-center text-[11px] text-muted hover:text-ink disabled:opacity-50"
        >
          ← Change show or tickets
        </button>
      </div>
    );
  } else if (shows.length === 0) {
    body = (
      <div className="space-y-3">
        {errorBox}
        {!shownError && (
          <div className="rounded-xl border border-dashed border-hairline p-4 text-center text-xs text-muted">
            No upcoming shows are bookable right now.
          </div>
        )}
      </div>
    );
  } else {
    const pick = (cls: boolean) =>
      cls
        ? 'border-2 border-purple-500 bg-purple-500/10 text-ink shadow-xs'
        : 'border border-hairline bg-surface-card/50 text-body hover:border-purple-500/40';
    body = (
      <div className="space-y-5">
        {listing && step === 'select' && (
          <AiReadPanel
            kind="scenes"
            tone="purple"
            cacheKey={`${listing.eventId}|${listing.venueId ?? ''}`}
            summary={scenesRead.summary}
            facts={scenesRead.facts}
            fallbackFit={scenesFit}
          />
        )}
        <AiPicksStrip
          picks={aiPicks}
          reasons={pickReasons}
          tone="purple"
          disabled={busy}
          onBook={(p) => applyPick({ ...p.sel, confirm: true })}
        />
        {(dateGroups.length > 1 || extraDates.length > 0 || seatsByDate.size > 0) && (
          <div>
            <span className="text-xs font-semibold uppercase tracking-wider text-muted-soft">Date</span>
            <div className="mt-2.5 flex gap-2 overflow-x-auto pb-1">
              {dateGroups.map((g) => {
                const sum = seatsByDate.get(g.key);
                const open = g.shows.some((s) => s.onSale) && sum?.onSale !== false;
                const seats =
                  sum?.available ??
                  g.shows.reduce<number | undefined>(
                    (n, s) => (s.availableSeats === undefined ? n : (n ?? 0) + s.availableSeats),
                    undefined,
                  );
                return (
                  <button
                    key={g.key}
                    type="button"
                    onClick={() => {
                      setSelectedDate(g.key);
                      setSelectedShowId('');
                      setSelectedTicketId('');
                      setAwaitShow(false);
                      setPendingTicket(null);
                      setLiveNote('');
                    }}
                    data-picked={activeGroup?.key === g.key ? 'true' : undefined}
                    className={`shrink-0 rounded-xl px-3 py-2 text-left text-xs transition-all ${pick(activeGroup?.key === g.key)} ${open ? '' : 'opacity-60'}`}
                  >
                    <span className="block font-semibold">{g.label}</span>
                    <span
                      className={`block text-[10px] ${open && seats !== undefined && seats <= SELLING_FAST ? 'font-semibold text-coral' : 'text-muted'}`}
                    >
                      {open
                        ? [`${g.shows.length} show${g.shows.length === 1 ? '' : 's'}`, seats !== undefined ? seatsText(seats, true, 'seats') : '']
                            .filter(Boolean)
                            .join(' · ')
                        : 'Sold out'}
                    </span>
                  </button>
                );
              })}
              {extraDates.map((d) => (
                <div
                  key={d.date}
                  className="shrink-0 rounded-xl border border-dashed border-hairline px-3 py-2 text-left text-xs text-muted"
                  title="Swiggy lists seats for this date but no show times yet"
                >
                  <span className="block font-semibold">{shortDate(d.date)}</span>
                  <span className="block text-[10px]">{d.onSale ? seatsText(d.available, true, 'seats') : 'Sold out'}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        <div>
          <span className="text-xs font-semibold uppercase tracking-wider text-muted-soft">
            {dateGroups.length > 1 ? 'Show time' : `Show time${activeGroup?.label ? ` · ${activeGroup.label}` : ''}`}
          </span>
          <div className="mt-2.5 grid grid-cols-2 gap-2 sm:grid-cols-3">
            {groupShows.map((s) => {
              const isSelected = activeShow?.showId === s.showId;
              return (
                <button
                  key={s.showId}
                  type="button"
                  disabled={!s.onSale}
                  onClick={() => {
                    setSelectedShowId(s.showId);
                    setAwaitShow(false);
                    // a ticket named in chat before the show was chosen
                    const named = pendingTicket ? matchTicket(pendingTicket, s.tickets.filter((t) => t.onSale)) : undefined;
                    setSelectedTicketId(named?.ticketId ?? '');
                    setPendingTicket(null);
                    setLiveNote(pendingTicket && !named ? `"${pendingTicket}" isn't offered for this show.` : '');
                  }}
                  className={`rounded-xl p-2.5 text-left transition-all duration-500 disabled:cursor-not-allowed disabled:opacity-50 ${pick(isSelected)} ${changes.has(`show:${s.showId}`) ? FLASH : ''}`}
                >
                  <span className="block text-xs font-semibold">{splitIst(s.showTimeIst).time || s.showTimeIst}</span>
                  <span
                    className={`block text-[10px] ${
                      !s.onSale
                        ? 'text-coral'
                        : s.availableSeats !== undefined && s.availableSeats <= SELLING_FAST
                          ? 'font-semibold text-coral'
                          : 'text-muted'
                    }`}
                  >
                    {seatsText(s.availableSeats, s.onSale, 'seats left')}
                  </span>
                  {(s.durationMin !== undefined || s.gatesOpenUnix !== undefined || s.auditorium) && (
                    <span className="block text-[10px] text-muted-soft">
                      {[
                        s.durationMin !== undefined
                          ? s.durationMin >= 60 && s.durationMin % 30 === 0
                            ? `${s.durationMin / 60} hr`
                            : `${s.durationMin} min`
                          : '',
                        s.gatesOpenUnix !== undefined
                          ? `Gates ${new Date(s.gatesOpenUnix * 1000).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: 'numeric', minute: '2-digit' })}`
                          : '',
                        s.auditorium ?? '',
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </div>

        {tickets.length > 0 ? (
          <div>
            <span className="text-xs font-semibold uppercase tracking-wider text-muted-soft">Ticket type</span>
            <div className="mt-2.5 grid grid-cols-1 gap-2 sm:grid-cols-2">
              {tickets.map((t) => {
                const isSelected = activeTicket?.ticketId === t.ticketId;
                return (
                  <button
                    key={t.ticketId}
                    type="button"
                    disabled={!t.onSale}
                    title={t.tnc}
                    onClick={() => setSelectedTicketId(t.ticketId)}
                    className={`flex flex-col justify-between rounded-xl p-3 text-left transition-all duration-500 disabled:cursor-not-allowed disabled:opacity-50 ${pick(isSelected)} ${
                      changes.has(`ticket:${activeShow?.showId}:${t.ticketId}`) ? FLASH : ''
                    }`}
                  >
                    <span className="block text-xs font-semibold text-ink">{t.title || 'Ticket'}</span>
                    <span className="mt-2 flex items-baseline gap-1.5">
                      {t.price !== undefined && (
                        <span className="font-display text-sm font-bold text-ink">
                          {t.price === 0 ? 'Free' : formatINR(t.price)}
                        </span>
                      )}
                      {t.originalPrice !== undefined && (
                        <span className="text-[11px] text-muted line-through">{formatINR(t.originalPrice)}</span>
                      )}
                    </span>
                    <span
                      className={`mt-0.5 text-[10px] ${
                        !t.onSale || (t.availableInventory !== undefined && t.availableInventory <= SELLING_FAST)
                          ? 'font-semibold text-coral'
                          : 'text-muted'
                      }`}
                    >
                      {!t.onSale
                        ? 'Sold out'
                        : [
                            t.availableInventory !== undefined ? seatsText(t.availableInventory, true) : '',
                            t.coverCharge !== undefined ? `+ ${formatINR(t.coverCharge)} cover` : '',
                          ]
                            .filter(Boolean)
                            .join(' · ') || 'On sale'}
                    </span>
                  </button>
                );
              })}
            </div>
            {activeTicket?.tnc && (
              <p className="mt-2 whitespace-pre-line text-[10px] leading-relaxed text-muted">{activeTicket.tnc}</p>
            )}
          </div>
        ) : (
          <p className="text-xs text-muted">
            {activeShow ? 'Swiggy listed no ticket types for this show.' : 'Pick a show time above to see its ticket types.'}
          </p>
        )}

        <div>
          <span className="text-xs font-semibold uppercase tracking-wider text-muted-soft">Tickets</span>
          <div className="mt-2 flex items-center gap-3">
            <div className="flex items-center rounded-xl border border-hairline bg-surface-card/60 p-1">
              <button
                type="button"
                aria-label="Fewer tickets"
                disabled={guestCount <= minGuests}
                onClick={() => setGuestCount(Math.max(minGuests, guestCount - 1))}
                className="flex h-8 w-8 items-center justify-center rounded-lg text-sm font-bold text-muted hover:bg-canvas hover:text-ink disabled:opacity-30"
              >
                –
              </button>
              <span className="w-8 text-center text-xs font-semibold text-ink">{guestCount}</span>
              <button
                type="button"
                aria-label="More tickets"
                disabled={guestCount >= maxGuests}
                onClick={() => setGuestCount(Math.min(maxGuests, guestCount + 1))}
                className="flex h-8 w-8 items-center justify-center rounded-lg text-sm font-bold text-muted hover:bg-canvas hover:text-ink disabled:opacity-30"
              >
                +
              </button>
            </div>
            <span className="text-xs text-muted">
              {minGuests > 1 ? `${minGuests}–${maxGuests}` : `Up to ${maxGuests}`} per booking
            </span>
          </div>
        </div>

        {activeTicket?.price !== undefined && activeTicket.price > 0 && !soldOut && (
          <BillSplit
            kind="scenes"
            price={activeTicket.price}
            coverCharge={activeTicket.coverCharge}
            tickets={guestCount}
            ticketName={activeTicket.title}
            compact
          />
        )}

        {liveNote && !shownError && (
          <div role="status" className="rounded-xl border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-700 dark:text-amber-300">
            {liveNote}
          </div>
        )}

        {errorBox}

        <button
          type="button"
          data-picker-cta
          disabled={!listing?.venueId || !activeShow || !activeTicket || soldOut || busy}
          onClick={() => void createCart()}
          className="w-full rounded-xl bg-purple-600 py-3 text-xs font-semibold text-white shadow-xs transition-all hover:bg-purple-700 disabled:opacity-50"
        >
          {busy
            ? 'Checking with Swiggy…'
            : !activeShow
              ? 'Pick a show time'
              : soldOut
              ? 'Sold out — pick another show'
              : `Review ${guestCount} × ${activeTicket?.title || 'ticket'}${estimate !== undefined && estimate > 0 ? ` · est. ${formatINR(estimate)}` : ''}`}
        </button>
        <p className="text-center text-[10px] text-muted">Swiggy confirms the final amount on the next step.</p>
      </div>
    );
  }

  const card = (
    <div
      ref={rootRef}
      className={`relative w-full max-w-lg overflow-hidden rounded-2xl border border-hairline bg-canvas p-4 shadow-card sm:p-5 animate-rise transition-shadow duration-500 ${
        pickedFlash ? 'ring-2 ring-purple-500 ring-offset-2 ring-offset-canvas' : ''
      }`}
    >
      {header}
      {listing?.venueId && !loading && step === 'select' && shows.length > 0 && (
        <LiveStamp
          className="mt-2"
          lastUpdated={poll.lastUpdated}
          live={poll.live}
          refreshing={poll.refreshing}
          onRefresh={poll.refresh}
          cadence="every 45 s"
          error={poll.error}
        />
      )}
      <div className="mt-4">{body}</div>
    </div>
  );

  if (!onClose) return card;

  return (
    <div
      ref={modalRef}
      role="dialog"
      aria-modal="true"
      aria-label={`Tickets for ${event?.title ?? initialListing?.eventTitle ?? "this event"}`}
      className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4"
    >
      <button
        type="button"
        aria-label="Dismiss"
        tabIndex={-1}
        onClick={onClose}
        className="absolute inset-0 bg-ink/50 backdrop-blur-xs"
      />
      {card}
    </div>
  );
}

export default ScenesShowPicker;
