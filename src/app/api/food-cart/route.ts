// /api/food-cart — deterministic food cart. The agent is read-only, so all
// food-cart mutations happen here, after a user action in the UI.
//
// Swiggy's server-side cart (get_food_cart) is the source of truth: every
// response's lines, prices and totals come from Swiggy. We only keep the
// user's DESIRED line set per addressId (single restaurant) so we can drive
// update_food_cart to it (update_food_cart doesn't remove unlisted lines). When
// Swiggy can't be reached we return the requested lines with `synced:false`
// and Swiggy's error in `notice` — never invented prices.
//
// Zero-lag: the hook updates its tray optimistically and coalesces rapid taps
// into a single `set` POST; this route does the real Swiggy round-trip and
// returns the authoritative cart (+ an applicable coupon) for reconcile.

import { isAuthError, ordersEnabled } from '@/backend/config/env';
import { idStr } from '@/backend/mcp/client';
import {
  applyFoodCoupon,
  fetchFoodCoupons,
  flushFoodCart,
  getFoodCart,
  getFoodOrders,
  mapFoodCart,
  placeFoodOrder,
  updateFoodCart,
  type DesiredFoodItem,
} from '@/backend/mcp/food-mcp';
import { getPaymentOptions, paymentSessionFromPlaceOrder } from '@/backend/mcp/payment-mcp';
import { FOOD_ORDER_CAP, emptyFoodCart } from '@/shared/types';
import type {
  Coupon,
  FoodCart,
  FoodCartLine,
  FoodCartRequest,
  FoodCouponReport,
  FoodPlaceResult,
} from '@/shared/types';
import { groupMax, pickDefaultAddons } from '@/shared/foodAi';
import { route, unauthorized as unauthorizedResponse, UserScopedMap } from "@/backend/http/route";
import { AddressOnlyQuery, FoodCartBody } from "@/backend/http/schemas";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface CartEntry {
  restaurantId: string;
  restaurantName: string;
  items: Map<string, FoodCartLine>; // menuItemId -> desired line
  // A coupon the user applied. A flush clears Swiggy's coupon, so after a
  // rebuild we re-apply it once if Swiggy no longer shows it applied.
  couponCode?: string | null;
  // The user's cutlery choice, re-sent on every update_food_cart (cutleryOptIn).
  cutleryOptIn?: boolean;
  // The user picked a coupon themselves — the automatic pass leaves it alone.
  couponManual?: boolean;
  // Automatic best-coupon pass: the cart signature it last ran for + its report.
  autoCouponSig?: string;
  couponReport?: FoodCouponReport;
}

// addressId -> desired cart, namespaced by the signed-in user (UserScopedMap)
// so one account can never read or write another account's desired cart.
const carts = new UserScopedMap<CartEntry>();

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function errMessage(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}

// Serialize writes per addressId so concurrent POSTs can't interleave their
// update→read steps (the hook keeps one sync in flight; this backstops it).
const addressLocks = new UserScopedMap<Promise<unknown>>();
function withAddressLock<T>(addressId: string, fn: () => Promise<T>): Promise<T> {
  const prev = addressLocks.get(addressId) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  addressLocks.set(addressId, next.then(() => {}, () => {}));
  return next;
}

const unauthorized = () => unauthorizedResponse();

/* -------------------------------- coupons --------------------------------- */
// Cache the applicable coupons per address+restaurant so `bestCoupon` can be
// filled on mutation responses without a fetch on the hot path.

const COUPON_TTL = 120_000; // 2 min
// every coupon fetch_food_coupons lists (applicable or not) + Swiggy's filter note
const couponCache = new UserScopedMap<{ coupons: Coupon[]; filter?: string; ts: number }>();
const couponFilters = new UserScopedMap<string>();

/** Only coupons Swiggy marks applicable to this cart may be one-tap applied. */
const applicableOnly = (coupons: Coupon[]) => coupons.filter((c) => c.applicable !== false);

async function getCoupons(
  addressId: string,
  restaurantId: string,
  fetchIfStale: boolean,
): Promise<Coupon[]> {
  const key = `${addressId}::${restaurantId}`;
  const hit = couponCache.get(key);
  if (hit && Date.now() - hit.ts < COUPON_TTL) return hit.coupons;
  if (!fetchIfStale) return hit?.coupons ?? [];
  try {
    const { coupons, filter } = await fetchFoodCoupons(addressId, restaurantId);
    couponCache.set(key, { coupons, filter, ts: Date.now() });
    if (filter) couponFilters.set(key, filter);
    return coupons;
  } catch (err) {
    if (isAuthError(err)) throw err;
    console.error("[api/food-cart] fetch_food_coupons failed:", err);
    return hit?.coupons ?? [];
  }
}

