// Runs our Food / Instamart / payment parsers on REAL Swiggy MCP payloads
// captured on 2026-10-22 (docs/swiggy-mcp/live/*.json) and asserts that
// products, dishes, restaurants, menus, carts, orders and payment options
// parse with real photos and prices.
// Run: npx tsx --tsconfig tsconfig.json scripts/verify-food-instamart.ts

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { cacheFromEvent, mapToolResult, type FoodResolved } from "@/backend/agent/agent";
import { resolveMealPlan, numbersGrounded } from "@/backend/agent/food-ai";
import { eventAllowedFor, summarize } from "@/backend/agent/runner";
import {
  aiSelection,
  dedupeAddonGroups,
  explainFoodBill,
  menuInsights,
  partySize,
  pickDefaultAddons,
  pickVariant,
} from "@/shared/foodAi";
import type { PromptContext } from "@/backend/agent/services";
import { mapFoodHistory } from "@/backend/history/history-map";
import {
  foodCouponFilter,
  foodRestaurantFromOrder,
  mapFoodCart,
  mapFoodCoupons,
  mapValidAddons,
  pastFoodOrders,
  mapFoodRestaurants,
  mapSearchMenu,
  normalizeMenu,
  trackerFromDeliveryStatus,
  trackerFromFoodOrders,
  trackerFromTrackFoodOrder,
} from "@/backend/mcp/food-mcp";
import { swiggyImageUrl } from "@/backend/mcp/image";
import { mapPaymentOptions } from "@/backend/mcp/payment-mcp";
import {
  approvedLines,
  assembleBasket,
  basketTotal,
  choosePack,
  closestSubstitute,
  parseNeed,
  parsePack,
  rankProducts,
  toPick,
  usualPick,
} from "@/shared/instamart-packs";
import { checkoutReadiness, reviewCart } from "@/shared/instamart-review";
import { coerceToolPayload } from "@/backend/mcp/payload";
import {
  cartToState,
  mapAddressPage,
  mapCartPayload,
  mapProductsPayload,
  sameAddressId,
} from "@/backend/mcp/swiggy-mcp";

const LIVE = join(process.cwd(), "docs/swiggy-mcp/live");
const BLR = "d1k9ctrdq1ocsktt0090__AMXrgASg728rGDWKq4_ky_";
const CHENNAI = "db7kh1c1d96ofdam8g8g__AMVEDwTGeS8WPRJQbO-o12";
const CDN = /^https:\/\/media-assets\.swiggy\.com\/swiggy\/image\/upload\/fl_lossy,f_auto,q_auto,w_\d+\/\S+$/;

type Capture = { structuredContent?: Record<string, unknown>; result?: Record<string, unknown> };
const load = (f: string): Capture => JSON.parse(readFileSync(join(LIVE, f), "utf8")) as Capture;
/** The payload exactly as client.ts → coerceToolPayload would hand it to us. */
const payloadOf = (f: string): unknown => {
  const c = load(f);
  return coerceToolPayload(c.result ?? { content: [], structuredContent: c.structuredContent });
};

let checks = 0;
function check(name: string, fn: () => void) {
  fn();
  checks++;
  console.log(`  ok  ${name}`);
}
const isPhoto = (u: string) => CDN.test(u);

console.log("Instamart");

check("search_products → products with per-variation photos + prices", () => {
  const { products, similarProducts, nextOffset } = mapProductsPayload(payloadOf("im_search_products.json"));
  assert.equal(products.length, 3);
  assert.equal(similarProducts.length, 1);
  assert.equal(nextOffset, "1");
  for (const p of [...products, ...similarProducts]) {
    assert.ok(p.productId && p.name && p.brand, `product fields: ${p.name}`);
    for (const v of p.variations) {
      assert.ok(v.spinId && v.skuId, "spin/sku");
      assert.ok(isPhoto(v.imageUrl), `photo: ${v.imageUrl}`);
      assert.ok(v.offerPrice > 0 && v.mrp >= v.offerPrice, `price ${v.offerPrice}/${v.mrp}`);
    }
  }
  const milky = products[0];
  assert.equal(milky.variations[0].offerPrice, 202);
  assert.equal(milky.variations[0].mrp, 330);
  assert.equal(milky.variations[0].unitLevelPrice, "50.5/100 g");
  assert.equal(milky.variations[1].maxQuantity, 6);
  // A live catalog path with a literal space is escaped, not broken.
  const epigamia = products[1].variations[0].imageUrl;
  assert.ok(epigamia.includes("NPI-099468%20_1_") && !epigamia.includes(" "), epigamia);
});

check("your_go_to_items → products; nextOffset \"0\" ends paging", () => {
  const { products, nextOffset } = mapProductsPayload(payloadOf("im_your_go_to_items.json"));
  assert.equal(products.length, 3);
  assert.equal(nextOffset, null);
  assert.ok(products.every((p) => p.variations.every((v) => isPhoto(v.imageUrl) && v.offerPrice > 0)));
  // A variation without unitLevelPrice (Thyronorm) still parses.
  assert.equal(products[2].variations[0].unitLevelPrice, undefined);
  assert.equal(products[2].variations[0].offerPrice, 147);
});

check("get_cart (raw, two text blocks + structuredContent) → cart with photos + bill", () => {
  const view = mapCartPayload(payloadOf("im_get_cart.raw.json"));
  assert.equal(view.items.length, 1);
  const line = view.items[0];
  assert.equal(line.name, "Godrej Yummiez Cheese Corn Nuggets");
  assert.equal(line.unitPrice, 219);
  assert.equal(line.mrp, 240);
  assert.ok(isPhoto(line.imageUrl), line.imageUrl);
  assert.equal(view.bill?.total, "₹266");
  assert.equal(view.bill?.lines.length, 4);
  assert.equal(view.payableTotal, 266);
  assert.equal(view.boundAddressId, "db7kh1c1d96ofdam8g8g"); // SHORT id, live
  // Same address (short vs full) → no "bound elsewhere" flag; other address → flag.
  assert.equal(cartToState(view, CHENNAI).boundAddressId, undefined);
  assert.equal(cartToState(view, BLR).boundAddressId, "db7kh1c1d96ofdam8g8g");
  assert.ok(sameAddressId("db7kh1c1d96ofdam8g8g", CHENNAI));
  assert.ok(!sameAddressId("db7kh1c1d96ofdam8g8g", BLR));
});

check("get_cart text-only (structuredContent {}) → JSON read from content[1]", () => {
  const raw = load("im_get_cart.raw.json").result as { content: unknown[] };
  const viaText = mapCartPayload(coerceToolPayload({ content: raw.content, structuredContent: {} }));
  assert.equal(viaText.items.length, 1);
  assert.equal(viaText.bill?.total, "₹266");
});

