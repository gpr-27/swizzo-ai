// Direct MCP calls to the Swiggy Instamart server (https://mcp.swiggy.com/im).
//
// These are the deterministic data calls the app makes outside the agent:
// addresses, product search / go-to items ("Load more"), the server-side cart
// (get_cart / update_cart / clear_cart), checkout, and order tracking.
// Contracts: docs/swiggy-mcp/instamart.md. Transport, session reuse, retries
// and envelope handling live in ./client.ts and ./payload.ts — every function
// here THROWS on failure (AuthError / SwiggyToolError / transport error).

import { cityPointFor } from '@/shared/cityCoords';
import { SWIGGY_IM_MCP_URL } from "@/backend/config/env";
import type {
  PastOrder,
  Address,
  AddressResolution,
  BillBreakdown,
  CartDeliveryAddress,
  CartLine,
  CartState,
  Product,
  ProductBadge,
  SwiggyOneStatus,
  Variation,
} from "@/shared/types";

import { callTool as callServerTool, type ToolResult } from "./client";
import { IMG_CARD, IMG_THUMB, swiggyImageUrl } from "./image";
import { coerceToolPayload, envelopeMessage } from "./payload";

export { coerceToolPayload };

// Bare names of the Swiggy Instamart tools.
const RAW_TOOL = {
  getAddresses: "get_addresses",
  createAddress: "create_address",
  deleteAddress: "delete_address",
  searchProducts: "search_products",
  goToItems: "your_go_to_items",
  getCart: "get_cart",
  getOrders: "get_orders",
  updateCart: "update_cart",
  clearCart: "clear_cart",
  checkout: "checkout",
  trackOrder: "track_order",
  getDeliveryStatus: "get_delivery_status",
} as const;

/** Call an Instamart tool and return its raw CallToolResult. */
function callTool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
  return callServerTool(SWIGGY_IM_MCP_URL, name, args);
}

/** Call an Instamart tool and return its unwrapped `data` as a record. */
async function callData(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const payload = coerceToolPayload(await callTool(name, args));
  return isRecord(payload) ? payload : {};
}

/**
 * Swiggy returns a cart's bound address as the short id ("db7kh1c1d96ofdam8g8g")
 * while get_addresses gives the full id ("db7kh1c1d96ofdam8g8g__AMVEDw…"); treat
 * them as the same address.
 */
export function sameAddressId(a: string, b: string): boolean {
  if (!a || !b) return false;
  const base = (id: string) => id.split("__")[0];
  return a === b || base(a) === base(b);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/* ----------------------------- value coercion ------------------------------ */

function str(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

/** Ids may arrive as strings or numbers — never blank a numeric id. */
function idStr(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return "";
}

function num(value: unknown, fallback = 0): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const clean = value.replace(/[^0-9.-]/g, "");
    if (clean) {
      const n = Number(clean);
      if (Number.isFinite(n)) return n;
    }
  }
  return fallback;
}

function optNum(value: unknown): number | undefined {
  const n = num(value, Number.NaN);
  return Number.isFinite(n) ? n : undefined;
}

function bool(value: unknown, fallback = false): boolean {
  return typeof value === "boolean" ? value : fallback;
}

/** Rupee formatter matching the UI's (₹, en-IN grouping, whole rupees). */
function inr(n: number): string {
  return `₹${Math.round(n).toLocaleString("en-IN")}`;
}

/**
 * Format a bill amount that may arrive as a NUMBER (e.g. 241, 12.5) or as an
 * already-formatted string ("₹241", "FREE").
 */
function money(value: unknown): string {
  if (typeof value === "number" && Number.isFinite(value)) return inr(value);
  if (typeof value === "string") return value.trim();
  return "";
}

/* --------------------------------- products -------------------------------- */

/** sla `{ value: "14", unit: "MINS" }` → "14 mins" (undefined when absent). */
function slaLabel(raw: unknown): string | undefined {
  if (!isRecord(raw)) return undefined;
  const value = idStr(raw.value).trim();
  if (!value) return undefined;
  const unit = str(raw.unit).trim().toLowerCase();
  return unit ? `${value} ${unit}` : value;
}

/** vegClassifier → veg / nonveg; VEG_CLASSIFIER_INVALID (non-food) → undefined. */
function vegOf(raw: unknown): "veg" | "nonveg" | undefined {
  const v = str(raw).toUpperCase();
  if (/NON_?VEG|EGG/.test(v)) return "nonveg";
  if (/_VEG$|^VEG$/.test(v)) return "veg";
  return undefined;
}

