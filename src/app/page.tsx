'use client';

// The multi-service Swiggy chat concierge: a two-column editorial layout on the
// cream canvas — conversation on the left, a service-specific tray on the right
// (a slide-over drawer on mobile). The TopNav switches the active service, which
// swaps the agent (via the hook), the inline cards, and this right-column tray.
// Checkout / place-order are gated behind a two-step confirmation modal
// (review -> final confirm) so a real order can never be placed on one click.

import { useEffect, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import { useSwiggyChat } from '@/frontend/hooks/useSwiggyChat';
import { useUsuals } from '@/frontend/hooks/useUsuals';
import { useDialogA11y } from '@/frontend/hooks/useDialogA11y';
// Direct imports (not the components barrel, which drags every component into
// the initial bundle).
import { TopNav } from '@/frontend/components/navigation/TopNav';
import { ChatThread } from '@/frontend/components/chat/ChatThread';
import { Composer } from '@/frontend/components/chat/Composer';
import { MessageQueue } from '@/frontend/components/chat/MessageQueue';
import { CartPanel } from '@/frontend/components/cart/CartPanel';
import { FoodCartPanel } from '@/frontend/components/cart/FoodCartPanel';
import { SwapBar } from '@/frontend/components/cart/SwapBar';
import { ProposalBar } from '@/frontend/components/cart/ProposalBar';
import { CompareBar } from '@/frontend/components/catalog/CompareBar';
import { UsualsBoard } from '@/frontend/components/features/UsualsBoard';
import { PoweredBy } from '@/frontend/components/navigation/PoweredBy';
import type { TonightChoice } from '@/frontend/components/features/UsualsBoard';
import { Toaster } from '@/frontend/components/features/Toaster';
// Rarely-used surfaces load on first use, in their own chunks.
const SharedBasketBanner = dynamic(() => import('@/frontend/components/features/SharedBasketBanner').then((m) => m.SharedBasketBanner));
const PaymentModal = dynamic(() => import('@/frontend/components/features/PaymentModal').then((m) => m.PaymentModal), { ssr: false });
const CreateAddressModal = dynamic(() => import('@/frontend/components/navigation/CreateAddressModal').then((m) => m.CreateAddressModal), { ssr: false });
const DineoutCompareTray = dynamic(() => import('@/frontend/components/features/DineoutCompare').then((m) => m.DineoutCompareTray), { ssr: false });
const HistoryView = dynamic(() => import('@/frontend/components/history/HistoryView').then((m) => m.HistoryView));
const ReorderDialog = dynamic(() => import('@/frontend/components/history/ReorderDialog').then((m) => m.ReorderDialog));
import { reorderToFoodLines } from '@/frontend/components/history/reorder';
import type { HistoryOrder } from '@/backend/history/history-map';
import { SERVICE_META } from '@/shared/types';
import type {
  PaymentOptionsPayload,
  Product,
  Service,
  Variation,
} from '@/shared/types';
import {
  buildShareUrl,
  clearSharedToken,
  copyToClipboard,
  decodeBasket,
  encodeFoodBasket,
  encodeInstamartBasket,
  takeSharedToken,
  type DecodedBasket,
} from '@/frontend/utils/share';
import { isMobileDevice } from '@/frontend/utils/device';
// Proactive per-tab home briefing + the trip origin for booking "leave by" lines
import { useHomeBriefing } from '@/frontend/hooks/useHomeBriefing';
import { EmptyState } from '@/frontend/components/navigation/EmptyState';
import { HomeBriefing } from '@/frontend/components/navigation/HomeBriefing';
import { setOrigin } from '@/frontend/state/origin';
// Plan tab: the live plan panel + its autonomous run
import { usePlanRun } from '@/frontend/hooks/usePlanRun';
const LivePlanPanel = dynamic(() => import('@/frontend/components/features/LivePlanPanel').then((m) => m.LivePlanPanel));
import { ErrorBoundary } from '@/frontend/components/features/ErrorBoundary';
import { onLivePlan } from '@/frontend/plan/livePlanBus';
import { isRunCommand } from '@/frontend/plan/planRun';

type ConfirmKind = 'instamart' | 'food';

// One selectable payment method in the checkout confirm — built ONLY from the
// live get_payment_options response (docs/swiggy-mcp/platform.md §6.2). `opts`
// is exactly what place-order receives: a UPI app sends `intentApp`, scan-QR
// sends `generateUPIQR`, never both; Swiggy Money / Cash send just the group.
type PayChoice = {
  key: string;
  label: string;
  sub?: string;
  iconUrl?: string;
  kind: 'upi-app' | 'upi-qr' | 'wallet' | 'cash';
  opts: { paymentMethod: string; intentApp?: string; generateUPIQR?: boolean };
};


function buildPayChoices(
  o: PaymentOptionsPayload | null,
  mobile: boolean,
): PayChoice[] {
  if (!o) return [];
  const out: PayChoice[] = [];
  const enabled = <T extends { enabled?: boolean }>(m: T) => m.enabled !== false;
  const appMethods = (o.platforms?.mobile?.methods ?? []).filter(enabled);
  const qrMethods = (o.platforms?.desktop?.methods ?? []).filter(enabled);
  // Prefer the device's own group; fall back to the other if it's empty.
  const useApps = mobile ? appMethods.length > 0 : qrMethods.length === 0;
  if (useApps) {
    for (const m of appMethods) {
      out.push({
        key: `app:${m.id}`,
        label: m.displayName || m.name || 'UPI app',
        sub: 'UPI app',
        iconUrl: m.iconUrl,
        kind: 'upi-app',
        opts: { paymentMethod: 'UPI', intentApp: m.intentApp ?? m.id },
      });
    }
  } else if (qrMethods.length > 0) {
    const m = qrMethods[0];
    out.push({
      key: `qr:${m.id}`,
      label: m.displayName || 'Scan UPI QR',
      sub: 'Any UPI app',
      iconUrl: m.iconUrl,
      kind: 'upi-qr',
      opts: { paymentMethod: 'UPI', generateUPIQR: true },
    });
  }
  if (o.swiggyMoney?.available === true) {
    out.push({
      key: 'wallet',
      label: o.swiggyMoney.displayName || 'Swiggy Money',
      sub: 'Wallet',
      kind: 'wallet',
      opts: { paymentMethod: 'SwiggyPay' },
    });
  }
  if (o.cod?.available === true) {
    out.push({
      key: 'cash',
      label: o.cod.displayName || 'Pay on delivery',
      sub: 'Cash',
      kind: 'cash',
      opts: { paymentMethod: 'Cash' },
    });
  }
  return out;
}

function formatINR(n: number): string {
  return `₹${Math.round(n).toLocaleString('en-IN')}`;
}

// Parse Swiggy's pre-formatted grand total (e.g. "₹1,241.00") into a number so
// the tray chip + checkout modal show the REAL bill (incl. fees/GST), not the
// bare item subtotal. Returns null when there's no authoritative bill yet.
function parseAmount(s?: string): number | null {
  if (!s) return null;
  const n = Number(s.replace(/[^0-9.]/g, ''));
  return Number.isFinite(n) ? n : null;
}

export default function Home() {
  const chat = useSwiggyChat();
  const [trayOpen, setTrayOpen] = useState(false);
  // Plan tab: live plan (right tray) + "Run plan for me"
  const plan = usePlanRun(chat);
  const asideRef = useRef<HTMLElement>(null);
  const [planFlash, setPlanFlash] = useState(false);
  const planRef = useRef(plan);
  useEffect(() => {
    planRef.current = plan;
  });
  // ItineraryCard → "Open live plan" / "Run plan for me": focus the panel
  // (desktop: scroll the tray up + flash it; mobile: open the drawer).
  useEffect(
    () =>
      onLivePlan((cmd) => {
        if (cmd === 'run') planRef.current.start();
        if (window.matchMedia('(min-width: 1024px)').matches) {
          asideRef.current?.scrollTo({ top: 0, behavior: 'smooth' });
          setPlanFlash(true);
          window.setTimeout(() => setPlanFlash(false), 1400);
        } else {
          setTrayOpen(true);
        }
      }),
    [],
  );
  // The panel's Confirm → the step's own picker / basket in the chat.
  const revealMessage = (id: string) => {
    setTrayOpen(false);
    window.setTimeout(() => {
      document.getElementById(`msg-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 80);
  };
  // "go ahead" / "do it" typed in the Plan tab → run the plan (not a chat turn)
  const runIfAsked = (text: string): boolean => {
    if (chat.service !== 'plan' || !plan.view || !isRunCommand(text)) return false;
    plan.note(`You said “${text.trim().slice(0, 40)}”`);
    plan.start();
    if (!window.matchMedia('(min-width: 1024px)').matches) setTrayOpen(true);
    return true;
  };
  const [confirm, setConfirm] = useState<ConfirmKind | null>(null);
  // Two-step ("double") confirmation before any real order is placed.
  const [confirmStep, setConfirmStep] = useState<'review' | 'final'>('review');
  const [placing, setPlacing] = useState(false);
  // Food: optional note to the restaurant (place_food_order noteToRestaurant)
  const [foodNote, setFoodNote] = useState('');
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(
    null,
  );
  // A basket handed to us via a `?basket=…` share link, awaiting the user's OK
  // before it replaces the current cart (never loaded silently).
  const [sharedBasket, setSharedBasket] = useState<DecodedBasket | null>(null);
  const [tonight, setTonight] = useState<TonightChoice>(null);
  // History page (all past orders): a page-level view over the chat area. The
  // active service is untouched, so closing it returns to the same tab.
  const [historyOpen, setHistoryOpen] = useState(false);
  const [reorderPick, setReorderPick] = useState<{ order: HistoryOrder; images: Record<string, string> } | null>(null);

  const { service, needsLogin } = chat;

  // Instamart board: load go-to items when logged in on Instamart with an address.
  const usualsEnabled =
    !needsLogin && service === 'instamart' && !!chat.selectedAddressId;
  const usuals = useUsuals(chat.selectedAddressId, usualsEnabled);
  const boardStatus =
    !chat.selectedAddressId && service === 'instamart'
      ? chat.addressesLoaded ? 'empty' : 'loading' // skeleton until addresses settle
      : usuals.status === 'idle'
        ? 'loading'
        : usuals.status;

  // On first load, pick up a shared basket from the URL (decoded + validated),
  // then strip the token from the address bar so a refresh doesn't re-prompt.
  useEffect(() => {
    const token = takeSharedToken();
    if (!token) return;
    const decoded = decodeBasket(token);
    clearSharedToken();
    // One-shot import of an external (URL) value on mount — exactly the
    // "subscribe to an outside system" case where a mount-time setState is right.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (decoded) setSharedBasket(decoded);
  }, []);

  // Copy a share link; if the clipboard is blocked (common on mobile webviews),
  // fall back to the native share sheet so the button never silently fails.
  const shareLink = async (url: string): Promise<boolean> => {
    if (await copyToClipboard(url)) return true;
    try {
      if (typeof navigator !== 'undefined' && navigator.share) {
        await navigator.share({ title: 'My Swiggy basket', url });
        return true;
      }
    } catch {
      /* user dismissed the share sheet / unsupported */
    }
    return false;
  };

  // Build a shareable link to the active service's basket and copy it.
  const shareInstamart = async (): Promise<boolean> => {
    if (!chat.cart.items.length) return false;
    return shareLink(buildShareUrl(encodeInstamartBasket(chat.cart.items)));
  };
  const shareFood = async (): Promise<boolean> => {
    if (!chat.foodCart.items.length) return false;
    return shareLink(
      buildShareUrl(
        encodeFoodBasket(
          chat.foodCart.items,
          chat.foodCart.restaurantId,
          chat.foodCart.restaurantName,
        ),
      ),
    );
  };

  // Pending agent proposals across every message — drives the always-visible
  // "picks ready to add" bar so a late/off-screen Approve card is never missed.
  const pendingProposals = chat.messages.flatMap((m) =>
    (m.proposals ?? [])
      .filter((p) => p.status === 'pending')
      .map((p) => ({ mid: m.id, pid: p.pid })),
  );
  const addAllPending = () => {
    const messageIds = Array.from(new Set(pendingProposals.map((p) => p.mid)));
    messageIds.forEach((mid) => chat.approveAllProposals(mid));
  };
  const dismissAllPending = () => {
    pendingProposals.forEach((p) => chat.dismissProposal(p.mid, p.pid));
  };

  // Accept a shared basket: switch to its service and replace the cart with it.
  const loadSharedBasket = () => {
    if (!sharedBasket) return;
    if (sharedBasket.service === 'instamart') {
      if (service !== 'instamart') chat.setService('instamart');
      chat.setCartItems(sharedBasket.items);
    } else {
      if (service !== 'food') chat.setService('food');
      chat.setFoodItems(
        sharedBasket.items,
        sharedBasket.restaurantId,
        sharedBasket.restaurantName,
      );
    }
    setSharedBasket(null);
    setTrayOpen(true);
  };
  const selectedAddress = chat.addresses.find(
    (a) => a.id === chat.selectedAddressId,
  );
  // Booking cards measure the trip from the selected delivery address.
  useEffect(() => {
    setOrigin(selectedAddress?.latitude, selectedAddress?.longitude);
  }, [selectedAddress?.latitude, selectedAddress?.longitude]);
  // Empty tab → proactive briefing from real orders / bookings (never blocks;
  // static welcome until it loads or if it fails).
  const briefing = useHomeBriefing(
    service,
    chat.selectedAddressId,
    chat.auth.user?.userId ?? undefined,
    !needsLogin && chat.auth.authenticated && chat.messages.length === 0 && !historyOpen,
  );

  // The authoritative Instamart total (real bill incl. fees/GST) when available,
  // else the bare subtotal so the chip/modal never read blank.
  const instamartTotal =
    parseAmount(chat.cart.bill?.total) ?? chat.cart.subtotal;

  // Active-service tray count + amount for the TopNav chip. Dineout / Scenes
  // have no cart — their tray is a prompt panel, so the pill shows no count.
  const trayCount =
    service === 'instamart'
      ? chat.cart.itemCount
      : service === 'food'
        ? chat.foodCart.itemCount
        : 0;
  const trayAmount =
    service === 'instamart'
      ? instamartTotal
      : service === 'food'
        ? chat.foodCart.toPay
        : 0;
  const hasCart = service === 'instamart' || service === 'food';

  // Live payment methods for the confirm dialog (never an invented list).
  const [payState, setPayState] = useState<'loading' | 'ready' | 'unavailable'>('loading');
  const [payChoices, setPayChoices] = useState<PayChoice[]>([]);
  const [payKey, setPayKey] = useState<string | null>(null);
  const payChoice = payChoices.find((c) => c.key === payKey) ?? null;

  // Only the latest request may write (close + reopen must not show stale methods).
  const payReqRef = useRef(0);
  const loadPayChoices = async (kind: ConfirmKind) => {
    const req = ++payReqRef.current;
    setPayState('loading');
    setPayChoices([]);
    setPayKey(null);
    const options = await chat.fetchPaymentOptions(kind);
    if (req !== payReqRef.current) return;
    const choices = buildPayChoices(options, isMobileDevice());
    setPayChoices(choices);
    setPayKey(choices[0]?.key ?? null);
    setPayState(choices.length ? 'ready' : 'unavailable');
  };

  const openConfirm = (kind: ConfirmKind) => {
    setResult(null);
    setConfirmStep('review'); // always start at step 1
    setConfirm(kind);
    void loadPayChoices(kind);
  };

  const closeConfirm = () => {
    if (placing) return;
    setConfirm(null);
    setResult(null);
    setConfirmStep('review');
  };

  const confirmAction = async () => {
    if (!confirm || !payChoice) return;
    setPlacing(true);
    const opts = { ...payChoice.opts, amount: confirmTotal };
    const note = foodNote.trim();
    const res =
      confirm === 'food'
        ? await chat.placeFoodOrder(note ? { ...opts, noteToRestaurant: note.slice(0, 200) } : opts)
        : await chat.checkout(opts);
    if (confirm === 'food' && (res.ok || res.session)) setFoodNote('');

    if (res.session) {
      closeConfirm();
    } else {
      setResult(res);
    }
    setPlacing(false);
  };

  // Switching service should dismiss any open tray/modal so the next service
  // starts clean.
  const onSelectService = (s: typeof service) => {
    setHistoryOpen(false);
    chat.setService(s);
    setTrayOpen(false);
    setConfirm(null);
    setResult(null);
    setConfirmStep('review');
    setTonight(null);
  };

  // History → Reorder (confirmed): load the past order's real lines into the
  // Food cart (replaces it — one restaurant per Swiggy cart), open the Food tab
  // with the cart tray. Never places an order.
  const confirmReorder = () => {
    const pick = reorderPick;
    setReorderPick(null);
    if (!pick?.order.reorder) return;
    const { restaurantId, restaurantName, items } = pick.order.reorder;
    if (service !== 'food') onSelectService('food');
    else setHistoryOpen(false);
    chat.setFoodItems(reorderToFoodLines(items, pick.images), restaurantId, restaurantName);
    setTrayOpen(true);
  };

  const handleTonight = (choice: TonightChoice) => {
    if (choice === 'out') {
      onSelectService('dineout');
      return;
    }
    setTonight(choice);
  };

  // Push selected usuals into the existing cart API path, then open the tray.
  // Never calls checkout / place order.
  const handleReviewShop = (
    picks: { product: Product; variation: Variation }[],
  ) => {
    if (!picks.length) return;
    // addToCart is optimistic + synchronous (the server sync is coalesced), so
    // there's no in-flight state to show — the tray opens with the items in.
    for (const { product, variation } of picks) {
      chat.addToCart(product, variation);
    }
    setTrayOpen(true);
  };

  const handleOpenFoodUsual = (r: {
    id: string;
    name: string;
  }) => {
    chat.setService('food');
    chat.sendMessage(
      `Show me the menu at ${r.name} (restaurantId ${r.id}).`,
      'food',
      undefined,
      undefined,
      `View ${r.name}'s menu`,
    );
  };

  const handleFoodUsualFallback = () => {
    chat.setService('food');
    chat.sendMessage(
      `Look at my recent food orders and show the places I reorder most — don't place an order.`,
      'food',
      undefined,
      undefined,
      'Order the usual',
    );
  };

  // Lock body scroll while a mobile overlay is open.
  useEffect(() => {
    const open = trayOpen || confirm !== null;
    if (open) {
      const prev = document.body.style.overflow;
      document.body.style.overflow = 'hidden';
      return () => {
        document.body.style.overflow = prev;
      };
    }
  }, [trayOpen, confirm]);

  // Confirm-modal figures depend on which tray triggered it. Instamart uses the
  // real bill total (parsed), Food uses toPay (already authoritative).
  const confirmTotal =
    confirm === 'food'
      ? chat.foodCart.toPay || chat.foodCart.itemTotal
      : instamartTotal;
  const confirmCount =
    confirm === 'food' ? chat.foodCart.itemCount : chat.cart.itemCount;

  /* ------------------------------ tray content ---------------------------- */

  const renderTray = () => {
    switch (service) {
      case 'instamart':
        return (
          <CartPanel
            cart={chat.cart}
            busy={chat.cartBusy}
            sending={chat.sending}
            onIncrement={chat.incrementItem}
            onDecrement={chat.decrementItem}
            onRemove={chat.removeItem}
            onClear={chat.clearCart}
            onCheckout={() => openConfirm('instamart')}
            onAnalyze={chat.analyzeCart}
            onAsk={(text, label) => chat.sendMessage(text, 'instamart', undefined, undefined, label)}
            onReplaceLine={chat.replaceCartLine}
            selectedAddressLine={
              selectedAddress ? `${selectedAddress.addressTag} · ${selectedAddress.addressLine}` : undefined
            }
            budget={chat.budget}
            onTrim={chat.trimToFit}
            onShare={shareInstamart}
            onSwap={(line) => {
              setTrayOpen(false);
              chat.selectSwap({
                kind: 'instamart',
                id: line.spinId,
                name: line.name,
                imageUrl: line.imageUrl,
                quantity: line.quantity,
              });
            }}
          />
        );
      case 'food':
        return (
          <FoodCartPanel
            cart={chat.foodCart}
            busy={chat.foodBusy}
            sending={chat.sending}
            onIncrement={chat.incFoodItem}
            onDecrement={chat.decFoodItem}
            onRemove={chat.removeFoodItem}
            onClear={chat.clearFoodCart}
            onPlaceOrder={() => openConfirm('food')}
            onAnalyze={chat.analyzeCart}
            onApplyCoupon={chat.applyBestCoupon}
            onListCoupons={chat.listFoodCoupons}
            onSetCutlery={chat.setFoodCutlery}
            budget={chat.budget}
            onTrim={chat.trimToFit}
            onShare={shareFood}
            parkedCarts={chat.parkedFoodCarts}
            onSwitchCart={chat.switchFoodCart}
            onDiscardCart={chat.discardParkedCart}
            kcalGoal={chat.kcalGoal}
            proteinGoal={chat.proteinGoal}
            kcal={chat.foodMacros.kcal}
            protein={chat.foodMacros.protein}
            onSwap={(line) => {
              setTrayOpen(false);
              chat.selectSwap({
                kind: 'food',
                id: line.menuItemId,
                name: line.name,
                imageUrl: line.imageUrl,
                quantity: line.quantity,
                restaurantId: chat.foodCart.restaurantId ?? undefined,
                restaurantName: chat.foodCart.restaurantName ?? undefined,
              });
            }}
          />
        );
      case 'dineout':
        return (
          <div className="flex h-full flex-col justify-between p-6 bg-canvas overflow-y-auto">
            <div className="space-y-6">
              <div>
                <div className="flex items-center gap-2">
                  <span className="flex h-8 w-8 items-center justify-center rounded-xl bg-coral/10 text-base">
                    🥂
                  </span>
                  <div>
                    <h3 className="font-display text-lg font-bold text-ink">Dineout Concierge</h3>
                    <p className="text-xs text-muted">Table reservations & dining deals</p>
                  </div>
                </div>
              </div>

              {/* Quick Prompts */}
              <div className="rounded-2xl border border-hairline bg-surface-card/60 p-4 space-y-3">
                <span className="text-xs font-semibold text-ink block">Explore Dining</span>
                <div className="flex flex-col gap-2">
                  {[
                    { label: '🌟 Top Rated Fine Dining', query: 'Find top rated fine dining restaurants near me' },
                    { label: '🍕 Weekend Buffet Offers', query: 'Show restaurants with buffet deals and discounts' },
                    { label: '🌿 Romantic Outdoor Seating', query: 'Recommend romantic restaurants with rooftop or outdoor tables' },
                    { label: '🍻 Microbreweries & Pubs', query: 'Find popular microbreweries near me' },
                  ].map((p, i) => (
                    <button
                      key={i}
                      type="button"
                      onClick={() => chat.sendMessage(p.query, 'dineout', undefined, undefined, p.label)}
                      className="rounded-xl border border-hairline bg-canvas px-3.5 py-2.5 text-left text-xs text-body hover:border-coral/50 hover:text-ink transition-all"
                    >
                      {p.label}
                    </button>
                  ))}
                </div>
              </div>

              {/* How it works — factual flow only; offers/prices come live from Swiggy */}
              <div className="rounded-2xl border border-coral/20 bg-coral/5 p-4">
                <div className="flex items-center gap-2 text-coral font-semibold text-xs mb-1">
                  <span aria-hidden="true">📅</span>
                  <span>How booking works</span>
                </div>
                <p className="text-xs text-body leading-relaxed">
                  Pick a restaurant, choose a slot and party size, then confirm. Any deals
                  or prices you see are the ones Swiggy Dineout returns for that slot.
                </p>
              </div>
            </div>

            <div className="flex justify-center border-t border-hairline pt-4">
              <PoweredBy service="dineout" compact />
            </div>
          </div>
        );
      case 'scenes':
        return (
          <div className="flex h-full flex-col justify-between p-6 bg-canvas overflow-y-auto">
            <div className="space-y-6">
              <div>
                <div className="flex items-center gap-2">
                  <span className="flex h-8 w-8 items-center justify-center rounded-xl bg-coral/10 text-base">
                    🎟️
                  </span>
                  <div>
                    <h3 className="font-display text-lg font-bold text-ink">Scenes Box Office</h3>
                    <p className="text-xs text-muted">Live gigs, standup comedy & screenings</p>
                  </div>
                </div>
              </div>

              {/* Quick Prompts */}
              <div className="rounded-2xl border border-hairline bg-surface-card/60 p-4 space-y-3">
                <span className="text-xs font-semibold text-ink block">Discover Experiences</span>
                <div className="flex flex-col gap-2">
                  {[
                    { label: '🎤 Standup Comedy Gigs', query: 'Show upcoming standup comedy shows and gigs' },
                    { label: '🎸 Live Concerts & Music', query: 'Find live music events and concerts happening this week' },
                    { label: '🎭 Theatre & Plays', query: 'Discover theatre plays and drama performances' },
                    { label: '🎬 Exclusive Screenings', query: 'Find movie screenings and indie film events' },
                  ].map((p, i) => (
                    <button
                      key={i}
                      type="button"
                      onClick={() => chat.sendMessage(p.query, 'scenes', undefined, undefined, p.label)}
                      className="rounded-xl border border-hairline bg-canvas px-3.5 py-2.5 text-left text-xs text-body hover:border-coral/50 hover:text-ink transition-all"
                    >
                      {p.label}
                    </button>
                  ))}
                </div>
              </div>

              {/* Ticketing Info */}
              <div className="rounded-2xl border border-purple-500/20 bg-purple-500/5 p-4">
                <div className="flex items-center gap-2 text-purple-600 dark:text-purple-400 font-semibold text-xs mb-1">
                  <span>🎟️</span>
                  <span>How booking works</span>
                </div>
                <p className="text-xs text-body leading-relaxed">
                  Pick a show and tickets, review Swiggy&apos;s cart summary, then pay by UPI (free shows skip payment). Your booking appears in your Swiggy app.
                </p>
              </div>
            </div>

            <div className="flex justify-center border-t border-hairline pt-4">
              <PoweredBy service="scenes" compact />
            </div>
          </div>
        );
      case 'plan':
        // A plan in this thread → the live plan panel tracks it step by step.
        if (plan.view) {
          return (
            <LivePlanPanel
              plan={plan}
              onReveal={revealMessage}
              onOpenCart={(svc) => onSelectService(svc)}
              highlight={planFlash}
            />
          );
        }
        // Plan has no cart of its own: Add / Reserve / See shows on its cards
        // go to the owning service's cart or confirm flow — summarised here.
        return (
          <div className="flex h-full flex-col justify-between p-6 bg-canvas overflow-y-auto">
            <div className="space-y-6">
              <div className="flex items-center gap-2">
                <span className="flex h-8 w-8 items-center justify-center rounded-xl bg-emerald-500/10 text-base">
                  🗺️
                </span>
                <div>
                  <h3 className="font-display text-lg font-bold text-ink">Outing Planner</h3>
                  <p className="text-xs text-muted">A show, a table, dinner home & snacks — one plan</p>
                </div>
              </div>

              <div className="rounded-2xl border border-hairline bg-surface-card/60 p-4 space-y-3">
                <span className="text-xs font-semibold text-ink block">Start a plan</span>
                <div className="flex flex-col gap-2">
                  {[
                    {
                      label: '👨‍👩‍👧‍👦 Family day at the mall',
                      query:
                        'Plan a family outing for 2 adults and 2 kids this Saturday from 4 PM: some time at a mall near me, then a show, dinner out, and snacks for the ride home. Budget about ₹5000, veg-friendly.',
                    },
                    {
                      label: '💕 Date night tonight',
                      query: 'Plan a date night for two tonight from 7 PM — a live show and a nice dinner nearby, under ₹3000.',
                    },
                    {
                      label: '🎤 Comedy + dinner with friends',
                      query: 'Plan a night out for 4 friends this Friday: a standup comedy show, then dinner at a lively place. About ₹1500 each.',
                    },
                    {
                      label: '🍿 Movie night in',
                      query: 'Plan a movie night at home for 3 this evening: dinner delivered and snacks & drinks from Instamart, around ₹1200.',
                    },
                  ].map((p) => (
                    <button
                      key={p.label}
                      type="button"
                      onClick={() => chat.sendMessage(p.query, 'plan', undefined, undefined, p.label)}
                      className="rounded-xl border border-hairline bg-canvas px-3.5 py-2.5 text-left text-xs text-body hover:border-emerald-500/50 hover:text-ink transition-all"
                    >
                      {p.label}
                    </button>
                  ))}
                </div>
              </div>

              {/* The planner reads; each service's own tab/cart does the buying. */}
              <div className="rounded-2xl border border-hairline bg-surface-card/60 p-4 space-y-2.5">
                <span className="text-xs font-semibold text-ink block">Your Swiggy carts</span>
                {(
                  [
                    { svc: 'instamart' as const, label: '⚡ Instamart', count: chat.cart.itemCount, amount: instamartTotal },
                    { svc: 'food' as const, label: '🍽️ Food', count: chat.foodCart.itemCount, amount: chat.foodCart.toPay },
                  ]
                ).map((c) => (
                  <button
                    key={c.svc}
                    type="button"
                    onClick={() => onSelectService(c.svc)}
                    className="flex w-full items-center justify-between rounded-xl border border-hairline bg-canvas px-3.5 py-2.5 text-left text-xs text-body hover:border-coral/50 hover:text-ink transition-all"
                  >
                    <span>{c.label}</span>
                    <span className="text-muted">
                      {c.count > 0
                        ? `${c.count} item${c.count === 1 ? '' : 's'}${c.amount > 0 ? ` · ₹${Math.round(c.amount)}` : ''} → checkout`
                        : 'empty'}
                    </span>
                  </button>
                ))}
              </div>

              <div className="rounded-2xl border border-emerald-500/20 bg-emerald-500/5 p-4">
                <div className="flex items-center gap-2 text-emerald-700 dark:text-emerald-400 font-semibold text-xs mb-1">
                  <span aria-hidden="true">🛡️</span>
                  <span>You stay in control</span>
                </div>
                <p className="text-xs text-body leading-relaxed">
                  The planner only searches. Tables, tickets, food and snacks are booked or ordered
                  in each service&apos;s own confirm flow — nothing is booked or paid until you confirm it there.
                </p>
              </div>
            </div>

            <div className="flex justify-center border-t border-hairline pt-4">
              <PoweredBy service="plan" compact />
            </div>
          </div>
        );
      default:
        return null;
    }
  };

  const trayPanelRef = useRef<HTMLDivElement>(null);
  const confirmPanelRef = useRef<HTMLDivElement>(null);
  const switchPanelRef = useRef<HTMLDivElement>(null);
  useDialogA11y(trayOpen, trayPanelRef, () => setTrayOpen(false));
  // No Escape-close while an order is being placed.
  useDialogA11y(confirm !== null, confirmPanelRef, placing ? undefined : closeConfirm);
  useDialogA11y(!!chat.pendingFoodSwitch, switchPanelRef, chat.cancelFoodSwitch);

  const trayTitle =
    service === 'dineout'
      ? 'Dineout'
      : service === 'scenes'
        ? 'Scenes'
        : service === 'plan'
          ? 'Plan'
          : 'Your cart';

  if (needsLogin) {
    return (
      <div className="flex h-dvh flex-col items-center justify-center bg-canvas px-6">
        <div className="max-w-md text-center">
          <div className="mx-auto mb-6 flex h-20 w-20 items-center justify-center rounded-full bg-coral/10 text-coral">
            <svg className="h-10 w-10" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
            </svg>
          </div>
          <h2 className="font-display text-3xl text-ink">Welcome to Swiggy Chat</h2>
          <p className="mt-3 text-body leading-relaxed">
            Log in with your Swiggy phone number to order groceries and food, book tables and find live events — all from one AI concierge. Your session lasts about 5 days and refreshes automatically.
          </p>
          <p className="mt-2 text-sm text-muted">Instamart · Food · Dineout · Scenes</p>
          <a
            href="/api/auth/login"
            className="mt-8 inline-flex items-center gap-2 rounded-xl bg-coral px-8 py-3.5 text-[15px] font-semibold text-on-primary shadow-lifted transition-all hover:-translate-y-0.5 hover:bg-coral-active hover:shadow-card"
          >
            Login with Swiggy
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M14 5l7 7m0 0l-7 7m7-7H3" />
            </svg>
          </a>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-dvh flex-col bg-canvas">
      <TopNav
        service={service}
        onSelectService={onSelectService}
        historyOpen={historyOpen}
        onToggleHistory={() => {
          setTrayOpen(false);
          setHistoryOpen((v) => !v);
        }}
        addresses={chat.addresses}
        selectedAddressId={chat.selectedAddressId}
        onSelectAddress={chat.selectAddress}
        onAddNewAddress={() => chat.setCreateAddressModalOpen(true)}
        onAddressDeleted={chat.removeDeletedAddress}
        authenticated={chat.auth.authenticated}
        user={chat.auth.user}
        authLoading={chat.auth.loading}
        onLogin={chat.login}
        onLogout={chat.logout}
        cartCount={trayCount}
        cartAmount={trayAmount}
        trayLabel={hasCart ? 'Cart' : 'Explore'}
        onToggleTray={() => setTrayOpen((v) => !v)}
        history={chat.history}
        activeSessionId={chat.sessionId}
        onOpenSession={chat.openSession}
        onNewChat={chat.newChat}
        onDeleteSession={chat.removeSession}
        recipes={chat.recipes}
        onSaveRecipe={chat.saveRecipe}
        onCookRecipe={chat.cookRecipe}
        onDeleteRecipe={chat.removeRecipe}
        preferences={chat.preferences}
        onChangePreferences={chat.setPreferences}
        allergies={chat.allergies}
        onChangeAllergies={chat.setAllergies}
        budget={chat.budget}
        onChangeBudget={chat.setBudget}
        kcalGoal={chat.kcalGoal}
        proteinGoal={chat.proteinGoal}
        onChangeMacroGoals={chat.setMacroGoals}
        // Tools-menu prompts go to the service whose section they live in (the
        // menu passes it) — Food / Dineout / Scenes items must NOT be forced
        // onto the Instamart agent.
        onPickTheme={(t, label, svc: Service) =>
          chat.sendMessage(t, svc, undefined, undefined, label)
        }
        sending={chat.sending}
        // Nutrition entry points (TopNav → Tools → Nutrition). Running macros
        // exist only for the Food cart today; other services show none rather
        // than the Food cart's numbers.
        nutritionKcal={service === 'food' ? chat.foodMacros.kcal : 0}
        nutritionProtein={service === 'food' ? chat.foodMacros.protein : 0}
        onAnalyzeNutrition={chat.nutritionReport}
        onAllergenSweep={chat.allergenSweep}
        onHealthierPicks={chat.analyzeCart}
        // Cook + one-tap reorder entry points (Tools → Recipe Book).
        onCookWithMe={chat.cookWithMe}
        onReorderRecipe={chat.reorderRecipe}
        onFindDeals={chat.findDeals}
        onSmartBasket={chat.smartBasket}
      />

      <div className="mx-auto flex w-full max-w-[1480px] flex-1 overflow-hidden">
        {/* Conversation column */}
        {historyOpen && (
          <main className="relative flex min-w-0 flex-1 flex-col">
            <ErrorBoundary name="history" className="m-4">
            <HistoryView
              userId={chat.auth.user?.userId ?? undefined}
              addressId={chat.selectedAddressId}
              lat={selectedAddress?.latitude}
              lng={selectedAddress?.longitude}
              backLabel={SERVICE_META[service].label}
              onClose={() => setHistoryOpen(false)}
              onLogin={chat.login}
              onReorder={(order, images) => setReorderPick({ order, images })}
              onOpenInstamart={() => onSelectService('instamart')}
            />
            </ErrorBoundary>
          </main>
        )}
        <main
          className={`relative min-w-0 flex-1 flex-col border-hairline lg:border-r ${historyOpen ? 'hidden' : 'flex'}`}
        >
          {sharedBasket && (
            <SharedBasketBanner
              basket={sharedBasket}
              onLoad={loadSharedBasket}
              onDismiss={() => setSharedBasket(null)}
            />
          )}
          <ChatThread
            messages={chat.messages}
            sending={chat.sending}
            inCartQty={chat.inCartQty}
            onAdd={chat.addToCart}
            onLoadMore={chat.loadMore}
            isLoadingMore={chat.isLoadingMore}
            openMenu={chat.openMenu}
            onLoadMoreMenu={chat.loadMoreMenu}
            isLoadingMoreMenu={chat.isLoadingMoreMenu}
            onLoadMoreDishes={chat.loadMoreDishes}
            isLoadingMoreDishes={chat.isLoadingMoreDishes}
            addFoodItem={chat.addFoodItem}
            inFoodCartQty={chat.inFoodCartQty}
            onPick={(text, displayText) => {
              if (runIfAsked(displayText || text)) return;
              chat.sendMessage(text, undefined, undefined, undefined, displayText);
            }}
            suggestions={chat.suggestions}
            service={chat.service}
            emptyBoard={
              service === 'instamart' ? (
                <>
                {/* the usuals board carries its own briefing once it has items — no duplicate */}
                {briefing?.briefing.hasData && usuals.items.length === 0 && (
                  <HomeBriefing
                    data={briefing}
                    variant="strip"
                    onPick={(text, displayText) =>
                      chat.sendMessage(text, undefined, undefined, undefined, displayText)
                    }
                  />
                )}
                <UsualsBoard
                  status={boardStatus}
                  items={usuals.items}
                  label={usuals.label}
                  foodUsual={usuals.foodUsual}
                  tonight={tonight}
                  onTonight={handleTonight}
                  onReviewShop={handleReviewShop}
                  onOpenFoodRestaurant={handleOpenFoodUsual}
                  onFoodFallback={handleFoodUsualFallback}
                  briefing={usuals.briefing}
                  onRefill={chat.refillUsuals}
                />
                </>
              ) : (
                <EmptyState
                  service={service}
                  suggestions={chat.suggestions}
                  briefing={briefing}
                  onPick={(text, displayText) =>
                    chat.sendMessage(text, undefined, undefined, undefined, displayText)
                  }
                />
              )
            }
            isSelected={chat.isSelectedForCompare}
            onToggleCompare={chat.toggleCompare}
            onToggleCompareFood={chat.toggleCompareFood}
            onAddCompareWinner={chat.addCompareWinner}
            onApproveProposal={chat.approveProposal}
            onDismissProposal={chat.dismissProposal}
            onApproveAll={chat.approveAllProposals}
            onRegenerate={chat.regenerate}
            onViewDineoutSlots={chat.openDineoutSlots}
            onBookDineoutSlot={chat.bookDineoutSlot}
            onViewScenesShows={chat.openScenesShows}
            onBookScenesShow={chat.bookScenesShow}
            onBasketAction={(id, a) => {
              chat.basketAction(id, a);
              if (a.type === 'approve') setTrayOpen(true);
            }}
            // "This belongs to another tab" → open that tab on a fresh thread with the ask.
            onHandoff={(svc, query, label) => {
              setTrayOpen(false);
              setConfirm(null);
              setTonight(null);
              chat.sendMessage(query, svc, undefined, undefined, label);
            }}
          />
          <CompareBar
            items={chat.compareItems}
            onCompare={chat.compareBest}
            onClear={chat.clearCompare}
            busy={chat.sending}
          />
          <SwapBar
            item={chat.swapItem}
            onSwap={chat.requestSwap}
            onClear={chat.clearSwap}
            busy={chat.sending}
          />
          <ProposalBar
            count={pendingProposals.length}
            onAddAll={addAllPending}
            onDismissAll={dismissAllPending}
          />
          <MessageQueue items={chat.queue} onCancel={chat.cancelQueued} />
          <Composer
            onSend={(text, image) => {
              if (!image && runIfAsked(text)) return;
              chat.sendMessage(text, undefined, image);
            }}
            disabled={chat.sending}
            onStop={chat.stop}
            suggestions={
              (service === 'instamart' && chat.messages.length === 0) ||
              // the latest reply already shows these as inline chips
              chat.messages[chat.messages.length - 1]?.chips?.length
                ? []
                : chat.suggestions
            }
            placeholder={
              service === 'instamart' && chat.messages.length === 0
                ? 'Add a note — coriander, or anything missing…'
                : chat.placeholder
            }
            lastReply={
              [...chat.messages]
                .reverse()
                .find((m) => m.role === 'assistant' && !m.pending)?.text
            }
          />
        </main>

        {/* Tray column — desktop */}
        <aside ref={asideRef} className={`hidden w-[420px] shrink-0 overflow-y-auto ${historyOpen ? '' : 'lg:block'}`}>
          <ErrorBoundary name="tray" resetKeys={[service]} className="m-4">
            {renderTray()}
          </ErrorBoundary>
        </aside>
      </div>

      {/* Tray drawer — mobile */}
      {trayOpen && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <button
            type="button"
            aria-label="Close tray"
            tabIndex={-1}
            onClick={() => setTrayOpen(false)}
            className="absolute inset-0 bg-black/40 backdrop-blur-[1px]"
          />
          <div
            ref={trayPanelRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="tray-title"
            className="absolute right-0 top-0 flex h-full w-[88%] max-w-[380px] animate-rise flex-col overflow-hidden bg-canvas pb-[env(safe-area-inset-bottom)] shadow-card"
          >
            <div className="flex shrink-0 items-center justify-between border-b border-hairline px-4 py-3">
              <h2 id="tray-title" className="font-display text-lg text-ink">{trayTitle}</h2>
              <button
                type="button"
                onClick={() => setTrayOpen(false)}
                aria-label="Close"
                className="tap inline-flex h-8 w-8 items-center justify-center rounded-full text-muted hover:bg-surface-card"
              >
                <svg
                  viewBox="0 0 24 24"
                  className="h-5 w-5"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <path d="M18 6 6 18M6 6l12 12" />
                </svg>
              </button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto">
              <ErrorBoundary name="tray-mobile" resetKeys={[service]} className="m-4">
                {renderTray()}
              </ErrorBoundary>
            </div>
          </div>
        </div>
      )}

      {/* Checkout / place-order confirmation modal */}
      {confirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <button
            type="button"
            aria-label="Dismiss"
            tabIndex={-1}
            onClick={closeConfirm}
            className="absolute inset-0 bg-black/40 backdrop-blur-[2px]"
          />
          <div
            ref={confirmPanelRef}
            role={result ? 'alertdialog' : 'dialog'}
            aria-modal="true"
            aria-labelledby="confirm-title"
            aria-describedby={result ? 'confirm-result' : undefined}
            className="relative max-h-[calc(100dvh-2rem)] w-full max-w-md animate-rise overflow-y-auto rounded-xl border border-hairline bg-canvas p-6 shadow-card"
          >
            {!result ? (
              <>
                {/* Step progress — makes the double confirmation explicit */}
                <div className="mb-3 flex items-center gap-2">
                  <span
                    className={`h-1.5 flex-1 rounded-full ${
                      confirmStep === 'review' ? 'bg-coral' : 'bg-coral/40'
                    }`}
                  />
                  <span
                    className={`h-1.5 flex-1 rounded-full ${
                      confirmStep === 'final' ? 'bg-coral' : 'bg-hairline'
                    }`}
                  />
                </div>
                <p className="text-xs font-medium uppercase tracking-[0.12em] text-muted-soft">
                  Step {confirmStep === 'review' ? '1' : '2'} of 2
                </p>

                {confirmStep === 'review' ? (
                  <>
                    <h2 id="confirm-title" className="mt-1 font-display text-2xl text-ink">
                      Review your order
                    </h2>
                    <p className="mt-1.5 text-sm text-muted">
                      {confirm === 'food'
                        ? 'Check the details below. You can confirm on the next step.'
                        : 'Check the details below. You can confirm on the next step.'}
                    </p>

                    <dl className="mt-5 space-y-3 rounded-lg bg-surface-card/60 p-4 text-sm">
                      <div className="flex items-start justify-between gap-4">
                        <dt className="text-muted">Delivering to</dt>
                        <dd className="max-w-[60%] text-right text-body">
                          {selectedAddress
                            ? `${selectedAddress.addressTag} · ${selectedAddress.addressLine}`
                            : 'Selected address'}
                        </dd>
                      </div>
                      <div className="flex items-center justify-between gap-4">
                        <dt className="text-muted">Items ({confirmCount})</dt>
                        <dd className="font-display text-xl text-ink">
                          {formatINR(confirmTotal)}
                        </dd>
                      </div>
                      {confirm === 'food' && (
                        <div className="border-t border-hairline pt-2">
                          <dt className="mb-1.5 block font-medium text-muted">
                            <label htmlFor="food-note">Note to the restaurant</label>
                          </dt>
                          <dd>
                            <input
                              id="food-note"
                              type="text"
                              value={foodNote}
                              maxLength={200}
                              onChange={(e) => setFoodNote(e.target.value)}
                              placeholder="e.g. less spicy, no onions (optional)"
                              className="w-full rounded-lg border border-hairline bg-canvas px-3 py-2 text-sm text-ink placeholder:text-muted-soft focus:border-coral focus:outline-none"
                            />
                          </dd>
                        </div>
                      )}
                      <div className="pt-2 border-t border-hairline">
                        <dt id="pay-option-label" className="text-muted block mb-2 font-medium">Payment Option</dt>
                        <dd>
                          {payState === 'loading' ? (
                            <p className="text-xs text-muted" role="status">
                              Loading payment options from Swiggy…
                            </p>
                          ) : payState === 'unavailable' ? (
                            <div role="alert" className="flex items-center justify-between gap-3 rounded-lg border border-hairline bg-canvas px-3 py-2.5">
                              <span className="text-xs text-body">
                                Payment options unavailable right now.
                              </span>
                              <button
                                type="button"
                                onClick={() => confirm && void loadPayChoices(confirm)}
                                className="shrink-0 text-xs font-medium text-coral hover:text-coral-active"
                              >
                                Retry
                              </button>
                            </div>
                          ) : (
                            <div
                              role="radiogroup"
                              aria-labelledby="pay-option-label"
                              className="grid grid-cols-2 gap-2 sm:grid-cols-3"
                            >
                              {payChoices.map((c) => {
                                const on = c.key === payKey;
                                return (
                                  <button
                                    key={c.key}
                                    type="button"
                                    role="radio"
                                    aria-checked={on}
                                    onClick={() => setPayKey(c.key)}
                                    className={`flex min-w-0 flex-col items-center justify-center rounded-xl border p-2.5 text-center transition-all ${
                                      on
                                        ? 'border-coral bg-coral/10 font-semibold text-coral shadow-xs'
                                        : 'border-hairline bg-surface-card/40 text-muted hover:border-cream-strong hover:text-ink'
                                    }`}
                                  >
                                    {c.iconUrl ? (
                                      // eslint-disable-next-line @next/next/no-img-element
                                      <img decoding="async" src={c.iconUrl} alt="" className="mb-1 h-5 w-5 object-contain" />
                                    ) : (
                                      <span className="mb-1 text-base" aria-hidden="true">
                                        {c.kind === 'wallet' ? '💳' : c.kind === 'cash' ? '💵' : c.kind === 'upi-qr' ? '▦' : '⚡'}
                                      </span>
                                    )}
                                    <span className="w-full truncate text-xs">{c.label}</span>
                                    {c.sub && (
                                      <span className="text-[10px] opacity-75">{c.sub}</span>
                                    )}
                                  </button>
                                );
                              })}
                            </div>
                          )}
                        </dd>
                      </div>
                    </dl>

                    <div className="mt-6 flex items-center justify-end gap-3">
                      <button
                        type="button"
                        onClick={closeConfirm}
                        className="rounded-md px-4 py-2.5 text-sm text-muted transition-colors hover:text-ink"
                      >
                        Cancel
                      </button>
                      <button
                        type="button"
                        onClick={() => setConfirmStep('final')}
                        disabled={confirmCount === 0 || !payChoice}
                        className="rounded-md bg-ink px-5 py-2.5 text-sm font-medium text-canvas transition-colors hover:bg-dark-elevated disabled:cursor-not-allowed disabled:opacity-40"
                      >
                        Continue →
                      </button>
                    </div>
                  </>
                ) : (
                  <>
                    <div className="mt-3 flex items-start gap-3 rounded-lg border border-coral/30 bg-coral/5 p-4">
                      <span className="mt-0.5 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-coral/15 text-coral">
                        <svg
                          viewBox="0 0 24 24"
                          className="h-4 w-4"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          aria-hidden="true"
                        >
                          <path d="M12 9v4m0 4h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" />
                        </svg>
                      </span>
                      <div>
                        <h2 id="confirm-title" className="font-display text-xl leading-tight text-ink">
                          Confirm — this places a real order
                        </h2>
                        <p className="mt-1.5 text-sm leading-relaxed text-body">
                          You&apos;re about to place a{' '}
                          <span className="font-medium text-ink">real</span>{' '}
                          {confirm === 'food' ? 'Swiggy Food' : 'Instamart'} order
                          for{' '}
                          <span className="font-medium text-ink">
                            {formatINR(confirmTotal)}
                          </span>{' '}
                          to{' '}
                          <span className="font-medium text-ink">
                            {selectedAddress?.addressTag ?? 'your address'}
                          </span>
                          {payChoice?.kind === 'upi-app'
                            ? ` via UPI (${payChoice.label}).`
                            : payChoice?.kind === 'upi-qr'
                              ? ' via UPI (scan a QR code).'
                              : payChoice?.kind === 'wallet'
                                ? ` with ${payChoice.label}.`
                                : ' — pay on delivery.'}{' '}
                          This can&apos;t be undone here.
                        </p>
                      </div>
                    </div>

                    <div className="mt-6 flex items-center justify-between gap-3">
                      <button
                        type="button"
                        onClick={() => setConfirmStep('review')}
                        disabled={placing}
                        className="rounded-md px-4 py-2.5 text-sm text-muted transition-colors hover:text-ink disabled:opacity-50"
                      >
                        ← Back
                      </button>
                      <button
                        type="button"
                        onClick={confirmAction}
                        disabled={placing || confirmCount === 0 || !payChoice}
                        className="rounded-md bg-coral px-5 py-2.5 text-sm font-medium text-on-primary transition-colors hover:bg-coral-active disabled:cursor-not-allowed disabled:bg-coral-disabled disabled:text-muted-soft"
                      >
                        {placing
                          ? 'Processing…'
                          : payChoice?.kind === 'upi-app' || payChoice?.kind === 'upi-qr'
                            ? 'Proceed to UPI Payment →'
                            : payChoice?.kind === 'wallet'
                              ? `Pay with ${payChoice.label}`
                              : 'Place Pay-on-Delivery Order'}
                      </button>
                    </div>
                  </>
                )}
              </>
            ) : (
              <div className="text-center">
                <div
                  className={`mx-auto flex h-12 w-12 items-center justify-center rounded-full ${
                    result.ok
                      ? 'bg-coral/10 text-coral'
                      : 'bg-surface-card text-muted'
                  }`}
                >
                  {result.ok ? (
                    <svg
                      viewBox="0 0 24 24"
                      className="h-6 w-6"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      aria-hidden="true"
                    >
                      <path d="M20 6 9 17l-5-5" />
                    </svg>
                  ) : (
                    <svg
                      viewBox="0 0 24 24"
                      className="h-6 w-6"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      aria-hidden="true"
                    >
                      <path d="M12 9v4m0 4h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" />
                    </svg>
                  )}
                </div>
                <h2 id="confirm-title" className="sr-only">
                  {result.ok ? 'Order update' : 'Order not placed'}
                </h2>
                <p id="confirm-result" className="mt-4 text-[15px] text-body">{result.message}</p>
                <button
                  type="button"
                  onClick={() => {
                    setConfirm(null);
                    setResult(null);
                    setConfirmStep('review');
                  }}
                  className="mt-6 rounded-md bg-ink px-5 py-2.5 text-sm font-medium text-canvas transition-colors hover:bg-dark-elevated"
                >
                  Done
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Single-restaurant switch confirm — adding from a different restaurant
          would replace the current order, so confirm before wiping it. */}
      {chat.pendingFoodSwitch && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <button
            type="button"
            aria-label="Cancel"
            tabIndex={-1}
            onClick={chat.cancelFoodSwitch}
            className="absolute inset-0 bg-black/40 backdrop-blur-[2px]"
          />
          <div
            ref={switchPanelRef}
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="switch-title"
            aria-describedby="switch-desc"
            className="relative w-full max-w-sm animate-rise rounded-xl border border-hairline bg-canvas p-6 shadow-card"
          >
            <h2 id="switch-title" className="font-display text-xl leading-tight text-ink">
              Start a new order?
            </h2>
            <p id="switch-desc" className="mt-2 text-sm leading-relaxed text-body">
              Your order has items from{' '}
              <span className="font-medium text-ink">
                {chat.pendingFoodSwitch.fromName}
              </span>
              . A food order can only be from one restaurant, so adding from{' '}
              <span className="font-medium text-ink">
                {chat.pendingFoodSwitch.toName}
              </span>{' '}
              will clear your current items.
            </p>
            <div className="mt-6 flex items-center justify-end gap-3">
              <button
                type="button"
                onClick={chat.cancelFoodSwitch}
                className="rounded-md px-4 py-2.5 text-sm text-muted transition-colors hover:text-ink"
              >
                Keep current order
              </button>
              <button
                type="button"
                onClick={chat.confirmFoodSwitch}
                className="rounded-md bg-coral px-5 py-2.5 text-sm font-medium text-on-primary transition-colors hover:bg-coral-active"
              >
                Start fresh
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Live status toasts (orders / bookings changing while polled) */}
      <Toaster />

      {/* Dineout side-by-side compare tray (cards' "Compare" toggle) */}
      {(service === 'dineout' || service === 'plan') && (
        <ErrorBoundary name="dineout-compare" silent>
          <DineoutCompareTray />
        </ErrorBoundary>
      )}

      {/* Universal In-Chat Payment Modal */}
      <ErrorBoundary name="payment" resetKeys={[chat.paymentSession]}>
        <PaymentModal
          session={chat.paymentSession}
          options={chat.paymentOptions}
          onClose={chat.closePayment}
          onSuccess={chat.onPaymentSuccess}
          onRetry={chat.retryPayment}
        />
      </ErrorBoundary>

      {/* Add New Address Modal */}
      <ErrorBoundary name="create-address" resetKeys={[chat.createAddressModalOpen]}>
        <CreateAddressModal
          isOpen={chat.createAddressModalOpen}
          onClose={() => chat.setCreateAddressModalOpen(false)}
          onAddressCreated={chat.addCreatedAddress}
        />
      </ErrorBoundary>

      {/* History → Reorder confirmation */}
      {reorderPick && (
        <ErrorBoundary name="reorder" resetKeys={[reorderPick]}>
        <ReorderDialog
          order={reorderPick.order}
          images={reorderPick.images}
          currentCart={{ restaurantName: chat.foodCart.restaurantName, itemCount: chat.foodCart.itemCount }}
          onConfirm={confirmReorder}
          onCancel={() => setReorderPick(null)}
        />
        </ErrorBoundary>
      )}
    </div>
  );
}