/**
 * Fill `bestCoupon` with an applicable coupon that isn't applied yet. Swiggy
 * gives no rupee value up front, so it is shown by code/title only. On the
 * mutation path coupons come from cache (warmed in the background).
 */
async function withBestCoupon(cart: FoodCart, addressId: string, allowFetch: boolean): Promise<FoodCart> {
  if (cart.items.length === 0 || !cart.restaurantId || !cart.synced) return cart;
  const rid = cart.restaurantId;
  const coupons = applicableOnly(await getCoupons(addressId, rid, allowFetch));
  if (!allowFetch) void getCoupons(addressId, rid, true).catch(() => {});
  const applied = cart.appliedCoupon?.code?.toUpperCase();
  const next = coupons.find((c) => c.code.toUpperCase() !== applied);
  if (next) return { ...cart, bestCoupon: next };
  return applied ? { ...cart, bestCoupon: null } : cart;
}

/* --------------------------------- helpers --------------------------------- */

function liveLines(entry: CartEntry): FoodCartLine[] {
  return [...entry.items.values()].filter((l) => l.quantity > 0);
}

function desiredItems(entry: CartEntry): DesiredFoodItem[] {
  return liveLines(entry).map((l) => ({
    menuItemId: l.menuItemId,
    quantity: l.quantity,
    selection: l.selection,
  }));
}

/**
 * The response cart. With `remote` (Swiggy's get_food_cart), lines and money
 * are Swiggy's; we only carry over the local image / chosen customization for
 * display. Without it, the requested lines are returned unsynced.
 */
function buildCart(entry: CartEntry | undefined, remote: FoodCart | null, notice?: string | null): FoodCart {
  if (remote) {
    const local = entry?.items;
    const items = remote.items.map((l) => {
      const mine = local?.get(l.menuItemId);
      return {
        ...l,
        imageUrl: l.imageUrl || mine?.imageUrl || "",
        // the user's / AI's selection (search_menu ids + format); else what Swiggy holds
        selection: mine?.selection ?? l.selection,
        ...(mine?.aiNote ? { aiNote: mine.aiNote } : {}),
      };
    });
    return {
      ...remote,
      items,
      restaurantId: remote.restaurantId || entry?.restaurantId || null,
      restaurantName: remote.restaurantName || entry?.restaurantName || null,
      synced: true,
      notice: notice ?? null,
      ...(typeof entry?.cutleryOptIn === "boolean" ? { cutleryOptIn: entry.cutleryOptIn } : {}),
      ...(entry?.couponReport ? { couponReport: entry.couponReport } : {}),
    };
  }
  if (!entry) return { ...emptyFoodCart(), notice: notice ?? null };
  const items = liveLines(entry);
  if (items.length === 0) return { ...emptyFoodCart(), notice: notice ?? null };
  const itemTotal = items.reduce((s, l) => s + l.price * l.quantity, 0);
  return {
    restaurantId: entry.restaurantId || null,
    restaurantName: entry.restaurantName || null,
    items,
    itemCount: items.reduce((s, l) => s + l.quantity, 0),
    itemTotal,
    taxes: 0,
    deliveryCharge: 0,
    toPay: itemTotal,
    appliedCoupon: null,
    synced: false,
    notice: notice ?? "Couldn't reach Swiggy to update your cart — prices aren't confirmed yet.",
  };
}

/** Adopt a cart that exists on Swiggy (e.g. built in the Swiggy app) as our desired set. */
function adoptRemote(addressId: string, remote: FoodCart): CartEntry | undefined {
  if (remote.items.length === 0 || !remote.restaurantId) return undefined;
  const entry: CartEntry = {
    restaurantId: remote.restaurantId,
    restaurantName: remote.restaurantName ?? "",
    items: new Map(remote.items.map((l) => [l.menuItemId, { ...l }])),
    couponCode: remote.appliedCoupon?.code ?? null,
  };
  carts.set(addressId, entry);
  return entry;
}

/**
 * Drive Swiggy's cart to the entry and return Swiggy's cart. Throws only on
 * auth; a Swiggy / network failure returns the unsynced local cart + notice.
 */
