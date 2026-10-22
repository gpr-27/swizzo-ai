'use client';

// The single integration hook for the multi-service Swiggy chat UI. It owns ALL
// chat, cart and address state across the services (Instamart / Food) and is the
// only module that talks to the backend (/api/addresses, /api/chat, /api/cart,
// /api/food-cart, /api/checkout, /api/orders, /api/dishes, /api/search).
//
// ★ ZERO PERCEIVED LAG is the law here: every cart mutation updates local state
// SYNCHRONOUSLY, then a debounced + coalesced `set` sync replays the whole
// desired cart to the server in the background and reconciles the authoritative
// money. cartBusy/foodBusy are subtle "syncing" hints, never blockers.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  type Address,
  type AddressResolution,
  type BillBreakdown,
  type CartLine,
  type CartProposal,
  type CartState,
  type ChatCatalog,
  type ChatMessage,
  type ChatSessionMeta,
  type ChatStreamEvent,
  type ActivePicker,
  type CompareItem,
  type Coupon,
  type BookingTrackerExtras,
  type DineoutBooking,
  type DineoutRestaurant,
  type DineoutSlotChoice,
  type DineoutSlotsView,
  type FoodCart,
  type FoodCartLine,
  type FoodCartSelection,
  type FoodPlaceResult,
  type FoodRestaurant,
  type MenuCategory,
  type MenuItem,
  type PaymentOptionsPayload,
  type PaymentSession,
  type Product,
  type Role,
  type ScenesEvent,
  type ScenesOrderOutcome,
  type Service,
  type SwapItem,
  type Variation,
  type InstamartBasket,
  SERVICES,
  emptyCart,
  emptyFoodCart,
} from '@/shared/types';
import { markDineoutNoSlots } from '@/frontend/state/dineoutAvailability';
import { approvedLines, rankProducts } from '@/shared/instamart-packs';
import type { SwiggyUser } from '@/frontend/components/navigation/AccountMenu';

import {
  loadSessionList,
  loadSession,
  upsertSession,
  deleteSession,
} from '@/frontend/state/history';
import {
  loadRecipes,
  saveRecipe as saveRecipeStore,
  updateRecipeByDish,
  deleteRecipe,
} from '@/frontend/state/recipes';
import type { Recipe } from '@/frontend/state/recipes';
import type { PickerSelectFields } from '@/shared/types';
import { setFoodAddressId } from '@/frontend/state/foodAddress';
import { registerFoodActions, setFoodContext } from '@/frontend/state/foodActions';
import { loadBookings, saveBooking, type BookingKind, type SavedBooking } from '@/frontend/state/bookings';
import { readLocalPreferences } from '@/frontend/state/cloudSync';
import { noteLocalChange, type SyncedChange } from '@/frontend/state/syncBus';
import { useCloudSync } from '@/frontend/hooks/useCloudSync';
import { getDishIngredients } from '@/shared/recipeData';
import { buildDineoutActivePicker, pickFromUserText, quickRead } from '@/shared/picker';
import { onPickerReady, pickerSnapshot, requestPickerOpen, sendBestPick, sendPlanPick, sendReasons, sendToPicker, type PlanPickResolver } from '@/frontend/utils/pickerBridge';
import { noteUserAsk } from '@/frontend/state/userNeeds';
import { useCertainlyLoggedOut } from '@/frontend/state/authHint';

// How many prior turns to send to the agent for conversational context.
const HISTORY_TURNS = 10;

