// Route handlers called directly with Request objects; the Swiggy MCP wire is
// stubbed with RECORDED live tool results (tests/api/fakeMcp.ts refuses every
// mutating tool). Covers /api/bookings, /api/addresses, auth, health/ready.
import { beforeEach, describe, expect, it, vi } from "vitest";

import { liveToolResult, readJson } from "../fixtures/live";
import { mcp } from "./fakeMcp";
import { jar } from "./fakeHeaders";
import { logIn, logOut, TEST_TOKEN } from "./session";
import { req } from "./request";

vi.mock("next/headers", async () => await import("./fakeHeaders"));
vi.mock("@modelcontextprotocol/sdk/client/index.js", async () => await import("./fakeMcp"));

const recorded = (rel: string) => {
  const c = readJson<{ structuredContent: Record<string, unknown> }>(rel);
  return { content: [{ type: "text", text: JSON.stringify(c.structuredContent) }], structuredContent: c.structuredContent };
};

beforeEach(async () => {
  mcp.reset();
  logOut();
  await logIn();
});

const { POST } = await import("@/app/api/bookings/route");
const { GET: getAddresses } = await import("@/app/api/addresses/route");

describe("POST /api/bookings", () => {
  it("reads Dineout's nested `order` shape (live get_booking_status)", async () => {
    mcp.on("get_booking_status", recorded("tests/fixtures/dineout_get_booking_status_live.json"));
    const res = await POST(req("/api/bookings", { body: { items: [{ kind: "dineout", orderId: "251659596133204" }] } }));
    expect(res.status).toBe(200);
    const data = (await res.json()) as { ok: boolean; bookings: Record<string, unknown>[] };
    expect(data.ok).toBe(true);
    expect(data.bookings[0]).toMatchObject({
      kind: "dineout",
      orderId: "251659596133204",
      ok: true,
      status: "PLACED",
      title: "Table at Ganbeii",
    });
    expect(String(data.bookings[0].details)).toBe("27 Oct 2026 · 08:00 PM · 2 guests · Flat 10% Off on Total Bill · Koramangala");
    // read-only, with the user's own token
    expect(mcp.calls.map((c) => [c.name, c.args, c.token])).toEqual([["get_booking_status", { orderId: "251659596133204" }, TEST_TOKEN]]);
    expect(mcp.calls[0].server).toMatch(/\/dineout$/);
  });

  it("a Swiggy failure for one booking is reported per row, not as a 500", async () => {
    mcp.on("get_booking_status", { content: [{ type: "text", text: JSON.stringify({ success: false, error: { message: "Order not found" } }) }] });
    const res = await POST(req("/api/bookings", { body: { items: [{ kind: "dineout", orderId: "999" }] } }));
    const data = (await res.json()) as { bookings: { ok: boolean; error?: string }[] };
    expect(res.status).toBe(200);
    expect(data.bookings[0].ok).toBe(false);
    expect(data.bookings[0].error).toBeTruthy();
  });

  it("no ids → no Swiggy calls", async () => {
    const res = await POST(req("/api/bookings", { body: { items: [] } }));
    expect(await res.json()).toEqual({ ok: true, bookings: [] });
    expect(mcp.calls).toEqual([]);
  });

  it("401 without a session", async () => {
    logOut();
    const res = await POST(req("/api/bookings", { body: { items: [{ kind: "dineout", orderId: "1" }] } }));
    expect(res.status).toBe(401);
    expect(mcp.calls).toEqual([]);
  });
});

describe("GET /api/addresses", () => {
  const GET = getAddresses;
  it("returns the live saved addresses with each city's centre coordinates", async () => {
    mcp.on("get_addresses", liveToolResult("im_get_addresses.json"));
    const res = await GET(req("/api/addresses"));
    expect(res.status).toBe(200);
    const data = (await res.json()) as { addresses: { id: string; city?: string; latitude?: number; longitude?: number }[]; resolution: Record<string, unknown> };
    expect(data.addresses).toHaveLength(3);
    expect(data.addresses.map((a) => a.city)).toEqual(["Chennai", "Bengaluru", "Ongole"]);
    for (const a of data.addresses) {
      expect(typeof a.latitude).toBe("number");
      expect(typeof a.longitude).toBe("number");
    }
    // Bengaluru's centre, not a guess
    const blr = data.addresses.find((a) => a.city === "Bengaluru")!;
    expect(blr.latitude).toBeCloseTo(12.97, 1);
    expect(blr.longitude).toBeCloseTo(77.59, 1);
    expect(data.resolution).toMatchObject({ needsUserClarification: true, defaultAddressId: "db7kh1c1d96ofdam8g8g__AMVEDwTGeS8WPRJQbO-o12" });
    // the phone stays masked as Swiggy sent it
    expect(JSON.stringify(data)).not.toMatch(/\d{10}/);
  });

  it("passes the user's earlier pick through (selectedAddressId)", async () => {
    mcp.on("get_addresses", liveToolResult("im_get_addresses.json"));
    await GET(req("/api/addresses?selectedAddressId=d1k9ctrdq1ocsktt0090__AMXrgASg728rGDWKq4_ky_"));
    expect(mcp.calls[0].args).toMatchObject({ page: 1, selectedAddressId: "d1k9ctrdq1ocsktt0090__AMXrgASg728rGDWKq4_ky_" });
  });

  it("401 without a session (Swiggy never called)", async () => {
    logOut();
    const res = await GET(req("/api/addresses"));
    expect(res.status).toBe(401);
    expect(mcp.calls).toEqual([]);
  });
});

