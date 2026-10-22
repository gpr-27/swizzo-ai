// POST /api/chat — called directly with Request objects. The LLM turn
// (runChat) is replaced by a generator that yields REAL card events: the
// agent's own mapToolResult run on recorded live Swiggy payloads. What is
// under test is the route: the follow-up text-only rule
// (src/backend/agent/followUp.ts), per-tab domain isolation of the context,
// request validation and auth.
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ChatStreamEvent } from "@/shared/types";
import { liveDineoutRestaurants, livePayload } from "../fixtures/live";
import { logIn, logOut } from "./session";
import { ndjson, req } from "./request";

vi.mock("next/headers", async () => await import("./fakeHeaders"));
vi.mock("@modelcontextprotocol/sdk/client/index.js", async () => await import("./fakeMcp"));

const runChat = vi.hoisted(() => ({ events: [] as ChatStreamEvent[], args: [] as Record<string, unknown>[] }));
vi.mock("@/backend/agent/agent", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/backend/agent/agent")>();
  return {
    ...real,
    runChat: async function* (args: Record<string, unknown>) {
      runChat.args.push(args);
      for (const e of runChat.events) yield e;
    },
  };
});

const { mapToolResult } = await import("@/backend/agent/agent");
const { POST } = await import("@/app/api/chat/route");

const ctx = { addressId: "", latitude: 12.9352, longitude: 77.6245 } as never;
/** A real turn: live Instamart products + live Dineout cards + text + done. */
function liveTurn(): ChatStreamEvent[] {
  const products = mapToolResult({ bareTool: "search_products", query: "toned milk", input: { query: "toned milk" } }, livePayload("im_search_products_milk.json"), ctx);
  const dineout: ChatStreamEvent = { type: "dineoutRestaurants", restaurants: liveDineoutRestaurants() } as ChatStreamEvent;
  return [
    { type: "model", info: { label: "test", step: 1, fallbacks: 0 } } as unknown as ChatStreamEvent,
    ...products,
    dineout,
    { type: "text", delta: "Amul Moti is the best value." },
    { type: "done" },
  ];
}

const history = [
  { role: "user", text: "toned milk" },
  { role: "assistant", text: "Here are some options." },
];

beforeEach(async () => {
  logOut();
  await logIn();
  runChat.events = liveTurn();
  runChat.args.length = 0;
});

const types = (evs: Record<string, unknown>[]) => evs.map((e) => e.type);

