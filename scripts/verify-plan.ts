// Verifies the Plan tab + strict domain isolation without any network calls:
//   npx tsx --tsconfig tsconfig.json scripts/verify-plan.ts
// 1. ITINERARY / PLAN TITLE / HANDOFF marker parsing
// 2. Plan tool routing: every plan tool resolves to its owning server's URL
// 3. Domain tabs can only reach their own server
// 4. Server-side card guard (eventAllowedFor) + emitAssistantText end to end
// 5. scopeContext + DOMAIN LOCK in every prompt

import { emitAssistantText } from "@/backend/agent/agent";
import { extractPlanMarkers } from "@/backend/agent/plan-markers";
import { eventAllowedFor, resolveToolDomain, resolveToolServerUrl } from "@/backend/agent/runner";
import {
  buildServicePrompt,
  MCP_SERVERS,
  MUTATING_TOOLS,
  READ_TOOLS,
  scopeContext,
  type PromptContext,
} from "@/backend/agent/services";
import { APP_COMPOSITE_TOOLS, buildServiceTools, PLAN_TOOLS } from "@/backend/agent/tools";
import {
  DOMAIN_SERVICES,
  SERVICES,
  type ActivePicker,
  type ChatMessage,
  type ChatStreamEvent,
  type DomainService,
  type Service,
} from "@/shared/types";

let failures = 0;
let passes = 0;
function check(name: string, ok: boolean, extra?: unknown) {
  if (ok) {
    passes++;
    console.log(`  ✓ ${name}`);
  } else {
    failures++;
    console.log(`  ✗ ${name}`, extra ?? "");
  }
}

/* ------------------------------ 1. markers ------------------------------- */
console.log("\n1. ITINERARY / HANDOFF parsing");
const planReply = `**PLAN TITLE:** Family Saturday at Phoenix
ITINERARY: 4:00 PM | other | Wander Phoenix Marketcity | Kids' play zone + window shopping | -
ITINERARY: 6:30 PM | scenes | Kids magic show | Phoenix Marketcity · ₹499 | ev_12345
- ITINERARY: 8:00 PM | dineout | Dinner at Toit | Brewery, family seating · ₹1800 for two | 98765
ITINERARY: 9:45 PM | instamart | Snacks for the ride home | Lay's + juice | SPIN_AB12
ITINERARY: 10:30 PM | food | Dessert delivered home | Death by Chocolate · ₹290 | 118762340
ITINERARY: 11:00 PM | dining | (alias check) | detail | n/a
ITINERARY: no pipes here so ignored
BEST: ev_12345 — fits the 6:30 slot
Here's a relaxed Saturday that keeps the kids happy 🎈
SUGGESTIONS: Cheaper dinner | Later show | Add dessert`;

const pm = extractPlanMarkers(planReply, "plan");
check("title parsed (bold marker tolerated)", pm.itinerary?.title === "Family Saturday at Phoenix", pm.itinerary?.title);
check("6 steps parsed", pm.itinerary?.steps.length === 6, pm.itinerary?.steps.length);
const st = pm.itinerary?.steps ?? [];
check("step 1 is 'other' with no ref", st[0]?.domain === "other" && st[0]?.ref === undefined, st[0]);
check("scenes step keeps time + ref", st[1]?.domain === "scenes" && st[1]?.time === "6:30 PM" && st[1]?.ref === "ev_12345", st[1]);
check("bulleted dineout line parsed", st[2]?.domain === "dineout" && st[2]?.ref === "98765", st[2]);
check("instamart ref", st[3]?.domain === "instamart" && st[3]?.ref === "SPIN_AB12", st[3]);
check("food ref", st[4]?.domain === "food" && st[4]?.ref === "118762340", st[4]);
check("alias 'dining' → dineout, 'n/a' ref dropped", st[5]?.domain === "dineout" && st[5]?.ref === undefined, st[5]);
check("marker lines stripped from prose", !/ITINERARY|PLAN TITLE/.test(pm.rest) && pm.rest.includes("BEST: ev_12345"), pm.rest);

const ho = extractPlanMarkers(
  "Biryani delivery lives in the Food tab 🍛\nHANDOFF: food | chicken biryani delivered home\nHANDOFF: scenes | x\nSUGGESTIONS: a | b | c",
  "scenes",
);
check("handoff to food parsed", ho.handoffs.length === 1 && ho.handoffs[0].service === "food" && ho.handoffs[0].query === "chicken biryani delivered home", ho.handoffs);
check("self-handoff (scenes→scenes) dropped", !ho.handoffs.some((h) => h.service === "scenes"));
check("handoff label names the tab", ho.handoffs[0]?.label === "Open in Food", ho.handoffs[0]?.label);
check("handoff to plan accepted", extractPlanMarkers("HANDOFF: plan | movie + dinner + snacks", "food").handoffs[0]?.service === "plan");

