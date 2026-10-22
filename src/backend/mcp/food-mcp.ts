// Food MCP helpers — normalization of the Swiggy Food tool payloads (shapes per
// docs/swiggy-mcp/food.md) plus the serialized food-cart operations used by the
// deterministic /api/food-cart and /api/dishes routes. Everything shown to the
// user comes from a real tool response; nothing here invents ids, prices,
// availability or coupon savings.

import { createHash } from "node:crypto";

import { MCP_SERVERS } from "@/backend/agent/services";
import { getSwiggyToken, isAuthError } from "@/backend/config/env";
import {
  bool,
  callTool,
  coerceToolPayload,
  idStr,
  isRecord,
  num,
  str,
} from "@/backend/mcp/client";
import { IMG_CARD, IMG_THUMB, swiggyImageUrl } from "@/backend/mcp/image";
import { envelopeMessage } from "@/backend/mcp/payload";
import type {
  PastOrder,
  Coupon,
  FoodAddonGroup,
  FoodAvailability,
  FoodCart,
  FoodCartLine,
  FoodCartSelection,
  FoodItemCustomization,
  FoodRestaurant,
  FoodVariantGroup,
  MenuCategory,
  MenuItem,
  OrderDetails,
} from "@/shared/types";
import { emptyFoodCart } from "@/shared/types";
import { BoundedMap } from "@/backend/resilience/lru";

const FOOD_URL = MCP_SERVERS.food.url;

// Bare tool names on the Swiggy Food MCP server.
const RAW_TOOL = {
  searchRestaurants: "search_restaurants",
  searchMenu: "search_menu",
  getRestaurantMenu: "get_restaurant_menu",
  flushFoodCart: "flush_food_cart",
  updateFoodCart: "update_food_cart",
  getFoodCart: "get_food_cart",
  placeFoodOrder: "place_food_order",
  fetchFoodCoupons: "fetch_food_coupons",
  applyFoodCoupon: "apply_food_coupon",
  getFoodOrders: "get_food_orders",
} as const;

// Short-lived dish search cache (prices / stock are live, so keep it brief).
const DISH_SEARCH_TTL_MS = 60 * 1000;
const dishSearchCache = new BoundedMap<string, { timestamp: number; result: DishSearchResult }>({
  max: 500,
  ttlMs: DISH_SEARCH_TTL_MS,
});

/* ----------------------- per-cart serialization (mutex) -------------------- */
// Swiggy keeps ONE food cart per authenticated session, so every remote cart
// operation (flush / update / read / coupon / place) for a user is funnelled
// through one FIFO queue. Without this, a concurrent flush→update→read can
// interleave and read a wrong item set / pricing.
const foodCartQueues = new BoundedMap<string, Promise<unknown>>({ max: 2_000 });

async function userCartKey(): Promise<string> {
  const token = (await getSwiggyToken().catch(() => null)) ?? "anon";
  return createHash("sha256").update(token).digest("hex").slice(0, 16);
}

export async function withFoodCartLock<T>(fn: () => Promise<T>): Promise<T> {
  const key = await userCartKey();
  const prev = foodCartQueues.get(key) ?? Promise.resolve();
  // Run after the previous op settles (success OR failure) so one error can't
  // wedge the queue; keep an error-swallowing tail as the chain's new head.
  const run = prev.then(fn, fn);
  foodCartQueues.set(
    key,
    run.then(
      () => undefined,
      () => undefined,
    ),
  );
  return run;
}

/* ------------------------------- shared bits ------------------------------- */

/**
 * Live Food payloads (search_restaurants / search_menu / get_restaurant_menu)
 * carry a full CDN `imageUrl`; older shapes use a bare `imageId` /
 * `cloudinaryImageId`. Either becomes a resized CDN URL.
 */
function getSwiggyImageUrl(it: Record<string, unknown>, width = IMG_CARD): string {
  for (const v of [it.imageUrl, it.imageId, it.image_id, it.cloudinaryImageId, it.image]) {
    const url = swiggyImageUrl(v, width);
    if (url) return url;
  }
  return "";
}

/** Swiggy marks veg as boolean, "1"/"0" or 1/0 depending on the tool. */
function isVegFlag(v: unknown): boolean {
  return v === true || v === 1 || v === "1" || v === "true";
}

/** `inStock` is a number (1/0) on menu/search payloads, a boolean elsewhere. */
function inStockFlag(v: unknown): boolean {
  if (v === undefined || v === null) return true; // omitted = no stock signal
  if (typeof v === "boolean") return v;
  return num(v, 1) !== 0;
}

/** Unwrap a residual `{ data: {...} }` wrapper when `key` isn't at the top. */
function unwrapTo(payload: unknown, key: string): Record<string, unknown> {
  let obj: Record<string, unknown> = isRecord(payload) ? payload : {};
  if (!(key in obj) && isRecord(obj.data)) obj = obj.data;
  return obj;
}

/* ------------------------------ restaurants -------------------------------- */

function availabilityOf(v: unknown): FoodAvailability {
  const s = str(v).toUpperCase();
  return s === "OPEN" || s === "CLOSED" || s === "UNAVAILABLE" ? s : "UNKNOWN";
}

/** Live search_restaurants marks promoted listings by suffixing the name with " (Ad)". */
const AD_SUFFIX = /\s*\(Ad\)\s*$/i;

/** Split Swiggy's "Meghana Foods (Ad)" into the real name + a sponsored flag. */
export function splitSponsored(rawName: string): { name: string; sponsored: boolean } {
  const trimmed = rawName.trim();
  return AD_SUFFIX.test(trimmed)
    ? { name: trimmed.replace(AD_SUFFIX, "").trim(), sponsored: true }
    : { name: trimmed, sponsored: false };
}

/** Map one raw search_restaurants entry -> FoodRestaurant. */
export function normalizeFoodRestaurant(raw: unknown): FoodRestaurant {
  const r = isRecord(raw) ? raw : {};
  const cuisines = Array.isArray(r.cuisines)
    ? r.cuisines.filter((c): c is string => typeof c === "string")
    : [];
  const availability = availabilityOf(r.availabilityStatus);
  const minutes = num(r.deliveryTimeMinutes);
  const { name, sponsored } = splitSponsored(str(r.name));
  return {
    id: idStr(r.id),
    name,
    cuisines,
    rating: num(r.avgRating),
    ratingCount: idStr(r.totalRatings),
    costForTwo: str(r.costForTwo),
    area: str(r.areaName),
    distanceKm: num(r.distanceKm),
    etaRange: str(r.deliveryTimeRange) || (minutes > 0 ? `${Math.round(minutes)} mins` : ""),
    offer: str(r.offer),
    imageUrl: getSwiggyImageUrl(r),
    availability,
    nextOpenTime: str(r.nextOpenTime) || undefined,
    isOpen: availability !== "CLOSED" && availability !== "UNAVAILABLE",
    ...(sponsored ? { sponsored } : {}),
    ...(minutes > 0 ? { deliveryMinutes: Math.round(minutes) } : {}),
    ...(typeof r.veg === "boolean" ? { veg: r.veg } : {}),
  };
}

/**
 * get_restaurant_menu `restaurant{}` (id, name, city, areaName, cuisines,
 * avgRating, totalRatingsString "5.3K+ ratings", costForTwoMessage, isOpen,
 * deliveryTime, slaString, address, imageUrl) -> FoodRestaurant for the menu header.
 */