describe("POST /api/chat", () => {
  it("streams NDJSON events from the agent (cards + text + done)", async () => {
    const res = await POST(req("/api/chat", { body: { service: "instamart", message: "toned milk", addressId: "x" } }));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/application\/x-ndjson/);
    const evs = await ndjson(res);
    expect(types(evs)).toContain("products");
    expect(types(evs)).toContain("dineoutRestaurants");
    expect(types(evs).at(-1)).toBe("done");
    const products = evs.find((e) => e.type === "products") as { products: { name: string }[] };
    expect(products.products.map((p) => p.name)).toContain("Amul Moti Toned Milk");
  });

  it("follow-up QUESTION about cards already shown → text only, no new cards", async () => {
    const res = await POST(req("/api/chat", { body: { service: "instamart", message: "which is the best rated one?", history } }));
    const evs = await ndjson(res);
    expect(types(evs)).not.toContain("products");
    expect(types(evs)).not.toContain("dineoutRestaurants");
    expect(evs.find((e) => e.type === "text")?.delta).toBe("Amul Moti is the best value.");
    expect(types(evs)).toContain("model");
    expect(types(evs).at(-1)).toBe("done");
  });

  it.each(["ok show me its menu", "any veg biryani?", "is there anything cheaper?", "book tomorrow 8 pm for 2"])(
    "a follow-up that asks to SEE something still gets cards: %s",
    async (message) => {
      const evs = await ndjson(await POST(req("/api/chat", { body: { service: "instamart", message, history } })));
      expect(types(evs)).toContain("products");
    },
  );

  it("the first message of a thread always gets cards, even phrased as a question", async () => {
    const evs = await ndjson(await POST(req("/api/chat", { body: { service: "dineout", message: "is it open now?" } })));
    expect(types(evs)).toContain("dineoutRestaurants");
  });

  it("a picker AI read is never filtered to text", async () => {
    const evs = await ndjson(
      await POST(req("/api/chat", { body: { service: "instamart", message: "which is cheapest?", history, pickerRead: true } })),
    );
    expect(types(evs)).toContain("products");
  });

  it("domain isolation: a tab's agent gets only its own cart, catalog, bookings and picker", async () => {
    const body = {
      message: "hi",
      cartLines: [{ id: "W6MKHU9IKH", name: "Amul Moti Toned Milk", quantity: 1 }],
      catalog: { products: [{ id: "W6MKHU9IKH", name: "Amul Moti Toned Milk" }], dishes: [{ id: "d1", name: "dish" }] },
      knownBookings: [
        { kind: "dineout", orderId: "D1", title: "Table" },
        { kind: "scenes", orderId: "S1", title: "Show" },
      ],
      kcalGoal: 2000,
      activePicker: { kind: "dineout", messageId: "m1", restaurantId: "1032642", restaurantName: "Si Nonna's", guests: 2, dates: [] },
    };
    for (const service of ["instamart", "food", "dineout", "scenes"]) {
      await ndjson(await POST(req("/api/chat", { body: { ...body, service } })));
    }
    const ctxOf = (i: number) => runChat.args[i].ctx as Record<string, unknown>;
    // instamart: its cart + products, no bookings, no Dineout picker
    expect(ctxOf(0).cartLines).toHaveLength(1);
    expect(ctxOf(0).catalog).toEqual({ products: body.catalog.products });
    expect(ctxOf(0).knownBookings).toBeUndefined();
    expect(ctxOf(0).activePicker).toBeUndefined();
    // food: dishes only
    expect(ctxOf(1).catalog).toEqual({ dishes: body.catalog.dishes });
    // dineout: no cart / macros; only dineout bookings; its own picker
    expect(ctxOf(2).cartLines).toBeUndefined();
    expect(ctxOf(2).kcalGoal).toBeUndefined();
    expect(ctxOf(2).catalog).toBeUndefined();
    expect((ctxOf(2).knownBookings as { kind: string }[]).map((b) => b.kind)).toEqual(["dineout"]);
    expect((ctxOf(2).activePicker as { kind: string } | undefined)?.kind).toBe("dineout");
    // scenes: never sees the Dineout picker
    expect(ctxOf(3).activePicker).toBeUndefined();
    expect((ctxOf(3).knownBookings as { kind: string }[]).map((b) => b.kind)).toEqual(["scenes"]);
  });

  it("an unknown service falls back to Instamart", async () => {
    await ndjson(await POST(req("/api/chat", { body: { service: "spaceship", message: "milk" } })));
    expect(runChat.args[0].service).toBe("instamart");
  });

  it("no coordinates → the agent is told to ask for the city (never assumes Bengaluru)", async () => {
    await ndjson(await POST(req("/api/chat", { body: { service: "dineout", message: "dinner", addressLine: "Test User: Ongole" } })));
    expect(String((runChat.args[0].ctx as { addressLine: string }).addressLine)).toMatch(/city NOT recognised/);
  });

  it("rejects an unsupported photo type with a 400 NDJSON error", async () => {
    const res = await POST(req("/api/chat", { body: { message: "what is this", image: { mediaType: "image/bmp", data: "AAAA" } } }));
    expect(res.status).toBe(400);
    const [ev] = await ndjson(res);
    expect(ev.type).toBe("error");
    expect(runChat.args).toHaveLength(0);
  });

  it("rejects a malformed body", async () => {
    const res = await POST(req("/api/chat", { body: "{not json" }));
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    expect(runChat.args).toHaveLength(0);
  });

  it("401 without a Swiggy session (and the agent never runs)", async () => {
    logOut();
    const res = await POST(req("/api/chat", { body: { service: "instamart", message: "milk" } }));
    expect(res.status).toBe(401);
    expect(runChat.args).toHaveLength(0);
  });
});
