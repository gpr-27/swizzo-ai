// zod schemas for every API request body / query (used by ./route.ts).
//
// Bodies: top-level objects are STRICT (unknown keys → 400), every string has a
// length cap, numbers have ranges, enums are closed. Nested Swiggy-shaped
// objects the UI echoes back (cart line metadata, menus, pickers) are size-
// capped and left to each route's own field-by-field parsing.
// Queries: known params are type/size checked; unknown params are ignored
// (GETs are read-only) but the wrapper caps total query size and count.
//
// Schemas are lenient where a route already returns a friendlier message for
// a missing value (e.g. addressId "" → "Pick a delivery address first.").

import { z } from "zod";

/* --------------------------------- atoms ----------------------------------- */

/** A Swiggy id (address, spin, sku, order, cart, restaurant, venue…): no whitespace / markup. */
export const id = z
  .string()
  .trim()
  .min(1)
  .max(256)
  .regex(/^[\w.:@|=+/~-]+$/, "has invalid characters");
/** Ids that Swiggy sometimes returns as numbers. */
export const idLike = z.union([id, z.number().int().nonnegative()]);
/** An id or "" (the route answers "" with its own message). */
export const idOrEmpty = z.union([z.literal(""), id]);
export const cartKey = z
  .string()
  .trim()
  .min(1)
  .max(2_048)
  .regex(/^[^\s<>"'`\\]+$/, "has invalid characters");
export const text = (max: number) => z.string().max(max);
export const lat = z.number().min(-90).max(90);
export const lng = z.number().min(-180).max(180);
export const money = z.number().min(0).max(10_000_000);
export const qty = z.number().int().min(0).max(1_000);
const opt = <T extends z.ZodType>(s: T) => s.nullish();
/** An object the route parses itself — bounded by the body byte cap. */
const loose = z.looseObject({});
const smallList = (max: number) => z.array(z.unknown()).max(max);

/** Query-string atoms (always strings). */
export const qId = z.string().trim().max(256).regex(/^[\w.:@|=+/~-]*$/, "has invalid characters");
// Numbers stay strings here: each route does its own Number() check with a friendlier message.
export const qNum = z.string().trim().max(32);
export const qText = (max: number) => z.string().max(max);
/** Opaque Swiggy tokens (cartKey, paasId…): no whitespace / markup. */
export const qToken = z.string().max(2_048).regex(/^[^\s<>"'`\\]*$/, "has invalid characters");

const SERVICE = z.enum(["instamart", "food", "dineout", "scenes", "plan"]);
const DOMAIN = z.enum(["instamart", "food", "dineout", "scenes"]);

/* --------------------------------- bodies ---------------------------------- */

export const ChatBody = z.strictObject({
  service: opt(text(20)),
  message: opt(text(8_000)),
  addressId: opt(idOrEmpty),
  addressLine: opt(text(1_000)),
  latitude: opt(lat),
  longitude: opt(lng),
  city: opt(text(120)),
  preferences: opt(text(2_000)),
  allergies: opt(text(1_000)),
  budget: opt(money),
  kcalGoal: opt(z.number().min(0).max(50_000)),
  proteinGoal: opt(z.number().min(0).max(5_000)),
  // the route keeps its own friendlier 413 for photos over ~5 MB
  image: opt(z.strictObject({ mediaType: text(60), data: text(7_500_000) })),
  history: opt(z.array(z.looseObject({ role: text(20), text: text(50_000) })).max(60)),
  catalog: opt(loose),
  cartLines: opt(smallList(200)),
  knownBookings: opt(smallList(200)),
  activePicker: opt(loose),
  pickerRead: opt(z.boolean()),
});

export const AiReadBody = z.strictObject({
  kind: z.enum(["dineout", "scenes", "compare"]),
  facts: text(20_000),
  needs: opt(text(2_000)),
});

export const BriefingBody = z.strictObject({
  service: SERVICE,
  addressId: opt(idOrEmpty),
  bookings: opt(smallList(200)),
});

export const FoodAiBody = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("menuRead"), restaurant: opt(loose), categories: opt(smallList(200)) }),
  z.strictObject({ action: z.literal("billRead"), cart: opt(loose) }),
  z.strictObject({
    action: z.literal("resolveMeal"),
    addressId: opt(idOrEmpty),
    restaurantId: opt(z.union([idOrEmpty, z.number()])),
    restaurantName: opt(text(300)),
    items: opt(smallList(40)),
  }),
]);