export function menuRestaurantInfo(raw: unknown, fallbackId = "", fallbackName = ""): FoodRestaurant | undefined {
  const r = isRecord(raw) ? raw : {};
  const id = idStr(r.id) || fallbackId;
  const { name, sponsored } = splitSponsored(str(r.name) || fallbackName);
  if (!id || !name) return undefined;
  const minutes = num(r.deliveryTime);
  const availability: FoodAvailability = r.isOpen === true ? "OPEN" : r.isOpen === false ? "CLOSED" : "UNKNOWN";
  return {
    id,
    name,
    cuisines: Array.isArray(r.cuisines) ? r.cuisines.filter((c): c is string => typeof c === "string") : [],
    rating: num(r.avgRating) || num(r.avgRatingString),
    ratingCount: str(r.totalRatingsString).replace(/\s*ratings?$/i, ""),
    costForTwo: str(r.costForTwoMessage),
    area: str(r.areaName),
    distanceKm: 0,
    etaRange: str(r.slaString) || (minutes > 0 ? `${Math.round(minutes)} mins` : ""),
    offer: "",
    imageUrl: getSwiggyImageUrl(r),
    availability,
    isOpen: r.isOpen !== false,
    ...(sponsored ? { sponsored } : {}),
    ...(minutes > 0 ? { deliveryMinutes: Math.round(minutes) } : {}),
    ...(str(r.address) ? { address: str(r.address).replace(/,\s*,/g, ",").trim() } : {}),
    ...(str(r.city) ? { city: str(r.city) } : {}),
  };
}

/** Map a search_restaurants payload (`{ restaurants, dishes, … }`) -> cards. */
export function mapFoodRestaurants(payload: unknown): FoodRestaurant[] {
  const obj = unwrapTo(payload, "restaurants");
  const list = Array.isArray(obj.restaurants) ? obj.restaurants : [];
  return list.map(normalizeFoodRestaurant).filter((r) => r.id && r.name);
}

/** search_restaurants also returns matching `dishes[]` — map them to MenuItems. */
export function mapRestaurantDishes(payload: unknown): MenuItem[] {
  const obj = unwrapTo(payload, "dishes");
  const list = Array.isArray(obj.dishes) ? obj.dishes : [];
  // Drop dishes whose restaurant Swiggy reports as closed / unavailable.
  const closed = new Set(
    mapFoodRestaurants(obj)
      .filter((r) => !r.isOpen)
      .map((r) => r.id),
  );
  const out: MenuItem[] = [];
  for (const raw of list) {
    const d = isRecord(raw) ? raw : {};
    const id = idStr(d.id);
    const restaurantId = idStr(d.restaurantId);
    if (!id || !restaurantId || closed.has(restaurantId)) continue;
    out.push({
      id,
      name: str(d.name),
      description: str(d.description),
      price: num(d.price),
      veg: isVegFlag(d.isVeg),
      bestseller: false,
      rating: "",
      ...(str(d.category) ? { category: str(d.category) } : {}),
      imageUrl: getSwiggyImageUrl(d),
      hasVariants: false,
      hasAddons: false,
      inStock: inStockFlag(d.inStock),
      restaurantId,
      restaurantName: splitSponsored(str(d.restaurantName)).name,
    });
  }
  return out;
}

/* --------------------------------- menu ------------------------------------ */

/** Map one get_restaurant_menu item -> MenuItem (browse view, no customizations). */
export function normalizeMenuItem(
  raw: unknown,
  restaurantId: string,
  restaurantName: string,
): MenuItem {
  const it = isRecord(raw) ? raw : {};
  return {
    id: idStr(it.id),
    name: str(it.name),
    description: str(it.description),
    price: num(it.price),
    veg: isVegFlag(it.isVeg),
    bestseller: bool(it.isBestseller),
    rating: idStr(it.rating),
    imageUrl: getSwiggyImageUrl(it),
    hasVariants: bool(it.hasVariants),
    hasAddons: bool(it.hasAddons),
    inStock: inStockFlag(it.inStock),
    restaurantId,
    restaurantName,
  };
}

/**
 * Map a get_restaurant_menu payload -> normalized menu page. Nested categories
 * (`subcategories[]`) are flattened as "Parent · Sub". Pagination is over
 * categories: `hasMore` means call again with `page + 1`.
 */
export function normalizeMenu(
  payload: unknown,
  restaurantName?: string,
  restaurantId?: string,
): {
  restaurantId: string;
  restaurantName: string;
  isOpen: boolean | null;
  categories: MenuCategory[];
  page: number;
  hasMore: boolean;
  restaurant?: FoodRestaurant;
  totalCategories?: number;
} {
  const obj = unwrapTo(payload, "categories");
  const restaurant = isRecord(obj.restaurant) ? obj.restaurant : {};
  const rId = str(restaurantId) || idStr(restaurant.id);
  const rName = splitSponsored(str(restaurantName) || str(restaurant.name)).name;

  const seen = new Set<string>();
  const categories: MenuCategory[] = [];
  const pushCategory = (title: string, rawItems: unknown, raw: Record<string, unknown>) => {
    const items: MenuItem[] = [];
    const list = Array.isArray(rawItems) ? rawItems : [];
    for (const rawItem of list) {
      const item = normalizeMenuItem(rawItem, rId, rName);
      if (!item.id || !item.name || seen.has(item.id)) continue;
      seen.add(item.id);
      items.push(item);
    }
    // Live: each category is capped (~10 items) with `hasMoreItems` + `totalItems`.
    const more = raw.hasMoreItems === true ? Math.max(0, num(raw.totalItems) - list.length) : 0;
    const total = num(raw.totalItems);
    const categoryId = idStr(raw.categoryId);
    if (items.length > 0) {
      categories.push({
        title: title || "Menu",
        items,
        ...(more > 0 ? { moreItems: more } : {}),
        ...(categoryId ? { categoryId } : {}),
        ...(total > 0 ? { totalItems: total } : {}),
      });
    }
  };

  for (const rawCat of Array.isArray(obj.categories) ? obj.categories : []) {
    const cat = isRecord(rawCat) ? rawCat : {};
    const title = str(cat.title);
    if (Array.isArray(cat.subcategories)) {
      for (const rawSub of cat.subcategories) {
        const sub = isRecord(rawSub) ? rawSub : {};
        const subTitle = str(sub.title);
        pushCategory(subTitle ? `${title} · ${subTitle}` : title, sub.items, sub);
      }
    } else {
      pushCategory(title, cat.items, cat);
    }
  }

  const info = menuRestaurantInfo(restaurant, rId, rName);
  return {
    restaurantId: rId,
    restaurantName: rName,
    isOpen: typeof restaurant.isOpen === "boolean" ? restaurant.isOpen : null,
    categories,
    page: num(obj.page, 1),
    hasMore: bool(obj.hasMore),
    ...(info ? { restaurant: info } : {}),
    ...(num(obj.totalCategories) > 0 ? { totalCategories: num(obj.totalCategories) } : {}),
  };
}

/** get_restaurant_menu (one page of categories) -> normalized menu. Read-only. */
export async function getRestaurantMenu(
  addressId: string,
  restaurantId: string,
  opts: { page?: number; restaurantName?: string } = {},
): Promise<ReturnType<typeof normalizeMenu>> {
  const args: Record<string, unknown> = { restaurantId, addressId, pageSize: 8 };
  if (opts.page && opts.page > 1) args.page = opts.page;
  const payload = coerceToolPayload(await callTool(FOOD_URL, RAW_TOOL.getRestaurantMenu, args));
  return normalizeMenu(payload, opts.restaurantName, restaurantId);
}

