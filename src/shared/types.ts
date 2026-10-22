// Shared domain + protocol types for the Instamart chat app.
// This file is the contract every other module builds against. Do not change
// shapes here without updating the backend (lib/agent, api/chat, api/cart) and
// the UI (hooks/components) together.

/* ----------------------------- Swiggy domain ----------------------------- */

export interface Variation {
  spinId: string; // the add-to-cart key (Swiggy SPIN id)
  skuId: string; // SKU id — update_cart wants BOTH spinId and skuId
  quantityDescription: string; // e.g. "500 ml", "500 ml x 4"
  mrp: number;
  offerPrice: number;
  unitLevelPrice?: string; // e.g. "₹12/100 g"
  imageUrl: string;
  inStock: boolean; // isInStockAndAvailable
  maxQuantity?: number; // per-order cap, when Swiggy sets one
  maxQuantityMessage?: string;
  rating?: { value: string; count?: string }; // e.g. { value: "4.4", count: "140.4k" }
  sla?: string; // delivery time for this pack, e.g. "14 mins" (sla.value + sla.unit)
  veg?: "veg" | "nonveg"; // vegClassifier (VEG_CLASSIFIER_INVALID → absent)
}

/** A Swiggy merchandising badge on a product ("Bestseller", "Switch", "Ad"). */
export interface ProductBadge {
  type: string; // BADGE_TYPE_BEST_SELLER | BADGE_TYPE_INSTA_UPGRADE | BADGE_TYPE_AD | …
  text: string;
  backgroundColor?: string; // Swiggy's own colour, e.g. "#238BF4"
}

export interface Product {
  productId: string;
  name: string; // displayName
  brand: string;
  inStock: boolean;
  isPromoted: boolean; // sponsored listing — Swiggy asks us to label it "Sponsored"
  variations: Variation[];
  badges?: ProductBadge[];
}

export interface Address {
  id: string;
  addressLine: string;
  addressTag: string;
  addressCategory: string;
  phoneNumber?: string;
  // the address's city centre (Swiggy sends no coordinates) — see shared/cityCoords
  latitude?: number;
  longitude?: number;
  city?: string;
}

/** get_addresses `resolution` block — which saved address Swiggy suggests. */
export interface AddressResolution {
  defaultAddressId?: string;
  resolutionSource: string; // explicit_user_address | user_selected_address | ranked_saved_address | …
  needsUserClarification: boolean;
}

/* -------------------------------- Cart ----------------------------------- */

export interface CartLine {
  spinId: string;
  skuId?: string; // sent with spinId to update_cart (absent only on legacy shared baskets)
  productId: string;
  name: string;
  brand: string;
  quantityDescription: string;
  imageUrl: string;
  unitPrice: number; // offerPrice / discountedFinalPrice
  mrp: number;
  quantity: number;
  maxQuantity?: number;
  maxQuantityMessage?: string; // Swiggy's own cap text ("Only 3 unit(s) …")
  inStock?: boolean; // false when Swiggy reports the line unavailable
}

// The real Swiggy bill breakdown (Item Total, Handling Fee, Delivery, GST, …).
export interface BillBreakdown {
  lines: { label: string; value: string }[]; // value pre-formatted, e.g. "₹12.00" / "FREE"
  total: string; // grand total ("To pay"), e.g. "₹241"
  totalLabel?: string; // Swiggy's label for the total (toPay.label, "To Pay")
}

/** Instamart get_cart `selectedAddressDetails` — where this cart delivers. */
export interface CartDeliveryAddress {
  label?: string; // annotation ("Home", "GPR")
  category?: string; // HOME | WORK | OTHER …
  name?: string;
  phone?: string; // masked to the last 4 digits before it reaches the UI
  flatNo?: string;
  area?: string;
  city?: string;
  address: string;
}

/** Instamart get_cart `superData` — the user's Swiggy One membership. */
export interface SwiggyOneStatus {
  userStatus: string; // "SUPER" when active
  program?: string; // "ONE"
  offering?: string; // "PLUS" / "LITE" …
}

export interface CartState {
  addressId: string;
  items: CartLine[];
  itemCount: number; // total quantity across lines
  subtotal: number; // sum(unitPrice * quantity)
  savings: number; // sum((mrp - unitPrice) * quantity)
  bill?: BillBreakdown; // real fees/taxes/grand total from Swiggy's cart
  // Swiggy's own notices for this cart: removed out-of-stock items, capped
  // quantities, unserviceable items, address / cart warnings, sync errors.
  warnings?: string[];
  // Items Swiggy can't deliver to this address (shown, but block checkout).
  unserviceable?: CartLine[];
  // The address the SERVER-side cart is bound to, when it differs from
  // `addressId` (Instamart carts bind to one delivery address).
  boundAddressId?: string;
  // Instamart: where Swiggy's cart delivers (selectedAddressDetails).
  deliveryAddress?: CartDeliveryAddress;
  // Instamart: Swiggy One membership (superData) — explains free delivery etc.
  swiggyOne?: SwiggyOneStatus;
  // Instamart: distinct stores fulfilling the cart (>1 = split delivery).
  storeCount?: number;
}

export function emptyCart(addressId: string): CartState {
  return { addressId, items: [], itemCount: 0, subtotal: 0, savings: 0 };
}

/* --------------------------- Chat stream protocol ------------------------- */
// The /api/chat route streams newline-delimited JSON (NDJSON). Each line is one
// ChatStreamEvent. The client hook parses these incrementally.