async function syncAndBuild(addressId: string, entry: CartEntry): Promise<FoodCart> {
  const items = liveLines(entry);
  try {
    if (items.length === 0) {
      carts.delete(addressId);
      await flushFoodCart();
      return { ...emptyFoodCart(), synced: true };
    }
    const data = await updateFoodCart(addressId, entry.restaurantId, entry.restaurantName, desiredItems(entry), {
      cutleryOptIn: entry.cutleryOptIn,
    });
    let remote = data ? mapFoodCart(data) : { ...emptyFoodCart(), synced: true };
    let notice: string | null = null;

    // Customised dishes: the variant went in first; now offer ONLY the add-ons
    // Swiggy lists in the cart's valid_addons for that variant — drop picks it
    // doesn't list, AI-pick the required ones — and push once more.
    if (reconcileAddons(entry, remote)) {
      const again = await updateFoodCart(addressId, entry.restaurantId, entry.restaurantName, desiredItems(entry), {
        cutleryOptIn: entry.cutleryOptIn,
      });
      if (again) remote = mapFoodCart(again);
    }

    // Sticky coupon: re-apply once if the rebuild dropped it.
    if (entry.couponCode && !remote.appliedCoupon) {
      const code = entry.couponCode;
      try {
        const res = await applyFoodCoupon(addressId, code);
        if (res.applied) {
          remote = await getFoodCart(addressId, entry.restaurantName);
        } else {
          entry.couponCode = null;
          notice = `Coupon ${code} no longer applies to this cart.`;
        }
      } catch (err) {
        if (isAuthError(err)) throw err;
        entry.couponCode = null;
        notice = `Coupon ${code} was removed: ${errMessage(err, "it no longer applies")}`;
      }
    }
    remote = await autoCoupon(addressId, entry, remote);
    return buildCart(entry, remote, notice);
  } catch (err) {
    if (isAuthError(err)) throw err;
    console.error("[api/food-cart] Swiggy sync failed:", err);
    return buildCart(entry, null, errMessage(err, "Couldn't update your Swiggy cart."));
  }
}

/**
 * Align each customised line with Swiggy's `valid_addons` for its variant
 * (update_food_cart docs: add the variant first, then pick from valid_addons;
 * never send more than maxAddons per group). Picks Swiggy no longer lists are
 * dropped; every REQUIRED group without enough picks gets the AI default (the
 * fullest free option, else the cheapest) with a one-line note on the line.
 * Returns true when the desired cart changed and must be pushed again.
 */
function reconcileAddons(entry: CartEntry, remote: FoodCart): boolean {
  let changed = false;
  for (const line of liveLines(entry)) {
    const valid = remote.items.find((r) => r.menuItemId === line.menuItemId)?.validAddons;
    if (!valid) continue; // Swiggy didn't list valid_addons for this line
    const sel = line.selection ?? remote.items.find((r) => r.menuItemId === line.menuItemId)?.selection;
    const current = sel?.addons ?? [];
    const kept: NonNullable<FoodCartLine["selection"]>["addons"] = [];
    const dropped: string[] = [];
    for (const a of current) {
      const g = valid.find((x) => x.groupId === a.groupId);
      const ok = g?.choices.some((c) => c.id === a.choiceId);
      const room = g ? kept.filter((k) => k.groupId === g.groupId).length < groupMax(g) : false;
      if (ok && room) kept.push(a);
      else dropped.push(a.name || a.choiceId);
    }
    const missing = valid.filter((g) => g.min > 0 && kept.filter((k) => k.groupId === g.groupId).length < g.min);
    const auto = pickDefaultAddons(
      missing.map((g) => ({ ...g, min: g.min - kept.filter((k) => k.groupId === g.groupId).length })),
    );
    if (!dropped.length && !auto.addons.length) continue;
    line.selection = {
      format: sel?.format ?? "none",
      variants: sel?.variants ?? [],
      addons: [...kept, ...auto.addons],
    };
    const notes = [
      auto.reasons.length ? `AI picked ${auto.reasons.join("; ")}` : "",
      dropped.length ? `removed ${dropped.join(", ")} (not offered for this option)` : "",
    ].filter(Boolean);
    line.aiNote = `${notes.join(" · ")} — from Swiggy's options for this dish. Tap Customise to change.`;
    changed = true;
  }
  return changed;
}

