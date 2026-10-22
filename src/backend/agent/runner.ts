// The concierge agent loop. Walks the provider chain (Claude Haiku → Groq ×2 →
// Gemini ×2, see providers.ts) and runs the first model that answers with the
// service's read-only Swiggy MCP tools. Tool results become card events as soon
// as they arrive; the model's final prose is parsed for control markers by
// emitAssistantText. On any provider error we fall through to the next model;
// cards already shown are de-duplicated so a retry never renders them twice.

import { stepCountIs, streamText, type ModelMessage } from "ai";

import { callTool, coerceToolPayload } from "@/backend/mcp/client";
import { fetchDineoutToolPayload } from "@/backend/mcp/dineout-mcp";
import { buildBasket, summarizeBasket, type BuildBasketArgs } from "@/backend/mcp/instamart-basket";
import type { ChatStreamEvent, DomainService, Service } from "@/shared/types";
import { blocksOtherPicker, pickerToolNote } from "@/shared/picker";
import { dineoutShortlistNote, REVIEWS_NOTE, scenesShortlistNote } from "@/shared/aiRead";

import {
  cacheFromEvent,
  emitAssistantText,
  mapToolResult,
  seedFromCatalog,
  statusLabel,
  type FoodResolved,
  type ProductLine,
  type RunChatArgs,
} from "./agent";
import { isKeyRejected, errorStatus, providerChain, type ChainAttempt } from "./providers";
import { buildServicePrompt, MCP_SERVERS } from "./services";
import { buildServiceTools, injectedArgs } from "./tools";
import { log } from "@/backend/obs/logger";
import { fenceUntrusted, UNTRUSTED_DATA_RULE } from "@/backend/security/prompt-guard";

// Whole-turn budget (route maxDuration is 120 s) and per-attempt guards.
const TOTAL_BUDGET_MS = 100_000;
const STEP_TIMEOUT_MS = 30_000;
const CHUNK_TIMEOUT_MS = 25_000;
const MAX_STEPS = 6;
// The planner fans out over up to four servers (search → collection → …).
const PLAN_MAX_STEPS = 10;
// Keep the prompt inside small free-tier TPM budgets (Groq: 8K tokens/min).
const HISTORY_TURNS = 10;
const HISTORY_CHARS = 1_500;

// Model-supplied fields that only label the UI card; never forwarded to Swiggy.
const DISPLAY_ONLY_ARGS = new Set(["restaurantName", "eventTitle"]);

/**
 * Which MCP server a tool call goes to. A domain tab only ever talks to its own
 * server; the Plan tab's tools each name their owning domain (tools.ts
 * PLAN_TOOLS), and a Plan call without one is refused rather than guessed.
 */
export function resolveToolDomain(service: Service, server?: DomainService): DomainService {
  if (service === "plan") {
    if (!server) throw new Error("plan tool called without its owning server");
    return server;
  }
  if (server && server !== service) {
    throw new Error(`${server} tool is not available in the ${service} tab`);
  }
  return service;
}

export function resolveToolServerUrl(service: Service, server?: DomainService): string {
  return MCP_SERVERS[resolveToolDomain(service, server)].url;
}

/**
 * Server-side isolation guard: may this event reach a chat in `service`? Every
 * card / cart / marker event belongs to exactly one domain; a domain tab only
 * receives its own, the Plan tab receives all four domains' cards plus its
 * itinerary (but never a cart REMOVE — it has no cart of its own).
 */
export function eventAllowedFor(service: Service, ev: ChatStreamEvent): boolean {
  const owner = eventDomain(ev);
  if (owner === "any") return true;
  // REMOVE edits an existing cart — only that cart's own tab may do it.
  if (owner === "cart-edit") return ev.type === "removeFromCart" && ev.target === service;
  return service === "plan" || owner === service;
}

function eventDomain(ev: ChatStreamEvent): DomainService | "plan" | "cart-edit" | "any" {
  switch (ev.type) {
    case "products":
    case "suggestions":
    case "ingredients":
    case "basket":
      return "instamart";
    case "foodRestaurants":
    case "menu":
    case "dishQuery":
    case "foodMealPlan":
      return "food";
    case "dineoutRestaurants":
    case "dineoutSlots":
      return "dineout";
    case "scenesEvents":
    case "scenesShows":
      return "scenes";
    case "pickerSelect":
    case "pickerReasons":
      return ev.target;
    case "bookingTracker":
      return ev.kind;
    case "orderHistory":
      return ev.service;
    case "addToCart":
      return ev.target;
    case "removeFromCart":
      return "cart-edit";
    case "paymentPrompt":
      return ev.session.service === "plan" ? "any" : ev.session.service;
    case "itinerary":
      return "plan";
    default:
      // status / text / chips / control / handoff / best / healthy / warn /
      // macros / comparison / steps / tracker / model / error / done (no
      // cards of their own — they only annotate what this tab already shows)
      return "any";
  }
}

/** Card events (not status pills) — the ones a retry must not render twice. */
function isCard(ev: ChatStreamEvent): boolean {
  return ev.type !== "status" && ev.type !== "text";
}