export type ChatStreamEvent =
  | { type: "status"; label: string } // ephemeral "Searching milk…" pill
  | { type: "text"; delta: string } // assistant prose, streamed
  | {
      type: "products";
      query: string;
      products: Product[];
      nextOffset: string | null;
    }
  | { type: "suggestions"; products: Product[] }
  // food
  | { type: "foodRestaurants"; query: string; restaurants: FoodRestaurant[] }
  | {
      type: "menu";
      restaurantId: string;
      restaurantName: string;
      categories: MenuCategory[];
      // get_restaurant_menu paginates over categories: hasMore -> page + 1
      page?: number;
      hasMore?: boolean;
      // get_restaurant_menu `restaurant{}` (rating, SLA, cost for two, address, photo…)
      restaurant?: FoodRestaurant;
      totalCategories?: number; // get_restaurant_menu `totalCategories`
    }
  // the agent's "best pick" among the shown results (id = spinId / menu_item_id)
  | { type: "bestPick"; id: string; reason: string }
  // the agent's "healthiest" pick(s) among the shown results
  | { type: "healthyPick"; id: string; reason: string }
  // an allergen / exclusion warning on a shown item
  | { type: "warn"; id: string; reason: string }
  // live order status (from track_* / get_*_orders)
  | {
      type: "tracker";
      status: string;
      eta?: string;
      partner?: string;
      items?: string;
      // Food: Swiggy's tracking page (trackUrl) and progressPercentage (0–100)
      trackUrl?: string;
      progress?: number;
    }
  // cook-with-me: step-by-step cooking guide (each step may carry a timer)
  | { type: "steps"; steps: { text: string; seconds?: number }[] }
  // food: cross-restaurant dish search (the client fetches /api/dishes)
  | { type: "dishQuery"; query: string }
  // food: the agent's one-sentence order ("dinner for 3 under ₹800") as ONE
  // approvable cart proposal (MEAL: / MEALITEM: markers, ids resolved server-side)
  | { type: "foodMealPlan"; plan: FoodMealPlan }
  // cook: the recipe's ingredient list — the client searches them ALL in
  // parallel (fast) and proposes the best pick of each, instead of the agent
  // searching one ingredient per turn (slow).
  | { type: "ingredients"; dish: string; items: string[] }
  // dynamic, context-aware follow-up chips (parsed from the agent's reply).
  // Doubles as the CLARIFY surface: when a request is ambiguous the agent asks a
  // short question in `text` and offers the answer options as chips.
  | { type: "chips"; items: string[] }
  // agent-estimated nutrition for shown items (id = spinId / menu_item_id) — the
  // client captures these to drive the live MacroMeter and the "Healthier" rank.
  | { type: "macros"; items: { id: string; kcal: number; protein: number }[] }
  // universal chat control: change ANY app setting by talking — calorie/protein
  // goals, budget, allergies, preferences, theme, service, clear cart, etc.
  | { type: "control"; action: string; value?: string }
  // a structured Compare verdict over the items the user selected to compare.
  // The matrix itself is rendered deterministically client-side from the
  // CompareItem metadata; the agent only supplies the winner, verdict and notes.
  | {
      type: "comparison";
      winnerId?: string;
      verdict?: string;
      notes?: { id: string; note: string }[];
    }
  // agent-driven add to cart — the backend resolves the id to exact item
  // metadata (no hallucinated price) and the client posts it deterministically
  | {
      type: "addToCart";
      target: "instamart";
      quantity: number;
      line: Omit<CartLine, "quantity">;
    }
  | {
      type: "addToCart";
      target: "food";
      quantity: number;
      restaurantId: string;
      restaurantName: string;
      line: Omit<FoodCartLine, "quantity">;
    }
  // agent-driven REMOVE: drop a line the user already has in their cart, by id
  // (spinId / menu_item_id). Deterministic + gated client-side, like addToCart.
  | { type: "removeFromCart"; target: "instamart" | "food"; id: string }
  // Instamart: an AI-built basket (build_basket) — one card, Approve all
  | { type: "basket"; basket: InstamartBasket }
  // Dineout & Scenes events
  | { type: "dineoutRestaurants"; query?: string; restaurants: DineoutRestaurant[]; paging?: DineoutPaging }
  | ({ type: "dineoutSlots" } & DineoutSlotsView)
  | {
      type: "scenesEvents";
      query?: string;
      events: ScenesEvent[];
      collections?: ScenesCollection[];
      // set (with events: []) when discover_events came back empty: the user
      // location the agent's keyword-browse fallback runs from (no card is drawn)
      emptyDiscover?: { latitude: number; longitude: number; city?: string };
    }
  | ({ type: "scenesShows" } & ScenesShowListing)
  // the agent resolved the user's words to a selection inside the OPEN picker
  // (PICK: marker) — the picker applies it to its own live data; never books.
  | ({ type: "pickerSelect"; target: "scenes" | "dineout"; messageId?: string } & PickerSelectFields)
  // the model's one-line reasons for the picker's AI PICKS (WHY: lines)
  | { type: "pickerReasons"; target: "scenes" | "dineout"; messageId?: string; reasons: { id: string; why: string }[] }
  | { type: "paymentPrompt"; session: PaymentSession; options?: PaymentOptionsPayload }
  | {
      type: "bookingTracker";
      kind: "dineout" | "scenes";
      title: string;
      status: string;
      details: string;
      orderId: string;
    }
  // Plan tab: the outing timeline parsed from ITINERARY: lines
  // past/active orders list (Food get_food_orders / Instamart get_orders)
  | { type: "orderHistory"; service: "food" | "instamart"; orders: PastOrder[] }
  | ({ type: "itinerary" } & Itinerary)
  // an off-domain ask: one-tap button that opens the owning tab with the query
  | ({ type: "handoff" } & ServiceHandoff)
  // which LLM actually produced this reply (after any provider fallbacks)
  | { type: "model"; info: GeneratedBy }
  | { type: "error"; message: string }
  | { type: "done" };

/** The provider + model that generated an assistant reply (shown under the bubble). */
export interface GeneratedBy {
  provider: "anthropic" | "groq" | "gemini";
  model: string; // API model id, e.g. "claude-haiku-5-5"
  label: string; // display name, e.g. "Claude Haiku 5.5"
  step: string; // which chain step answered, e.g. "Groq · key 2"
  fallbacks: number; // how many earlier attempts failed before this one
}

/* ------------------------------ Chat UI model ----------------------------- */

export type Role = "user" | "assistant";

export interface ProductGroup {
  query: string; // the search that produced this grid
  products: Product[];
  nextOffset: string | null; // pagination cursor for "Load more"
}

export interface ChatMessage {
  id: string;
  role: Role;
  createdAt?: number; // epoch ms when the turn was created (per-message timestamp)
  text: string; // the full text (used for agent context); may be a long instruction
  // short label shown in the user bubble INSTEAD of `text` for action-triggered
  // turns (cook / swap / deals / analyse), so the user never sees the raw prompt.
  displayText?: string;
  status?: string; // live status line while pending
  // instamart — one grid per search, so "everything for X" shows a grid per item
  productGroups?: ProductGroup[];
  suggestions?: Product[];
  // food
  foodRestaurants?: FoodRestaurant[];
  // page / hasMore: get_restaurant_menu paginates over categories ("More" button)
  menu?: {
    restaurantId: string;
    restaurantName: string;
    categories: MenuCategory[];
    page?: number;
    hasMore?: boolean;
    restaurant?: FoodRestaurant; // get_restaurant_menu header info
    totalCategories?: number;
  };
  // cross-restaurant dish search results (each dish keeps its restaurantName)
  // nextOffset: search_menu pagination ("More dishes"); null/absent = no more
  // totalItems = search_menu's total match count ("422")
  dishGroups?: { query: string; dishes: MenuItem[]; nextOffset?: number | null; totalItems?: number }[];
  // food: the agent's whole-meal proposal (Approve all / tweak) — see FoodMealPlan
  foodMealPlan?: FoodMealPlan & { status?: "pending" | "approved" | "dismissed" };
  // the agent's recommended pick(s): id (spinId / menu_item_id) -> one-line why
  bestPicks?: Record<string, string>;
  // the agent's healthiest pick(s): id -> why (rendered as a green flag)
  healthyPicks?: Record<string, string>;
  // allergen warnings: id -> reason (rendered as a red flag on the card)
  warns?: Record<string, string>;
  // dineout
  dineoutRestaurants?: DineoutRestaurant[];
  // the search behind dineoutRestaurants — total + next offset for "Load more"
  dineoutPaging?: DineoutPaging;
  dineoutSlots?: DineoutSlotsView;
  // scenes
  scenesEvents?: ScenesEvent[];
  // genre chips from discover_events (tap → get_events_collection)
  scenesCollections?: ScenesCollection[];
  scenesShows?: ScenesShowListing;
  // the picker that was here moved down to a later reply (chat changed the selection)
  pickerMoved?: "dineout" | "scenes";
  // cards this reply would have repeated — already shown in an earlier message
  // (the bubble shows a one-line "Shown above ↑" link instead of the duplicate)
  shownAbove?: { label: string; messageId: string }[];
  // booking tracker (for dineout reservations or scenes event tickets)
  bookingTracker?: { kind: "dineout" | "scenes"; title: string; status: string; details: string; orderId: string } & BookingTrackerExtras;
  // past / active orders (all of them, not just the latest)
  orderHistory?: { service: "food" | "instamart"; orders: PastOrder[] };
  // "my bookings": every booking made in this app, with live status from Swiggy
  bookingTrackers?: ({ kind: "dineout" | "scenes"; title: string; status: string; details: string; orderId: string } & BookingTrackerExtras)[];
  // live order-tracking card (filled from track_* tools)
  tracker?: {
    status: string;
    eta?: string;
    partner?: string;
    items?: string;
    service?: "food" | "instamart";
    trackUrl?: string; // Food: https://www.swiggy.com/track-order/<orderId>
    progress?: number; // Food track_food_order progressPercentage (0–100)
  };
  // cook-with-me step-by-step guide
  cookSteps?: { text: string; seconds?: number }[];
  // agent-proposed cart changes awaiting the user's APPROVAL — the agent never
  // edits the cart on its own; the user taps Approve (or Dismiss) on each.
  proposals?: CartProposal[];
  // an image the user attached on this turn (base64, no data: prefix) — rendered
  // as a thumbnail inside the user bubble so the sent photo is always visible.
  image?: { mediaType: string; data: string };
  // inline, tappable follow-up / clarifying chips shown under this assistant turn
  chips?: string[];
  // compare ("choose best of both"): the snapshot of items being compared on this
  // turn + the agent's structured verdict, rendered as a Compare card.
  compareItems?: CompareItem[];
  comparison?: ComparisonResult;
  // the LLM that produced this assistant turn
  generatedBy?: GeneratedBy;
  // Plan tab: the outing timeline (steps link to this turn's real cards)
  itinerary?: Itinerary;
  // off-domain asks routed to the tab that owns them
  handoffs?: ServiceHandoff[];
  // Instamart: one AI-built basket proposal (Approve all / remove / swap)
  basket?: InstamartBasket;
  pending?: boolean;
}

