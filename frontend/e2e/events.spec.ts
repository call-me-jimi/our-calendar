import { expect, test, type Browser, type Page } from "@playwright/test";

import { addDays, todayBerlin, type Day } from "../src/lib/days";
import { createUser, signIn, uniqueEmail } from "./helpers";

/** Ivo, instance and group admin, alone in a fresh group, UI in English, desktop size. */
async function adminWithGroup(browser: Browser): Promise<{ page: Page; gid: number; origin: string }> {
  const email = uniqueEmail("ev");
  createUser(email, "Ivo", true);
  const page = await (await browser.newContext({ locale: "en-US", viewport: { width: 1280, height: 900 } })).newPage();
  await signIn(page, email);
  await page.getByRole("button", { name: "EN", exact: true }).click();
  const origin = new URL(page.url()).origin;
  const res = await page.request.post("/api/groups", { data: { name: `Ev ${Date.now()}` }, headers: { Origin: origin } });
  return { page, gid: (await res.json()).id, origin };
}

const cell = (page: Page, day: Day) => page.locator(`.cell[data-day="${day}"]`);
const offered = (page: Page, day: Day) => page.locator(`.finder .bchip[data-start="${day}"]`);

/** Gruppe's table on the month of `day` (it is at most one month ahead in these tests). */
async function tableAt(page: Page, gid: number, day: Day) {
  await page.goto(`/g/${gid}/group?layout=table`);
  if (day.slice(0, 7) !== todayBerlin().slice(0, 7)) await page.getByRole("button", { name: "Next month" }).click();
  await expect(page.locator(`th[data-day="${day}"]`)).toBeVisible();
}

/** Step the view (Calendar or Overview) month by month until `day` is shown. */
async function showDay(page: Page, tag: "th" | ".cell", day: Day) {
  const target = page.locator(`${tag}[data-day="${day}"]`);
  const forward = day > todayBerlin();
  for (let i = 0; i < 30 && (await target.count()) === 0; i++) {
    await page.getByRole("button", { name: forward ? "Next month" : "Previous month" }).click();
  }
  await expect(target.first()).toBeVisible();
}

// The P5 phase check (plan.md): an event shows in Gruppe, blocks Passende Tage, can be edited and deleted.
test("events: create, show, exclude from Passende Tage, edit, delete", async ({ browser }) => {
  const { page, gid } = await adminWithGroup(browser);
  const day = addDays(todayBerlin(), 3);
  const title = "Gig at Lido";
  const head = page.locator(`th[data-day="${day}"]`);
  const groupCell = page.locator(`tr.sum td[data-day="${day}"]`);

  await tableAt(page, gid, day);
  await expect(offered(page, day)).toHaveCount(1);

  // Create via "+ Event": two days with time & place.
  await page.getByRole("button", { name: "+ Event" }).click();
  const dialog = page.getByRole("dialog", { name: "New event" });
  await dialog.getByLabel("Title").fill(title);
  await dialog.getByLabel("First day").fill(day);
  await dialog.getByLabel("Last day").fill(addDays(day, 1));
  await dialog.getByLabel("Time & place").fill("8 pm, Lido");
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(dialog).toHaveCount(0);

  // Table: a bar in the day header, an event in the group row, and no matching day on those days.
  await expect(head.locator(".ev")).toHaveCount(1);
  await expect(head).toHaveAttribute("title", new RegExp(title));
  await expect(groupCell).toHaveClass(/g-event/);
  await expect(offered(page, day)).toHaveCount(0);
  await expect(offered(page, addDays(day, 1))).toHaveCount(0);
  await expect(offered(page, addDays(day, 2))).toHaveCount(1);

  // Edit from the day summary.
  await groupCell.click();
  await page.getByRole("dialog").getByRole("button", { name: `Event: ${title}` }).click();
  const edit = page.getByRole("dialog", { name: "Edit event" });
  await expect(edit).toContainText("Created by Ivo");
  await expect(edit.getByLabel("Title")).toHaveValue(title);
  await expect(edit.getByLabel("Time & place")).toHaveValue("8 pm, Lido");
  await edit.getByLabel("Title").fill("Gig at Lido (moved)");
  await edit.getByRole("button", { name: "Save" }).click();
  await expect(edit).toHaveCount(0);
  await expect(head).toHaveAttribute("title", /Gig at Lido \(moved\)/);

  // Delete, with confirmation; the days are offered again.
  await groupCell.click();
  await page.getByRole("dialog").getByRole("button", { name: /\(moved\)/ }).click();
  const del = page.getByRole("dialog", { name: "Edit event" });
  await del.getByRole("button", { name: "Delete" }).click();
  await del.getByRole("button", { name: "Yes" }).click();
  await expect(del).toHaveCount(0);
  await expect(head.locator(".ev")).toHaveCount(0);
  await expect(offered(page, day)).toHaveCount(1);
});