function clean(s: string, max = 50): string {
  return s
    .replace(/[^\w\s.,₹&'-]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

/** Compact, id-bearing text the model reads back as the tool result. */
export function summarize(events: ChatStreamEvent[]): string {
  const out: string[] = [];
  for (const ev of events) {
    if (ev.type === "basket") {
      out.push(summarizeBasket(ev.basket));
    } else if (ev.type === "products" || ev.type === "suggestions") {
      out.push(
        `PRODUCTS${ev.type === "products" && ev.query ? ` · ${clean(ev.query, 40)}` : ""} (cards already shown; use a pack id in ADD:/BEST:/HEALTHY: markers; the user picks the pack, so name the pack you mean; SPONSORED items are ads — say "Sponsored" if you recommend one):`,
      );
      for (const p of ev.products.slice(0, 10)) {
        const vs = p.variations ?? [];
        const v = vs[0];
        if (!v) continue;
        const badges = (p.badges ?? [])
          .filter((b) => b.type !== "BADGE_TYPE_AD")
          .map((b) => clean(b.text, 15));
        const facts = [
          v.rating ? `★${v.rating.value}${v.rating.count ? ` (${clean(v.rating.count, 8)})` : ""}` : "",
          v.veg === "veg" ? "veg" : v.veg === "nonveg" ? "non-veg" : "",
          v.sla ? `arrives ${clean(v.sla, 12)}` : "",
          p.isPromoted ? "SPONSORED" : "",
          ...badges,
          p.inStock ? "" : "out of stock",
        ].filter(Boolean);
        // Every pack (up to 4) so the model can compare sizes and unit prices.
        const packs = vs.slice(0, 4).map((x) =>
          [
            `id=${x.spinId}`,
            clean(x.quantityDescription, 20),
            `₹${x.offerPrice}${x.mrp > x.offerPrice ? ` (mrp ₹${x.mrp})` : ""}`,
            x.unitLevelPrice ? `₹${clean(x.unitLevelPrice.replace("/", " per "), 20)}` : "",
            x.maxQuantity ? `max ${x.maxQuantity}` : "",
            x.inStock ? "" : "out of stock",
          ]
            .filter(Boolean)
            .join(" "),
        );
        out.push(
          `• ${clean(p.brand || "", 20)} ${clean(p.name || "", 50)}${facts.length ? ` | ${facts.join(" | ")}` : ""} | packs: ${packs.join("; ")}`,
        );
      }
      if (ev.type === "products" && ev.nextOffset) {
        out.push(`More results exist: call search_products again with offset=${ev.nextOffset} if the user wants more.`);
      }
    } else if (ev.type === "foodRestaurants") {
      out.push(
        "RESTAURANTS (cards already shown; recommend ONLY status=OPEN ones, always mention distance for ones over 5 km; call get_restaurant_menu with the restaurantId):",
      );
      for (const r of ev.restaurants.slice(0, 8)) {
        const facts = [
          `status=${r.availability}${r.nextOpenTime ? ` (opens ${clean(r.nextOpenTime, 20)})` : ""}`,
          r.rating > 0 ? `★${r.rating}${r.ratingCount ? ` (${r.ratingCount.replace(/[^\w.+]/g, "").slice(0, 10)})` : ""}` : "",
          r.distanceKm > 0 ? `${r.distanceKm} km` : "",
          r.etaRange,
          r.costForTwo ? clean(r.costForTwo, 20) : "",
          r.area ? clean(r.area, 25) : "",
          r.veg ? "pure veg" : "",
          r.sponsored ? "ad (promoted)" : "",
          clean(r.offer || "", 30),
        ].filter(Boolean);
        out.push(
          `• restaurantId=${r.id} | ${clean(r.name || "", 30)} | ${(r.cuisines || []).map((c) => clean(c, 20)).join(", ")} | ${facts.join(" | ")}`,
        );
      }
    } else if (ev.type === "menu") {
      out.push(
        `MENU${ev.restaurantName ? ` · ${clean(ev.restaurantName, 30)}` : ""} (cards already shown; use the id in ADD:/BEST:/MACRO: markers):`,
      );
      const r = ev.restaurant;
      if (r) {
        const about = [
          r.isOpen ? "open" : "CLOSED",
          r.rating > 0 ? `★${r.rating}${r.ratingCount ? ` (${r.ratingCount.replace(/[^\w.+]/g, "").slice(0, 10)})` : ""}` : "",
          r.etaRange,
          r.costForTwo ? clean(r.costForTwo, 20) : "",
          [r.area, r.city].filter(Boolean).map((x) => clean(x ?? "", 20)).join(", "),
          r.cuisines.length ? r.cuisines.slice(0, 4).map((c) => clean(c, 20)).join(", ") : "",
          r.sponsored ? "ad (promoted)" : "",
          ev.totalCategories ? `${ev.totalCategories} categories` : "",
        ].filter(Boolean);
        out.push(`restaurantId=${r.id} | ${about.join(" | ")}`);
      }
      const cats = ev.categories.filter((c) => c.totalItems || c.moreItems);
      if (cats.length) {
        out.push(
          `Categories: ${cats
            .slice(0, 8)
            .map((c) => `${clean(c.title, 30)} (${c.totalItems ?? c.items.length}${c.moreItems ? `, ${c.moreItems} not shown` : ""})`)
            .join(", ")}`,
        );
      }
      for (const it of ev.categories.flatMap((c) => c.items).slice(0, 24)) {
        // cross-restaurant results: the restaurantId lets a meal plan open that menu next
        const where = !ev.restaurantId && it.restaurantName ? ` | at ${clean(it.restaurantName, 30)} (restaurantId=${it.restaurantId})` : "";
        const rating = it.rating ? ` | ★${clean(it.rating, 4)}${it.ratingCount ? ` (${it.ratingCount.replace(/[^\w.+]/g, "").slice(0, 8)})` : ""}` : "";
        const desc = it.description ? ` | ${clean(it.description, 60)}` : "";
        // search_menu portions: variantsV2 prices are ADD-ONS to the dish price
        const opts = (it.customization?.variantGroups ?? [])
          .slice(0, 1)
          .map(
            (g) =>
              ` | options: ${g.choices
                .slice(0, 4)
                .map((c) => `${c.name.replace(/[|\r\n/]/g, " ").slice(0, 40)}${c.isDefault ? " (default)" : ""}${c.price ? ` ${g.pricesAreAddOns ? "+" : ""}₹${c.price}` : ""}${c.inStock ? "" : " sold out"}`)
                .join(" / ")}`,
          )
          .join("");
        const cat = it.category ? ` | ${clean(it.category, 20)}` : "";
        out.push(
          `• id=${it.id} | ${clean(it.name || "", 40)} | ₹${it.price} | ${it.veg ? "veg" : "non-veg"}${it.bestseller ? " | bestseller" : ""}${rating}${it.hasVariants || it.hasAddons ? " | customisable" : ""}${it.inStock ? "" : " | unavailable"}${cat}${opts}${where}${desc}`,
        );
      }
      if (ev.hasMore) {
        out.push(`More categories exist: call get_restaurant_menu again with page=${(ev.page ?? 1) + 1} if the user wants more.`);
      }
    } else if (ev.type === "dineoutRestaurants") {
      out.push(
        "DINEOUT RESTAURANTS (photo cards with View details + Reserve buttons already shown, in this order; mark the best with BEST: <restaurantId> — <reason>; do NOT search again for the same ask):",
      );
      const at = ev.restaurants[0];
      if (at?.latitude !== undefined && at.longitude !== undefined) {
        out.push(`(searched at latitude=${at.latitude}, longitude=${at.longitude} — reuse for details/slots)`);
      }
      if (ev.paging?.total !== undefined) {
        out.push(
          `(${ev.paging.total} matched in total${
            ev.paging.nextOffset !== undefined
              ? `; the user can tap "Load more", or call search_restaurants_dineout again with the same query and offset=${ev.paging.nextOffset} only if they ask for more`
              : "; all shown"
          })`,
        );
      }
      for (const r of ev.restaurants.slice(0, 10)) {
        const offerLine = (o: { title: string; description?: string; discountPercentage?: number; coverCharge?: number; slotGroupName?: string }) =>
          clean(
            [
              o.slotGroupName ? `[${o.slotGroupName}]` : "",
              o.title,
              o.discountPercentage ? `${o.discountPercentage}% off` : "",
              o.description,
              o.coverCharge ? `₹${o.coverCharge} cover charge` : o.coverCharge === 0 ? "no cover charge" : "",
            ]
              .filter(Boolean)
              .join(" — "),
            90,
          );
        out.push(
          [
            `• restaurantId=${r.id}`,
            clean(r.name, 30),
            r.bookable === false ? "bookable: no (walk-in only — no table booking on Swiggy)" : r.bookable ? "bookable: yes" : "",
            r.cuisines.map((c) => clean(c, 20)).join(", "),
            r.rating !== undefined ? `★${r.rating}${r.ratingCount ? ` (${r.ratingCount})` : ""}` : "new/unrated",
            r.costForTwo ? clean(r.costForTwo, 25) : "",
            [r.locality, r.area].filter(Boolean).map((a) => clean(a ?? "", 25)).join(", "),
            r.distance ? clean(r.distance, 12) : "",
            r.offerHeadline
              ? `offer: ${clean(
                  [r.offerHeadline.logoText ? `[Swiggy ${r.offerHeadline.logoText}]` : "", r.offerHeadline.title, r.offerHeadline.subtitle, r.offerHeadline.subtext]
                    .filter(Boolean)
                    .join(" "),
                  70,
                )}`
              : "",
            r.dealDetails?.length
              ? `deals: ${r.dealDetails.slice(0, 3).map(offerLine).join("; ")}`
              : r.deals?.[0]
                ? `deal: ${clean(r.deals[0], 50)}`
                : "",
            r.offerDetails?.length
              ? `offers: ${r.offerDetails.slice(0, 3).map(offerLine).join("; ")}`
              : !r.offerHeadline && r.offers?.[0]
                ? `offer: ${clean(r.offers[0], 40)}`
                : "",
            r.bankOffers?.length ? `bank offers: ${r.bankOffers.slice(0, 2).map((b) => clean(b, 30)).join("; ")}` : "",
            r.vendorHighlights?.length ? `perks: ${r.vendorHighlights.slice(0, 3).map((v) => clean(v, 25)).join(", ")}` : "",
            r.timings ? clean(r.timings, 25) : "",
            r.address ? `address: ${clean(r.address, 70)}` : "",
            r.hasDetails && r.amenities?.length ? `amenities: ${r.amenities.slice(0, 8).map((a) => clean(a, 20)).join(", ")}` : "",
            !r.hasDetails && r.highlights?.length ? r.highlights.slice(0, 5).map((h) => clean(h, 20)).join(", ") : "",
            r.hasDetails && r.menuImageGroups?.length
              ? `menu photos: ${r.menuImageGroups.map((g) => `${clean(g.title, 25)} (${g.images.length}p)`).join(", ")}`
              : "",
            r.hasDetails && r.mastheadImageUrls?.length ? `${r.mastheadImageUrls.length} photos` : "",
          ]
            .filter(Boolean)
            .join(" | "),
        );
      }
      const shortlist = dineoutShortlistNote(ev.restaurants);
      if (shortlist) out.push(shortlist);
      out.push(`REVIEWS: ${REVIEWS_NOTE} Cite the rating with its count (e.g. "4.6★ from 1.1k ratings"); never quote or invent reviews.`);
    } else if (ev.type === "dineoutSlots") {
      // Per-date meal windows (one call = 7 days) + the deals on offer. The user
      // books in the picker; the model never books or claims a booking.
      out.push(
        `SLOTS · ${clean(ev.restaurantName || "restaurant", 30)} (slot picker already shown — the user picks date, time, guests and deal there and confirms; you cannot book):`,
      );
      const byDate = new Map<string, Map<string, { first: string; last: string; n: number }>>();
      const deals = new Map<string, string>();
      const daySub = new Map<string, string>();
      for (const s of ev.slots) {
        if (s.daySubtext && !daySub.has(s.dateStr)) daySub.set(s.dateStr, clean(s.daySubtext, 25));
        if (s.availableInventory === 0 || s.deals.every((d) => d.soldOut)) continue;
        const groups = byDate.get(s.dateStr) ?? new Map<string, { first: string; last: string; n: number }>();
        const g = groups.get(s.slotGroupName || "Slots");
        if (g) {
          g.last = s.displayTime;
          g.n++;
        } else groups.set(s.slotGroupName || "Slots", { first: s.displayTime, last: s.displayTime, n: 1 });
        byDate.set(s.dateStr, groups);
        for (const d of s.deals) {
          const label = clean(d.title || (d.isFree ? "Table booking" : "Prebook deal"), 40);
          if (!deals.has(label)) {
            deals.set(
              label,
              [
                d.isFree ? "free" : `paid${d.bookingPrice ? ` ₹${d.bookingPrice}` : d.displayFee ? ` ${clean(d.displayFee, 15)}` : ""}`,
                d.discountPercentage ? `${d.discountPercentage}% off bill` : "",
                d.dealCategory ? clean(d.dealCategory, 15) : "",
              ]
                .filter(Boolean)
                .join(", "),
            );
          }
        }
      }
      if (byDate.size === 0) out.push("• No bookable slots in this 7-day window.");
      for (const [date, groups] of byDate) {
        out.push(
          `• ${date}${daySub.has(date) ? ` [${daySub.get(date)}]` : ""}: ${[...groups].map(([name, g]) => `${name} ${g.first}${g.n > 1 ? `–${g.last}` : ""} (${g.n})`).join(", ")}`,
        );
      }
      if (deals.size) out.push(`Deals: ${[...deals].slice(0, 6).map(([t, k]) => `${t} (${k})`).join(" · ")}`);
    } else if (ev.type === "scenesEvents") {
      if (ev.emptyDiscover) {
        // Machine line parsed by the discover tool's keyword fallback (tools.ts).
        const d = ev.emptyDiscover;
        out.push(`DISCOVER_EMPTY lat=${d.latitude} lng=${d.longitude}${d.city ? ` city=${clean(d.city, 30)}` : ""}`);
      }
      if (ev.events.length) {
        out.push("EVENTS (cards with Book buttons already shown; mark the best with BEST: <eventId> — <reason>):");
      }
      for (const e of ev.events.slice(0, 8)) {
        const place = [e.venueName, e.area, e.city].filter(Boolean).map((x) => clean(x as string, 30)).join(", ");
        // get_event_venue_info cards also carry distance + event metadata.
        const extra = [
          e.distanceKm !== undefined ? `${e.distanceKm} km away` : "",
          e.showCount !== undefined ? `${e.showCount} show${e.showCount === 1 ? "" : "s"}` : "",
          e.duration,
          e.ageGroup,
          e.seating,
          e.languages?.slice(0, 3).join("/"),
          e.rewards ? e.rewards.replace(/[\r\n|]/g, " ").slice(0, 50) : "",
        ].filter(Boolean);
        out.push(
          `• eventId=${e.id}${e.venueId ? ` | venueId=${e.venueId}` : ""} | ${clean(e.title, 50)}${place ? ` | ${place}` : ""}${e.priceText ? ` | ${clean(e.priceText, 20)}` : ""}${e.dateSummary ? ` | ${e.dateSummary.replace(/[\r\n|]/g, " ").slice(0, 40)}` : ""}${extra.length ? ` | ${extra.join(" · ").replace(/[\r\n|]/g, " ")}` : ""}`,
        );
      }
      const scenesShortlist = scenesShortlistNote(ev.events);
      if (scenesShortlist) out.push(scenesShortlist);
      if (ev.collections?.length) {
        out.push(
          `GENRE CHIPS (shown; for a genre call get_events_collection with its collectionIdentifier): ${ev.collections
            .slice(0, 12)
            .map((c) => `${clean(c.label, 20)}=${c.id}`)
            .join(", ")}`,
        );
      }
    } else if (ev.type === "scenesShows") {
      const about = [
        ev.duration,
        ev.ageGroup,
        ev.languages?.slice(0, 3).join("/"),
        ev.seating,
        ev.recurring
          ? `recurring${ev.runUntilUnix ? ` until ${new Date(ev.runUntilUnix * 1000).toISOString().slice(0, 10)}` : ""}`
          : "",
        ev.venueDistanceKm !== undefined ? `${ev.venueDistanceKm} km away` : "",
        ev.startPrice !== undefined ? `from ₹${ev.startPrice}` : "",
      ]
        .filter(Boolean)
        .join(" · ");
      out.push(
        `SHOWS · ${clean(ev.eventTitle, 40)} · eventId=${ev.eventId}${ev.venueId ? ` · venueId=${ev.venueId}` : " · (no venueId — not bookable until scoped to a venue)"}${ev.venueName ? ` · ${clean(ev.venueName, 30)}` : ""}${about ? ` · ${about.replace(/[\r\n|]/g, " ").slice(0, 120)}` : ""} (ticket picker already shown; the user picks show, ticket and count there):`,
      );
      // eventInfo extras — only the ones Swiggy filled.
      const info = [
        ev.category ? `Category: ${clean(ev.category, 30)}` : "",
        ev.tags?.length ? `Tags: ${ev.tags.map((t) => clean(t, 24)).join(", ")}` : "",
        ev.artists?.length ? `Artists: ${ev.artists.slice(0, 5).map((a) => clean(a, 30)).join(", ")}` : "",
        ev.organizer ? `Organiser: ${clean(ev.organizer, 40)}` : "",
        ev.tour ? `Tour: ${clean(ev.tour, 40)}` : "",
        ev.rewards ? `Offer: ${ev.rewards.replace(/[\r\n|]/g, " ").slice(0, 60)}` : "",
        ev.description ? `About: ${clean(ev.description, 200)}` : "",
        ev.thingsToRemember?.length ? `Remember: ${ev.thingsToRemember.slice(0, 4).map((t) => clean(t, 80)).join("; ")}` : "",
        ev.eventTnc ? `Terms: ${clean(ev.eventTnc, 160)}` : "",
      ].filter(Boolean);
      if (info.length) out.push(info.join(" | "));
      if (ev.dates?.length) {
        out.push(
          `Dates: ${ev.dates
            .slice(0, 10)
            .map((d) => `${d.date}${d.onSale ? (d.available !== undefined ? ` (${d.available} seats)` : "") : " SOLD OUT"}`)
            .join(", ")}`,
        );
      }
      for (const s of ev.shows.slice(0, 10)) {
        const tickets = s.tickets
          .slice(0, 4)
          .map(
            (t) =>
              `${clean(t.title, 24)}${t.price !== undefined ? ` ₹${t.price}` : ""}${t.originalPrice !== undefined ? ` (was ₹${t.originalPrice})` : ""}${t.coverCharge !== undefined ? ` +₹${t.coverCharge} cover` : ""}${t.availableInventory !== undefined ? ` (${t.availableInventory} left)` : ""}${t.onSale ? "" : " SOLD OUT"}${t.tnc ? ` [${clean(t.tnc.replace(/\n/g, "; "), 60)}]` : ""}`,
          )
          .join(", ");
        const showMeta = [
          s.durationMin !== undefined ? `${s.durationMin} min` : "",
          s.gatesOpenUnix !== undefined
            ? `gates ${new Date(s.gatesOpenUnix * 1000).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour: "numeric", minute: "2-digit" })}`
            : "",
          s.availableSeats !== undefined ? `${s.availableSeats} seats` : "",
          s.minGuests !== undefined && s.maxGuests !== undefined ? `${s.minGuests}–${s.maxGuests} per booking` : "",
          s.auditorium ? clean(s.auditorium, 20) : "",
        ].filter(Boolean);
        out.push(
          `• ${s.showTimeIst.replace(/[\r\n|]/g, " ").slice(0, 40) || s.date || "show"}${s.onSale ? "" : " | SOLD OUT"}${showMeta.length ? ` | ${showMeta.join(" · ")}` : ""} | ${tickets || "no ticket types listed"}`,
        );
      }
    } else if (ev.type === "orderHistory") {
      out.push(`ORDERS (${ev.orders.length}, newest first — a card listing ALL of them is already shown; mention the count and highlight what matters, don't re-list every line):`);
      for (const o of ev.orders.slice(0, 20)) {
        // Food extras: restaurant area, order type, and RATE_* CTAs (rating is
        // only possible in the Swiggy app — there is no rating tool).
        const extra = [
          o.area ? clean(o.area, 30) : "",
          o.orderType && o.orderType.toLowerCase() !== "regular" ? clean(o.orderType, 15) : "",
          o.reorderable ? "reorderable" : "",
          o.rateActions?.length ? `can rate in Swiggy app: ${o.rateActions.map((a) => clean(a, 20)).join(", ")}` : "",
        ].filter(Boolean);
        out.push(
          `• orderId=${o.orderId} | ${clean(o.title, 40)} | ${o.status}${o.active ? " (ACTIVE)" : ""} | ${o.total ?? ""} | ${o.placedAt ?? ""} | ${clean(o.items ?? "", 80)}${extra.length ? ` | ${extra.join(" | ")}` : ""}`,
        );
      }
    } else if (ev.type === "tracker") {
      out.push(
        `ORDER: ${ev.status}${ev.eta ? " · " + ev.eta : ""}${ev.items ? " · " + ev.items : ""}${
          typeof ev.progress === "number" ? ` · ${ev.progress}% done` : ""
        }${ev.trackUrl ? ` · live tracking page: ${ev.trackUrl}` : ""}`,
      );
    } else if (ev.type === "bookingTracker") {
      out.push(`BOOKING: ${ev.title} · ${ev.status} · ${ev.details}`);
    }
  }
  return out.length ? out.join("\n") : "No results found for this request.";
}

/** A tool result with no card: the raw data, size-capped, for the model only. */
function compactPayload(bareTool: string, payload: unknown): string {
  if (payload === undefined || payload === null) return "No results found for this request.";
  let json: string;
  try {
    // Drop Swiggy's session plumbing (get_food_cart echoes a session JWT as
    // `tid`) — it wastes the budget and must never reach the model.
    json = JSON.stringify(payload, (k, v) => (k === "tid" || k === "sid" || k === "deviceId" ? undefined : v));
  } catch {
    json = String(payload);
  }
  if (!json || json === "{}" || json === "[]") return "No results found for this request.";
  const MAX = 3_000;
  return `RESULT of ${bareTool} (data only — no card was shown; summarise what matters for the user):\n${fenceUntrusted(
    json,
    MAX,
  )}`;
}

function buildMessages(args: RunChatArgs): ModelMessage[] {
  const history: ModelMessage[] = (args.history ?? [])
    .filter((h) => h.text.trim())
    .slice(-HISTORY_TURNS)
    .map((h) =>
      h.role === "user"
        ? { role: "user" as const, content: h.text.slice(0, HISTORY_CHARS) }
        : { role: "assistant" as const, content: h.text.slice(0, HISTORY_CHARS) },
    );

  const text = args.message.trim() || (args.image ? "" : "Help me with my order.");
  const content: Array<{ type: "text"; text: string } | { type: "image"; image: string; mediaType: string }> = [];
  if (text) content.push({ type: "text", text });
  if (args.image) {
    content.push({ type: "image", image: args.image.data, mediaType: args.image.mediaType });
  }
  return [...history, { role: "user", content }];
}

function photoInstructions(service: Service): string {
  return `\n\nThe user attached a photo. First identify what it shows — a fridge/pantry, a printed or handwritten shopping list, or a cooked dish. THEN ${
    service === "food"
      ? "name the dish you see and emit `DISHES: <that dish>` so matching dishes from nearby restaurants appear; mark the best with BEST"
      : service === "instamart"
        ? "emit `INGREDIENTS: a | b | c` listing every item you identified so the app searches and fills the cart with the best pick of each"
        : "use it to understand what the user wants and search accordingly"
  }. Say in ONE warm line what you spotted.`;
}

function describeError(err: unknown): string {
  const status = errorStatus(err);
  const msg = err instanceof Error ? err.message : String(err);
  return `${status ? `${status} ` : ""}${msg}`.slice(0, 240);
}

/**
 * Run one attempt. Yields events; throws if the provider fails. Returns the
 * full reply text plus whether any card came from this attempt's tools.
 */
async function* runAttempt(
  attempt: ChainAttempt,
  args: RunChatArgs,
  shared: {
    lineBySpin: Map<string, ProductLine>;
    foodById: Map<string, FoodResolved>;
    restNameById: Map<string, string>;
    shownCards: Set<string>;
    signal: AbortSignal;
  },
): AsyncGenerator<ChatStreamEvent, { text: string; cards: number }> {
  const { service, ctx } = args;
  const queue: ChatStreamEvent[] = [];
  let cards = 0;

  const run = async (
    bareTool: string,
    modelArgs: Record<string, unknown>,
    server?: DomainService,
  ): Promise<string> => {
    // Each tool goes to the server that owns it (Plan spans all four).
    const domain = resolveToolDomain(service, server);
    const url = MCP_SERVERS[domain].url;
    const input = { ...injectedArgs(bareTool, ctx), ...modelArgs };
    const mcpArgs = Object.fromEntries(
      Object.entries(input).filter(([k, v]) => !DISPLAY_ONLY_ARGS.has(k) && v !== undefined),
    );
    const q = typeof modelArgs.query === "string" ? modelArgs.query : "";
    queue.push({ type: "status", label: statusLabel(bareTool, q) ?? "Working…" });
    let events: ChatStreamEvent[];
    let payload: unknown;
    try {
      // Dineout needs more than the coerced payload (text-only search → photo
      // cards via render; slots in `_meta`) — see fetchDineoutToolPayload.
      payload =
        domain === "dineout"
          ? await fetchDineoutToolPayload(bareTool, mcpArgs, shared.signal)
          : bareTool === "build_basket"
            ? // Instamart app-side composite: parallel search_products + pack choice.
              await buildBasket(ctx.addressId, mcpArgs as unknown as BuildBasketArgs)
            : coerceToolPayload(await callTool(url, bareTool, mcpArgs, { signal: shared.signal }));
      events = mapToolResult({ bareTool, query: q, input }, payload, ctx);
    } catch (e) {
      // Auth failures must reach the user ("log in again"), not be paraphrased away.
      if ((e as { name?: string })?.name === "AuthError" || errorStatus(e) === 401) throw e;
      return `Tool ${bareTool} failed: ${fenceUntrusted(e instanceof Error ? e.message : "error", 500)}. Tell the user briefly and suggest a next step; do not invent results.`;
    }
    let blocked: string | null = null;
    for (const ev of events) {
      // Never render another domain's cards in this tab.
      if (!eventAllowedFor(service, ev)) continue;
      // An open picker is never swapped for another event's / restaurant's
      // picker unless the user plainly asked for that one (see blocksOtherPicker).
      const other =
        ev.type === "scenesShows" || ev.type === "dineoutSlots" ? blocksOtherPicker(ev, ctx.activePicker, args.message) : null;
      if (other) {
        blocked = other;
        continue;
      }
      cacheFromEvent(ev, shared.lineBySpin, shared.foodById, shared.restNameById);
      const filled =
        ev.type === "menu" && !ev.restaurantName
          ? { ...ev, restaurantName: shared.restNameById.get(ev.restaurantId) ?? ev.restaurantName }
          : ev;
      queue.push(filled);
    }
    // Tools with no card (order details, coupons…) still need their data in
    // front of the model — pass a compact JSON excerpt instead of "no results".
    if (blocked) {
      return `NOT SHOWN: the picker for "${blocked}" was not opened — the user still has the OPEN PICKER above and did not ask to switch. Do not say it opened; handle their request in the open picker with a PICK line, or ask whether they want "${blocked}" instead.`;
    }
    if (!events.some(isCard)) return compactPayload(bareTool, payload);
    // slots / shows: the AI PICKS the picker shows, so the model writes the read + WHY lines
    return summarize(events) + pickerToolNote(events, ctx.activePicker?.kind === "dineout" ? ctx.activePicker.guests : 2);
  };

  // Swiggy text in tool results is data, never instructions (security/prompt-guard).
  let instructions = buildServicePrompt(service, ctx) + UNTRUSTED_DATA_RULE;
  if (args.image) instructions += photoInstructions(service);

  const result = streamText({
    model: attempt.languageModel,
    instructions: {
      role: "system",
      content: instructions,
      // Large, stable per-service prompt: cache it on Anthropic (ignored elsewhere).
      providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } },
    },
    messages: buildMessages(args),
    tools: args.noTools ? {} : buildServiceTools(service, run),
    stopWhen: stepCountIs(service === "plan" ? PLAN_MAX_STEPS : MAX_STEPS),
    maxRetries: 0, // the chain, not the SDK, handles failover
    maxOutputTokens: 4096,
    timeout: { stepMs: STEP_TIMEOUT_MS, chunkMs: CHUNK_TIMEOUT_MS },
    abortSignal: shared.signal,
    providerOptions: attempt.providerOptions as never,
    // Errors arrive as `error` stream parts and are handled by the chain;
    // don't let the SDK also dump the raw error object to the console.
    onError: () => {},
  });

  let text = "";
  const flush = function* (): Generator<ChatStreamEvent> {
    while (queue.length) {
      const ev = queue.shift()!;
      if (isCard(ev)) {
        const key = JSON.stringify(ev);
        if (shared.shownCards.has(key)) continue;
        shared.shownCards.add(key);
        cards++;
      }
      yield ev;
    }
  };

  for await (const part of result.stream) {
    yield* flush();
    if (part.type === "text-delta") text += part.text;
    else if (part.type === "error") throw part.error ?? new Error("provider stream error");
    else if (part.type === "finish" && part.finishReason === "content-filter" && !text.trim()) {
      throw new Error("response blocked by the provider's content filter");
    }
  }
  yield* flush();
  return { text, cards };
}

/** Public entry: run the chat turn across the provider chain. */
export async function* runChatChain(args: RunChatArgs): AsyncGenerator<ChatStreamEvent> {
  const attempts = providerChain(process.env, { needsVision: Boolean(args.image) });
  if (attempts.length === 0) {
    throw new Error(
      "No LLM provider keys are configured. Set ANTHROPIC_API_KEY, GROQ_API_KEY(_2) or GEMINI_API_KEY(_2) in .env.local.",
    );
  }

  const lineBySpin = new Map<string, ProductLine>();
  const foodById = new Map<string, FoodResolved>();
  const restNameById = new Map<string, string>();
  seedFromCatalog(args.ctx, lineBySpin, foodById, restNameById);
  const shownCards = new Set<string>();

  const deadline = Date.now() + TOTAL_BUDGET_MS;
  const rejectedKeys = new Set<string>();
  let lastErr: unknown = null;
  let failures = 0;
  let cardsShown = 0;

  for (const attempt of attempts) {
    if (args.signal?.aborted) return;
    const keyId = `${attempt.provider}#${attempt.keyIndex}`;
    if (rejectedKeys.has(keyId)) continue;
    const remaining = deadline - Date.now();
    if (remaining <= 2_000) break;

    const started = Date.now();
    try {
      const gen = runAttempt(attempt, args, {
        lineBySpin,
        foodById,
        restNameById,
        shownCards,
        signal: args.signal
          ? AbortSignal.any([args.signal, AbortSignal.timeout(remaining)])
          : AbortSignal.timeout(remaining),
      });
      let step = await gen.next();
      while (!step.done) {
        if (isCard(step.value)) cardsShown++;
        yield step.value;
        step = await gen.next();
      }
      const { text } = step.value;

      if (!text.trim() && cardsShown === 0) {
        throw new Error("empty completion");
      }
      log.info("llm_turn", {
        service: args.service,
        provider: attempt.provider,
        key: attempt.keyIndex,
        model: attempt.model.id,
        ms: Date.now() - started,
        ok: true,
        fallbacks: failures,
      });
      yield {
        type: "model",
        info: {
          provider: attempt.provider,
          model: attempt.model.id,
          label: attempt.model.label,
          step: attempt.stepLabel,
          fallbacks: failures,
        },
      };
      const reply = text.trim() ? text : fallbackReply(args.service);
      for (const ev of emitAssistantText(reply, args.service, lineBySpin, foodById, args.message, args.ctx.activePicker)) {
        // Markers can name another domain's ids (ADD/DISHES/INGREDIENTS…) — drop them.
        if (eventAllowedFor(args.service, ev)) yield ev;
      }
      return;
    } catch (err) {
      // The user stopped the turn — don't fall through to the next provider.
      if (args.signal?.aborted) return;
      // Swiggy auth problems are not provider problems — surface them immediately.
      if ((err as { name?: string })?.name === "AuthError") throw err;
      lastErr = err;
      failures++;
      log.warn("llm_fallback", {
        service: args.service,
        provider: attempt.provider,
        key: attempt.keyIndex,
        model: attempt.model.id,
        ms: Date.now() - started,
        errMessage: describeError(err),
      });
      if (isKeyRejected(err)) rejectedKeys.add(keyId);
    }
  }

  throw lastErr instanceof Error
    ? lastErr
    : new Error("Every AI provider failed or timed out. Please try again in a moment.");
}

/** Short reply when a model rendered cards but returned no prose. */
function fallbackReply(service: Service): string {
  switch (service) {
    case "food":
      return "Here's what I found near you — tap a dish to add it.\n\nSUGGESTIONS: View cart | Show more | Different cuisine";
    case "dineout":
      return "Here are the best spots I found — tap **Reserve** on any of them to pick a slot.\n\nSUGGESTIONS: Book for tonight | Rooftop places | Buffet deals";
    case "scenes":
      return "Here's what's on near you — tap an event to see shows and tickets.\n\nSUGGESTIONS: Comedy this weekend | Live music | Something tonight";
    case "plan":
      return "Here's what I found for your outing — tap Reserve, See shows or Add on any card to book it in its own flow.\n\nSUGGESTIONS: Build the full plan | Cheaper options | Change the time";
    default:
      return "Here are the best matches — tap **Add** on anything you want.\n\nSUGGESTIONS: View cart | Show more | Cheaper options";
  }
}
