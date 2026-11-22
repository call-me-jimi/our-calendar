import { expect, test, type Browser, type Page } from "@playwright/test";

import { addDays, todayBerlin, type Day } from "../src/lib/days";
import { createUser, signIn, uniqueEmail } from "./helpers";

const mailpit = process.env.E2E_MAILPIT_URL ?? "http://127.0.0.1:8026";

async function mailCount(email: string): Promise<number> {
  const res = await fetch(`${mailpit}/api/v1/search?query=${encodeURIComponent(`to:"${email}"`)}`);
  return ((await res.json()) as { messages: unknown[] }).messages.length;
}

/** A signed-in page in English at desktop size, plus its origin for API calls. */
async function signedIn(browser: Browser, email: string, name: string, admin = false) {
  createUser(email, name, admin);
  const page = await (await browser.newContext({ locale: "en-US", viewport: { width: 1280, height: 900 } })).newPage();
  await signIn(page, email);
  await page.getByRole("button", { name: "EN", exact: true }).click();
  return { page, origin: new URL(page.url()).origin };
}

async function showDay(page: Page, day: Day) {
  const target = page.locator(`.cell[data-day="${day}"]`);
  await page.locator(".cell[data-day]").first().waitFor(); // the calendar has rendered
  for (let i = 0; i < 3 && (await target.count()) === 0; i++) {
    await page.getByRole("button", { name: "Next month" }).click();
  }
  await expect(target.first()).toBeVisible();
}

// The P6 check (plan.md): deleting an account removes the person, and what they did for the group stays
// as "former member".
test("a member deletes their account; the admin sees 'former member'", async ({ browser }) => {
  const ivo = await signedIn(browser, uniqueEmail("ivo"), "Ivo", true);
  const post = (path: string, data?: object) => ivo.page.request.post(path, { data, headers: { Origin: ivo.origin } });
  const gid: number = (await (await post("/api/groups", { name: `Del ${Date.now()}` })).json()).id;
  const inviteUrl: string = (await (await post(`/api/groups/${gid}/invites`)).json()).url;
  const ivoId: number = (await (await ivo.page.request.get("/api/me")).json()).id;

  // Mia joins and becomes a second admin, so she may set Ivo's day (and isn't the last admin).
  const miaEmail = uniqueEmail("mia");
  const mia = await signedIn(browser, miaEmail, "Mia");
  const miaPost = (path: string, data?: object) => mia.page.request.post(path, { data, headers: { Origin: mia.origin } });
  expect((await miaPost(`/api/join/${inviteUrl.split("/").pop()}`)).ok()).toBe(true);
  const miaId: number = (await (await mia.page.request.get("/api/me")).json()).id;
  const promote = await ivo.page.request.patch(`/api/groups/${gid}/members/${miaId}`, {
    data: { role: "admin" },
    headers: { Origin: ivo.origin },
  });
  expect(promote.ok()).toBe(true);

  const day = addDays(todayBerlin(), 2);
  const marks = await mia.page.request.put("/api/marks", {
    data: { user_id: ivoId, group_id: gid, days: [{ day, state: "busy" }] },
    headers: { Origin: mia.origin },
  });
  expect(marks.ok()).toBe(true);
  expect((await miaPost(`/api/groups/${gid}/events`, { title: "Mia's gig", start_day: day, end_day: day })).status()).toBe(201);

  // Delete through the UI: the button only works once the name is typed exactly.
  const cookie = (await mia.page.context().cookies()).find((c) => c.name === "__Host-session")!;
  await mia.page.goto("/me");
  await mia.page.getByRole("button", { name: "Delete account …" }).click();
  const confirm = mia.page.getByLabel("To confirm, type your name: Mia");
  const final = mia.page.getByRole("button", { name: "Delete my account for good" });
  await confirm.fill("mia");
  await expect(final).toBeDisabled();
  await confirm.fill("Mia");
  await final.click();
  await expect(mia.page).toHaveURL(/\/signin$/);
  await expect(mia.page.getByRole("status")).toHaveText("Your account has been deleted.");

  // The old session is dead, and the address gets no new sign-in link.
  const replay = await mia.page.request.get("/api/me", { headers: { Cookie: `__Host-session=${cookie.value}` } });
  expect(replay.status()).toBe(401);
  const mails = await mailCount(miaEmail);
  await mia.page.getByRole("button", { name: "Email me a sign-in link instead" }).click();
  await mia.page.getByLabel("Email address").fill(miaEmail);
  await mia.page.getByRole("button", { name: "Send link" }).click();
  await expect(mia.page.getByRole("status")).toContainText(miaEmail);
  await new Promise((r) => setTimeout(r, 2_000));
  expect(await mailCount(miaEmail)).toBe(mails);

  // In Gruppe's day summary, Ivo's day and the event show "former member"; Mia is no longer listed.
  await ivo.page.goto(`/g/${gid}/group`);
  await showDay(ivo.page, day);
  await ivo.page.locator(`.cell[data-day="${day}"]`).click();
  const summary = ivo.page.getByRole("dialog");
  await expect(summary.locator(".mrow", { hasText: "You" })).toContainText("set by former member");
  await expect(summary.locator(".mrow", { hasText: "Mia" })).toHaveCount(0);
  await summary.getByRole("button", { name: "Event: Mia's gig" }).click();
  await expect(ivo.page.getByRole("dialog", { name: "Edit event" })).toContainText("Created by former member");
});

test("the privacy note is public in both languages and linked from footer and sign-in", async ({ browser }) => {
  const page = await (await browser.newContext({ locale: "en-US" })).newPage();
  await page.goto("/signin");
  await page.getByRole("button", { name: "EN", exact: true }).click();
  await page.getByRole("link", { name: "What happens to your data" }).click();
  await expect(page).toHaveURL(/\/privacy$/);
  await expect(page.getByRole("heading", { name: "Privacy", level: 1 })).toBeVisible();
  await expect(page.getByText(/openholidaysapi\.org/)).toBeVisible();
  await expect(page.getByRole("heading", { name: "Contact" })).toBeVisible();

  await page.getByRole("button", { name: "DE", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Datenschutz", level: 1 })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Sicherungen" })).toBeVisible();

  // The footer link works from any page, signed out included.
  await page.goto("/join/not-a-real-token");
  await page.getByRole("contentinfo").getByRole("link", { name: "Datenschutz" }).click();
  await expect(page).toHaveURL(/\/privacy$/);
  await expect(page.getByRole("heading", { name: "Datenschutz", level: 1 })).toBeVisible();
});