/* ------------------------- Instamart AI basket ---------------------------- */
// Built server-side from REAL search_products / your_go_to_items results
// (src/shared/instamart-packs.ts picks the pack); the cart only changes when
// the user taps Approve on the card.

/** One concrete pack the basket proposes, with Swiggy's own facts about it. */
export interface BasketPick {
  line: Omit<CartLine, "quantity">;
  quantity: number;
  reason: string; // one line, derived from real data (₹/unit, rating, ETA…)
  unitPrice?: string; // "₹7/100 ml" (Swiggy's unitLevelPrice, else computed)
  rating?: { value: string; count?: string };
  sla?: string; // "11 mins"
  veg?: "veg" | "nonveg";
  sponsored?: boolean; // isPromoted / Ad badge — always labelled
  badges?: string[]; // "Bestseller", "Switch"
  packCount?: number; // how many packs Swiggy offers for this product
}

export interface BasketLine extends BasketPick {
  id: string; // stable key within the basket
  need: string; // what the user / model asked for ("toned milk · 2 L")
  kind: "pick" | "substitute" | "overflow";
  note?: string; // why a substitute / extra line ("X is out of stock — closest match")
  capped?: string; // Swiggy's maxQuantityMessage when the per-order cap bit
  lastOrdered?: string; // usuals: "ordered 6 days ago"
  alternatives?: BasketPick[]; // up to 2 real swaps the user can pick instead
}

export interface InstamartBasket {
  id: string;
  title: string;
  source: "ask" | "usuals";
  budget?: number;
  lines: BasketLine[];
  missing?: { need: string; why: string }[]; // asked for, nothing buyable found
  itemTotal: number; // sum of offer prices × qty (fees come from Swiggy's cart)
  mrpTotal: number;
  skippedSponsored?: number; // sponsored listings passed over for better value
  status?: "pending" | "approved" | "dismissed";
  removed?: string[]; // line ids the user took out
  chosen?: Record<string, number>; // line id → index into alternatives
  note?: string; // AI one-liner (usuals refill)
}

/**
 * Structured facts about a booking, known only when this app made it (the
 * slot / show the user picked). They power Add to calendar, Directions, the
 * countdown chip and the bill split; every field is optional and copied from
 * Swiggy's own data — never estimated.
 */
export interface BookingTrackerExtras {
  startsAt?: number; // epoch ms (slot.reservationTime / show_time_unix)
  endsAt?: number; // epoch ms (Scenes timeRange.endTime)
  place?: string; // restaurant / venue name
  address?: string; // restaurant location / venue address
  lat?: number; // VENUE coordinates only (never the user's)
  lng?: number;
  mapUrl?: string; // Swiggy's own locationMapUrl
  guests?: number;
  amount?: number; // ₹ Swiggy charged (billToPay), when known
  unitPrice?: number; // ₹ per ticket (Scenes)
  costForTwo?: string; // Dineout display string ("₹1000 for two")
}

/** An agent-proposed cart change shown for the user's approval (never auto-applied). */
export interface CartProposal {
  pid: string;
  status: "pending" | "approved" | "dismissed";
  kind: "add" | "remove" | "swap";
  name: string; // the item the change concerns
  imageUrl?: string;
  detail?: string; // "₹63 · 6 Pieces" (add) or "replaces NOICE Eggs" (swap)
  target?: "instamart" | "food"; // which cart it changes (Plan's itinerary approves per step)
}

/** The agent's structured verdict for a Compare card (matrix is client-rendered). */
export interface ComparisonResult {
  winnerId?: string; // spinId / menuItemId of the recommended item
  verdict?: string; // one-line why-this-one
  notes?: Record<string, string>; // id -> one-line qualitative note
}

/** A saved conversation in local (browser) history. */
export interface ChatSessionMeta {
  id: string;
  title: string;
  service: Service;
  updatedAt: number; // epoch ms
}

export interface ChatSession extends ChatSessionMeta {
  messages: ChatMessage[];
}

/* ----------------------- /api/chat request/response ----------------------- */

export interface ChatRequest {
  service: Service;
  message: string;
  addressId: string;
  addressLine?: string; // display text of the selected address (saves a server lookup)
  latitude?: number; // the address's city centre; absent when its city isn't recognised
  longitude?: number;
  city?: string;
  preferences?: string; // diet goals / requirements to respect in every search
  allergies?: string; // hard exclusions
  budget?: number; // soft budget in rupees
  kcalGoal?: number; // daily calorie goal — lets the agent build toward it
  proteinGoal?: number; // daily protein goal (g)
  // an attached photo (fridge / shopping list / dish) for vision -> cart
  image?: { mediaType: string; data: string }; // base64, no data: prefix
  // prior turns, oldest-first, for conversational context
  history?: { role: Role; text: string }[];
  // recently-shown items so agent-driven ADD/BEST/WARN markers resolve ACROSS
  // turns and for cross-restaurant dishes (whose ids never enter the agent loop).
  catalog?: ChatCatalog;
  // the user's CURRENT cart for the active service, so the agent can edit it by
  // id — remove a line ("remove the tofu") or replace one ("swap it for X").
  cartLines?: { id: string; name: string; quantity: number }[];
  // Dineout/Scenes bookings made in this app (Swiggy has no list-bookings tool)
  knownBookings?: { kind: "dineout" | "scenes"; orderId: string; title: string }[];
  // the ticket / slot picker still open in this thread (live listing + current
  // selection), so "the 25th, entry pass for two" edits IT instead of a new search
  activePicker?: ActivePicker;
  // a picker just loaded: write the AI read of activePicker only — no tool calls
  // (Dineout is rate-limited; the loaded data is reused, never re-fetched)
  pickerRead?: boolean;
}

/** A selection the user asked for inside an open picker (only the fields named). */
export interface PickerSelectFields {
  date?: string; // "YYYY-MM-DD" (or a day phrase the picker resolves)
  time?: string; // show / slot time label ("9:00 pm")
  showId?: string;
  ticketId?: string;
  ticketName?: string;
  qty?: number; // Scenes ticket count
  guests?: number; // Dineout party size
  deal?: string; // Dineout: "free" | "paid" | an itemId / deal title
  // "book it": fill everything, then open the picker's final review / confirm
  // step (Scenes: Review → cart summary; Dineout paid: cart summary). The user
  // still taps the final Confirm — nothing is booked without it.
  confirm?: boolean;
}

/** One "AI pick" computed from a picker's live data (ranked deterministically). */
export interface AiPick {
  id: string; // stable kind id: "soonest" | "value" | "prime" | "fast" | "weekend"
  label: string; // "Best value"
  title: string; // "Tomorrow 8:00 PM · free table · 15% off"
  why: string; // deterministic one-liner (the model may replace it)
  sel: PickerSelectFields; // the full selection "Book this" applies
}