check("get_orders (empty) → no tracker card", () => {
  const evs = mapToolResult({ bareTool: "get_orders", query: "", input: {} }, payloadOf("im_get_orders.raw.json"), {} as PromptContext);
  assert.equal(evs.length, 0);
});

console.log("Instamart field audit (docs/swiggy-mcp/fields/instamart.md)");

check("search_products (eggs) → badges, Sponsored, rating, sla, unit price, caps, similar", () => {
  const { products, similarProducts, nextOffset } = mapProductsPayload(payloadOf("im_search_products_eggs.json"));
  assert.equal(nextOffset, "1");
  assert.equal(products.length, 4);
  const [fresh, eggozAd, eggozSwitch, fresh6] = products;
  // Bestseller badge in Swiggy's own colour; not sponsored.
  assert.deepEqual(fresh.badges, [{ type: "BADGE_TYPE_BEST_SELLER", text: "Bestseller", backgroundColor: "#238BF4" }]);
  assert.equal(fresh.isPromoted, false);
  // Two packs, each with its own price, unit price, cap and cap message.
  assert.equal(fresh.variations.length, 2);
  assert.equal(fresh.variations[0].quantityDescription, "12 Pieces x 2");
  assert.equal(fresh.variations[0].unitLevelPrice, "8.7/piece");
  assert.equal(fresh.variations[0].maxQuantity, 3);
  assert.equal(fresh.variations[0].maxQuantityMessage, "Only 3 unit(s) of this item can be added per order.");
  assert.deepEqual(fresh.variations[0].rating, { value: "4.4", count: "140.4k" });
  assert.equal(fresh.variations[0].sla, "14 mins");
  // VEG_CLASSIFIER_INVALID (eggs are not classified) → no veg mark.
  assert.equal(fresh.variations[0].veg, undefined);
  // isPromoted + Ad badge → sponsored listing.
  assert.equal(eggozAd.isPromoted, true);
  assert.ok(eggozAd.badges?.some((b) => b.type === "BADGE_TYPE_AD"));
  assert.deepEqual(eggozSwitch.badges?.map((b) => b.text), ["Switch", "Ad"]);
  assert.equal(eggozSwitch.variations[0].maxQuantityMessage, "That’s all we have in stock at the moment!");
  assert.equal(fresh6.badges, undefined);
  assert.equal(similarProducts.length, 1);
  assert.equal(similarProducts[0].name, "Hatsun Curd");
  assert.ok(isPhoto(similarProducts[0].variations[0].imageUrl));
});

check("search_products (vague) → no rating / unit price is fine; per-item sla", () => {
  const { products } = mapProductsPayload(payloadOf("im_search_products_vague.json"));
  assert.equal(products.length, 3);
  assert.equal(products[0].variations[0].rating, undefined);
  assert.equal(products[0].variations[0].unitLevelPrice, undefined);
  assert.equal(products[1].variations[0].sla, "29 mins");
  assert.deepEqual(products[2].variations[0].rating, { value: "4.4", count: "368" });
});

check("search_products offset=1 → nextOffset \"2\"; pack without a cap parses", () => {
  const { products, nextOffset } = mapProductsPayload(payloadOf("im_search_products_offset1.json"));
  assert.equal(nextOffset, "2");
  const crax = products[1];
  assert.equal(crax.isPromoted, true);
  assert.equal(crax.variations[1].maxQuantity, undefined);
  assert.equal(crax.variations[1].maxQuantityMessage, undefined);
  assert.equal(crax.variations[1].unitLevelPrice, "47.7/100 g");
});

check("your_go_to_items → vegClassifier VEG → veg mark", () => {
  const { products } = mapProductsPayload(payloadOf("im_your_go_to_items.json"));
  assert.equal(products[0].variations[0].veg, "veg");
  assert.equal(products[0].variations[0].sla, "17 mins");
});

check("agent summary → model sees packs, unit price, rating, sla, Sponsored, badges, paging", () => {
  const evs = mapToolResult({ bareTool: "search_products", query: "eggs", input: {} }, payloadOf("im_search_products_eggs.json"), {} as PromptContext);
  assert.deepEqual(evs.map((e) => e.type), ["products", "products"]);
  const first = evs[0];
  assert.ok(first.type === "products" && first.products[1].isPromoted && first.nextOffset === "1");
  const text = summarize(evs);
  assert.ok(text.includes("id=PQO3B4KKNO 12 Pieces x 2 ₹208 (mrp ₹290) ₹8.7 per piece max 3"), text);
  assert.ok(text.includes("id=UCX9XSR1L6 12 Pieces ₹104 (mrp ₹145)"), "second pack listed");
  assert.ok(text.includes("★4.4 (140.4k)") && text.includes("arrives 14 mins") && text.includes("Bestseller"), text);
  assert.ok(/Eggoz White Farm Fresh Eggs \| [^\n]*SPONSORED/.test(text), "sponsored marked");
  assert.ok(!text.includes("| Ad"), "Ad badge folded into SPONSORED");
  assert.ok(text.includes("offset=1"), "paging hint");
});

check("get_addresses → tag, category, masked phone, resolution", () => {
  const page = mapAddressPage(payloadOf("im_get_addresses.json"));
  assert.equal(page.addresses.length, 3);
  assert.equal(page.hasMore, false);
  assert.deepEqual(page.addresses[2], {
    id: "cpdepit19tt3f622h3ng__AOys_QTFP0od9ekkq38oQa",
    addressLine: "Test User: [flat redacted], Ongole, Andhra Pradesh 523001, India",
    addressTag: "Home",
    addressCategory: "Home",
    phoneNumber: "****6256",
    // Swiggy sends no coordinates — the city centre comes from the line (shared/cityCoords)
    latitude: 15.5057,
    longitude: 80.0499,
    city: "Ongole",
  });
  assert.deepEqual(page.resolution, {
    defaultAddressId: CHENNAI,
    resolutionSource: "ranked_saved_address",
    needsUserClarification: true,
  });
});