/* ------------------------------ search_menu -------------------------------- */

/** Build the customization options of one search_menu item. */
function customizationOf(it: Record<string, unknown>): FoodItemCustomization {
  const variantGroups: FoodVariantGroup[] = [];
  let format: FoodItemCustomization["format"] = "none";

  if (Array.isArray(it.variantsV2) && it.variantsV2.length > 0) {
    format = "variantsV2";
    for (const rawGroup of it.variantsV2) {
      const g = isRecord(rawGroup) ? rawGroup : {};
      const groupId = idStr(g.groupId);
      const choices = (Array.isArray(g.variations) ? g.variations : [])
        .filter(isRecord)
        .map((v) => ({
          id: idStr(v.id),
          name: str(v.name),
          price: typeof v.price === "number" ? v.price : undefined,
          inStock: inStockFlag(v.inStock),
          isDefault: num(v.default) === 1,
        }))
        .filter((c) => c.id);
      if (groupId && choices.length) variantGroups.push({ groupId, name: str(g.name), choices, pricesAreAddOns: true });
    }
  } else if (Array.isArray(it.variations) && it.variations.length > 0) {
    // Legacy single-variant format: a flat list, each option tagged with its groupId.
    format = "variations";
    const byGroup = new Map<string, FoodVariantGroup>();
    for (const rawV of it.variations) {
      const v = isRecord(rawV) ? rawV : {};
      const id = idStr(v.id);
      const groupId = idStr(v.groupId);
      if (!id || !groupId) continue;
      const group = byGroup.get(groupId) ?? { groupId, name: "Choose one", choices: [] };
      group.choices.push({
        id,
        name: str(v.name),
        price: typeof v.price === "number" ? v.price : undefined,
        inStock: inStockFlag(v.inStock),
        isDefault: num(v.default) === 1,
      });
      byGroup.set(groupId, group);
    }
    variantGroups.push(...byGroup.values());
  }

  const addonGroups: FoodAddonGroup[] = [];
  for (const rawGroup of Array.isArray(it.addons) ? it.addons : []) {
    const g = isRecord(rawGroup) ? rawGroup : {};
    const groupId = idStr(g.groupId);
    const choices = (Array.isArray(g.choices) ? g.choices : [])
      .filter(isRecord)
      .map((c) => ({ id: idStr(c.id), name: str(c.name), price: num(c.price) }))
      .filter((c) => c.id);
    if (!groupId || !choices.length) continue;
    const maxFree = num(g.maxFreeAddons, -1);
    addonGroups.push({
      groupId,
      name: str(g.groupName),
      min: Math.max(0, num(g.minAddons)),
      max: Math.max(0, num(g.maxAddons)),
      ...(maxFree > 0 ? { maxFree } : {}),
      choices,
    });
  }

  return { format, variantGroups, addonGroups };
}

/** Map one search_menu `items[]` entry (snake_case ids) -> MenuItem. */
export function normalizeSearchMenuItem(raw: unknown): MenuItem {
  const it = isRecord(raw) ? raw : {};
  const customization = customizationOf(it);
  return {
    id: idStr(it.menu_item_id),
    name: str(it.name),
    description: str(it.description),
    price: num(it.price),
    veg: isVegFlag(it.isVeg),
    bestseller: bool(it.isBestseller),
    rating: idStr(it.rating),
    ...(idStr(it.totalRatings) ? { ratingCount: idStr(it.totalRatings) } : {}),
    imageUrl: getSwiggyImageUrl(it),
    hasVariants: bool(it.hasVariants) || customization.variantGroups.length > 0,
    hasAddons: bool(it.hasAddons) || customization.addonGroups.length > 0,
    inStock: inStockFlag(it.inStock),
    restaurantId: idStr(it.restaurant_id),
    restaurantName: splitSponsored(str(it.restaurant_name)).name,
    customization,
  };
}

export interface DishSearchResult {
  dishes: MenuItem[];
  hasMore: boolean;
  nextOffset: number | null;
  totalItems?: number; // search_menu `totalItems` (all matches Swiggy has)
}