/** Snapshot of an open Scenes ticket picker (real listing data only). */
export interface ScenesActivePicker {
  kind: "scenes";
  messageId: string;
  eventId: string;
  eventTitle: string;
  venueName?: string;
  dates: {
    date: string;
    label: string;
    shows: { showId: string; timeLabel: string; seatsLeft?: number; soldOut?: boolean }[];
  }[];
  // tiers unioned by name; onlyOn = the dates a tier is on sale when not all
  tickets: { name: string; price?: number; onlyOn?: string[] }[];
  selection?: { date?: string; showId?: string; timeLabel?: string; ticketName?: string; qty?: number };
  aiPicks?: { id: string; label: string; title: string }[];
}

/** Snapshot of an open Dineout slot picker (real slots only). */
export interface DineoutActivePicker {
  kind: "dineout";
  messageId: string;
  restaurantId: string;
  restaurantName: string;
  dates: {
    date: string;
    label: string;
    meals: Record<string, string[]>; // meal window → open time labels
    deals: { title: string; free: boolean; price?: number; discount?: number }[];
  }[];
  guests: number;
  selection?: { date?: string; time?: string; deal?: string; guests?: number };
  aiPicks?: { id: string; label: string; title: string }[];
}

export type ActivePicker = ScenesActivePicker | DineoutActivePicker;

/** A compact map of items the client has recently shown, sent with each turn so
 *  the agent can resolve ADD/BEST/HEALTHY/WARN ids it didn't search this turn. */
export interface ChatCatalog {
  products?: Omit<CartLine, "quantity">[]; // keyed by spinId
  dishes?: {
    restaurantId: string;
    restaurantName: string;
    line: Omit<FoodCartLine, "quantity">;
  }[]; // keyed by line.menuItemId
}

/* ----------------------- /api/cart request/response ----------------------- */

export type CartAction =
  | "add"
  | "increment"
  | "decrement"
  | "remove"
  | "clear"
  | "set"; // replace the WHOLE desired cart in one call (coalesced optimistic sync)

export interface CartRequest {
  action: CartAction;
  addressId: string;
  // required for add/increment/decrement/remove
  spinId?: string;
  // full metadata required only for `add` (so the cart can render without a
  // second lookup); ignored for other actions.
  line?: Omit<CartLine, "quantity">;
  quantity?: number; // for `add`, defaults to 1
  // for `set`: the full desired item set; the route replaces the cart with it.
  items?: { line: Omit<CartLine, "quantity">; quantity: number }[];
}

/* ===========================================================================
   MULTI-SERVICE (Instamart / Food)
   The chat shell is service-agnostic; only the MCP/agent, the card kinds, and
   the right-column tray change per service.
   =========================================================================== */

/** The four Swiggy domains — each backed by exactly one MCP server. */
export type DomainService = "instamart" | "food" | "dineout" | "scenes";

/**
 * A chat tab. The four domain tabs are strictly isolated (each only ever talks
 * to its own MCP server and renders its own cards); "plan" is the outing
 * planner that reads from all four servers and hands every booking / order
 * back to the owning domain's confirm flow. Plan has no cart of its own.
 */
export type Service = DomainService | "plan";

export const DOMAIN_SERVICES: DomainService[] = ["instamart", "food", "dineout", "scenes"];

export const SERVICES: Service[] = [...DOMAIN_SERVICES, "plan"];

export function isDomainService(s: unknown): s is DomainService {
  return typeof s === "string" && (DOMAIN_SERVICES as string[]).includes(s);
}

export const SERVICE_META: Record<
  Service,
  { label: string; tagline: string; accentGlyph: string; emoji: string }
> = {
  instamart: { label: "Instamart", tagline: "Groceries in minutes", accentGlyph: "I", emoji: "⚡" },
  food: { label: "Food", tagline: "Restaurants, delivered", accentGlyph: "F", emoji: "🍽️" },
  dineout: { label: "Dineout", tagline: "Table reservations & dining deals", accentGlyph: "D", emoji: "🥂" },
  scenes: { label: "Scenes", tagline: "Events, comedy & live gigs", accentGlyph: "S", emoji: "🎟️" },
  plan: { label: "Plan", tagline: "Outings planned across Swiggy", accentGlyph: "P", emoji: "🗺️" },
};

/* ------------------------------ Plan (outings) ----------------------------- */

/** Which part of an outing a step belongs to ("other" = no Swiggy domain, e.g. the mall). */
export type ItineraryDomain = DomainService | "other";

/** One stop on a planned outing, parsed from an `ITINERARY:` marker line. */
export interface ItineraryStep {
  time?: string; // "4:00 PM" (free text, as the planner wrote it)
  domain: ItineraryDomain;
  title: string;
  detail?: string;
  // id of the real card this step points at (Dineout restaurantId / Scenes
  // eventId / Food menu_item_id / Instamart spinId) — only ids a tool returned
  ref?: string;
}

export interface Itinerary {
  title?: string;
  // PLAN INFO: line — the outing's date / party size / total budget as the
  // planner read them from the user's ask (live plan panel header)
  date?: string; // "Sat 25 Oct"
  party?: number;
  budget?: number; // ₹ total the user named
  // UNAVAILABLE: lines — parts the user asked for that Swiggy had nothing for
  // ("comedy show" | "none on Swiggy Scenes in Chennai for Sat 24 Oct")
  unavailable?: { what: string; why: string }[];
  steps: ItineraryStep[];
}

/** "This belongs to another tab" — a one-tap hand-off that opens that tab with the ask. */
export interface ServiceHandoff {
  service: Service;
  query: string;
  label?: string;
}

/* ------------------------------- Food domain ------------------------------- */

/** search_restaurants `availabilityStatus` ("UNKNOWN" when Swiggy omitted it). */
export type FoodAvailability = "OPEN" | "CLOSED" | "UNAVAILABLE" | "UNKNOWN";

/** Builders Club hard cap on a Food order total (₹). */
export const FOOD_ORDER_CAP = 1000;

/** Restaurants farther than this (km) must have their distance called out. */
export const FOOD_FAR_KM = 5;

export interface FoodRestaurant {
  id: string;
  name: string;
  cuisines: string[];
  rating: number; // 0 = not rated / not returned
  ratingCount: string; // "" when not returned
  costForTwo: string;
  area: string;
  distanceKm: number; // 0 = not returned
  etaRange: string; // "15-20 MINS" ("" when not returned)
  offer: string; // "70% OFF"
  imageUrl: string;
  availability: FoodAvailability;
  nextOpenTime?: string;
  // false ONLY when Swiggy says the restaurant is CLOSED / UNAVAILABLE
  isOpen: boolean;
  // Swiggy suffixes promoted listings with " (Ad)" — stripped from `name`, kept here
  sponsored?: boolean;
  deliveryMinutes?: number; // deliveryTimeMinutes / get_restaurant_menu deliveryTime
  veg?: boolean; // pure-veg restaurant (documented `veg`)
  // get_restaurant_menu `restaurant{}` only
  address?: string;
  city?: string;
}

/** One selectable option inside a variant group (search_menu). */
export interface FoodVariantChoice {
  id: string;
  name: string;
  price?: number;
  inStock: boolean;
  isDefault: boolean;
}

export interface FoodVariantGroup {
  groupId: string;
  name: string;
  choices: FoodVariantChoice[];
  // variantsV2 choice prices are ADD-ONS to the dish price (live: the default
  // "Serves 1" has no price, "Serves 2" = +₹430 on a ₹369 biryani)
  pricesAreAddOns?: boolean;
}

export interface FoodAddonGroup {
  groupId: string;
  name: string;
  min: number;
  max: number; // 0 = no limit
  maxFree?: number; // maxFreeAddons (> 0 only; -1 = not applicable)
  choices: { id: string; name: string; price: number }[];
}

/**
 * Customization options for a dish, from search_menu. An item carries EITHER
 * legacy `variations` OR `variantsV2` (never both); cart updates must use the
 * same format.
 */
