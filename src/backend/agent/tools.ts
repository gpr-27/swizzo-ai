// Read-only Swiggy MCP tools exposed to the concierge LLM, per service.
// Mutating tools (cart updates, order placement, bookings, payments) are never
// given to the model — the deterministic API routes call them after the user
// confirms in the UI.

import { tool, type ToolSet } from "ai";
import { z } from "zod";

import { agentDiscoverWithFallback, agentEnrichSearch } from "@/backend/mcp/scenes-mcp";
import { instamartOrderCoords } from "@/backend/mcp/swiggy-mcp";
import type { DomainService, Service } from "@/shared/types";

/**
 * Runs one MCP tool with the model's args; returns a compact text summary for
 * the model. `server` names the domain whose MCP server owns the tool — the
 * Plan tab's tools pass it; a domain tab's tools omit it (= that tab's server).
 */
export type ToolRunner = (
  bareTool: string,
  args: Record<string, unknown>,
  server?: DomainService,
) => Promise<string>;

/**
 * The Plan tab's read-only tool set, per owning server. Discovery only — no
 * order/booking status, carts or payments (those stay in each domain's tab).
 * Bare names are unique across the four servers (asserted in
 * scripts/verify-plan.ts), so the model sees them unprefixed.
 */
export const PLAN_TOOLS: Record<DomainService, string[]> = {
  scenes: ["discover_events", "get_events_collection", "search_events", "get_event_details", "list_event_shows"],
  // Slots / show times are read-only and render the domain's own picker; the
  // booking itself still needs the user's explicit confirmation in that picker.
  dineout: ["search_restaurants_dineout", "get_restaurant_details", "get_available_slots"],
  food: ["search_menu", "search_restaurants", "get_restaurant_menu"],
  instamart: ["search_products", "your_go_to_items"],
};

