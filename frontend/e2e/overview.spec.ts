import { expect, test, type Browser, type Page } from "@playwright/test";

import { addDays, addMonths, compareDays, todayBerlin, weekday, type Day } from "../src/lib/days";
import { createUser, signIn, uniqueEmail } from "./helpers";

type Member = { page: Page; id: number };

/** Ivo (group admin) and Anna (member) in a fresh group, both signed in, UI in English. */
async function twoMembers(browser: Browser): Promise<{ gid: number; ivo: Member; anna: Member }> {
  const ivoEmail = uniqueEmail("ivo");
  createUser(ivoEmail, "Ivo", true);
  const ivo = await (await browser.newContext({ locale: "en-US", viewport: { width: 1280, height: 900 } })).newPage();
  await signIn(ivo, ivoEmail);
  await ivo.getByRole("button", { name: "EN", exact: true }).click();
  const headers = { Origin: new URL(ivo.url()).origin };
  const { id: gid } = await (await ivo.request.post("/api/groups", { data: { name: `Ov ${Date.now()}` }, headers })).json();
  const invite = await (await ivo.request.post(`/api/groups/${gid}/invites`, { headers })).json();

  const annaEmail = uniqueEmail("anna");
  createUser(annaEmail, "Anna");
  const anna = await (await browser.newContext({ locale: "en-US" })).newPage();
  await signIn(anna, annaEmail);
  await anna.getByRole("button", { name: "EN", exact: true }).click();
  await anna.goto(invite.url);
  await anna.getByRole("button", { name: "Join" }).click();
  await expect(anna).toHaveURL(/\/days$/);

  const idOf = async (p: Page) => (await (await p.request.get("/api/me")).json()).id as number;
  return { gid, ivo: { page: ivo, id: await idOf(ivo) }, anna: { page: anna, id: await idOf(anna) } };
}

async function mark(m: Member, gid: number, days: { day: Day; state: "busy" | "maybe" }[]) {
  const res = await m.page.request.put("/api/marks", {
    data: { user_id: m.id, group_id: gid, days: days.map((d) => ({ ...d, note: null })) },
    headers: { Origin: new URL(m.page.url()).origin },
  });
  expect(res.ok()).toBe(true);
}

/** The k-th Friday from today on (k = 0: this week's, or today if it is one). */
function friday(k: number): Day {
  let d = todayBerlin();
  while (weekday(d) !== 4) d = addDays(d, 1);
  return addDays(d, 7 * k);
}

const row = (page: Page, name: string) => page.locator(`tr[data-member="${name}"]`);

// The P4 phase check (plan.md): Anna's marks reach Ivo's open Gruppe table by polling, without reload.
test("the Gruppe table picks up another member's marks within 60 s", async ({ browser }) => {
  test.setTimeout(120_000);
  const { gid, ivo, anna } = await twoMembers(browser);

  await ivo.page.goto(`/g/${gid}/group?layout=table`);
  await ivo.page.getByRole("button", { name: "Next month" }).click();
  await expect(row(ivo.page, "Anna")).toContainText("nothing entered yet");
  await expect(ivo.page.locator("tr[data-member]").first()).toHaveAttribute("data-member", "Ivo"); // viewer first

  // Anna marks the 3rd–6th of next month (a day in the current month may already be past).
  const now = todayBerlin();
  const [y, m] = now.split("-").map(Number) as [number, number];
  const next = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
  const range = [3, 4, 5, 6].map((d) => `${next}-0${d}`);
  await mark(anna, gid, range.map((day) => ({ day, state: "busy" })));

  await expect(row(ivo.page, "Anna").locator("td.busy")).toHaveCount(4, { timeout: 70_000 });
  await expect(row(ivo.page, "Anna")).toContainText("updated");
  await expect(ivo.page.locator(`tr.sum td[data-day="${range[0]}"]`)).toHaveText("1");

  // Tapping the group row shows who can't.
  await ivo.page.locator(`tr.sum td[data-day="${range[1]}"]`).click();
  const summary = ivo.page.getByRole("dialog");
  await expect(summary).toContainText("1 can't");
  await expect(summary.locator(".mrow", { hasText: "Anna" })).toContainText("can't");
  await expect(summary.locator(".mrow", { hasText: "You" })).toContainText("can");
});