export interface FoodItemCustomization {
  format: "variations" | "variantsV2" | "none";
  variantGroups: FoodVariantGroup[];
  addonGroups: FoodAddonGroup[];
}

/** The variant / addon choices the user picked for one cart line. */
export interface FoodCartSelection {
  format: "variations" | "variantsV2" | "none";
  variants: { groupId: string; variationId: string; name: string }[];
  addons: { groupId: string; choiceId: string; name: string; price: number }[];
}

export interface MenuItem {
  id: string; // menu_item_id
  name: string;
  description: string;
  price: number;
  veg: boolean;
  bestseller: boolean;
  rating: string; // "4.4" or ""
  ratingCount?: string; // search_menu `totalRatings` ("36")
  category?: string; // search_restaurants dishes[].category
  imageUrl: string;
  hasVariants: boolean;
  hasAddons: boolean;
  inStock: boolean;
  restaurantId: string;
  restaurantName: string;
  // present only on search_menu results (get_restaurant_menu is browse-only)
  customization?: FoodItemCustomization;
}

export interface MenuCategory {
  title: string;
  items: MenuItem[];
  // get_restaurant_menu caps each category (~10 dishes; live `hasMoreItems` +
  // `totalItems`): how many more Swiggy has in it (reach them via search_menu)
  moreItems?: number;
  categoryId?: string;
  totalItems?: number; // Swiggy's dish count for this category
}

export interface FoodCartLine {
  menuItemId: string;
  name: string;
  imageUrl: string;
  quantity: number;
  veg: boolean;
  price: number; // per-unit effective price
  inStock?: boolean; // from get_food_cart `in_stock`
  selection?: FoodCartSelection; // chosen variants / addons (customised dishes)
  detail?: string; // "Large · Extra cheese" (from the Swiggy cart)
  // get_food_cart line totals before / after discounts (subtotal vs final_price)
  lineSubtotal?: number;
  lineFinal?: number;
  // get_food_cart `valid_addons`: the add-on groups Swiggy allows for THIS line's
  // chosen variant (the only add-ons we offer once the dish is in the cart)
  validAddons?: FoodAddonGroup[];
  // the AI's one-line note about what it pre-selected for this line (and why)
  aiNote?: string;
}

/**
 * A Swiggy Food coupon from fetch_food_coupons. Swiggy does not return the
 * rupee value of a coupon up front — `savings` is the REAL discount
 * (`coupon_discount`) once applied, and 0 while unknown.
 */
export interface Coupon {
  code: string;
  title?: string;
  description?: string;
  savings: number;
  // fetch_food_coupons extras
  applicable?: boolean; // false = listed but not valid for this cart yet
  subtitle?: string;
  ribbon?: string; // ribbon_text, e.g. "BEST OFFER"
  section?: string; // coupon_sections[].title
  terms?: string[]; // terms_and_conditions.bullet_texts
}

export interface FoodCart {
  restaurantId: string | null;
  restaurantName: string | null;
  items: FoodCartLine[];
  itemCount: number;
  itemTotal: number;
  taxes: number;
  deliveryCharge: number;
  toPay: number;
  appliedCoupon?: { code: string; savings: number } | null; // applied (coupon_discount > 0)
  // get_food_cart extras (only what Swiggy returned)
  deliveryChargeStrikeoff?: number; // pricing.delivery_charge_strikeoff (pre-discount fee)
  freeDeliveryApplied?: boolean; // offers.free_delivery_applied
  restaurantArea?: string; // restaurant.area
  deliverySubtitle?: string; // restaurant.deliverySubtitle (e.g. "Delivery in 25 mins")
  bestCoupon?: Coupon | null; // an applicable coupon not yet applied (one-tap)
  // true when these lines/prices came from Swiggy's get_food_cart; false when
  // Swiggy couldn't be reached and this is only the locally requested cart
  synced?: boolean;
  notice?: string | null; // a real Swiggy message to show (sync / coupon failure)
  // the cutlery preference the user set (sent as update_food_cart cutleryOptIn);
  // undefined = never set, Swiggy keeps its default
  cutleryOptIn?: boolean;
  // the automatic coupon pass (after a cart change): what was applied, what it
  // saved (Swiggy's real coupon_discount) and why the other coupons don't apply
  couponReport?: FoodCouponReport;
}

/** Result of the automatic best-coupon pass on the food cart. */
export interface FoodCouponReport {
  applied?: { code: string; savings: number; title?: string } | null;
  auto: boolean; // true = the AI applied it (not the user)
  // every other listed coupon, with Swiggy's own reason when it gave one
  others: { code: string; title?: string; reason: string }[];
  message?: string; // one line for the user ("Applied X — saves ₹Y")
}

/** One dish of an agent-proposed meal (ids/prices exactly as Swiggy returned). */
export interface FoodMealPlanItem {
  menuItemId: string;
  name: string;
  quantity: number;
  reason: string; // the AI's 1-line why
  option?: string; // portion / variant wish ("Serves 2"), matched on resolve
  price: number; // Swiggy's base price (variant add-on prices come on resolve)
  veg: boolean;
  imageUrl: string;
  customisable?: boolean; // hasVariants || hasAddons (undefined = not known)
  rating?: string;
  bestseller?: boolean;
}

/** The agent's whole-order proposal from ONE restaurant. */
export interface FoodMealPlan {
  title: string; // "Dinner for 3 · under ₹800 · 1 veg"
  budget?: number;
  people?: number;
  restaurantId: string;
  restaurantName: string;
  items: FoodMealPlanItem[];
  estimate: number; // Σ price × qty of the base prices (before taxes / delivery)
  notes?: string[]; // e.g. a dish dropped because it was from another restaurant
}

export function emptyFoodCart(): FoodCart {
  return {
    restaurantId: null,
    restaurantName: null,
    items: [],
    itemCount: 0,
    itemTotal: 0,
    taxes: 0,
    deliveryCharge: 0,
    toPay: 0,
  };
}

/* ------------------------- Food cart request shape ------------------------- */

export type FoodCartAction =
  | "add"
  | "increment"
  | "decrement"
  | "remove"
  | "clear"
  | "set" // replace the WHOLE desired food cart in one call (coalesced sync)
  | "coupon" // apply the best available coupon (or a specific `couponCode`)
  | "coupons" // list the coupons Swiggy says apply (fetch_food_coupons)
  | "cutlery" // set the cutlery preference (update_food_cart cutleryOptIn)
  | "place";

export interface FoodCartRequest {
  action: FoodCartAction;
  addressId: string;
  restaurantId?: string;
  restaurantName?: string;
  menuItemId?: string;
  // metadata for `add` so the tray renders immediately
  line?: Omit<FoodCartLine, "quantity">;
  quantity?: number;
  // for `set`: the full desired item set (single restaurant).
  items?: { line: Omit<FoodCartLine, "quantity">; quantity: number }[];
  couponCode?: string; // for `coupon`: a specific code; omit to auto-pick the best
  // for `place`: the method the user picked from get_payment_options
  paymentMethod?: string;
  intentApp?: string;
  generateUPIQR?: boolean;
  // for `place`: the total the user saw and confirmed (re-checked server-side)
  amount?: number;
  noteToRestaurant?: string;
  // for `cutlery`: true = send cutlery, false = skip (update_food_cart cutleryOptIn)
  cutleryOptIn?: boolean;
}

/** POST /api/food-cart {action:"place"} response. */
export interface FoodPlaceResult {
  placed: boolean; // true only when Swiggy confirmed the order (Cash / SwiggyPay)
  gated: boolean; // ordering disabled on this server (SWIGGY_ENABLE_ORDERS)
  ok: boolean;
  message: string;
  orderId?: string;
  paymentSession?: PaymentSession; // UPI: built from the real PENDING_PAYMENT response
  cart: FoodCart;
}

/* ------------------------- Component prop API (food) ----------------------- */