export function buildServiceTools(service: Service, run: ToolRunner): ToolSet {
  switch (service) {
    case "plan": {
      // Reuse each domain's own tool definitions, bound to THAT domain's server.
      const out: ToolSet = {};
      for (const domain of Object.keys(PLAN_TOOLS) as DomainService[]) {
        const own = buildServiceTools(domain, (bareTool, args) => run(bareTool, args, domain));
        for (const name of PLAN_TOOLS[domain]) {
          if (own[name]) out[name] = own[name];
        }
      }
      return out;
    }

    case "food":
      return {
        search_restaurants: tool({
          description:
            "Search restaurants near the user's delivery address by restaurant name or cuisine. Use ONLY for explicit place asks ('pizza places near me', 'show me Meghana'). Each result has availabilityStatus — recommend only OPEN ones and mention distance for far ones.",
          inputSchema: z.object({
            query: z.string().min(1).describe("a restaurant name or cuisine"),
            offset: z.number().int().min(0).optional().describe("nextOffset from a previous call, for more results"),
          }),
          execute: (a) => run("search_restaurants", a),
        }),
        get_restaurant_menu: tool({
          description:
            "Browse one restaurant's menu (paginated over categories; ~10 dishes per category). Pass the restaurantId from a search_restaurants result. When the result says more categories exist, call again with page + 1. To order a specific dish or see its customizations, use search_menu with restaurantIdOfAddedItem.",
          inputSchema: z.object({
            restaurantId: z.string(),
            restaurantName: z.string().optional(),
            page: z.number().int().min(1).optional(),
          }),
          execute: (a) => run("get_restaurant_menu", a),
        }),
        search_menu: tool({
          description:
            "Search dishes by name — inside one restaurant (pass restaurantIdOfAddedItem, e.g. the restaurant of the dishes already in the cart) or, without it, across nearby restaurants. Returns each dish with its restaurant, price and variant/add-on options. For a plain dish craving prefer the DISHES: marker.",
          inputSchema: z.object({
            query: z.string().min(1).describe("a dish name, e.g. 'paneer tikka'"),
            restaurantIdOfAddedItem: z.string().optional().describe("scope the search to this restaurant"),
            vegFilter: z.union([z.literal(0), z.literal(1)]).optional().describe("1 = veg only (there is no non-veg-only filter)"),
            offset: z.number().int().min(0).optional(),
          }),
          execute: (a) => run("search_menu", a),
        }),
        get_food_orders: tool({
          description:
            "The user's recent food orders (active and delivered, newest first). Set activeOnly only when the user asks for current/ongoing orders.",
          inputSchema: z.object({
            activeOnly: z.boolean().optional(),
            orderCount: z.number().int().min(1).max(15).optional(),
          }),
          execute: (a) => run("get_food_orders", a),
        }),
        get_food_order_details: tool({
          description:
            "Full detail of ONE food order — items with variants/add-ons, bill breakdown, payment method, delivery address and status. Pass the orderId from get_food_orders. Use for 'what did I order', 'how much did I pay', 'what was in my last order'.",
          inputSchema: z.object({ orderId: z.string() }),
          execute: (a) => run("get_food_order_details", a),
        }),
        track_food_order: tool({
          description:
            "Live tracking (status + ETA) for an in-progress food order. Pass orderId from get_food_orders, or omit it to track all active orders.",
          inputSchema: z.object({ orderId: z.string().optional() }),
          execute: (a) => run("track_food_order", a),
        }),
        get_food_delivery_status: tool({
          description:
            "Structured delivery ETA for one placed food order (orderId from get_food_orders). Reports delivered / cancelled.",
          inputSchema: z.object({ orderId: z.string() }),
          execute: (a) => run("get_food_delivery_status", a),
        }),
        get_food_cart: tool({
          description:
            "Read the user's live Swiggy food cart: items with variants/add-ons, valid_addons, bill (item total, taxes, delivery, to pay) and Swiggy's coupon hint. A coupon counts as applied ONLY when coupon_discount > 0. Read-only — the cart panel edits it.",
          inputSchema: z.object({
            restaurantName: z.string().optional().describe("the cart's restaurant name, for display only"),
          }),
          execute: (a) => run("get_food_cart", a),
        }),
        fetch_food_coupons: tool({
          description:
            "Coupons and offers Swiggy lists for a cart from ONE restaurant (pass that restaurantId — e.g. the restaurant in the CURRENT CART), with whether each is applicable. Optionally check one couponCode. Read-only: the user applies a coupon from the cart panel; never claim one is applied.",
          inputSchema: z.object({
            restaurantId: z.string().describe("the cart's restaurant id — call get_food_cart first if you don't have it (restaurant.id)"),
            couponCode: z.string().optional().describe("check just this code"),
          }),
          execute: (a) => run("fetch_food_coupons", a),
        }),
      };

    case "dineout": {
      // Swiggy rate-limits Dineout search (~7 calls → HTTP 429), and each
      // search also renders photo cards (render_restaurants_dineout, done for
      // the model in fetchDineoutToolPayload). Cap searches per attempt; repeats
      // of the same search are served from the cache in dineout-mcp.ts.
      let searches = 0;
      return {
        search_restaurants_dineout: tool({
          description:
            "Find restaurants to BOOK A TABLE at (Swiggy Dineout); the results are shown to the user as photo cards automatically. Pass ONE search term, not a sentence: a restaurant/chain name ('Toit'), a cuisine ('Italian'; a dish becomes its cuisine, 'dosa' → 'South Indian'), an area ('Indiranagar'), a kind of place ('cafe', 'pub', 'brewery') or a vibe ('rooftop', 'buffet', 'live music'). No location words — the user's coordinates are added for you. Call it once per request. An empty result means nothing matched.",
          inputSchema: z.object({
            query: z.string().describe("one term: name, cuisine, area, kind of place, or vibe"),
            latitude: z.number().optional().describe("only when the user named a different city/area"),
            longitude: z.number().optional().describe("only when the user named a different city/area"),
            offset: z.number().int().min(0).optional().describe("only to show more of the SAME search"),
          }),
          execute: (a) =>
            ++searches > 2
              ? Promise.resolve(
                  "Search limit reached for this turn (Swiggy rate-limits Dineout search). Use the restaurants already shown, or ask the user to refine their ask.",
                )
              : run("search_restaurants_dineout", a),
        }),
        get_restaurant_details: tool({
          description:
            "Get ratings, deals, timings, address and amenities for ONE Dineout restaurant the user picked. Use the restaurantId from search_restaurants_dineout; do not search again.",
          inputSchema: z.object({
            restaurantId: z.string(),
            latitude: z.number().optional().describe("same coordinates as the search, if not the user's own"),
            longitude: z.number().optional().describe("same coordinates as the search, if not the user's own"),
          }),
          execute: (a) => run("get_restaurant_details", a),
        }),
        get_available_slots: tool({
          description:
            "Show bookable table slots for ONE Dineout restaurant. One call returns up to 7 days starting at `date` (breakfast/lunch/dinner, free and paid deals) and renders a slot picker — never call it again just because the user wants another date in that range. The user books through the picker.",
          inputSchema: z.object({
            restaurantId: z.string(),
            restaurantName: z.string().optional().describe("for the card title only"),
            date: z.string().describe("start date, YYYY-MM-DD (IST)"),
            latitude: z.number().optional().describe("same coordinates as the search, if not the user's own"),
            longitude: z.number().optional().describe("same coordinates as the search, if not the user's own"),
          }),
          execute: (a) => run("get_available_slots", a),
        }),
        get_booking_status: tool({
          description:
            "Status of ONE table booking by the orderId from its confirmation. There is no list-my-bookings tool: if you don't have an orderId, ask the user for it.",
          inputSchema: z.object({ orderId: z.string() }),
          execute: (a) => run("get_booking_status", a),
        }),
      };
    }

    case "scenes":
      return {
        discover_events: tool({
          description:
            "Browse events near the user — use for ANY genre/category ask ('comedy shows', 'live music this weekend', 'open mic', 'workshops') and for 'what's on'. Pass the genre words the user used (or nothing for general browsing). Returns real event cards in the user's city with eventIds and venueIds. NOT for a named artist (use search_events).",
          inputSchema: z.object({
            genre: z
              .string()
              .optional()
              .describe("the genre / vibe in the user's words, e.g. 'comedy', 'live music', 'workshop', 'party'"),
          }),
          // Swiggy's discover_events is empty server-side today: when it returns
          // nothing, fall back to a keyword search in the user's city (the
          // genre is never forwarded to Swiggy).
          execute: async (a) =>
            agentDiscoverWithFallback(await run("discover_events", {}), a.genre, (eventId) =>
              run("get_event_details", { eventId }),
            ),
        }),
        get_events_collection: tool({
          description:
            "Full event listing for ONE genre chip from discover_events. Only call with a collectionIdentifier taken from GENRE CHIPS in a discover_events result — never guess one (there are usually none).",
          inputSchema: z.object({
            collectionIdentifier: z.string().describe("the chip's collectionIdentifier from discover_events"),
          }),
          execute: (a) => run("get_events_collection", a),
        }),
        search_events: tool({
          description:
            "Search events by a SPECIFIC artist, show title or distinctive keyword (e.g. 'Zakir Khan', 'Sufi night', 'pottery'). Results are kept to the user's city when anything matches there. If nothing matches, say so and offer to browse — do not retry the same query.",
          inputSchema: z.object({
            query: z.string().describe("artist, show name or a distinctive keyword"),
            addressId: z
              .string()
              .optional()
              .describe("only when the user asked for events near a SAVED place: the id from get_saved_locations"),
          }),
          // A saved-location id replaces the user's current coordinates.
          execute: async (a) =>
            agentEnrichSearch(
              await run("search_events", a.addressId ? { ...a, latitude: undefined, longitude: undefined } : a),
              (eventId) => run("get_event_details", { eventId }),
            ),
        }),
        get_event_details: tool({
          description:
            "Details for one event incl. its venueId (the ONLY source of venueId). Always call this before list_event_shows.",
          inputSchema: z.object({ eventId: z.string() }),
          execute: (a) => run("get_event_details", a),
        }),
        list_event_shows: tool({
          description:
            "Show times, seats and ticket types for one event at one venue. Pass the eventId AND the venueId from get_event_details.",
          inputSchema: z.object({
            eventId: z.string(),
            venueId: z.string().describe("venueId from get_event_details"),
            eventTitle: z.string().optional().describe("event name, for the card header only"),
          }),
          execute: (a) => run("list_event_shows", a),
        }),
        get_event_venue_info: tool({
          description:
            "Venue(s) hosting ONE event — venue name, address, location and event metadata (genre, language, duration). Browsing only: NOT for booking (list_event_shows already includes venue details).",
          inputSchema: z.object({
            eventId: z.string(),
            venueId: z.string().optional().describe("one venue only; omit for every venue of the event"),
          }),
          execute: (a) => run("get_event_venue_info", a),
        }),
        get_saved_locations: tool({
          description:
            "The user's saved Swiggy addresses (id + address line), for 'events near my home / office / saved place'. Pass the chosen id as addressId to search_events.",
          inputSchema: z.object({}),
          execute: (a) => run("get_saved_locations", a),
        }),
        get_event_booking_status: tool({
          description: "Check the status of an event ticket booking by its orderId.",
          inputSchema: z.object({ orderId: z.string() }),
          execute: (a) => run("get_event_booking_status", a),
        }),
      };

    case "instamart":
    default:
      return {
        search_products: tool({
          description: "Search Instamart grocery products near the user's delivery address.",
          inputSchema: z.object({
            query: z.string().describe("the grocery item to search for"),
          }),
          execute: (a) => run("search_products", a),
        }),
        your_go_to_items: tool({
          description: "The user's usual / frequently bought grocery items.",
          inputSchema: z.object({}),
          execute: (a) => run("your_go_to_items", a),
        }),
        get_orders: tool({
          description:
            "The user's Instamart orders from the last 15 days (order history, reorder ideas, weekly spend). Set activeOnly=true for current / on-the-way orders.",
          inputSchema: z.object({
            activeOnly: z.boolean().optional().describe("true = only active / ongoing orders"),
            count: z.number().int().min(1).max(20).optional().describe("how many orders (default 10)"),
          }),
          execute: (a) => run("get_orders", a),
        }),
        get_delivery_status: tool({
          description:
            "Live delivery status + ETA for ONE placed Instamart order. Pass the orderId shown in the get_orders result (\"order #…\"). Use for 'where is my order' / 'when will it arrive'.",
          inputSchema: z.object({ orderId: z.string() }),
          execute: (a) => run("get_delivery_status", a),
        }),
        // The documented get_order_details / list_coupons / apply_coupon are NOT
        // exposed by the live Instamart server (tools/list, 2026-10-22) — see
        // docs/swiggy-mcp/CAPABILITIES.md. get_orders already lists each
        // order's items, total and status.
        get_cart: tool({
          description:
            "Read the user's live Instamart cart: items, quantities, bill breakdown and to-pay. Read-only — the cart panel edits it and checks out.",
          inputSchema: z.object({}),
          execute: (a) => run("get_cart", a),
        }),
        // App-side composite (runner.ts): parallel search_products per item +
        // best-value pack choice → ONE basket card the user approves. Read-only.
        build_basket: tool({
          description:
            "Build ONE complete basket card from a one-sentence shopping ask ('weekly groceries for 2, mostly veg, ₹1500', 'party snacks for 10', 'breakfast stuff for the week') or to refill the user's usuals (fromUsuals=true). YOU plan the items + sizes/quantities for the stated people/days/budget; the app searches Swiggy for every item in parallel, picks the best-value in-stock pack per item (sponsored listings skipped unless allowSponsored), substitutes out-of-stock items, respects per-order caps, and shows one card with Approve all. Nothing is added until the user approves.",
          inputSchema: z.object({
            title: z.string().optional().describe("short card title, e.g. 'Weekly groceries for 2'"),
            budget: z.number().optional().describe("rupee budget the user stated, if any"),
            fromUsuals: z.boolean().optional().describe("true = refill the user's go-to items (items not needed)"),
            allowSponsored: z.boolean().optional().describe("true only if the user asked for a specific sponsored brand"),
            vegOnly: z.boolean().optional().describe("true when the user wants veg only"),
            items: z
              .array(
                z.object({
                  query: z.string().describe("a concise Swiggy search term, e.g. 'toned milk', 'brown bread', 'basmati rice'"),
                  quantity: z.number().int().min(1).max(20).optional().describe("packs wanted (when no size)"),
                  size: z.string().optional().describe("total amount wanted, e.g. '2 L', '1 kg', '12' (pieces)"),
                }),
              )
              .max(18)
              .optional(),
          }),
          execute: (a) => run("build_basket", a),
        }),
        get_payment_options: tool({
          description:
            "Live payment methods Swiggy offers for the CURRENT Instamart cart (UPI apps / scan-QR / Swiggy Money / Cash) plus agenticPaymentEligible and the payable amount. Use for 'how can I pay', 'am I ready to order'. Read-only — the user pays from the Checkout button; you never place orders.",
          inputSchema: z.object({}),
          execute: (a) => run("get_payment_options", a),
        }),
        track_order: tool({
          description:
            "PRIMARY live tracking for ONE Instamart order: status, ETA, delivery partner, store and items. Pass the orderId from get_orders (\"order #…\"); the delivery coordinates are added for you.",
          inputSchema: z.object({ orderId: z.string() }),
          // Prefer the order's own delivery coordinates (get_orders); else the
          // selected address's (injectedArgs).
          execute: async (a) => {
            const at = await instamartOrderCoords(a.orderId).catch(() => undefined);
            return run("track_order", at ? { ...a, ...at } : a);
          },
        }),
      };
  }
}

