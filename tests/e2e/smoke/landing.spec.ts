// Browser smoke on the production build — no Swiggy login. Logged out we see
// the login gate; for the app shell, /api/auth/status and /api/addresses are
// answered in the browser with the recorded (redacted) live capture, every
// other API call gets an empty 404, and any state-changing call fails the test.
import { expect, test, type Page } from "@playwright/test";

import { expectNoMutations, guardMutations, liveAddresses } from "../fixtures";

test("logged out: the landing shows the Swiggy login gate", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveTitle(/Swizzo/);
  await expect(page.getByRole("heading", { name: /Welcome to Swiggy Chat/ })).toBeVisible();
  const login = page.getByRole("link", { name: /Login with Swiggy/ });
  await expect(login).toHaveAttribute("href", "/api/auth/login");
});

test("the login button leads to Swiggy's authorize URL (not followed)", async ({ page, baseURL }) => {
  await page.goto("/");
  const authorize = page.waitForRequest((r) => r.url().startsWith("https://mcp.swiggy.com/auth/authorize"));
  await page.route("https://mcp.swiggy.com/**", (route) => route.fulfill({ status: 200, body: "stubbed Swiggy authorize page" }));
  await page.getByRole("link", { name: /Login with Swiggy/ }).click();
  const url = new URL((await authorize).url());
  const appBase = process.env.E2E_APP_BASE_URL || baseURL!;
  expect(url.searchParams.get("redirect_uri")).toBe(`${appBase.replace(/\/+$/, "")}/api/auth/callback`);
  expect(url.searchParams.get("code_challenge_method")).toBe("S256");
});

test("a cancelled Swiggy login lands back on the gate and the error param is cleaned up", async ({ page }) => {
  await page.goto("/?auth_error=access_denied");
  // the gate stays (still logged out) and the query param is cleaned up
  await expect(page.getByRole("link", { name: /Login with Swiggy/ })).toBeVisible();
  await expect(page).not.toHaveURL(/auth_error/);
});

async function openShell(page: Page, baseURL: string) {
  // any session cookie makes the server render the app shell instead of the gate
  await page.context().addCookies([{ name: "swiggy_session", value: "v1.e2e-placeholder", url: baseURL }]);
  const guard = await guardMutations(page);
  const book = liveAddresses();
  await page.route("**/api/**", async (route) => {
    const u = new URL(route.request().url());
    if (u.pathname === "/api/auth/status") return route.fulfill({ json: { authenticated: true, user: { name: "Test User", addressCount: book.addresses.length } } });
    if (u.pathname === "/api/addresses") return route.fulfill({ json: book });
    return route.fulfill({ status: 404, json: { ok: false } });
  });
  await page.goto("/");
  return guard;
}

test("app shell: five tabs, Instamart first, switching moves the selection", async ({ page, baseURL }) => {
  const guard = await openShell(page, baseURL!);
  const tabs = page.getByRole("tablist", { name: "Service" }).getByRole("tab");
  await expect(tabs).toHaveCount(5);
  await expect(page.getByRole("tab", { selected: true })).toContainText("Instamart");
  for (const name of ["Food", "Dineout", "Scenes", "Plan", "Instamart"]) {
    await page.getByRole("tab", { name }).click();
    await expect(page.getByRole("tab", { selected: true })).toContainText(name);
  }
  // keyboard: arrow keys move between tabs
  await page.getByRole("tab", { selected: true }).focus();
  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("tab", { selected: true })).toContainText("Food");
  expectNoMutations(guard);
});

test("app shell: the saved address (live capture) is shown and the composer is ready", async ({ page, baseURL }) => {
  const guard = await openShell(page, baseURL!);
  await expect(page.getByText(/New Tippasandra|West Tambaram/).first()).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Message" })).toBeEditable();
  expectNoMutations(guard);
});