/** What the automatic coupon pass keys on: the restaurant and its exact lines. */
function cartSignature(cart: FoodCart): string {
  return [
    cart.restaurantId ?? "",
    ...cart.items.map((l) => `${l.menuItemId}x${l.quantity}:${(l.selection?.variants ?? []).map((v) => v.variationId).join(",")}`).sort(),
  ].join("|");
}

/**
 * After a cart change: find and apply the best coupon Swiggy lists as
 * applicable (apply_food_coupon is a cart operation; the order still needs the
 * user's tap). fetch_food_coupons gives no rupee value, so up to 3 applicable
 * coupons are tried and the largest REAL coupon_discount wins; the cart is
 * re-read and the report says what was applied, what it saves, and Swiggy's
 * reason for every other coupon. Skipped when the user chose a coupon.
 */
async function autoCoupon(addressId: string, entry: CartEntry, remote: FoodCart): Promise<FoodCart> {
  if (!remote.items.length || !remote.restaurantId) {
    entry.couponReport = undefined;
    return remote;
  }
  const sig = cartSignature(remote);
  if (entry.autoCouponSig === sig && entry.couponReport) return remote;
  entry.autoCouponSig = sig;

  const all = await getCoupons(addressId, remote.restaurantId, true);
  const others: FoodCouponReport["others"] = all
    .filter((c) => c.applicable === false)
    .map((c) => ({
      code: c.code,
      ...(c.title ? { title: c.title } : {}),
      reason: c.subtitle || c.description || "Swiggy says it doesn't apply to this cart yet",
    }));
  const appliedNow = remote.appliedCoupon ? { code: remote.appliedCoupon.code, savings: remote.appliedCoupon.savings } : null;

  if (entry.couponManual) {
    entry.couponReport = { applied: appliedNow, auto: false, others, ...(appliedNow ? { message: `${appliedNow.code} saves ₹${appliedNow.savings}` } : {}) };
    return remote;
  }

  const applicable = all.filter((c) => c.applicable !== false).slice(0, 3);
  let best: { code: string; savings: number; title?: string } | null = appliedNow;
  let current = appliedNow?.code ?? null; // the coupon Swiggy holds right now
  for (const c of applicable) {
    if (best && c.code.toUpperCase() === best.code.toUpperCase()) continue;
    try {
      const res = await applyFoodCoupon(addressId, c.code);
      if (res.applied) current = c.code;
      if (res.applied && res.discount > (best?.savings ?? 0)) {
        if (best) others.push({ code: best.code, reason: `saves ₹${best.savings} — ${c.code} saves more` });
        best = { code: c.code, savings: res.discount, ...(c.title ? { title: c.title } : {}) };
      } else {
        others.push({
          code: c.code,
          ...(c.title ? { title: c.title } : {}),
          reason: res.applied
            ? `saves ₹${res.discount} — less than ${best?.code ?? "the applied coupon"}`
            : res.message || "Swiggy gave no discount on this cart",
        });
      }
    } catch (err) {
      if (isAuthError(err)) throw err;
      others.push({ code: c.code, ...(c.title ? { title: c.title } : {}), reason: errMessage(err, "Swiggy rejected it for this cart") });
    }
  }
  let next = remote;
  if (applicable.length) {
    try {
      // the best one must be the coupon Swiggy holds at the end
      if (best && current?.toUpperCase() !== best.code.toUpperCase()) await applyFoodCoupon(addressId, best.code);
      next = await getFoodCart(addressId, entry.restaurantName);
    } catch (err) {
      if (isAuthError(err)) throw err;
      console.error("[api/food-cart] auto coupon re-read failed:", err);
    }
  }
  const real = next.appliedCoupon; // only coupon_discount > 0 counts
  if (real) entry.couponCode = real.code;
  const applied = real
    ? { code: real.code, savings: real.savings, ...(best?.code === real.code && best.title ? { title: best.title } : {}) }
    : null;
  entry.couponReport = {
    applied,
    auto: Boolean(applied && (!appliedNow || appliedNow.code !== applied.code)),
    others: others.filter((o) => o.code.toUpperCase() !== applied?.code.toUpperCase()),
    message: applied
      ? `Applied ${applied.code} — saves ₹${applied.savings}`
      : applicable.length
        ? "Tried the coupons Swiggy lists for this cart — none gives a discount right now."
        : all.length
          ? "No coupon applies to this cart yet."
          : undefined,
  };
  return next;
}

/* ---------------------------------- routes --------------------------------- */