test("plan an event from a Passende Tage result: summary, then the dialog prefilled", async ({ browser }) => {
  const { page, gid } = await adminWithGroup(browser);
  await page.goto(`/g/${gid}/group`);
  const finder = page.locator(".finder");
  await finder.getByRole("button", { name: "Weekend", exact: true }).click();
  await finder.getByRole("button", { name: "More days" }).click();

  const first = finder.locator(".bchip").first();
  const start = (await first.getAttribute("data-start"))!;
  await first.click();
  const summary = page.getByRole("dialog");
  await expect(summary).toContainText("2 days · Everyone can");
  await summary.getByRole("button", { name: "Plan event" }).click();

  const dialog = page.getByRole("dialog", { name: "New event" });
  await expect(dialog.getByLabel("First day")).toHaveValue(start);
  await expect(dialog.getByLabel("Last day")).toHaveValue(addDays(start, 1));
  await dialog.getByLabel("Title").fill("Weekend trip");
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(offered(page, start)).toHaveCount(0); // the weekend has an event now
});

test("plan an event from a header drag in the table", async ({ browser }) => {
  const { page, gid } = await adminWithGroup(browser);
  await page.goto(`/g/${gid}/group?layout=table`);
  await page.getByRole("button", { name: "Next month" }).click(); // a whole month ahead
  const now = todayBerlin();
  const [y, m] = now.split("-").map(Number) as [number, number];
  const next = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
  // The finder panel sits above the table, so the header can start below the fold.
  await page.locator(`th[data-day="${next}-03"]`).scrollIntoViewIfNeeded();
  const a = await page.locator(`th[data-day="${next}-03"]`).boundingBox();
  const b = await page.locator(`th[data-day="${next}-05"]`).boundingBox();
  await page.mouse.move(a!.x + a!.width / 2, a!.y + a!.height / 2);
  await page.mouse.down();
  await page.mouse.move(b!.x + b!.width / 2, b!.y + b!.height / 2, { steps: 5 });
  await page.mouse.up();
  await expect(page.locator(`th[data-day="${next}-04"]`)).toHaveClass(/selected/);

  const summary = page.getByRole("dialog");
  await expect(summary).toContainText("3 days · Everyone can");
  await summary.getByRole("button", { name: "Plan event" }).click();
  const dialog = page.getByRole("dialog", { name: "New event" });
  await expect(dialog.getByLabel("First day")).toHaveValue(`${next}-03`);
  await expect(dialog.getByLabel("Last day")).toHaveValue(`${next}-05`);
});

test("feed: subscribe link serves the group's events as iCalendar", async ({ browser }) => {
  const { page, gid, origin } = await adminWithGroup(browser);
  const day = addDays(todayBerlin(), 10);
  const res = await page.request.post(`/api/groups/${gid}/events`, {
    data: { title: "Feed Gig", start_day: day, end_day: day, time_place: "Lido" },
    headers: { Origin: origin },
  });
  expect(res.status()).toBe(201);

  await page.goto(`/g/${gid}/calendar`);
  await page.getByLabel("Group menu").click();
  await page.getByRole("button", { name: "Subscribe to events" }).click();
  const sheet = page.getByRole("dialog", { name: "Subscribe to events" });
  await sheet.getByRole("button", { name: "Create link" }).click();
  const input = sheet.getByLabel("Calendar link");
  await expect(input).toHaveValue(/\/feed\/[^/]+\.ics$/);
  const url = await input.inputValue();

  const feed = await page.request.get(url);
  expect(feed.status()).toBe(200);
  expect(feed.headers()["content-type"]).toContain("text/calendar");
  expect(await feed.text()).toContain("SUMMARY:Feed Gig");

  // Reopened: a new link replaces the old one, which stops working.
  await sheet.getByRole("button", { name: "Close" }).click();
  await page.getByLabel("Group menu").click();
  await page.getByRole("button", { name: "Subscribe to events" }).click();
  await sheet.getByRole("button", { name: "Create new link – the old one stops working" }).click();
  await expect(input).not.toHaveValue(url);
  expect((await page.request.get(url)).ok()).toBe(false);
});

test("holidays: Berlin + Brandenburg in October 2027", async ({ browser }) => {
  const { page, gid, origin } = await adminWithGroup(browser);
  const res = await page.request.patch(`/api/groups/${gid}`, {
    data: { regions: ["DE-BE", "DE-BB"] },
    headers: { Origin: origin },
  });
  expect(res.ok()).toBe(true);

  await page.goto(`/g/${gid}/calendar`);
  await showDay(page, ".cell", "2027-10-31");
  await expect(cell(page, "2027-10-03")).toHaveClass(/\bbank\b/); // German Unity Day, nationwide
  await expect(cell(page, "2027-10-31")).toHaveClass(/\bbank\b/); // Reformation Day, Brandenburg only
  await expect(cell(page, "2027-10-31")).toHaveAttribute("title", /Reformation.*\(Brandenburg\)/);
  await expect(cell(page, "2027-10-15").locator(".school")).toHaveCount(1); // autumn school holidays: one ribbon
  await expect(cell(page, "2027-10-15")).toHaveAttribute("title", /Berlin.*Brandenburg/); // both regions

  await page.goto(`/g/${gid}/overview`);
  await showDay(page, "th", "2027-10-31");
  await expect(page.locator('th[data-day="2027-10-31"]')).toHaveClass(/\bbank\b/);
  await expect(page.locator('th[data-day="2027-10-31"]')).toHaveAttribute("title", /\(Brandenburg\)/);
});
