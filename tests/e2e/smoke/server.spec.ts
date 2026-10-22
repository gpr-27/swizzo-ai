// Server-side smoke against the production build: no browser stubs, no Swiggy
// login, and nothing here ever reaches Swiggy (the authorize redirect is read,
// not followed).
import { expect, test } from "@playwright/test";

test("GET /api/health is alive", async ({ request }) => {
  const res = await request.get("/api/health");
  expect(res.status()).toBe(200);
  expect(await res.json()).toMatchObject({ ok: true, status: "alive" });
  expect(res.headers()["cache-control"]).toContain("no-store");
});

test("GET /api/ready answers with names/booleans only", async ({ request }) => {
  const res = await request.get("/api/ready");
  expect([200, 503]).toContain(res.status());
  const body = await res.json();
  expect(body).toHaveProperty("status");
  expect(JSON.stringify(body)).not.toContain("e2e-dummy-session-secret");
});

test("login builds Swiggy's authorize URL with redirect_uri from APP_BASE_URL", async ({ request, baseURL }) => {
  const res = await request.get("/api/auth/login", { maxRedirects: 0 });
  expect([302, 303, 307, 308]).toContain(res.status());
  const loc = new URL(res.headers()["location"]);
  expect(`${loc.origin}${loc.pathname}`).toBe("https://mcp.swiggy.com/auth/authorize");
  const appBase = process.env.E2E_APP_BASE_URL || baseURL!;
  expect(loc.searchParams.get("redirect_uri")).toBe(`${appBase.replace(/\/+$/, "")}/api/auth/callback`);
  expect(loc.searchParams.get("client_id")).toBeTruthy();
  expect(loc.searchParams.get("response_type")).toBe("code");
  expect(loc.searchParams.get("code_challenge_method")).toBe("S256");
  expect(loc.searchParams.get("state")).toBeTruthy();
  // the PKCE verifier stays server-side in a sealed httpOnly cookie
  const setCookie = res.headersArray().filter((h) => h.name.toLowerCase() === "set-cookie").map((h) => h.value).join("\n");
  expect(setCookie).toMatch(/swiggy_oauth=v1\./);
  expect(setCookie).toMatch(/HttpOnly/i);
  expect(loc.search).not.toContain(setCookie.split("=")[1]?.slice(0, 20));
});

test("the OAuth callback with a forged state goes back to the app with an error", async ({ request }) => {
  const res = await request.get("/api/auth/callback?code=x&state=forged", { maxRedirects: 0 });
  expect([302, 303, 307, 308]).toContain(res.status());
  expect(new URL(res.headers()["location"]).searchParams.get("auth_error")).toBe("state_mismatch");
});

test("session APIs answer 401 without a Swiggy login", async ({ request, baseURL }) => {
  for (const path of ["/api/addresses", "/api/cart?addressId=x", "/api/history"]) {
    const res = await request.get(path);
    expect(res.status(), path).toBe(401);
  }
  const chat = await request.post("/api/chat", { data: { service: "instamart", message: "milk" }, headers: { origin: new URL(baseURL!).origin } });
  expect(chat.status()).toBe(401);
});

test("state-changing APIs refuse cross-site requests", async ({ request }) => {
  const res = await request.post("/api/checkout", { data: {}, headers: { origin: "https://evil.example.net", "sec-fetch-site": "cross-site" } });
  expect(res.status()).toBe(403);
});

test("unknown pages render the 404 page", async ({ page }) => {
  const res = await page.goto("/definitely-not-a-page");
  expect(res?.status()).toBe(404);
  await expect(page.getByRole("heading", { name: "This page doesn't exist" })).toBeVisible();
  await page.getByRole("link", { name: "Back to Swizzo" }).click();
  await expect(page).toHaveURL(/\/$/);
});

test("security headers are set on pages", async ({ request }) => {
  const res = await request.get("/");
  const h = res.headers();
  expect(h["x-powered-by"]).toBeUndefined();
  expect(h["content-security-policy"] ?? h["content-security-policy-report-only"]).toBeTruthy();
});