check("get_cart → delivery address (masked phone), Swiggy One, To Pay label, cap message", () => {
  const view = mapCartPayload(payloadOf("im_get_cart.raw.json"));
  assert.deepEqual(view.deliveryAddress, {
    address: "West Tambaram, Tambaram, Chennai, Tamil Nadu, India",
    label: "User",
    category: "OTHER",
    name: "Test User",
    phone: "••••6256",
    flatNo: "[flat redacted]",
    area: "West Tambaram",
    city: "Chennai",
  });
  assert.deepEqual(view.swiggyOne, { userStatus: "SUPER", program: "ONE", offering: "PLUS" });
  assert.equal(view.bill?.totalLabel, "To Pay");
  assert.equal(view.items[0].maxQuantity, 3);
  assert.equal(view.items[0].maxQuantityMessage, "That's all we have in stock at the moment!");
  const state = cartToState(view, CHENNAI);
  assert.equal(state.swiggyOne?.offering, "PLUS");
  assert.equal(state.deliveryAddress?.label, "User");
  assert.equal(state.storeCount, undefined); // one store
  assert.equal(state.savings, 21); // mrp 240 − 219
});

check("get_cart (cartAbsent) → empty, no bill/address; payment options (empty cart) → none", () => {
  const view = mapCartPayload(payloadOf("im_get_cart_empty.json"));
  assert.equal(view.absent, true);
  assert.equal(view.items.length, 0);
  const state = cartToState(view, BLR);
  assert.equal(state.bill, undefined);
  assert.equal(state.deliveryAddress, undefined);
  const o = mapPaymentOptions("instamart", payloadOf("im_get_payment_options_emptycart.json"));
  assert.deepEqual(o.allMethods, []);
  assert.equal(o.paymentAmount, null);
  assert.equal(o.agenticPaymentEligible, false);
});

console.log("Food");

check("search_restaurants → restaurant cards with photos", () => {
  const rs = mapFoodRestaurants(payloadOf("food_search_restaurants.json"));
  assert.equal(rs.length, 4);
  for (const r of rs) {
    assert.ok(r.id && r.name && r.isOpen, r.name);
    assert.ok(isPhoto(r.imageUrl), r.imageUrl);
    assert.ok(r.rating > 0 && r.costForTwo && r.etaRange && r.area, `meta ${r.name}`);
  }
  assert.equal(rs[0].distanceKm, 0.4);
  assert.equal(rs[0].etaRange, "35-45 MINS");
  // Bare CDN id (no path) and "_compressed" suffix both stay real photos.
  assert.ok(rs[3].imageUrl.endsWith("/dgqyjag69zrlxnmckwc4"));
  assert.ok(rs[2].imageUrl.endsWith(".jpg_compressed"));
});

check("search_menu (cross-restaurant) → dishes with photos, prices, own restaurant", () => {
  const { dishes, hasMore, nextOffset } = mapSearchMenu(payloadOf("food_search_menu.json"));
  assert.equal(dishes.length, 4);
  assert.ok(hasMore);
  assert.equal(nextOffset, 10);
  for (const d of dishes) {
    assert.ok(d.id && d.name && d.restaurantId && d.restaurantName, d.name);
    assert.ok(d.price > 0 && d.veg && d.inStock, `${d.name} ₹${d.price}`);
    assert.ok(isPhoto(d.imageUrl), d.imageUrl);
  }
  assert.equal(dishes[3].restaurantName, "Meghana Foods");
  assert.ok(dishes[0].hasAddons); // flag only — the cross search returns no addon groups
});

check("search_menu (scoped) → restaurant from fallback + real addon groups", () => {
  const { dishes } = mapSearchMenu(payloadOf("food_search_menu_scoped.json"), "271", "Meghana Foods");
  assert.equal(dishes.length, 2);
  assert.ok(dishes.every((d) => d.restaurantId === "271" && isPhoto(d.imageUrl)));
  const pb = dishes[1];
  assert.equal(pb.customization?.addonGroups.length, 2);
  assert.equal(pb.customization?.addonGroups[1].max, 7);
  assert.equal(pb.customization?.addonGroups[1].choices[0].name, "Extra Raita");
});

check("get_restaurant_menu → categories with dish photos (bare ids too)", () => {
  const menu = normalizeMenu(payloadOf("food_get_restaurant_menu.json"), undefined, "271");
  assert.equal(menu.restaurantName, "Meghana Foods");
  assert.equal(menu.isOpen, true);
  assert.equal(menu.categories.length, 2);
  assert.ok(menu.hasMore);
  const items = menu.categories.flatMap((c) => c.items);
  assert.equal(items.length, 5);
  assert.ok(items.every((i) => isPhoto(i.imageUrl) && i.price > 0), "photos + prices");
  assert.ok(items.find((i) => i.name === "Pepper Chicken")?.imageUrl.endsWith("/rlcjzwkysumyh28nxuaq"));
  assert.ok(items[0].bestseller && !items[0].veg && items[1].veg);
  assert.ok(items.find((i) => i.name === "Royal Chicken")?.inStock, "missing inStock = no signal");
});

check("agent mapToolResult → food cards", () => {
  const ctx = {} as PromptContext;
  const r = mapToolResult({ bareTool: "search_restaurants", query: "biryani", input: {} }, payloadOf("food_search_restaurants.json"), ctx);
  assert.equal(r[0]?.type, "foodRestaurants");
  const m = mapToolResult({ bareTool: "search_menu", query: "paneer biryani", input: {} }, payloadOf("food_search_menu.json"), ctx);
  assert.equal(m[0]?.type, "menu");
  const g = mapToolResult({ bareTool: "get_restaurant_menu", query: "", input: { restaurantId: "271" } }, payloadOf("food_get_restaurant_menu.json"), ctx);
  assert.equal(g[0]?.type, "menu");
  const s = mapToolResult({ bareTool: "search_products", query: "paneer", input: {} }, payloadOf("im_search_products.json"), ctx);
  assert.deepEqual(s.map((e) => e.type), ["products", "products"]);
});

check("get_food_cart (empty: data null, short addressId) → no cart", () => {
  const p = payloadOf("food_get_food_cart_empty.json") as Record<string, unknown>;
  assert.equal(p.data, null);
  assert.equal(p.addressId, "d1k9ctrdq1ocsktt0090");
  assert.ok(sameAddressId(String(p.addressId), BLR));
  // A docs-shaped line still maps its photo (cart lines use the thumb size).
  const cart = mapFoodCart({
    restaurant: { id: "271", name: "Meghana Foods" },
    items: [{ menu_item_id: "86408296", name: "Paneer Biryani", quantity: 2, final_price: 760, imageUrl: "https://media-assets.swiggy.com/swiggy/image/upload/FOOD_CATALOG/IMAGES/CMS/2025/6/6/a380b487-e336-41fa-966a-2b1490e475c9_49f5550e-15a1-42cc-96f9-46e416891bff.jpg" }],
    pricing: { item_total: 760, to_pay: 812 },
  });
  assert.equal(cart.items[0].price, 380);
  assert.ok(cart.items[0].imageUrl.includes("w_160/"));
});