// Did the user EXPLICITLY tell us to change the cart this turn ("add milk",
// "order 2 eggs", "remove the tofu", "put bread in my cart", "approve all")?
// If so the agent's ADD/REMOVE applies directly; otherwise it's proposed for the user's approval.
// Deliberately strict: a question ("what should I order?") or a negation ("don't
// place an order") is NEVER a command, and the verb must lead the sentence or
// the text must name the cart — otherwise the agent's changes are proposed.
function isExplicitCartCommand(text: string): boolean {
  const t = text.trim();
  if (!t || /\?\s*$/.test(t)) return false;
  if (/\b(?:don'?t|do\s+not|never|without)\b[^.?!]*\b(?:add|order|buy|place|remove)\b/i.test(t)) {
    return false;
  }
  return (
    /^(?:please\s+|pls\s+|now\s+|ok(?:ay)?,?\s+)?(?:add|order|buy|purchase|reorder|remove|delete|drop|take\s+out|approve|get\s+me|put)\b/i.test(t) ||
    /\b(?:to|in|into|from|out\s+of)\s+(?:my\s+|the\s+)?(?:cart|basket)\b/i.test(t) ||
    /\b(?:add|order|approve)\s+all(?:\s+the)?(?:\s+required)?\s+(?:items|ingredients)\b/i.test(t)
  );
}
// Debounce window for the coalesced cart `set` sync.
const SYNC_DEBOUNCE_MS = 250;

/**
 * Parse an /api/cart response into Swiggy's CartState. 200 = the new cart;
 * 422 = Swiggy rejected the change and the body is what it holds now + its
 * error in `warnings`. A 502 on GET carries an empty cart + the read error
 * (`allowReadError`); on a write it means Swiggy's state is unknown, so we
 * keep the optimistic cart. 401 / network → null.
 */
async function readServerCart(res: Response, allowReadError = false): Promise<CartState | null> {
  if (!res.ok && res.status !== 422 && !(allowReadError && res.status === 502)) return null;
  const data = (await res.json().catch(() => null)) as CartState | null;
  return data && Array.isArray(data.items) ? data : null;
}

/** Swiggy's cart lines lack brand (and sometimes images): keep ours by spinId. */
function withLineMeta(server: CartState, prev: CartState): CartState {
  if (!server.items.length || !prev.items.length) return server;
  const bySpin = new Map(prev.items.map((l) => [l.spinId, l]));
  return {
    ...server,
    items: server.items.map((l) => {
      const p = bySpin.get(l.spinId);
      return p
        ? {
            ...l,
            brand: l.brand || p.brand,
            name: l.name || p.name,
            imageUrl: l.imageUrl || p.imageUrl,
            skuId: l.skuId || p.skuId,
            maxQuantity: l.maxQuantity ?? p.maxQuantity,
            maxQuantityMessage: l.maxQuantityMessage || p.maxQuantityMessage,
          }
        : l;
    }),
  };
}
// localStorage key for the persisted id -> macros map (survives reload).
const MACROS_KEY = 'swiggy-macros-v1';

/** A unique session id (browser crypto, with a safe fallback). */
function makeSessionId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `s-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  }
}

/** Parse a pre-formatted rupee string ("₹241" / "₹1,204.50") to a number. */
function parseRupees(s?: string): number {
  if (!s) return 0;
  const n = Number(String(s).replace(/[^0-9.]/g, ''));
  return Number.isFinite(n) ? n : 0;
}

/** Merge card lists by id (later entries refine earlier ones, order preserved). */
function mergeById<T extends { id: string }>(prev: T[] | undefined, next: T[]): T[] {
  if (!prev?.length) return next;
  const byId = new Map(prev.map((x) => [x.id, x] as const));
  for (const x of next) byId.set(x.id, { ...(byId.get(x.id) ?? {}), ...x } as T);
  return [...byId.values()];
}

/** Recompute the derived grocery-cart totals from items (optimistic, instant). */
function recomputeCart(
  addressId: string,
  items: CartLine[],
  bill: BillBreakdown | undefined,
): CartState {
  const itemCount = items.reduce((s, i) => s + i.quantity, 0);
  const subtotal = items.reduce((s, i) => s + i.unitPrice * i.quantity, 0);
  const savings = items.reduce(
    (s, i) => s + Math.max(0, i.mrp - i.unitPrice) * i.quantity,
    0,
  );
  // Drop the (now-stale) fee breakdown when the cart empties; otherwise keep the
  // last authoritative bill until the background sync reconciles a fresh one.
  return {
    addressId,
    items,
    itemCount,
    subtotal,
    savings,
    bill: items.length ? bill : undefined,
  };
}

/** Recompute the derived food-cart totals (optimistic). Fees/toPay are estimated
 *  from the last-known authoritative values and reconciled on the next sync. */
function recomputeFoodCart(
  prev: FoodCart,
  items: FoodCartLine[],
  restaurantId: string | null,
  restaurantName: string | null,
): FoodCart {
  if (items.length === 0) return emptyFoodCart();
  const itemCount = items.reduce((s, i) => s + i.quantity, 0);
  const itemTotal = items.reduce((s, i) => s + i.price * i.quantity, 0);
  const coupon = prev.appliedCoupon ?? null;
  const toPay = Math.max(
    0,
    itemTotal + prev.taxes + prev.deliveryCharge - (coupon?.savings ?? 0),
  );
  return {
    restaurantId,
    restaurantName,
    items,
    itemCount,
    itemTotal,
    taxes: prev.taxes,
    deliveryCharge: prev.deliveryCharge,
    toPay,
    appliedCoupon: coupon,
    bestCoupon: prev.bestCoupon ?? null,
  };
}

// Default venue coordinates (Bengaluru) used for search.
const DEFAULT_LAT = 12.9716;
const DEFAULT_LNG = 77.5946;

const DEFAULT_NETWORK_ERROR =
  "### 🌐 Network Connection Failure\n\n" +
  "**Exact Reason**: Unable to communicate with the local server endpoint `/api/chat`.\n\n" +
  "**Recommended Action**:\n" +
  "1. Verify that your Next.js local server is active on `http://localhost:3000`.\n" +
  "2. If the request timed out, upstream AI model routes on the free/shared tier may be experiencing temporary traffic latency.\n\n" +
  "> 📢 **Provider Status Note**:\n" +
  "> *As this app connects to free/shared provider endpoints, momentary edge connection resets can happen on the provider's side and are not an issue with your app code.*";

// Per-service starter chips, shown until the agent emits context-aware ones.
const DEFAULT_SUGGESTIONS: Record<Service, string[]> = {
  instamart: ['Milk & eggs', 'Snacks for tonight', 'Fresh fruit', 'My usuals'],
  food: ['Pizza near me', 'Biryani', 'Healthy bowls', 'Desserts'],
  dineout: ['Rooftop restaurants', 'Buffet deals', 'Romantic dining', 'Pubs & breweries'],
  scenes: ['Standup comedy gigs', 'Live music & concerts', 'Theatre plays', 'Screenings'],
  plan: [
    'Family day out this Saturday',
    'Date night tonight under ₹3000',
    'Comedy show + dinner with friends',
    'Movie, dinner & snacks home',
  ],
};

const PLACEHOLDERS: Record<Service, string> = {
  instamart: 'Ask for anything — “paneer & fresh coriander”…',
  food: 'Craving something? — “butter chicken near me”…',
  dineout: 'Reserve a table — “fine dining in Indiranagar”…',
  scenes: 'Find gigs & events — “standup comedy this weekend”…',
  plan: 'Plan an outing — “family of 4, Saturday evening, mall + show + dinner”…',
};

// A cook run in progress, so we can persist the resolved ingredients/steps to
// the matching recipe when the turn settles (deterministic one-tap reorder).
interface CookContext {
  dish: string;
  assistantId: string;
  mode: 'cook' | 'steps';
  ingredients: { spinId: string; line: Omit<CartLine, 'quantity'>; quantity: number }[];
  // parallel ingredient-search batches still running — they own persistence
  inFlight?: number;
}

export interface UseSwiggyChat {
  // service switcher
  service: Service;
  setService: (s: Service) => void;
  // local (browser) chat history
  history: ChatSessionMeta[];
  sessionId: string; // active session id — for HistoryMenu active-row highlight
  newChat: () => void;
  openSession: (id: string) => void;
  removeSession: (id: string) => void;
  // recipe book
  recipes: Recipe[];
  saveRecipe: (dish: string) => void;
  cookRecipe: (dish: string) => void;
  cookWithMe: (dish: string) => void; // step-by-step timed guide for a dish
  reorderRecipe: (recipe: Recipe) => void; // rebuild cart from saved spinIds
  removeRecipe: (id: string) => void;
  // preferences (requirement matching) + cart analysis
  preferences: string;
  setPreferences: (p: string) => void;
  analyzeCart: () => void;
  allergenSweep: () => void; // agent + deterministic allergen pass over the cart
  nutritionReport: () => void; // macro/health read of cart vs goals
  // allergen guardian + budget + macro goals
  allergies: string;
  setAllergies: (a: string) => void;
  budget: number;
  setBudget: (n: number) => void;
  trimToFit: () => void;
  kcalGoal: number;
  proteinGoal: number;
  setMacroGoals: (kcal: number, protein: number) => void;
  foodMacros: { kcal: number; protein: number };
  // conversation
  messages: ChatMessage[];
  sending: boolean;
  // addresses
  addresses: Address[];
  selectedAddressId: string;
  selectAddress: (id: string) => void;
  // instamart cart
  cart: CartState;
  cartBusy: boolean;
  addToCart: (product: Product, variation: Variation) => void;
  incrementItem: (spinId: string) => void;
  decrementItem: (spinId: string) => void;
  removeItem: (spinId: string) => void;
  clearCart: () => void;
  inCartQty: (spinId: string) => number;
  loadMore: (messageId: string, groupIndex: number) => void;
  isLoadingMore: (messageId: string, groupIndex: number) => boolean;
  checkout: (opts?: {
    paymentMethod?: string;
    intentApp?: string;
    generateUPIQR?: boolean;
    amount?: number;
  }) => Promise<{ ok: boolean; gated: boolean; message: string; session?: PaymentSession }>;
  // dynamic, service-aware quick suggestions + input placeholder
  suggestions: string[];
  placeholder: string;
  // compare ("choose best of both")
  compareItems: CompareItem[];
  toggleCompare: (product: Product, variation: Variation) => void;
  toggleCompareFood: (item: MenuItem) => void;
  isSelectedForCompare: (spinId: string) => boolean;
  clearCompare: () => void;
  compareBest: (question?: string) => void;
  addCompareWinner: (item: CompareItem) => void; // "Add winner" on Compare card
  // swap ("change this cart item to X") — select a line, say what you'd prefer,
  // and the agent's match replaces it (old line removed, new one added).
  swapItem: SwapItem | null;
  selectSwap: (item: SwapItem) => void;
  clearSwap: () => void;
  requestSwap: (text: string) => void;
  // food cart
  foodCart: FoodCart;
  foodBusy: boolean;
  // `selection`: variant / add-on choices for a customised dish
  addFoodItem: (item: MenuItem, selection?: FoodCartSelection) => void;
  // MULTI-CART: other restaurants' carts, parked locally. Switch into one to make
  // it active (and sync it to Swiggy); place each restaurant's order separately.
  parkedFoodCarts: FoodCart[];
  switchFoodCart: (restaurantId: string) => void;
  discardParkedCart: (restaurantId: string) => void;
  // restaurant-switch confirm: a dish from another restaurant waits here until
  // the user agrees to park the current cart (Swiggy holds one restaurant)
  pendingFoodSwitch: { fromName: string; toName: string } | null;
  confirmFoodSwitch: () => void;
  cancelFoodSwitch: () => void;
  incFoodItem: (menuItemId: string) => void;
  decFoodItem: (menuItemId: string) => void;
  removeFoodItem: (menuItemId: string) => void;
  clearFoodCart: () => void;
  inFoodCartQty: (menuItemId: string) => number;
  applyBestCoupon: (couponCode?: string) => void; // apply a food coupon (default: the best available)
  setFoodCutlery: (optIn: boolean) => void; // update_food_cart cutleryOptIn
  // coupons Swiggy lists as applicable to the current food cart (fetch_food_coupons)
  // filter = fetch_food_coupons summary.filter_applied ("COD only")
  listFoodCoupons: () => Promise<{ coupons: Coupon[]; message?: string; filter?: string }>;
  // drop an address Swiggy just deleted (delete_address) from the picker
  removeDeletedAddress: (id: string) => void;
  placeFoodOrder: (opts?: {
    paymentMethod?: string;
    intentApp?: string;
    generateUPIQR?: boolean;
    amount?: number;
    noteToRestaurant?: string;
  }) => Promise<{ ok: boolean; gated: boolean; placed: boolean; message: string; session?: PaymentSession }>;
  // one-tap reorder from real order history
  orderUsuals: () => void;
  // smart deal-hunter — finds the heaviest offers + proposes the best to cart
  findDeals: () => void;
  // smart basket — goal-driven auto-builder ("high-protein day under ₹600")
  smartBasket: (goal: string) => void;
  // bulk cart setters (used to import a shared basket from a link)
  setCartItems: (items: CartLine[]) => void;
  setFoodItems: (
    items: FoodCartLine[],
    restaurantId: string | null,
    restaurantName: string | null,
  ) => void;
  // card actions that send a follow-up chat turn
  sendMessage: (
    text: string,
    serviceOverride?: Service,
    image?: { mediaType: string; data: string },
    addIntent?: 'direct' | 'propose',
    displayText?: string,
  ) => void;
  // stop the streaming reply; re-run a reply in place ("Try again")
  stop: () => void;
  regenerate: (assistantId: string) => void;
  // approval-gated agent cart proposals
  approveProposal: (messageId: string, pid: string) => void;
  dismissProposal: (messageId: string, pid: string) => void;
  approveAllProposals: (messageId: string) => void;
  // Instamart AI basket card: approve (with the user's removals / swaps) or dismiss
  basketAction: (
    messageId: string,
    action: { type: 'approve'; removed: string[]; chosen: Record<string, number> } | { type: 'dismiss' },
  ) => void;
  // Instamart: build the usuals refill basket (your_go_to_items) as one card
  refillUsuals: () => void;
  // Instamart: swap one cart line for another (AI substitute for an unavailable line)
  replaceCartLine: (oldSpinId: string, line: Omit<CartLine, 'quantity'>, quantity: number) => void;
  // queued messages (clicked while a turn was streaming) + cancel
  queue: { qid: string; label: string }[];
  cancelQueued: (qid: string) => void;
  openMenu: (r: FoodRestaurant) => void;
  // restaurant menu "More" (next get_restaurant_menu page) + its loading flag
  loadMoreMenu: (messageId: string) => void;
  isLoadingMoreMenu: (messageId: string) => boolean;
  // cross-restaurant dish search "More dishes" (search_menu nextOffset)
  loadMoreDishes: (messageId: string, groupIndex: number) => void;
  isLoadingMoreDishes: (messageId: string, groupIndex: number) => boolean;
  needsLogin: boolean;
  /** the first /api/addresses lookup has settled (ok or not) — lets the UI show a skeleton, not "empty", before it */
  addressesLoaded: boolean;
  // Swiggy authentication
  auth: {
    authenticated: boolean;
    user: SwiggyUser | null;
    loading: boolean;
  };
  login: () => void;
  logout: () => Promise<void>;
  // Universal in-chat payments
  paymentSession: PaymentSession | null;
  paymentOptions: PaymentOptionsPayload | null;
  fetchPaymentOptions: (svc?: Service, addrId?: string, cartKey?: string) => Promise<PaymentOptionsPayload | null>;
  openPayment: (session: PaymentSession, options?: PaymentOptionsPayload) => void;
  closePayment: () => void;
  onPaymentSuccess: (orderId: string, message: string) => void;
  /** PaymentModal onRetry: close the failed attempt and refresh live payment options. */
  retryPayment: () => void;
  // Address creation
  addCreatedAddress: (address: Address) => void;
  createAddressModalOpen: boolean;
  setCreateAddressModalOpen: (open: boolean) => void;
  // Dineout & Scenes actions
  // opts.autoPick: fill with the picker's best AI pick. opts.planIntent (Plan
  // tab): the itinerary step it serves — its AI read pre-fills the slot / show
  // that fits the plan (PICK … confirm=1); the user still taps the final Confirm.
  // opts.planPick (Plan run): ONE selection computed from the loaded listing for
  // the plan step (replaces autoPick; the AI read then only explains it).
  openDineoutSlots: (restaurant: DineoutRestaurant, opts?: { autoPick?: boolean; planIntent?: string; planPick?: PlanPickResolver }) => void;
  bookDineoutSlot: (
    restaurantId: string,
    restaurantName: string,
    choice: DineoutSlotChoice,
    guestCount: number,
  ) => Promise<boolean>;
  openScenesShows: (event: ScenesEvent, opts?: { autoPick?: boolean; planIntent?: string; planPick?: PlanPickResolver }) => void;
  bookScenesShow: (
    eventId: string,
    eventTitle: string,
    outcome: ScenesOrderOutcome,
    ticketTitle: string,
    guestCount: number,
  ) => Promise<void>;
}

export function useSwiggyChat(): UseSwiggyChat {
  // No session cookie on the request → server-render the login gate directly.
  const loggedOutHint = useCertainlyLoggedOut();
  const [needsLogin, setNeedsLogin] = useState(loggedOutHint);
  const [auth, setAuth] = useState<{
    authenticated: boolean;
    user: SwiggyUser | null;
    loading: boolean;
  }>({
    authenticated: false,
    user: null,
    loading: true,
  });

  // Reads the auth status (no state writes) so the mount effect only sets state
  // from the async callback — never synchronously in the effect body.
  const readAuthStatus = useCallback(async (): Promise<{
    authenticated: boolean;
    user: SwiggyUser | null;
    loading: boolean;
  }> => {
    try {
      const res = await window.fetch('/api/auth/status', {
        headers: { 'ngrok-skip-browser-warning': 'true' },
      });
      if (!res.ok) return { authenticated: false, user: null, loading: false };
      const data = await res.json();
      return {
        authenticated: Boolean(data?.authenticated),
        user: data?.user || null,
        loading: false,
      };
    } catch {
      return { authenticated: false, user: null, loading: false };
    }
  }, []);

  useEffect(() => {
    let alive = true;
    // The OAuth callback reports failures as ?auth_error=… — strip it from the
    // URL and tell the user once.
    let authError: string | null = null;
    try {
      const url = new URL(window.location.href);
      authError = url.searchParams.get('auth_error');
      if (authError) {
        url.searchParams.delete('auth_error');
        window.history.replaceState(null, '', url.toString());
      }
    } catch {
      // ignore
    }
    void readAuthStatus().then((next) => {
      if (!alive) return;
      setAuth(next);
      if (authError && !next.authenticated) {
        setMessages((prev) => [
          ...prev,
          {
            id: `auth-err-${Date.now()}`,
            role: 'assistant',
            text:
              authError === 'access_denied'
                ? 'Swiggy login was cancelled. Tap **Login with Swiggy** whenever you are ready.'
                : 'Swiggy login did not complete. Please tap **Login with Swiggy** and try again.',
            createdAt: Date.now(),
          },
        ]);
      }
    });
    return () => {
      alive = false;
    };
  }, [readAuthStatus]);

  const login = useCallback(() => {
    window.location.href = '/api/auth/login';
  }, []);

  const logout = useCallback(async () => {
    try {
      await window.fetch('/api/auth/logout', {
        method: 'POST',
        headers: { 'ngrok-skip-browser-warning': 'true' },
      });
      setAuth({ authenticated: false, user: null, loading: false });
      setAddresses([]);
      setSelectedAddressId('');
      setCart(emptyCart(''));
      setFoodCart(emptyFoodCart());
      setMessages([]);
    } catch (err) {
      console.error('Logout failed:', err);
    }
  }, []);

  // Shadow global fetch to intercept 401 Unauthorized errors and bypass ngrok interstitials
  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers || {});
    headers.set('ngrok-skip-browser-warning', 'true');
    const res = await window.fetch(input, { ...init, headers });
    if (res.status === 401) {
      setNeedsLogin(true);
      setAuth({ authenticated: false, user: null, loading: false });
    }
    return res;
  };

  const [service, setServiceState] = useState<Service>('instamart');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [sending, setSending] = useState(false);
  const [addresses, setAddresses] = useState<Address[]>([]);
  const [addressesLoaded, setAddressesLoaded] = useState(false);
  const [selectedAddressId, setSelectedAddressId] = useState('');
  const [createAddressModalOpen, setCreateAddressModalOpen] = useState(false);

  // Universal in-chat payment session & options
  const [paymentSession, setPaymentSession] = useState<PaymentSession | null>(null);
  const [paymentOptions, setPaymentOptions] = useState<PaymentOptionsPayload | null>(null);

  const openPayment = useCallback((session: PaymentSession, options?: PaymentOptionsPayload) => {
    // Typed number, but upstream payloads can carry a "₹241" string at runtime.
    const rawAmt: unknown = session.amount;
    let cleanAmt = 0;
    if (typeof rawAmt === 'number' && Number.isFinite(rawAmt)) {
      cleanAmt = rawAmt;
    } else if (typeof rawAmt === 'string') {
      const clean = rawAmt.replace(/[^0-9.]/g, '');
      if (clean) {
        const n = Number(clean);
        if (Number.isFinite(n)) cleanAmt = n;
      }
    }
    // No amount on the place-order response: fall back to Swiggy's own cart
    // bill. Never invent one — 0 means "unknown" and the modal hides it.
    if (!cleanAmt || cleanAmt <= 0) {
      if (session.service === 'food') {
        cleanAmt = foodCartRef.current.toPay || 0;
      } else if (session.service === 'instamart') {
        const billTotal = cartRef.current.bill?.total ? Number(String(cartRef.current.bill.total).replace(/[^0-9.]/g, '')) : 0;
        cleanAmt = Number.isFinite(billTotal) ? billTotal : 0;
      }
    }
    setPaymentSession({
      ...session,
      amount: cleanAmt > 0 ? cleanAmt : 0,
    });
    if (options) setPaymentOptions(options);
  }, []);

  const closePayment = useCallback(() => {
    setPaymentSession(null);
    setPaymentOptions(null);
  }, []);

  const paymentSessionRef = useRef<PaymentSession | null>(null);
  useEffect(() => {
    paymentSessionRef.current = paymentSession;
  }, [paymentSession]);

  // instamart cart
  const [cart, setCart] = useState<CartState>(() => emptyCart(''));
  const [cartBusy, setCartBusy] = useState(false);
  const [loadingIds, setLoadingIds] = useState<Record<string, boolean>>({});

  // food cart — the ACTIVE restaurant's cart (the one synced to Swiggy).
  const [foodCart, setFoodCart] = useState<FoodCart>(() => emptyFoodCart());
  const [foodBusy, setFoodBusy] = useState(false);
  // MULTI-CART: other restaurants' carts, parked locally. Swiggy can only hold
  // one restaurant's order at a time, so only the ACTIVE cart syncs to Swiggy;
  // parked carts are saved baskets you switch into (and then place separately).
  const [parkedFoodCarts, setParkedFoodCarts] = useState<FoodCart[]>([]);
  const parkedFoodCartsRef = useRef<FoodCart[]>([]);

  // dynamic follow-up chips parsed from the agent's replies
  const [dynamicSuggestions, setDynamicSuggestions] = useState<string[]>([]);

  // products picked to compare ("choose best of both") — any number
  const [compareItems, setCompareItems] = useState<CompareItem[]>([]);

  // the cart line the user is replacing ("change this to X"), + the live pending
  // swap so the agent's resulting ADD this turn is applied as a replace.
  const [swapItem, setSwapItem] = useState<SwapItem | null>(null);
  const pendingSwapRef = useRef<SwapItem | null>(null);
  // A chat-requested tab switch (CONTROL: service=…), applied when the turn ends
  // so the new tab starts its OWN thread instead of inheriting this one.
  const pendingTabRef = useRef<Service | null>(null);

  // A food cart is single-restaurant. Adding a dish from a DIFFERENT restaurant
  // would wipe the current order, so we hold it here and confirm first.
  const [pendingFoodSwitch, setPendingFoodSwitch] = useState<{
    line: Omit<FoodCartLine, 'quantity'>;
    restaurantId: string;
    restaurantName: string;
    quantity: number;
    fromName: string;
    toName: string;
  } | null>(null);

  // Outgoing message QUEUE: clicking chips/options while a turn is streaming
  // lines them up here and they fire one after another (each cancellable).
  type QItem = {
    qid: string;
    text: string;
    serviceOverride?: Service;
    image?: { mediaType: string; data: string };
    addIntent?: 'direct' | 'propose';
    displayText?: string;
    // runs when the turn actually starts (with its assistant id) — lets feature
    // buttons (cook / compare / swap) queue and still bind to THEIR turn.
    onStart?: (assistantId: string) => void;
  };
  const queueRef = useRef<QItem[]>([]);
  const [queue, setQueue] = useState<QItem[]>([]);
  const qidRef = useRef(0);
  const syncQueue = useCallback(() => setQueue([...queueRef.current]), []);
  type SendFn = (
    text: string,
    serviceOverride?: Service,
    image?: { mediaType: string; data: string },
    addIntent?: 'direct' | 'propose',
    displayText?: string,
    onStart?: (assistantId: string) => void,
  ) => void;
  // Ref to the latest sendMessage so the drain effect can dispatch the next one.
  const sendMessageRef = useRef<SendFn>(() => {});

  // local (browser) chat history + the active session id
  const [history, setHistory] = useState<ChatSessionMeta[]>([]);
  const [sessionId, setSessionId] = useState<string>(makeSessionId);

  // saved recipes (browser-local)
  const [recipes, setRecipes] = useState<Recipe[]>([]);

  // diet goals / requirements, injected into every search (browser-local)
  const [preferences, setPreferencesState] = useState('');
  const [allergies, setAllergiesState] = useState('');
  const [budget, setBudgetState] = useState(0);
  const [kcalGoal, setKcalGoalState] = useState(0);
  const [proteinGoal, setProteinGoalState] = useState(0);

  // id -> agent-estimated macros, captured from `macros` events and persisted so
  // the MacroMeter survives reload. Powers `foodMacros` below.
  const [macros, setMacros] = useState<Record<string, { kcal: number; protein: number }>>({});

  /* ----------------------------- live mirrors ----------------------------- */
  // Refs that mirror state so stable callbacks read current values without
  // re-creating (and without stale closures).
  const preferencesRef = useRef(preferences);
  const allergiesRef = useRef(allergies);
  const budgetRef = useRef(budget);
  const kcalGoalRef = useRef(kcalGoal);
  const proteinGoalRef = useRef(proteinGoal);
  const serviceRef = useRef(service);
  const selectedAddressIdRef = useRef(selectedAddressId);
  const cartRef = useRef(cart);
  const foodCartRef = useRef(foodCart);
  const sendingRef = useRef(sending);
  const compareItemsRef = useRef(compareItems);
  const messagesRef = useRef<ChatMessage[]>(messages);

  useEffect(() => { preferencesRef.current = preferences; }, [preferences]);
  useEffect(() => { allergiesRef.current = allergies; }, [allergies]);
  useEffect(() => { budgetRef.current = budget; }, [budget]);
  useEffect(() => { kcalGoalRef.current = kcalGoal; }, [kcalGoal]);
  useEffect(() => { proteinGoalRef.current = proteinGoal; }, [proteinGoal]);
  useEffect(() => { serviceRef.current = service; }, [service]);
  useEffect(() => { selectedAddressIdRef.current = selectedAddressId; }, [selectedAddressId]);
  useEffect(() => { cartRef.current = cart; }, [cart]);
  useEffect(() => { foodCartRef.current = foodCart; }, [foodCart]);
  useEffect(() => { parkedFoodCartsRef.current = parkedFoodCarts; }, [parkedFoodCarts]);
  useEffect(() => { sendingRef.current = sending; }, [sending]);
  useEffect(() => { compareItemsRef.current = compareItems; }, [compareItems]);

  // Latest messages snapshot + a synchronous id -> messageId index (so best/
  // healthy/warn marks route to the message that actually shows the item).
  const idIndexRef = useRef<Map<string, string>>(new Map());
  useEffect(() => {
    messagesRef.current = messages;
    const idx = new Map<string, string>();
    for (const m of messages) {
      m.productGroups?.forEach((g) =>
        g.products.forEach((p) => p.variations.forEach((v) => idx.set(v.spinId, m.id))),
      );
      m.suggestions?.forEach((p) => p.variations.forEach((v) => idx.set(v.spinId, m.id)));
      m.menu?.categories.forEach((c) => c.items.forEach((it) => idx.set(it.id, m.id)));
      m.dishGroups?.forEach((g) => g.dishes.forEach((d) => idx.set(d.id, m.id)));
    }
    idIndexRef.current = idx;
  }, [messages]);

  /* --------------------------- cart sync machinery ------------------------ */
  // version: bumps on every optimistic mutation (used to detect "newer edits
  // landed while a sync was in flight"). dirty: true until a sync reconciles
  // (so a stale background GET can't clobber unsynced optimistic items).
  const cartVersion = useRef(0);
  const foodVersion = useRef(0);
  const cartDirtyRef = useRef(false);
  const foodDirtyRef = useRef(false);
  const cartSyncTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const foodSyncTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cartSyncInFlight = useRef(false);
  const foodSyncInFlight = useRef(false);
  const cartSyncPending = useRef(false);
  const foodSyncPending = useRef(false);

  // Stable, render-safe id generation (no Math.random in render).
  const idRef = useRef(0);
  const nextId = useCallback(
    () => `id-${++idRef.current}-${Math.random().toString(36).slice(2, 8)}`,
    [],
  );

  // Bookings made in this app, remembered per Swiggy user (Swiggy has no
  // "list my bookings" tool — only status-by-orderId).
  const userIdRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    userIdRef.current = auth.user?.userId ?? undefined;
  }, [auth.user?.userId]);
  const rememberBooking = useCallback(
    (
      kind: BookingKind,
      orderId: string | undefined,
      title: string,
      details?: string,
      // Dineout: restaurant + search coordinates, so History can show its photo
      extra?: Pick<SavedBooking, 'restaurantId' | 'lat' | 'lng' | 'eventId' | 'startsAt' | 'party' | 'amount'>,
    ) => {
      if (!orderId) return;
      saveBooking(userIdRef.current, { kind, orderId, title, details, createdAt: Date.now(), ...extra });
    },
    [],
  );

  // The id of the most recently created assistant turn (so compare/cook helpers
  // can attach metadata to the turn they just kicked off).
  const lastAssistantIdRef = useRef<string>('');
  // The active cook run, if any (for persisting recipe ingredients/steps).
  const cookContextRef = useRef<CookContext | null>(null);

  // Posts an agent-resolved add-to-cart (carrying exact item metadata).
  // Reassigned every render so the stable applyEvent always runs the latest
  // optimistic closures via this ref.
  const addResolverRef = useRef<
    (ev: Extract<ChatStreamEvent, { type: 'addToCart' }>) => void
  >(() => {});

  // Agent-driven REMOVE — drops a line by id, optimistically. Reassigned each
  // render so the stable applyEvent always runs the latest cart closures.
  const removeResolverRef = useRef<(target: 'instamart' | 'food', id: string) => void>(
    () => {},
  );

  // Agent cart changes are PROPOSED (approval-gated). proposeResolverRef builds a
  // proposal card + stashes its "apply" fn; proposalActionsRef maps pid -> apply.
  const proposeResolverRef = useRef<
    (
      assistantId: string,
      ev: Extract<ChatStreamEvent, { type: 'addToCart' | 'removeFromCart' }>,
    ) => void
  >(() => {});
  const proposalActionsRef = useRef<Map<string, () => void>>(new Map());
  const pidRef = useRef(0);
  // Whether THIS turn's agent ADDs/REMOVEs apply directly (user explicitly asked)
  // or are proposed for approval (the agent is acting on its own).
  const turnIntentRef = useRef<'direct' | 'propose'>('propose');

  // PER-TURN context, keyed by assistant id. Async resolvers (ingredient / dish
  // searches) settle AFTER `done` — often after the next queued turn started —
  // so they must read THEIR turn's intent/swap, never the global "current" one.
  type TurnCtx = { intent: 'direct' | 'propose'; hadAdd: boolean };
  const turnsRef = useRef<Map<string, TurnCtx>>(new Map());
  // The add-intent each user turn was sent with (so "Try again" replays it).
  const userIntentRef = useRef<Map<string, 'direct' | 'propose'>>(new Map());
  /** The intent of a given turn (falls back to the latest turn's intent). */
  const intentFor = useCallback(
    (assistantId: string): 'direct' | 'propose' =>
      turnsRef.current.get(assistantId)?.intent ?? turnIntentRef.current,
    [],
  );

  // The in-flight chat stream's abort handle (STOP / thread reset), and the id of
  // the assistant turn the UI is currently listening to — events for any other
  // (stale) turn are dropped so a tab switch / new chat never receives them.
  const abortRef = useRef<AbortController | null>(null);
  const activeTurnRef = useRef<string | null>(null);
  // assistant id -> text length before an error banner was appended (history
  // sent to the agent is cut there).
  const errorAtRef = useRef<Map<string, number>>(new Map());
  // Bumped on every thread reset; async resolvers capture it and bail if it
  // changed (so a late search can't edit the cart after a tab switch).
  const threadEpochRef = useRef(0);
  const sessionIdRef = useRef(sessionId);
  useEffect(() => { sessionIdRef.current = sessionId; }, [sessionId]);

  // Fetches cross-restaurant dishes for a DISHES marker and appends them.
  const dishResolverRef = useRef<(assistantId: string, query: string) => void>(
    () => {},
  );

  // Cook: searches every ingredient IN PARALLEL and proposes the best pick of
  // each, so the basket builds fast instead of one ingredient per agent turn.
  const ingredientsResolverRef = useRef<(assistantId: string, items: string[]) => void>(
    () => {},
  );

  // Universal chat control — applies a CONTROL marker (set a goal/budget/allergy/
  // preference, switch theme/service, clear cart, …) to real app state.
  const controlResolverRef = useRef<(action: string, value?: string) => void>(
    () => {},
  );

  /* ------------------------------- addresses ------------------------------ */

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await fetch('/api/addresses');
        if (!res.ok) return;
        const data: { addresses?: Address[]; resolution?: AddressResolution | null } = await res.json();
        if (!alive) return;
        const list = data.addresses ?? [];
        // Swiggy's get_addresses resolution decides the preselection: its
        // defaultAddressId (one address, or a ranked suggestion the picker lets
        // the user change). Keep an earlier explicit pick if it still exists.
        const suggested = data.resolution?.defaultAddressId;
        const preferred = list.find((a) => a.id === suggested);
        const sorted = preferred ? [preferred, ...list.filter((a) => a.id !== preferred.id)] : list;
        setAddresses(sorted);
        if (sorted.length) {
          setSelectedAddressId((prev) =>
            prev && sorted.some((a) => a.id === prev) ? prev : sorted[0].id,
          );
        }
      } catch {
        // leave addresses empty; UI still renders gracefully
      } finally {
        if (alive) setAddressesLoaded(true);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const selectAddress = useCallback((id: string) => {
    setSelectedAddressId(id);
  }, []);

  // A different address means a different cart — clear the dirty guards so the
  // load effects below can adopt the new address's authoritative cart.
  useEffect(() => {
    cartDirtyRef.current = false;
    foodDirtyRef.current = false;
  }, [selectedAddressId]);

  /* ---------------------------- service switch ---------------------------- */

  // Write a conversation to local history (heavy base64 photos stripped so a few
  // photo turns can't blow the localStorage quota and silently stop saving).
  // upsertSession is a no-op when nothing actually changed (so merely reopening
  // a chat — which re-keys ids — never bumps its updatedAt or reorders history).
  const persistTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saveSession = useCallback((id: string, svc: Service, msgs: ChatMessage[]) => {
    const firstUser = msgs.find((m) => m.role === 'user');
    if (!firstUser) return;
    const title = (firstUser.text || '').trim().slice(0, 70) || 'New chat';
    const persistable = msgs.map((m) => (m.image ? { ...m, image: undefined } : m));
    if (upsertSession({ id, title, service: svc, messages: persistable, updatedAt: Date.now() })) {
      setHistory(loadSessionList());
    }
  }, []);
  // Save the CURRENT thread right now (cancelling any debounced save) — used
  // before the thread is swapped out so its latest state is never lost.
  const flushPersist = useCallback(() => {
    if (persistTimerRef.current) {
      clearTimeout(persistTimerRef.current);
      persistTimerRef.current = null;
    }
    if (messagesRef.current.length) {
      saveSession(sessionIdRef.current, serviceRef.current, messagesRef.current);
    }
  }, [saveSession]);

  // Tear down the current thread: abort the in-flight stream (so its late events,
  // cart edits, CONTROLs and chips never leak into the next thread), drop the
  // queue, unlock the composer, and clear every per-thread ref + state.
  const resetThread = useCallback(
    (persist = true) => {
      if (persist) {
        flushPersist();
      } else if (persistTimerRef.current) {
        clearTimeout(persistTimerRef.current);
        persistTimerRef.current = null;
      }
      abortRef.current?.abort();
      abortRef.current = null;
      activeTurnRef.current = null;
      threadEpochRef.current += 1;
      turnsRef.current.clear();
      queueRef.current = [];
      setQueue([]);
      sendingRef.current = false;
      setSending(false);
      pendingSwapRef.current = null;
      cookContextRef.current = null;
      messagesRef.current = [];
      idIndexRef.current = new Map();
      setMessages([]);
      setDynamicSuggestions([]);
      setCompareItems([]);
    },
    [flushPersist],
  );

  /** Start a brand-new session id (ref updated synchronously for same-tick reads). */
  const freshSession = useCallback(() => {
    const sid = makeSessionId();
    sessionIdRef.current = sid;
    setSessionId(sid);
  }, []);

  // Switching service resets the thread (fresh greeting) and starts a fresh
  // session so the previous one stays intact in history. Side effects live
  // OUTSIDE the state updater so the setter stays pure.
  const setService = useCallback(
    (s: Service) => {
      if (serviceRef.current === s) return;
      resetThread(); // persists the old thread under its OLD service first
      serviceRef.current = s;
      setServiceState(s);
      freshSession();
    },
    [resetThread, freshSession],
  );

  /* ----------------------------- local history ---------------------------- */

  // Load saved sessions + recipes + preferences + macros once on mount. (Reading
  // browser-only storage in an effect — not a lazy initializer — keeps the
  // server-rendered HTML and the first client render in sync.)
  useEffect(() => {
    // Hydrate React from the persisted browser store on mount. This is the
    // sanctioned use of an effect (sync React state with an external system);
    // lazy initializers would read localStorage during render and mismatch the
    // server-rendered HTML, so the rule is intentionally disabled here.
    /* eslint-disable react-hooks/set-state-in-effect -- load browser-only persisted state on mount */
    setHistory(loadSessionList());
    setRecipes(loadRecipes());
    try {
      setPreferencesState(localStorage.getItem('swiggy-preferences-v1') ?? '');
      setAllergiesState(localStorage.getItem('swiggy-allergies-v1') ?? '');
      setBudgetState(Number(localStorage.getItem('swiggy-budget-v1') || 0) || 0);
      setKcalGoalState(Number(localStorage.getItem('swiggy-kcalgoal-v1') || 0) || 0);
      setProteinGoalState(Number(localStorage.getItem('swiggy-proteingoal-v1') || 0) || 0);
      const m = localStorage.getItem(MACROS_KEY);
      if (m) setMacros(JSON.parse(m) as Record<string, { kcal: number; protein: number }>);
    } catch {
      /* ignore */
    }
    /* eslint-enable react-hooks/set-state-in-effect */
  }, []);

  const persistPref = (key: string, val: string) => {
    try {
      localStorage.setItem(key, val);
      noteLocalChange({ entity: 'preferences' });
    } catch {
      /* ignore */
    }
  };

  // Cross-device sync (inert when the server has no database): when server
  // data lands in localStorage, re-read the stores this hook mirrors.
  const onCloudSynced = useCallback((c: SyncedChange) => {
    if (c.sessions) setHistory(loadSessionList());
    if (c.preferences) {
      const p = readLocalPreferences();
      setPreferencesState(p.preferences);
      setAllergiesState(p.allergies);
      setBudgetState(p.budget);
      setKcalGoalState(p.kcalGoal);
      setProteinGoalState(p.proteinGoal);
    }
  }, []);
  useCloudSync(auth.authenticated, auth.user?.userId ?? undefined, onCloudSynced);

  const setPreferences = useCallback((p: string) => {
    setPreferencesState(p);
    persistPref('swiggy-preferences-v1', p);
  }, []);
  const setAllergies = useCallback((a: string) => {
    setAllergiesState(a);
    persistPref('swiggy-allergies-v1', a);
  }, []);
  const setBudget = useCallback((n: number) => {
    const v = Math.max(0, Math.round(n) || 0);
    setBudgetState(v);
    persistPref('swiggy-budget-v1', String(v));
  }, []);
  const setMacroGoals = useCallback((kcal: number, protein: number) => {
    const k = Math.max(0, Math.round(kcal) || 0);
    const p = Math.max(0, Math.round(protein) || 0);
    setKcalGoalState(k);
    setProteinGoalState(p);
    persistPref('swiggy-kcalgoal-v1', String(k));
    persistPref('swiggy-proteingoal-v1', String(p));
  }, []);

  // Persist the current conversation whenever a turn settles — debounced, since
  // late async results (ingredient grids, approvals) each change `messages` and
  // every save re-serializes the whole history. The write + history re-read run
  // in the timer callback (an external-store sync), not the effect body.
  useEffect(() => {
    if (sending || messages.length === 0) return;
    if (persistTimerRef.current) clearTimeout(persistTimerRef.current);
    persistTimerRef.current = setTimeout(() => {
      persistTimerRef.current = null;
      saveSession(sessionId, service, messages);
    }, 400);
  }, [messages, sending, service, sessionId, saveSession]);

  const newChat = useCallback(() => {
    resetThread();
    freshSession();
  }, [resetThread, freshSession]);

  const openSession = useCallback(
    (id: string) => {
      const s = loadSession(id);
      if (!s) return;
      resetThread();
      // Re-key any missing/duplicate ids so React never sees a duplicate key, and
      // normalize transient fields: a thread saved mid-turn must not spin forever,
      // and a pending proposal whose apply() closure didn't survive a reload can't
      // be approved (it would add nothing) — show it as dismissed instead.
      const seen = new Set<string>();
      const restored = s.messages.map((m) => {
        let id2 = m.id;
        if (!id2 || seen.has(id2)) {
          id2 = `id-${++idRef.current}-${Math.random().toString(36).slice(2, 8)}`;
        }
        seen.add(id2);
        return {
          ...m,
          id: id2,
          pending: false,
          status: undefined,
          proposals: m.proposals?.map((p) =>
            p.status === 'pending' && !proposalActionsRef.current.has(p.pid)
              ? { ...p, status: 'dismissed' as const }
              : p,
          ),
        };
      });
      setServiceState(s.service);
      serviceRef.current = s.service;
      messagesRef.current = restored;
      setMessages(restored);
      sessionIdRef.current = s.id;
      setSessionId(s.id);
    },
    [resetThread],
  );

  const removeSession = useCallback(
    (id: string) => {
      deleteSession(id);
      setHistory(loadSessionList());
      if (id === sessionIdRef.current) {
        resetThread(false); // don't re-save the session we just deleted
        freshSession();
      }
    },
    [resetThread, freshSession],
  );

  const saveRecipe = useCallback((dish: string) => {
    const name = dish.trim();
    if (!name) return;
    saveRecipeStore({ id: makeSessionId(), dish: name, createdAt: Date.now() });
    setRecipes(loadRecipes());
  }, []);

  const removeRecipe = useCallback((id: string) => {
    deleteRecipe(id);
    setRecipes(loadRecipes());
  }, []);

  /* --------------------------- cart background sync ----------------------- */

  // Replay the WHOLE desired grocery cart to the server. Coalesced (one desired
  // set) + serialized (at most one in flight; the latest queued). Reconciles the
  // authoritative bill on the way back without clobbering newer optimistic edits.
  const runCartSync = useCallback(async () => {
    if (cartSyncInFlight.current) {
      cartSyncPending.current = true;
      return;
    }
    cartSyncInFlight.current = true;
    setCartBusy(true);
    try {
      do {
        cartSyncPending.current = false;
        const sentVersion = cartVersion.current;
        const snap = cartRef.current;
        // The cart follows the SELECTED address (the route moves the server
        // cart — clear_cart then update_cart — when the address changed).
        const addressId = selectedAddressIdRef.current || snap.addressId;
        const items = snap.items.map(({ quantity, ...line }) => ({ line, quantity }));
        try {
          const res = await fetch('/api/cart', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'set', addressId, items }),
          });
          // 200 = Swiggy's new cart; 422 = Swiggy rejected the change and the
          // body is what Swiggy actually holds now + its error in `warnings`.
          const data = await readServerCart(res);
          // Adopt the authoritative server state ONLY if no newer optimistic
          // edit landed mid-flight; otherwise a fresh sync is already queued.
          if (data && cartVersion.current === sentVersion) {
            setCart(withLineMeta(data, snap));
            cartDirtyRef.current = false;
          }
        } catch {
          // keep optimistic state; the next change re-attempts the sync
        }
      } while (cartSyncPending.current);
    } finally {
      cartSyncInFlight.current = false;
      setCartBusy(false);
    }
  }, []);

  const scheduleCartSync = useCallback(() => {
    if (cartSyncTimer.current) clearTimeout(cartSyncTimer.current);
    cartSyncTimer.current = setTimeout(() => {
      cartSyncTimer.current = null;
      void runCartSync();
    }, SYNC_DEBOUNCE_MS);
  }, [runCartSync]);

  // Force-push the latest desired cart and await it (used right before checkout
  // so the server validates against exactly what the user sees).
  // Returns Swiggy's cart after the push (null if the push itself failed).
  const pushCartNow = useCallback(async (): Promise<{ cart: CartState; ok: boolean } | null> => {
    if (cartSyncTimer.current) {
      clearTimeout(cartSyncTimer.current);
      cartSyncTimer.current = null;
    }
    const snap = cartRef.current;
    const addressId = selectedAddressIdRef.current || snap.addressId;
    const items = snap.items.map(({ quantity, ...line }) => ({ line, quantity }));
    try {
      const res = await fetch('/api/cart', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'set', addressId, items }),
      });
      const data = await readServerCart(res);
      if (!data) return null;
      const merged = withLineMeta(data, snap);
      setCart(merged);
      cartDirtyRef.current = false;
      return { cart: merged, ok: res.ok };
    } catch {
      return null;
    }
  }, []);

  const runFoodSync = useCallback(async () => {
    if (foodSyncInFlight.current) {
      foodSyncPending.current = true;
      return;
    }
    foodSyncInFlight.current = true;
    setFoodBusy(true);
    try {
      do {
        foodSyncPending.current = false;
        const sentVersion = foodVersion.current;
        const snap = foodCartRef.current;
        const items = snap.items.map(({ quantity, ...line }) => ({ line, quantity }));
        try {
          const res = await fetch('/api/food-cart', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              action: 'set',
              addressId: selectedAddressIdRef.current,
              restaurantId: snap.restaurantId ?? undefined,
              restaurantName: snap.restaurantName ?? undefined,
              items,
            }),
          });
          if (res.ok) {
            const data: FoodCart = await res.json();
            if (foodVersion.current === sentVersion) {
              setFoodCart(data);
              foodDirtyRef.current = false;
            }
          }
        } catch {
          // keep optimistic state
        }
      } while (foodSyncPending.current);
    } finally {
      foodSyncInFlight.current = false;
      setFoodBusy(false);
    }
  }, []);

  const scheduleFoodSync = useCallback(() => {
    if (foodSyncTimer.current) clearTimeout(foodSyncTimer.current);
    foodSyncTimer.current = setTimeout(() => {
      foodSyncTimer.current = null;
      void runFoodSync();
    }, SYNC_DEBOUNCE_MS);
  }, [runFoodSync]);

  const pushFoodNow = useCallback(async () => {
    if (foodSyncTimer.current) {
      clearTimeout(foodSyncTimer.current);
      foodSyncTimer.current = null;
    }
    const snap = foodCartRef.current;
    const items = snap.items.map(({ quantity, ...line }) => ({ line, quantity }));
    try {
      const res = await fetch('/api/food-cart', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'set',
          addressId: selectedAddressIdRef.current,
          restaurantId: snap.restaurantId ?? undefined,
          restaurantName: snap.restaurantName ?? undefined,
          items,
        }),
      });
      if (res.ok) {
        const data: FoodCart = await res.json();
        setFoodCart(data);
        foodDirtyRef.current = false;
      }
    } catch {
      /* ignore */
    }
  }, []);

  /* -------------------------- optimistic primitives ----------------------- */

  const applyCart = useCallback(
    (updater: (items: CartLine[]) => CartLine[]) => {
      cartVersion.current += 1;
      cartDirtyRef.current = true;
      setCart((prev) =>
        recomputeCart(
          prev.addressId || selectedAddressIdRef.current,
          updater(prev.items),
          prev.bill,
        ),
      );
      scheduleCartSync();
    },
    [scheduleCartSync],
  );

  const addLine = useCallback(
    (line: Omit<CartLine, 'quantity'>, quantity = 1) => {
      const q = Math.max(1, quantity);
      applyCart((items) => {
        // Respect Swiggy's per-order cap for the SKU (maxQuantity).
        const cap = (n: number, max?: number) => (max && max > 0 ? Math.min(n, max) : n);
        const i = items.findIndex((x) => x.spinId === line.spinId);
        if (i >= 0) {
          const copy = items.slice();
          copy[i] = { ...copy[i], quantity: cap(copy[i].quantity + q, copy[i].maxQuantity ?? line.maxQuantity) };
          return copy;
        }
        return [...items, { ...line, quantity: cap(q, line.maxQuantity) }];
      });
    },
    [applyCart],
  );

  const setCartItems = useCallback(
    (items: CartLine[]) => {
      applyCart(() => items);
    },
    [applyCart],
  );

  const applyFood = useCallback(
    (
      updater: (cart: FoodCart) => {
        items: FoodCartLine[];
        restaurantId: string | null;
        restaurantName: string | null;
      },
    ) => {
      foodVersion.current += 1;
      foodDirtyRef.current = true;
      setFoodCart((prev) => {
        const { items, restaurantId, restaurantName } = updater(prev);
        return recomputeFoodCart(prev, items, restaurantId, restaurantName);
      });
      scheduleFoodSync();
    },
    [scheduleFoodSync],
  );

  /**
   * Add a dish to the food cart. A Swiggy food cart holds ONE restaurant, so a
   * dish from a different restaurant is held in `pendingFoodSwitch` until the
   * user confirms the switch (docs: warn before the cart is flushed). Returns
   * false when the add is waiting on that confirmation.
   */
  const addFood = useCallback(
    (
      line: Omit<FoodCartLine, 'quantity'>,
      restaurantId: string,
      restaurantName: string,
      quantity = 1,
    ): boolean => {
      const q = Math.max(1, quantity);
      const cur = foodCartRef.current;
      if (cur.items.length && cur.restaurantId && restaurantId && cur.restaurantId !== restaurantId) {
        setPendingFoodSwitch({
          line,
          restaurantId,
          restaurantName,
          quantity: q,
          fromName: cur.restaurantName || 'your current restaurant',
          toName: restaurantName || 'the new restaurant',
        });
        return false;
      }
      applyFood((prev) => {
        const i = prev.items.findIndex((x) => x.menuItemId === line.menuItemId);
        let items: FoodCartLine[];
        if (i >= 0) {
          items = prev.items.slice();
          // a re-customised dish takes the new variant / add-on choice
          items[i] = line.selection
            ? { ...items[i], ...line, quantity: items[i].quantity + q }
            : { ...items[i], quantity: items[i].quantity + q };
        } else {
          items = [...prev.items, { ...line, quantity: q }];
        }
        return {
          items,
          restaurantId: prev.restaurantId ?? restaurantId,
          restaurantName: prev.restaurantName ?? restaurantName,
        };
      });
      return true;
    },
    [applyFood],
  );

  // Replace the WHOLE food cart in one shot (used by a shared-basket import).
  // Single-restaurant by nature, so it carries the restaurant identity with it.
  const setFoodItems = useCallback(
    (
      items: FoodCartLine[],
      restaurantId: string | null,
      restaurantName: string | null,
    ) => {
      applyFood(() => ({ items, restaurantId, restaurantName }));
    },
    [applyFood],
  );

  /* ----------------------------- instamart cart --------------------------- */

  // (Re)load the grocery cart when the address/service makes it relevant. The
  // dirty + version guards stop a slow GET from clobbering unsynced optimistic
  // items (e.g. a reorder that just rebuilt the cart).
  // Instamart carts bind to ONE address. When the user switches address with
  // items in the cart, move the cart: the /api/cart `set` sees the new address,
  // runs clear_cart then update_cart, and reports anything that didn't survive
  // the re-check (stock / serviceability differ per address).
  useEffect(() => {
    if (!selectedAddressId || service !== 'instamart') return;
    const snap = cartRef.current;
    if (snap.items.length && snap.addressId && snap.addressId !== selectedAddressId) {
      cartVersion.current += 1;
      void runCartSync();
      return;
    }
    let alive = true;
    const v = cartVersion.current;
    (async () => {
      try {
        const res = await fetch(`/api/cart?addressId=${encodeURIComponent(selectedAddressId)}`);
        const data = await readServerCart(res, true);
        if (data && alive && !cartDirtyRef.current && cartVersion.current === v) {
          setCart(withLineMeta(data, cartRef.current));
        }
      } catch {
        // network blip: keep what we show; the next change re-syncs
      }
    })();
    return () => {
      alive = false;
    };
  }, [selectedAddressId, service, runCartSync]);

  const addToCart = useCallback(
    (product: Product, variation: Variation, quantity = 1) => {
      const line: Omit<CartLine, 'quantity'> = {
        spinId: variation.spinId,
        ...(variation.skuId ? { skuId: variation.skuId } : {}),
        productId: product.productId,
        name: product.name,
        brand: product.brand,
        quantityDescription: variation.quantityDescription,
        imageUrl: variation.imageUrl,
        unitPrice: variation.offerPrice,
        mrp: variation.mrp,
        ...(variation.maxQuantity ? { maxQuantity: variation.maxQuantity } : {}),
        ...(variation.maxQuantityMessage ? { maxQuantityMessage: variation.maxQuantityMessage } : {}),
        inStock: product.inStock && variation.inStock,
      };
      addLine(line, quantity);
    },
    [addLine],
  );

  const incrementItem = useCallback(
    (spinId: string) =>
      applyCart((items) =>
        items.map((x) =>
          x.spinId === spinId && !(x.maxQuantity && x.quantity >= x.maxQuantity)
            ? { ...x, quantity: x.quantity + 1 }
            : x,
        ),
      ),
    [applyCart],
  );

  const decrementItem = useCallback(
    (spinId: string) =>
      applyCart((items) =>
        items.flatMap((x) =>
          x.spinId === spinId
            ? x.quantity > 1
              ? [{ ...x, quantity: x.quantity - 1 }]
              : []
            : [x],
        ),
      ),
    [applyCart],
  );

  const removeItem = useCallback(
    (spinId: string) => applyCart((items) => items.filter((x) => x.spinId !== spinId)),
    [applyCart],
  );

  const clearCart = useCallback(() => applyCart(() => []), [applyCart]);

  const inCartQty = useCallback(
    (spinId: string) => cart.items.find((i) => i.spinId === spinId)?.quantity ?? 0,
    [cart],
  );

  /* ------------------------------- food cart ------------------------------ */

  useEffect(() => {
    setFoodAddressId(selectedAddressId || '');
    if (!selectedAddressId || service !== 'food') return;
    let alive = true;
    const v = foodVersion.current;
    (async () => {
      try {
        const res = await fetch(`/api/food-cart?addressId=${encodeURIComponent(selectedAddressId)}`);
        if (!res.ok) return;
        const data: FoodCart = await res.json();
        if (alive && !foodDirtyRef.current && foodVersion.current === v) setFoodCart(data);
      } catch {
        if (alive && !foodDirtyRef.current && foodVersion.current === v) setFoodCart(emptyFoodCart());
      }
    })();
    return () => {
      alive = false;
    };
  }, [selectedAddressId, service]);

  // Manual Add from a dish card. `selection` carries the variant / add-on
  // choices for a customised dish (from the card's customizer).
  const addFoodItem = useCallback(
    (item: MenuItem, selection?: FoodCartSelection) => {
      const detail = selection
        ? [...selection.variants.map((v) => v.name), ...selection.addons.map((a) => a.name)]
            .filter(Boolean)
            .join(' · ') || undefined
        : undefined;
      const line: Omit<FoodCartLine, 'quantity'> = {
        menuItemId: item.id,
        name: item.name,
        imageUrl: item.imageUrl,
        veg: item.veg,
        price: item.price,
        ...(selection ? { selection, detail } : {}),
      };
      addFood(line, item.restaurantId, item.restaurantName, 1);
    },
    [addFood],
  );

  // Switch the active cart to a parked restaurant's cart (and park the current).
  const switchFoodCart = useCallback(
    (restaurantId: string) => {
      const cur = foodCartRef.current;
      const parked = parkedFoodCartsRef.current;
      const target = parked.find((c) => c.restaurantId === restaurantId);
      if (!target) return;
      const nextParked = parked.filter((c) => c.restaurantId !== restaurantId);
      if (cur.items.length > 0 && cur.restaurantId) {
        nextParked.push(cur);
      }
      setParkedFoodCarts(nextParked);
      parkedFoodCartsRef.current = nextParked;
      applyFood(() => ({
        items: target.items,
        restaurantId: target.restaurantId,
        restaurantName: target.restaurantName,
      }));
    },
    [applyFood],
  );

  // Discard a parked restaurant cart (does not touch the active cart).
  const discardParkedCart = useCallback((restaurantId: string) => {
    const next = parkedFoodCartsRef.current.filter(
      (c) => c.restaurantId !== restaurantId,
    );
    setParkedFoodCarts(next);
    parkedFoodCartsRef.current = next;
  }, []);

  // Confirm the restaurant switch: the current order is PARKED locally (so the
  // user can switch back to it) and Swiggy's cart is rebuilt for the new
  // restaurant — resuming its parked cart if there is one — with the held dish.
  const confirmFoodSwitch = useCallback(() => {
    const p = pendingFoodSwitch;
    if (!p) return;
    setPendingFoodSwitch(null);
    const cur = foodCartRef.current;
    const parked = parkedFoodCartsRef.current;
    const existing = parked.find((c) => c.restaurantId === p.restaurantId);
    const nextParked = [
      ...parked.filter((c) => c.restaurantId !== cur.restaurantId && c.restaurantId !== p.restaurantId),
      ...(cur.items.length && cur.restaurantId ? [cur] : []),
    ];
    setParkedFoodCarts(nextParked);
    parkedFoodCartsRef.current = nextParked;
    const base = existing ? existing.items.slice() : [];
    const i = base.findIndex((x) => x.menuItemId === p.line.menuItemId);
    if (i >= 0) base[i] = { ...base[i], ...p.line, quantity: base[i].quantity + p.quantity };
    else base.push({ ...p.line, quantity: Math.max(1, p.quantity) });
    applyFood(() => ({ items: base, restaurantId: p.restaurantId, restaurantName: p.restaurantName }));
  }, [pendingFoodSwitch, applyFood]);

  const cancelFoodSwitch = useCallback(() => setPendingFoodSwitch(null), []);

  // Food AI: an APPROVED meal plan (the user tapped Approve on the proposal).
  // Same restaurant → merge into the cart; another restaurant → park the
  // current cart (like a confirmed switch) and start this one.
  const applyMealPlan = useCallback(
    (
      lines: { line: Omit<FoodCartLine, 'quantity'>; quantity: number }[],
      restaurantId: string,
      restaurantName: string,
    ) => {
      const wanted = lines.filter((l) => l.line.menuItemId && l.quantity > 0);
      if (!wanted.length || !restaurantId) return;
      const cur = foodCartRef.current;
      const sameRest = !cur.items.length || !cur.restaurantId || cur.restaurantId === restaurantId;
      if (!sameRest) {
        const nextParked = [
          ...parkedFoodCartsRef.current.filter((c) => c.restaurantId !== cur.restaurantId && c.restaurantId !== restaurantId),
          cur,
        ];
        setParkedFoodCarts(nextParked);
        parkedFoodCartsRef.current = nextParked;
      }
      applyFood((prev) => {
        const items = sameRest ? prev.items.slice() : [];
        for (const w of wanted) {
          const detail = w.line.selection
            ? [...w.line.selection.variants.map((v) => v.name), ...w.line.selection.addons.map((a) => a.name)]
                .filter(Boolean)
                .join(' · ') || undefined
            : w.line.detail;
          const i = items.findIndex((x) => x.menuItemId === w.line.menuItemId);
          const line = { ...w.line, ...(detail ? { detail } : {}) };
          if (i >= 0) items[i] = { ...items[i], ...line, quantity: items[i].quantity + w.quantity };
          else items.push({ ...line, quantity: w.quantity });
        }
        return { items, restaurantId, restaurantName };
      });
    },
    [applyFood],
  );

  // Food AI: the user changed a cart line's portion / add-ons in the cart editor.
  const setFoodLineSelection = useCallback(
    (menuItemId: string, selection: FoodCartSelection, note?: string) => {
      const detail =
        [...selection.variants.map((v) => v.name), ...selection.addons.map((a) => a.name)].filter(Boolean).join(' · ') ||
        undefined;
      applyFood((prev) => ({
        items: prev.items.map((l) =>
          l.menuItemId === menuItemId ? { ...l, selection, detail, aiNote: note } : l,
        ),
        restaurantId: prev.restaurantId,
        restaurantName: prev.restaurantName,
      }));
    },
    [applyFood],
  );

  // Publish the Food actions + delivery context for the self-contained Food cards.
  const foodAddressLine = addresses.find((a) => a.id === selectedAddressId)?.addressLine ?? '';
  useEffect(() => {
    registerFoodActions({
      applyMealPlan,
      setLineSelection: setFoodLineSelection,
      sendChat: (text, displayText) => sendMessageRef.current(text, 'food', undefined, undefined, displayText),
      setMealPlanStatus: (messageId, status) =>
        setMessages((prev) =>
          prev.map((m) => (m.id === messageId && m.foodMealPlan ? { ...m, foodMealPlan: { ...m.foodMealPlan, status } } : m)),
        ),
    });
    setFoodContext({ addressId: selectedAddressId || '', addressLine: foodAddressLine });
  }, [applyMealPlan, setFoodLineSelection, selectedAddressId, foodAddressLine]);

  const incFoodItem = useCallback(
    (menuItemId: string) =>
      applyFood((prev) => ({
        items: prev.items.map((x) =>
          x.menuItemId === menuItemId ? { ...x, quantity: x.quantity + 1 } : x,
        ),
        restaurantId: prev.restaurantId,
        restaurantName: prev.restaurantName,
      })),
    [applyFood],
  );

  const decFoodItem = useCallback(
    (menuItemId: string) =>
      applyFood((prev) => {
        const items = prev.items.flatMap((x) =>
          x.menuItemId === menuItemId
            ? x.quantity > 1
              ? [{ ...x, quantity: x.quantity - 1 }]
              : []
            : [x],
        );
        return {
          items,
          restaurantId: items.length ? prev.restaurantId : null,
          restaurantName: items.length ? prev.restaurantName : null,
        };
      }),
    [applyFood],
  );

  const removeFoodItem = useCallback(
    (menuItemId: string) =>
      applyFood((prev) => {
        const items = prev.items.filter((x) => x.menuItemId !== menuItemId);
        return {
          items,
          restaurantId: items.length ? prev.restaurantId : null,
          restaurantName: items.length ? prev.restaurantName : null,
        };
      }),
    [applyFood],
  );

  const clearFoodCart = useCallback(
    () => applyFood(() => ({ items: [], restaurantId: null, restaurantName: null })),
    [applyFood],
  );

  const inFoodCartQty = useCallback(
    (menuItemId: string) =>
      foodCart.items.find((i) => i.menuItemId === menuItemId)?.quantity ?? 0,
    [foodCart],
  );

  // Apply the best available food coupon (real saving). Bumps the version so an
  // in-flight item sync can't clobber the coupon result we just applied.
  // A specific `couponCode` (from the coupon list / typed by the user) is
  // applied instead; non-string args (e.g. a click event) are ignored.
  const applyBestCoupon = useCallback((couponCode?: string) => {
    if (!foodCartRef.current.items.length) return;
    const code = typeof couponCode === 'string' ? couponCode.trim() : '';
    foodVersion.current += 1;
    setFoodBusy(true);
    (async () => {
      try {
        const res = await fetch('/api/food-cart', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'coupon',
            addressId: selectedAddressIdRef.current,
            ...(code ? { couponCode: code } : {}),
          }),
        });
        if (res.ok) {
          const data: FoodCart = await res.json();
          setFoodCart(data);
          foodDirtyRef.current = false;
        }
      } catch {
        /* keep cart as-is */
      } finally {
        setFoodBusy(false);
      }
    })();
  }, []);

  // Cutlery on/off for the food order (update_food_cart cutleryOptIn).
  const setFoodCutlery = useCallback((optIn: boolean) => {
    if (!foodCartRef.current.items.length) return;
    setFoodCart((prev) => ({ ...prev, cutleryOptIn: optIn }));
    foodVersion.current += 1;
    setFoodBusy(true);
    (async () => {
      try {
        const res = await fetch('/api/food-cart', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'cutlery', addressId: selectedAddressIdRef.current, cutleryOptIn: optIn }),
        });
        if (res.ok) {
          const data: FoodCart = await res.json();
          setFoodCart(data.items.length ? data : (prev) => ({ ...prev, cutleryOptIn: optIn }));
          foodDirtyRef.current = false;
        }
      } catch {
        /* keep cart as-is */
      } finally {
        setFoodBusy(false);
      }
    })();
  }, []);

  // Read-only: the coupons Swiggy lists as applicable to the current food cart.
  const listFoodCoupons = useCallback(async (): Promise<{ coupons: Coupon[]; message?: string; filter?: string }> => {
    if (!foodCartRef.current.items.length) return { coupons: [] };
    try {
      const res = await fetch('/api/food-cart', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'coupons', addressId: selectedAddressIdRef.current }),
      });
      const data = (await res.json().catch(() => ({}))) as { coupons?: Coupon[]; message?: string; filter?: string };
      return { coupons: Array.isArray(data.coupons) ? data.coupons : [], message: data.message, filter: data.filter };
    } catch {
      return { coupons: [], message: 'Could not reach the server.' };
    }
  }, []);

  // Place the food order the user confirmed. The server re-reads Swiggy's
  // cart, enforces the ₹1000 cap, checks `amount` against the live total and
  // only reports `placed` when Swiggy confirmed it (UPI returns a real
  // PENDING_PAYMENT session for the payment modal instead).
  const placeFoodOrder = useCallback(
    async (opts?: {
      paymentMethod?: string;
      intentApp?: string;
      generateUPIQR?: boolean;
      amount?: number;
      noteToRestaurant?: string;
    }): Promise<{
      ok: boolean;
      gated: boolean;
      placed: boolean;
      message: string;
      session?: PaymentSession;
    }> => {
      if (!opts?.paymentMethod) {
        return { ok: false, gated: false, placed: false, message: 'Choose a payment method first.' };
      }
      await pushFoodNow(); // make sure the server has the exact desired cart
      try {
        const res = await fetch('/api/food-cart', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'place',
            addressId: selectedAddressIdRef.current,
            paymentMethod: opts.paymentMethod,
            intentApp: opts.intentApp,
            generateUPIQR: opts.generateUPIQR,
            noteToRestaurant: opts.noteToRestaurant,
            // the total the user saw when confirming (re-checked server-side)
            amount: opts.amount ?? foodCartRef.current.toPay,
          }),
        });
        if (res.status === 401) {
          return { ok: false, gated: false, placed: false, message: 'Your Swiggy session expired — please log in again.' };
        }
        const data = (await res.json().catch(() => ({}))) as Partial<FoodPlaceResult>;

        // Reconcile with Swiggy's cart as the server saw it.
        if (data.cart) {
          foodVersion.current += 1;
          setFoodCart(data.cart);
          foodDirtyRef.current = false;
        }
        if (data.paymentSession) {
          openPayment(data.paymentSession, paymentOptions || undefined);
        }

        return {
          ok: res.ok && data.ok === true,
          gated: Boolean(data.gated),
          placed: Boolean(data.placed),
          session: data.paymentSession,
          message:
            typeof data.message === 'string' && data.message
              ? data.message
              : 'Could not place the order. Please try again.',
        };
      } catch (err: unknown) {
        return {
          ok: false,
          gated: false,
          placed: false,
          message: (err instanceof Error && err.message) || 'Food checkout request failed. Please check your connection.',
        };
      }
    },
    [pushFoodNow, openPayment, paymentOptions],
  );

  // Running macros of the current food order, from captured agent estimates.
  const foodMacros = useMemo(
    () =>
      foodCart.items.reduce(
        (acc, it) => {
          const mc = macros[it.menuItemId];
          if (mc) {
            acc.kcal += mc.kcal * it.quantity;
            acc.protein += mc.protein * it.quantity;
          }
          return acc;
        },
        { kcal: 0, protein: 0 },
      ),
    [foodCart, macros],
  );

  /* ------------------------ chat ↔ open picker bridge ---------------------- */

  // Turns that already drove a picker (PICK) or opened a new card — the
  // deterministic client fallback only runs when neither happened.
  const turnPickedRef = useRef(new Set<string>());
  const turnCardsRef = useRef(new Map<string, 'scenes' | 'dineout' | 'other'>());
  // pickers opened by a TAP that still need their AI read once loaded
  const pickerReadRef = useRef(new Set<string>());
  // Plan tab: picker message id → the itinerary step it was opened for
  const pickerIntentRef = useRef(new Map<string, string>());

  // The latest message in the thread that holds a picker of `kind` (any if omitted).
  const latestPickerId = useCallback((kind?: 'scenes' | 'dineout'): string | null => {
    const msgs = messagesRef.current;
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i];
      if ((kind !== 'dineout' && m.scenesShows) || (kind !== 'scenes' && m.dineoutSlots)) return m.id;
    }
    return null;
  }, []);

  // The most recent picker of this tab's kind that is still open (not booked):
  // its live listing + selection go with the turn as `activePicker`.
  const findOpenPicker = useCallback(
    (svc: Service): ActivePicker | null => {
      if (svc !== 'scenes' && svc !== 'dineout' && svc !== 'plan') return null;
      const id = latestPickerId(svc === 'plan' ? undefined : svc);
      if (!id) return null;
      const msgs = messagesRef.current;
      const at = msgs.findIndex((m) => m.id === id);
      const kind = msgs[at]?.scenesShows ? 'scenes' : 'dineout';
      // a booking made after it (this app's tracker card) closes the picker
      if (msgs.slice(at + 1).some((m) => m.bookingTracker?.kind === kind)) return null;
      return pickerSnapshot(id);
    },
    [latestPickerId],
  );

  // A chat turn changed an older picker's selection → move the picker down into
  // that reply (so the user never scrolls back), carrying the current selection
  // forward; the old spot collapses to a one-line note. Same-message picks just apply.
  const movePickerTo = useCallback((fromId: string, toId: string, sel: PickerSelectFields) => {
    const msgs = messagesRef.current;
    const from = msgs.find((m) => m.id === fromId);
    const to = msgs.find((m) => m.id === toId);
    if (fromId === toId || !from || !to || to.role !== 'assistant' || to.dineoutSlots || to.scenesShows) {
      sendToPicker(fromId, sel);
      return;
    }
    const kind: 'dineout' | 'scenes' = from.scenesShows ? 'scenes' : 'dineout';
    const snap = pickerSnapshot(fromId);
    if (!snap) {
      // finished (booked / paying) or not mounted — leave it where it is
      sendToPicker(fromId, sel);
      return;
    }
    // what's already chosen, minus anything tied to a date the user just changed
    let base: PickerSelectFields = {};
    if (snap.kind === 'dineout') {
      const c = snap.selection ?? {};
      base = { guests: c.guests ?? snap.guests, date: c.date, time: c.time, deal: c.deal };
    } else {
      const c = snap.selection ?? {};
      base = { date: c.date, showId: c.showId, time: c.timeLabel, ticketName: c.ticketName, qty: c.qty };
    }
    if (sel.date && base.date && sel.date !== base.date) {
      base = { guests: base.guests, ticketName: base.ticketName, qty: base.qty };
    }
    const merged: PickerSelectFields = Object.fromEntries(
      Object.entries({ ...base, ...sel }).filter(([, v]) => v !== undefined && v !== ''),
    ) as PickerSelectFields;
    setMessages((prev) =>
      prev.map((m) => {
        if (m.id === fromId) return { ...m, dineoutSlots: undefined, scenesShows: undefined, pickerMoved: kind };
        if (m.id === toId) return kind === 'scenes' ? { ...m, scenesShows: from.scenesShows } : { ...m, dineoutSlots: from.dineoutSlots };
        return m;
      }),
    );
    turnCardsRef.current.set(toId, kind);
    // queued until the moved picker mounts and registers
    sendToPicker(toId, merged);
  }, []);

  // Route a pickerSelect / pickerReasons event to its picker: the named message,
  // else the picker this turn just opened, else the latest picker of that kind.
  const routePickerEvent = useCallback(
    (
      assistantId: string,
      ev: Extract<ChatStreamEvent, { type: 'pickerSelect' } | { type: 'pickerReasons' }>,
    ) => {
      const named = ev.messageId && messagesRef.current.some((m) => m.id === ev.messageId) ? ev.messageId : null;
      const id = named ?? (turnCardsRef.current.get(assistantId) === ev.target ? assistantId : latestPickerId(ev.target));
      if (!id) return;
      if (ev.type === 'pickerReasons') {
        sendReasons(id, ev.reasons);
        return;
      }
      const { type: _t, target: _k, messageId: _m, ...sel } = ev;
      void _t;
      void _k;
      void _m;
      movePickerTo(id, assistantId, sel);
    },
    [latestPickerId, movePickerTo],
  );

  /* -------------------------------- chat ---------------------------------- */

  // Apply one parsed stream event to the pending assistant message (or, for
  // best/healthy/warn marks, to whichever message actually shows the item).
  const applyEvent = useCallback((assistantId: string, ev: ChatStreamEvent) => {
    // Chat → open picker: select inside it (never books); not a message change.
    if (ev.type === 'pickerSelect' || ev.type === 'pickerReasons') {
      if (ev.type === 'pickerSelect') turnPickedRef.current.add(assistantId);
      routePickerEvent(assistantId, ev);
      return;
    }
    if (ev.type === 'scenesShows') turnCardsRef.current.set(assistantId, 'scenes');
    else if (ev.type === 'dineoutSlots') turnCardsRef.current.set(assistantId, 'dineout');
    else if (
      (ev.type === 'scenesEvents' && ev.events.length) ||
      ev.type === 'dineoutRestaurants' ||
      ev.type === 'products' ||
      ev.type === 'foodRestaurants'
    ) {
      if (!turnCardsRef.current.has(assistantId)) turnCardsRef.current.set(assistantId, 'other');
    }
    // Dynamic chips: hook-level quick chips AND inline clarify pills on the turn.
    if (ev.type === 'chips') {
      setDynamicSuggestions(ev.items);
      setMessages((prev) =>
        prev.map((m) => (m.id === assistantId ? { ...m, chips: ev.items, status: undefined } : m)),
      );
      return;
    }
    // Agent-driven ADD / REMOVE / swap. If the user EXPLICITLY asked ("add X",
    // "remove the tofu") the turn is 'direct' and we apply optimistically. If the
    // agent is acting on its own (a suggestion, a photo, a cook, a swap the user
    // is exploring) we PROPOSE it and wait for the user's Approve. Manual card
    // Add buttons never come through here, so they always apply directly.
    if (ev.type === 'addToCart' || ev.type === 'removeFromCart') {
      if (intentFor(assistantId) === 'direct') {
        if (ev.type === 'addToCart') {
          // remembered so a late DISHES/ingredient fallback doesn't add a 2nd item
          const turn = turnsRef.current.get(assistantId);
          if (turn) turn.hadAdd = true;
          addResolverRef.current(ev);
          const pid = ev.target === 'instamart' ? ev.line.spinId : ev.line.menuItemId;
          const name = ev.line.name;
          const imageUrl = 'imageUrl' in ev.line ? ev.line.imageUrl : undefined;
          const price = 'unitPrice' in ev.line ? ev.line.unitPrice : ev.line.price;
          setMessages((prev) =>
            prev.map((m) =>
              m.id === assistantId
                ? {
                    ...m,
                    proposals: [
                      ...(m.proposals ?? []).filter((p) => p.pid !== pid),
                      {
                        pid,
                        status: 'approved',
                        kind: 'add',
                        name,
                        imageUrl,
                        detail: `₹${price} · Added to cart`,
                      },
                    ],
                  }
                : m,
            ),
          );
        } else {
          removeResolverRef.current(ev.target, ev.id);
        }
      } else {
        proposeResolverRef.current(assistantId, ev);
      }
      return;
    }
    // Cross-restaurant dish search — fetched deterministically from /api/dishes.
    if (ev.type === 'dishQuery') {
      dishResolverRef.current(assistantId, ev.query);
      return;
    }
    // Cook ingredients — parallel-search each + propose the best pick (fast).
    if (ev.type === 'ingredients') {
      ingredientsResolverRef.current(assistantId, ev.items);
      return;
    }
    // Instamart AI basket — one card; the cart changes only on Approve all.
    if (ev.type === 'basket') {
      setMessages((prev) =>
        prev.map((m) => (m.id === assistantId ? { ...m, basket: ev.basket, status: undefined } : m)),
      );
      return;
    }
    // Universal chat control — change an app setting by talking.
    if (ev.type === 'control') {
      controlResolverRef.current(ev.action, ev.value);
      return;
    }
    // Agent-estimated nutrition — capture + persist for the MacroMeter.
    if (ev.type === 'macros') {
      setMacros((prev) => {
        const next = { ...prev };
        for (const it of ev.items) next[it.id] = { kcal: it.kcal, protein: it.protein };
        try {
          localStorage.setItem(MACROS_KEY, JSON.stringify(next));
        } catch {
          /* ignore */
        }
        return next;
      });
      return;
    }
    // Structured Compare verdict — attach to the current turn (the matrix itself
    // is already on the message from compareBest's snapshot).
    if (ev.type === 'comparison') {
      const notes: Record<string, string> = {};
      ev.notes?.forEach((n) => {
        notes[n.id] = n.note;
      });
      setMessages((prev) =>
        prev.map((m) =>
          m.id === assistantId
            ? {
                ...m,
                comparison: { winnerId: ev.winnerId, verdict: ev.verdict, notes },
                status: undefined,
              }
            : m,
        ),
      );
      return;
    }
    // Best / Healthier / Warn marks: route to whichever message contains the id
    // (so the badge lands on the original grid, not the empty follow-up bubble).
    if (ev.type === 'bestPick' || ev.type === 'healthyPick' || ev.type === 'warn') {
      let targetId = idIndexRef.current.get(ev.id);
      if (!targetId) {
        const msgs = messagesRef.current;
        for (let i = msgs.length - 1; i >= 0 && !targetId; i--) {
          const m = msgs[i];
          if (
            m.productGroups?.some((g) =>
              g.products.some((p) => p.variations.some((v) => v.spinId === ev.id)),
            ) ||
            m.suggestions?.some((p) => p.variations.some((v) => v.spinId === ev.id)) ||
            m.menu?.categories.some((c) => c.items.some((it) => it.id === ev.id)) ||
            m.dishGroups?.some((g) => g.dishes.some((d) => d.id === ev.id)) ||
            m.dineoutRestaurants?.some((r) => r.id === ev.id)
          ) {
            targetId = m.id;
          }
        }
      }
      targetId = targetId ?? assistantId;
      const field =
        ev.type === 'bestPick' ? 'bestPicks' : ev.type === 'healthyPick' ? 'healthyPicks' : 'warns';
      setMessages((prev) =>
        prev.map((m) => {
          if (m.id === targetId) {
            const cur = (m[field] as Record<string, string> | undefined) ?? {};
            const updated: ChatMessage = { ...m, [field]: { ...cur, [ev.id]: ev.reason } };
            if (m.id === assistantId) updated.status = undefined;
            return updated;
          }
          if (m.id === assistantId) return { ...m, status: undefined };
          return m;
        }),
      );
      return;
    }
    // Cook-with-me steps: persist to the recipe (for instant replay) + render.
    if (ev.type === 'steps') {
      const ctx = cookContextRef.current;
      if (ctx && ctx.mode === 'steps' && ctx.assistantId === assistantId) {
        updateRecipeByDish(ctx.dish, { steps: ev.steps });
        setRecipes(loadRecipes());
      }
      setMessages((prev) =>
        prev.map((m) => (m.id === assistantId ? { ...m, cookSteps: ev.steps, status: undefined } : m)),
      );
      return;
    }
    // Turn settled: persist any captured cook ingredients for deterministic reorder.
    if (ev.type === 'done') {
      // A swap turn ended without the agent producing a replacement ADD — drop
      // the pending swap so a later, unrelated add isn't treated as a replace.
      pendingSwapRef.current = null;
      // Chat-requested tab switch: open the new tab on its own fresh thread
      // (the current one is saved to history first) once this turn settles.
      const nextTab = pendingTabRef.current;
      pendingTabRef.current = null;
      if (nextTab && nextTab !== serviceRef.current) setTimeout(() => setService(nextTab), 0);
      const ctx = cookContextRef.current;
      if (ctx) {
        if (ctx.mode === 'cook') {
          // A cook now spans a clarify turn (asks preferences, no adds) then a
          // build turn (adds ingredients). Persist + end the session only once
          // ingredients were actually captured, so the clarify turn doesn't end
          // it early; otherwise keep the context alive for the build turn. While
          // ingredient searches are still in flight THEY persist when settled.
          if (ctx.ingredients.length && !ctx.inFlight) {
            updateRecipeByDish(ctx.dish, { ingredients: ctx.ingredients });
            setRecipes(loadRecipes());
            cookContextRef.current = null;
          }
        } else if (ctx.assistantId === assistantId) {
          // steps (single-turn) — clear when its own turn ends
          cookContextRef.current = null;
        }
      }
      setMessages((prev) =>
        prev.map((m) => (m.id === assistantId ? { ...m, pending: false, status: undefined } : m)),
      );
      return;
    }

    if (ev.type === 'paymentPrompt') {
      openPayment(ev.session, ev.options);
      return;
    }

    // Strict no-repeat rule: a card block whose items were ALL already shown in
    // an earlier message of this thread is not drawn again — the reply gets a
    // one-line "Shown above ↑" link to the earlier cards instead.
    const repeat = repeatedCards(messagesRef.current, assistantId, ev);
    if (repeat) {
      setMessages((prev) =>
        prev.map((m) =>
          m.id !== assistantId || m.shownAbove?.some((x) => x.messageId === repeat.messageId && x.label === repeat.label)
            ? m
            : { ...m, shownAbove: [...(m.shownAbove ?? []), repeat], status: undefined },
        ),
      );
      return;
    }

    // Register ids synchronously so a best/healthy/warn mark arriving later in
    // the SAME stream can be routed even before the messages effect reruns.
    if (ev.type === 'products' || ev.type === 'suggestions') {
      for (const p of ev.products) {
        for (const v of p.variations) idIndexRef.current.set(v.spinId, assistantId);
      }
    } else if (ev.type === 'menu') {
      for (const c of ev.categories) {
        for (const it of c.items) idIndexRef.current.set(it.id, assistantId);
      }
    }

    setMessages((prev) =>
      prev.map((m) => {
        if (m.id !== assistantId) return m;
        switch (ev.type) {
          case 'status':
            return { ...m, status: ev.label };
          case 'model':
            // which LLM answered — shown under the reply
            return { ...m, generatedBy: ev.info };
          case 'text':
            return { ...m, text: m.text + ev.delta, status: undefined };
          case 'products':
            return {
              ...m,
              productGroups: [
                ...(m.productGroups ?? []),
                { query: ev.query, products: ev.products, nextOffset: ev.nextOffset },
              ],
              status: undefined,
            };
          case 'suggestions':
            return { ...m, suggestions: ev.products, status: undefined };
          // Card lists MERGE within a turn (by id) instead of overwriting, so a
          // follow-up details/second search call can't collapse the list to one.
          case 'foodRestaurants':
            return {
              ...m,
              foodRestaurants: mergeById(m.foodRestaurants, ev.restaurants),
              status: undefined,
            };
          case 'menu':
            return {
              ...m,
              menu:
                m.menu && m.menu.restaurantId === ev.restaurantId
                  ? {
                      ...m.menu,
                      categories: [...m.menu.categories, ...ev.categories],
                      page: Math.max(m.menu.page ?? 1, ev.page ?? 1),
                      hasMore: ev.hasMore,
                      restaurant: m.menu.restaurant ?? ev.restaurant,
                      totalCategories: ev.totalCategories ?? m.menu.totalCategories,
                    }
                  : {
                      restaurantId: ev.restaurantId,
                      restaurantName: ev.restaurantName,
                      categories: ev.categories,
                      page: ev.page,
                      hasMore: ev.hasMore,
                      restaurant: ev.restaurant,
                      totalCategories: ev.totalCategories,
                    },
              status: undefined,
            };
          case 'foodMealPlan':
            // the agent's whole-order proposal — nothing is added until Approve
            return { ...m, foodMealPlan: { ...ev.plan, status: 'pending' }, status: undefined };
          case 'dineoutRestaurants':
            return {
              ...m,
              dineoutRestaurants: mergeById(m.dineoutRestaurants, ev.restaurants),
              // the latest search's total/next offset ("Load more" on the cards)
              dineoutPaging: ev.paging ?? m.dineoutPaging,
              status: undefined,
            };
          case 'dineoutSlots':
            return {
              ...m,
              dineoutSlots: {
                restaurantId: ev.restaurantId,
                restaurantName: ev.restaurantName,
                latitude: ev.latitude,
                longitude: ev.longitude,
                slots: ev.slots,
              },
              status: undefined,
            };
          case 'scenesEvents':
            return {
              ...m,
              scenesEvents: ev.events.length ? mergeById(m.scenesEvents, ev.events) : m.scenesEvents,
              scenesCollections: ev.collections?.length ? ev.collections : m.scenesCollections,
              status: undefined,
            };
          case 'scenesShows': {
            const { type: _t, ...listing } = ev;
            void _t;
            return { ...m, scenesShows: listing, status: undefined };
          }
          case 'orderHistory':
            return {
              ...m,
              orderHistory: { service: ev.service, orders: ev.orders },
              status: undefined,
            };
          case 'bookingTracker':
            return {
              ...m,
              bookingTracker: {
                kind: ev.kind,
                title: ev.title,
                status: ev.status,
                details: ev.details,
                orderId: ev.orderId,
              },
              status: undefined,
            };
          case 'tracker':
            return {
              ...m,
              tracker: {
                status: ev.status,
                eta: ev.eta,
                partner: ev.partner,
                items: ev.items,
                trackUrl: ev.trackUrl,
                progress: ev.progress,
                // which tracking route the card may poll live (LiveOrderTracker)
                service:
                  serviceRef.current === 'food' || serviceRef.current === 'instamart' ? serviceRef.current : undefined,
              },
              status: undefined,
            };
          case 'itinerary': {
            // Plan tab only (the server never sends it to a domain tab).
            if (serviceRef.current !== 'plan') return m;
            const { type: _t, ...itinerary } = ev;
            void _t;
            return { ...m, itinerary, status: undefined };
          }
          case 'handoff': {
            const { type: _t, ...h } = ev;
            void _t;
            if (h.service === serviceRef.current) return m;
            return {
              ...m,
              handoffs: [...(m.handoffs ?? []).filter((x) => x.service !== h.service), h],
              status: undefined,
            };
          }
          case 'error':
            console.error('[swiggy-chat] Stream error:', ev.message);
            // remember where the reply's real prose ends, so the error banner is
            // never fed back to the agent as conversation history (idempotent)
            if (!errorAtRef.current.has(m.id)) errorAtRef.current.set(m.id, m.text.length);
            return {
              ...m,
              text: m.text
                ? `${m.text}\n\n${ev.message || DEFAULT_NETWORK_ERROR}`
                : (ev.message || DEFAULT_NETWORK_ERROR),
              status: undefined,
            };
          default:
            return m;
        }
      }),
    );
  }, [openPayment, intentFor, setService, routePickerEvent]);

  // Build the recently-shown catalog so cross-turn / cross-restaurant ADD/BEST/
  // WARN ids resolve server-side.
  // Strictly per tab: Instamart sends products, Food sends dishes, Plan sends
  // both from its OWN thread (never a cart), Dineout / Scenes send nothing.
  const buildCatalog = useCallback((svc: Service): ChatCatalog => {
    const msgs = messagesRef.current.slice(-8);
    const catalog: ChatCatalog = {};
    if (svc === 'dineout' || svc === 'scenes') return catalog;
    if (svc === 'instamart' || svc === 'plan') {
      const products: Omit<CartLine, 'quantity'>[] = [];
      const seen = new Set<string>();
      const add = (p: Product) => {
        for (const v of p.variations) {
          if (seen.has(v.spinId)) continue;
          seen.add(v.spinId);
          products.push({
            spinId: v.spinId,
            ...(v.skuId ? { skuId: v.skuId } : {}),
            productId: p.productId,
            name: p.name,
            brand: p.brand,
            quantityDescription: v.quantityDescription,
            imageUrl: v.imageUrl,
            unitPrice: v.offerPrice,
            mrp: v.mrp,
            ...(v.maxQuantity ? { maxQuantity: v.maxQuantity } : {}),
            inStock: p.inStock && v.inStock,
          });
        }
      };
      // The cart's own lines first, so "one more of the milk" / an ADD by id of an
      // item that's in the cart (but not on screen any more) still resolves.
      // (kept outside the recent-items cap so a long session can't push them out).
      const cartLines: Omit<CartLine, 'quantity'>[] = (svc === 'instamart' ? cartRef.current.items : []).map((l) => ({
        spinId: l.spinId,
        ...(l.skuId ? { skuId: l.skuId } : {}),
        productId: l.productId,
        name: l.name,
        brand: l.brand,
        quantityDescription: l.quantityDescription,
        imageUrl: l.imageUrl,
        unitPrice: l.unitPrice,
        mrp: l.mrp,
      }));
      for (const l of cartLines) seen.add(l.spinId);
      for (const m of msgs) {
        m.productGroups?.forEach((g) => g.products.forEach(add));
        m.suggestions?.forEach(add);
      }
      const all = [...cartLines, ...products.slice(-80)];
      if (all.length) catalog.products = all;
    }
    if (svc === 'food' || svc === 'plan') {
      const dishes: NonNullable<ChatCatalog['dishes']> = [];
      const seen = new Set<string>();
      const add = (d: MenuItem, rid: string, rname: string) => {
        if (seen.has(d.id)) return;
        seen.add(d.id);
        dishes.push({
          restaurantId: rid || d.restaurantId,
          restaurantName: rname || d.restaurantName,
          line: { menuItemId: d.id, name: d.name, imageUrl: d.imageUrl, veg: d.veg, price: d.price },
        });
      };
      for (const m of msgs) {
        if (m.menu) {
          for (const c of m.menu.categories) {
            for (const it of c.items) add(it, m.menu.restaurantId, m.menu.restaurantName);
          }
        }
        m.dishGroups?.forEach((g) => g.dishes.forEach((d) => add(d, d.restaurantId, d.restaurantName)));
      }
      // The active food cart's own lines too (same reason as Instamart above).
      const fc = foodCartRef.current;
      const cartDishes: NonNullable<ChatCatalog['dishes']> =
        svc === 'food' && fc.restaurantId
          ? fc.items
              .filter((l) => !seen.has(l.menuItemId))
              .map((l) => ({
                restaurantId: fc.restaurantId ?? '',
                restaurantName: fc.restaurantName ?? '',
                line: { menuItemId: l.menuItemId, name: l.name, imageUrl: l.imageUrl, veg: l.veg, price: l.price },
              }))
          : [];
      const allDishes = [...cartDishes, ...dishes.slice(-80)];
      if (allDishes.length) catalog.dishes = allDishes;
    }
    return catalog;
  }, []);

  // Stream ONE assistant turn from /api/chat into `assistantId`, abortable via
  // `abortRef`. Shared by sendMessage (new turns) and regenerate (re-run in
  // place). On abort, the partial reply is kept and marked stopped.
  const streamAssistant = useCallback(
    (
      assistantId: string,
      message: string,
      activeService: Service,
      image: { mediaType: string; data: string } | undefined,
      history: { role: Role; text: string }[],
    ) => {
      const controller = new AbortController();
      abortRef.current = controller;
      activeTurnRef.current = assistantId;
      // Only the turn the UI is listening to may touch state (a tab switch / new
      // chat / openSession re-points activeTurnRef and aborts this one).
      const isLive = () => activeTurnRef.current === assistantId && !controller.signal.aborted;
      // The selected address's real coordinates + display line (Bengaluru only as
      // a last-resort fallback when the address carries no coordinates).
      const addr = addresses.find((a) => a.id === selectedAddressId);
      // the ticket / slot picker still open in this thread (live data + selection)
      const openPicker = findOpenPicker(activeService);
      turnPickedRef.current.delete(assistantId);
      turnCardsRef.current.delete(assistantId);
      // Deterministic safety net: the model didn't drive the open picker (no PICK,
      // no new cards — or it failed) → read the selection from the user's words.
      const pickFallback = () => {
        const picked = turnPickedRef.current.has(assistantId);
        const opened = turnCardsRef.current.has(assistantId);
        turnPickedRef.current.delete(assistantId);
        turnCardsRef.current.delete(assistantId);
        if (!openPicker || picked || opened) return;
        const sel = pickFromUserText(message, openPicker);
        if (sel) movePickerTo(openPicker.messageId, assistantId, sel);
      };
      (async () => {
        try {
          const res = await fetch('/api/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            signal: controller.signal,
            body: JSON.stringify({
              service: activeService,
              message,
              addressId: selectedAddressId,
              addressLine: addr?.addressLine || undefined,
              // the address's city centre; omitted when its city isn't known (the agent asks)
              latitude: typeof addr?.latitude === 'number' ? addr.latitude : undefined,
              longitude: typeof addr?.longitude === 'number' ? addr.longitude : undefined,
              city: addr?.city,
              preferences: preferencesRef.current.trim() || undefined,
              allergies: allergiesRef.current.trim() || undefined,
              budget: budgetRef.current > 0 ? budgetRef.current : undefined,
              kcalGoal: kcalGoalRef.current > 0 ? kcalGoalRef.current : undefined,
              proteinGoal: proteinGoalRef.current > 0 ? proteinGoalRef.current : undefined,
              image,
              history,
              catalog: buildCatalog(activeService),
              activePicker: openPicker ?? undefined,
              // order ids of Dineout / Scenes bookings made in this app, so the
              // agent can check them by id ("is my table confirmed?").
              knownBookings:
                activeService === 'dineout' || activeService === 'scenes' || activeService === 'plan'
                  ? loadBookings(userIdRef.current)
                      .filter((b) => activeService === 'plan' || b.kind === activeService)
                      .slice(0, 20)
                      .map((b) => ({ kind: b.kind, orderId: b.orderId, title: b.title }))
                  : undefined,
              // the active service's current cart, so the agent can remove /
              // replace lines by id ("remove the tofu", "swap X for Y"). Only the
              // two cart tabs have one — Dineout / Scenes / Plan never see a cart.
              cartLines:
                activeService === 'food'
                  ? foodCartRef.current.items.map((l) => ({
                      id: l.menuItemId,
                      name: l.name,
                      quantity: l.quantity,
                    }))
                  : activeService === 'instamart'
                    ? cartRef.current.items.map((l) => ({
                        id: l.spinId,
                        name: l.name,
                        quantity: l.quantity,
                      }))
                    : undefined,
            }),
          });
          if (!res.ok || !res.body) {
            // The route answers bad requests with an NDJSON `error` line — surface
            // that real message instead of a generic "chat 400".
            const body = await res.text().catch(() => '');
            let serverMsg = '';
            for (const l of body.split('\n')) {
              try {
                const ev = JSON.parse(l) as ChatStreamEvent;
                if (ev.type === 'error' && ev.message) {
                  serverMsg = ev.message;
                  break;
                }
              } catch {
                /* not JSON */
              }
            }
            if (serverMsg) {
              if (isLive()) applyEvent(assistantId, { type: 'error', message: serverMsg });
              if (isLive()) applyEvent(assistantId, { type: 'done' });
              if (isLive()) pickFallback();
              return;
            }
            throw new Error(`chat ${res.status}`);
          }

          const reader = res.body.getReader();
          const decoder = new TextDecoder();
          let buffer = '';

          const flushLine = (line: string) => {
            const trimmedLine = line.trim();
            if (!trimmedLine || !isLive()) return;
            let ev: ChatStreamEvent;
            try {
              ev = JSON.parse(trimmedLine) as ChatStreamEvent;
            } catch {
              return; // ignore a malformed line
            }
            // Applied OUTSIDE the parse try so a bug in a handler isn't swallowed.
            applyEvent(assistantId, ev);
          };

          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            let nl: number;
            while ((nl = buffer.indexOf('\n')) >= 0) {
              const line = buffer.slice(0, nl);
              buffer = buffer.slice(nl + 1);
              flushLine(line);
            }
          }
          // flush the decoder (a trailing multi-byte char) + the last partial line
          buffer += decoder.decode();
          flushLine(buffer);

          // Settle the pending flag even if no 'done' arrived. (A cook run's
          // ingredients are persisted by the ingredient resolver once ITS async
          // searches settle — they finish after the stream does.)
          if (isLive()) pickFallback();
          if (isLive()) {
            const ctx = cookContextRef.current;
            if (ctx && ctx.assistantId === assistantId && ctx.mode === 'steps') {
              cookContextRef.current = null;
            }
            setMessages((prev) =>
              prev.map((m) =>
                m.id === assistantId && (m.pending || m.status)
                  ? { ...m, pending: false, status: undefined }
                  : m,
              ),
            );
          }
        } catch (err: unknown) {
          // A thread reset already tore this turn down — nothing to report.
          if (activeTurnRef.current !== assistantId) return;
          // A user-initiated STOP isn't an error — keep the partial reply.
          const stopped = controller.signal.aborted;
          if (!stopped) pickFallback();
          const errMsg = err instanceof Error ? err.message : '';
          const networkErr = errMsg
            ? `### 🌐 Connection Error\n\n` +
              `**Exact Reason**: ${errMsg}\n\n` +
              `**Recommended Action**:\n` +
              `1. Check your internet connection and verify that the local dev server is active.\n` +
              `2. If this was a request timeout, the upstream model routing on the free tier may be experiencing traffic latency.\n\n` +
              `> 📢 **Provider Status Note**:\n` +
              `> *Because this system uses a free/shared provider routing tier, occasional edge connection fluctuations occur upstream and are not caused by your application code.*`
            : DEFAULT_NETWORK_ERROR;
          setMessages((prev) =>
            prev.map((m) => {
              if (m.id === assistantId && !stopped && !errorAtRef.current.has(m.id)) {
                errorAtRef.current.set(m.id, m.text.length);
              }
              return m.id === assistantId
                ? {
                    ...m,
                    pending: false,
                    status: undefined,
                    text: stopped
                      ? m.text && m.text.trim()
                        ? m.text
                        : '_Stopped._'
                      : m.text
                        ? `${m.text}\n\n${networkErr}`
                        : networkErr,
                  }
                : m;
            }),
          );
        } finally {
          // Only the CURRENT stream may unlock the composer — a stale stream
          // finishing late must not flip `sending` off under a newer turn.
          if (abortRef.current === controller) {
            abortRef.current = null;
            sendingRef.current = false;
            setSending(false);
          }
        }
      })();
    },
    [applyEvent, buildCatalog, selectedAddressId, addresses, findOpenPicker, movePickerTo],
  );

  // Approve every pending proposal on a message. The cart changes run HERE (an
  // event handler), never inside a setMessages updater — updaters must be pure
  // (StrictMode double-invokes them) and mustn't set other state mid-render.
  // Declared before sendMessage, which uses it for "approve all" chat commands.
  const approveAllProposals = useCallback((messageId: string) => {
    const msg = messagesRef.current.find((m) => m.id === messageId);
    const pids = (msg?.proposals ?? []).filter((p) => p.status === 'pending').map((p) => p.pid);
    if (!pids.length) return;
    const approved = new Set<string>();
    for (const pid of pids) {
      const apply = proposalActionsRef.current.get(pid);
      if (!apply) continue; // nothing to apply — leave a stale card as-is
      apply();
      proposalActionsRef.current.delete(pid);
      approved.add(pid);
    }
    if (!approved.size) return;
    setMessages((prev) =>
      prev.map((m) =>
        m.id !== messageId || !m.proposals
          ? m
          : {
              ...m,
              proposals: m.proposals.map((p) =>
                approved.has(p.pid) ? { ...p, status: 'approved' as const } : p,
              ),
            },
      ),
    );
  }, []);

  // Prior turns (oldest-first) sent to the agent as context: empties, "Stopped"
  // placeholders and any appended error banner are left out.
  const buildHistory = useCallback(
    (msgs: ChatMessage[]): { role: Role; text: string }[] =>
      msgs
        .map((m) => {
          const at = errorAtRef.current.get(m.id);
          const text = (at === undefined ? m.text : m.text.slice(0, at)).trim();
          return { role: m.role as Role, text: text === '_Stopped._' ? '' : text };
        })
        .filter((h) => h.text.length > 0)
        .slice(-HISTORY_TURNS),
    [],
  );

  // "My bookings" — Swiggy has no list tool, so list the bookings made in this
  // app and fetch each one's live status (get_booking_status /
  // get_event_booking_status) instead of asking the user for order ids.
  const showMyBookings = useCallback(
    async (text: string, svc: Service) => {
      const stamp = Date.now();
      const asstId = `bk-a-${stamp}`;
      setMessages((prev) => [
        ...prev,
        { id: `bk-u-${stamp}`, role: 'user', text, createdAt: stamp },
        {
          id: asstId,
          role: 'assistant',
          text: '',
          status: 'Checking your bookings with Swiggy…',
          pending: true,
          createdAt: stamp,
        },
      ]);
      const fill = (patch: Partial<ChatMessage>) =>
        setMessages((prev) =>
          prev.map((m) => (m.id === asstId ? { ...m, ...patch, pending: false, status: undefined } : m)),
        );
      const saved = loadBookings(userIdRef.current).filter((b) => svc === 'plan' || b.kind === svc);
      const what = svc === 'scenes' ? 'event tickets' : svc === 'dineout' ? 'table bookings' : 'bookings';
      const limit =
        "Swiggy doesn't let apps list your bookings — only check one by its order ID — so I can show the ones made here in Swizzo. Bookings made in the Swiggy app are in the Swiggy app.";
      if (!saved.length) {
        fill({
          text: `You haven't made any ${what} in Swizzo yet. ${limit}`,
          chips: svc === 'scenes' ? ['Comedy this weekend', 'Live music', "What's on tonight"] : ['Book a table tonight', 'Rooftop places', 'Buffet deals'],
        });
        return;
      }
      try {
        const res = await fetch('/api/bookings', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ items: saved.map((b) => ({ kind: b.kind, orderId: b.orderId })) }),
        });
        const data = (await res.json().catch(() => ({}))) as {
          ok?: boolean;
          message?: string;
          bookings?: { kind: 'dineout' | 'scenes'; orderId: string; ok: boolean; status?: string; title?: string; details?: string; error?: string }[];
        };
        if (!res.ok || !data.ok || !Array.isArray(data.bookings)) {
          fill({ text: `⚠️ ${data.message || "Couldn't reach Swiggy to check your bookings — please try again."}` });
          return;
        }
        const rows = data.bookings;
        const trackers = rows.map((r, i) => ({
          kind: r.kind,
          orderId: r.orderId,
          title: r.title || saved[i]?.title || (r.kind === 'dineout' ? 'Table booking' : 'Event tickets'),
          status: r.ok ? r.status || 'Unknown' : 'Unavailable',
          details: r.ok ? r.details || saved[i]?.details || '' : r.error || 'Swiggy could not return this booking.',
        }));
        const okCount = rows.filter((r) => r.ok).length;
        fill({
          text: `Here ${trackers.length === 1 ? 'is your booking' : `are your ${trackers.length} ${what}`} made in Swizzo, with live status from Swiggy${
            okCount < rows.length ? ` (${rows.length - okCount} couldn't be loaded right now)` : ''
          }. ${limit}`,
          bookingTrackers: trackers,
        });
      } catch {
        fill({ text: "⚠️ Couldn't reach Swiggy to check your bookings — please try again." });
      }
    },
    [],
  );

  const sendMessage = useCallback(
    (
      text: string,
      serviceOverride?: Service,
      image?: { mediaType: string; data: string },
      addIntent?: 'direct' | 'propose',
      displayText?: string,
      onStart?: (assistantId: string) => void,
    ) => {
      const trimmed = text.trim();
      if (!trimmed && !image) return;
      noteUserAsk(trimmed); // the user's stated needs → AI "Should I go?" / shortlists
      // A turn is already streaming — QUEUE this one instead of dropping it; the
      // drain effect fires it when the current turn settles.
      if (sendingRef.current) {
        queueRef.current = [
          ...queueRef.current,
          {
            qid: `q-${++qidRef.current}`,
            text: trimmed,
            serviceOverride,
            image,
            addIntent,
            displayText,
            onStart,
          },
        ];
        syncQueue();
        return;
      }
      // "my bookings / all my reservations / my tickets" → list the bookings made
      // here with live status (deterministic; no LLM round-trip).
      const turnService = serviceOverride ?? serviceRef.current;
      if (
        !image &&
        (turnService === 'dineout' || turnService === 'scenes' || turnService === 'plan') &&
        /\b(my|all)\b[^.?!]{0,25}\b(bookings?|reservations?|tickets?|passes)\b/i.test(trimmed) &&
        !/\b(book|reserve|buy)\s+(a|me|us|some|\d+)\b/i.test(trimmed)
      ) {
        void showMyBookings(trimmed, turnService);
        return;
      }
      // Direct apply only when the user explicitly commanded a cart change this
      // turn; otherwise agent ADDs/REMOVEs this turn are proposed for approval.
      // The Plan tab never changes a cart on its own: its picks are ALWAYS
      // Approve / Dismiss proposals, whatever the wording.
      const intent =
        (serviceOverride ?? serviceRef.current) === 'plan'
          ? 'propose'
          : (addIntent ?? (isExplicitCartCommand(trimmed) ? 'direct' : 'propose'));
      turnIntentRef.current = intent;
      // A turn for ANOTHER service starts that service's own thread (the current
      // one is saved to history first) — never mix services in one session.
      if (serviceOverride && serviceOverride !== serviceRef.current) {
        if (messagesRef.current.length) {
          resetThread();
          freshSession();
        }
        cookContextRef.current = null;
        setServiceState(serviceOverride);
        serviceRef.current = serviceOverride;
      }
      const activeService = serviceOverride ?? serviceRef.current;

      // 1. Intercept "Approve all" / "Approve all items" / "Add all items"
      const isApprovalAction =
        !image &&
        /^(?:approve\s+all(?:\s+items)?|add\s+all(?:\s+the)?(?:\s+required)?\s+items\.?|approve\s+items?|order\s+all(?:\s+the)?\s+ingredients\.?)$/i.test(
          trimmed,
        );
      if (isApprovalAction) {
        const pendingMsgs = messagesRef.current.filter((m) =>
          m.proposals?.some((p) => p.status === 'pending'),
        );
        if (pendingMsgs.length > 0) {
          for (const pm of pendingMsgs) {
            approveAllProposals(pm.id);
          }
          const userMsg: ChatMessage = {
            id: nextId(),
            role: 'user',
            createdAt: Date.now(),
            text: displayText || trimmed,
          };
          const confirmMsg: ChatMessage = {
            id: nextId(),
            role: 'assistant',
            createdAt: Date.now(),
            text: 'All items have been approved and added to your cart! 🛒 You can review them in your cart on the right or proceed to checkout.',
            chips: ['View cart', 'Checkout', 'Start cooking 🧑‍🍳'],
          };
          setMessages((prev) => [...prev, userMsg, confirmMsg]);
          return;
        }

        // If no pending proposals exist on screen, but a recipe dish was active:
        const activeDish = cookContextRef.current?.dish;
        if (activeDish) {
          const assistantId = nextId();
          lastAssistantIdRef.current = assistantId;
          const userMsg: ChatMessage = {
            id: nextId(),
            role: 'user',
            createdAt: Date.now(),
            text: displayText || trimmed,
          };
          const assistantMsg: ChatMessage = {
            id: assistantId,
            role: 'assistant',
            createdAt: Date.now(),
            text: `Adding all the essential ingredients for your ${activeDish} straight into your cart! 🛒`,
            chips: ['Start cooking 🧑‍🍳', 'View cart', 'Checkout'],
          };
          setMessages((prev) => [...prev, userMsg, assistantMsg]);
          turnIntentRef.current = 'direct';
          turnsRef.current.set(assistantId, { intent: 'direct', hadAdd: false });
          onStart?.(assistantId);
          ingredientsResolverRef.current(assistantId, getDishIngredients(activeDish));
          return;
        }
      }

      // Build history from the prior turns (oldest-first), excluding empties.
      const history = buildHistory(messagesRef.current);

      const now = Date.now();
      const userMsg: ChatMessage = {
        id: nextId(),
        role: 'user',
        createdAt: now,
        text: trimmed || '📷 Photo',
        ...(displayText ? { displayText } : {}),
        ...(image ? { image } : {}),
      };
      const assistantId = nextId();
      lastAssistantIdRef.current = assistantId;
      turnsRef.current.set(assistantId, { intent, hadAdd: false });
      userIntentRef.current.set(userMsg.id, intent);
      const assistantMsg: ChatMessage = {
        id: assistantId,
        role: 'assistant',
        createdAt: now,
        text: '',
        pending: true,
      };
      setMessages((prev) => [...prev, userMsg, assistantMsg]);
      // the ref flips NOW (not after commit) so a same-tick second send queues
      sendingRef.current = true;
      setSending(true);
      onStart?.(assistantId);

      // Deterministic Instamart order tracking — bypass the agent and hit
      // /api/orders directly (the agent often won't reliably call get_orders).
      const trackingIntent =
        activeService === 'instamart' &&
        !image &&
        /(track|where(?:'s| is)?)\b[^.?!]*\border|order status/i.test(trimmed);
      if (trackingIntent) {
        // Same lifecycle as a stream: abortable by STOP / thread reset, and only
        // the live turn may write state or unlock the composer.
        const controller = new AbortController();
        abortRef.current = controller;
        activeTurnRef.current = assistantId;
        const isLive = () => activeTurnRef.current === assistantId && !controller.signal.aborted;
        (async () => {
          try {
            const res = await fetch(
              `/api/orders?addressId=${encodeURIComponent(selectedAddressId)}`,
              { signal: controller.signal },
            );
            const data: {
              tracker: { status: string; eta?: string; partner?: string; items?: string } | null;
              summary?: string;
              error?: string;
              message?: string;
            } = await res.json().catch(() => ({ tracker: null }));
            if (!isLive()) return;
            if (!res.ok) {
              applyEvent(assistantId, {
                type: 'error',
                message: data.message || data.error || `Couldn't load your orders (${res.status}).`,
              });
            } else {
              if (data.summary) applyEvent(assistantId, { type: 'text', delta: data.summary });
              if (data.tracker) applyEvent(assistantId, { type: 'tracker', ...data.tracker });
            }
            applyEvent(assistantId, { type: 'done' });
          } catch (err: unknown) {
            if (activeTurnRef.current !== assistantId) return;
            if (controller.signal.aborted) {
              applyEvent(assistantId, { type: 'text', delta: '_Stopped._' });
            } else {
              applyEvent(assistantId, {
                type: 'error',
                message: err instanceof Error && err.message ? err.message : 'Order tracking failed.',
              });
            }
            applyEvent(assistantId, { type: 'done' });
          } finally {
            if (abortRef.current === controller) {
              abortRef.current = null;
              sendingRef.current = false;
              setSending(false);
            }
          }
        })();
        return;
      }

      streamAssistant(assistantId, trimmed, activeService, image, history);
    },
    [
      applyEvent,
      showMyBookings,
      approveAllProposals,
      buildHistory,
      freshSession,
      nextId,
      resetThread,
      selectedAddressId,
      streamAssistant,
      syncQueue,
    ],
  );

  // Keep the ref pointing at the latest sendMessage for the drain effect.
  sendMessageRef.current = sendMessage;

  // Drain the queue: when a turn settles (sending → false), fire the next queued
  // message. Keyed ONLY on `sending` so adding to the queue mid-turn doesn't
  // double-dispatch; the next item goes out the moment the current turn ends.
  useEffect(() => {
    if (sending) return;
    if (queueRef.current.length === 0) return;
    const next = queueRef.current[0];
    queueRef.current = queueRef.current.slice(1);
    syncQueue();
    sendMessageRef.current(
      next.text,
      next.serviceOverride,
      next.image,
      next.addIntent,
      next.displayText, // the short bubble label, not the raw instruction prompt
      next.onStart,
    );
  }, [sending, syncQueue]);

  const cancelQueued = useCallback(
    (qid: string) => {
      queueRef.current = queueRef.current.filter((q) => q.qid !== qid);
      syncQueue();
    },
    [syncQueue],
  );

  // Stop the in-flight assistant reply (abort the stream). The partial reply and
  // any cards it already produced are kept.
  const stop = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  // Unmount: abort the in-flight turn, cancel debounced cart syncs, save the
  // thread's latest state, and invalidate late async resolver results.
  useEffect(
    () => () => {
      flushPersist();
      abortRef.current?.abort();
      threadEpochRef.current += 1;
      if (cartSyncTimer.current) clearTimeout(cartSyncTimer.current);
      if (foodSyncTimer.current) clearTimeout(foodSyncTimer.current);
    },
    [flushPersist],
  );

  // "Try again": re-run a turn in place — drop the assistant reply (and anything
  // after it) and re-ask the user message that produced it, streaming fresh.
  const regenerate = useCallback(
    (assistantId: string) => {
      if (sendingRef.current) return;
      const msgs = messagesRef.current;
      const idx = msgs.findIndex((m) => m.id === assistantId);
      if (idx < 0) return;
      let uidx = idx - 1;
      while (uidx >= 0 && msgs[uidx].role !== 'user') uidx -= 1;
      if (uidx < 0) return;
      const userMsg = msgs[uidx];
      const activeService = serviceRef.current;
      const history = buildHistory(msgs.slice(0, uidx));
      // Replay the intent the turn was originally SENT with (cook = direct, deals
      // = propose, …); re-deriving it from the instruction text can flip it.
      const intent =
        userIntentRef.current.get(userMsg.id) ??
        (isExplicitCartCommand(userMsg.displayText ?? userMsg.text) ? 'direct' : 'propose');
      turnIntentRef.current = intent;
      cookContextRef.current = null;
      pendingSwapRef.current = null;
      // The replaced reply's (and later turns') un-approved proposals go away.
      for (const m of msgs.slice(idx)) {
        m.proposals?.forEach((p) => proposalActionsRef.current.delete(p.pid));
      }
      const newAssistantId = nextId();
      lastAssistantIdRef.current = newAssistantId;
      turnsRef.current.set(newAssistantId, { intent, hadAdd: false });
      setMessages((prev) => {
        const cut = prev.findIndex((m) => m.id === assistantId);
        const keep = cut < 0 ? prev : prev.slice(0, cut);
        return [
          ...keep,
          {
            id: newAssistantId,
            role: 'assistant' as Role,
            createdAt: Date.now(),
            text: '',
            pending: true,
          },
        ];
      });
      sendingRef.current = true;
      setSending(true);
      streamAssistant(newAssistantId, userMsg.text, activeService, userMsg.image, history);
    },
    [buildHistory, nextId, streamAssistant],
  );

  // "View menu" on a restaurant card: fetched straight from get_restaurant_menu
  // (/api/food-menu) — no model round-trip, so it's instant and always shows
  // Swiggy's real menu. Falls back to asking the agent if the route fails.
  const fetchMenuPage = useCallback(
    async (restaurantId: string, restaurantName: string, page: number) => {
      const res = await fetch(
        `/api/food-menu?restaurantId=${encodeURIComponent(restaurantId)}&addressId=${encodeURIComponent(
          selectedAddressIdRef.current,
        )}&page=${page}&restaurantName=${encodeURIComponent(restaurantName)}`,
      );
      if (res.status === 401) {
        setNeedsLogin(true);
        throw new Error('Your Swiggy session expired — please log in again.');
      }
      const data = (await res.json().catch(() => ({}))) as {
        restaurantId?: string;
        restaurantName?: string;
        isOpen?: boolean | null;
        categories?: MenuCategory[];
        page?: number;
        hasMore?: boolean;
        restaurant?: FoodRestaurant;
        totalCategories?: number;
        error?: string;
      };
      if (!res.ok) throw new Error(data.error || "Swiggy couldn't load this menu.");
      return data;
    },
    [],
  );

  const openMenu = useCallback(
    (r: FoodRestaurant) => {
      if (!selectedAddressIdRef.current) {
        sendMessage(`Show me the menu at ${r.name} (restaurantId ${r.id}).`, undefined, undefined, undefined, `View ${r.name}'s menu`);
        return;
      }
      const stamp = Date.now();
      const asstId = `menu-a-${stamp}`;
      setMessages((prev) => [
        ...prev,
        { id: `menu-u-${stamp}`, role: 'user', text: `View ${r.name}'s menu`, createdAt: stamp },
        { id: asstId, role: 'assistant', text: '', status: 'Checking the menu…', pending: true, createdAt: stamp },
      ]);
      const fill = (patch: Partial<ChatMessage>) =>
        setMessages((prev) =>
          prev.map((m) => (m.id === asstId ? { ...m, ...patch, pending: false, status: undefined } : m)),
        );
      (async () => {
        try {
          const data = await fetchMenuPage(r.id, r.name, 1);
          const categories = data.categories ?? [];
          for (const c of categories) for (const it of c.items) idIndexRef.current.set(it.id, asstId);
          const name = data.restaurantName || r.name;
          if (!categories.length) {
            fill({ text: `Swiggy returned no dishes for ${name} right now — it may be closed. Try another restaurant?` });
            return;
          }
          fill({
            text:
              data.isOpen === false
                ? `${name} is closed right now on Swiggy — here's its menu for later.`
                : `Here's ${name}'s menu from Swiggy. Tap Add on anything you like — customisable dishes ask for your choices first.`,
            menu: {
              restaurantId: r.id,
              restaurantName: name,
              categories,
              page: data.page ?? 1,
              hasMore: !!data.hasMore,
              // the card's search fields (distance, offer) + the menu's own header info
              restaurant: data.restaurant ? { ...r, ...data.restaurant, distanceKm: r.distanceKm, offer: r.offer } : r,
              totalCategories: data.totalCategories,
            },
            chips: [`Best dish at ${name}`, `Veg options at ${name}`, 'Show my cart'],
          });
        } catch (err) {
          fill({ text: `⚠️ ${err instanceof Error ? err.message : "Couldn't load the menu."}` });
        }
      })();
    },
    [fetchMenuPage, sendMessage],
  );

  // "More" on a restaurant menu: append the next category page in place.
  const loadMoreMenu = useCallback(
    (messageId: string) => {
      const msg = messagesRef.current.find((m) => m.id === messageId);
      const menu = msg?.menu;
      if (!menu || !menu.hasMore) return;
      const key = `menu:${messageId}`;
      setLoadingIds((prev) => ({ ...prev, [key]: true }));
      (async () => {
        try {
          const data = await fetchMenuPage(menu.restaurantId, menu.restaurantName, (menu.page ?? 1) + 1);
          const incoming = data.categories ?? [];
          for (const c of incoming) for (const it of c.items) idIndexRef.current.set(it.id, messageId);
          setMessages((prev) =>
            prev.map((m) =>
              m.id === messageId && m.menu
                ? {
                    ...m,
                    menu: {
                      ...m.menu,
                      categories: [...m.menu.categories, ...incoming],
                      page: data.page ?? (m.menu.page ?? 1) + 1,
                      hasMore: !!data.hasMore && incoming.length > 0,
                    },
                  }
                : m,
            ),
          );
        } catch {
          // keep what's shown; the button stays so the user can retry
        } finally {
          setLoadingIds((prev) => {
            const next = { ...prev };
            delete next[key];
            return next;
          });
        }
      })();
    },
    [fetchMenuPage],
  );

  // "More dishes" on a cross-restaurant dish search (search_menu nextOffset).
  const loadMoreDishes = useCallback((messageId: string, groupIndex: number) => {
    const group = messagesRef.current.find((m) => m.id === messageId)?.dishGroups?.[groupIndex];
    if (!group || group.nextOffset == null) return;
    const { query, nextOffset } = group;
    const key = `dish:${messageId}:${groupIndex}`;
    setLoadingIds((prev) => ({ ...prev, [key]: true }));
    (async () => {
      try {
        const res = await fetch(
          `/api/dishes?q=${encodeURIComponent(query)}&addressId=${encodeURIComponent(
            selectedAddressIdRef.current,
          )}&offset=${nextOffset}`,
        );
        if (res.status === 401) setNeedsLogin(true);
        if (!res.ok) return;
        const data = (await res.json()) as { dishes?: MenuItem[]; hasMore?: boolean; nextOffset?: number | null };
        const incoming = data.dishes ?? [];
        for (const d of incoming) idIndexRef.current.set(d.id, messageId);
        setMessages((prev) =>
          prev.map((m) => {
            if (m.id !== messageId || !m.dishGroups) return m;
            const groups = m.dishGroups.map((g, gi) => {
              if (gi !== groupIndex) return g;
              const seen = new Set(g.dishes.map((d) => `${d.restaurantId}:${d.id}`));
              const merged = [...g.dishes, ...incoming.filter((d) => !seen.has(`${d.restaurantId}:${d.id}`))];
              const more = data.hasMore && incoming.length > 0 ? data.nextOffset ?? null : null;
              return { ...g, dishes: merged, nextOffset: more };
            });
            return { ...m, dishGroups: groups };
          }),
        );
      } catch {
        // keep what's shown
      } finally {
        setLoadingIds((prev) => {
          const next = { ...prev };
          delete next[key];
          return next;
        });
      }
    })();
  }, []);

  const isLoadingMoreDishes = useCallback(
    (messageId: string, groupIndex: number) => Boolean(loadingIds[`dish:${messageId}:${groupIndex}`]),
    [loadingIds],
  );

  const isLoadingMoreMenu = useCallback(
    (messageId: string) => Boolean(loadingIds[`menu:${messageId}`]),
    [loadingIds],
  );

  /* ------------------------------- recipes -------------------------------- */

  // Cook a saved recipe: fresh Instamart chat that lists ingredients + picks AND
  // adds the best pick of each directly to the cart.
  const cookRecipe = useCallback(
    (dish: string) => {
      const ingredients = getDishIngredients(dish);
      const ingLine = ingredients.join(' | ');
      // Queues like any chip while a turn streams; the cook context binds to THIS
      // turn's assistant id when it actually starts.
      sendMessage(
        `I want to cook ${dish}. Immediately output on the FIRST line: "INGREDIENTS: ${ingLine}". Then in 1-2 sentences confirm the ingredients and provide quick cooking tips. End with SUGGESTIONS: Start cooking 🧑‍🍳 | Add basmati rice | Checkout.`,
        'instamart',
        undefined,
        'direct',
        `Order ingredients for ${dish}`,
        (assistantId) => {
          cookContextRef.current = { dish, assistantId, mode: 'cook', ingredients: [] };
        },
      );
    },
    [sendMessage],
  );

  // Step-by-step timed cooking guide (STEPS) for a dish — persisted to the recipe.
  const cookWithMe = useCallback(
    (dish: string) => {
      sendMessage(
        `Let's cook ${dish} together. FIRST emit the ingredient list as ONE line "INGREDIENTS: item1 | item2 | …" (1-3 words each) — do NOT search products yourself; the app finds + proposes the best pick of each in parallel. THEN walk me through it live — emit a STEPS block, one short practical step per line, with a timer in seconds on any step that needs timing (boil, simmer, rest, bake). Keep it concise.`,
        'instamart',
        undefined,
        'propose',
        `Cook with me — ${dish}`,
        (assistantId) => {
          cookContextRef.current = { dish, assistantId, mode: 'steps', ingredients: [] };
        },
      );
    },
    [sendMessage],
  );

  // One-tap reorder: rebuild the cart from the recipe's saved spinIds (instant);
  // the `set` sync reconciles live prices and the server drops anything OOS. If
  // the recipe has no captured ingredients yet, fall back to a real cook run.
  const reorderRecipe = useCallback(
    (recipe: Recipe) => {
      if (recipe.ingredients?.length) {
        if (serviceRef.current !== 'instamart') setService('instamart');
        const items: CartLine[] = recipe.ingredients.map((ing) => ({
          ...ing.line,
          quantity: Math.max(1, ing.quantity),
        }));
        setCartItems(items);
      } else {
        cookRecipe(recipe.dish);
      }
    },
    [setService, setCartItems, cookRecipe],
  );

  /* --------------------------- cart analysis turns ------------------------ */

  const analyzeCart = useCallback(() => {
    if (serviceRef.current === 'instamart') {
      const c = cartRef.current;
      if (!c.items.length) return;
      const total = parseRupees(c.bill?.total) || Math.round(c.subtotal);
      const list = c.items
        .map((i) => `${i.name} (${i.quantityDescription}) x${i.quantity} — ₹${i.unitPrice}`)
        .join('; ');
      sendMessage(
        `Analyse my cart for health and value (it totals about ₹${total}), then suggest better swaps or anything missing (search the top 1-2 so I can add them). Items: ${list}.`,
        undefined,
        undefined,
        undefined,
        'Analyse my cart',
      );
    } else {
      const c = foodCartRef.current;
      if (!c.items.length) return;
      const total = Math.round(c.toPay || c.itemTotal);
      const list = c.items.map((i) => `${i.name} x${i.quantity} — ₹${i.price}`).join('; ');
      sendMessage(
        `Analyse my food order for health (calories/balance) and value (it totals about ₹${total}), suggest lighter or better-value options, and emit a MACRO estimate per dish so my meter updates. Items: ${list}.`,
        undefined,
        undefined,
        undefined,
        'Analyse my order',
      );
    }
  }, [sendMessage]);

  const trimToFit = useCallback(() => {
    const b = budgetRef.current;
    if (b <= 0) return;
    if (serviceRef.current === 'instamart') {
      const c = cartRef.current;
      if (!c.items.length) return;
      const total = parseRupees(c.bill?.total) || Math.round(c.subtotal);
      const list = c.items.map((i) => `${i.name} x${i.quantity} — ₹${i.unitPrice}`).join('; ');
      sendMessage(
        `My budget is ₹${b} and my cart totals about ₹${total}. Suggest cheaper swaps to fit the budget and search the top 1-2 so I can add them. Cart: ${list}.`,
        undefined,
        undefined,
        undefined,
        'Trim to my budget',
      );
    } else {
      const c = foodCartRef.current;
      if (!c.items.length) return;
      const total = Math.round(c.toPay || c.itemTotal);
      const list = c.items.map((i) => `${i.name} x${i.quantity} — ₹${i.price}`).join('; ');
      sendMessage(
        `My budget is ₹${b} and my order totals about ₹${total}. Suggest cheaper options to fit the budget. Order: ${list}.`,
        undefined,
        undefined,
        undefined,
        'Trim to my budget',
      );
    }
  }, [sendMessage]);

  const nutritionReport = useCallback(() => {
    const bits: string[] = [];
    if (kcalGoalRef.current > 0) bits.push(`${kcalGoalRef.current} kcal`);
    if (proteinGoalRef.current > 0) bits.push(`${proteinGoalRef.current} g protein`);
    const goals = bits.length
      ? ` My daily goals are ${bits.join(' and ')} — tell me how this sits against them.`
      : '';
    if (serviceRef.current === 'instamart') {
      const c = cartRef.current;
      if (!c.items.length) return;
      const list = c.items.map((i) => `${i.name} (${i.quantityDescription}) x${i.quantity}`).join('; ');
      sendMessage(
        `Give me a nutrition report on my cart: estimate calories and protein per item and emit a MACRO line for each so my meter updates, then total it up.${goals} Items: ${list}.`,
        undefined,
        undefined,
        undefined,
        'Nutrition breakdown',
      );
    } else {
      const c = foodCartRef.current;
      if (!c.items.length) return;
      const list = c.items.map((i) => `${i.name} x${i.quantity}`).join('; ');
      sendMessage(
        `Give me a nutrition report on my food order: estimate calories and protein per dish and emit a MACRO line for each so my meter updates, then total it up.${goals} Items: ${list}.`,
        undefined,
        undefined,
        undefined,
        'Nutrition breakdown',
      );
    }
  }, [sendMessage]);

  const allergenSweep = useCallback(() => {
    const al = allergiesRef.current.trim();
    const against = al
      ? `my allergies / hard exclusions: ${al}`
      : `common allergens (nuts, dairy, gluten, shellfish, soy, egg)`;
    if (serviceRef.current === 'instamart') {
      const c = cartRef.current;
      if (!c.items.length) return;
      const list = c.items.map((i) => `${i.name} (${i.quantityDescription})`).join('; ');
      sendMessage(
        `Do a careful allergen safety pass over my cart against ${against}. For any risky item emit a WARN marker with the reason, and suggest a safe swap I can add. Items: ${list}.`,
        undefined,
        undefined,
        undefined,
        'Allergen sweep',
      );
    } else {
      const c = foodCartRef.current;
      if (!c.items.length) return;
      const list = c.items.map((i) => i.name).join('; ');
      sendMessage(
        `Do a careful allergen safety pass over my order against ${against}. For any risky item emit a WARN marker with the reason, and suggest a safe swap I can add. Items: ${list}.`,
        undefined,
        undefined,
        undefined,
        'Allergen sweep',
      );
    }
  }, [sendMessage]);

  // Instamart usuals refill: build the basket server-side from your_go_to_items
  // (+ get_orders for "last ordered"), AI pack per item, substitutes for the
  // out-of-stock ones — shown as ONE card; nothing is added until Approve all.
  const refillUsuals = useCallback(() => {
    const addressId = selectedAddressIdRef.current;
    if (!addressId) return;
    const stamp = Date.now();
    const userId = `refill-u-${stamp}`;
    const botId = `refill-a-${stamp}`;
    setMessages((prev) => [
      ...prev,
      { id: userId, role: 'user', text: 'Refill my usuals', createdAt: stamp },
      {
        id: botId,
        role: 'assistant',
        text: '',
        createdAt: stamp,
        pending: true,
        status: 'Building your usuals basket — picking the best pack for each…',
      },
    ]);
    void (async () => {
      let patch: Partial<ChatMessage>;
      try {
        const res = await fetch('/api/instamart/basket', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            addressId,
            fromUsuals: true,
            ...(budgetRef.current > 0 ? { budget: budgetRef.current } : {}),
          }),
        });
        if (res.status === 401) setNeedsLogin(true);
        const data = (await res.json().catch(() => ({}))) as { basket?: InstamartBasket; error?: string };
        const b = data.basket;
        if (b && (b.lines.length || b.missing?.length)) {
          const subs = b.lines.filter((l) => l.kind === 'substitute').length;
          patch = {
            basket: b,
            text:
              b.note ||
              `Here's your usual basket — ${b.lines.length} item${b.lines.length === 1 ? '' : 's'}, ₹${b.itemTotal} before fees${
                subs ? `, with ${subs} substitute${subs === 1 ? '' : 's'} for out-of-stock usuals` : ''
              }. Remove anything you don't need, then tap **Approve all**.`,
          };
        } else {
          patch = {
            text:
              data.error ||
              "I couldn't find any go-to items for this address yet — tell me what you need and I'll build the basket.",
          };
        }
      } catch {
        patch = { text: "I couldn't reach Instamart just now — try **Refill my usuals** again in a moment." };
      }
      setMessages((prev) =>
        prev.map((m) => (m.id === botId ? { ...m, ...patch, pending: false, status: undefined } : m)),
      );
    })();
  }, []);

  const orderUsuals = useCallback(() => {
    if (serviceRef.current === 'instamart') {
      refillUsuals();
    } else {

      sendMessage(
        `Look at my recent food orders and reorder my usual — find the dish(es) I order most and ADD them straight to my cart from the same restaurant when it's available.`,
        'food',
        undefined,
        undefined,
        'Reorder my usuals',
      );
    }
  }, [sendMessage, refillUsuals]);

  // Smart deal-hunter: surface the HEAVIEST current offers and propose adding the
  // best to the cart for the user's approval (proactive → 'propose' so the user
  // okays each deal). Respects budget/prefs which are sent with every turn.
  const findDeals = useCallback(() => {
    if (serviceRef.current === 'food') {
      sendMessage(
        `Hunt down the HEAVIEST deals in Food right now: search popular cravings (pizza, biryani, burgers, rolls, desserts) and surface the dishes with the biggest discounts/offers and the best coupon savings. In 2-3 lines call out the single best-value deal (compare a couple on real price + offer), mark it with BEST, then PROPOSE adding that best-value dish to my order for my approval. Keep it to genuinely heavy offers only.`,
        'food',
        undefined,
        'propose',
        'Find the best deals',
      );
    } else {
      sendMessage(
        `Hunt down the HEAVIEST deals right now: search everyday categories (snacks, dairy, staples, drinks, household, fruit) and surface the products with the biggest % off and rupee savings. In 2-3 lines compare the top 2-3 on real price-per-unit + discount, mark the single best-value deal with BEST, then PROPOSE adding the best 2-3 heavy-discount items to my cart for my approval. Only genuinely big discounts — skip thin offers.`,
        'instamart',
        undefined,
        'propose',
        'Find the best deals',
      );
    }
  }, [sendMessage]);

  // Smart Basket — goal-driven auto-builder. The user states a goal in plain
  // language ("a high-protein day under ₹600"); the agent PLANS a basket that
  // hits it, snaps the on-screen budget/macro meters to the target via CONTROL
  // markers, and emits the plan as ONE INGREDIENTS line. The existing parallel
  // ingredient search then finds the best-value product for each and PROPOSES
  // them for approval — so the whole shop is built, in budget, on the user's
  // say-so. The full instruction is hidden; the bubble shows just the goal.
  const smartBasket = useCallback(
    (goal: string) => {
      // (queues while a turn streams, like a chip — never silently dropped)
      const g = goal.trim();
      if (!g) return;
      sendMessage(
        `Build me a SMART BASKET of Instamart groceries for this goal: "${g}". Do these steps, in order, in ONE reply:\n` +
          `1) If the goal implies a rupee budget, a daily calorie target, or a protein target, FIRST emit the matching control markers on their own lines so my on-screen meters snap to the goal — "CONTROL: budget=<rupees>", "CONTROL: kcalGoal=<kcal>", "CONTROL: proteinGoal=<grams>". Only emit the ones the goal actually implies; infer sensible numbers when the goal is qualitative (e.g. "high-protein day" → proteinGoal≈120).\n` +
          `2) In 2-3 short lines, explain the basket you've planned and how it hits the goal. You MAY estimate ≈ kcal / ≈ g protein. Do NOT state a specific rupee total or claim it fits the budget — you can't see live prices; the app fills each item and shows the REAL running total against the budget meter. At most say you'll "aim to stay within budget".\n` +
          `3) Call build_basket ONCE with the planned shopping list (title, the budget, and each item as a concise search term with a realistic size or quantity). If there's a rupee budget, keep it TIGHT — 5 to 8 genuine ESSENTIALS only (no pricey extras like premium nut butters, packaged green tea, or dry fruits unless the goal asks), inexpensive everyday staples (e.g. "oats", "eggs", "bread", "bananas", "milk", "poha"). The app picks the best-value in-stock pack for each and shows ONE basket card with the real total vs budget.\n` +
          `4) End with a "SUGGESTIONS:" line offering a couple of one-tap refinements, e.g. "SUGGESTIONS: Make it higher-protein | Cheaper basket | Add more".\n` +
          `Keep it warm and concise.`,
        'instamart',
        undefined,
        'propose',
        `Smart basket · ${g}`,
      );
    },
    [sendMessage],
  );

  /* ------------------------------ load more ------------------------------- */

  const loadMore = useCallback(
    (messageId: string, groupIndex: number) => {
      const msg = messagesRef.current.find((m) => m.id === messageId);
      const group = msg?.productGroups?.[groupIndex];
      if (!group || !group.query || !group.nextOffset) return;
      const query = group.query;
      const offset = group.nextOffset;
      const key = `${messageId}:${groupIndex}`;

      setLoadingIds((prev) => ({ ...prev, [key]: true }));
      (async () => {
        try {
          const res = await fetch(
            `/api/search?addressId=${encodeURIComponent(selectedAddressId)}&query=${encodeURIComponent(
              query,
            )}&offset=${encodeURIComponent(offset)}`,
          );
          if (!res.ok) throw new Error(`search ${res.status}`);
          const data: { products?: Product[]; nextOffset?: string | null } = await res.json();
          const incoming = data.products ?? [];
          const newOffset = data.nextOffset ?? null;
          // Index the new ids so best/healthy/warn marks can route to them.
          for (const p of incoming) {
            for (const v of p.variations) idIndexRef.current.set(v.spinId, messageId);
          }

          setMessages((prev) =>
            prev.map((m) => {
              if (m.id !== messageId || !m.productGroups) return m;
              const groups = m.productGroups.map((g, gi) => {
                if (gi !== groupIndex) return g;
                const seen = new Set(g.products.map((p) => p.productId || p.variations[0]?.spinId));
                const merged = [...g.products];
                for (const p of incoming) {
                  const k = p.productId || p.variations[0]?.spinId;
                  if (k && seen.has(k)) continue;
                  if (k) seen.add(k);
                  merged.push(p);
                }
                return { ...g, products: merged, nextOffset: newOffset };
              });
              return { ...m, productGroups: groups };
            }),
          );
        } catch {
          // leave the existing products in place
        } finally {
          setLoadingIds((prev) => {
            const next = { ...prev };
            delete next[key];
            return next;
          });
        }
      })();
    },
    [selectedAddressId],
  );

  const isLoadingMore = useCallback(
    (messageId: string, groupIndex: number) => Boolean(loadingIds[`${messageId}:${groupIndex}`]),
    [loadingIds],
  );

  /* ------------------------------ checkout -------------------------------- */

  const checkout = useCallback(
    async (opts?: {
      paymentMethod?: string;
      intentApp?: string;
      generateUPIQR?: boolean;
      amount?: number;
    }): Promise<{
      ok: boolean;
      gated: boolean;
      message: string;
      session?: PaymentSession;
    }> => {
      // Validate against exactly what the user sees — and against what Swiggy
      // now holds (removed / capped / unserviceable items surface as warnings).
      const before = new Map(cartRef.current.items.map((l) => [l.spinId, l.quantity]));
      const pushed = await pushCartNow();
      if (!pushed) {
        return { ok: false, gated: false, message: "Couldn't sync your cart with Swiggy. Please try again." };
      }
      // The push may have moved the cart to this address (or Swiggy capped /
      // removed items): never place an order for a basket the user didn't review.
      const after = pushed.cart.items;
      if (
        pushed.ok &&
        after.length > 0 &&
        (after.length !== before.size || after.some((l) => before.get(l.spinId) !== l.quantity))
      ) {
        return {
          ok: false,
          gated: false,
          message: pushed.cart.warnings?.[0] || 'Swiggy updated your cart — please review it and check out again.',
        };
      }
      if (!pushed.ok || pushed.cart.items.length === 0) {
        return {
          ok: false,
          gated: false,
          message: pushed.cart.warnings?.[0] || 'Your Instamart cart is empty.',
        };
      }
      if (pushed.cart.unserviceable?.length || pushed.cart.items.some((l) => l.inStock === false)) {
        return { ok: false, gated: false, message: 'Remove the unavailable items before checking out.' };
      }

      // checkout's paymentMethod is the GROUP; a UPI app goes in intentApp and
      // scan-QR is generateUPIQR — never both.
      const method = opts?.paymentMethod;
      const isUpi = method === 'UPI';
      const intentApp = isUpi ? opts?.intentApp : undefined;
      const generateUPIQR = isUpi && !intentApp ? opts?.generateUPIQR === true : undefined;
      try {
        const res = await fetch('/api/checkout', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            addressId: selectedAddressIdRef.current,
            ...(method ? { paymentMethod: method } : {}),
            ...(intentApp ? { intentApp } : {}),
            ...(generateUPIQR ? { generateUPIQR: true } : {}),
          }),
        });
        const data: {
          placed?: boolean;
          gated?: boolean;
          ok?: boolean;
          message?: string;
          orderId?: string;
          paymentSession?: PaymentSession;
        } = await res.json().catch(() => ({}));

        if (data.paymentSession) {
          openPayment(data.paymentSession, paymentOptions || undefined);
        }
        if (data.placed) {
          // Swiggy has turned the cart into an order — drop our copy.
          cartVersion.current += 1;
          setCart(emptyCart(selectedAddressIdRef.current));
        }

        return {
          ok: res.ok && data.ok !== false,
          gated: Boolean(data.gated),
          session: data.paymentSession,
          message:
            (typeof data.message === 'string' && data.message) ||
            (res.status === 401 ? 'Your Swiggy session expired — please log in again.' : 'Checkout failed.'),
        };
      } catch {
        // We never got an answer: the order may or may not exist.
        return {
          ok: false,
          gated: false,
          message: "We couldn't confirm whether your order was placed. Check your recent orders before trying again.",
        };
      }
    },
    [pushCartNow, openPayment, paymentOptions],
  );

  /* -------------------------- agent-driven resolvers ---------------------- */

  // Fetch cross-restaurant dishes and append them to the assistant message.
  dishResolverRef.current = (assistantId, query) => {
    // The intent of THIS turn (captured now; the fetch settles after `done`).
    const intent = intentFor(assistantId);
    const appendNote = (note: string) =>
      setMessages((prev) =>
        prev.map((m) =>
          m.id === assistantId
            ? { ...m, text: m.text ? `${m.text}\n\n${note}` : note, status: undefined }
            : m,
        ),
      );
    fetch(
      `/api/dishes?q=${encodeURIComponent(query)}&addressId=${encodeURIComponent(selectedAddressId)}`,
    )
      .then(async (r) => {
        const data = (await r.json().catch(() => ({}))) as {
          query?: string;
          dishes?: MenuItem[];
          error?: string;
          hasMore?: boolean;
          nextOffset?: number | null;
          totalItems?: number;
        };
        return { ok: r.ok, data };
      })
      .then(({ ok, data }) => {
        if (!ok) {
          appendNote(data.error ? `Swiggy dish search failed: ${data.error}` : "Swiggy dish search failed — please try again.");
          return;
        }
        if (!data.dishes?.length) {
          appendNote(`I checked nearby restaurants on Swiggy, but couldn't find "${data.query || query}" on any active menus.`);
          return;
        }
        const dishes = data.dishes;
        for (const d of dishes) idIndexRef.current.set(d.id, assistantId);

        // An explicit "order X" with no ADD marker this turn: add the top
        // in-stock dish — unless it needs the user's variant / add-on choice.
        const turn = turnsRef.current.get(assistantId);
        const topDish = dishes.find((d) => d.inStock);
        let added = false;
        let held = false;
        if (intent === 'direct' && !turn?.hadAdd && topDish && !topDish.hasVariants && !topDish.hasAddons) {
          if (turn) turn.hadAdd = true;
          added = addFood(
            {
              menuItemId: topDish.id,
              name: topDish.name,
              price: topDish.price,
              veg: topDish.veg,
              imageUrl: topDish.imageUrl,
            },
            topDish.restaurantId,
            topDish.restaurantName,
            1,
          );
          held = !added;
        }

        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantId
              ? {
                  ...m,
                  dishGroups: [
                    ...(m.dishGroups ?? []),
                    {
                      query: data.query || query,
                      dishes,
                      nextOffset: data.hasMore ? data.nextOffset ?? null : null,
                      ...(data.totalItems ? { totalItems: data.totalItems } : {}),
                    },
                  ],
                  ...((added || held) && topDish
                    ? {
                        proposals: [
                          ...(m.proposals ?? []).filter((p) => p.pid !== topDish.id),
                          {
                            pid: topDish.id,
                            status: 'approved',
                            kind: 'add',
                            name: topDish.name,
                            imageUrl: topDish.imageUrl,
                            detail: added
                              ? `₹${topDish.price} · ${topDish.restaurantName} · Added to cart`
                              : `₹${topDish.price} · ${topDish.restaurantName} · Confirm the restaurant switch to add`,
                          },
                        ],
                      }
                    : {}),
                  status: undefined,
                }
              : m,
          ),
        );
      })
      .catch(() => {
        appendNote('Swiggy dish search failed — please try again.');
      });
  };

  // Cook: search EVERY ingredient in parallel, append a grid for each, and
  // propose the top pick (approval-gated) — the basket builds fast, not one
  // ingredient per agent turn.
  // Apply a CONTROL marker to real app state (the "ultimate" chat control).
  controlResolverRef.current = (action, value) => {
    const a = action.toLowerCase().replace(/[\s_-]/g, '');
    const num = () => Math.max(0, Math.round(Number(value) || 0));
    switch (a) {
      case 'kcalgoal':
      case 'caloriegoal':
      case 'calories':
        setMacroGoals(num(), proteinGoalRef.current);
        break;
      case 'proteingoal':
      case 'protein':
        setMacroGoals(kcalGoalRef.current, num());
        break;
      case 'macrogoals': {
        // value like "2000,120" or "2000 kcal 120 g"
        const nums = (value ?? '').match(/\d+/g) ?? [];
        if (nums.length >= 1) {
          setMacroGoals(
            Number(nums[0]) || kcalGoalRef.current,
            Number(nums[1]) || proteinGoalRef.current,
          );
        }
        break;
      }
      case 'budget':
        setBudget(num());
        break;
      case 'allergies':
      case 'allergy':
        setAllergies(value ?? '');
        break;
      case 'preferences':
      case 'preference':
      case 'diet':
        setPreferences(value ?? '');
        break;
      case 'theme': {
        const dark = (value ?? '').toLowerCase().includes('dark');
        const theme = dark ? 'dark' : 'light';
        try {
          document.documentElement.dataset.theme = theme;
          localStorage.setItem('swiggy-theme', theme);
          // let the ThemeToggle (own state) follow a chat-driven change
          window.dispatchEvent(new CustomEvent('swiggy-theme-change', { detail: theme }));
        } catch {
          /* ignore */
        }
        break;
      }
      case 'service': {
        // This marker arrives mid-stream: switching now would either wipe the
        // reply that asked for it or carry this tab's thread into the next tab.
        // Remember it; the turn's `done` switches tabs with a fresh thread.
        const v = (value ?? '').toLowerCase();
        const s: Service | undefined =
          SERVICES.find((x) => v.includes(x)) ?? (v.includes('grocer') ? 'instamart' : undefined);
        if (s && s !== serviceRef.current) pendingTabRef.current = s;
        break;
      }
      case 'clearcart':
        // Only a cart tab may clear its own cart (never from Dineout / Scenes / Plan).
        if (serviceRef.current === 'food') clearFoodCart();
        else if (serviceRef.current === 'instamart') clearCart();
        break;
      default:
        break;
    }
  };

  ingredientsResolverRef.current = (assistantId, items) => {
    const addr = selectedAddressIdRef.current;
    // Everything this turn needs is captured NOW: these searches settle after
    // `done` (often after the next queued turn began), so reading the global
    // intent / cook context later would apply the wrong turn's rules.
    const intent = intentFor(assistantId);
    const epoch = threadEpochRef.current;
    const cook =
      cookContextRef.current && cookContextRef.current.mode === 'cook' ? cookContextRef.current : null;
    if (cook) cook.inFlight = (cook.inFlight ?? 0) + 1;
    const jobs = items.slice(0, 14).map((ing) =>
      fetch(
        `/api/search?addressId=${encodeURIComponent(addr)}&query=${encodeURIComponent(ing)}`,
      )
        .then((r) => (r.ok ? r.json() : null))
        .then((data: { products?: Product[]; nextOffset?: string | null } | null) => {
          // the thread was reset (tab switch / new chat) — don't touch the cart
          if (!data || threadEpochRef.current !== epoch) return;
          const products = data.products ?? [];
          if (!products.length) return;
          setMessages((prev) =>
            prev.map((m) =>
              m.id === assistantId
                ? {
                    ...m,
                    productGroups: [
                      ...(m.productGroups ?? []),
                      { query: ing, products, nextOffset: data.nextOffset ?? null },
                    ],
                    status: undefined,
                  }
                : m,
            ),
          );
          // Propose the best-VALUE pick of this ingredient: among results that
          // actually match it, the best price per unit (shared AI pack choice —
          // sponsored listings skipped unless nothing else fits).
          const ranked = rankProducts(ing, products);
          let best: { p: Product; v: Variation } | null = ranked.pick
            ? { p: ranked.pick.product, v: ranked.pick.variation }
            : null;
          if (!best) {
            const p0 = products[0];
            const v0 = p0?.variations?.[0];
            if (v0) best = { p: p0, v: v0 };
          }
          if (best) {
            const { p, v } = best;
            const line: Omit<CartLine, 'quantity'> = {
              spinId: v.spinId,
              ...(v.skuId ? { skuId: v.skuId } : {}),
              productId: p.productId,
              name: p.name,
              brand: p.brand,
              quantityDescription: v.quantityDescription,
              imageUrl: v.imageUrl,
              unitPrice: v.offerPrice,
              mrp: v.mrp,
              ...(v.maxQuantity ? { maxQuantity: v.maxQuantity } : {}),
              inStock: p.inStock && v.inStock,
            };
            if (intent === 'direct') {
              const capturedByResolver = cookContextRef.current === cook && cook !== null;
              addResolverRef.current({
                type: 'addToCart',
                target: 'instamart',
                quantity: 1,
                line,
              });
              // addResolver captures into the LIVE cook context; if that was
              // already cleared, record the pick on this run's own context.
              if (cook && !capturedByResolver) {
                cook.ingredients.push({ spinId: line.spinId, line, quantity: 1 });
              }
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === assistantId
                    ? {
                        ...m,
                        proposals: [
                          ...(m.proposals ?? []).filter((p) => p.pid !== v.spinId),
                          {
                            pid: v.spinId,
                            status: 'approved',
                            kind: 'add',
                            name: p.name,
                            imageUrl: v.imageUrl,
                            detail: `₹${v.offerPrice} · ${v.quantityDescription}`,
                          },
                        ],
                      }
                    : m,
                ),
              );
            } else {
              proposeResolverRef.current(assistantId, {
                type: 'addToCart',
                target: 'instamart',
                quantity: 1,
                line,
              });
            }
          }
        })
        .catch(() => {
          /* ignore one ingredient's failure */
        }),
    );
    // Persist the cook run's resolved picks once EVERY search has settled (the
    // stream's `done` arrives long before), for a deterministic one-tap reorder.
    void Promise.allSettled(jobs).then(() => {
      if (!cook) return;
      cook.inFlight = Math.max(0, (cook.inFlight ?? 1) - 1);
      if (cook.inFlight > 0 || !cook.ingredients.length) return;
      const unique = [...new Map(cook.ingredients.map((i) => [i.spinId, i] as const)).values()];
      updateRecipeByDish(cook.dish, { ingredients: unique });
      setRecipes(loadRecipes());
      if (cookContextRef.current === cook) cookContextRef.current = null;
    });
  };

  // Agent-resolved add to cart — OPTIMISTIC, same as a manual Add, and it
  // captures ingredients during a cook run for deterministic reorder.
  addResolverRef.current = (ev) => {
    // SWAP: if the user asked to replace a cart line this turn, the agent's first
    // ADD is the chosen replacement — drop the old line and add the new one at the
    // old quantity (instead of a plain add). One swap per pending request.
    const pending = pendingSwapRef.current;
    if (pending && pending.kind === ev.target) {
      pendingSwapRef.current = null;
      const qty = pending.quantity || ev.quantity;
      if (ev.target === 'instamart') {
        applyCart((items) => [
          ...items.filter((x) => x.spinId !== pending.id && x.spinId !== ev.line.spinId),
          { ...ev.line, quantity: qty },
        ]);
      } else {
        applyFood((prev) => ({
          items: [
            ...prev.items.filter(
              (x) => x.menuItemId !== pending.id && x.menuItemId !== ev.line.menuItemId,
            ),
            { ...ev.line, quantity: qty },
          ],
          restaurantId: prev.restaurantId ?? ev.restaurantId,
          restaurantName: prev.restaurantName ?? ev.restaurantName,
        }));
      }
      return;
    }

    if (ev.target === 'instamart') {
      addLine(ev.line, ev.quantity);
      const ctx = cookContextRef.current;
      if (ctx && ctx.mode === 'cook') {
        ctx.ingredients.push({ spinId: ev.line.spinId, line: ev.line, quantity: ev.quantity });
      }
    } else {
      addFood(ev.line, ev.restaurantId, ev.restaurantName, ev.quantity);
    }
  };

  // Agent-driven REMOVE — drop the line by id, optimistically.
  removeResolverRef.current = (target, id) => {
    if (target === 'food') {
      applyFood((prev) => ({
        items: prev.items.filter((x) => x.menuItemId !== id),
        restaurantId: prev.restaurantId,
        restaurantName: prev.restaurantName,
      }));
    } else {
      applyCart((items) => items.filter((x) => x.spinId !== id));
    }
  };

  // Turn an agent ADD/REMOVE/swap into an APPROVAL proposal on the message (the
  // cart is only touched when the user taps Approve). The apply closure is stashed
  // by pid; a swap snapshots its pending target NOW (so it survives the turn end).
  proposeResolverRef.current = (assistantId, ev) => {
    // Scoped to the turn: a bare counter restarts at 0 on reload, so a new card's
    // "p-1" collided with a restored card's "p-1" and approved the wrong item.
    const pid = `${assistantId}:p${++pidRef.current}`;
    let proposal: CartProposal;
    let apply: () => void;

    if (ev.type === 'removeFromCart') {
      const name =
        ev.target === 'food'
          ? foodCartRef.current.items.find((i) => i.menuItemId === ev.id)?.name ?? 'this item'
          : cartRef.current.items.find((i) => i.spinId === ev.id)?.name ?? 'this item';
      proposal = { pid, status: 'pending', kind: 'remove', name, detail: 'Remove from cart', target: ev.target };
      apply = () => removeResolverRef.current(ev.target, ev.id);
    } else {
      const pending = pendingSwapRef.current;
      const swap = pending && pending.kind === ev.target ? pending : null;
      if (swap) pendingSwapRef.current = null; // consume now; applied on approve
      const price = ev.target === 'instamart' ? ev.line.unitPrice : ev.line.price;
      proposal = {
        pid,
        status: 'pending',
        kind: swap ? 'swap' : 'add',
        target: ev.target,
        name: ev.line.name,
        imageUrl: ev.line.imageUrl,
        detail: swap ? `replaces ${swap.name}` : `Add · ₹${Math.round(price)}`,
      };
      apply = () => {
        if (swap) {
          const qty = swap.quantity || ev.quantity;
          if (ev.target === 'instamart') {
            applyCart((items) => [
              ...items.filter((x) => x.spinId !== swap.id && x.spinId !== ev.line.spinId),
              { ...ev.line, quantity: qty },
            ]);
          } else {
            applyFood((prev) => ({
              items: [
                ...prev.items.filter(
                  (x) => x.menuItemId !== swap.id && x.menuItemId !== ev.line.menuItemId,
                ),
                { ...ev.line, quantity: qty },
              ],
              restaurantId: prev.restaurantId ?? ev.restaurantId,
              restaurantName: prev.restaurantName ?? ev.restaurantName,
            }));
          }
        } else {
          addResolverRef.current(ev);
        }
      };
    }

    proposalActionsRef.current.set(pid, apply);
    setMessages((prev) =>
      prev.map((m) =>
        m.id === assistantId ? { ...m, proposals: [...(m.proposals ?? []), proposal] } : m,
      ),
    );
  };

  /* ----------------------------- proposals -------------------------------- */

  const setProposalStatus = useCallback(
    (messageId: string, pid: string, status: 'approved' | 'dismissed') => {
      setMessages((prev) =>
        prev.map((m) =>
          m.id === messageId && m.proposals
            ? {
                ...m,
                proposals: m.proposals.map((p) => (p.pid === pid ? { ...p, status } : p)),
              }
            : m,
        ),
      );
    },
    [],
  );

  const approveProposal = useCallback(
    (messageId: string, pid: string) => {
      const apply = proposalActionsRef.current.get(pid);
      // No apply() means it already ran (double tap) or didn't survive a reload —
      // never flip the card to "approved" when nothing was added.
      if (!apply) return;
      apply();
      proposalActionsRef.current.delete(pid);
      setProposalStatus(messageId, pid, 'approved');
    },
    [setProposalStatus],
  );

  const dismissProposal = useCallback(
    (messageId: string, pid: string) => {
      proposalActionsRef.current.delete(pid);
      setProposalStatus(messageId, pid, 'dismissed');
    },
    [setProposalStatus],
  );

  // (approveAllProposals is declared above sendMessage, which uses it.)

  /* ------------------------- instamart AI basket -------------------------- */

  // Approve all on a basket card: add every line the user kept (their swaps
  // applied) in ONE optimistic cart change → one coalesced update_cart. Per-
  // order caps are respected; Swiggy's own notices come back on the cart.
  const basketAction = useCallback(
    (
      messageId: string,
      action: { type: 'approve'; removed: string[]; chosen: Record<string, number> } | { type: 'dismiss' },
    ) => {
      const msg = messagesRef.current.find((m) => m.id === messageId);
      const b = msg?.basket;
      if (!b || b.status === 'approved') return;
      if (action.type === 'approve') {
        const picks = approvedLines({ ...b, removed: action.removed, chosen: action.chosen });
        if (!picks.length) return;
        applyCart((items) => {
          const out = items.slice();
          for (const { line, quantity } of picks) {
            const max = line.maxQuantity && line.maxQuantity > 0 ? line.maxQuantity : Infinity;
            const i = out.findIndex((x) => x.spinId === line.spinId);
            if (i >= 0) out[i] = { ...out[i], quantity: Math.min(out[i].quantity + quantity, out[i].maxQuantity ?? max) };
            else out.push({ ...line, quantity: Math.min(quantity, max) });
          }
          return out;
        });
      }
      setMessages((prev) =>
        prev.map((m) =>
          m.id === messageId && m.basket
            ? {
                ...m,
                basket: {
                  ...m.basket,
                  status: action.type === 'approve' ? 'approved' : 'dismissed',
                  ...(action.type === 'approve' ? { removed: action.removed, chosen: action.chosen } : {}),
                },
              }
            : m,
        ),
      );
    },
    [applyCart],
  );

  // Swap one cart line for another at the same quantity (cart-review substitute).
  const replaceCartLine = useCallback(
    (oldSpinId: string, line: Omit<CartLine, 'quantity'>, quantity: number) => {
      const max = line.maxQuantity && line.maxQuantity > 0 ? line.maxQuantity : Infinity;
      applyCart((items) => [
        ...items.filter((x) => x.spinId !== oldSpinId && x.spinId !== line.spinId),
        { ...line, quantity: Math.max(1, Math.min(quantity, max)) },
      ]);
    },
    [applyCart],
  );

  /* ------------------------------- compare -------------------------------- */

  const toggleCompare = useCallback((product: Product, variation: Variation) => {
    setCompareItems((prev) => {
      if (prev.some((c) => c.spinId === variation.spinId)) {
        return prev.filter((c) => c.spinId !== variation.spinId);
      }
      return [
        ...prev,
        {
          productId: product.productId,
          spinId: variation.spinId,
          name: product.name,
          brand: product.brand,
          quantityDescription: variation.quantityDescription,
          imageUrl: variation.imageUrl,
          offerPrice: variation.offerPrice,
          mrp: variation.mrp,
          kind: 'instamart',
        },
      ];
    });
  }, []);

  const toggleCompareFood = useCallback((item: MenuItem) => {
    setCompareItems((prev) => {
      if (prev.some((c) => c.spinId === item.id)) {
        return prev.filter((c) => c.spinId !== item.id);
      }
      return [
        ...prev,
        {
          productId: item.id,
          spinId: item.id, // for food items this is the menuItemId
          name: item.name,
          brand: item.restaurantName || '',
          quantityDescription: item.veg ? 'Veg' : 'Non-veg',
          imageUrl: item.imageUrl,
          offerPrice: item.price,
          mrp: item.price,
          kind: 'food',
          veg: item.veg,
          restaurantId: item.restaurantId,
          restaurantName: item.restaurantName,
        },
      ];
    });
  }, []);

  const isSelectedForCompare = useCallback(
    (spinId: string) => compareItems.some((c) => c.spinId === spinId),
    [compareItems],
  );

  const clearCompare = useCallback(() => setCompareItems([]), []);

  // Fixed mid-stream race: guard BEFORE mutating, snapshot the selection onto the
  // new turn so the Compare matrix renders, then clear AFTER dispatch (so a
  // streaming no-op can never swallow the user's selection + question).
  const compareBest = useCallback(
    (question?: string) => {
      const items = compareItemsRef.current;
      if (items.length === 0) return;
      const lines = items
        .map(
          (c, i) =>
            `${i + 1}) ${c.name} (${c.quantityDescription}) [id: ${c.spinId}] — ₹${c.offerPrice}${
              c.mrp > c.offerPrice ? ` [MRP ₹${c.mrp}]` : ''
            }`,
        )
        .join('; ');
      const q = question?.trim();
      const msg = q
        ? `About these items: ${q} — emit a COMPARE verdict (winner id + one-line why) plus a short NOTE per item, then answer in prose. Items: ${lines}.`
        : items.length === 1
          ? `Is this a good buy, and what should I know? Emit a COMPARE verdict. ${lines}.`
          : `Compare these and recommend the single best value — emit a COMPARE verdict (winner id + one-line why) plus a short NOTE per item. Items: ${lines}.`;
      const snapshot = items.slice();
      const label = q
        ? q
        : items.length === 1
          ? `Is "${items[0].name}" a good buy?`
          : `Compare ${items.length} items`;
      // The snapshot attaches to THIS turn when it starts (it may queue behind a
      // streaming one), so the Compare matrix always lands on the right bubble.
      sendMessage(msg, undefined, undefined, undefined, label, (aid) => {
        setMessages((prev) =>
          prev.map((m) => (m.id === aid ? { ...m, compareItems: snapshot } : m)),
        );
      });
      setCompareItems([]);
    },
    [sendMessage],
  );

  // "Add winner to cart" on the Compare card — routes to the right cart by kind.
  const addCompareWinner = useCallback(
    (item: CompareItem) => {
      if (item.kind === 'food') {
        const line: Omit<FoodCartLine, 'quantity'> = {
          menuItemId: item.spinId,
          name: item.name,
          imageUrl: item.imageUrl,
          veg: item.veg ?? true,
          price: item.offerPrice,
        };
        addFood(line, item.restaurantId ?? '', item.restaurantName ?? '', 1);
      } else {
        const line: Omit<CartLine, 'quantity'> = {
          spinId: item.spinId,
          productId: item.productId,
          name: item.name,
          brand: item.brand,
          quantityDescription: item.quantityDescription,
          imageUrl: item.imageUrl,
          unitPrice: item.offerPrice,
          mrp: item.mrp,
        };
        addLine(line, 1);
      }
    },
    [addFood, addLine],
  );

  /* --------------------------------- swap --------------------------------- */

  const selectSwap = useCallback((item: SwapItem) => setSwapItem(item), []);
  const clearSwap = useCallback(() => setSwapItem(null), []);

  // "Change THIS cart line to X." Mark the pending swap (so this turn's ADD
  // replaces it), then ask the agent — in the user's own words — for the
  // alternative. The agent searches and ADDs the best match; addResolver swaps it.
  const requestSwap = useCallback(
    (text: string) => {
      const item = swapItem;
      if (!item) return;
      setSwapItem(null);
      const want = text.trim() || 'a better-value alternative';
      // Arm the swap only when THIS turn starts — armed earlier, a still-
      // streaming turn's ADD would consume it as a replace.
      const arm = () => {
        pendingSwapRef.current = item;
      };
      if (item.kind === 'food') {
        sendMessage(
          `Swap a dish already in my order: replace "${item.name}"${
            item.restaurantName ? ` from ${item.restaurantName}` : ''
          } with ${want}. Find the single best match${
            item.restaurantName ? ` at ${item.restaurantName}` : ''
          } and ADD it (emit its ADD line). Add only that one replacement.`,
          'food',
          undefined,
          'propose',
          `Change "${item.name}" → ${want}`,
          arm,
        );
      } else {
        sendMessage(
          `Swap an item already in my cart: replace "${item.name}" with ${want}. Search and ADD the single best match (emit its ADD line). Add only that one replacement — nothing else.`,
          'instamart',
          undefined,
          'propose',
          `Change "${item.name}" → ${want}`,
          arm,
        );
      }
    },
    [swapItem, sendMessage],
  );


  // Live get_payment_options. Offer ONLY what this returns (no fallback list);
  // null means "unavailable right now". Scenes needs the event cartKey.
  // (Reads only — callers set state from the resolved value.)
  const loadPaymentOptions = useCallback(
    async (activeService: Service, activeAddr?: string, cartKey?: string): Promise<PaymentOptionsPayload | null | 'auth'> => {
      if (activeService === 'scenes' && !cartKey) return null;
      const q = new URLSearchParams({ service: activeService });
      if (activeService === 'food' && activeAddr) q.set('addressId', activeAddr);
      if (cartKey) q.set('cartKey', cartKey);
      try {
        const res = await window.fetch(`/api/payments/options?${q.toString()}`, {
          headers: { 'ngrok-skip-browser-warning': 'true' },
        });
        if (res.status === 401) return 'auth';
        const data = (await res.json().catch(() => ({}))) as { options?: PaymentOptionsPayload };
        return res.ok && data.options ? data.options : null;
      } catch (e) {
        console.warn('Failed to fetch live payment options:', e);
        return null;
      }
    },
    [],
  );

  const fetchPaymentOptions = useCallback(
    async (svc?: Service, addrId?: string, cartKey?: string) => {
      const loaded = await loadPaymentOptions(svc || service, addrId || selectedAddressIdRef.current, cartKey);
      if (loaded === 'auth') setNeedsLogin(true);
      const options = loaded === 'auth' ? null : loaded;
      setPaymentOptions(options);
      return options;
    },
    [service, loadPaymentOptions],
  );

  // A failed UPI attempt: close the modal, refresh the live methods for a
  // fresh attempt (docs: re-show get_payment_options, then place again).
  const retryPayment = useCallback(() => {
    const failed = paymentSessionRef.current;
    setPaymentSession(null);
    if (!failed) return;
    void fetchPaymentOptions(failed.service, failed.echo?.addressId, failed.echo?.cartKey);
    setMessages((prev) => [
      ...prev,
      {
        id: `pay-retry-${Date.now()}`,
        role: 'assistant',
        text: 'That payment did not go through, and no order was placed. Pick a payment method and place the order again when you are ready.',
        createdAt: Date.now(),
      },
    ]);
  }, [fetchPaymentOptions]);

  useEffect(() => {
    // Preload only the retail (Food / Instamart) picker once an address is
    // chosen. Dineout and Scenes fetch their UPI-only options lazily when the
    // user reaches payment (Scenes needs the create_event_cart cartKey).
    if (!selectedAddressId || (service !== 'food' && service !== 'instamart')) return;
    let alive = true;
    void loadPaymentOptions(service, selectedAddressId).then((loaded) => {
      if (!alive) return;
      if (loaded === 'auth') setNeedsLogin(true);
      setPaymentOptions(loaded === 'auth' ? null : loaded);
    });
    return () => {
      alive = false;
    };
  }, [service, selectedAddressId, loadPaymentOptions]);

  const onPaymentSuccess = useCallback((orderId: string, message: string) => {
    setPaymentSession(null);
    setPaymentOptions(null);
    setMessages((prev) => [
      ...prev,
      {
        id: `pay-succ-${Date.now()}`,
        role: 'assistant',
        text: `🎉 **${message}**\n\nYour order/booking (#${orderId.slice(-8)}) has been successfully confirmed on Swiggy.`,
        createdAt: Date.now(),
      },
    ]);
  }, []);

  const addCreatedAddress = useCallback((address: Address) => {
    setAddresses((prev) => [address, ...prev]);
    setSelectedAddressId(address.id);
  }, []);

  // After delete_address succeeded: drop it; if it was selected, select the next one.
  const removeDeletedAddress = useCallback((id: string) => {
    setAddresses((prev) => {
      const next = prev.filter((a) => a.id !== id);
      setSelectedAddressId((sel) => (sel === id ? (next[0]?.id ?? '') : sel));
      return next;
    });
  }, []);

  // AI read of a picker the user opened by TAP: once its live data is loaded,
  // one lightweight model turn (no tools — the loaded data is reused, never
  // re-fetched) writes a 2–3 line read, the AI-pick reasons and booking chips.
  // On any failure the deterministic quick read stays.
  const runPickerRead = useCallback(
    async (messageId: string) => {
      const snap = pickerSnapshot(messageId);
      if (!snap) return;
      const svc = serviceRef.current;
      const at = messagesRef.current.findIndex((m) => m.id === messageId);
      if (at < 0) return;
      const base = quickRead(snap);
      setMessages((prev) =>
        prev.map((m) => (m.id === messageId ? { ...m, text: base, status: 'Reading the live availability…' } : m)),
      );
      const addr = addresses.find((a) => a.id === selectedAddressIdRef.current);
      let text = '';
      try {
        const res = await fetch('/api/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            service: svc,
            message: `[picker opened] ${snap.kind === 'scenes' ? `Tickets for ${snap.eventTitle}` : `Table slots at ${snap.restaurantName}`}${
              pickerIntentRef.current.has(messageId)
                ? ` — opened from the PLAN step "${pickerIntentRef.current.get(messageId)}". The app has ALREADY selected the ${snap.kind === 'scenes' ? 'show + ticket + count' : 'slot + guests + deal'} for this step (the plan's date, the time nearest the plan, the party size${snap.kind === 'scenes' ? '' : ', a free table first'}). Do NOT emit a PICK line and do not restate the selection ("Set to …"); write only the 2-3 line read of the real availability. The user still taps the final Confirm.`
                : ''
            }`,
            addressId: selectedAddressIdRef.current,
            addressLine: addr?.addressLine || undefined,
            latitude: typeof addr?.latitude === 'number' ? addr.latitude : DEFAULT_LAT,
            longitude: typeof addr?.longitude === 'number' ? addr.longitude : DEFAULT_LNG,
            preferences: preferencesRef.current.trim() || undefined,
            allergies: allergiesRef.current.trim() || undefined,
            budget: budgetRef.current > 0 ? budgetRef.current : undefined,
            history: buildHistory(messagesRef.current.slice(0, at)),
            activePicker: snap,
            pickerRead: true,
          }),
        });
        if (res.ok && res.body) {
          const reader = res.body.getReader();
          const decoder = new TextDecoder();
          let buffer = '';
          const handle = (raw: string) => {
            if (!raw.trim()) return;
            let ev: ChatStreamEvent;
            try {
              ev = JSON.parse(raw) as ChatStreamEvent;
            } catch {
              return;
            }
            if (ev.type === 'text') text += ev.delta;
            else if (ev.type === 'pickerReasons' || ev.type === 'pickerSelect') {
              routePickerEvent(messageId, { ...ev, messageId });
            } else if (ev.type === 'chips' || ev.type === 'model') applyEvent(messageId, ev);
          };
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            let nl: number;
            while ((nl = buffer.indexOf('\n')) >= 0) {
              handle(buffer.slice(0, nl));
              buffer = buffer.slice(nl + 1);
            }
          }
          handle(buffer + decoder.decode());
        }
      } catch {
        /* keep the quick read */
      }
      const read = text.trim();
      setMessages((prev) =>
        prev.map((m) => (m.id === messageId ? { ...m, text: read || base, status: undefined, pending: false } : m)),
      );
    },
    [addresses, applyEvent, buildHistory, routePickerEvent],
  );
  // Fire it once per tapped picker, when that picker registers with its data.
  useEffect(
    () =>
      onPickerReady((id) => {
        if (!pickerReadRef.current.has(id)) return;
        pickerReadRef.current.delete(id);
        void runPickerRead(id);
      }),
    [runPickerRead],
  );

  // Dineout: "Reserve Table" loads the live slot picker directly (one
  // get_available_slots call = 7 days), with the coordinates the search used.
  // A second tap while the same restaurant is loading is ignored (no duplicate
  // Swiggy calls — Dineout is rate-limited).
  const dineoutSlotsInFlight = useRef(new Set<string>());
  const openDineoutSlots = useCallback(
    (restaurant: DineoutRestaurant, opts?: { autoPick?: boolean; planIntent?: string; planPick?: PlanPickResolver }) => {
      // Swiggy lists it but takes no table bookings (partnerType "NPR") — never
      // open the slot picker; the card shows a "Walk-in only" badge instead.
      if (restaurant.bookable === false) return;
      // One-tap "Book best slot": an open picker for this restaurant is reused
      // (no second get_available_slots — Dineout is rate-limited).
      if (opts?.autoPick || opts?.planPick) {
        const open = [...messagesRef.current].reverse().find((m) => m.dineoutSlots?.restaurantId === restaurant.id);
        if (open && pickerSnapshot(open.id)) {
          if (opts.planPick) sendPlanPick(open.id, opts.planPick);
          else sendBestPick(open.id);
          return;
        }
      }
      if (dineoutSlotsInFlight.current.has(restaurant.id)) return;
      dineoutSlotsInFlight.current.add(restaurant.id);
      const addr = addresses.find((a) => a.id === selectedAddressId);
      const lat =
        restaurant.latitude ?? (typeof addr?.latitude === 'number' ? addr.latitude : DEFAULT_LAT);
      const lng =
        restaurant.longitude ?? (typeof addr?.longitude === 'number' ? addr.longitude : DEFAULT_LNG);
      const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
      const stamp = Date.now();
      const assistantId = `do-slots-${stamp}`;
      if (!opts?.planPick) requestPickerOpen(assistantId); // the user tapped this restaurant: open its slot popup
      setMessages((prev) => [
        ...prev,
        {
          id: `do-slots-u-${stamp}`,
          role: 'user',
          text: `Show table slots at ${restaurant.name}`,
          displayText: opts?.autoPick ? `Book the best slot at ${restaurant.name}` : `View slots for ${restaurant.name}`,
          createdAt: stamp,
        },
        {
          id: assistantId,
          role: 'assistant',
          text: '',
          pending: true,
          status: 'Checking table reservation slots…',
          createdAt: stamp,
        },
      ]);
      void (async () => {
        let text = '';
        let view: DineoutSlotsView | undefined;
        try {
          const qs = new URLSearchParams({
            restaurantId: restaurant.id,
            date: today,
            lat: String(lat),
            lng: String(lng),
            restaurantName: restaurant.name,
          });
          const res = await fetch(`/api/dineout/search?${qs.toString()}`);
          const data = await res.json().catch(() => ({}));
          if (data?.ok && Array.isArray(data.slots)) {
            view = {
              restaurantId: data.restaurantId || restaurant.id,
              restaurantName: data.restaurantName || restaurant.name,
              latitude: typeof data.latitude === 'number' ? data.latitude : lat,
              longitude: typeof data.longitude === 'number' ? data.longitude : lng,
              slots: data.slots,
            };
            if (!data.slots.length) {
              markDineoutNoSlots(restaurant.id);
              view = undefined; // no empty picker
            }
            // a real-data quick read now; the AI read replaces it once the picker mounts
            if (view) pickerReadRef.current.add(assistantId);
            // fills the best AI pick once the picker mounts (the user still confirms)
            if (view && opts?.planPick) sendPlanPick(assistantId, opts.planPick);
            else if (view && opts?.autoPick) sendBestPick(assistantId);
            if (view && opts?.planIntent) pickerIntentRef.current.set(assistantId, opts.planIntent.slice(0, 200));
            text = view
              ? quickRead(buildDineoutActivePicker(assistantId, view, view.slots, { guests: 2 }))
              : `**${restaurant.name}** is listed on Swiggy Dineout but isn't taking table bookings there (walk-in only) — no slots for the next 7 days. Want me to find a bookable place nearby?`;
          } else if (data?.busy) {
            text = `${data.message || 'Dineout is busy right now — please try again in a minute.'}`;
          } else {
            text = `Couldn't load slots for **${restaurant.name}**: ${data?.message || 'Swiggy did not return availability.'}`;
          }
        } catch {
          text = `Couldn't load slots for **${restaurant.name}** — network error. Please try again.`;
        } finally {
          dineoutSlotsInFlight.current.delete(restaurant.id);
        }
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantId
              ? { ...m, text, dineoutSlots: view, pending: false, status: undefined }
              : m,
          ),
        );
      })();
    },
    [addresses, selectedAddressId],
  );

  // Dineout: book the user's confirmed slot + deal. FREE → book_table books it
  // in one step; PAID (choice.payment set) → book_table returns PENDING_PAYMENT
  // and the real PaymentSession goes to the payment modal. Failures show
  // Swiggy's own message — never a fabricated confirmation.
  const bookDineoutSlot = useCallback(
    async (
      restaurantId: string,
      restaurantName: string,
      choice: DineoutSlotChoice,
      guestCount: number,
    ): Promise<boolean> => {
      const { slot, deal, latitude, longitude, payment } = choice;
      // The restaurant card this slot came from (cost for two / map link / address) — for the booking card's extras.
      const known = messagesRef.current
        .flatMap((m) => m.dineoutRestaurants ?? [])
        .find((r) => r.id === restaurantId);
      const say = (text: string, booking?: DineoutBooking) =>
        setMessages((prev) => [
          ...prev,
          {
            id: `do-book-${Date.now()}`,
            role: 'assistant',
            text,
            bookingTracker: booking
              ? {
                  kind: 'dineout',
                  title: `Table at ${booking.restaurantName || restaurantName}`,
                  status: booking.status,
                  details: [
                    booking.reservationDate,
                    booking.reservationTime,
                    booking.guestCount
                      ? `${booking.guestCount} guest${booking.guestCount === 1 ? '' : 's'}`
                      : '',
                    booking.dealTitle || deal.title,
                    booking.restaurantLocation,
                  ]
                    .filter(Boolean)
                    .join(' · '),
                  orderId: booking.orderId,
                  // the slot the user picked → countdown, calendar, directions, split
                  startsAt: slot.reservationTime * 1000,
                  place: booking.restaurantName || restaurantName,
                  address: booking.restaurantLocation || known?.address || known?.area,
                  mapUrl: known?.locationMapUrl,
                  guests: booking.guestCount ?? guestCount,
                  costForTwo: known?.costForTwo,
                  amount: payment?.amount,
                }
              : undefined,
            createdAt: Date.now(),
          },
        ]);
      try {
        const res = await fetch('/api/dineout/book', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            restaurantId,
            restaurantName,
            slotId: deal.slotId,
            itemId: deal.itemId,
            reservationTime: slot.reservationTime,
            guestCount,
            latitude,
            longitude,
            payment,
          }),
        });
        const data = await res.json().catch(() => ({}));
        if (data?.ok && data.paymentSession) {
          rememberBooking(
            'dineout',
            data.paymentSession.orderId,
            `Table at ${restaurantName}`,
            `${slot.dateStr} · ${slot.displayTime} · ${guestCount} guest${guestCount === 1 ? '' : 's'}`,
            { restaurantId, lat: latitude, lng: longitude, startsAt: slot.reservationTime * 1000, party: guestCount, amount: payment?.amount },
          );
          openPayment(data.paymentSession as PaymentSession);
          say(
            `Payment started for your table at **${restaurantName}** (${slot.displayTime}, ${guestCount} guest${guestCount === 1 ? '' : 's'}). Complete it in your UPI app — the booking confirms once Swiggy receives the payment.`,
            { status: 'PENDING_PAYMENT', ...(data.booking as Partial<DineoutBooking>), orderId: data.paymentSession.orderId },
          );
          return true;
        }
        if (data?.ok && data.booking?.orderId) {
          const booking = data.booking as DineoutBooking;
          rememberBooking(
            'dineout',
            booking.orderId,
            `Table at ${booking.restaurantName || restaurantName}`,
            `${slot.dateStr} · ${slot.displayTime} · ${guestCount} guest${guestCount === 1 ? '' : 's'}`,
            { restaurantId, lat: latitude, lng: longitude, startsAt: slot.reservationTime * 1000, party: guestCount, amount: payment?.amount },
          );
          say(`Your table at **${booking.restaurantName || restaurantName}** — Swiggy says: **${booking.status}**.`, booking);
          return true;
        }
        say(`⚠️ Couldn't book your table at **${restaurantName}**: ${data?.message || 'Swiggy did not confirm the booking.'}`);
        return false;
      } catch {
        say(
          `⚠️ We lost the connection while booking at **${restaurantName}**, so we can't tell whether it went through. Please check your bookings in the Swiggy app before trying again.`,
        );
        return false;
      }
    },
    [openPayment, rememberBooking],
  );

  // "See shows & tickets" on an event card → a ticket picker that loads the
  // bookable listing deterministically (get_event_details → list_event_shows
  // {eventId, venueId}) with the same coordinates the event was found with.
  const openScenesShows = useCallback((event: ScenesEvent, opts?: { autoPick?: boolean; planIntent?: string; planPick?: PlanPickResolver }) => {
    const id = `sc-shows-${event.id}-${Date.now()}`;
    if (!opts?.planPick) requestPickerOpen(id); // the user tapped this event: open its ticket popup
    // the AI read runs once the picker has loaded its venue listing
    pickerReadRef.current.add(id);
    // one-tap "Best show": selected once the listing loads (Review → Confirm stays the user's)
    if (opts?.planPick) sendPlanPick(id, opts.planPick);
    else if (opts?.autoPick) sendBestPick(id);
    if (opts?.planIntent) pickerIntentRef.current.set(id, opts.planIntent.slice(0, 200));
    setMessages((prev) => [
      ...prev,
      {
        id,
        role: 'assistant',
        text: `Shows & tickets for ${event.title || 'this event'}`,
        scenesShows: {
          eventId: event.id,
          eventTitle: event.title,
          venueName: event.venueName || undefined,
          venueAddress: event.venueAddress,
          venueArea: event.area,
          city: event.city,
          dateSummary: event.dateSummary,
          latitude: event.latitude,
          longitude: event.longitude,
          shows: [],
        },
        createdAt: Date.now(),
      },
    ]);
  }, []);

  // The ticket picker placed a real order: UPI → hand the PENDING_PAYMENT
  // session to the payment sheet (not booked until payment succeeds);
  // FREE → show Swiggy's booking status verbatim (PROCESSING ≠ confirmed).
  const bookScenesShow = useCallback(
    async (
      eventId: string,
      eventTitle: string,
      outcome: ScenesOrderOutcome,
      ticketTitle: string,
      guestCount: number,
      // show time / venue / price from the ticket picker (calendar, directions, split)
      extra?: BookingTrackerExtras,
    ) => {
      if (outcome.kind === 'upi') {
        rememberBooking('scenes', outcome.session.orderId, `${guestCount}× ${ticketTitle} · ${eventTitle}`, undefined, { eventId, startsAt: extra?.startsAt, party: guestCount, amount: extra?.amount });
        openPayment(outcome.session, outcome.options);
        return;
      }
      const b = outcome.booking;
      rememberBooking('scenes', b.orderId, `${guestCount}× ${ticketTitle} · ${eventTitle}`, undefined, { eventId, startsAt: extra?.startsAt, party: guestCount, amount: extra?.amount });
      const processing = b.status.toUpperCase() === 'PROCESSING';
      const details = [
        b.venueName ? (b.venueLocation ? `${b.venueName}, ${b.venueLocation}` : b.venueName) : '',
        [b.date, b.time].filter(Boolean).join(' · '),
        `${b.guestCount ?? guestCount}× ${ticketTitle}`,
        processing ? 'Swiggy is still confirming this booking' : '',
      ]
        .filter(Boolean)
        .join(' | ');
      setMessages((prev) => [
        ...prev,
        {
          id: `sc-book-${b.orderId}`,
          role: 'assistant',
          text: processing
            ? `Your free tickets for **${eventTitle}** are being confirmed by Swiggy (order ${b.orderId}). Ask me "is my booking confirmed?" to check again.`
            : outcome.message || `Free tickets for **${eventTitle}** — status: ${b.status || 'placed'} (order ${b.orderId}).`,
          bookingTracker: {
            kind: 'scenes',
            title: b.title || `${ticketTitle} · ${eventTitle || eventId}`,
            status: b.status,
            details,
            orderId: b.orderId,
            ...extra,
            guests: b.guestCount ?? extra?.guests ?? guestCount,
          },
          createdAt: Date.now(),
        },
      ]);
    },
    [openPayment, rememberBooking],
  );

  const suggestions = dynamicSuggestions.length ? dynamicSuggestions : DEFAULT_SUGGESTIONS[service];
  const placeholder = PLACEHOLDERS[service];

  return {
    service,
    setService,
    history,
    sessionId,
    newChat,
    openSession,
    removeSession,
    recipes,
    saveRecipe,
    cookRecipe,
    cookWithMe,
    reorderRecipe,
    removeRecipe,
    preferences,
    setPreferences,
    analyzeCart,
    allergenSweep,
    nutritionReport,
    allergies,
    setAllergies,
    budget,
    setBudget,
    trimToFit,
    kcalGoal,
    proteinGoal,
    setMacroGoals,
    foodMacros,
    messages,
    sending,
    suggestions,
    placeholder,
    addresses,
    selectedAddressId,
    selectAddress,
    cart,
    cartBusy,
    addToCart,
    incrementItem,
    decrementItem,
    removeItem,
    clearCart,
    inCartQty,
    loadMore,
    isLoadingMore,
    checkout,
    foodCart,
    foodBusy,
    addFoodItem,
    parkedFoodCarts,
    switchFoodCart,
    discardParkedCart,
    pendingFoodSwitch: pendingFoodSwitch
      ? { fromName: pendingFoodSwitch.fromName, toName: pendingFoodSwitch.toName }
      : null,
    confirmFoodSwitch,
    cancelFoodSwitch,
    incFoodItem,
    decFoodItem,
    removeFoodItem,
    clearFoodCart,
    inFoodCartQty,
    applyBestCoupon,
    setFoodCutlery,
    listFoodCoupons,
    placeFoodOrder,
    orderUsuals,
    findDeals,
    smartBasket,
    setCartItems,
    setFoodItems,
    sendMessage,
    stop,
    cancelQueued,
    openMenu,
    loadMoreMenu,
    isLoadingMoreMenu,
    loadMoreDishes,
    isLoadingMoreDishes,
    needsLogin,
    addressesLoaded,
    auth,
    login,
    logout,
    regenerate,
    compareItems,
    toggleCompare,
    toggleCompareFood,
    isSelectedForCompare,
    clearCompare,
    compareBest,
    addCompareWinner,
    swapItem,
    selectSwap,
    clearSwap,
    requestSwap,
    approveProposal,
    dismissProposal,
    approveAllProposals,
    basketAction,
    refillUsuals,
    replaceCartLine,
    queue: queue.map((q) => ({ qid: q.qid, label: q.displayText ?? q.text })),
    paymentSession,
    paymentOptions,
    fetchPaymentOptions,
    openPayment,
    closePayment,
    onPaymentSuccess,
    retryPayment,
    addCreatedAddress,
    removeDeletedAddress,
    createAddressModalOpen,
    setCreateAddressModalOpen,
    openDineoutSlots,
    bookDineoutSlot,
    openScenesShows,
    bookScenesShow,
  };
}

