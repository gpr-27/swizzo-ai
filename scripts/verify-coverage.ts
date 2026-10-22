// Endpoint coverage check — no network:
//   npx tsx --tsconfig tsconfig.json scripts/verify-coverage.ts
// 1. Every LIVE Swiggy MCP tool (tools/list, 2026-10-22 — 62 tools) is called
//    somewhere in src/ (as a quoted tool name), so nothing exposed is unused.
// 2. Every live tool is classified exactly once as READ or MUTATING in
//    services.ts, and no documented-but-not-live tool is classified.
// 3. The agent never gets a mutating tool; every agent tool is live + READ.
// 4. Each domain tab's agent exposes the read tools it should (all read tools
//    minus the deliberate exclusions listed below, with the reason).
// 5. Plan's tools are a subset of the four domains' agent tools.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { MUTATING_TOOLS, READ_TOOLS } from "@/backend/agent/services";
import { APP_COMPOSITE_TOOLS, buildServiceTools, PLAN_TOOLS } from "@/backend/agent/tools";
import { DOMAIN_SERVICES, type DomainService } from "@/shared/types";

// Live tools/list per server (verified 2026-10-22 against the connected servers).
const LIVE: Record<DomainService, string[]> = {
  food: [
    "search_restaurants", "get_restaurant_menu", "search_menu", "get_food_cart", "update_food_cart",
    "flush_food_cart", "fetch_food_coupons", "apply_food_coupon", "place_food_order", "get_payment_options",
    "check_payment_status", "confirm_order", "get_food_orders", "get_food_order_details", "track_food_order",
    "get_food_delivery_status", "get_addresses", "create_address", "delete_address", "report_error",
  ],
  instamart: [
    "search_products", "your_go_to_items", "get_cart", "update_cart", "clear_cart", "checkout",
    "get_payment_options", "check_payment_status", "confirm_order", "get_orders", "track_order",
    "get_delivery_status", "get_addresses", "create_address", "delete_address", "report_error",
  ],
  dineout: [
    "search_restaurants_dineout", "render_restaurants_dineout", "get_restaurant_details", "get_available_slots",
    "create_cart", "book_table", "get_payment_options", "check_payment_status", "confirm_order",
    "get_booking_status", "report_error",
  ],
  scenes: [
    "discover_events", "get_events_collection", "search_events", "get_event_details", "list_event_shows",
    "get_event_venue_info", "get_saved_locations", "create_event_cart", "get_event_cart", "place_event_order",
    "get_payment_options", "check_payment_status", "confirm_order", "get_event_booking_status", "report_error",
  ],
};

// Documented but NOT in the live tools/list — must not be called as live tools.
const NOT_LIVE: Record<DomainService, string[]> = {
  food: ["recommend_address"],
  instamart: ["list_coupons", "apply_coupon", "get_order_details", "recommend_address"],
  dineout: ["cancel_booking"], // probed at runtime with hasTool(); used only if Swiggy enables it
  scenes: [],
};

// Read tools a tab's agent deliberately does NOT get, and why.
const AGENT_EXCLUDED: Record<DomainService, Record<string, string>> = {
  food: {
    get_addresses: "address comes from the app context (AddressPicker)",
    get_payment_options: "renders the payment picker — the checkout UI calls it",
    check_payment_status: "the PaymentModal polls it; never in a model loop",
  },
  instamart: {
    get_addresses: "address comes from the app context (AddressPicker)",
    check_payment_status: "the PaymentModal polls it; never in a model loop",
  },
  dineout: {
    render_restaurants_dineout: "run for the model automatically after every search (photo cards)",
    get_payment_options: "the slot picker calls it for paid deals",
    check_payment_status: "the PaymentModal polls it",
  },
  scenes: {
    get_event_cart: "Swiggy: 'the normal flow does not call this' — create_event_cart returns the summary",
    get_payment_options: "the ticket picker calls it with the cartKey",
    check_payment_status: "the PaymentModal polls it",
  },
};

let passes = 0;
let failures = 0;
function check(name: string, ok: boolean, extra?: unknown) {
  if (ok) passes++;
  else failures++;
  console.log(`  ${ok ? "✓" : "✗"} ${name}${ok || extra === undefined ? "" : ` ${JSON.stringify(extra)}`}`);
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}