/**
 * App-side composite tools: not Swiggy MCP tools, but the model calls them like
 * one. Each is built ONLY from the listed read tools of its domain (runner.ts
 * runs it); scripts/verify-coverage.ts asserts every part is a live READ tool.
 */
export const APP_COMPOSITE_TOOLS: Partial<Record<DomainService, Record<string, string[]>>> = {
  instamart: { build_basket: ["search_products", "your_go_to_items", "get_orders"] },
};

/** Context args the server injects so the model never has to know them. */
// Which context args each tool documents (docs/swiggy-mcp/*.md). Anything not
// listed gets nothing injected — e.g. booking-status and order-tracking tools
// take only an id.
const ADDRESS_TOOLS = new Set([
  "search_restaurants",
  "get_restaurant_menu",
  "search_menu",
  "get_food_orders",
  "get_food_cart",
  "fetch_food_coupons",
  "search_products",
  "your_go_to_items",
  "get_delivery_status",
]);
const COORD_TOOLS = new Set([
  "search_restaurants_dineout",
  "get_restaurant_details",
  "get_available_slots",
  "discover_events",
  "search_events",
  "get_events_collection",
  "get_event_details",
  "list_event_shows",
  "get_event_venue_info",
]);

export function injectedArgs(
  bareTool: string,
  ctx: { addressId: string; latitude: number; longitude: number },
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (ADDRESS_TOOLS.has(bareTool)) out.addressId = ctx.addressId;
  if (COORD_TOOLS.has(bareTool)) {
    out.latitude = ctx.latitude;
    out.longitude = ctx.longitude;
  }
  // Instamart track_order names its coordinates lat / lng.
  if (bareTool === "track_order") {
    out.lat = ctx.latitude;
    out.lng = ctx.longitude;
  }
  return out;
}