check("get_food_orders → tracker + usual-restaurant cards with cover photos", () => {
  const payload = payloadOf("food_get_food_orders.raw.json");
  const tr = trackerFromFoodOrders(payload);
  assert.equal(tr?.status, "Delivered");
  assert.ok(tr?.items?.includes("250940466155091"));
  const orders = ((payload as { orders: Record<string, unknown>[] }).orders ?? []);
  const cards = orders.map(foodRestaurantFromOrder).filter((r) => r !== null);
  assert.equal(cards.length, 5);
  assert.ok(cards.every((c) => isPhoto(c.imageUrl)), "cover photos");
  assert.ok(cards[0].imageUrl.endsWith("RX_THUMBNAIL/IMAGES/VENDOR/2025/12/4/0f39400c-adb7-4037-b5b5-a54b460e5a7f_1058795.JPG"));
});

check("track_food_order (none active) / get_food_delivery_status (delivered)", () => {
  assert.equal(trackerFromTrackFoodOrder(payloadOf("food_track_food_order.json")), null);
  const d = trackerFromDeliveryStatus(payloadOf("food_get_food_delivery_status.json"));
  assert.equal(d?.status, "Delivered");
  assert.equal(d?.eta, undefined);
});

check("fetch_food_coupons (none applicable) shape", () => {
  const p = payloadOf("food_fetch_food_coupons.json") as { coupon_sections: unknown[] };
  assert.deepEqual(p.coupon_sections, []);
});

console.log("Payments + images");

check("get_payment_options → methods (UPI intent / QR / COD / Swiggy Money)", () => {
  const o = mapPaymentOptions("instamart", payloadOf("im_get_payment_options.json"));
  const apps = o.platforms?.mobile?.methods ?? [];
  assert.equal(apps.length, 3);
  assert.ok(apps.every((m) => m.paymentMethod === "UPI" && m.intentApp === m.id && m.iconUrl), "intent apps");
  assert.equal(apps[0].intentApp, "gpay://upi/"); // echoed byte-for-byte into checkout
  const qr = o.platforms?.desktop?.methods[0];
  assert.ok(qr?.isQr && !qr.intentApp && qr.paymentMethod === "UPI");
  assert.equal(o.cod?.available, true);
  assert.equal(o.swiggyMoney?.available, true);
  assert.equal(o.paymentAmount, 266);
  assert.equal(o.placeOrderToolName, "checkout");
  const byId = new Map(o.allMethods.map((m) => [m.id, m.paymentMethod]));
  assert.equal(byId.get("COD"), "Cash");
  assert.equal(byId.get("SwiggyPay"), "SwiggyPay");
  // Food with an empty cart: nothing to offer — no invented fallback list.
  const food = mapPaymentOptions("food", payloadOf("food_get_payment_options_emptycart.json"));
  assert.deepEqual(food.allMethods, []);
  assert.equal(food.cod, undefined);
  assert.equal(food.placeOrderToolName, "place_food_order");
});

check("empty structuredContent ({}) → text fallback, not silent {}", () => {
  assert.deepEqual(payloadOf("food_get_food_order_details.json"), {});
  const viaText = coerceToolPayload({
    content: [{ type: "text", text: "Order 250940466155091 — Bikkgane Biryani, Delivered" }],
    structuredContent: {},
  });
  assert.deepEqual(viaText, { text: "Order 250940466155091 — Bikkgane Biryani, Delivered" });
});

check("swiggyImageUrl", () => {
  assert.equal(swiggyImageUrl(""), "");
  assert.equal(swiggyImageUrl(undefined), "");
  assert.equal(
    swiggyImageUrl("u7dynyeabdgn5rujasvl", 160),
    "https://media-assets.swiggy.com/swiggy/image/upload/fl_lossy,f_auto,q_auto,w_160/u7dynyeabdgn5rujasvl",
  );
  const already = "https://media-assets.swiggy.com/swiggy/image/upload/fl_lossy,f_auto,q_auto,w_660/abc";
  assert.equal(swiggyImageUrl(already), already);
});

/* ------------- Food field audit (docs/swiggy-mcp/fields/food.md) ------------- */
// Separate section (the Instamart audit edits its own block above).
console.log("Food field audit (docs/swiggy-mcp/fields/food.md)");

check("search_restaurants → (Ad) stripped + sponsored, rating count, cost for two, area, ETA minutes", () => {
  const rs = mapFoodRestaurants(payloadOf("food_search_restaurants_kfc.json"));
  const kfc = rs.find((r) => r.id === "693653");
  const leon = rs.find((r) => r.id === "1286");
  assert.equal(kfc?.name, "KFC");
  assert.equal(kfc?.sponsored, undefined);
  assert.equal(leon?.name, "Leon's - Burgers & Wings (Leon Grill)");
  assert.equal(leon?.sponsored, true);
  assert.equal(leon?.ratingCount, "179K+");
  assert.equal(leon?.costForTwo, "₹300 for two");
  assert.equal(leon?.area, "Jeevan Bhima Nagar");
  assert.equal(leon?.etaRange, "20-25 MINS");
  assert.equal(leon?.deliveryMinutes, 25);
  assert.equal(leon?.distanceKm, 0.7);
  assert.ok(isPhoto(leon?.imageUrl ?? ""));
  // the original biryani capture: every "(Ad)" is stripped from the visible name
  assert.ok(mapFoodRestaurants(payloadOf("food_search_restaurants.json")).every((r) => !/\(Ad\)/.test(r.name)));
});

check("get_restaurant_menu page 2 → restaurant header, categoryId/totalItems, totalCategories", () => {
  const menu = normalizeMenu(payloadOf("food_get_restaurant_menu_page2.json"), undefined, "41795");
  assert.equal(menu.page, 2);
  assert.equal(menu.hasMore, true);
  assert.equal(menu.totalCategories, 8);
  const r = menu.restaurant;
  assert.ok(r);
  assert.equal(r.name, "Behrouz Biryani");
  assert.equal(r.rating, 4.1);
  assert.equal(r.ratingCount, "5.3K+");
  assert.equal(r.costForTwo, "₹500 for two");
  assert.equal(r.etaRange, "20-25 MINS");
  assert.equal(r.deliveryMinutes, 27);
  assert.equal(r.city, "Bangalore");
  assert.equal(r.area, "New Tippasandra");
  assert.ok(r.address?.startsWith("Maruti Sankeerna"));
  assert.ok(!r.address?.includes(",,"));
  assert.equal(r.availability, "OPEN");
  assert.ok(isPhoto(r.imageUrl));
  const [kebabs, combos] = menu.categories;
  assert.equal(kebabs.categoryId, "40057453");
  assert.equal(kebabs.totalItems, 9);
  assert.equal(kebabs.moreItems, undefined);
  assert.equal(combos.totalItems, 13);
  assert.equal(combos.moreItems, 12);
  assert.ok(kebabs.items[0].description.startsWith("Contains milk"));
  assert.equal(kebabs.items[0].bestseller, true);
  assert.equal(kebabs.items[1].veg, true);
});