/** Map a search_menu payload -> dishes (each carries its own restaurant). */
export function mapSearchMenu(
  payload: unknown,
  fallbackRestaurantId = "",
  fallbackRestaurantName = "",
): DishSearchResult {
  const obj = unwrapTo(payload, "items");
  const seen = new Set<string>();
  const dishes: MenuItem[] = [];
  for (const raw of Array.isArray(obj.items) ? obj.items : []) {
    const item = normalizeSearchMenuItem(raw);
    if (!item.restaurantId) item.restaurantId = fallbackRestaurantId;
    if (!item.restaurantName) item.restaurantName = fallbackRestaurantName;
    if (!item.id || !item.name || !item.restaurantId) continue;
    const key = `${item.restaurantId}:${item.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    dishes.push(item);
  }
  const next = obj.nextOffset;
  const totalItems = num(obj.totalItems);
  return {
    dishes,
    hasMore: bool(obj.hasMore),
    nextOffset: typeof next === "number" && Number.isFinite(next) ? next : null,
    ...(totalItems > 0 ? { totalItems } : {}),
  };
}

/** Call search_menu (across restaurants, or scoped to one with `restaurantId`). */
export async function searchMenu(
  addressId: string,
  query: string,
  opts: { restaurantId?: string; restaurantName?: string; vegOnly?: boolean; offset?: number } = {},
): Promise<DishSearchResult> {
  const args: Record<string, unknown> = { query, addressId };
  if (opts.restaurantId) args.restaurantIdOfAddedItem = opts.restaurantId;
  if (opts.vegOnly) args.vegFilter = 1;
  if (opts.offset) args.offset = opts.offset;
  const payload = coerceToolPayload(await callTool(FOOD_URL, RAW_TOOL.searchMenu, args));
  return mapSearchMenu(payload, opts.restaurantId, opts.restaurantName);
}

/* ----------------------- cross-restaurant dish search ---------------------- */

const DISH_STOP = new Set([
  "veg",
  "the",
  "and",
  "near",
  "some",
  "show",
  "dishes",
  "dish",
  "food",
  "me",
  "for",
  "with",
  "best",
  "good",
  "find",
  "want",
  "order",
]);

/**
 * Parse conversational queries into clean food search terms, positive search tokens,
 * and negative exclusions (e.g. "not chicken or paneer", "no mushrooms").
 */
export function parseFoodSearchQuery(input: string): {
  searchTerm: string;
  positiveTokens: string[];
  negativeTokens: string[];
  wantVeg: boolean;
} {
  let text = input.toLowerCase().trim();
  // Strip conversational chat prefixes
  text = text
    .replace(/^(and\s+)?(i\s+also\s+want|i\s+want|can\s+you\s+get|can\s+you\s+find|give\s+me|show\s+me|find\s+me|order\s+me|i\s+asked\s+for|craving\s+for|craving)\s+/i, "")
    .replace(/[.!?]+$/, "")
    .trim();

  // Extract negative constraints ("not chicken or paneer", "without onions", "no egg")
  const negativeTokens: string[] = [];
  const notMatch = text.match(/\b(?:not|no|without|except)\s+([^,.]+)/i);
  if (notMatch) {
    const negPart = notMatch[1];
    const rawNegWords = negPart.split(/\s+(?:or|and)\s+|\s+/).map((w) => w.trim()).filter((w) => w.length > 2);
    // Remove the negative clause from the search term
    text = text.replace(/\b(?:not|no|without|except)\s+[^,.]+$/i, "").replace(/[,]+$/, "").trim();
    const coreWords = new Set(text.split(/\s+/));
    negativeTokens.push(...rawNegWords.filter((w) => !coreWords.has(w)));
  }

  const wantVeg = /\bveg\b|vegetarian/i.test(text);
  const positiveTokens = text
    .split(/[\s&,/]+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 1 && !DISH_STOP.has(t) && !["want", "also", "find", "near", "give", "show", "pizzas"].includes(t));

  return {
    searchTerm: text || input.trim(),
    positiveTokens,
    negativeTokens,
    wantVeg,
  };
}

/**
 * Find dishes matching `query` ACROSS nearby restaurants with search_menu (the
 * documented dish search; it returns each dish's restaurant and its full
 * customizations). Falls back to search_restaurants' `dishes[]` when
 * search_menu returns nothing. Auth errors propagate; other failures throw so
 * the route can show Swiggy's message.
 */
export async function searchDishes(
  query: string,
  addressId: string,
  offset = 0,
): Promise<DishSearchResult> {
  const parsed = parseFoodSearchQuery(query);
  const { searchTerm, negativeTokens, wantVeg } = parsed;
  const cacheKey = `${searchTerm}:${addressId}:${offset}`;
  const cached = dishSearchCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < DISH_SEARCH_TTL_MS) return cached.result;

  let result: DishSearchResult = { dishes: [], hasMore: false, nextOffset: null };
  let searchErr: unknown = null;
  try {
    result = await searchMenu(addressId, searchTerm, { vegOnly: wantVeg, offset });
  } catch (err) {
    if (isAuthError(err)) throw err;
    searchErr = err;
  }

  if (result.dishes.length === 0 && offset === 0) {
    try {
      const payload = coerceToolPayload(
        await callTool(FOOD_URL, RAW_TOOL.searchRestaurants, { query: searchTerm, addressId }),
      );
      const dishes = mapRestaurantDishes(payload).filter((d) => !wantVeg || d.veg);
      result = { dishes, hasMore: false, nextOffset: null };
      searchErr = null;
    } catch (err) {
      if (isAuthError(err)) throw err;
      searchErr ??= err;
    }
  }
  if (searchErr && result.dishes.length === 0) throw searchErr;

  // Honour exclusions the user stated ("biryani, not chicken").
  if (negativeTokens.length) {
    result = {
      ...result,
      dishes: result.dishes.filter((d) => {
        const text = `${d.name} ${d.description}`.toLowerCase();
        return !negativeTokens.some((neg) => text.includes(neg));
      }),
    };
  }

  dishSearchCache.set(cacheKey, { timestamp: Date.now(), result });
  return result;
}

/* ------------------------------- food cart --------------------------------- */

function selectionLabel(raw: unknown): string {
  return (Array.isArray(raw) ? raw : [])
    .filter(isRecord)
    .map((s) => str(s.name))
    .filter(Boolean)
    .join(" · ");
}

const firstId = (r: Record<string, unknown>, keys: string[]): string => {
  for (const k of keys) {
    const v = idStr(r[k]);
    if (v) return v;
  }
  return "";
};

/**
 * get_food_cart `items[].valid_addons` -> add-on groups for THAT line's chosen
 * variant (docs: prefer these over search_menu's full addon list). Group /
 * choice ids are read from either casing; `maxAddons` 0 / -1 = unlimited.
 */
export function mapValidAddons(raw: unknown): FoodAddonGroup[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: FoodAddonGroup[] = [];
  for (const rg of raw) {
    if (!isRecord(rg)) continue;
    const groupId = firstId(rg, ["group_id", "groupId", "id"]);
    const list = Array.isArray(rg.choices) ? rg.choices : Array.isArray(rg.addons) ? rg.addons : [];
    const choices = list
      .filter(isRecord)
      .map((c) => ({ id: firstId(c, ["choice_id", "choiceId", "id", "addon_id", "variation_id"]), name: str(c.name), price: num(c.price) }))
      .filter((c) => c.id);
    if (!groupId || !choices.length) continue;
    out.push({
      groupId,
      name: str(rg.name) || str(rg.groupName) || str(rg.group_name),
      min: Math.max(0, num(rg.minAddons, num(rg.min_addons))),
      max: Math.max(0, num(rg.maxAddons, num(rg.max_addons))),
      choices,
    });
  }
  return out;
}

/** The variants / add-ons Swiggy holds on a cart line, as a FoodCartSelection. */
function remoteSelection(it: Record<string, unknown>): FoodCartSelection | undefined {
  const variants = (Array.isArray(it.variants) ? it.variants : [])
    .filter(isRecord)
    .map((v) => ({ groupId: firstId(v, ["group_id", "groupId"]), variationId: firstId(v, ["variation_id", "variationId", "id"]), name: str(v.name) }))
    .filter((v) => v.groupId && v.variationId);
  const addons = (Array.isArray(it.addons) ? it.addons : [])
    .filter(isRecord)
    .map((a) => ({ groupId: firstId(a, ["group_id", "groupId"]), choiceId: firstId(a, ["choice_id", "choiceId", "id", "addon_id"]), name: str(a.name), price: num(a.price) }))
    .filter((a) => a.groupId && a.choiceId);
  if (!variants.length && !addons.length) return undefined;
  // [UNCERTAIN] the cart doesn't say which variant format the dish uses; the
  // route keeps the format the user's own selection carried (search_menu's).
  return { format: "variantsV2", variants, addons };
}

/** Map a get_food_cart / update_food_cart inner `data` object -> FoodCart. */
export function mapFoodCart(data: unknown): FoodCart {
  const d = isRecord(data) ? data : {};
  const restaurant = isRecord(d.restaurant) ? d.restaurant : {};
  const pricing = isRecord(d.pricing) ? d.pricing : {};
  const rawItems = Array.isArray(d.items) ? d.items : [];

  const items: FoodCartLine[] = rawItems.filter(isRecord).map((it): FoodCartLine => {
    const quantity = num(it.quantity, 1);
    // final_price / total / subtotal are LINE totals; FoodCartLine.price is the
    // per-unit effective price.
    const lineTotal =
      it.final_price !== undefined
        ? num(it.final_price)
        : it.total !== undefined
          ? num(it.total)
          : num(it.subtotal);
    const detail = [selectionLabel(it.variants), selectionLabel(it.addons)].filter(Boolean).join(" · ");
    const subtotal = it.subtotal !== undefined ? num(it.subtotal) : undefined;
    const final = it.final_price !== undefined ? num(it.final_price) : undefined;
    const validAddons = mapValidAddons(it.valid_addons);
    const selection = remoteSelection(it);
    return {
      menuItemId: idStr(it.menu_item_id),
      name: str(it.name),
      imageUrl: getSwiggyImageUrl(it, IMG_THUMB),
      quantity,
      veg: isVegFlag(it.is_veg),
      price: quantity > 0 ? lineTotal / quantity : lineTotal,
      inStock: it.in_stock === undefined ? true : it.in_stock !== false,
      detail: detail || undefined,
      // a per-line discount shows as subtotal (struck) vs final_price
      ...(subtotal !== undefined && final !== undefined && subtotal > final ? { lineSubtotal: subtotal, lineFinal: final } : {}),
      ...(validAddons ? { validAddons } : {}),
      ...(selection ? { selection } : {}),
    };
  });

  const itemTotal = num(pricing.item_total);
  // `item_count` is DISTINCT lines; FoodCart.itemCount is total quantity.
  const itemCount = items.reduce((n, l) => n + l.quantity, 0);

  // `offers.coupon_applied` is a code STRING. A coupon is applied only when
  // coupon_discount > 0; with discount 0 it is just Swiggy's suggestion.
  const offers = isRecord(d.offers) ? d.offers : {};
  const couponDiscount = num(offers.coupon_discount);
  const couponCode = str(offers.coupon_applied);
  const appliedCoupon =
    couponCode && couponDiscount > 0 ? { code: couponCode, savings: Math.round(couponDiscount) } : null;
  const bestCoupon: Coupon | null =
    couponCode && couponDiscount <= 0 ? { code: couponCode, savings: 0, title: "Suggested by Swiggy" } : null;

  return {
    restaurantId: idStr(restaurant.id) || null,
    restaurantName: str(restaurant.name) || null,
    items,
    itemCount,
    itemTotal,
    taxes: num(pricing.taxes_and_charges),
    deliveryCharge: num(pricing.delivery_charge),
    toPay: num(pricing.to_pay, itemTotal),
    appliedCoupon,
    bestCoupon,
    synced: true,
    ...(num(pricing.delivery_charge_strikeoff) > num(pricing.delivery_charge)
      ? { deliveryChargeStrikeoff: num(pricing.delivery_charge_strikeoff) }
      : {}),
    ...(offers.free_delivery_applied === true ? { freeDeliveryApplied: true } : {}),
    ...(str(restaurant.area) ? { restaurantArea: str(restaurant.area) } : {}),
    ...(str(restaurant.deliverySubtitle) ? { deliverySubtitle: str(restaurant.deliverySubtitle) } : {}),
  };
}

/** A cart line the caller wants on Swiggy. */
export interface DesiredFoodItem {
  menuItemId: string;
  quantity: number;
  selection?: FoodCartSelection;
}

/**
 * One `cartItems[]` entry for update_food_cart.
 * [UNCERTAIN] The element shape is not documented beyond `menu_item_id` being
 * the id update_food_cart uses and items carrying variants OR variantsV2 (same
 * format as search_menu) plus addons. Group/choice ids are sent paired exactly
 * as search_menu returned them.
 */
function toCartItem(i: DesiredFoodItem): Record<string, unknown> {
  const item: Record<string, unknown> = { menu_item_id: i.menuItemId, quantity: i.quantity };
  const sel = i.selection;
  if (sel && sel.variants.length) {
    const variants = sel.variants.map((v) => ({ group_id: v.groupId, variation_id: v.variationId }));
    item[sel.format === "variantsV2" ? "variantsV2" : "variants"] = variants;
  }
  if (sel && sel.addons.length) {
    item.addons = sel.addons.map((a) => ({ group_id: a.groupId, choice_id: a.choiceId }));
  }
  return item;
}

/** SET the given items on the Swiggy cart. Returns the error message on failure. */
async function pushUpdate(
  addressId: string,
  restaurantId: string,
  restaurantName: string,
  items: DesiredFoodItem[],
  cutleryOptIn?: boolean,
): Promise<string | null> {
  try {
    const args: Record<string, unknown> = {
      restaurantId,
      addressId,
      cartItems: items.map(toCartItem),
    };
    if (restaurantName) args.restaurantName = restaurantName;
    // Live schema: true = request cutlery, false = skip, omit = unchanged.
    if (typeof cutleryOptIn === "boolean") args.cutleryOptIn = cutleryOptIn;
    coerceToolPayload(await callTool(FOOD_URL, RAW_TOOL.updateFoodCart, args));
    return null;
  } catch (err) {
    if (isAuthError(err)) throw err;
    console.error("[food-mcp] update_food_cart failed:", err);
    return err instanceof Error ? err.message : "Swiggy couldn't update the cart.";
  }
}

/** The set of menu_item_ids currently in a get_food_cart inner `data` object. */
function cartItemIds(data: unknown): Set<string> {
  const out = new Set<string>();
  const items = isRecord(data) && Array.isArray(data.items) ? data.items : [];
  for (const it of items) {
    if (!isRecord(it)) continue;
    const id = idStr(it.menu_item_id);
    if (id) out.add(id);
  }
  return out;
}

export class FoodCartSyncError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FoodCartSyncError";
  }
}

/**
 * Drive the Swiggy food cart to exactly `items`, serialized per user.
 * `update_food_cart` sets each listed item's quantity but (observed) does not
 * remove unlisted items, so:
 *  1. UPDATE-FIRST (no flush) — a failed update leaves the remote cart intact.
 *  2. Read back. Only if stale items remain (removal / restaurant switch) or the
 *     update failed do we FLUSH, re-push the full set (once more on failure)
 *     and re-read. If that still fails we throw FoodCartSyncError with
 *     Swiggy's message rather than report items over an empty remote cart.
 *
 * Returns the authoritative get_food_cart inner `data`.
 */
export async function updateFoodCart(
  addressId: string,
  restaurantId: string,
  restaurantName: string,
  items: DesiredFoodItem[],
  opts: { cutleryOptIn?: boolean } = {},
): Promise<Record<string, unknown> | null> {
  const cutlery = opts.cutleryOptIn;
  return withFoodCartLock(async () => {
    const wanted = items.filter((i) => i.menuItemId && i.quantity > 0);
    const desiredIds = new Set(wanted.map((i) => i.menuItemId));

    // Empty desired set -> clear and read (nothing to re-add, so flush is safe).
    if (wanted.length === 0) {
      await flushFoodCartRaw();
      return getFoodCartDataRaw(addressId);
    }
    if (!restaurantId) throw new FoodCartSyncError("Missing restaurant for the food cart.");

    // 1) Update-first.
    const err1 = await pushUpdate(addressId, restaurantId, restaurantName, wanted, cutlery);
    let data = err1 ? null : await getFoodCartDataRaw(addressId);

    // 2) Decide whether a clean rebuild is required.
    const ids = cartItemIds(data);
    const hasStale = [...ids].some((id) => !desiredIds.has(id));
    if (err1 || !data || hasStale || ids.size === 0) {
      await flushFoodCartRaw();
      let err2 = await pushUpdate(addressId, restaurantId, restaurantName, wanted, cutlery);
      // Re-add once more on failure: never leave the cart empty after the flush.
      if (err2) err2 = await pushUpdate(addressId, restaurantId, restaurantName, wanted, cutlery);
      if (err2) throw new FoodCartSyncError(err2);
      data = await getFoodCartDataRaw(addressId);
    }
    return data;
  });
}

/** Empty the Swiggy food cart (lock-free core, used inside the cart lock). */
async function flushFoodCartRaw(): Promise<void> {
  coerceToolPayload(await callTool(FOOD_URL, RAW_TOOL.flushFoodCart, {}));
}

/** Empty the Swiggy food cart (serialized with other cart ops). */
export async function flushFoodCart(): Promise<void> {
  return withFoodCartLock(() => flushFoodCartRaw());
}

/**
 * Read get_food_cart. The cart lives at `data.data`; `addressId` and the
 * payment hints sit on the outer `data`. Returns the inner cart object (or null
 * when Swiggy returned no cart). Lock-free.
 */
async function getFoodCartDataRaw(
  addressId: string,
  restaurantName?: string,
): Promise<Record<string, unknown> | null> {
  const args: Record<string, unknown> = { addressId };
  if (restaurantName) args.restaurantName = restaurantName;
  const payload = coerceToolPayload(await callTool(FOOD_URL, RAW_TOOL.getFoodCart, args));
  if (isRecord(payload) && isRecord(payload.data)) return payload.data;
  if (isRecord(payload) && Array.isArray(payload.items)) return payload;
  return null;
}

/** Read the current Swiggy food cart -> FoodCart (empty when there is none). Throws on failure. */
export async function getFoodCart(addressId: string, restaurantName?: string): Promise<FoodCart> {
  // Serialize the read so it can't land mid-mutation and see a half-built cart.
  const data = await withFoodCartLock(() => getFoodCartDataRaw(addressId, restaurantName));
  return data ? mapFoodCart(data) : { ...emptyFoodCart(), synced: true };
}

/* -------------------------------- coupons ---------------------------------- */

/**
 * Every coupon fetch_food_coupons lists (`coupon_sections[].coupons[]`; the
 * server already filters to COD-compatible offers — `summary.filter_applied`).
 * Applicable ones come first; the rest keep `applicable: false` so the UI can
 * show them greyed with Swiggy's own subtitle (e.g. "Add ₹99 more"). Swiggy
 * returns no rupee value here, so `savings` stays 0 until the coupon is applied
 * and the cart reports `coupon_discount`.
 * [UNCERTAIN] The docs give `id` as the only coupon identifier; it is used as
 * the `couponCode` for apply_food_coupon.
 */
export function mapFoodCoupons(payload: unknown): Coupon[] {
  const obj = unwrapTo(payload, "coupon_sections");
  const out: Coupon[] = [];
  const seen = new Set<string>();
  for (const rawSection of Array.isArray(obj.coupon_sections) ? obj.coupon_sections : []) {
    const section = isRecord(rawSection) ? rawSection : {};
    for (const rawCoupon of Array.isArray(section.coupons) ? section.coupons : []) {
      const c = isRecord(rawCoupon) ? rawCoupon : {};
      const code = idStr(c.id);
      if (!code || seen.has(code.toUpperCase())) continue;
      seen.add(code.toUpperCase());
      const tnc = isRecord(c.terms_and_conditions) ? c.terms_and_conditions : {};
      const terms = (Array.isArray(tnc.bullet_texts) ? tnc.bullet_texts : [])
        .map((t) => str(t).trim())
        .filter(Boolean);
      out.push({
        code,
        title: str(c.title) || undefined,
        description: str(c.description, str(c.subtitle)) || undefined,
        savings: 0,
        applicable: c.applicable === true,
        ...(str(c.subtitle) && str(c.subtitle) !== str(c.description) ? { subtitle: str(c.subtitle) } : {}),
        ...(str(c.ribbon_text) ? { ribbon: str(c.ribbon_text) } : {}),
        ...(str(section.title) ? { section: str(section.title) } : {}),
        ...(terms.length ? { terms } : {}),
      });
    }
  }
  // stable: applicable first, Swiggy's order within each group
  return out.sort((a, b) => Number(b.applicable) - Number(a.applicable));
}

/** fetch_food_coupons `summary.filter_applied` ("COD only") — shown next to the list. */
export function foodCouponFilter(payload: unknown): string | undefined {
  const obj = unwrapTo(payload, "coupon_sections");
  const summary = isRecord(obj.summary) ? obj.summary : {};
  return str(summary.filter_applied) || undefined;
}

/** fetch_food_coupons -> every listed coupon + Swiggy's filter note ("COD only"). Read-only. */
export async function fetchFoodCoupons(
  addressId: string,
  restaurantId: string,
): Promise<{ coupons: Coupon[]; filter?: string }> {
  if (!restaurantId) return { coupons: [] };
  const payload = coerceToolPayload(
    await callTool(FOOD_URL, RAW_TOOL.fetchFoodCoupons, { restaurantId, addressId }),
  );
  return { coupons: mapFoodCoupons(payload), filter: foodCouponFilter(payload) };
}

/**
 * Apply a coupon (apply_food_coupon {couponCode, addressId}). The coupon is
 * applied only when the returned cart shows the code AND coupon_discount > 0.
 * Never retried automatically (non-idempotent per the client policy).
 */
export async function applyFoodCoupon(
  addressId: string,
  couponCode: string,
): Promise<{ applied: boolean; discount: number; message?: string }> {
  return withFoodCartLock(async () => {
    const raw = await callTool(FOOD_URL, RAW_TOOL.applyFoodCoupon, { couponCode, addressId });
    const payload = coerceToolPayload(raw);
    const outer = isRecord(payload) ? payload : {};
    const inner = isRecord(outer.data) ? outer.data : outer;
    const offers = isRecord(inner.offers) ? inner.offers : {};
    const pricing = isRecord(inner.pricing) ? inner.pricing : {};
    const discount = num(offers.coupon_discount, num(pricing.coupon_discount));
    const applied = discount > 0 && Boolean(str(offers.coupon_applied, couponCode));
    return {
      applied,
      discount: applied ? Math.round(discount) : 0,
      message: str(outer.statusMessage) || envelopeMessage(raw),
    };
  });
}

/* --------------------------------- orders ---------------------------------- */

/** Raw get_food_orders `orders[]` (newest first, across all addresses). */
export async function getFoodOrders(
  addressId: string,
  opts: { activeOnly?: boolean; orderCount?: number } = {},
): Promise<Record<string, unknown>[]> {
  const args: Record<string, unknown> = { addressId };
  if (opts.activeOnly) args.activeOnly = true;
  if (opts.orderCount) args.orderCount = Math.min(15, Math.max(1, opts.orderCount));
  const payload = coerceToolPayload(await callTool(FOOD_URL, RAW_TOOL.getFoodOrders, args));
  const obj = unwrapTo(payload, "orders");
  return (Array.isArray(obj.orders) ? obj.orders : []).filter(isRecord);
}

/* ------------------------------ order details ------------------------------ */

const rupees = (v: unknown): string | undefined => {
  if (typeof v === "string" && v.trim()) return /₹/.test(v) ? v.trim() : `₹${v.trim()}`;
  if (typeof v === "number" && Number.isFinite(v)) return `₹${Math.round(v * 100) / 100}`;
  return undefined;
};

/**
 * get_food_order_details → OrderDetails. Documented body: `data.order` with
 * order_items[], charges{}, order_total, payment_method, delivery_address…
 * Live (2026-10-22) the structuredContent is `{}` and the detail is in the text
 * content, so when no structured order comes back we keep Swiggy's own text
 * (coerceToolPayload → `{ text }`) and show it verbatim — nothing invented.
 */
export function mapFoodOrderDetails(payload: unknown, orderId: string): OrderDetails | null {
  const root = isRecord(payload) ? payload : {};
  const data = isRecord(root.data) ? root.data : root;
  const o = isRecord(data.order) ? data.order : Array.isArray(data.order_items) ? data : null;
  if (!o) {
    const text = str(root.text).trim() || str(data.statusMessage).trim();
    return text ? parseFoodOrderDetailsText(text, orderId) : null;
  }
  const items: OrderDetails["items"] = [];
  for (const raw of Array.isArray(o.order_items) ? o.order_items : []) {
    if (!isRecord(raw)) continue;
    const name = str(raw.name);
    if (!name) continue;
    const parts = [
      ...(Array.isArray(raw.variants) ? raw.variants : []),
      ...(Array.isArray(raw.addons) ? raw.addons : []),
    ]
      .map((c) => (isRecord(c) ? str(c.name) : ""))
      .filter(Boolean);
    const qty = num(raw.quantity, 0);
    items.push({
      name,
      ...(qty > 0 ? { quantity: qty } : {}),
      ...(rupees(raw.final_price ?? raw.total) ? { price: rupees(raw.final_price ?? raw.total) } : {}),
      ...(parts.length ? { customizations: parts.join(" · ") } : {}),
      ...(raw.is_veg !== undefined ? { isVeg: String(raw.is_veg) === "1" } : {}),
      ...(swiggyImageUrl(raw.image_id, IMG_THUMB) ? { imageUrl: swiggyImageUrl(raw.image_id, IMG_THUMB) } : {}),
    });
  }
  const charges: OrderDetails["charges"] = [];
  const ch = isRecord(o.charges) ? o.charges : {};
  for (const [label, amount] of Object.entries(ch)) {
    const a = rupees(amount);
    if (a && !/^₹0(\.0+)?$/.test(a)) charges.push({ label: label.replace(/_/g, " "), amount: a });
  }
  if (num(o.coupon_discount, 0) > 0) charges.push({ label: "Coupon discount", amount: `−${rupees(o.coupon_discount)}` });
  const addr = isRecord(o.delivery_address) ? o.delivery_address : {};
  const deliveryAddress =
    str(addr.address) || [str(addr.flat_no), str(addr.address_line1), str(addr.area), str(addr.city)].filter(Boolean).join(", ");
  return {
    orderId: idStr(o.order_id) || orderId,
    title: str(o.restaurant_name) || undefined,
    area: str(o.restaurant_area_name) || str(o.restaurant_locality) || undefined,
    status: str(o.order_status) || str(o.post_status) || undefined,
    placedAt: str(o.order_time) || undefined,
    items,
    charges,
    total: rupees(o.order_total),
    paymentMethod: str(o.payment_method) || undefined,
    deliveryAddress: deliveryAddress || undefined,
    coupon: o.is_coupon_applied === true ? str(o.coupon_applied) || undefined : undefined,
    ...(typeof o.is_cancellable === "boolean" ? { cancellable: o.is_cancellable } : {}),
  };
}

/**
 * The live get_food_order_details reply is text only, e.g.
 *   Order 2448… — Isha Fast Food (Viralimalai)
 *   Delivered | regular
 *   Placed: 2026-08-04 13:37:52
 *   Items (3):
 *     - Chicken noodles — ₹0 | Non-veg [image: https://…jpg]
 *         Serves 2 - 1000ml ₹419
 *   Delivery address: …
 *   Total paid: ₹36
 *   Payment: Bank
 * Parse it into the same OrderDetails shape; keep the raw text as a fallback.
 */
export function parseFoodOrderDetailsText(text: string, orderId: string): OrderDetails {
  const lines = text.split("\n");
  const out: OrderDetails = { orderId, items: [], charges: [], text };
  const head = lines[0]?.match(/^Order\s+(\S+)\s+—\s+(.+?)(?:\s+\(([^)]+)\))?\s*$/);
  if (head) {
    out.orderId = head[1] || orderId;
    out.title = head[2];
    if (head[3]) out.area = head[3];
  }
  if (lines[1] && !lines[1].includes(":")) out.status = lines[1].split("|")[0].trim() || undefined;
  let inItems = false;
  for (const raw of lines) {
    const line = raw.trimEnd();
    const kv = line.match(/^(Placed|Delivery address|Total paid|Payment|Coupon):\s*(.+)$/i);
    if (kv) {
      inItems = false;
      const [, k, v] = kv;
      if (/^placed/i.test(k)) out.placedAt = v;
      else if (/^delivery/i.test(k)) out.deliveryAddress = v;
      else if (/^total/i.test(k)) out.total = v;
      else if (/^payment/i.test(k)) out.paymentMethod = v;
      else if (/^coupon/i.test(k)) out.coupon = v;
      continue;
    }
    if (/^Items\s*\(\d+\):/i.test(line)) {
      inItems = true;
      continue;
    }
    if (!inItems || !line.trim()) continue;
    const item = line.match(/^\s*-\s+(.+?)\s+—\s+(₹[\d,.]+)(?:\s*\|\s*([^[]+?))?\s*(?:\[image:\s*([^\]]+)\])?\s*$/);
    if (item) {
      const [, name, price, vegText, img] = item;
      const qty = name.match(/^(.*?)\s*(?:x|×)\s*(\d+)$/i);
      out.items.push({
        name: qty ? qty[1] : name,
        ...(qty ? { quantity: Number(qty[2]) } : {}),
        // "₹0" lines are free / bundled — don't show a misleading price.
        ...(price && !/^₹0(\.0+)?$/.test(price) ? { price } : {}),
        ...(vegText ? { isVeg: /^veg/i.test(vegText.trim()) } : {}),
        ...(img && swiggyImageUrl(img.trim(), IMG_THUMB) ? { imageUrl: swiggyImageUrl(img.trim(), IMG_THUMB) } : {}),
      });
      continue;
    }
    // indented continuation = variant / add-on of the previous item
    const last = out.items[out.items.length - 1];
    if (last && /^\s{4,}\S/.test(raw)) {
      last.customizations = [last.customizations, line.trim()].filter(Boolean).join(" · ");
    }
  }
  return out;
}

/** get_food_order_details for one order (read-only). */
export async function getFoodOrderDetails(orderId: string): Promise<OrderDetails> {
  const payload = coerceToolPayload(await callTool(FOOD_URL, "get_food_order_details", { orderId }));
  const d = mapFoodOrderDetails(payload, orderId);
  if (!d) throw new Error("Swiggy returned no details for this order.");
  return d;
}

/** Live: orders[].actions[].reorderMeta.restaurantCoverImageId (a bare CDN id / path). */
function coverImageOfOrder(o: Record<string, unknown>): string {
  for (const a of Array.isArray(o.actions) ? o.actions : []) {
    const meta = isRecord(a) && isRecord(a.reorderMeta) ? a.reorderMeta : null;
    const url = meta ? swiggyImageUrl(meta.restaurantCoverImageId) : "";
    if (url) return url;
  }
  return "";
}

/**
 * A restaurant card from one get_food_orders order: what Swiggy returned
 * (name, area, cover photo). Availability stays "UNKNOWN" until the menu is
 * opened; no rating / ETA is invented. Null without a real restaurantId.
 */
export function foodRestaurantFromOrder(o: Record<string, unknown>): FoodRestaurant | null {
  const id = idStr(o.restaurantId);
  const name = str(o.restaurantName);
  if (!id || !name) return null;
  return {
    id,
    name,
    cuisines: [],
    rating: 0,
    ratingCount: "",
    costForTwo: "",
    area: str(o.restaurantAreaName),
    distanceKm: 0,
    etaRange: "",
    offer: "",
    imageUrl: coverImageOfOrder(o),
    availability: "UNKNOWN",
    isOpen: true,
  };
}

/**
 * Place a real food order. The caller gates this (SWIGGY_ENABLE_ORDERS), has the
 * user's explicit confirmation, and handles ambiguous failures (check
 * get_food_orders, never blind-retry). Returns the unwrapped `data` plus the
 * envelope message (Swiggy's branded confirmation text).
 */
export async function placeFoodOrder(args: {
  addressId: string;
  paymentMethod: string;
  intentApp?: string;
  generateUPIQR?: boolean;
  noteToRestaurant?: string;
}): Promise<{ data: Record<string, unknown>; message?: string }> {
  const callArgs: Record<string, unknown> = {
    addressId: args.addressId,
    paymentMethod: args.paymentMethod,
  };
  if (args.paymentMethod === "UPI") {
    if (args.intentApp) callArgs.intentApp = args.intentApp;
    else if (args.generateUPIQR) callArgs.generateUPIQR = true;
  }
  if (args.noteToRestaurant?.trim()) callArgs.noteToRestaurant = args.noteToRestaurant.trim();

  const raw = await callTool(FOOD_URL, RAW_TOOL.placeFoodOrder, callArgs, { maxRetries: 0 });
  const payload = coerceToolPayload(raw);
  return { data: isRecord(payload) ? payload : {}, message: envelopeMessage(raw) };
}

/* -------------------------------- tracking --------------------------------- */

export interface FoodTracker {
  status: string;
  eta?: string;
  partner?: string;
  items?: string;
  trackUrl?: string; // Swiggy's web tracking page for this order
  progress?: number; // track_food_order progressPercentage, 0–100
  pollIntervalSec?: number; // pollIntervalSec / pollingDuration (never < 10)
}

/** Only Swiggy's own tracking pages are linked. */
function swiggyTrackUrl(v: unknown): string | undefined {
  const s = str(v).trim();
  return /^https:\/\/www\.swiggy\.com\//.test(s) ? s : undefined;
}

/** "Rate delivery" etc. from get_food_orders `actions[]` (enabled RATE_* CTAs). */
export function foodRateActions(o: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const a of Array.isArray(o.actions) ? o.actions.filter(isRecord) : []) {
    if (a.isEnabled === false || !/RATE/i.test(str(a.type))) continue;
    const label = titleCase(str(a.title)) || "Rate order";
    if (!out.includes(label)) out.push(label);
  }
  return out;
}

const titleCase = (s: string) =>
  s ? s.charAt(0).toUpperCase() + s.slice(1).toLowerCase().replace(/_/g, " ") : "";

function etaFromEpoch(deliveryBy: unknown, serverNow: unknown): string | undefined {
  const by = num(deliveryBy, 0);
  const now = num(serverNow, 0) || Date.now();
  if (by <= 0) return undefined;
  const mins = Math.round((by - now) / 60_000);
  return mins > 0 ? `${mins} min${mins === 1 ? "" : "s"}` : undefined;
}

/** get_food_orders payload -> every order (newest first) for the order-history card. */
export function pastFoodOrders(payload: unknown): PastOrder[] {
  const obj = unwrapTo(payload, "orders");
  return (Array.isArray(obj.orders) ? obj.orders : []).filter(isRecord).map((o) => {
    const actions = Array.isArray(o.actions) ? o.actions.filter(isRecord) : [];
    const reorder = actions.find((a) => isRecord(a.reorderMeta));
    const cover = reorder && isRecord(reorder.reorderMeta) ? str(reorder.reorderMeta.restaurantCoverImageId) : "";
    const status = str(o.orderDeliveryStatus) || str(o.orderStatus);
    return {
      orderId: idStr(o.orderId),
      title: str(o.restaurantName, "Restaurant"),
      items: str(o.orderedItems) || undefined,
      status: titleCase(str(o.orderStatus) || status) || "Unknown",
      total: str(o.orderTotal) || undefined,
      placedAt: str(o.orderedTime) || undefined,
      area: str(o.restaurantAreaName) || undefined,
      imageUrl: cover ? swiggyImageUrl(cover, IMG_THUMB) || undefined : undefined,
      active: o.isActiveOrder === true,
      reorderable: !!reorder,
      ...(str(o.orderType) ? { orderType: str(o.orderType) } : {}),
      ...(foodRateActions(o).length ? { rateActions: foodRateActions(o) } : {}),
      ...(idStr(o.restaurantId) ? { restaurantId: idStr(o.restaurantId) } : {}),
    };
  });
}

/** get_food_orders payload -> tracker for the newest active order (else the newest). */
export function trackerFromFoodOrders(payload: unknown): FoodTracker | null {
  const obj = unwrapTo(payload, "orders");
  const orders = (Array.isArray(obj.orders) ? obj.orders : []).filter(isRecord);
  const o = orders.find((x) => x.isActiveOrder === true) ?? orders[0] ?? null;
  if (!o) return null;
  const raw = str(o.orderDeliveryStatus) || str(o.orderStatus);
  if (!raw) return null;
  // Carry the order id (exactly as returned) so the model can follow up with
  // track_food_order / get_food_delivery_status, and the user can quote it.
  const orderId = idStr(o.orderId);
  return {
    status: titleCase(raw),
    items:
      [orderId ? `Order #${orderId}` : "", str(o.orderedItems), str(o.restaurantName)]
        .filter(Boolean)
        .join(" · ") || undefined,
    ...(orderId ? { trackUrl: `https://www.swiggy.com/track-order/${encodeURIComponent(orderId)}` } : {}),
  };
}