export const ReportErrorBody = z.strictObject({
  service: DOMAIN,
  tool: text(100),
  errorMessage: text(4_000),
  flowDescription: opt(text(2_000)),
  toolContext: opt(z.record(text(80), z.unknown()).refine((r) => Object.keys(r).length <= 40, "too many keys")),
  userNotes: opt(text(2_000)),
  reportId: opt(text(200)),
});

const PHONE = /^(?:\+?91[\s-]?|0)?[6-9]\d{4}[\s-]?\d{5}$/;
export const AddressCreateBody = z.strictObject({
  fullAddress: text(600),
  addressLine: text(400),
  addressLine2: opt(text(300)),
  locality: opt(text(200)),
  city: text(120),
  postalCode: text(12),
  addressCategory: text(40),
  addressTag: opt(text(80)),
  userName: text(120),
  userPhone: z.union([z.literal(""), z.string().trim().regex(PHONE, "enter a valid 10-digit mobile number")]),
  receiverName: opt(text(120)),
  receiverPhone: opt(z.union([z.literal(""), z.string().trim().regex(PHONE, "enter a valid 10-digit mobile number")])),
  latitude: opt(lat),
  longitude: opt(lng),
});

const CartItems = z.array(z.looseObject({ line: loose, quantity: qty })).max(150);

export const CartBody = z.strictObject({
  action: z.enum(["add", "increment", "decrement", "remove", "clear", "set"]),
  addressId: idOrEmpty,
  spinId: opt(id),
  line: opt(loose),
  quantity: opt(qty),
  items: opt(CartItems),
});

export const FoodCartBody = z.strictObject({
  action: z.enum(["add", "increment", "decrement", "remove", "clear", "set", "coupon", "coupons", "cutlery", "place"]),
  addressId: idOrEmpty,
  restaurantId: opt(z.union([idOrEmpty, z.number()])),
  restaurantName: opt(text(300)),
  menuItemId: opt(idLike),
  line: opt(loose),
  quantity: opt(qty),
  items: opt(CartItems),
  couponCode: opt(text(64)),
  paymentMethod: opt(text(30)),
  intentApp: opt(text(120)),
  generateUPIQR: opt(z.boolean()),
  amount: opt(money),
  noteToRestaurant: opt(text(500)),
  cutleryOptIn: opt(z.boolean()),
});

export const CheckoutBody = z.strictObject({
  addressId: idOrEmpty,
  paymentMethod: opt(text(30)),
  intentApp: opt(text(120)),
  generateUPIQR: opt(z.boolean()),
  confirmDuplicate: opt(z.boolean()),
});

const BookingRef = z.looseObject({ kind: z.enum(["dineout", "scenes"]), orderId: idLike });
export const BookingsBody = z.strictObject({ items: z.array(BookingRef).max(200) });
export const HistoryBookingsBody = z.strictObject({
  items: z.array(BookingRef).max(200),
  lat: opt(lat),
  lng: opt(lng),
});

const DineoutSlot = {
  restaurantId: idLike,
  slotId: z.number(),
  itemId: idLike,
  reservationTime: z.number().int().nonnegative(),
  guestCount: z.number().int().min(1).max(20),
  latitude: lat,
  longitude: lng,
};
export const DineoutCartBody = z.strictObject(DineoutSlot);
export const DineoutBookBody = z.strictObject({
  ...DineoutSlot,
  restaurantName: opt(text(300)),
  payment: opt(
    z.strictObject({
      cartKey,
      intentApp: opt(text(120)),
      generateUPIQR: opt(z.boolean()),
      amount: opt(money),
    }),
  ),
});
export const DineoutCancelBody = z.strictObject({
  orderId: id,
  action: z.literal("cancel"),
  reason: opt(text(300)),
});

export const HistoryInsightsBody = z.strictObject({ facts: z.array(text(1_000)).max(50) });
export const HistoryTrackBody = z.strictObject({
  service: opt(text(20)),
  orderId: id,
  addressId: opt(idOrEmpty),
  lat: opt(lat),
  lng: opt(lng),
});
export const TrackBody = z.strictObject({
  service: opt(z.enum(["food", "instamart"])),
  addressId: opt(idOrEmpty),
  lat: opt(lat),
  lng: opt(lng),
});

export const InstamartBasketBody = z.strictObject({
  addressId: idOrEmpty,
  fromUsuals: opt(z.boolean()),
  items: opt(
    z
      .array(z.looseObject({ query: text(120), quantity: opt(qty), size: opt(text(60)) }))
      .max(40),
  ),
  budget: opt(money),
  title: opt(text(200)),
  allowSponsored: opt(z.boolean()),
  vegOnly: opt(z.boolean()),
});
export const InstamartNoteBody = z.strictObject({
  kind: z.enum(["briefing", "review"]),
  facts: z.array(text(1_000)).max(40),
});

