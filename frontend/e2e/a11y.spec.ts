import AxeBuilder from "@axe-core/playwright";
import {
  expect,
  test,
  type Browser,
  type BrowserContext,
  type BrowserContextOptions,
  type Page,
} from "@playwright/test";

import { addDays, todayBerlin, type Day } from "../src/lib/days";
import { createUser, signIn, uniqueEmail } from "./helpers";

// The P6 phase check (plan.md): no serious or critical axe violations on Meine Tage and Gruppe (both layouts, summary open),
// desktop and phone, light and dark; plus keyboard marking in Meine Tage.

const DESKTOP: BrowserContextOptions = { locale: "en-US", viewport: { width: 1280, height: 900 } };
const PHONE: BrowserContextOptions = {
  locale: "en-US",
  viewport: { width: 390, height: 844 },
  hasTouch: true,
  isMobile: true,
};
const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"];

type Setup = { gid: number; storage: Awaited<ReturnType<BrowserContext["storageState"]>> };

/** Ivo (admin) and Anna in a group with BE + BB holidays, marks (one with a note) and an event. */
async function setup(browser: Browser): Promise<Setup> {
  const ivoEmail = uniqueEmail("a11y-ivo");
  createUser(ivoEmail, "Ivo", true);
  const ctx = await browser.newContext(DESKTOP);
  const ivo = await ctx.newPage();
  await signIn(ivo, ivoEmail);
  await ivo.getByRole("button", { name: "EN", exact: true }).click();
  const headers = { Origin: new URL(ivo.url()).origin };
  const { id: gid } = await (await ivo.request.post("/api/groups", { data: { name: `A11y ${Date.now()}` }, headers })).json();
  expect((await ivo.request.patch(`/api/groups/${gid}`, { data: { regions: ["DE-BE", "DE-BB"] }, headers })).ok()).toBe(true);
  const invite = await (await ivo.request.post(`/api/groups/${gid}/invites`, { headers })).json();

  const annaEmail = uniqueEmail("a11y-anna");
  createUser(annaEmail, "Anna");
  const annaCtx = await browser.newContext(DESKTOP);
  const anna = await annaCtx.newPage();
  await signIn(anna, annaEmail);
  await anna.goto(invite.url);
  await anna.getByRole("button", { name: /Join|Beitreten/ }).click();
  await expect(anna).toHaveURL(/\/days$/);

  const today = todayBerlin();
  const put = async (p: Page, days: { day: Day; state: "busy" | "maybe"; note: string | null }[]) => {
    const me = await (await p.request.get("/api/me")).json();
    const res = await p.request.put("/api/marks", { data: { user_id: me.id, group_id: gid, days }, headers });
    expect(res.ok()).toBe(true);
  };
  await put(ivo, [
    { day: addDays(today, 1), state: "busy", note: null },
    { day: addDays(today, 2), state: "busy", note: null },
    { day: addDays(today, 5), state: "maybe", note: "only after 7 pm" },
  ]);
  await put(anna, [
    { day: addDays(today, 2), state: "busy", note: null },
    { day: addDays(today, 6), state: "maybe", note: null },
  ]);
  const event = { title: "Gig at Lido", start_day: addDays(today, 3), end_day: addDays(today, 4), time_place: "8 pm", note: null };
  expect((await ivo.request.post(`/api/groups/${gid}/events`, { data: event, headers })).ok()).toBe(true);

  const storage = await ctx.storageState();
  await annaCtx.close();
  await ctx.close();
  return { gid, storage };
}

async function expectNoSeriousViolations(page: Page, what: string) {
  // A popover that is still fading in has its text at partial opacity, which axe reads as low contrast.
  await page
    .locator("body")
    .evaluate((body) => Promise.all(body.getAnimations({ subtree: true }).map((a: { finished: Promise<unknown> }) => a.finished)));
  const { violations } = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  const serious = violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  const report = serious.map((v) => `${v.id} (${v.impact}): ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`);
  expect(report, what).toEqual([]);
}