async function main() {
/* --------------------------- 2. plan tool routing ------------------------- */
console.log("\n2. Plan tool routing (each tool → its own server URL)");
const calls: { tool: string; server?: DomainService }[] = [];
const planTools = buildServiceTools("plan", async (tool, _args, server) => {
  calls.push({ tool, server });
  return "ok";
});
const expected = new Map<string, DomainService>();
for (const d of DOMAIN_SERVICES) for (const t of PLAN_TOOLS[d]) {
  check(`${t} is unique across servers`, !expected.has(t), expected.get(t));
  expected.set(t, d);
}
check("plan exposes exactly PLAN_TOOLS", Object.keys(planTools).sort().join() === [...expected.keys()].sort().join(), Object.keys(planTools));
const dummyArgs: Record<string, Record<string, unknown>> = {
  get_events_collection: { collectionIdentifier: "c1" },
  search_events: { query: "x" },
  get_event_details: { eventId: "e1" },
  search_restaurants_dineout: { query: "x" },
  get_restaurant_details: { restaurantId: "r1" },
  search_menu: { query: "x" },
  search_restaurants: { query: "x" },
  get_restaurant_menu: { restaurantId: "r1" },
  search_products: { query: "x" },
};
for (const [name, def] of Object.entries(planTools)) {
  calls.length = 0;
  await def.execute!((dummyArgs[name] ?? {}) as never, { toolCallId: "t", messages: [] } as never);
  const want = expected.get(name)!;
  const got = calls[0]?.server;
  const url = got ? resolveToolServerUrl("plan", got) : "";
  check(
    `${name.padEnd(28)} → ${want.padEnd(9)} ${MCP_SERVERS[want].url}`,
    calls.length === 1 && calls[0].tool === name && got === want && url === MCP_SERVERS[want].url,
    calls,
  );
  check(`${name} is a READ tool of ${want}`, READ_TOOLS[want].includes(name));
  check(`${name} is not mutating anywhere`, !DOMAIN_SERVICES.some((d) => MUTATING_TOOLS[d].includes(name)));
}
const urls = new Set(DOMAIN_SERVICES.map((d) => MCP_SERVERS[d].url));
check("the four servers have four distinct URLs", urls.size === 4, [...urls]);

/* ------------------------- 3. domain tab isolation ------------------------ */
console.log("\n3. Domain tabs reach only their own server");
for (const d of DOMAIN_SERVICES) {
  const seen: (DomainService | undefined)[] = [];
  const tools = buildServiceTools(d, async (_t, _a, server) => {
    seen.push(server);
    return "ok";
  });
  for (const def of Object.values(tools)) {
    await def.execute!({ query: "x", orderId: "o", restaurantId: "r", eventId: "e", venueId: "v", collectionIdentifier: "c" } as never, { toolCallId: "t", messages: [] } as never);
  }
  check(`${d}: every tool resolves to ${d}`, seen.every((s) => resolveToolDomain(d, s) === d), seen);
  const foreign = DOMAIN_SERVICES.filter((x) => x !== d);
  check(
    `${d}: a foreign server is refused`,
    foreign.every((f) => {
      try {
        resolveToolDomain(d, f);
        return false;
      } catch {
        return true;
      }
    }),
  );
  const planOnly = Object.keys(tools).filter((t) => !READ_TOOLS[d].includes(t) && !(t in (APP_COMPOSITE_TOOLS[d] ?? {})));
  check(`${d}: only its own read tools`, planOnly.length === 0, planOnly);
}
let planNoServer = false;
try {
  resolveToolDomain("plan");
} catch {
  planNoServer = true;
}
check("plan call without a server is refused", planNoServer);

/* ------------------------------ 4. card guard ----------------------------- */
console.log("\n4. Server-side card guard");
const sample: Record<string, ChatStreamEvent> = {
  products: { type: "products", query: "chips", products: [], nextOffset: null },
  ingredients: { type: "ingredients", dish: "", items: ["chips"] },
  menu: { type: "menu", restaurantId: "r", restaurantName: "R", categories: [] },
  dishQuery: { type: "dishQuery", query: "biryani" },
  dineoutRestaurants: { type: "dineoutRestaurants", restaurants: [] },
  scenesEvents: { type: "scenesEvents", events: [] },
  addFood: {
    type: "addToCart",
    target: "food",
    quantity: 1,
    restaurantId: "r",
    restaurantName: "R",
    line: { menuItemId: "m", name: "Dish", veg: true, price: 100 },
  } as ChatStreamEvent,
  removeIm: { type: "removeFromCart", target: "instamart", id: "s" },
  itinerary: { type: "itinerary", steps: [{ domain: "scenes", title: "Show" }] },
  handoff: { type: "handoff", service: "food", query: "biryani" },
  chips: { type: "chips", items: ["a"] },
};
const owner: Record<string, Service | "all" | "cart"> = {
  products: "instamart",
  ingredients: "instamart",
  menu: "food",
  dishQuery: "food",
  dineoutRestaurants: "dineout",
  scenesEvents: "scenes",
  addFood: "food",
  removeIm: "cart",
  itinerary: "plan",
  handoff: "all",
  chips: "all",
};
for (const svc of SERVICES) {
  const wrong: string[] = [];
  for (const [k, ev] of Object.entries(sample)) {
    const o = owner[k];
    const want =
      o === "all"
        ? true
        : o === "cart"
          ? svc === "instamart"
          : o === "plan"
            ? svc === "plan"
            : svc === "plan" || svc === o;
    if (eventAllowedFor(svc, ev) !== want) wrong.push(`${k}=${!want}`);
  }
  check(`${svc}: allowed/dropped matrix`, wrong.length === 0, wrong);
}

// End to end: marker parsing → events, filtered the way runner.ts filters them.
const run = (svc: Service, text: string) =>
  [...emitAssistantText(text, svc, new Map(), new Map(), "")].filter((ev) => eventAllowedFor(svc, ev));
const planEvents = run("plan", planReply);
const itEv = planEvents.find((e) => e.type === "itinerary");
check("plan reply → itinerary event with 6 steps", itEv?.type === "itinerary" && itEv.steps.length === 6);
check("plan reply → bestPick for the event", planEvents.some((e) => e.type === "bestPick" && e.id === "ev_12345"));
check("plan reply prose has no marker text", planEvents.filter((e) => e.type === "text").every((e) => e.type === "text" && !/ITINERARY|BEST:/.test(e.delta)));
const scenesEvents = run("scenes", planReply + "\nDISHES: biryani\nINGREDIENTS: chips | juice\nHANDOFF: food | biryani");
check("ITINERARY in a domain tab → dropped", !scenesEvents.some((e) => e.type === "itinerary"));
check("DISHES/INGREDIENTS in scenes → dropped", !scenesEvents.some((e) => e.type === "dishQuery" || e.type === "ingredients"));
check("HANDOFF in scenes → handoff event", scenesEvents.some((e) => e.type === "handoff" && e.service === "food"));
const instaEvents = run("instamart", "REMOVE: SPIN1\nDISHES: biryani\nSUGGESTIONS: a | b | c");
check("instamart keeps its own REMOVE, drops DISHES", instaEvents.some((e) => e.type === "removeFromCart") && !instaEvents.some((e) => e.type === "dishQuery"));
check("plan never REMOVEs from a cart", !run("plan", "REMOVE: SPIN1").some((e) => e.type === "removeFromCart"));

/* ------------------------ 5. context + prompt guards ---------------------- */
console.log("\n5. Context scoping + prompts");
const ctx: PromptContext = {
  addressLine: "HSR Layout",
  addressId: "a1",
  latitude: 12.9,
  longitude: 77.6,
  budget: 3000,
  kcalGoal: 2000,
  catalog: {
    products: [{ spinId: "S1", productId: "p", name: "Chips", brand: "", quantityDescription: "", imageUrl: "", unitPrice: 20, mrp: 20, inStock: true }],
    dishes: [{ restaurantId: "r", restaurantName: "R", line: { menuItemId: "m", name: "Dish", imageUrl: "", veg: true, price: 100 } }],
  },
  cartLines: [{ id: "S1", name: "Chips", quantity: 1 }],
};
const sc = scopeContext("scenes", ctx);
check("scenes: no catalog / cart / kcal", !sc.catalog && !sc.cartLines && !sc.kcalGoal && sc.budget === 3000);
const im = scopeContext("instamart", ctx);
check("instamart: products only + its cart", !!im.catalog?.products && !im.catalog?.dishes && !!im.cartLines);
const fd = scopeContext("food", ctx);
check("food: dishes only", !!fd.catalog?.dishes && !fd.catalog?.products);
const pl = scopeContext("plan", ctx);
check("plan: thread catalog, no cart, no kcal", !!pl.catalog?.products && !!pl.catalog?.dishes && !pl.cartLines && !pl.kcalGoal);
for (const d of DOMAIN_SERVICES) {
  const p = buildServicePrompt(d, scopeContext(d, ctx));
  check(`${d} prompt carries the DOMAIN LOCK + HANDOFF`, p.includes("DOMAIN LOCK") && p.includes("HANDOFF:"));
}
const pp = buildServicePrompt("plan", pl);
check("plan prompt: ITINERARY + never books", pp.includes("ITINERARY:") && /NEVER book/.test(pp));
check("dineout/scenes prompts have no cart/INGREDIENTS rules", !/INGREDIENTS:|CART ANALYSIS/.test(buildServicePrompt("scenes", sc)) && !/INGREDIENTS:|CART ANALYSIS/.test(buildServicePrompt("dineout", scopeContext("dineout", ctx))));


// 6. Plan autonomy: one sentence → full plan; Food dish ADD → Approve proposal; step buttons pre-fill.
check("plan prompt: no question when defaults can be inferred", /ONE SENTENCE IS ENOUGH/.test(pp) && /ALL FOUR services/.test(pp));
check("plan prompt: Food dish ADD + dated scenes/dineout details", pp.includes("ADD: <dish id>") && /DATE/.test(pp));
check("plan prompt: still never books", /NEVER book, pay or order/.test(pp));
const foodById = new Map([
  ["DISH9", { restaurantId: "R1", restaurantName: "Punjabi Dhaba", line: { menuItemId: "DISH9", name: "Chicken rice", imageUrl: "", veg: false, price: 109 } }],
]);
const planAdd = [...emitAssistantText("ITINERARY: 9:30 PM | food | Dinner home | Chicken rice | DISH9\nADD: DISH9 x2", "plan", new Map(), foodById as never, "")].filter((ev) => eventAllowedFor("plan", ev));
check(
  "plan food ADD → food addToCart proposal event (x2)",
  planAdd.some((e) => e.type === "addToCart" && e.target === "food" && e.quantity === 2),
  planAdd.map((e) => e.type),
);
{
  const { pendingFor, nextStepIndex } = await import("@/frontend/components/chat/ItineraryCard");
  const msg = {
    id: "m1",
    role: "assistant" as const,
    text: "",
    createdAt: 0,
    proposals: [
      { pid: "m1:p1", status: "pending" as const, kind: "add" as const, name: "Chicken rice", target: "food" as const },
      { pid: "m1:p2", status: "pending" as const, kind: "add" as const, name: "Lays", target: "instamart" as const },
      { pid: "m1:p3", status: "approved" as const, kind: "add" as const, name: "Coke", target: "instamart" as const },
    ],
  };
  check("pendingFor(food) = only the pending food pick", pendingFor(msg, "food").map((p) => p.pid).join() === "m1:p1");
  check("pendingFor(instamart) skips approved", pendingFor(msg, "instamart").map((p) => p.pid).join() === "m1:p2");
  const steps = [{ domain: "other" as const }, { domain: "scenes" as const }, { domain: "dineout" as const }];
  check("next step skips 'other' stops", nextStepIndex(steps, new Set()) === 1);
  check("next step advances past done steps", nextStepIndex(steps, new Set([1])) === 2);
  check("next step = -1 when all done", nextStepIndex(steps, new Set([1, 2])) === -1);
}

await verifyRun();
await verifyLiveFixes();

console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
}