export interface FoodRestaurantCardProps {
  restaurant: FoodRestaurant;
  onViewMenu: (restaurant: FoodRestaurant) => void;
}

export interface MenuListProps {
  restaurantId: string;
  restaurantName: string;
  // get_restaurant_menu `restaurant{}` → header (photo, rating, SLA, cost, address)
  restaurant?: FoodRestaurant;
  totalCategories?: number; // "8 categories" (get_restaurant_menu totalCategories)
  totalItems?: number; // search_menu totalItems ("422 matches")
  categories: MenuCategory[];
  inCartQty: (menuItemId: string) => number;
  // `selection` is set when the user customised the dish (variants / addons)
  onAdd: (item: MenuItem, selection?: FoodCartSelection) => void;
  addressId?: string; // to load a dish's customization options (search_menu)
  bestReason?: (menuItemId: string) => string | undefined;
  healthyReason?: (menuItemId: string) => string | undefined;
  warnReason?: (menuItemId: string) => string | undefined;
  onFindBest?: () => void;
  onHealthier?: () => void;
  isSelectedForCompare?: (menuItemId: string) => boolean;
  onToggleCompare?: (item: MenuItem) => void;
  heading?: string; // overrides the "Menu · {name}" header (cross-restaurant)
  showRestaurant?: boolean; // show each dish's restaurant name (cross-restaurant)
  // pagination: restaurant menu → next category page; dish search → nextOffset
  onLoadMore?: () => void;
  loadingMore?: boolean;
  loadMoreLabel?: string;
  // "N more in this category" → search that category inside the restaurant
  onSearchCategory?: (categoryTitle: string) => void;
}

export interface FoodCartPanelProps {
  cart: FoodCart;
  busy?: boolean;
  onIncrement: (menuItemId: string) => void;
  onDecrement: (menuItemId: string) => void;
  onRemove: (menuItemId: string) => void;
  onClear: () => void;
  onPlaceOrder?: () => void;
  onAnalyze?: () => void; // "Analyse my order" (AI health + value)
  budget?: number;
  onTrim?: () => void;
  kcalGoal?: number;
  proteinGoal?: number;
  kcal?: number; // running calories in the order
  protein?: number; // running protein in the order
}

/* --------------------------- Component prop API --------------------------- */
// Shared so the chat-ui and cards agents agree on interfaces.

// A cart line the user picked to REPLACE ("change this to X / I'd prefer brand Y").
// The agent searches for the requested alternative and the app swaps it in: the
// old line is removed and the matched replacement added at the same quantity.
export interface SwapItem {
  kind: "instamart" | "food";
  id: string; // spinId (instamart) or menuItemId (food) of the line being replaced
  name: string;
  imageUrl: string;
  quantity: number;
  restaurantId?: string; // food — re-add the replacement to the same order
  restaurantName?: string;
}

// A product/dish the user picked to compare ("choose best of both").
export interface CompareItem {
  productId: string;
  spinId: string; // for food items this is the menuItemId
  name: string;
  brand: string;
  quantityDescription: string;
  imageUrl: string;
  offerPrice: number;
  mrp: number;
  // which cart an "Add winner" should target, with the metadata to add it
  kind?: "instamart" | "food";
  veg?: boolean; // food
  restaurantId?: string; // food — needed to add to the food cart
  restaurantName?: string; // food
}

export interface ProductCardProps {
  product: Product;
  inCartQty: (spinId: string) => number;
  onAdd: (product: Product, variation: Variation) => void;
  // compare selection (optional — present in chat, omitted elsewhere)
  isSelected?: (spinId: string) => boolean;
  onToggleCompare?: (product: Product, variation: Variation) => void;
  // the agent's "best pick" reason for a variation, if any
  bestReason?: (spinId: string) => string | undefined;
  // the agent's "healthiest" reason for a variation, if any
  healthyReason?: (spinId: string) => string | undefined;
  // allergen warning for a variation, if any
  warnReason?: (spinId: string) => string | undefined;
}

export interface ProductGridProps {
  products: Product[];
  query?: string;
  nextOffset?: string | null;
  loadingMore?: boolean;
  inCartQty: (spinId: string) => number;
  onAdd: (product: Product, variation: Variation) => void;
  onLoadMore?: () => void;
  isSelected?: (spinId: string) => boolean;
  onToggleCompare?: (product: Product, variation: Variation) => void;
  bestReason?: (spinId: string) => string | undefined;
  healthyReason?: (spinId: string) => string | undefined;
  warnReason?: (spinId: string) => string | undefined;
  onFindBest?: () => void; // "✦ Best pick" — ask the agent to recommend one
  onHealthier?: () => void; // "🥗 Healthier" — nutritionist read + better swap
}

export interface CartPanelProps {
  cart: CartState;
  busy?: boolean;
  onIncrement: (spinId: string) => void;
  onDecrement: (spinId: string) => void;
  onRemove: (spinId: string) => void;
  onClear: () => void;
  onCheckout?: () => void;
  onAnalyze?: () => void; // "Analyse my cart" (AI health + value)
  budget?: number; // budget guardrail (0 = off)
  onTrim?: () => void; // "Trim to fit" the budget
}

/* ===========================================================================
   DINEOUT DOMAIN
   Restaurant table discovery, slot availability, deals, and reservations.
   =========================================================================== */

// Field names follow the LIVE Swiggy responses (docs/swiggy-mcp/LIVE-SAMPLES.md):
// search_restaurants_dineout (text lines) → render_restaurants_dineout (card
// JSON with photos) and get_restaurant_details. Optional fields are simply
// absent when Swiggy omits them — nothing is defaulted or invented.
export interface DineoutRestaurant {
  id: string; // restaurants[].id / restaurant.id — the restaurantId for follow-ups
  name: string;
  cuisines: string[];
  rating?: number; // rating.value (render, "--" → absent) / avgRating (details)
  ratingCount?: number;
  costForTwo?: string; // Swiggy's display string, e.g. "₹1000 for two"
  area?: string;
  locality?: string;
  address?: string;
  distance?: string; // Swiggy's display string, e.g. "2.3 km"
  timings?: string;
  offers?: string[]; // offers[].offerTitle (render) / offers[].title — description (details)
  // the same offers with every field Swiggy sent (description, % off, cover charge…)
  offerDetails?: DineoutOffer[];
  offerHeadline?: DineoutOfferHeadline;
  bankOffers?: string[]; // render bankOffers[].offerTitle (pay-with-bank offers)
  highlights?: string[]; // render highlights[] (amenity-like facts)
  vendorHighlights?: string[]; // render vendorHighlights[].text — the restaurant's own perks ("Free Beer")
  deals?: string[]; // availableDeals[].dealTitle / restaurant.deals[].title
  dealDetails?: DineoutOffer[]; // details restaurant.deals[] with every field
  partnerType?: string; // render/details partnerType: "PR" takes table bookings, "NPR" is listed only
  source?: string; // render `source` (e.g. "autosuggest" for name matches that are listing-only)
  // Takes table bookings on Swiggy: false = partnerType "NPR" (walk-in only, no
  // Reserve); true = "PR" / "Table booking" perk / "Reservation available";
  // undefined = unknown (text-only search fallback).
  bookable?: boolean;
  amenities?: string[];
  imageUrl?: string;
  mastheadImageUrls?: string[];
  menuImageGroups?: { title: string; images: { imageUrl: string; label?: string }[] }[];
  locationMapUrl?: string;
  description?: string;
  // true once get_restaurant_details filled the fields above (details sheet)
  hasDetails?: boolean;
  // coordinates the search/details response echoed — reused for slots + booking
  latitude?: number;
  longitude?: number;
}