/** Map one raw search_products variation to our `Variation` shape. */
function normalizeVariation(raw: unknown): Variation {
  const v = isRecord(raw) ? raw : {};
  const price = isRecord(v.price) ? v.price : {};
  const unitLevelPrice = str(price.unitLevelPrice);
  const maxQuantity = optNum(v.maxQuantity);
  const maxQuantityMessage = str(v.maxQuantityMessage);
  const ratingRaw = isRecord(v.rating) ? v.rating : {};
  const ratingValue = idStr(ratingRaw.value).trim();
  const ratingCount = idStr(ratingRaw.count).trim();
  const sla = slaLabel(v.sla);
  const veg = vegOf(v.vegClassifier);
  return {
    spinId: idStr(v.spinId),
    skuId: idStr(v.skuId),
    quantityDescription: str(v.quantityDescription),
    mrp: num(price.mrp),
    offerPrice: num(price.offerPrice, num(price.mrp)),
    ...(unitLevelPrice ? { unitLevelPrice } : {}),
    // Live: every variation carries its own full CDN imageUrl.
    imageUrl: swiggyImageUrl(v.imageUrl, IMG_CARD),
    inStock: bool(v.isInStockAndAvailable, true),
    ...(maxQuantity && maxQuantity > 0 ? { maxQuantity } : {}),
    ...(maxQuantityMessage ? { maxQuantityMessage } : {}),
    ...(ratingValue && Number(ratingValue) > 0
      ? { rating: { value: ratingValue, ...(ratingCount ? { count: ratingCount } : {}) } }
      : {}),
    ...(sla ? { sla } : {}),
    ...(veg ? { veg } : {}),
  };
}

/** Swiggy's merchandising badges (Bestseller / Switch / Ad), text required. */
function normalizeBadges(raw: unknown): ProductBadge[] {
  return (Array.isArray(raw) ? raw : [])
    .filter(isRecord)
    .map((b) => {
      const backgroundColor = str(b.backgroundColor).trim();
      return {
        type: str(b.type),
        text: str(b.text).trim(),
        ...(backgroundColor ? { backgroundColor } : {}),
      };
    })
    .filter((b) => b.text);
}

/** Map one raw Swiggy product (SearchProduct) to our `Product` shape. */
export function normalizeProduct(raw: unknown): Product {
  const p = isRecord(raw) ? raw : {};
  const variations = Array.isArray(p.variations)
    ? p.variations.map(normalizeVariation).filter((v) => v.spinId)
    : [];
  const badges = normalizeBadges(p.badges);
  return {
    productId: idStr(p.productId),
    name: str(p.displayName),
    brand: str(p.brand),
    // A product is buyable only when Swiggy says it is in stock AND available.
    inStock: bool(p.inStock, true) && bool(p.isAvail, true),
    // An "Ad" badge also marks a sponsored listing.
    isPromoted: bool(p.isPromoted) || badges.some((b) => b.type === "BADGE_TYPE_AD"),
    variations,
    ...(badges.length ? { badges } : {}),
  };
}

/**
 * Map a `{ products, similarProducts?, nextOffset }` payload (search_products /
 * your_go_to_items) into normalized products. Exported for the agent stream.
 */
export function mapProductsPayload(payload: unknown): {
  products: Product[];
  similarProducts: Product[];
  nextOffset: string | null;
} {
  const obj: Record<string, unknown> = isRecord(payload) ? payload : {};
  const map = (list: unknown) =>
    (Array.isArray(list) ? list : []).map(normalizeProduct).filter((p) => p.productId && p.variations.length);
  const raw = obj.nextOffset;
  // Live your_go_to_items answers `nextOffset: "0"` on its only page — "0"
  // can never be a NEXT page (offset 0 is the first), so treat it as the end
  // instead of looping "Load more" on the same page.
  const nextOffset =
    raw === null || raw === undefined || raw === "" || String(raw) === "0" ? null : String(raw);
  return { products: map(obj.products), similarProducts: map(obj.similarProducts), nextOffset };
}

/* --------------------------------- addresses -------------------------------- */