describe("auth routes", () => {
  it("GET /api/auth/login builds Swiggy's authorize URL with redirect_uri from APP_BASE_URL + PKCE S256", async () => {
    vi.stubEnv("APP_BASE_URL", "https://swizzo.example.com/");
    vi.stubEnv("SWIGGY_OAUTH_CLIENT_ID", "swiggy-mcp");
    const { GET } = await import("@/app/api/auth/login/route");
    logOut();
    const res = await GET(req("/api/auth/login", { headers: { host: "evil.example.net" } }));
    expect([302, 303, 307, 308]).toContain(res.status);
    const loc = new URL(res.headers.get("location")!);
    expect(`${loc.origin}${loc.pathname}`).toBe("https://mcp.swiggy.com/auth/authorize");
    expect(loc.searchParams.get("response_type")).toBe("code");
    expect(loc.searchParams.get("client_id")).toBe("swiggy-mcp");
    // from env, never from the Host header
    expect(loc.searchParams.get("redirect_uri")).toBe("https://swizzo.example.com/api/auth/callback");
    expect(loc.searchParams.get("code_challenge_method")).toBe("S256");
    expect(loc.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(loc.searchParams.get("state")).toMatch(/^[A-Za-z0-9_-]{16,}$/);
    expect(loc.searchParams.get("prompt")).toBeNull();
    // the PKCE verifier + state are sealed in an httpOnly cookie, not in the URL
    const cookie = jar.get("swiggy_oauth");
    expect(cookie?.value).toMatch(/^v1\./);
    expect(cookie?.opts).toMatchObject({ httpOnly: true });
  });

  it("'Switch account' asks Swiggy for the login form again", async () => {
    const { GET } = await import("@/app/api/auth/login/route");
    const res = await GET(req("/api/auth/login?prompt=login"));
    expect(new URL(res.headers.get("location")!).searchParams.get("prompt")).toBe("login");
  });

  it("GET /api/auth/callback with a forged state never exchanges the code", async () => {
    const { GET } = await import("@/app/api/auth/callback/route");
    logOut();
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const res = await GET(req("/api/auth/callback?code=abc&state=forged"));
    expect(new URL(res.headers.get("location")!).searchParams.get("auth_error")).toBe("state_mismatch");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("GET /api/auth/status: logged out → authenticated:false", async () => {
    const { GET } = await import("@/app/api/auth/status/route");
    logOut();
    const data = (await (await GET(req("/api/auth/status"))).json()) as { authenticated: boolean };
    expect(data.authenticated).toBe(false);
  });

  it("GET /api/auth/status: logged in → verified live with get_addresses (recorded)", async () => {
    mcp.on("get_addresses", liveToolResult("im_get_addresses.json"));
    const { GET } = await import("@/app/api/auth/status/route");
    const data = (await (await GET(req("/api/auth/status"))).json()) as { authenticated: boolean; user?: { name: string; addressCount: number } };
    expect(data.authenticated).toBe(true);
    expect(data.user).toMatchObject({ name: "Test User", addressCount: 3 });
  });

  it("POST /api/auth/logout from another site is refused (CSRF)", async () => {
    const { POST } = await import("@/app/api/auth/logout/route");
    const res = await POST(req("/api/auth/logout", { method: "POST", headers: { origin: "https://evil.example.net", "sec-fetch-site": "cross-site" } }));
    expect(res.status).toBe(403);
    expect(jar.has("swiggy_session")).toBe(true);
  });
});

describe("health", () => {
  it("GET /api/health is 200 without env, session or Swiggy", async () => {
    logOut();
    const { GET } = await import("@/app/api/health/route");
    const res = await GET(req("/api/health"));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, status: "alive" });
    expect(mcp.calls).toEqual([]);
  });

  it("GET /api/ready reports env NAMES only, never values", async () => {
    vi.stubEnv("SESSION_SECRET", "s".repeat(40));
    const { GET } = await import("@/app/api/ready/route");
    const res = await GET(req("/api/ready"));
    expect([200, 503]).toContain(res.status);
    expect(JSON.stringify(await res.json())).not.toContain("s".repeat(40));
  });
});