/** track_food_order payload -> tracker for the first (or only) tracked order. */
export function trackerFromTrackFoodOrder(payload: unknown): FoodTracker | null {
  const obj = unwrapTo(payload, "orders");
  const o = Array.isArray(obj.orders) && isRecord(obj.orders[0]) ? obj.orders[0] : null;
  if (!o) return null;
  const status = str(o.orderStatus) || str(o.title);
  if (!status) return null;
  const pct = num(o.progressPercentage, -1);
  const poll = num(o.pollingDuration, 0);
  const orderId = idStr(o.orderId);
  return {
    status: titleCase(status),
    eta: str(o.etaText) || undefined,
    items:
      [orderId ? `Order #${orderId}` : "", str(o.title) !== status ? str(o.title) : "", str(o.subtitle)]
        .filter(Boolean)
        .join(" · ") || undefined,
    trackUrl:
      swiggyTrackUrl(o.trackUrl) ?? (orderId ? `https://www.swiggy.com/track-order/${encodeURIComponent(orderId)}` : undefined),
    ...(pct >= 0 ? { progress: Math.min(100, Math.round(pct)) } : {}),
    // pollingDuration is in seconds (docs: poll no faster than every 10 s)
    ...(poll > 0 ? { pollIntervalSec: Math.max(10, Math.round(poll)) } : {}),
  };
}

/** get_food_delivery_status payload -> tracker (statusText + ETA; terminal flags). */
export function trackerFromDeliveryStatus(payload: unknown): FoodTracker | null {
  const o = unwrapTo(payload, "pollIntervalSec");
  const delivered = o.delivered === true;
  const cancelled = o.cancelled === true;
  const statusText = str(o.statusText);
  const status = delivered ? "Delivered" : cancelled ? "Cancelled" : statusText;
  if (!status) return null;
  const poll = num(o.pollIntervalSec, 0);
  return {
    status,
    eta: delivered || cancelled ? undefined : str(o.etaText) || etaFromEpoch(o.deliveryBy, o.serverNow),
    items:
      [idStr(o.orderId) ? `Order #${idStr(o.orderId)}` : "", delivered || cancelled ? statusText : ""]
        .filter(Boolean)
        .join(" · ") || undefined,
    ...(swiggyTrackUrl(o.trackUrl) ? { trackUrl: swiggyTrackUrl(o.trackUrl) } : {}),
    ...(poll > 0 && !delivered && !cancelled ? { pollIntervalSec: Math.max(10, Math.round(poll)) } : {}),
  };
}