function normalizeAddress(raw: unknown): Address {
  const a = isRecord(raw) ? raw : {};
  const phoneNumber = str(a.phoneNumber);
  const addressLine = str(a.addressLine);
  // Swiggy sends no coordinates; Dineout / Scenes search by the city's centre
  const lat = Number(a.lat ?? a.latitude);
  const lng = Number(a.lng ?? a.longitude);
  const city = cityPointFor(addressLine);
  const point =
    Number.isFinite(lat) && Number.isFinite(lng) && (lat !== 0 || lng !== 0)
      ? { latitude: lat, longitude: lng, ...(city ? { city: city.city } : {}) }
      : city;
  return {
    id: idStr(a.id),
    addressLine,
    addressTag: str(a.addressTag),
    addressCategory: str(a.addressCategory),
    ...(phoneNumber ? { phoneNumber } : {}),
    ...(point ? { latitude: point.latitude, longitude: point.longitude, ...(point.city ? { city: point.city } : {}) } : {}),
  };
}

/**
 * Every saved address (get_addresses pages 10 at a time — follow `hasMore`)
 * plus Swiggy's resolution of which one to use. `selectedAddressId` is the
 * user's earlier pick, passed for continuity.
 */
export async function getAddressBook(selectedAddressId?: string): Promise<{
  addresses: Address[];
  resolution: AddressResolution | null;
}> {
  const addresses: Address[] = [];
  let resolution: AddressResolution | null = null;
  const MAX_PAGES = 5;
  for (let page = 1; page <= MAX_PAGES; page++) {
    const args: Record<string, unknown> = { page };
    if (selectedAddressId) args.selectedAddressId = selectedAddressId;
    const data = await callData(RAW_TOOL.getAddresses, args);
    const pageData = mapAddressPage(data);
    addresses.push(...pageData.addresses);
    resolution ??= pageData.resolution;
    if (!pageData.hasMore) break;
  }
  return { addresses, resolution };
}

/** One get_addresses page → addresses, Swiggy's resolution, and `hasMore`. */
export function mapAddressPage(payload: unknown): {
  addresses: Address[];
  resolution: AddressResolution | null;
  hasMore: boolean;
} {
  const data = isRecord(payload) ? payload : {};
  const list = Array.isArray(data.addresses) ? data.addresses : [];
  let resolution: AddressResolution | null = null;
  if (isRecord(data.resolution)) {
    const r = data.resolution;
    const defaultAddressId = idStr(r.defaultAddressId);
    resolution = {
      ...(defaultAddressId ? { defaultAddressId } : {}),
      resolutionSource: str(r.resolutionSource),
      needsUserClarification: bool(r.needsUserClarification),
    };
  }
  const pagination = isRecord(data.pagination) ? data.pagination : {};
  return {
    addresses: list.map(normalizeAddress).filter((a) => a.id),
    resolution,
    hasMore: pagination.hasMore === true,
  };
}

/** Saved delivery addresses (all pages). */
export async function getAddresses(): Promise<Address[]> {
  return (await getAddressBook()).addresses;
}

export type AddressCategory = "HOME" | "WORK" | "OFFICE" | "FRIENDS_AND_FAMILY" | "OTHER";

/** create_address input — exactly the documented parameters. */
export interface CreateAddressInput {
  fullAddress: string;
  addressLine: string;
  addressLine2: string; // "" when there is none
  locality?: string;
  city: string;
  postalCode: string;
  latitude?: number;
  longitude?: number;
  addressCategory: AddressCategory;
  addressTag?: string;
  userName: string;
  userPhone: string;
  receiverName?: string;
  receiverPhone?: string;
}

/** Create a delivery address (shared Food & Instamart). Returns the new addressId. */
export async function createAddress(input: CreateAddressInput): Promise<string> {
  const args: Record<string, unknown> = {
    fullAddress: input.fullAddress,
    addressLine: input.addressLine,
    addressLine2: input.addressLine2 ?? "",
    city: input.city,
    postalCode: input.postalCode,
    addressCategory: input.addressCategory,
    userName: input.userName,
    userPhone: input.userPhone,
  };
  if (input.locality) args.locality = input.locality;
  if (input.addressTag) args.addressTag = input.addressTag;
  if (input.receiverName) args.receiverName = input.receiverName;
  if (input.receiverPhone) args.receiverPhone = input.receiverPhone;
  if (input.latitude != null && input.longitude != null) {
    args.latitude = input.latitude;
    args.longitude = input.longitude;
  }
  const data = await callData(RAW_TOOL.createAddress, args);
  const addressId = idStr(data.addressId);
  if (!addressId) throw new Error("Swiggy did not return an address id.");
  return addressId;
}