// The earlier message (other than `selfId`) that already shows every item of
// this card event, or null. Menus repeat when the same restaurant's page was
// already drawn; lists repeat when all their ids are already on screen.
function repeatedCards(
  msgs: ChatMessage[],
  selfId: string,
  ev: ChatStreamEvent,
): { label: string; messageId: string } | null {
  const earlier = msgs.filter((m) => m.id !== selfId && m.role === 'assistant');
  const covered = (ids: string[], has: (m: ChatMessage) => Set<string>, label: string) => {
    if (!ids.length) return null;
    for (let i = earlier.length - 1; i >= 0; i--) {
      const seen = has(earlier[i]);
      if (ids.every((id) => seen.has(id))) return { label, messageId: earlier[i].id };
    }
    return null;
  };
  switch (ev.type) {
    case 'products':
      return covered(
        ev.products.map((p) => p.productId || p.variations[0]?.spinId || p.name),
        (m) => new Set((m.productGroups ?? []).flatMap((g) => g.products.map((p) => p.productId || p.variations[0]?.spinId || p.name))),
        'Those products',
      );
    case 'foodRestaurants':
      return covered(
        ev.restaurants.map((r) => r.id),
        (m) => new Set((m.foodRestaurants ?? []).map((r) => r.id)),
        'Those restaurants',
      );
    case 'dineoutRestaurants':
      return covered(
        ev.restaurants.map((r) => r.id),
        (m) => new Set((m.dineoutRestaurants ?? []).map((r) => r.id)),
        'Those restaurants',
      );
    case 'scenesEvents':
      return covered(
        ev.events.map((e) => e.id),
        (m) => new Set((m.scenesEvents ?? []).map((e) => e.id)),
        'Those events',
      );
    case 'menu': {
      const page = ev.page ?? 1;
      for (let i = earlier.length - 1; i >= 0; i--) {
        const menu = earlier[i].menu;
        if (menu && menu.restaurantId === ev.restaurantId && (menu.page ?? 1) >= page) {
          return { label: `${ev.restaurantName || 'The'} menu`, messageId: earlier[i].id };
        }
      }
      return null;
    }
    default:
      return null;
  }
}
