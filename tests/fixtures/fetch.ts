// A recording fetch stub for component tests: each call is matched against
// path prefixes; anything unmatched rejects (so a component can never reach a
// real endpoint unnoticed). Also knows which app routes change real-world
// state so tests can assert they were never hit.
import { vi } from "vitest";

export type Handler = (url: URL, init?: RequestInit) => unknown | Promise<unknown>;

const REPLY = Symbol("reply");
type Reply = { [REPLY]: true; status: number; body: unknown };
/** A canned non-200 reply: `reply(429, { busy: true })`. */
export const reply = (status: number, body: unknown): Reply => ({ [REPLY]: true, status, body });

export interface FetchCall {
  path: string;
  url: URL;
  method: string;
  body?: unknown;
}

/** App routes that place / book / pay / confirm (or create a Swiggy cart). */
export const MUTATING_ROUTES = [
  "/api/checkout",
  "/api/orders",
  "/api/dineout/book",
  "/api/dineout/cart",
  "/api/scenes/cart",
  "/api/scenes/order",
  "/api/payments/confirm",
  "/api/food-cart",
  "/api/cart",
  "/api/addresses/create",
];

/** Route → handler function, canned `reply(...)`, or a plain JSON body (200). */
export function stubFetch(routes: Record<string, Handler | Reply | object>) {
  const calls: FetchCall[] = [];
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(raw, "http://localhost");
    const method = (init?.method ?? "GET").toUpperCase();
    let body: unknown;
    if (typeof init?.body === "string") {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    calls.push({ path: url.pathname, url, method, body });
    const key = Object.keys(routes)
      .filter((k) => url.pathname === k || url.pathname.startsWith(`${k}/`) || `${method} ${url.pathname}` === k)
      .sort((a, b) => b.length - a.length)[0];
    if (!key) throw new Error(`[tests] unexpected fetch ${method} ${url.pathname}${url.search}`);
    const h = routes[key];
    if (typeof h === "function") {
      const out = await (h as Handler)(url, init);
      return out instanceof Response ? out : Response.json(out);
    }
    if (REPLY in h) return Response.json((h as Reply).body, { status: (h as Reply).status });
    return Response.json(h);
  });
  vi.stubGlobal("fetch", fn);
  return {
    calls,
    fn,
    mutating: () => calls.filter((c) => MUTATING_ROUTES.some((r) => c.path === r || c.path.startsWith(`${r}/`)) && c.method !== "GET"),
  };
}

/** A promise that never settles — for long-polls the test must not complete. */
export const never = () => new Promise<never>(() => {});