export const GET = route({ name: "api/food-cart", rateLimit: "read", query: AddressOnlyQuery }, async function GET(request: Request): Promise<Response> {
  const addressId = (new URL(request.url).searchParams.get("addressId") ?? "").trim();
  if (!addressId) return Response.json(emptyFoodCart());
  let entry = carts.get(addressId);

  try {
    const remote = await getFoodCart(addressId, entry?.restaurantName);
    // Nothing requested locally yet: show whatever Swiggy holds for this user.
    if (!entry) entry = adoptRemote(addressId, remote);
    const cart = buildCart(entry, remote);
    return Response.json(await withBestCoupon(cart, addressId, true));
  } catch (err) {
    if (isAuthError(err)) return unauthorized();
    console.error("[api/food-cart] get_food_cart failed:", err);
    return Response.json(buildCart(entry, null, errMessage(err, "Couldn't load your Swiggy cart.")));
  }
});

export const POST = route(
  {
    name: "api/food-cart",
    body: FoodCartBody,
    maxBodyBytes: 256 * 1024,
    // placing an order is an order-class action with double-submit protection
    rateLimit: (b) => (b.action === "place" ? "order" : "mutate"),
    idempotent: (b) => (b.action === "place" ? "food:place" : null),
  },
  async function POST(request: Request): Promise<Response> {
  let body: FoodCartRequest;
  try {
    body = (await request.json()) as FoodCartRequest;
  } catch {
    return Response.json(emptyFoodCart(), { status: 400 });
  }

  const addressId = typeof body.addressId === "string" ? body.addressId.trim() : "";
  if (!addressId) {
    return Response.json({ ...emptyFoodCart(), notice: "Pick a delivery address first." }, { status: 400 });
  }
  try {
    return await withAddressLock(addressId, () => handlePost(addressId, body));
  } catch (err) {
    if (isAuthError(err)) return unauthorized();
    throw err;
  }
});