/** Delete a saved delivery address (permanent — confirm with the user first). */
export async function deleteAddress(addressId: string): Promise<{ statusCode: number; statusMessage: string }> {
  const data = await callData(RAW_TOOL.deleteAddress, { addressId });
  return { statusCode: num(data.statusCode), statusMessage: str(data.statusMessage) };
}

/* ----------------------------------- search --------------------------------- */

/** Search products for an address. `offset` paginates ("Load more"). */
export async function searchProducts(
  addressId: string,
  query: string,
  offset = 0,
): Promise<{ products: Product[]; similarProducts: Product[]; nextOffset: string | null }> {
  const data = await callData(RAW_TOOL.searchProducts, { addressId, query, offset });
  return mapProductsPayload(data);
}

/** The user's frequently / recently ordered items for an address. */
export async function goToItems(
  addressId: string,
  offset = 0,
): Promise<{ products: Product[]; similarProducts: Product[]; nextOffset: string | null }> {
  const data = await callData(RAW_TOOL.goToItems, { addressId, offset });
  return mapProductsPayload(data);
}

/* ------------------------------------ cart ---------------------------------- */

/** The server-side Instamart cart (InstamartCart), mapped to our shapes. */
export interface InstamartCartView {
  items: CartLine[];
  deliveryAddress?: CartDeliveryAddress; // selectedAddressDetails
  swiggyOne?: SwiggyOneStatus; // superData
  unserviceable: CartLine[];
  bill: BillBreakdown | null;
  boundAddressId: string; // selectedAddressDetails.id ("" when unknown)
  boundAddressText: string;
  storeCount: number; // distinct storeIds (multi-store carts split into several orders)
  absent: boolean; // cartAbsent / empty
  warnings: string[];
  payableTotal: number | null;
}

function mapCartItem(raw: unknown): CartLine | null {
  const it = isRecord(raw) ? raw : {};
  const spinId = idStr(it.spinId);
  if (!spinId) return null;
  const skuId = idStr(it.skuId);
  const maxQuantity = optNum(it.maxQuantity);
  const maxQuantityMessage = str(it.maxQuantityMessage);
  return {
    spinId,
    ...(skuId ? { skuId } : {}),
    productId: idStr(it.productId),
    name: str(it.itemName),
    brand: "",
    quantityDescription: str(it.itemVariant),
    imageUrl: swiggyImageUrl(it.imageUrl, IMG_THUMB),
    // [UNCERTAIN] the docs don't say whether discountedFinalPrice is per unit
    // or per line; it's an "item-level price field", treated as per unit.
    unitPrice: num(it.discountedFinalPrice, num(it.mrp)),
    mrp: num(it.mrp),
    quantity: Math.max(0, Math.round(num(it.quantity))),
    ...(maxQuantity && maxQuantity > 0 ? { maxQuantity } : {}),
    ...(maxQuantityMessage ? { maxQuantityMessage } : {}),
    inStock: bool(it.isInStockAndAvailable, true),
  };
}

/** Show only the last 4 digits of a phone number ("9392756256" → "••••6256"). */
function maskPhone(raw: unknown): string {
  const digits = idStr(raw).replace(/\D/g, "");
  return digits.length >= 4 ? `••••${digits.slice(-4)}` : "";
}

/** get_cart `selectedAddressDetails` → the delivery address card. */
function mapDeliveryAddress(raw: unknown, fallback: string): CartDeliveryAddress | undefined {
  const d = isRecord(raw) ? raw : {};
  const address = str(d.address).trim() || fallback.trim();
  if (!address) return undefined;
  const pick = (k: string) => str(d[k]).trim();
  const out: CartDeliveryAddress = { address };
  const fields: [keyof CartDeliveryAddress, string][] = [
    ["label", pick("annotation")],
    ["category", pick("category")],
    ["name", pick("name")],
    ["phone", maskPhone(d.mobile)],
    ["flatNo", pick("flatNo")],
    ["area", pick("area")],
    ["city", pick("city")],
  ];
  for (const [k, v] of fields) if (v) out[k] = v;
  return out;
}

/** get_cart `superData` → Swiggy One status (only when Swiggy sends a status). */
function mapSwiggyOne(raw: unknown): SwiggyOneStatus | undefined {
  if (!isRecord(raw)) return undefined;
  const userStatus = str(raw.userStatus).trim();
  if (!userStatus) return undefined;
  const program = str(raw.program).trim();
  const offering = str(raw.offering).trim();
  return { userStatus, ...(program ? { program } : {}), ...(offering ? { offering } : {}) };
}

