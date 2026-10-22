// Logged-in E2E (opt-in): a REAL Swiggy session, READ-ONLY flows only.
//   E2E_SWIGGY_COOKIE  the value of your `swiggy_session` cookie (DevTools →
//                      Application → Cookies) from a server that uses the SAME
//                      SESSION_SECRET as the one Playwright starts
//   E2E_CHAT=1         also run one chat search (needs LLM keys on the server)
// Never taps Confirm / Pay / Checkout / Approve / Add / Book; every state-
// changing app route is aborted by the network guard and fails the test.
import { expect, test } from "@playwright/test";

import { expectNoMutations, guardMutations } from "../fixtures";

const cookie = process.env.E2E_SWIGGY_COOKIE?.trim();
test.skip(!cookie, "set E2E_SWIGGY_COOKIE to run the logged-in read-only suite");

test.beforeEach(async ({ context, baseURL }) => {
  await context.addCookies([{ name: "swiggy_session", value: cookie!, url: baseURL!, httpOnly: true, sameSite: "Lax" }]);
});

test("the session is live: /api/auth/status says authenticated", async ({ page }) => {
  await page.goto("/");
  const status = await page.evaluate(async () => (await fetch("/api/auth/status")).json());
  expect(status.authenticated).toBe(true);
});

test("the shell loads the account's saved addresses (get_addresses)", async ({ page }) => {
  const guard = await guardMutations(page);
  const addresses = page.waitForResponse((r) => new URL(r.url()).pathname === "/api/addresses" && r.status() === 200);
  await page.goto("/");
  const body = await (await addresses).json();
  expect(body.addresses.length).toBeGreaterThan(0);
  await expect(page.getByRole("tablist", { name: "Service" })).toBeVisible();
  expectNoMutations(guard);
});

test("tabs switch on a real account without any write", async ({ page }) => {
  const guard = await guardMutations(page);
  await page.goto("/");
  for (const name of ["Food", "Dineout", "Scenes", "Plan", "Instamart"]) {
    await page.getByRole("tab", { name }).click();
    await expect(page.getByRole("tab", { selected: true })).toContainText(name);
  }
  expectNoMutations(guard);
});

test("order history opens (read-only get_*_orders)", async ({ page }) => {
  const guard = await guardMutations(page);
  await page.goto("/");
  await page.getByRole("button", { name: "Order history" }).click();
  await expect(page.getByRole("button", { name: "Close order history" })).toBeVisible();
  expectNoMutations(guard);
});

test("chat: an Instamart search draws live product cards (nothing added)", async ({ page }) => {
  test.skip(process.env.E2E_CHAT !== "1", "set E2E_CHAT=1 (needs LLM keys on the server)");
  const guard = await guardMutations(page);
  await page.goto("/");
  await page.getByRole("tab", { name: "Instamart" }).click();
  const box = page.getByRole("textbox", { name: "Message" });
  await box.fill("toned milk");
  await box.press("Enter");
  await expect(page.locator("article").first()).toBeVisible({ timeout: 90_000 });
  await expect(page.locator('article img[src*="media-assets.swiggy.com"]').first()).toBeAttached();
  expectNoMutations(guard);
});