async function handlePost(addressId: string, body: FoodCartRequest): Promise<Response> {
  const action = (body.action as string) ?? "";
  const menuItemId = typeof body.menuItemId === "string" ? body.menuItemId : "";
  const qty = typeof body.quantity === "number" && body.quantity > 0 ? body.quantity : 1;

  // Place an order (gated + verified against Swiggy's cart).
  if (action === "place") return Response.json(await handlePlace(addressId, body));

  // Apply the best (or a specific) coupon and re-read the discounted cart.
  if (action === "coupon") return handleCoupon(addressId, body.couponCode);

  // List the coupons Swiggy says apply to this cart (fetch_food_coupons; read-only).
  if (action === "coupons") {
    const rid = carts.get(addressId)?.restaurantId || "";
    if (!rid) return Response.json({ ok: true, coupons: [] });
    try {
      const coupons = await getCoupons(addressId, rid, true);
      const filter = couponFilters.get(`${addressId}::${rid}`);
      return Response.json({ ok: true, coupons, ...(filter ? { filter } : {}) });
    } catch (err) {
      if (isAuthError(err)) throw err;
      return Response.json({ ok: false, coupons: [], message: errMessage(err, "Couldn't load coupons.") });
    }
  }

  // Cutlery preference: stored on the desired cart and sent with update_food_cart.
  if (action === "cutlery") {
    const entry = carts.get(addressId);
    if (!entry || entry.items.size === 0 || typeof body.cutleryOptIn !== "boolean") {
      return Response.json(entry ? buildCart(entry, null) : emptyFoodCart());
    }
    entry.cutleryOptIn = body.cutleryOptIn;
    const cart = await syncAndBuild(addressId, entry);
    return Response.json(await withBestCoupon(cart, addressId, false));
  }

  // Clear: drop the desired cart and flush Swiggy.
  if (action === "clear") {
    carts.delete(addressId);
    try {
      await flushFoodCart();
      return Response.json({ ...emptyFoodCart(), synced: true });
    } catch (err) {
      if (isAuthError(err)) throw err;
      return Response.json({ ...emptyFoodCart(), notice: errMessage(err, "Couldn't clear your Swiggy cart.") });
    }
  }

  // Replace the WHOLE desired (single-restaurant) cart in one call.
  if (action === "set") {
    const items = Array.isArray(body.items) ? body.items : [];
    const prev = carts.get(addressId);
    const restaurantId = str(body.restaurantId) || prev?.restaurantId || "";
    const restaurantName = str(body.restaurantName) || prev?.restaurantName || "";

    const map = new Map<string, FoodCartLine>();
    for (const it of items) {
      const line = it?.line;
      const q = typeof it?.quantity === "number" ? it.quantity : 0;
      if (line?.menuItemId && q > 0) map.set(line.menuItemId, { ...line, quantity: q });
    }
    // Switching restaurants resets any sticky coupon.
    const keepCoupon = prev && prev.restaurantId === restaurantId ? prev.couponCode : null;
    const entry: CartEntry = {
      restaurantId,
      restaurantName,
      items: map,
      couponCode: keepCoupon ?? null,
      ...(prev && prev.restaurantId === restaurantId && typeof prev.cutleryOptIn === "boolean"
        ? { cutleryOptIn: prev.cutleryOptIn }
        : {}),
      // same restaurant: keep the coupon pass's memory (skip re-trying an unchanged cart)
      ...(prev && prev.restaurantId === restaurantId
        ? { couponManual: prev.couponManual, autoCouponSig: prev.autoCouponSig, couponReport: prev.couponReport }
        : {}),
    };
    if (map.size) carts.set(addressId, entry);
    const cart = await syncAndBuild(addressId, entry);
    return Response.json(await withBestCoupon(cart, addressId, false));
  }

  if (action === "add") {
    const incomingId = str(body.restaurantId);
    const incomingName = str(body.restaurantName);

    let entry = carts.get(addressId);
    // Single-restaurant cart. The client confirms a restaurant switch with the
    // user before sending it; here the new restaurant replaces the cart.
    if (entry && incomingId && entry.restaurantId && entry.restaurantId !== incomingId) {
      carts.delete(addressId);
      entry = undefined;
    }
    if (!entry) {
      entry = { restaurantId: incomingId, restaurantName: incomingName, items: new Map() };
      carts.set(addressId, entry);
    }
    if (incomingId) entry.restaurantId = incomingId;
    if (incomingName) entry.restaurantName = incomingName;

    if (body.line && menuItemId) {
      const existing = entry.items.get(menuItemId);
      if (existing) existing.quantity += qty;
      else entry.items.set(menuItemId, { ...body.line, quantity: qty });
    }
    const cart = await syncAndBuild(addressId, entry);
    return Response.json(await withBestCoupon(cart, addressId, false));
  }

  // increment / decrement / remove operate on an existing cart.
  const entry = carts.get(addressId);
  if (!entry) return Response.json(emptyFoodCart());

  switch (action) {
    case "increment": {
      const l = menuItemId ? entry.items.get(menuItemId) : undefined;
      if (l) l.quantity += 1;
      break;
    }
    case "decrement": {
      const l = menuItemId ? entry.items.get(menuItemId) : undefined;
      if (l) {
        l.quantity -= 1;
        if (l.quantity <= 0) entry.items.delete(menuItemId);
      }
      break;
    }
    case "remove": {
      if (menuItemId) entry.items.delete(menuItemId);
      break;
    }
    default:
      break;
  }

  const cart = await syncAndBuild(addressId, entry);
  return Response.json(await withBestCoupon(cart, addressId, false));
}

/**
 * Apply a coupon. With an explicit `couponCode`, apply that; otherwise the
 * first coupon Swiggy lists as applicable. The coupon counts as applied only
 * when Swiggy returns a positive coupon_discount; the saving shown is that
 * real discount from the re-read cart.
 */
async function handleCoupon(addressId: string, couponCode?: string): Promise<Response> {
  const entry = carts.get(addressId);
  if (!entry || entry.items.size === 0) return Response.json(emptyFoodCart());

  // Make sure Swiggy's cart matches ours first.
  const synced = await syncAndBuild(addressId, entry);
  if (!synced.synced || !synced.restaurantId) return Response.json(synced);

  const coupons = applicableOnly(await getCoupons(addressId, synced.restaurantId, true));
  const code =
    (couponCode || "").trim() ||
    coupons.find((c) => c.code.toUpperCase() !== synced.appliedCoupon?.code?.toUpperCase())?.code ||
    synced.bestCoupon?.code ||
    "";
  if (!code) {
    return Response.json({ ...synced, notice: "No coupons are applicable to this cart right now." });
  }

  try {
    const res = await applyFoodCoupon(addressId, code);
    if (!res.applied) {
      return Response.json(
        await withBestCoupon(
          { ...synced, notice: res.message || `Coupon ${code} doesn't apply to this cart.` },
          addressId,
          false,
        ),
      );
    }
    entry.couponCode = code;
    // an explicit code is the user's choice — the automatic pass won't replace it
    if ((couponCode || "").trim()) entry.couponManual = true;
    entry.couponReport = { applied: { code, savings: res.discount }, auto: false, others: entry.couponReport?.others ?? [], message: `Applied ${code} — saves ₹${res.discount}` };
    const remote = await getFoodCart(addressId, entry.restaurantName);
    return Response.json(await withBestCoupon(buildCart(entry, remote), addressId, false));
  } catch (err) {
    if (isAuthError(err)) throw err;
    console.error("[api/food-cart] apply_food_coupon failed:", err);
    return Response.json({ ...synced, notice: errMessage(err, `Couldn't apply coupon ${code}.`) });
  }
}