test("find matching days: Fri + Sat, 2 days in a row, next 3 months", async ({ browser }) => {
  const { gid, ivo, anna } = await twoMembers(browser);
  const today = todayBerlin();
  const end = addDays(addMonths(today, 3), -1);
  const fridays: Day[] = [];
  for (let k = 0; compareDays(addDays(friday(k), 1), end) <= 0; k++) fridays.push(friday(k));
  const [w0, w1] = fridays as [Day, Day];
  await mark(anna, gid, [{ day: addDays(w0, 1), state: "busy" }]); // a Saturday Anna can't
  await mark(ivo, gid, [{ day: w1, state: "maybe" }]); // a Friday Ivo might not

  const page = ivo.page;
  await page.goto(`/g/${gid}/group`);
  const finder = page.locator(".finder");
  await finder.getByRole("button", { name: "Weekend", exact: true }).click();
  await finder.getByRole("button", { name: "Fri", exact: true }).click();
  await finder.getByRole("button", { name: "Sun", exact: true }).click();
  await finder.getByRole("button", { name: "More days" }).click();
  await finder.getByRole("button", { name: "3 months" }).click();

  // Every Friday whose weekend everyone can, in date order, grouped by month.
  const starts = () => finder.locator(".bchip").evaluateAll((els) => els.map((e) => e.getAttribute("data-start")));
  await expect.poll(starts).toEqual(fridays.slice(2));
  await expect(finder).toContainText(`${fridays.length - 2} stretches in the chosen period`);

  // "Maybe" counting as free brings back Ivo's Friday, never Anna's Saturday.
  await finder.getByRole("button", { name: "“Maybe” counts as free" }).click();
  await expect.poll(starts).toEqual(fridays.slice(1));

  // The weekdays, the length and the switch are remembered; the period starts at 12 months again.
  await page.reload();
  await expect(finder.getByRole("button", { name: "Fri", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(finder.getByRole("button", { name: "Sun", exact: true })).toHaveAttribute("aria-pressed", "false");
  await expect(finder.locator(".stepper output")).toHaveText("2 days");
  await expect(finder.getByRole("button", { name: "“Maybe” counts as free" })).toHaveAttribute("aria-pressed", "true");
  await expect(finder.getByRole("button", { name: "12 months" })).toHaveAttribute("aria-pressed", "true");

  // Going back before today keeps the results: shown months and the 12-month period load separately,
  // as one load they'd pass the server's 400-day limit.
  await expect(finder.locator(".bchip").first()).toBeVisible();
  const before = await finder.locator(".bchip").count();
  await page.getByRole("button", { name: "Previous month" }).click();
  await page.getByRole("button", { name: "Previous month" }).click();
  await expect(finder.locator(".bchip")).toHaveCount(before);
  await expect(page.getByRole("button", { name: "Try again" })).toHaveCount(0);
  // × closes the hint above the grid, leaving an "i" in the toolbar (the text stays for screen
  // readers); it stays closed after a reload.
  const hint = page.locator(".hint");
  await page.getByRole("button", { name: "Close hint" }).click();
  await expect(hint).toHaveCount(0);
  await page.reload();
  await expect(page.locator(".month-nav").getByRole("button", { name: "Show hint" })).toBeVisible();
  await expect(hint).toHaveCount(0);
  await page.getByRole("button", { name: "Show hint" }).click();
  await expect(hint).toBeVisible();
});

test("phone: a day's summary opens right under the tapped day, in view; closing doesn't scroll", async ({ browser }) => {
  const email = uniqueEmail("sum");
  createUser(email, "Ivo", true);
  const page = await (
    await browser.newContext({ locale: "en-US", viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })
  ).newPage();
  await signIn(page, email);
  const res = await page.request.post("/api/groups", {
    data: { name: `Sum ${Date.now()}` },
    headers: { Origin: new URL(page.url()).origin },
  });
  await page.goto(`/g/${(await res.json()).id}/group`);
  await page.getByRole("button", { name: "EN", exact: true }).click();
  await page.getByRole("button", { name: "Next month" }).click();

  // A day in the last week of next month: low on the page.
  const day = addMonths(todayBerlin(), 1).slice(0, 8) + "26";
  const cellOf = page.locator(`.cell[data-day="${day}"]`);
  // Focus starts far up the page (a tap on the day doesn't take it), where closing gives it back.
  await page.locator("a.brand").focus();
  await cellOf.scrollIntoViewIfNeeded();
  await cellOf.tap();
  const summary = page.getByRole("dialog");
  await expect(summary).toBeVisible();
  const c = (await cellOf.boundingBox())!;
  const s = (await summary.boundingBox())!;
  expect(s.y).toBeGreaterThanOrEqual(c.y + c.height);
  expect(s.y - (c.y + c.height)).toBeLessThan(16);
  // Scrolled into view.
  await expect.poll(async () => {
    const box = (await summary.boundingBox())!;
    return box.y + box.height;
  }).toBeLessThanOrEqual(844);

  // Closing leaves the page where it is.
  const scrolled = await page.evaluate<number>("window.scrollY");
  await summary.getByRole("button", { name: "Close" }).tap();
  await expect(summary).toHaveCount(0);
  expect(await page.evaluate<number>("window.scrollY")).toBe(scrolled);
});
