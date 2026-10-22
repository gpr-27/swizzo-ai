// Phone-sized smoke: the login gate fits and the login link is reachable.
import { expect, test } from "@playwright/test";

test("mobile: login gate renders without horizontal scroll", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("link", { name: /Login with Swiggy/ })).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(1);
});
