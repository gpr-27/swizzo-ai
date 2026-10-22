// Shared E2E helpers: recorded live payloads for the shell, and a network
// guard that fails the test if any state-changing app route is requested.
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { expect, type Page, type Route } from "@playwright/test";

import { cityPointFor } from "../../src/shared/cityCoords";

const ROOT = join(__dirname, "..", "..");

/** The live get_addresses capture (redacted), as /api/addresses returns it. */
export function liveAddresses() {
  const cap = JSON.parse(readFileSync(join(ROOT, "docs/swiggy-mcp/live/im_get_addresses.json"), "utf8")) as {
    structuredContent: { addresses: { id: string; addressLine: string; addressTag: string; addressCategory: string; phoneNumber: string }[]; resolution: unknown };
  };
  // city centres attached exactly as the server does (shared/cityCoords)
  return {
    addresses: cap.structuredContent.addresses.map((a) => {
      const p = cityPointFor(a.addressLine);
      return p ? { ...a, latitude: p.latitude, longitude: p.longitude, city: p.city } : a;
    }),
    resolution: cap.structuredContent.resolution,
  };
}

/** App routes that change real-world state (orders, bookings, carts, payments, addresses). */
export const MUTATING = [
  /\/api\/checkout\b/,
  /\/api\/orders(\/|$|\?)/,
  /\/api\/dineout\/(book|cart)\b/,
  /\/api\/scenes\/(cart|order)\b/,
  /\/api\/payments\/confirm\b/,
  /\/api\/addresses\/create\b/,
  /\/api\/instamart\/basket\b/,
];
const WRITE_ON_GET_OK = new Set(["GET", "HEAD"]);
const CART_ROUTES = [/\/api\/cart\b/, /\/api\/food-cart\b/];

/**
 * Blocks (and records) every request that could change Swiggy state. Cart
 * reads (GET) are allowed; cart writes are not.
 */
export async function guardMutations(page: Page): Promise<{ blocked: string[] }> {
  const blocked: string[] = [];
  await page.route("**/api/**", async (route: Route) => {
    const r = route.request();
    const url = r.url();
    const write = !WRITE_ON_GET_OK.has(r.method());
    if (MUTATING.some((re) => re.test(url)) || (write && CART_ROUTES.some((re) => re.test(url)))) {
      blocked.push(`${r.method()} ${new URL(url).pathname}`);
      return route.abort("blockedbyclient");
    }
    return route.fallback();
  });
  return { blocked };
}

export function expectNoMutations(guard: { blocked: string[] }) {
  expect(guard.blocked, "state-changing requests were attempted").toEqual([]);
}