const numOrNumString = z.union([z.number(), z.string().max(32)]);
export const PaymentConfirmBody = z.strictObject({
  service: z.enum(["food", "instamart", "dineout", "scenes"]),
  orderId: id,
  paasId: opt(cartKey),
  transactionId: opt(cartKey),
  addressId: opt(idOrEmpty),
  cartId: opt(z.union([z.literal(""), cartKey])),
  lat: opt(numOrNumString),
  lng: opt(numOrNumString),
});

export const ScenesCartBody = z.strictObject({
  venueId: idLike,
  showId: idLike,
  ticketId: idLike,
  showTime: z.number().int().nonnegative(),
  guestCount: z.number().int().min(1).max(20),
  latitude: lat,
  longitude: lng,
});
export const ScenesOrderBody = z.strictObject({
  cartKey,
  paymentMethod: z.enum(["UPI", "FREE"]),
  intentApp: opt(text(120)),
  generateUPIQR: opt(z.boolean()),
  amount: opt(money),
  title: opt(text(300)),
  selection: opt(loose),
});

/* --------------------------------- queries --------------------------------- */

export const AddressesQuery = z.looseObject({ selectedAddressId: qId.optional() });
export const AddressDeleteQuery = z.looseObject({ addressId: qId.min(1, "addressId is required") });
export const AddressOnlyQuery = z.looseObject({ addressId: qId.optional() });
export const DishesQuery = z.looseObject({
  q: qText(200).optional(),
  addressId: qId.optional(),
  restaurantId: qId.optional(),
  offset: qNum.optional(),
});
export const FoodMenuQuery = z.looseObject({
  restaurantId: qId.optional(),
  addressId: qId.optional(),
  restaurantName: qText(300).optional(),
  page: qNum.optional(),
});
export const SearchQuery = z.looseObject({
  addressId: qId.optional(),
  query: qText(200).optional(),
  offset: qText(256).optional(),
});
export const OrderDetailsQuery = z.looseObject({
  orderId: qId.optional(),
  service: qText(20).optional(),
});
export const PaymentOptionsQuery = z.looseObject({
  service: qText(20).optional(),
  addressId: qId.optional(),
  cartKey: qToken.optional(),
});
export const PaymentStatusQuery = z.looseObject({
  service: qText(20).optional(),
  orderId: qId.optional(),
  paasId: qToken.optional(),
  addressId: qId.optional(),
  cartId: qToken.optional(),
  lat: qNum.optional(),
  lng: qNum.optional(),
});
export const DineoutSearchQuery = z.looseObject({
  query: qText(200).optional(),
  lat: qNum.optional(),
  lng: qNum.optional(),
  restaurantId: qId.optional(),
  date: qText(16).optional(),
  restaurantName: qText(300).optional(),
  limit: qNum.optional(),
  offset: qNum.optional(),
});
export const DineoutDetailsQuery = z.looseObject({
  restaurantId: qId.optional(),
  lat: qNum.optional(),
  lng: qNum.optional(),
});
export const DineoutBookingQuery = z.looseObject({ orderId: qId.optional() });
export const ScenesSearchQuery = z.looseObject({
  lat: qNum.optional(),
  lng: qNum.optional(),
  eventId: qId.optional(),
  collectionId: qId.optional(),
  query: qText(200).optional(),
  genre: qText(60).optional(),
  address: qText(1_000).optional(),
});
export const ScenesShowsQuery = z.looseObject({
  eventId: qId.optional(),
  venueId: qId.optional(),
  lat: qNum.optional(),
  lng: qNum.optional(),
  fresh: qText(4).optional(),
  title: qText(300).optional(),
});
export const ScenesCartQuery = z.looseObject({
  cartKey: qToken.optional(),
  latitude: qNum.optional(),
  longitude: qNum.optional(),
});
export const ImagesQuery = z.looseObject({
  kind: qText(20).optional(),
  id: qId.optional(),
  lat: qNum.optional(),
  lng: qNum.optional(),
  addressId: qId.optional(),
});
export const LoginQuery = z.looseObject({ prompt: qText(20).optional() });
export const CallbackQuery = z.looseObject({
  code: qText(2_048).optional(),
  state: qText(256).optional(),
  error: qText(200).optional(),
});
