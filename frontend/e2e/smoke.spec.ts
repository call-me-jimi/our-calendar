import { expect, test } from "@playwright/test";

test("shell renders under the CSP without console errors", async ({ page }) => {
  const errors: string[] = [];
  // The signed-out GET /api/me answers 401 by design; the browser logs that as an error.
  page.on("console", (m) => {
    if (m.type() === "error" && !m.text().includes("status of 401")) errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(e.message));

  const res = await page.goto("/signin");
  expect(res?.headers()["content-security-policy"]).toContain("default-src 'self'");
  await expect(page.getByRole("heading", { name: /Sign in|Anmelden/ })).toBeVisible();
  await expect(page.getByText("Wann passt's?")).toBeVisible();
  expect(errors).toEqual([]);
});