check("search_menu (scoped) → variantsV2 add-on prices, default, min/max, votes, totalItems", () => {
  const res = mapSearchMenu(payloadOf("food_search_menu_scoped_variants.json"), "41795", "Behrouz Biryani");
  assert.equal(res.totalItems, 137);
  assert.equal(res.nextOffset, 10);
  const [chicken, paneer, combo] = res.dishes;
  assert.equal(chicken.veg, false); // live: non-veg items omit isVeg
  assert.equal(paneer.veg, true);
  assert.equal(chicken.ratingCount, "36");
  assert.equal(chicken.restaurantName, "Behrouz Biryani");
  const c = chicken.customization;
  assert.equal(c?.format, "variantsV2");
  const portion = c?.variantGroups[0];
  assert.equal(portion?.pricesAreAddOns, true);
  assert.equal(portion?.choices.find((x) => x.isDefault)?.name, "Serves 1 (Light Eater) - Miniyat");
  assert.equal(portion?.choices.find((x) => x.id === "211720440")?.price, 430);
  const acc = c?.addonGroups.find((g) => g.groupId === "271731065");
  assert.equal(acc?.min, 1);
  assert.equal(acc?.max, 1);
  assert.equal(acc?.maxFree, undefined); // -1 = not applicable
  assert.equal(c?.addonGroups.find((g) => g.groupId === "271731077")?.choices[1].price, 66.5);
  assert.equal(combo.hasVariants, false);
  assert.ok(res.dishes.every((d) => isPhoto(d.imageUrl)));
});

check("search_menu vegFilter=1 → all veg, totalItems, own restaurant per dish", () => {
  const res = mapSearchMenu(payloadOf("food_search_menu_veg.json"));
  assert.equal(res.totalItems, 422);
  assert.ok(res.dishes.every((d) => d.veg));
  assert.equal(res.dishes[1].restaurantName, "1881 Dum House: Lucknow's Legacy");
});

check("get_food_orders → orderType, RATE_* actions, restaurantId (chat card + History page)", () => {
  const orders = pastFoodOrders(payloadOf("food_get_food_orders.json"));
  assert.equal(orders.length, 3);
  assert.equal(orders[0].orderType, "regular");
  assert.deepEqual(orders[0].rateActions, ["Rate delivery"]);
  assert.deepEqual(orders[1].rateActions, ["Rate order"]);
  assert.deepEqual(orders[2].rateActions, ["Rate food"]);
  assert.equal(orders[0].restaurantId, "1058795");
  assert.equal(orders[1].status, "Cancelled");
  assert.ok(isPhoto(orders[0].imageUrl ?? ""));
  const rows = mapFoodHistory(((payloadOf("food_get_food_orders.json") as { orders: unknown[] }).orders));
  assert.deepEqual(rows[0].rateActions, ["Rate delivery"]);
  assert.equal(rows[0].orderType, "regular");
  assert.equal(rows[0].reorder?.items[0].variants[0].name, "Serves 2 - 1000ml");
});

check("get_food_delivery_status → trackUrl; delivered stops polling", () => {
  const d = trackerFromDeliveryStatus(payloadOf("food_get_food_delivery_status.json"));
  assert.equal(d?.trackUrl, "https://www.swiggy.com/track-order/250940466155091");
  assert.equal(d?.pollIntervalSec, undefined);
  assert.ok(d?.items?.includes("250940466155091"));
  // documented track_food_order shape (no active order live): progress + polling + trackUrl
  const t = trackerFromTrackFoodOrder({
    orders: [
      { orderId: "1", title: "Food is being prepared", subtitle: "Bikkgane Biryani", etaText: "25 mins", orderStatus: "PREPARING", progressPercentage: "40", pollingDuration: "5" },
    ],
  });
  assert.equal(t?.progress, 40);
  assert.equal(t?.pollIntervalSec, 10); // never faster than 10 s
  assert.equal(t?.trackUrl, "https://www.swiggy.com/track-order/1");
  assert.equal(t?.eta, "25 mins");
});

check("fetch_food_coupons → summary filter, applicable-first, ribbon/terms (documented shape)", () => {
  assert.equal(foodCouponFilter(payloadOf("food_fetch_food_coupons.json")), "COD only");
  assert.deepEqual(mapFoodCoupons(payloadOf("food_fetch_food_coupons.json")), []);
  const cs = mapFoodCoupons({
    coupon_sections: [
      {
        title: "Best coupons",
        coupons: [
          { id: "BIG99", applicable: false, title: "Flat ₹99 off", subtitle: "Add ₹120 more to avail" },
          { id: "TRYNEW", applicable: true, title: "60% off", description: "Up to ₹120", ribbon_text: "BEST", terms_and_conditions: { bullet_texts: ["Valid on COD"] } },
        ],
      },
    ],
  });
  assert.equal(cs[0].code, "TRYNEW");
  assert.equal(cs[0].ribbon, "BEST");
  assert.deepEqual(cs[0].terms, ["Valid on COD"]);
  assert.equal(cs[0].section, "Best coupons");
  assert.equal(cs[1].applicable, false);
  assert.equal(cs[1].subtitle, "Add ₹120 more to avail");
});

check("get_food_cart (documented shape) → strikeoff delivery, free delivery, area, line discount", () => {
  const cart = mapFoodCart({
    restaurant: { id: "41795", name: "Behrouz Biryani", area: "New Tippasandra", deliverySubtitle: "Delivery in 25 mins" },
    items: [{ menu_item_id: "193068246", name: "Biryani", quantity: 1, subtotal: 429, final_price: 399 }],
    pricing: { item_total: 429, delivery_charge: 0, delivery_charge_strikeoff: 39, taxes_and_charges: 22, to_pay: 421 },
    offers: { coupon_applied: "TRYNEW", coupon_discount: 30, free_delivery_applied: true },
  });
  assert.equal(cart.deliveryChargeStrikeoff, 39);
  assert.equal(cart.freeDeliveryApplied, true);
  assert.equal(cart.restaurantArea, "New Tippasandra");
  assert.equal(cart.deliverySubtitle, "Delivery in 25 mins");
  assert.equal(cart.items[0].lineSubtotal, 429);
  assert.equal(cart.items[0].lineFinal, 399);
  assert.deepEqual(cart.appliedCoupon, { code: "TRYNEW", savings: 30 });
});