/** Map get_cart / update_cart / apply_coupon `data` into an InstamartCartView. */
export function mapCartPayload(payload: unknown): InstamartCartView {
  const d = isRecord(payload) ? payload : {};
  const items = (Array.isArray(d.items) ? d.items : [])
    .map(mapCartItem)
    .filter((l): l is CartLine => !!l && l.quantity > 0);
  const unserviceable = (Array.isArray(d.unserviceableItems) ? d.unserviceableItems : [])
    .map(mapCartItem)
    .filter((l): l is CartLine => !!l);

  const bb = isRecord(d.billBreakdown) ? d.billBreakdown : {};
  const lines = (Array.isArray(bb.lineItems) ? bb.lineItems : [])
    .map((l) => (isRecord(l) ? { label: str(l.label), value: money(l.value) } : null))
    .filter((l): l is { label: string; value: string } => !!l && !!l.label && !!l.value);
  const toPay = isRecord(bb.toPay) ? money(bb.toPay.value) : "";
  const totalLabel = isRecord(bb.toPay) ? str(bb.toPay.label).trim() : "";
  const total = toPay || money(d.cartTotalAmount);
  const bill = lines.length || total ? { lines, total, ...(totalLabel ? { totalLabel } : {}) } : null;

  const details = isRecord(d.selectedAddressDetails) ? d.selectedAddressDetails : {};
  const deliveryAddress = mapDeliveryAddress(details, "");
  const swiggyOne = mapSwiggyOne(d.superData);
  const storeIds = new Set(
    (Array.isArray(d.items) ? d.items : [])
      .map((it) => (isRecord(it) ? idStr(it.storeId) : ""))
      .filter(Boolean),
  );

  const warnings: string[] = [];
  const addressWarning = str(d.addressWarning);
  if (addressWarning) warnings.push(addressWarning);
  if (isRecord(d.cartWarning) && str(d.cartWarning.message)) warnings.push(str(d.cartWarning.message));
  for (const r of Array.isArray(d.removedOutOfStockItems) ? d.removedOutOfStockItems : []) {
    const name = isRecord(r) ? str(r.itemName) : "";
    if (name) warnings.push(`${name} is out of stock and was removed.`);
  }
  for (const r of Array.isArray(d.reducedQuantityItems) ? d.reducedQuantityItems : []) {
    if (!isRecord(r)) continue;
    const name = str(r.itemName);
    const capped = num(r.cappedQuantity);
    const reason = str(r.reason);
    if (name) warnings.push(`${name} limited to ${capped}${reason ? ` — ${reason}` : "."}`);
  }
  for (const u of unserviceable) {
    warnings.push(`${u.name || "An item"} can't be delivered to this address.`);
  }
  for (const it of Array.isArray(d.items) ? d.items : []) {
    if (isRecord(it) && it.isInStockAndAvailable === false && str(it.itemName)) {
      warnings.push(`${str(it.itemName)} is currently unavailable.`);
    }
  }

  return {
    items,
    ...(deliveryAddress ? { deliveryAddress } : {}),
    ...(swiggyOne ? { swiggyOne } : {}),
    unserviceable,
    bill,
    boundAddressId: idStr(details.id),
    boundAddressText: str(details.address, str(d.selectedAddress)),
    storeCount: storeIds.size,
    absent: d.cartAbsent === true || items.length === 0,
    warnings,
    payableTotal: total ? num(total, Number.NaN) || null : null,
  };
}

/**
 * Turn a server cart into the UI's CartState. `meta` (by spinId) carries the
 * display fields the cart response lacks (brand, product name, image).
 */
