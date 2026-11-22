import { expect, test } from "@playwright/test";

import { createUser, signIn, uniqueEmail } from "./helpers";

// The P2 phase check (plan.md): the admin creates a group and an invite; a new person joins with
// name, email and password and sees the group; signs in again with the password; after revoking,
// the link no longer works.
test("create group, invite, join with a password, sign in with it, revoke", async ({ browser }) => {
  const adminEmail = uniqueEmail("admin");
  createUser(adminEmail, "Ivo", true);
  const groupName = `Band ${Date.now()}`;

  const admin = await (await browser.newContext({ locale: "en-US" })).newPage();
  await signIn(admin, adminEmail);
  await admin.getByRole("link", { name: "Admin" }).click();
  await admin.getByLabel("Gruppenname").fill(groupName);
  await admin.getByRole("button", { name: "Gruppe anlegen" }).click();

  // Lands in the new group's settings, as its admin.
  await expect(admin).toHaveURL(/\/g\/\d+\/settings$/);
  await expect(admin.locator(".rows li").filter({ hasText: "Ivo" })).toContainText("Admin");
  await admin.getByRole("button", { name: "Neuen Link erstellen" }).click();
  const inviteUrl = await admin.getByRole("textbox", { name: "Einladungslink" }).inputValue();
  expect(inviteUrl).toMatch(/\/join\/[\w-]+$/);
  await expect(admin.getByText("0× benutzt")).toBeVisible();

  // A new person joins with name, email and password: straight in, no mail.
  const annaEmail = uniqueEmail("anna");
  const anna = await (await browser.newContext({ locale: "en-US" })).newPage();
  await anna.goto(inviteUrl);
  await expect(anna.getByRole("heading", { name: `Join “${groupName}”` })).toBeVisible();
  await anna.getByLabel("Your name").fill("Anna");
  await anna.getByLabel("Email address").fill(annaEmail);
  // A common password is refused.
  await anna.getByLabel("Password").fill("Passwort1");
  await anna.getByRole("button", { name: "Join" }).click();
  await expect(anna.getByRole("alert")).toHaveText(/too common/);
  await anna.getByLabel("Password").fill("annas-passwort");
  await anna.getByRole("button", { name: "Join" }).click();

  // Straight into the group, as a member: no settings tab, and no password reminder.
  await expect(anna).toHaveURL(/\/g\/\d+\/days$/);
  await expect(anna.getByRole("heading", { name: groupName })).toBeVisible();
  await expect(anna.getByRole("link", { name: "Settings" })).toHaveCount(0);
  await expect(anna.getByText("You don't have a password yet.")).toHaveCount(0);

  // Signed out, Anna signs in again with email and password.
  await anna.getByLabel("Account", { exact: true }).click(); // the avatar menu
  await anna.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(anna).toHaveURL(/\/signin$/);
  await anna.getByLabel("Email address").fill(annaEmail);
  await anna.getByLabel("Password").fill("falsches-passwort");
  await anna.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(anna.getByRole("alert")).toHaveText("Email or password is wrong.");
  await anna.getByLabel("Password").fill("annas-passwort");
  await anna.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(anna).toHaveURL(/\/g\/\d+\/days$/);

  // The admin sees Anna and one use; then revokes the link.
  await admin.reload();
  await expect(admin.locator(".rows li").filter({ hasText: "Anna" })).toContainText("Mitglied");
  await expect(admin.getByText("1× benutzt")).toBeVisible();
  await admin.getByRole("button", { name: "Widerrufen" }).click();
  await expect(admin.getByText("Keine aktiven Links.")).toBeVisible();

  const late = await (await browser.newContext({ locale: "en-US" })).newPage();
  await late.goto(inviteUrl);
  await expect(late.getByText("This link is no longer valid")).toBeVisible();
});

test("a member leaves; the last admin can't", async ({ browser }) => {
  const adminEmail = uniqueEmail("admin");
  createUser(adminEmail, "Ivo", true);
  const page = await (await browser.newContext({ locale: "en-US" })).newPage();
  await signIn(page, adminEmail);
  await page.goto("/admin");
  await page.getByLabel("Gruppenname").fill(`Solo ${Date.now()}`);
  await page.getByRole("button", { name: "Gruppe anlegen" }).click();
  await expect(page).toHaveURL(/\/settings$/);

  await page.getByLabel("Gruppenmenü").click();
  await page.getByRole("button", { name: "Gruppe verlassen" }).click();
  await page.getByRole("button", { name: "Ja" }).click();
  await expect(page.getByText("Eine Gruppe braucht mindestens einen Admin")).toBeVisible();
});