check("agent menu event + summary → model sees header, votes, categories, Ad, rate CTAs, trackUrl", () => {
  const ctx = {} as PromptContext;
  const menuEv = mapToolResult(
    { bareTool: "get_restaurant_menu", query: "", input: { restaurantId: "41795" } },
    payloadOf("food_get_restaurant_menu_page2.json"),
    ctx,
  );
  const ev = menuEv[0];
  assert.equal(ev?.type, "menu");
  assert.equal(ev?.type === "menu" ? ev.restaurant?.ratingCount : "", "5.3K+");
  const text = summarize([
    ...menuEv,
    ...mapToolResult({ bareTool: "search_restaurants", query: "KFC", input: {} }, payloadOf("food_search_restaurants_kfc.json"), ctx),
    ...mapToolResult({ bareTool: "get_food_orders", query: "", input: {} }, payloadOf("food_get_food_orders.json"), ctx),
    ...mapToolResult({ bareTool: "get_food_delivery_status", query: "", input: {} }, payloadOf("food_get_food_delivery_status.json"), ctx),
  ]);
  for (const needle of [
    "restaurantId=41795 | open | ★4.1 (5.3K+)",
    "₹500 for two",
    "8 categories",
    "Biryani with Thums Up Combos (13, 12 not shown)",
    "ad (promoted)",
    "Jeevan Bhima Nagar",
    "can rate in Swiggy app: Rate delivery",
    "live tracking page: https://www.swiggy.com/track-order/250940466155091",
    "Contains milk",
  ]) {
    assert.ok(text.includes(needle), `summary missing: ${needle}`);
  }
});

/* ------------------- Food AI (meal plan, menu read, add-ons) ------------------- */