test("axe: Meine Tage and Gruppe, desktop and phone, light and dark", async ({ browser }) => {
  test.setTimeout(120_000);
  const { gid, storage } = await setup(browser);

  for (const [device, options] of [["desktop", DESKTOP], ["phone", PHONE]] as const) {
    const ctx = await browser.newContext({ ...options, storageState: storage });
    const page = await ctx.newPage();
    for (const colorScheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme });

      await page.goto(`/g/${gid}/days`);
      await expect(page.locator(".cell[data-day]").first()).toBeVisible();
      await page.waitForLoadState("networkidle"); // marks, events and holidays are in
      await expectNoSeriousViolations(page, `my days ${device} ${colorScheme}`);

      await page.goto(`/g/${gid}/group`);
      await expect(page.locator(".finder .bchip").first()).toBeVisible();
      await page.waitForLoadState("networkidle");
      await expectNoSeriousViolations(page, `gruppe calendar ${device} ${colorScheme}`);

      await page.goto(`/g/${gid}/group?layout=table`);
      await expect(page.locator('tr[data-member="Anna"]')).toBeVisible();
      await page.waitForLoadState("networkidle");
      await expectNoSeriousViolations(page, `gruppe table ${device} ${colorScheme}`);
      // The day summary (a popover; full width under the day on phones) on a day with a note.
      const noted = addDays(todayBerlin(), 5);
      if (noted.slice(0, 7) !== todayBerlin().slice(0, 7)) await page.getByRole("button", { name: "Next month" }).click();
      await page.locator(`tr.sum td[data-day="${noted}"]`).click();
      await expect(page.getByRole("dialog")).toContainText("only after 7 pm");
      await expect(page.getByRole("dialog")).toBeFocused();
      await expectNoSeriousViolations(page, `day summary ${device} ${colorScheme}`);
      await page.keyboard.press("Escape");
      await expect(page.getByRole("dialog")).toHaveCount(0);
      // Another month, e.g. December: holidays and the Schulferien ribbon in the header.
      await page.getByRole("button", { name: "Next month" }).click();
      await page.waitForLoadState("networkidle");
      await expectNoSeriousViolations(page, `gruppe table next month ${device} ${colorScheme}`);
    }
    await ctx.close();
  }

  // The marking sheet (opened by keyboard) is a labelled dialog with the day's note.
  const ctx = await browser.newContext({ ...DESKTOP, storageState: storage });
  const page = await ctx.newPage();
  await page.goto(`/g/${gid}/days`);
  const day = addDays(todayBerlin(), 5);
  await page.locator(`.cell[data-day="${day}"]`).focus();
  await page.keyboard.press("Space");
  const dialog = page.getByRole("dialog");
  await expect(dialog).toHaveAccessibleName(/\d/);
  await expect(dialog.getByRole("textbox", { name: "Note" })).toHaveValue("only after 7 pm");
  await expectNoSeriousViolations(page, "marking sheet");
  await ctx.close();
});

/** A day in the month after the current one (Berlin), always inside the editable window. */
function nextMonthDay(d: number): Day {
  const [y, m] = todayBerlin().split("-").map(Number) as [number, number];
  const next = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
  return `${next}-${String(d).padStart(2, "0")}`;
}

test("keyboard: space selects, shift+arrows add a range, B / V / Delete apply, escape clears, ctrl+z undoes", async ({
  browser,
}) => {
  const email = uniqueEmail("kbd");
  createUser(email, "Ivo", true);
  const page = await (await browser.newContext(DESKTOP)).newPage();
  await signIn(page, email);
  await page.getByRole("button", { name: "EN", exact: true }).click();
  const origin = new URL(page.url()).origin;
  const { id: gid } = await (
    await page.request.post("/api/groups", { data: { name: `Kbd ${Date.now()}` }, headers: { Origin: origin } })
  ).json();
  await page.goto(`/g/${gid}/days`);

  const cell = (d: number) => page.locator(`.cell[data-day="${nextMonthDay(d)}"]`);
  const selected = page.locator(".cell.selected");
  const busy = page.locator(".cell.own-busy");
  const maybe = page.locator(".cell.own-maybe");

  // Space selects the focused day and opens the sheet; the focus stays in the grid; B marks it busy.
  await cell(10).focus();
  await page.keyboard.press("Space");
  await expect(cell(10)).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(cell(10)).toBeFocused();
  await page.keyboard.press("b");
  await expect(cell(10)).toHaveClass(/own-busy/);
  await expect(cell(10)).toHaveAttribute("aria-label", /you: busy/);
  await expect(page.getByText("1 day marked as busy")).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);

  // → moves; Shift + → → shows the range as selected, letting go of Shift keeps it; V marks it maybe.
  await page.keyboard.press("ArrowRight");
  await expect(cell(11)).toBeFocused();
  await page.keyboard.down("Shift");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  await expect(selected).toHaveCount(3);
  await page.keyboard.up("Shift");
  await expect(selected).toHaveCount(3);
  await page.keyboard.press("v");
  await expect(maybe).toHaveCount(3);
  await expect(page.getByText("3 days marked as maybe")).toBeVisible();

  // Ctrl+Z undoes the last action (the range).
  await page.keyboard.press("Control+z");
  await expect(maybe).toHaveCount(0);
  await expect(busy).toHaveCount(1);

  // Escape clears a selection without marking anything; Delete frees the selected days.
  await page.keyboard.press("Space");
  await expect(selected).toHaveCount(1);
  await page.keyboard.press("Escape");
  await expect(selected).toHaveCount(0);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await cell(10).focus();
  await page.keyboard.press("Space");
  await page.keyboard.press("Delete");
  await expect(busy).toHaveCount(0);
  await expect(page.getByText("1 day free again")).toBeVisible();
});