export function cartToState(
  view: InstamartCartView,
  addressId: string,
  meta?: Map<string, Omit<CartLine, "quantity">>,
  extraWarnings: string[] = [],
): CartState {
  const items = view.items.map((l) => {
    const m = meta?.get(l.spinId);
    return m
      ? {
          ...l,
          brand: l.brand || m.brand,
          name: l.name || m.name,
          imageUrl: l.imageUrl || m.imageUrl,
          quantityDescription: l.quantityDescription || m.quantityDescription,
          productId: l.productId || m.productId,
          maxQuantityMessage: l.maxQuantityMessage || m.maxQuantityMessage,
        }
      : l;
  });
  let itemCount = 0;
  let subtotal = 0;
  let savings = 0;
  for (const l of items) {
    itemCount += l.quantity;
    subtotal += l.unitPrice * l.quantity;
    savings += Math.max(0, l.mrp - l.unitPrice) * l.quantity;
  }
  const warnings = [...extraWarnings, ...view.warnings];
  return {
    addressId,
    items,
    itemCount,
    subtotal,
    savings,
    ...(view.bill && items.length ? { bill: view.bill } : {}),
    ...(warnings.length ? { warnings } : {}),
    ...(view.unserviceable.length ? { unserviceable: view.unserviceable } : {}),
    ...(view.deliveryAddress && items.length ? { deliveryAddress: view.deliveryAddress } : {}),
    ...(view.swiggyOne ? { swiggyOne: view.swiggyOne } : {}),
    ...(view.storeCount > 1 && items.length ? { storeCount: view.storeCount } : {}),
    ...(view.boundAddressId && addressId && !sameAddressId(view.boundAddressId, addressId) && items.length
      ? { boundAddressId: view.boundAddressId }
      : {}),
  };
}

const EMPTY_VIEW: InstamartCartView = {
  items: [],
  unserviceable: [],
  bill: null,
  boundAddressId: "",
  boundAddressText: "",
  storeCount: 0,
  absent: true,
  warnings: [],
  payableTotal: null,
};

/** Read the server-side cart. A missing / expired cart reads as empty. */
export async function getCart(): Promise<InstamartCartView> {
  try {
    return mapCartPayload(await callData(RAW_TOOL.getCart, {}));
  } catch (err) {
    // "Cart not found" / expired is an empty cart, not an error.
    if (err instanceof Error && err.name === "SwiggyToolError" && /cart (not found|expired|is empty)|no cart/i.test(err.message)) {
      return EMPTY_VIEW;
    }
    throw err;
  }
}

/**
 * Replace the Swiggy cart with the given item set. update_cart REPLACES the
 * whole cart (absolute state, so retry-safe), and returns the new cart —
 * including removedOutOfStockItems / reducedQuantityItems notices.
 */
export async function updateCart(
  selectedAddressId: string,
  items: { spinId: string; skuId?: string; quantity: number }[],
): Promise<InstamartCartView> {
  const payloadItems = items.map((i) => ({
    spinId: i.spinId,
    ...(i.skuId ? { skuId: i.skuId } : {}),
    quantity: i.quantity,
  }));
  const data = await callData(RAW_TOOL.updateCart, { selectedAddressId, items: payloadItems });
  return mapCartPayload(data);
}

/** Empty the Swiggy cart. */
export async function clearCart(): Promise<void> {
  await callData(RAW_TOOL.clearCart, {});
}

/* ---------------------------------- orders ---------------------------------- */

/** Raw Instamart orders from the last 15 days (newest first). */
export async function getOrders(opts: { count?: number; activeOnly?: boolean } = {}): Promise<Record<string, unknown>[]> {
  const args: Record<string, unknown> = {};
  if (opts.count) args.count = opts.count;
  if (opts.activeOnly) args.activeOnly = true;
  const data = await callData(RAW_TOOL.getOrders, args);
  const orders = Array.isArray(data.orders) ? data.orders : [];
  return orders.filter(isRecord);
}

/** The user's most recent Instamart order (raw), for deterministic tracking. */
export async function getLatestOrder(): Promise<Record<string, unknown> | null> {
  const orders = await getOrders({ count: 5 });
  return orders[0] ?? null;
}

/** get_delivery_status — structured ETA for a placed order. */
export async function getDeliveryStatus(orderId: string, addressId: string): Promise<Record<string, unknown>> {
  return callData(RAW_TOOL.getDeliveryStatus, { orderId, addressId });
}

/** track_order — needs the delivery address coordinates. */
/**
 * The delivery coordinates get_orders reports for one order (its docs: "orders
 * … with delivery address coordinates"), for track_order. Reads the common
 * spellings; undefined when Swiggy returned none (caller falls back to the
 * selected address's coordinates).
 */
export async function instamartOrderCoords(orderId: string): Promise<{ lat: number; lng: number } | undefined> {
  const orders = await getOrders({ count: 20 });
  const o = orders.find((x) => idStr(x.orderId) === orderId);
  if (!o) return undefined;
  for (const src of [o.deliveryAddress, o.address, o]) {
    if (!isRecord(src)) continue;
    const lat = optNum(src.lat ?? src.latitude);
    const lng = optNum(src.lng ?? src.longitude);
    if (lat !== undefined && lng !== undefined && (lat !== 0 || lng !== 0)) return { lat, lng };
  }
  return undefined;
}

