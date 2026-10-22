// Recorded LIVE Swiggy MCP payloads (read-only tools, captured 2026-10-22/23,
// PII already redacted at capture: "Test User", "[flat redacted]", masked
// phones) turned into component / route inputs by the APP'S OWN mappers, so
// tests see exactly what production would render. Nothing here is invented:
// every product, price, slot and show comes from these files —
//   docs/swiggy-mcp/live/*.json            (Instamart / Food captures)
//   docs/swiggy-mcp/LIVE-SAMPLES.md         (raw CallToolResults, Dineout slots)
//   scripts/fixtures/dineout-live.json      (render / details / walk-in-only KFC)
//   scripts/fixtures/scenes/*_live.json     (Scenes listings)

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { coerceToolPayload } from "@/backend/mcp/payload";
import { mapDineoutRender, mapDineoutSlots, readSlotsPayload } from "@/backend/mcp/dineout-mcp";
import { mapShowListing } from "@/backend/mcp/scenes-mcp";
import { mapCartPayload, cartToState, mapProductsPayload } from "@/backend/mcp/swiggy-mcp";
import { mapPaymentOptions } from "@/backend/mcp/payment-mcp";
import type { DineoutRestaurant, DineoutSlotsView, Product, ScenesShowListing } from "@/shared/types";

export const ROOT = join(__dirname, "..", "..");
const LIVE = join(ROOT, "docs/swiggy-mcp/live");

type Capture = { structuredContent?: Record<string, unknown>; result?: Record<string, unknown>; args?: Record<string, unknown> };

export const readJson = <T = unknown>(rel: string): T => JSON.parse(readFileSync(join(ROOT, rel), "utf8")) as T;
export const capture = (file: string): Capture => readJson<Capture>(`docs/swiggy-mcp/live/${file}`);

/** The payload exactly as client.ts → coerceToolPayload hands it to the mappers. */
export const livePayload = (file: string): unknown => {
  const c = capture(file);
  return coerceToolPayload(c.result ?? { content: [], structuredContent: c.structuredContent });
};

/** A raw CallToolResult for the stubbed MCP client (what Swiggy's server sent). */
export const liveToolResult = (file: string): { content: { type: string; text: string }[]; structuredContent?: Record<string, unknown> } => {
  const c = capture(file);
  if (c.result) return c.result as never;
  return { content: [{ type: "text", text: JSON.stringify(c.structuredContent ?? {}) }], structuredContent: c.structuredContent };
};

export const liveFiles = (): string[] => readdirSync(LIVE).filter((f) => f.endsWith(".json"));

/** The ```json block under each "## <heading>" of LIVE-SAMPLES.md. */
export function liveSamples(heading: string): string[] {
  const md = readFileSync(join(ROOT, "docs/swiggy-mcp/LIVE-SAMPLES.md"), "utf8");
  const out: string[] = [];
  for (const part of md.split(/\n## /)) {
    if (!part.startsWith(heading)) continue;
    const m = /```json\n([\s\S]*?)\n```/.exec(part);
    if (m) out.push(m[1]);
  }
  return out;
}

/* -------------------------------- Instamart -------------------------------- */

/** search_products "toned milk" — Amul Moti Toned Milk has "450 ml x 2" + "450 ml" packs. */
export function liveMilkProducts(): Product[] {
  return mapProductsPayload(livePayload("im_search_products_milk.json")).products;
}

export function liveProducts(file = "im_search_products.json"): Product[] {
  return mapProductsPayload(livePayload(file)).products;
}

/** The Chennai address the live cart was captured for (get_addresses). */
export const LIVE_CART_ADDRESS_ID = "db7kh1c1d96ofdam8g8g__AMVEDwTGeS8WPRJQbO-o12";

/** get_cart (raw: two text blocks + structuredContent) → the CartPanel's CartState. */
export function liveCartState() {
  const view = mapCartPayload(livePayload("im_get_cart.raw.json"));
  return cartToState(view, LIVE_CART_ADDRESS_ID);
}

export function livePaymentOptions(service: "instamart" | "food" = "instamart", file = "im_get_payment_options.json") {
  return mapPaymentOptions(service, livePayload(file));
}

/* --------------------------------- Dineout --------------------------------- */

type DineoutFixtures = Record<string, { structuredContent: unknown }> & { slots_1032642_structured: Record<string, unknown> };
export const dineoutFixtures = (): DineoutFixtures => readJson<DineoutFixtures>("scripts/fixtures/dineout-live.json");

/** render_restaurants_dineout, Koramangala (4 live cards, photos + offers). */
export function liveDineoutRestaurants(): DineoutRestaurant[] {
  return mapDineoutRender(dineoutFixtures().render_koramangala.structuredContent).restaurants;
}

/** KFC — listed on Dineout as partnerType NPR (no table bookings). */
export function liveWalkInRestaurant(): DineoutRestaurant {
  return mapDineoutRender(dineoutFixtures().render_npr_kfc.structuredContent).restaurants[0];
}

/** The LIVE-SAMPLES slots sample is truncated mid-object: keep every complete slot. */
function repairTruncatedSlots(text: string): Record<string, unknown> {
  const cut = text.lastIndexOf("\n   },");
  const head = text.slice(0, cut + "\n   }".length);
  return JSON.parse(`${head}\n  ]\n }\n}`) as Record<string, unknown>;
}

/** get_available_slots for Si Nonna's (1032642), 23 Oct 2026 — free + paid deals. */
export function liveDineoutSlotsView(): DineoutSlotsView {
  const raw = repairTruncatedSlots(liveSamples("get_available_slots")[0]);
  const withStructured = { ...raw, structuredContent: dineoutFixtures().slots_1032642_structured };
  const view = mapDineoutSlots(readSlotsPayload(withStructured), {
    restaurantId: "1032642",
    restaurantName: "Si Nonna's",
    date: "2026-10-23",
    latitude: 12.9352,
    longitude: 77.6245,
  });
  if (!view) throw new Error("live slots fixture did not map");
  return view;
}

/* --------------------------------- Scenes ---------------------------------- */

/** list_event_shows for event 100081309 at Koramangala Social (venue 1084). */
export function liveScenesListing(): ScenesShowListing {
  const raw = readJson("scripts/fixtures/scenes/shows_100081309_live.json");
  return mapShowListing(raw, { eventId: "100081309", venueId: "1084", latitude: 12.93, longitude: 77.61 });
}