const root = join(__dirname, "..");
const sources = walk(join(root, "src")).map((p) => ({ p, text: readFileSync(p, "utf8") }));
// Places that only LIST names (registries) don't count as "implemented".
const REGISTRY = /src\/backend\/agent\/services\.ts$/;

console.log("\n1. Every live tool is called somewhere in src/ (outside the services.ts registry)");
const total = DOMAIN_SERVICES.reduce((n, d) => n + LIVE[d].length, 0);
check(`live inventory is 62 tools (got ${total})`, total === 62);
const allNames = new Set(DOMAIN_SERVICES.flatMap((d) => LIVE[d]));
for (const name of [...allNames].sort()) {
  const re = new RegExp(`["'\`]${name}["'\`]|\\b${name}:\\s*tool\\(`);
  const hits = sources.filter((s) => !REGISTRY.test(s.p) && re.test(s.text)).map((s) => s.p.replace(`${root}/`, ""));
  check(`${name} → ${hits.length ? hits.slice(0, 3).join(", ") + (hits.length > 3 ? ` +${hits.length - 3}` : "") : "NOT FOUND"}`, hits.length > 0);
}

console.log("\n2. READ / MUTATING classification matches the live inventory");
for (const d of DOMAIN_SERVICES) {
  const read = new Set(READ_TOOLS[d]);
  const mut = new Set(MUTATING_TOOLS[d]);
  const both = [...read].filter((t) => mut.has(t));
  const missing = LIVE[d].filter((t) => !read.has(t) && !mut.has(t));
  const extra = [...read, ...mut].filter((t) => !LIVE[d].includes(t));
  const notLive = [...read, ...mut].filter((t) => NOT_LIVE[d].includes(t));
  check(`${d}: no tool is both READ and MUTATING`, both.length === 0, both);
  check(`${d}: every live tool classified`, missing.length === 0, missing);
  check(`${d}: nothing classified that isn't live`, extra.length === 0 && notLive.length === 0, [...extra, ...notLive]);
}

console.log("\n3/4. Agent tools: live READ only, and every read tool is exposed or deliberately excluded");
const noop = async () => "";
for (const d of DOMAIN_SERVICES) {
  const agent = Object.keys(buildServiceTools(d, noop));
  const mutatingInAgent = agent.filter((t) => MUTATING_TOOLS[d].includes(t));
  // App composites (e.g. Instamart build_basket) count when every part is a live READ tool.
  const composite = APP_COMPOSITE_TOOLS[d] ?? {};
  const notRead = agent.filter((t) => !READ_TOOLS[d].includes(t) && !(t in composite));
  const badComposite = Object.entries(composite).flatMap(([t, parts]) =>
    parts.filter((p) => !READ_TOOLS[d].includes(p) || MUTATING_TOOLS[d].includes(p)).map((p) => `${t}→${p}`),
  );
  check(`${d}: agent has no mutating tool`, mutatingInAgent.length === 0, mutatingInAgent);
  check(`${d}: every agent tool is a live READ tool (or a composite of them)`, notRead.length === 0, notRead);
  check(`${d}: app composites use only live READ tools`, badComposite.length === 0, badComposite);
  const gaps = READ_TOOLS[d].filter((t) => !agent.includes(t) && !(t in AGENT_EXCLUDED[d]));
  check(`${d}: agent covers all read tools (${agent.length} exposed, ${Object.keys(AGENT_EXCLUDED[d]).length} excluded on purpose)`, gaps.length === 0, gaps);
  const staleExclusions = Object.keys(AGENT_EXCLUDED[d]).filter((t) => agent.includes(t));
  check(`${d}: exclusion list is current`, staleExclusions.length === 0, staleExclusions);
}

console.log("\n5. Plan = a subset of the domain agents' read tools");
const plan = Object.keys(buildServiceTools("plan", noop));
for (const d of DOMAIN_SERVICES) {
  const own = Object.keys(buildServiceTools(d, noop));
  const bad = PLAN_TOOLS[d].filter((t) => !own.includes(t) || !READ_TOOLS[d].includes(t));
  check(`plan/${d}: ${PLAN_TOOLS[d].join(", ")}`, bad.length === 0, bad);
}
check(`plan exposes ${plan.length} tools across all four domains`, DOMAIN_SERVICES.every((d) => PLAN_TOOLS[d].length > 0));

console.log(`\n${failures === 0 ? "PASS" : "FAIL"}: ${passes} passed, ${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