console.log("Food AI");
{
  const ctx = {} as PromptContext;
  const behrouz = mapSearchMenu(payloadOf("food_search_menu_behrouz_addons.json"), "41795", "Behrouz Biryani").dishes;
  const chicken = behrouz.find((d) => d.id === "193068261")!;
  const vegBiryani = behrouz.find((d) => d.id === "193068250")!;

  check("Behrouz: 4 near-duplicate required 'Choose Accompaniment' groups collapse to 1 (variant-scoped)", () => {
    const raw = chicken.customization!.addonGroups;
    assert.equal(raw.filter((g) => /accompaniment/i.test(g.name)).length, 4);
    const d = dedupeAddonGroups(raw);
    assert.equal(d.groups.filter((g) => /accompaniment/i.test(g.name)).length, 1);
    assert.equal(d.groups.filter((g) => /egg/i.test(g.name)).length, 1);
    assert.equal(d.variantScoped, true);
  });

  check("AI selection: variant first (Swiggy default), add-ons deferred to the cart's valid_addons", () => {
    const ai = aiSelection(chicken.customization!);
    assert.equal(ai.addonsAfterAdd, true);
    assert.deepEqual(ai.selection.addons, []);
    assert.equal(ai.selection.variants[0].variationId, "211720502");
    assert.match(ai.reasons[0], /Swiggy's default portion/);
  });

  check("AI selection: 'for 2' picks Serves 2 and adds its +₹ to the estimate", () => {
    const ai = aiSelection(vegBiryani.customization!, "for 2");
    assert.equal(ai.selection.variants[0].variationId, "211720460");
    assert.equal(ai.extra, 330);
    assert.equal(pickVariant(vegBiryani.customization!.variantGroups[0], "Serves 4")?.choiceId, "211720461");
    assert.equal(partySize("dinner for 3 under ₹800"), 3);
  });

  check("AI default for a required group = the fullest free option; optional groups untouched", () => {
    const groups = dedupeAddonGroups(chicken.customization!.addonGroups).groups;
    const d = pickDefaultAddons(groups);
    assert.equal(d.addons.length, 1);
    assert.equal(d.addons[0].name, "Mint Raita & Gulab Jamun");
    assert.equal(d.addons[0].price, 0);
    assert.match(d.reasons[0], /free/);
  });

  // A get_food_cart line in the DOCUMENTED shape (live carts were empty; see fields/food.md).
  const docCart = {
    restaurant: { id: "41795", name: "Behrouz Biryani", area: "New Tippasandra", deliverySubtitle: "Add ₹40 more for free delivery" },
    items: [
      {
        menu_item_id: "193068261",
        name: "Hyderabadi Lazeez Bhuna Murgh Biryani",
        quantity: 1,
        subtotal: 799,
        total: 799,
        final_price: 799,
        variants: [{ group_id: "71345455", variation_id: "211720504", name: "Serves 2 - Shaan" }],
        addons: [],
        valid_addons: [
          {
            group_id: "271731188",
            name: "Choose Accompaniment.",
            minAddons: 1,
            maxAddons: 1,
            choices: [
              { id: "139496440", name: "Only Mint Raita", price: 0 },
              { id: "139496438", name: "Mint Raita & Gulab Jamun", price: 0 },
            ],
          },
          { groupId: "272686211", name: "Add an Egg.", maxAddons: -1, addons: [{ choice_id: "144254116", name: "Egg (2 Piece)", price: 49 }] },
        ],
      },
    ],
    pricing: { item_total: 799, delivery_charge: 30, delivery_charge_strikeoff: 50, taxes_and_charges: 61, to_pay: 790 },
    offers: { coupon_applied: "TRYNEW", coupon_discount: 100 },
  };

  check("get_food_cart valid_addons + the line's variant selection are parsed (both casings)", () => {
    const cart = mapFoodCart(docCart);
    const line = cart.items[0];
    assert.equal(line.validAddons?.length, 2);
    assert.equal(line.validAddons?.[0].groupId, "271731188");
    assert.equal(line.validAddons?.[0].min, 1);
    assert.equal(line.validAddons?.[1].choices[0].id, "144254116");
    assert.equal(line.validAddons?.[1].max, 0); // -1 → unlimited
    assert.equal(line.selection?.variants[0].variationId, "211720504");
    assert.deepEqual(mapValidAddons(undefined), undefined);
    // the AI default comes from THIS portion's group, not search_menu's four copies
    assert.equal(pickDefaultAddons(line.validAddons!).addons[0].choiceId, "139496438");
  });

  check("bill read: Swiggy's numbers only; savings = coupon + delivery strike-off; nudge only from Swiggy's text", () => {
    const cart = mapFoodCart(docCart);
    const read = explainFoodBill(cart);
    assert.match(read.lines[0], /You pay ₹790/);
    assert.match(read.lines[1], /TRYNEW takes off ₹100/);
    assert.equal(read.savings, 120);
    assert.deepEqual(read.nudges, ["Add ₹40 more for free delivery"]);
    assert.deepEqual(explainFoodBill({ ...cart, deliverySubtitle: "Delivery in 25 mins" }).nudges, []);
    assert.ok(numbersGrounded(read.lines.join(" "), read.facts));
    assert.ok(!numbersGrounded("Add ₹55 more for free delivery", read.facts));
  });

  check("menu read (live Behrouz menu): picks / value / veg lines + chips on real dish ids", () => {
    const menu = normalizeMenu(payloadOf("food_get_restaurant_menu.json"), "Behrouz Biryani", "41795");
    const ins = menuInsights(menu.categories, menu.restaurant);
    const ids = new Set(menu.categories.flatMap((c) => c.items.map((i) => i.id)));
    assert.ok(ins.lines.length >= 2 && ins.lines.length <= 3, ins.lines.join(" / "));
    assert.ok(ins.chips.length >= 1 && ins.chips.every((c) => ids.has(c.itemId)));
    assert.ok(numbersGrounded(ins.lines.join(" "), ins.facts), ins.lines.join(" / "));
  });

  check("MEAL / MEALITEM markers → one single-restaurant plan; unknown + other-restaurant dishes dropped", () => {
    const foodById = new Map<string, FoodResolved>();
    const restNames = new Map<string, string>();
    const menuEv = mapToolResult({ bareTool: "get_restaurant_menu", query: "", input: { restaurantId: "41795" } }, payloadOf("food_get_restaurant_menu.json"), ctx);
    for (const ev of menuEv) cacheFromEvent(ev, new Map(), foodById, restNames);
    const other = mapSearchMenu(payloadOf("food_search_menu.json")).dishes.find((d) => d.restaurantId !== "41795")!;
    for (const ev of mapToolResult({ bareTool: "search_menu", query: "biryani", input: {} }, payloadOf("food_search_menu.json"), ctx)) {
      cacheFromEvent(ev, new Map(), foodById, restNames);
    }
    const ids = [...foodById.entries()].filter(([, f]) => f.restaurantId === "41795").map(([id]) => id);
    const text = `MEAL: Dinner for 3 | budget=800 | people=3\nMEALITEM: ${ids[0]} x2 | Serves 2 | bestseller, ★4.1\nMEALITEM: ${ids[1]} x1 | - | the veg pick\nMEALITEM: 999999 x1 | - | invented\nMEALITEM: ${other.id} x1 | - | other place\nGreat dinner ahead!`;
    const { rest, plan } = resolveMealPlan(text, foodById);
    assert.equal(rest.trim(), "Great dinner ahead!");
    assert.ok(plan);
    assert.equal(plan.restaurantId, "41795");
    assert.equal(plan.items.length, 2);
    assert.equal(plan.items[0].quantity, 2);
    assert.equal(plan.items[0].option, "Serves 2");
    assert.equal(plan.items[1].option, undefined);
    assert.equal(plan.budget, 800);
    assert.equal(plan.people, 3);
    assert.equal(plan.estimate, plan.items.reduce((s, i) => s + i.price * i.quantity, 0));
    assert.equal(plan.notes?.length, 2);
    // the plan reaches only the Food (and Plan) tab
    const ev = { type: "foodMealPlan" as const, plan };
    assert.ok(eventAllowedFor("food", ev) && !eventAllowedFor("instamart", ev) && !eventAllowedFor("dineout", ev));
  });

  check("model sees search_menu portions (default + '+₹' add-on prices) and the dish's restaurantId", () => {
    const text = summarize(
      mapToolResult({ bareTool: "search_menu", query: "biryani", input: { restaurantIdOfAddedItem: "41795" } }, payloadOf("food_search_menu_behrouz_addons.json"), ctx),
    );
    assert.ok(text.includes("options: Serves 1 (Light Eater) - Miniyat (default)"), text);
    assert.ok(text.includes("Serves 2 - Shaan +₹330"), text);
    const cross = summarize(mapToolResult({ bareTool: "search_menu", query: "biryani", input: {} }, payloadOf("food_search_menu.json"), ctx));
    assert.match(cross, /\(restaurantId=\d+\)/);
  });
}


// Separate section: the Instamart AI basket / pack choice / cart review
// (src/shared/instamart-packs.ts, instamart-review.ts) on live payloads.
console.log("Instamart AI basket (pack choice, substitutes, caps, review, readiness)");
{
  const milk = mapProductsPayload(payloadOf("im_search_products_milk.json")).products;
  const eggs = mapProductsPayload(payloadOf("im_search_products_eggs.json")).products;
  const taaza = milk.find((p) => p.name === "Amul Taaza Toned Milk")!;
  const whitener = milk.find((p) => p.name === "Amul Dairy Whitener")!;

  check("parsePack reads every live pack shape", () => {
    assert.deepEqual(parsePack("450 ml x 2"), { kind: "ml", amount: 900 });
    assert.deepEqual(parsePack("1 ltr x 12"), { kind: "ml", amount: 12000 });
    assert.deepEqual(parsePack("12 Pieces x 2"), { kind: "pc", amount: 24 });
    assert.deepEqual(parsePack("52.9 g"), { kind: "g", amount: 52.9 });
    assert.deepEqual(parsePack("10 numbers"), { kind: "pc", amount: 10 });
    assert.equal(parsePack(""), null);
  });

  check("AI pack: smallest pack by default (user preference), cheapest cover for '2 L'", () => {
    const plain = choosePack(taaza)!;
    assert.equal(plain.variation.quantityDescription, "1 ltr"); // not the ₹840 12-pack at the same ₹7/100 ml
    assert.match(plain.why, /smallest pack/);
    // every in-stock pack is at least as big as the default
    const amt = (d: string) => parsePack(d)?.amount ?? Infinity;
    assert.ok(taaza.variations.filter((v) => v.inStock !== false).every((v) => amt(v.quantityDescription) >= amt(plain.variation.quantityDescription)));
    const two = choosePack(taaza, { amount: parseNeed("2 L") })!;
    assert.equal(two.units, 2);
    assert.equal(two.cost, 140);
    assert.ok(two.covers);
    assert.match(two.why, /2 × 1 ltr covers your 2 L for ₹140/);
  });

  check("rank: sponsored listings skipped for value, labelled when they are the only match", () => {
    const r = rankProducts("toned milk", milk);
    assert.equal(r.pick?.product.isPromoted, false);
    assert.ok(!r.alternatives.some((a) => a.product.isPromoted));
    const w = rankProducts("dairy whitener", milk);
    assert.equal(w.pick?.product.productId, whitener.productId);
    assert.match(toPick(w.pick!).reason, /^⭐ Sponsored/);
  });

  check("basket: one card, real packs + reasons, budget, cap top-up, out-of-stock substitute, missing", () => {
    const oosMilk = milk.map((p) => (p.name === "Amul Taaza Toned Milk" ? { ...p, inStock: false } : p));
    const req = {
      title: "Weekly for 2",
      budget: 400,
      items: [
        { query: "amul taaza toned milk", size: "2 L" },
        { query: "eggs", size: "12" },
        { query: "toned milk", quantity: 25 },
        { query: "saffron" },
      ],
    };
    const b = assembleBasket(
      req,
      [
        { item: req.items[0], products: oosMilk },
        { item: req.items[1], products: eggs },
        { item: req.items[2], products: milk },
        { item: req.items[3], products: [], error: "Swiggy search failed" },
      ],
      "b1",
    );
    const [sub, egg, capped, topUp] = b.lines;
    assert.equal(sub.kind, "substitute");
    assert.match(sub.note!, /Amul Taaza Toned Milk is out of stock — closest in-stock match/);
    assert.ok(sub.line.spinId && sub.line.skuId && sub.quantity >= 1);
    assert.equal(egg.line.quantityDescription, "12 Pieces");
    assert.ok(egg.unitPrice && egg.rating && egg.sla, "Swiggy facts carried");
    assert.match(egg.reason, /★4\.4 \(140\.4k\)/);
    assert.equal(capped.capped, "Only 20 unit(s) of this item can be added per order.");
    assert.equal(capped.quantity, 20);
    assert.equal(topUp.kind, "overflow");
    assert.match(topUp.note!, /adding this for the rest/);
    assert.deepEqual(b.missing, [{ need: "saffron", why: "Swiggy search failed" }]);
    assert.equal(b.budget, 400);
    assert.equal(b.itemTotal, Math.round(b.lines.reduce((s, l) => s + l.line.unitPrice * l.quantity, 0)));
    assert.ok(b.skippedSponsored && b.skippedSponsored > 0);
    // Approve all honours removals + swaps
    const kept = approvedLines({ ...b, removed: [topUp.id], chosen: { [egg.id]: 0 } });
    assert.equal(kept.length, 3);
    assert.equal(kept[1].line.spinId, egg.alternatives![0].line.spinId);
    assert.equal(basketTotal({ ...b, removed: b.lines.map((l) => l.id) }), 0);
  });

  check("build_basket result → one basket card; model summary has ids, totals vs budget, substitutes", () => {
    const b = assembleBasket({ budget: 100, items: [{ query: "eggs", quantity: 2 }] }, [{ item: { query: "eggs", quantity: 2 }, products: eggs }], "b2");
    const evs = mapToolResult({ bareTool: "build_basket", query: "", input: {} }, b, {} as PromptContext);
    assert.equal(evs.length, 1);
    assert.equal(evs[0].type, "basket");
    assert.ok(eventAllowedFor("instamart", evs[0]) && !eventAllowedFor("food", evs[0]));
    const text = summarize(evs);
    assert.match(text, /^BASKET/);
    assert.match(text, new RegExp(`id=${b.lines[0].line.spinId}`));
    assert.match(text, /OVER|under/);
  });

  check("usuals: AI pack for every in-stock go-to item", () => {
    const { products } = mapProductsPayload(payloadOf("im_your_go_to_items.json"));
    for (const p of products) {
      const c = usualPick(p);
      if (!p.inStock || !p.variations.some((v) => v.inStock)) assert.equal(c, null);
      else assert.ok(c && toPick(c).reason.length > 5, p.name);
    }
  });

  check("closest substitute keeps type + size", () => {
    const s = closestSubstitute({ name: "Amul Taaza Toned Milk", quantityDescription: "1 ltr", spinId: "HH5FTSMTW0" }, milk, new Set(["HH5FTSMTW0"]))!;
    assert.match(s.product.name, /Toned Milk/);
    assert.ok(!s.product.isPromoted);
  });

  check("cart review: live cart → Swiggy One, fees, savings; blockers for min order / unavailable", () => {
    const state = cartToState(mapCartPayload(payloadOf("im_get_cart.raw.json")), CHENNAI);
    const r = reviewCart(state, 200);
    const all = r.insights.map((i) => i.text).join(" | ");
    assert.match(all, /Swiggy ONE PLUS active — Delivery Partner Fee FREE/);
    assert.match(all, /Late Night Fee ₹35\.40/);
    assert.match(all, /You save ₹21 vs MRP/);
    assert.match(all, /over your ₹200 budget/);
    assert.ok(r.chips.some((c) => c.kind === "trim"));
    assert.ok(r.facts.some((f) => /To Pay ₹266/.test(f)));
    const small = reviewCart({ ...state, items: state.items.map((l) => ({ ...l, unitPrice: 40 })), subtotal: 40 });
    assert.equal(small.insights[0].tone, "block");
    assert.match(small.headline, /Add ₹59 more/);
    const oos = reviewCart({ ...state, items: state.items.map((l) => ({ ...l, inStock: false })) });
    assert.equal(oos.unavailable.length, 1);
    assert.ok(oos.chips.some((c) => c.kind === "remove"));
    const removed = reviewCart({ ...state, warnings: ["Amul Butter is out of stock and was removed."] });
    assert.ok(removed.chips.some((c) => c.kind === "ask" && /Amul Butter/.test(c.text!)));
  });

  check("ready to order: address, To Pay, Swiggy's methods, agenticPaymentEligible explained", () => {
    const state = cartToState(mapCartPayload(payloadOf("im_get_cart.raw.json")), CHENNAI);
    const opts = mapPaymentOptions("instamart", payloadOf("im_get_payment_options.json"));
    const r = checkoutReadiness(state, opts);
    assert.ok(r.ready);
    assert.equal(r.toPay, "₹266");
    assert.match(r.address!, /West Tambaram/);
    const labels = r.methods.map((m) => m.label);
    for (const l of ["Google Pay", "Pay on delivery", "Swiggy Money"]) assert.ok(labels.includes(l), l);
    assert.equal(opts?.agenticPaymentEligible, false);
    assert.match(r.agenticNote!, /agenticPaymentEligible: false/);
    assert.equal(checkoutReadiness(state, null).ready, false);
  });
}

console.log(`\nAll ${checks} checks passed on live payloads.`);