/** render_restaurants_dineout `offerHeadline` (the card's headline offer). */
export interface DineoutOfferHeadline {
  title: string; // "Flat 15% off"
  subtitle?: string; // "on pre-booking"
  subtext?: string; // "+1 offer"
  kind?: string; // "deal" | "payment"
  logoUrl?: string; // Swiggy's offer badge image (live `offerHeadline.logoUrl`)
  logoText?: string; // badge wording next to the logo, e.g. "ONE" (Swiggy One)
}

/** One restaurant offer / deal, field-for-field (render offers[] or details deals[] / offers[]). */
export interface DineoutOffer {
  title: string; // "Flat 15% off on Total Bill"
  description?: string; // "Available on Mon-Sun" / render offerDescription "Total bill"
  discountPercentage?: number; // details only
  coverCharge?: number; // details only; ₹ charged up front (0 = none)
  slotGroupName?: string; // details only, e.g. "Pre-booking offers"
  offerCategory?: string; // details only, e.g. "prebooking"
}

/** search_restaurants_dineout paging (from the "Found N … offset=X" text header). */
export interface DineoutPaging {
  query: string;
  latitude: number;
  longitude: number;
  total?: number; // "Found 28 restaurant(s)"
  nextOffset?: number; // "call again with offset=10"; absent = no more
}

/** One bookable deal inside a slot (get_available_slots slots[].deals[]). */
export interface DineoutDeal {
  itemId: string; // "restaurantId-ticketId" — pass to create_cart / book_table
  ticketId: string;
  slotId: number; // pass to create_cart / book_table
  title?: string;
  isFree: boolean; // false (or bookingPrice > 0) => PAID prebook deal
  bookingPrice?: number;
  displayFee?: string;
  discountPercentage?: number;
  dealCategory?: string;
  availableInventory?: number;
  soldOut?: boolean;
}

/** One reservation time (get_available_slots `_meta.slots[]`). */
export interface DineoutSlot {
  key: string; // `${dateStr}|${reservationTime}` — unique per slot (slotId is NOT)
  slotId: number; // deals[0].slotId (the slot itself carries none) — prefer deal.slotId
  dateStr: string; // YYYY-MM-DD
  displayTime: string; // "07:30 PM"
  reservationTime: number; // unix seconds (Swiggy sends a numeric string) — echoed to create_cart / book_table
  slotGroupName: string; // Breakfast | Lunch | Dinner
  availableInventory?: number; // absent in live data; 0 only when Swiggy says so
  subText?: string; // e.g. "15% off"
  daySubtext?: string; // the whole day's headline, e.g. "15% off" (shown on the date chip)
  deals: DineoutDeal[];
}

/** A get_available_slots result as rendered in chat (7 days from one call). */
export interface DineoutSlotsView {
  restaurantId: string;
  restaurantName: string;
  latitude: number;
  longitude: number;
  slots: DineoutSlot[];
}

/** What the slot picker hands the app when the user confirms a reservation. */
export interface DineoutSlotChoice {
  slot: DineoutSlot;
  deal: DineoutDeal;
  latitude: number;
  longitude: number;
  // paid deals only: the create_cart result + the UPI method the user picked
  payment?: {
    cartKey: string;
    amount?: number;
    intentApp?: string;
    generateUPIQR?: boolean;
  };
}

/** create_cart (DEAL_TICKET_PURCHASE) result shown as the Booking Summary. */
export interface DineoutCart {
  cartKey: string;
  cartId?: string;
  billToPay?: number;
  skipPayment?: boolean;
}

/** book_table FREE result / get_booking_status result. */
export interface DineoutBooking {
  orderId: string;
  status: string;
  restaurantId?: string;
  restaurantName?: string;
  restaurantLocation?: string;
  reservationDate?: string;
  reservationTime?: string; // display string in the response
  guestCount?: number;
  dealTitle?: string;
  amount?: number; // bill.totalBillAmount (₹ paid for a paid deal)
}

export interface DineoutRestaurantCardProps {
  restaurant: DineoutRestaurant;
  onViewSlots?: (restaurant: DineoutRestaurant) => void;
}

/* ===========================================================================
   SCENES DOMAIN
   Live shows, stand-up comedy gigs, screenings, events, and ticketing.
   =========================================================================== */

// Field-for-field from the LIVE Scenes payloads (docs/swiggy-mcp/LIVE-SAMPLES.md).
// Scenes responses carry no images; `priceText` is Swiggy's display string
// (often empty), kept verbatim.
export interface ScenesEvent {
  id: string; // eventId
  title: string; // eventName
  venueName: string;
  area?: string; // area (discover/details) or the locality part of search_events `location`
  city?: string; // the city part of search_events `location` ("Indiranagar, Bangalore" → "Bangalore")
  venueAddress?: string; // formattedAddress (get_event_details)
  dateSummary?: string; // date | upcomingDate ("23rd Oct • 10:00 PM onwards")
  priceText?: string; // price
  venueId?: string; // only from get_event_details
  venueLatitude?: number; // get_event_details venueLat (the VENUE, not the user)
  venueLongitude?: number; // get_event_details venueLng
  // the USER coordinates this event was found with — reused for every follow-up call
  latitude?: number;
  longitude?: number;
  // Only from get_event_venue_info (eventShowListing.eventInfo / venueDetails[]):
  distanceKm?: number; // venueDetails[].distance (metres) → km from the user
  languages?: string[]; // eventInfo.languages
  ageGroup?: string; // eventInfo.ageGroup
  duration?: string; // eventInfo.eventDuration ("1 hr")
  seating?: string; // eventInfo.seatingArrangement ("Seated" / "Standing & seated")
  rewards?: string; // eventInfo.rewardsWidget.title, image markup stripped ("Earn 10% DineCash on ticket booking")
  showCount?: number; // shows at THIS venue in the listing window
}

/** A genre chip from discover_events (`collectionIdentifier` + `label`). */
export interface ScenesCollection {
  id: string;
  label: string;
}

/** One ticket tier of a show: list_event_shows `tickets[]` ({id, name, price.price.units …}). */
export interface ScenesTicket {
  ticketId: string; // tickets[].id (string) — create_event_cart.ticketId verbatim
  title: string; // tickets[].name
  price?: number; // the price the user pays: discountedPrice.units (else price.units), rupees
  originalPrice?: number; // price.price.units when higher than `price` (a real discount)
  coverCharge?: number; // coverCharge.units when > 0
  availableInventory?: number; // seats left for this tier
  onSale: boolean; // status ON_SALE (or no status) and inventory not 0
  tnc?: string; // plain-text terms (HTML stripped)
}

export interface ScenesShow {
  showId: string; // eventShow[].id, verbatim (create_event_cart wants it as a number → Number(showId))
  showTimeIst: string; // show_time_ist — display verbatim
  showTimeUnix: number; // show_time_unix (epoch s) — create_event_cart.showTime verbatim
  date?: string; // the date group, "YYYY-MM-DD"
  availableSeats?: number; // maxAvailableInventory
  minGuests?: number; // purchaseRules.allowedCovers.min
  maxGuests?: number; // purchaseRules.allowedCovers.max
  onSale: boolean;
  tickets: ScenesTicket[];
  endTimeUnix?: number; // timeRange.endTime (epoch s), for calendar entries
  durationMin?: number; // timeRange end − start, minutes (this show's real length)
  gatesOpenUnix?: number; // gatePreopenedAt (epoch s) — when doors open, if Swiggy says
  venueId?: string; // eventShow[].venue.venueId (listings without a venue filter span venues)
  auditorium?: string; // venueDetails[].auditoriums[] name matching eventShow[].auditoriumId
}