/* ---------------------------------- place ---------------------------------- */

const PAYMENT_METHODS = new Set(["UPI", "Cash", "COD", "SwiggyPay"]);

function placeFail(message: string, cart: FoodCart, extra: Partial<FoodPlaceResult> = {}): FoodPlaceResult {
  return { placed: false, gated: false, ok: false, message, cart, ...extra };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** True when Swiggy's cart has exactly the confirmed lines and quantities. */
function matchesDesired(entry: CartEntry, remote: FoodCart): boolean {
  const want = liveLines(entry);
  if (want.length !== remote.items.length) return false;
  return want.every((w) => remote.items.some((r) => r.menuItemId === w.menuItemId && r.quantity === w.quantity));
}

/**
 * Place a real food order, following the documented rules:
 *  1. re-sync, then RE-READ get_food_cart and verify it is exactly what the
 *     user confirmed (lines, stock, total) and within the ₹1000 cap;
 *  2. offer only a payment method get_payment_options returned;
 *  3. gate on SWIGGY_ENABLE_ORDERS (honest `placed:false, gated:true`);
 *  4. place_food_order is NOT idempotent: never retried. On an ambiguous
 *     failure, wait, read get_food_orders and report only what Swiggy shows.
 * UPI returns a PaymentSession built from the real PENDING_PAYMENT response
 * (with the addressId / cartId / lat / lng echo needed to finalize).
 */
async function handlePlace(addressId: string, body: FoodCartRequest): Promise<FoodPlaceResult> {
  const entry = carts.get(addressId);
  const empty = emptyFoodCart();
  const paymentMethod = str(body.paymentMethod);
  if (!entry || liveLines(entry).length === 0) return placeFail("Your food cart is empty.", empty);
  if (!PAYMENT_METHODS.has(paymentMethod)) {
    return placeFail("Choose a payment method first.", buildCart(entry, null, null));
  }
  const isUpi = paymentMethod === "UPI";

  // 1) Sync + authoritative re-read.
  const synced = await syncAndBuild(addressId, entry);
  if (!synced.synced) return placeFail(synced.notice || "Couldn't sync your cart with Swiggy.", synced);
  let remote: FoodCart;
  try {
    remote = buildCart(entry, await getFoodCart(addressId, entry.restaurantName));
  } catch (err) {
    if (isAuthError(err)) throw err;
    return placeFail(errMessage(err, "Couldn't read your Swiggy cart."), synced);
  }
  if (remote.items.length === 0) return placeFail("Your Swiggy cart is empty — add the dishes again.", remote);
  if (!matchesDesired(entry, remote)) {
    return placeFail("Your Swiggy cart changed — please review it before placing the order.", remote);
  }
  const outOfStock = remote.items.filter((l) => l.inStock === false);
  if (outOfStock.length) {
    return placeFail(`${outOfStock.map((l) => l.name).join(", ")} is out of stock — remove it to continue.`, remote);
  }
  if (remote.toPay > FOOD_ORDER_CAP) {
    return placeFail(
      `Swiggy limits these orders to ₹${FOOD_ORDER_CAP}. Your total is ₹${Math.round(remote.toPay)} — remove something to continue.`,
      remote,
    );
  }
  if (typeof body.amount === "number" && Math.abs(body.amount - remote.toPay) > 1) {
    return placeFail(
      `Your total is now ₹${Math.round(remote.toPay)} (was ₹${Math.round(body.amount)}). Please review and confirm again.`,
      remote,
    );
  }

  // 2) The method must be one Swiggy offers for this cart.
  try {
    const opts = await getPaymentOptions("food", { addressId });
    const offered =
      paymentMethod === "UPI"
        ? Boolean(opts.platforms?.mobile?.methods.length || opts.platforms?.desktop?.methods.length) ||
          opts.allMethods.some((m) => (m.groupName ?? "").toUpperCase() === "UPI")
        : paymentMethod === "SwiggyPay"
          ? opts.swiggyMoney?.available === true
          : opts.cod?.available === true;
    if (!offered) {
      return placeFail(`${paymentMethod === "SwiggyPay" ? "Swiggy Money" : paymentMethod} isn't available for this order — pick another payment method.`, remote);
    }
  } catch (err) {
    if (isAuthError(err)) throw err;
    // Can't verify the method — Swiggy validates it on placement anyway.
    console.warn("[api/food-cart] get_payment_options failed before placing:", err);
  }

  // 3) Server gate.
  if (!ordersEnabled()) {
    return { placed: false, gated: true, ok: false, message: "Ordering is disabled on this server", cart: remote };
  }

  // Snapshot recent orders so an ambiguous failure can be checked against them.
  const before = await getFoodOrders(addressId, { orderCount: 5 })
    .then((orders) => new Set(orders.map((o) => idStr(o.orderId))))
    .catch(() => null);

  // 4) Place (never retried).
  try {
    const { data, message } = await placeFoodOrder({
      addressId,
      paymentMethod,
      intentApp: isUpi ? str(body.intentApp) || undefined : undefined,
      generateUPIQR: isUpi && !str(body.intentApp) ? body.generateUPIQR !== false : undefined,
      noteToRestaurant: str(body.noteToRestaurant) || undefined,
    });
    const normalized = str(data.normalizedStatus).toLowerCase();
    const status = str(data.status).toUpperCase();

    if (normalized === "pending" || status === "PENDING_PAYMENT") {
      const session = paymentSessionFromPlaceOrder("food", data, {
        amount: remote.toPay,
        title: remote.restaurantName ?? undefined,
      });
      if (!session) {
        return placeFail(
          "Swiggy created the order but returned no payment details — check your orders in the Swiggy app before trying again.",
          remote,
        );
      }
      session.echo = { ...session.echo, addressId: session.echo?.addressId || addressId };
      // Keep the cart until payment succeeds; a failed payment can be retried on it.
      return {
        placed: false,
        gated: false,
        ok: true,
        orderId: session.orderId,
        paymentSession: session,
        message: "Complete the payment in your UPI app — your order is confirmed once the payment succeeds.",
        cart: remote,
      };
    }

    if (normalized === "success") {
      carts.delete(addressId);
      return {
        placed: true,
        gated: false,
        ok: true,
        orderId: idStr(data.orderId) || undefined,
        message: message || "Swiggy order placed successfully",
        cart: { ...empty, synced: true },
      };
    }
    return placeFail(message || `Swiggy didn't place the order (status: ${status || "unknown"}).`, remote);
  } catch (err) {
    if (isAuthError(err)) throw err;
    // Swiggy rejected the order outright (closed, min order, …): terminal.
    if ((err as { name?: string })?.name === "SwiggyToolError") {
      return placeFail(errMessage(err, "Swiggy couldn't place the order."), remote);
    }
    // Ambiguous (network / timeout / 5xx): did the order go through?
    console.error("[api/food-cart] place_food_order ambiguous failure:", err);
    await sleep(3000);
    try {
      const orders = await getFoodOrders(addressId, { orderCount: 5 });
      const created = before
        ? orders.find(
            (o) =>
              !before.has(idStr(o.orderId)) &&
              (!remote.restaurantId || idStr(o.restaurantId) === remote.restaurantId),
          )
        : undefined;
      if (created) {
        const orderId = idStr(created.orderId);
        if (isUpi) {
          return placeFail(
            `Swiggy created order ${orderId}, but the payment link was lost. Open the Swiggy app to complete or cancel it — don't place it again.`,
            remote,
            { orderId },
          );
        }
        carts.delete(addressId);
        return {
          placed: true,
          gated: false,
          ok: true,
          orderId,
          message: "Swiggy order placed successfully",
          cart: { ...empty, synced: true },
        };
      }
      if (before) {
        return placeFail(
          `The order didn't go through (${errMessage(err, "network error")}). Nothing was placed — you can try again.`,
          remote,
        );
      }
    } catch (checkErr) {
      if (isAuthError(checkErr)) throw checkErr;
    }
    return placeFail(
      "We couldn't confirm whether the order went through. Check your orders in the Swiggy app before trying again.",
      remote,
    );
  }
}