export async function trackOrder(orderId: string, lat: number, lng: number): Promise<Record<string, unknown>> {
  return callData(RAW_TOOL.trackOrder, { orderId, lat, lng });
}

/* --------------------------------- checkout --------------------------------- */

export interface CheckoutArgs {
  addressId: string;
  paymentMethod?: "UPI" | "Cash" | "COD" | "SwiggyPay";
  intentApp?: string; // only with UPI
  generateUPIQR?: boolean; // only with UPI, never together with intentApp
  confirmDuplicate?: boolean; // only after a duplicate rejection + user consent
}

/**
 * Place a real order (NON-idempotent — never retried by the client). The
 * caller owns the server gate, the user confirmation and the ambiguous-failure
 * check-then-retry. Returns the unwrapped `data` plus the envelope message
 * (which carries the required "Instamart order placed successfully" branding).
 */
export async function checkout(input: CheckoutArgs): Promise<{ data: Record<string, unknown>; message?: string }> {
  const args: Record<string, unknown> = { addressId: input.addressId };
  if (input.paymentMethod) args.paymentMethod = input.paymentMethod;
  if (input.paymentMethod === "UPI") {
    if (input.intentApp) args.intentApp = input.intentApp;
    else if (input.generateUPIQR) args.generateUPIQR = true;
  }
  if (input.confirmDuplicate) args.confirmDuplicate = true;
  const raw = await callTool(RAW_TOOL.checkout, args);
  const payload = coerceToolPayload(raw);
  return { data: isRecord(payload) ? payload : {}, message: envelopeMessage(raw) };
}

/* --------------------------------- tracking --------------------------------- */

/** The compact live-tracking card the UI renders (same shape for every service). */
export interface OrderTracker {
  status: string;
  eta?: string;
  partner?: string;
  items?: string;
}

function titleCase(s: string): string {
  return s ? s.charAt(0).toUpperCase() + s.slice(1).toLowerCase().replace(/_/g, " ") : "";
}

function itemsLabel(count: number, store: string): string | undefined {
  return [count ? `${count} item${count > 1 ? "s" : ""}` : "", store].filter(Boolean).join(" · ") || undefined;
}

/** get_orders order → tracker (status / currentStatus / estimatedDeliveryTime). */
export function imTrackerFromOrder(o: Record<string, unknown>): OrderTracker | null {
  const raw = str(o.statusMessage) || str(o.currentStatus) || str(o.status) || str(o.historyStatus);
  if (!raw) return null;
  const delivered = /delivered/i.test(raw);
  const status = delivered ? "Delivered" : titleCase(raw.split(/[,—]/)[0].trim());
  const active = o.isActive === true && !delivered;
  const eta = active ? str(o.estimatedDeliveryTime) || undefined : undefined;
  const count = typeof o.itemCount === "number" ? o.itemCount : Array.isArray(o.items) ? o.items.length : 0;
  return { status, eta, items: itemsLabel(count, str(o.storeName)) };
}

/** get_orders `orders[]` → every order (newest first) for the order-history card. */
export function pastInstamartOrders(payload: unknown): PastOrder[] {
  const obj = isRecord(payload) ? payload : {};
  const orders = (Array.isArray(obj.orders) ? obj.orders : []).filter(isRecord);
  return orders.map((o) => {
    const tr = imTrackerFromOrder(o);
    const items = Array.isArray(o.items)
      ? o.items
          .filter(isRecord)
          .map((i) => {
            const name = str(i.name) || str(i.itemName) || str(i.displayName);
            const q = typeof i.quantity === "number" ? i.quantity : undefined;
            return name ? (q ? `${name} (${q})` : name) : "";
          })
          .filter(Boolean)
          .join(", ")
      : "";
    const firstImage = Array.isArray(o.items)
      ? o.items.filter(isRecord).map((i) => str(i.imageUrl)).find(Boolean)
      : "";
    const total = o.orderTotal ?? o.totalAmount ?? o.totalPrice ?? o.amount;
    return {
      orderId: idStr(o.orderId),
      title: str(o.storeName, "Instamart"),
      items: items || tr?.items || undefined,
      status: tr?.status ?? "Unknown",
      total: typeof total === "number" ? inr(total) : typeof total === "string" ? total : undefined,
      placedAt: str(o.orderTime) || str(o.createdAt) || str(o.orderedTime) || undefined,
      imageUrl: firstImage || undefined,
      active: o.isActive === true,
    };
  });
}