/** list_event_shows for ONE venue (a listing without venueId is not bookable). */
export interface ScenesShowListing {
  eventId: string;
  eventTitle: string;
  venueId?: string;
  venueName?: string;
  venueAddress?: string;
  venueArea?: string; // venueDetails[].localityDisplayName
  city?: string; // venueDetails[].cityDisplayName
  languages?: string[]; // eventInfo.languages
  ageGroup?: string; // eventInfo.ageGroup
  duration?: string; // eventInfo.eventDuration, e.g. "1 hr"
  tags?: string[]; // eventInfo.tags (human-readable ones only)
  dateSummary?: string; // get_event_details upcomingDate, when known
  latitude?: number;
  longitude?: number;
  shows: ScenesShow[];
  // eventShowListing.dateSummary: seats left per date (live)
  dates?: { date: string; available?: number; onSale: boolean }[];
  venueLatitude?: number; // venueDetails[].location.latLng (the venue)
  venueLongitude?: number;
  venueDistanceKm?: number; // venueDetails[].distance (metres from the user) → km
  // eventInfo extras — each only when Swiggy filled it (most are empty live today)
  seating?: string; // seatingArrangement → "Seated" | "Standing" | "Standing & seated"
  recurring?: boolean; // eventInfo.recurring (a regular night, not a one-off)
  runFromUnix?: number; // eventInfo.timeRange.startTime (epoch s) — the event's whole run
  runUntilUnix?: number; // eventInfo.timeRange.endTime
  rewards?: string; // rewardsWidget.title without the {{img|…}} markup
  rewardsLogo?: string; // rewardsWidget.logo (a real Swiggy asset URL)
  description?: string; // eventInfo.description (HTML → text)
  category?: string; // eventInfo.eventCategory.name
  artists?: string[]; // eventInfo.artists[] names
  organizer?: string; // eventInfo.organizer name
  tour?: string; // eventInfo.tour name
  thingsToRemember?: string[]; // eventInfo.thingsToRemember[] (HTML → text)
  eventTnc?: string; // eventInfo.tnc (HTML → text)
  startPrice?: number; // eventInfo.ticketStartPrice, else the lowest on-sale ticket price listed
}

/** The exact create_event_cart arguments (echoed again for a FREE place_event_order). */
export interface ScenesSelection {
  venueId: string;
  showId: number;
  ticketId: string;
  showTime: number;
  guestCount: number; // 1–20
  latitude: number;
  longitude: number;
}

/** create_event_cart result — `summary` is the authoritative text the user confirms. */
export interface ScenesCart {
  cartKey: string;
  checkoutMode: "FREE" | "UPI" | "UNAVAILABLE";
  billToPay?: number;
  skipPayment?: boolean;
  summary?: string;
  selection: ScenesSelection;
}

/** A placed / looked-up ticket booking (place_event_order FREE or get_event_booking_status). */
export interface ScenesBooking {
  orderId: string;
  status: string; // verbatim: CONFIRMED | PROCESSING | …
  cartKey?: string;
  title?: string; // dealTitle
  venueName?: string; // restaurantName
  venueLocation?: string; // restaurantLocation
  date?: string; // reservationDate (show date)
  time?: string; // reservationTime (show time)
  guestCount?: number;
  totalAmount?: number;
}

/** What the ticket picker hands back after place_event_order. */
export type ScenesOrderOutcome =
  | { kind: "upi"; session: PaymentSession; options?: PaymentOptionsPayload }
  | { kind: "free"; booking: ScenesBooking; message?: string };

/* ===========================================================================
   UNIVERSAL PAYMENT SYSTEM
   Shared Payment Stage across Food, Instamart, Dineout, and Scenes.
   =========================================================================== */

export type PaymentMethodGroup = "UPI" | "Cash" | "SwiggyPay" | string;

export interface PaymentMethodItem {
  id: string;
  name: string;
  displayName?: string;
  paymentMethod: PaymentMethodGroup;
  groupName?: string;
  intentApp?: string;
  kind?: "intent" | "qr" | "wallet" | "cod" | string;
  isQr?: boolean;
  iconUrl?: string;
  description?: string;
  enabled?: boolean;
}

export interface PaymentOptionsPayload {
  allMethods: PaymentMethodItem[];
  platforms?: {
    mobile?: { groupName?: string; methods: PaymentMethodItem[] };
    desktop?: { groupName?: string; methods: PaymentMethodItem[] };
  };
  cod?: {
    available?: boolean;
    eligible?: boolean;
    id?: string;
    displayName?: string;
    fee?: number;
    message?: string;
  };
  swiggyMoney?: {
    available?: boolean;
    id?: string;
    displayName?: string;
  };
  /** Payable total as returned by get_payment_options, when Swiggy sends one. */
  paymentAmount: number | null;
  addressId?: string;
  placeOrderToolName: string;
  agenticPaymentEligible?: boolean;
}

/**
 * A UPI payment in progress, built ONLY from a real place-order response
 * (checkout / place_food_order / book_table / place_event_order with
 * status PENDING_PAYMENT). Never synthesise ids or URLs.
 */
export interface PaymentSession {
  orderId: string;
  paasId?: string;
  transactionId?: string;
  bridgeUrl?: string;
  upiIntentUrl?: string;
  isQrFlow?: boolean;
  // Echo fields some servers require on check_payment_status / confirm_order
  // (Food: addressId, cartId, lat, lng; Scenes/Dineout: cartKey).
  echo?: { addressId?: string; cartId?: string; lat?: number; lng?: number; cartKey?: string };
  paymentMethod: PaymentMethodGroup;
  status: "pending" | "success" | "paid" | "failed" | "cancelled" | "cart_changed" | "refund-initiated";
  pollingIntervalInMs: number;
  maxTimeToPollForInMs: number;
  confirmed?: boolean;
  amount: number;
  service: Service;
  title?: string;
}

/** One check_payment_status iteration (docs/swiggy-mcp/platform.md §6.4). */
export interface PaymentStatusResult {
  /** Swiggy's status, lower-cased (success | paid | failed | cancelled | cart_changed | refund-initiated | pending | …). */
  status: string;
  terminal: boolean;
  isTerminalSuccess: boolean;
  isTerminalFailure: boolean;
  /** true = the order was already finalized server-side; do NOT call confirm_order. */
  confirmed: boolean;
  orderStatus?: string;
  message?: string;
}

/** confirm_order outcome: only `success` means the order is placed. */
export interface PaymentConfirmResult {
  result: "success" | "failed" | "pending" | string;
  orderId: string;
  orderStatus?: string;
  message?: string;
}

/* ===========================================================================
   ADDRESS MANAGEMENT (create_address / delete_address)
   =========================================================================== */

export interface CreateAddressInput {
  fullAddress: string;
  addressTag: "Home" | "Work" | "Other";
  flatNo?: string;
  landmark?: string;
  receiverName?: string;
  receiverPhone?: string;
  latitude?: number;
  longitude?: number;
}


/** One order from get_food_orders / get_orders, as shown in the order-history card. */
export interface PastOrder {
  orderId: string;
  title: string; // restaurant / store name
  items?: string; // "Chicken Dum Biryani (1), …"
  status: string; // Delivered / cancelled / On the way…
  total?: string; // "₹341"
  placedAt?: string; // "October 14, 3:11 PM"
  area?: string;
  imageUrl?: string;
  active: boolean;
  reorderable?: boolean;
  // Food get_food_orders extras
  orderType?: string; // "regular" …
  rateActions?: string[]; // enabled RATE_* CTAs ("Rate delivery") — rating only in the Swiggy app
  restaurantId?: string;
}

/** One past order's full detail (Food get_food_order_details), for the order-history card. */
export interface OrderDetails {
  orderId: string;
  title?: string; // restaurant name
  area?: string;
  status?: string;
  placedAt?: string;
  items: {
    name: string;
    quantity?: number;
    price?: string; // "₹299"
    customizations?: string; // "Full · Extra raita"
    isVeg?: boolean;
    imageUrl?: string;
  }[];
  charges: { label: string; amount: string }[]; // Swiggy's own charge lines
  total?: string;
  paymentMethod?: string;
  deliveryAddress?: string;
  coupon?: string;
  cancellable?: boolean;
  // Swiggy's own text when it returned no structured body (shown verbatim)
  text?: string;
}
