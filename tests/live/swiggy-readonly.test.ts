// LIVE: real calls to Swiggy's MCP servers — READ-ONLY tools only — mapped by
// the app's own parsers. Skipped unless SWIGGY_TOKEN (a Swiggy MCP bearer
// access token) is set; see docs/TESTING.md. Every tool name is checked
// against services.ts READ_TOOLS before the call goes out, so this suite can
// never place, book, pay, confirm or change a cart / address.
import { describe, expect, it } from "vitest";

import { mapToolResult } from "@/backend/agent/agent";
import { MUTATING_TOOLS, READ_TOOLS } from "@/backend/agent/services";
import {
  SWIGGY_DINEOUT_MCP_URL,
  SWIGGY_FOOD_MCP_URL,
  SWIGGY_IM_MCP_URL,
  SWIGGY_SCENES_MCP_URL,
} from "@/backend/config/env";
import { callTool, coerceToolPayload } from "@/backend/mcp/client";
import { mapDineoutSearch } from "@/backend/mcp/dineout-mcp";
import { mapFoodRestaurants } from "@/backend/mcp/food-mcp";
import { mapScenesEvents } from "@/backend/mcp/scenes-mcp";
import { mapAddressPage, mapProductsPayload } from "@/backend/mcp/swiggy-mcp";
import type { DomainService } from "@/shared/types";
import { runScript } from "../scripts/runScript";

const token = process.env.SWIGGY_TOKEN?.trim();
const BLR = { latitude: 12.9716, longitude: 77.5946 };
const URLS: Record<DomainService, string> = {
  instamart: SWIGGY_IM_MCP_URL,
  food: SWIGGY_FOOD_MCP_URL,
  dineout: SWIGGY_DINEOUT_MCP_URL,
  scenes: SWIGGY_SCENES_MCP_URL,
};

async function read(domain: DomainService, name: string, args: Record<string, unknown>) {
  if (!READ_TOOLS[domain].includes(name) || MUTATING_TOOLS[domain].includes(name)) {
    throw new Error(`refusing non-read tool ${domain}/${name} in the live suite`);
  }
  return coerceToolPayload(await callTool(URLS[domain], name, args, { token: token!, maxRetries: 1 }));
}

describe.skipIf(!token)("live Swiggy MCP (read-only)", () => {
  let addressId = "";

  it("instamart get_addresses → saved addresses (city centres resolved)", async () => {
    const page = mapAddressPage(await read("instamart", "get_addresses", {}));
    expect(page.addresses.length).toBeGreaterThan(0);
    addressId = (page.addresses.find((a) => a.city === "Bengaluru") ?? page.addresses[0]).id;
    expect(addressId).toBeTruthy();
  });

  it("instamart search_products → products with real photos + prices", async () => {
    const { products } = mapProductsPayload(await read("instamart", "search_products", { query: "toned milk", addressId }));
    expect(products.length).toBeGreaterThan(0);
    for (const p of products) {
      for (const v of p.variations) {
        expect(v.imageUrl).toMatch(/^https:\/\/media-assets\.swiggy\.com\//);
        expect(v.offerPrice).toBeGreaterThan(0);
      }
    }
  });

  it("instamart get_cart is readable (never modified)", async () => {
    const payload = await read("instamart", "get_cart", { addressId });
    expect(payload).toBeTypeOf("object");
  });

  it("food search_restaurants → restaurant cards", async () => {
    const r = mapFoodRestaurants(await read("food", "search_restaurants", { query: "biryani", addressId }));
    expect(Array.isArray(r)).toBe(true);
  });

  it("dineout search_restaurants_dineout → parsed text results", async () => {
    const res = mapDineoutSearch(await read("dineout", "search_restaurants_dineout", { query: "Koramangala", ...BLR }));
    expect(res.restaurants.length).toBeGreaterThan(0);
    expect(res.restaurants[0].id).toMatch(/^\d+$/);
  });

  it("scenes search_events → events, mapped to cards by the agent", async () => {
    const payload = await read("scenes", "search_events", { query: "comedy", ...BLR });
    const { events } = mapScenesEvents(payload, BLR);
    expect(Array.isArray(events)).toBe(true);
    const evs = mapToolResult({ bareTool: "search_events", query: "comedy", input: { query: "comedy" } }, payload, {
      addressId,
      ...BLR,
    } as never);
    expect(Array.isArray(evs)).toBe(true);
  });

  it("scripts/verify-scenes.ts live section (discover → search → details → shows)", async () => {
    const run = await runScript("verify-scenes", { exits: "always", env: { SWIGGY_TOKEN: token }, timeoutMs: 110_000 });
    const failed = run.checks.filter((c) => !c.ok).map((c) => c.label);
    expect(failed).toEqual([]);
    expect(run.lines.join("\n")).toMatch(/# LIVE \(read-only tools\)/);
    expect(run.exitCode ?? 0).toBe(0);
  });
});

describe.skipIf(!token)("live: the read-only guard itself", () => {
  it("refuses a mutating tool before any network call", async () => {
    await expect(read("instamart", "checkout", {})).rejects.toThrow(/refusing non-read tool/);
    await expect(read("dineout", "book_table", {})).rejects.toThrow(/refusing non-read tool/);
  });
});

describe("live suite configuration", () => {
  it(token ? "SWIGGY_TOKEN set — live checks ran" : "SWIGGY_TOKEN not set — live checks skipped", () => {
    expect(true).toBe(true);
  });
});
