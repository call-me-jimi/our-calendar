import { expect, test } from "@playwright/test";

import { createUser, magicLink, uniqueEmail } from "./helpers";

// The P1 phase check (plan.md): sign in through Mailpit, sign out, and the old cookie is dead.
test("magic-link sign-in, sign-out, and the replayed cookie is refused", async ({
  page,
  context,
  baseURL,
}) => {
  const email = uniqueEmail("admin");
  createUser(email, "E2E Admin", true);

  await page.goto("/");
  await expect(page).toHaveURL(/\/signin$/);
  await page.getByRole("button", { name: "EN", exact: true }).click();
  await page.getByRole("button", { name: "Email me a sign-in link instead" }).click();
  await page.getByLabel("Email address").fill(email);
  await page.getByRole("button", { name: "Send link" }).click();
  await expect(page.getByRole("status")).toContainText(email);

  const link = await magicLink(email);
  expect(new URL(link).hash).toMatch(/^#t=/);
  await page.goto(link);
  await page.getByRole("button", { name: "Sign in now" }).click();

  // Signed in: the user's stored language (German, from create-user) takes over.
  await expect(page.getByRole("heading", { name: "Hallo E2E Admin!" })).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`${baseURL}/$`));

  const cookie = (await context.cookies()).find((c) => c.name === "__Host-session");
  expect(cookie?.httpOnly).toBe(true);
  expect(cookie?.secure).toBe(true);

  // The same link a second time is refused.
  await page.goto(link);
  await page.getByRole("button", { name: "Jetzt anmelden" }).click();
  await expect(page.getByText("Dieser Link ist abgelaufen")).toBeVisible();

  await page.getByLabel("Konto", { exact: true }).click(); // the avatar menu
  await page.getByRole("button", { name: "Abmelden", exact: true }).click();
  await expect(page).toHaveURL(/\/signin$/);

  // Replay the old cookie outside the browser: the session is gone server-side.
  const res = await page.request.get("/api/me", {
    headers: { Cookie: `__Host-session=${cookie!.value}` },
  });
  expect(res.status()).toBe(401);
});

test("an unknown address gets the same answer and no mail", async ({ page }) => {
  await page.goto("/signin");
  await page.getByRole("button", { name: "EN", exact: true }).click();
  const email = uniqueEmail("nobody");
  await page.getByRole("button", { name: "Email me a sign-in link instead" }).click();
  await page.getByLabel("Email address").fill(email);
  await page.getByRole("button", { name: "Send link" }).click();
  await expect(page.getByRole("status")).toContainText(email);
  await expect(magicLink(email, 2_000)).rejects.toThrow();
});
