import { expect, test, type Browser } from "@playwright/test";

import { createUser, signIn, uniqueEmail } from "./helpers";

// Sign-in links handed out instead of mailed (spec §3.1). They work whether or not the instance sends
// mail; the local stack does (Mailpit), which these tests only use to sign the people in first.

/** A signed-in page in English, plus its origin for API calls. */
async function signedIn(browser: Browser, email: string, name: string, admin = false) {
  createUser(email, name, admin);
  const page = await (await browser.newContext({ locale: "en-US" })).newPage();
  await signIn(page, email);
  await page.getByRole("button", { name: "EN", exact: true }).click();
  return { page, origin: new URL(page.url()).origin };
}

/** Open a sign-in link in a brand-new browser (no cookies), as on another device. */
async function openLink(browser: Browser, url: string) {
  const page = await (await browser.newContext({ locale: "en-US" })).newPage();
  await page.goto(url);
  await page.getByRole("button", { name: "Sign in now" }).click();
  return page;
}

async function whoAmI(page: import("@playwright/test").Page): Promise<string> {
  const res = await page.request.get("/api/me");
  expect(res.status()).toBe(200);
  return ((await res.json()) as { display_name: string }).display_name;
}

test("an admin creates a sign-in link for a member; it signs in as the member, once", async ({ browser }) => {
  const ivo = await signedIn(browser, uniqueEmail("ivo"), "Ivo", true);
  const post = (path: string) => ivo.page.request.post(path, { headers: { Origin: ivo.origin } });
  const create = await ivo.page.request.post("/api/groups", {
    data: { name: `Links ${Date.now()}` },
    headers: { Origin: ivo.origin },
  });
  const gid: number = (await create.json()).id;
  const inviteUrl: string = (await (await post(`/api/groups/${gid}/invites`)).json()).url;

  const mia = await signedIn(browser, uniqueEmail("mia"), "Mia");
  const joined = await mia.page.request.post(`/api/join/${inviteUrl.split("/").pop()}`, {
    headers: { Origin: mia.origin },
  });
  expect(joined.ok()).toBe(true);

  await ivo.page.goto(`/g/${gid}/settings`);
  const rows = ivo.page.locator(".rows li");
  // Not for yourself (Ivo is also the instance admin).
  await expect(rows.filter({ hasText: "Ivo" }).getByRole("button", { name: "Sign-in link" })).toHaveCount(0);
  await rows.filter({ hasText: "Mia" }).getByRole("button", { name: "Sign-in link" }).click();
  const box = ivo.page.getByRole("textbox", { name: "Sign-in link for Mia" });
  const url = await box.inputValue();
  expect(url).toMatch(/\/auth\/verify#t=[\w-]+$/);
  await expect(ivo.page.getByText("Send it only to Mia")).toBeVisible();

  // Another device opens it and is Mia, not Ivo.
  const device = await openLink(browser, url);
  await device.waitForURL((u) => !u.pathname.startsWith("/auth/"));
  expect(await whoAmI(device)).toBe("Mia");
  // Ivo is still Ivo.
  expect(await whoAmI(ivo.page)).toBe("Ivo");

  // Single use.
  const again = await openLink(browser, url);
  await expect(again.getByText("This link has expired or was already used.")).toBeVisible();
  expect((await again.request.get("/api/me")).status()).toBe(401);
});