/* ---------------------- 7. live plan: PLAN INFO + run --------------------- */
async function verifyRun() {
  console.log("\n7. PLAN INFO + live plan run state machine (no network, no Swiggy calls)");
  const info = extractPlanMarkers(
    "PLAN TITLE: Comedy night\nPLAN INFO: Sat 25 Oct | 2 adults + 2 kids | ₹5,000\nITINERARY: 7 PM | scenes | Show | x | ev1",
    "plan",
  ).itinerary;
  check("PLAN INFO → date / party (summed) / budget", info?.date === "Sat 25 Oct" && info?.party === 4 && info?.budget === 5000, info);
  check("PLAN INFO stripped, '-' budget left out", extractPlanMarkers("PLAN INFO: tonight | 2 people | -\nITINERARY: 7 PM | scenes | S | d | ev1").itinerary?.budget === undefined);

  const R = await import("@/frontend/plan/planRun");
  const bridge = await import("@/frontend/utils/pickerBridge");
  check("run commands recognised", ["go ahead", "Do it!", "ok, run the plan for me", "Run the plan for me"].every(R.isRunCommand));
  check("ordinary asks are not run commands", !["go ahead and find cheaper dinner", "do it tomorrow?", "plan a date"].some(R.isRunCommand));

  const T0 = 1_800_000_000_000;
  let now = T0;
  const it = {
    title: "Comedy night",
    date: "Sat 25 Oct",
    party: 2,
    budget: 3000,
    steps: [
      { time: "6:00 PM", domain: "other" as const, title: "Walk around Forum" },
      { time: "7:00 PM", domain: "scenes" as const, title: "Standup show", ref: "ev1" },
      { time: "9:00 PM", domain: "dineout" as const, title: "Dinner at Ganbeii", ref: "r1" },
      { time: "10:30 PM", domain: "food" as const, title: "Dessert home", ref: "d1" },
    ],
  };
  const planMsg: ChatMessage = {
    id: "plan1",
    role: "assistant",
    text: "",
    createdAt: T0,
    itinerary: it,
    scenesEvents: [{ id: "ev1", title: "Standup Saturday", venueName: "Comedy Club", area: "Koramangala", priceText: "₹499" }],
    dineoutRestaurants: [
      { id: "r1", name: "Ganbeii", cuisines: [], bookable: true, distance: "1.2 km", costForTwo: "₹1200 for two" },
      { id: "r2", name: "Toit", cuisines: [], bookable: true },
    ],
    proposals: [{ pid: "plan1:p1", status: "pending", kind: "add", name: "Brownie", detail: "₹180", target: "food" }],
  };
  let messages: ChatMessage[] = [planMsg];
  const snaps = new Map<string, ActivePicker>();
  let sending = false;
  let run = R.adoptItinerary(R.emptyRun(), undefined, planMsg, now);
  const view = () =>
    R.derivePlan({ messages, run, snapshot: (id) => snaps.get(id) ?? null, sending, now, foodCart: { items: [], toPay: 0 } })!;
  const decide = () => R.decideNext(view(), run, { sending, now });
  const seen: string[] = [];
  const step = () => {
    const a = decide();
    seen.push(a.type);
    return a;
  };

  check("plan adopted + 'Built …' log line", run.planIds[0] === "plan1" && /Built “Comedy night”/.test(run.log[0]?.text ?? ""), run.log);
  check("header facts from PLAN INFO", view().date === "Sat 25 Oct" && view().party === 2 && view().budget === 3000);
  check("idle run never acts", step().type === "none");
  run = { ...run, mode: "running" };
  let a = step();
  check("running → opens the Scenes picker first ('other' stop skipped)", a.type === "open" && a.index === 1, a);
  run = R.markActed(run, 1, "open", "ev1", now);
  check("after open → searching, no repeat action", view().steps[1].status === "searching" && step().type === "none");
  // the picker message loads + the AI pre-fills (real snapshot shape)
  messages = [...messages, { id: "sc1", role: "assistant", text: "The 7 PM show fits right before dinner. More detail.", createdAt: now + 1, scenesShows: { eventId: "ev1", eventTitle: "Standup Saturday", shows: [] } }];
  snaps.set("sc1", {
    kind: "scenes",
    messageId: "sc1",
    eventId: "ev1",
    eventTitle: "Standup Saturday",
    dates: [{ date: "2027-01-16", label: "Sat 16 Jan", shows: [{ showId: "s1", timeLabel: "7:00 pm" }] }],
    tickets: [{ name: "Silver", price: 499 }],
    selection: { date: "2027-01-16", showId: "s1", timeLabel: "7:00 pm", ticketName: "Silver", qty: 2 },
  });
  let v = view();
  check("picked show → waiting for confirm with the live pick (never the model's prose)", v.steps[1].status === "confirm" && /Silver/.test(v.steps[1].pick?.title ?? "") && !/7 PM show fits/.test(v.steps[1].pick?.why ?? ""), v.steps[1]);
  check("lined-up budget = real ticket price × qty", v.lined === 998, v.lined);
  check("STOPS at the irreversible ticket step (wait)", step().type === "wait");
  run = R.logTransitions(run, v, now);
  check("log says it is waiting for you", run.log.some((l) => /Waiting for you/.test(l.text)), run.log.map((l) => l.text));
  // the user confirms in the picker → Swiggy's tracker card
  messages = [...messages, { id: "sc-book-O1", role: "assistant", text: "", createdAt: now + 2, bookingTracker: { kind: "scenes", title: "Silver · Standup Saturday", status: "CONFIRMED", details: "", orderId: "O1", amount: 998 } }];
  snaps.delete("sc1");
  v = view();
  check("booked after the user's confirm (order id + spent)", v.steps[1].status === "booked" && v.steps[1].booking?.orderId === "O1" && v.spent === 998, v.steps[1]);
  run = { ...run, lastDineoutAt: now - 1000 };
  check("Dineout searches are spaced (rate limit)", step().type === "none");
  now += 10_000;
  a = step();
  check("continues by itself → opens the Dineout picker", a.type === "open" && a.index === 2, a);
  run = R.markActed(run, 2, "open", "r1", now);
  // walk-in only (slot load came back without a picker)
  messages = [
    ...messages,
    { id: "do-slots-u-5", role: "user", text: "Show table slots at Ganbeii", createdAt: now + 1 },
    { id: "do-slots-5", role: "assistant", text: "**Ganbeii** is listed on Swiggy Dineout but isn't taking table bookings there (walk-in only).", createdAt: now + 1 },
  ];
  v = view();
  check("walk-in only → failed with Swiggy's reason", v.steps[2].status === "failed" && /walk-in only/.test(v.steps[2].reason ?? ""), v.steps[2]);
  a = step();
  check("failure → automatic replan of that step", a.type === "replan" && a.index === 2, a);
  run = R.markFailed(R.markActed(run, 2, "replan", "r1", now), 2, "r1", "walk-in only");
  const rp = R.replanPrompt(2, it.steps[2], "walk-in only");
  check("replan prompt is read-only + keeps other steps", /Never book/.test(rp.text) && /Keep every other step/.test(rp.text) && /TAKES TABLE BOOKINGS/.test(rp.text));
  sending = true;
  check("while replanning → searching", view().steps[2].status === "searching" && step().type === "none");
  // the planner re-emits the plan with Toit for step 3
  const plan2: ChatMessage = { ...planMsg, id: "plan2", createdAt: now + 5, proposals: undefined, itinerary: { ...it, steps: it.steps.map((s, i) => (i === 2 ? { ...s, title: "Dinner at Toit", ref: "r2" } : s)) } };
  messages = [...messages, plan2];
  sending = false;
  run = R.adoptItinerary(run, it, plan2, now);
  v = view();
  check("replanned step shown as replaced (with reason) and planned again", v.steps[2].status === "planned" && v.steps[2].name === "Toit" && v.steps[2].replacedFrom?.from === "Dinner at Ganbeii", v.steps[2]);
  check("plan-updated log line", run.log.some((l) => /Plan updated — step 3: Dinner at Ganbeii → Dinner at Toit/.test(l.text)));
  check("earlier booking kept across the replan", v.steps[1].status === "booked");
  now += 10_000;
  a = step();
  check("opens the replacement restaurant", a.type === "open" && a.index === 2, a);
  // second failure on the same step → pause (no endless replans)
  run = R.markFailed(R.markActed(run, 2, "replan", "r2", now), 2, "r2", "no slots");
  messages = [...messages, { id: "late", role: "assistant", text: "ok", createdAt: now + 1 }];
  a = step();
  check("second failure → pause for the user", a.type === "pause", a);
  // Dineout busy → retry the same picker later, never a replan (no extra search)
  {
    const busyRun = { ...R.emptyRun(), planIds: ["plan1"], mode: "running" as const, startedAt: T0, acted: { "2": { kind: "open" as const, at: now, ref: "r1" } } };
    const busyMsgs: ChatMessage[] = [
      planMsg,
      { id: "sc-book-O1", role: "assistant", text: "", createdAt: T0 + 1, bookingTracker: { kind: "scenes", title: "Standup Saturday", status: "CONFIRMED", details: "", orderId: "O1" } },
      { id: "do-slots-u-9", role: "user", text: "Show table slots at Ganbeii", createdAt: now + 1 },
      { id: "do-slots-9", role: "assistant", text: "Dineout is busy right now — please try again in a minute.", createdAt: now + 2 },
    ];
    const bv = (t: number) => R.derivePlan({ messages: busyMsgs, run: busyRun, snapshot: () => null, now: t })!;
    check("busy → failed (busy)", bv(now).steps[2].status === "failed" && R.isBusy(bv(now).steps[2].reason));
    check("busy → waits before retrying", R.decideNext(bv(now + 5000), busyRun, { sending: false, now: now + 5000 }).type === "none");
    check("busy → retries the same picker after 30 s", R.decideNext(bv(now + 31_000), busyRun, { sending: false, now: now + 31_000 }).type === "retry");
  }
  // Food: pending proposal → wait; approved → added → finish
  {
    const fr = { ...R.emptyRun(), planIds: ["plan1"], mode: "running" as const, startedAt: T0, skipped: [1, 2] };
    const fv = (msgs: ChatMessage[]) => R.derivePlan({ messages: msgs, run: fr, snapshot: () => null, now, foodCart: { items: [{ menuItemId: "d1", name: "Brownie", quantity: 1 }], toPay: 210 } })!;
    let f = fv([planMsg]);
    check("skipped steps are passed; food proposal → wait for the user's Add", f.steps[3].status === "confirm" && f.steps[3].confirm?.kind === "proposals" && R.decideNext(f, fr, { sending: false, now }).type === "wait", f.steps[3]);
    f = fv([{ ...planMsg, proposals: [{ ...planMsg.proposals![0], status: "approved" }] }]);
    check("approved → added to the Food cart (real to-pay)", f.steps[3].status === "booked" && f.lined === 210, f.steps[3]);
    check("all handled → finish", R.decideNext(f, fr, { sending: false, now }).type === "finish");
  }
  // Ask: a food step with no proposals asks the planner (read-only), never adds
  {
    const ar = { ...R.emptyRun(), planIds: ["plan1"], mode: "running" as const, startedAt: T0, skipped: [1, 2] };
    const noProp = { ...planMsg, proposals: undefined };
    const av = R.derivePlan({ messages: [noProp], run: ar, snapshot: () => null, now })!;
    check("no food pick yet → ask the planner", R.decideNext(av, ar, { sending: false, now }).type === "ask");
    check("…but never while a turn is streaming", R.decideNext(av, ar, { sending: true, now }).type === "none");
    check("ask prompt is a proposal, not an add", /ADD: line \(I'll approve it\)/.test(R.askPrompt(it.steps[3]).text));
  }
  const allowed = new Set(["none", "open", "retry", "ask", "replan", "wait", "pause", "finish"]);
  check("the run only ever opens / asks / replans / waits (no mutating move)", seen.every((t) => allowed.has(t)), seen);
  const revived = R.reviveRun(JSON.parse(JSON.stringify({ ...run, mode: "running" })));
  check("after a reload a running plan comes back PAUSED", revived.mode === "paused" && /reload/.test(revived.note ?? ""));
  bridge.setAutoCartHold(true);
  check("picker auto-cart hold on while running", bridge.autoCartHeld());
  bridge.setAutoCartHold(false);
  check("…and off again", !bridge.autoCartHeld());
}

void main();

/* ------------- 8. live-test regressions: one plan pick, no stale text ------------- */
async function verifyLiveFixes() {
  console.log("\n8. Live-test regressions (plan pick = step date/time/party, free first; current selection only)");
  const R = await import("@/frontend/plan/planRun");
  const bridge = await import("@/frontend/utils/pickerBridge");
  const NOW = Date.parse("2026-10-23T10:00:00+05:30"); // Fri 23 Oct
  const snap = (selection?: { date?: string; time?: string; deal?: string; guests?: number }): ActivePicker => ({
    kind: "dineout",
    messageId: "do-slots-1",
    restaurantId: "r1",
    restaurantName: "Smack Diner",
    guests: 2,
    dates: [
      { date: "2026-10-23", label: "Fri, 23 Oct", meals: { Dinner: ["08:00 PM"] }, deals: [{ title: "Table reservation", free: true, discount: 15 }] },
      {
        date: "2026-10-24",
        label: "Sat, 24 Oct",
        meals: { Dinner: ["07:00 PM", "07:30 PM", "08:00 PM"] },
        deals: [
          { title: "Flat 20% off on Total Bill", free: false, price: 25, discount: 20 },
          { title: "Table reservation", free: true, discount: 15 },
        ],
      },
    ],
    ...(selection ? { selection } : {}),
  });
  const step = { time: "7:30 PM", domain: "dineout" as const, title: "Dinner at Smack Diner", detail: "Sat 24 Oct · 2 guests", ref: "r1" };
  const it = { title: "Saturday Dinner for Two", date: "Sat 24 Oct", party: 2, steps: [step] };
  const target = R.planTargetFor(step, it);
  const pick = R.planPickDineout(snap() as never, target, NOW);
  const sel = pick && "sel" in pick ? pick.sel : undefined;
  check("plan pick uses the STEP's date (Sat 24 Oct, not today Fri 23)", sel?.date === "2026-10-24", sel);
  check("plan pick = slot nearest the step time (7:30 PM)", sel?.time === "07:30 PM", sel);
  check("plan pick prefers the FREE table (15% off) over the paid 20% deal", sel?.deal === "Table reservation" && sel?.confirm === true, sel);
  check("plan pick uses the party size", sel?.guests === 2, sel);
  const paid = R.planPickDineout(snap() as never, { ...target, wantPaid: true }, NOW);
  check("paid deal only when the plan asked for one (no confirm → no auto create_cart)", !!paid && "sel" in paid && paid.sel.deal === "Flat 20% off on Total Bill" && !paid.sel.confirm, paid);
  const none = R.planPickDineout(snap() as never, { ...target, dateText: "Sun 25 Oct" }, NOW);
  check("no slot on the step's date → an error (never another day silently)", !!none && "error" in none, none);

  // the bridge applies exactly ONE selection when the picker registers (no best-pick first)
  const applied: unknown[] = [];
  bridge.sendPlanPick("do-slots-1", (sn) => {
    const p = R.planPickFor(sn, target, NOW);
    return p && "sel" in p ? p.sel : null;
  });
  const off = bridge.registerPicker("do-slots-1", { kind: "dineout", snapshot: () => snap(), apply: (x) => applied.push(x) });
  await new Promise((r) => setTimeout(r, 0));
  off();
  check("one plan selection applied on register (no sequential overrides)", applied.length === 1 && (applied[0] as { date?: string }).date === "2026-10-24", applied);

  // the step card shows the CURRENT selection + its own why, never the model's stale "Set to …" line
  const planMsg: ChatMessage = {
    id: "plan1",
    role: "assistant",
    text: "",
    createdAt: NOW,
    itinerary: it,
    dineoutRestaurants: [{ id: "r1", name: "Smack Diner", cuisines: [], bookable: true }],
  };
  const picker: ChatMessage = {
    id: "do-slots-1",
    role: "assistant",
    createdAt: NOW + 1,
    text: "Set to Sat 24 Oct · 7:30 PM · 2 guests · Flat 20% off (₹25) — tap Confirm in the picker.",
    dineoutSlots: { restaurantId: "r1", restaurantName: "Smack Diner", slots: [] } as never,
  };
  const run = { ...R.emptyRun(), planIds: ["plan1"], startedAt: NOW, mode: "running" as const };
  const view = (selection: { date?: string; time?: string; deal?: string; guests?: number }) =>
    R.derivePlan({ messages: [planMsg, picker], run, snapshot: () => snap(selection), now: NOW + 5000 })!;
  let v = view({ date: "2026-10-24", time: "07:30 PM", deal: "Table reservation", guests: 2 });
  const s0 = v.steps[0];
  check("card pick = live selection (free table · 15% off)", s0.status === "confirm" && /Sat, 24 Oct · 07:30 PM · free table · 15% off · 2 guests/.test(s0.pick?.title ?? ""), s0.pick);
  check("card why is about the current selection, not the stale model text", !!s0.pick?.why && !/Set to|Flat 20%|₹25/.test(s0.pick.why) && /7:30 PM/.test(s0.pick.why), s0.pick?.why);
  v = view({ date: "2026-10-24", time: "08:00 PM", deal: "Table reservation", guests: 2 });
  check("a changed selection says so (and shows the new time)", /08:00 PM/.test(v.steps[0].pick?.title ?? "") && /Changed from the plan's pick/.test(v.steps[0].pick?.why ?? ""), v.steps[0].pick);
  const logged = R.logTransitions(run, view({ date: "2026-10-24", time: "07:30 PM", deal: "Table reservation", guests: 2 }), NOW);
  check("ONE log line for the final pick", logged.log.filter((l) => /free table · 15% off/.test(l.text)).length === 1, logged.log.map((l) => l.text));
  check("'picked' (still reading) writes no extra log line", R.describeStep({ ...v.steps[0], status: "picked" }) === null);

  // 3. asked for, but unavailable
  const un = extractPlanMarkers(
    "PLAN TITLE: Saturday Dinner for Two\nUNAVAILABLE: comedy show | none on Swiggy Scenes in Chennai for Sat 24 Oct (found only in Bangalore / Mumbai)\nITINERARY: 7:30 PM | dineout | Dinner | x | r1",
    "plan",
  );
  check("UNAVAILABLE line → itinerary.unavailable", un.itinerary?.unavailable?.[0]?.what === "comedy show" && /Chennai/.test(un.itinerary?.unavailable?.[0]?.why ?? "") && !/UNAVAILABLE/.test(un.rest), un.itinerary);
  check("'Try Sunday' after a Saturday plan", R.nextDayName("Sat 24 Oct") === "Sunday" && R.unavailablePrompt({ what: "comedy show", why: "none" }, "day", it).display === "Try Sunday");
  check("'Try another kind of show' prompt is read-only", /Never book/.test(R.unavailablePrompt({ what: "comedy show", why: "none" }, "other", it).text));
}