/** get_delivery_status data → tracker (statusText / etaText / deliveryBy). */
export function imTrackerFromDeliveryStatus(d: Record<string, unknown>): OrderTracker | null {
  const delivered = d.delivered === true;
  const cancelled = d.cancelled === true;
  const statusText = str(d.statusText);
  if (!statusText && !delivered && !cancelled && !str(d.etaText)) return null;
  const status = delivered ? "Delivered" : cancelled ? "Cancelled" : statusText || "On the way";
  let eta: string | undefined;
  if (!delivered && !cancelled) {
    eta = str(d.etaText) || undefined;
    const by = typeof d.deliveryBy === "number" ? d.deliveryBy : null;
    const now = typeof d.serverNow === "number" ? d.serverNow : null;
    if (!eta && by && now && by > now) eta = `${Math.max(1, Math.round((by - now) / 60_000))} mins`;
  }
  return { status, eta };
}

/** track_order data → tracker (`status` is an OBJECT: statusMessage / etaText / etaMinutes). */
export function imTrackerFromTrackOrder(d: Record<string, unknown>): OrderTracker | null {
  const st = isRecord(d.status) ? d.status : {};
  const statusMessage = str(st.statusMessage);
  if (!statusMessage) return null;
  const delivered = /delivered/i.test(statusMessage);
  const etaMinutes = optNum(st.etaMinutes);
  const eta = delivered ? undefined : str(st.etaText) || (etaMinutes ? `${Math.round(etaMinutes)} mins` : undefined);
  const store = isRecord(d.storeInfo) ? str(d.storeInfo.name) : "";
  const count = typeof d.itemCount === "number" ? d.itemCount : Array.isArray(d.items) ? d.items.length : 0;
  const sub = str(st.subStatusMessage);
  return {
    status: delivered ? "Delivered" : statusMessage,
    eta,
    ...(sub ? { partner: sub } : {}),
    items: itemsLabel(count, store),
  };
}

/**
 * Deterministic Instamart tracking for the latest order: get_orders (active
 * first) → get_delivery_status(orderId, addressId) for a live ETA, plus
 * track_order when the caller has the delivery coordinates. Read-only.
 */
export async function getInstamartTracking(opts: {
  addressId?: string;
  lat?: number;
  lng?: number;
}): Promise<{ tracker: OrderTracker | null; summary: string; orderId?: string; pollIntervalSec?: number }> {
  const active = await getOrders({ count: 5, activeOnly: true });
  const order = active[0] ?? (await getOrders({ count: 5 }))[0];
  if (!order) {
    return { tracker: null, summary: "You don't have any Instamart orders in the last 15 days. 📦" };
  }
  const orderId = str(order.orderId);
  const base = imTrackerFromOrder(order);
  let live: OrderTracker | null = null;
  let pollIntervalSec: number | undefined;

  if (orderId && order.isActive === true) {
    const deliveryAddr = isRecord(order.deliveryAddress) ? str(order.deliveryAddress.id) : "";
    const addressId = deliveryAddr || opts.addressId || "";
    if (opts.lat != null && opts.lng != null) {
      const t = await trackOrder(orderId, opts.lat, opts.lng).catch(() => null);
      if (t) {
        live = imTrackerFromTrackOrder(t);
        pollIntervalSec = optNum(t.pollingIntervalSeconds);
      }
    }
    if (!live && addressId) {
      const d = await getDeliveryStatus(orderId, addressId).catch(() => null);
      if (d) {
        live = imTrackerFromDeliveryStatus(d);
        pollIntervalSec = optNum(d.pollIntervalSec);
      }
    }
  }

  const tracker: OrderTracker | null = live
    ? { ...live, items: live.items ?? base?.items }
    : base;
  const summary = !tracker
    ? "I found your latest Instamart order but Swiggy didn't return its status. 📦"
    : tracker.status === "Delivered"
      ? `Your latest Instamart order was delivered — ${tracker.items ?? "see details"}. 📦`
      : `Your Instamart order: ${tracker.status.toLowerCase()}${tracker.eta ? ` — about ${tracker.eta} away` : ""}. 🛵`;
  return {
    tracker,
    summary,
    orderId: orderId || undefined,
    // Never poll faster than 10 s (docs: rate limits).
    ...(pollIntervalSec ? { pollIntervalSec: Math.max(10, pollIntervalSec) } : {}),
  };
}
