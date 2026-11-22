import { expect, test, type Page } from "@playwright/test";

import { createUser, signIn, uniqueEmail } from "./helpers";

/** A day in the month after the current one (Berlin), always inside the editable window. */
function nextMonthDay(d: number): string {
  const now = new Date(new Date().toLocaleString("en-US", { timeZone: "Europe/Berlin" }));
  const y = now.getMonth() === 11 ? now.getFullYear() + 1 : now.getFullYear();
  const m = ((now.getMonth() + 1) % 12) + 1;
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

const cell = (page: Page, day: string) => page.locator(`[data-day="${day}"]`);

async function adminWithGroup(page: Page): Promise<number> {
  const email = uniqueEmail("cal");
  createUser(email, "Ivo", true);
  await signIn(page, email);
  const origin = new URL(page.url()).origin;
  const res = await page.request.post("/api/groups", {
    data: { name: `Cal ${Date.now()}` },
    headers: { Origin: origin },
  });
  return (await res.json()).id;
}

// The P8 step 5 check (plan.md).
test("desktop: drag a range, choose Busy, reload; a busy day offers Maybe / Free again; undo", async ({ browser }) => {
  const page = await (
    await browser.newContext({ locale: "en-US", viewport: { width: 1280, height: 900 } })
  ).newPage();
  const gid = await adminWithGroup(page);
  await page.goto(`/g/${gid}/days`);
  await page.getByRole("button", { name: "EN", exact: true }).click();
  const busy = page.locator(".cell.own-busy");

  const from = nextMonthDay(3);
  const to = nextMonthDay(10);
  const a = await cell(page, from).boundingBox();
  const b = await cell(page, to).boundingBox();
  await page.mouse.move(a!.x + a!.width / 2, a!.y + a!.height / 2);
  await page.mouse.down();
  await page.mouse.move(b!.x + b!.width / 2, b!.y + b!.height / 2, { steps: 8 });
  await page.mouse.up();

  await expect(page.locator(".cell.selected")).toHaveCount(8);
  const sheet = page.getByRole("dialog");
  await expect(sheet).toContainText("8 days selected");
  await expect(sheet).toContainText("Can't you make these days?");
  await sheet.getByRole("button", { name: /^Busy/ }).click();
  await expect(busy).toHaveCount(8);
  await expect(sheet).toHaveCount(0);
  await expect(page.getByText("8 days marked as busy")).toBeVisible();

  // Saved on the server: still there after a reload.
  await page.reload();
  await expect(busy).toHaveCount(8);

  // A busy day only offers Maybe and Free again; Free again clears it, Undo brings it back.
  await cell(page, from).click();
  await expect(sheet).toContainText("Change this mark?");
  await expect(sheet.locator(".choice")).toHaveText([/^Maybe/, /^Free again/]);
  await sheet.getByRole("button", { name: /^Free again/ }).click();
  await expect(busy).toHaveCount(7);
  await page.getByRole("button", { name: "Undo" }).click();
  await expect(busy).toHaveCount(8);

  // A group admin alone in the group has no "Marking for" picker.
  await expect(page.getByText("Marking for")).toHaveCount(0);
});

test("phone: tap three days, Maybe with a note; undo restores", async ({ browser }) => {
  const ctx = await browser.newContext({
    locale: "en-US",
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
  });
  const page = await ctx.newPage();
  const gid = await adminWithGroup(page);
  await page.goto(`/g/${gid}/days`);
  await page.getByRole("button", { name: "EN", exact: true }).click();
  const maybe = page.locator(".cell.own-maybe");

  await page.getByRole("button", { name: "Next month" }).click();
  for (const d of [12, 13, 14]) await cell(page, nextMonthDay(d)).tap();
  await expect(page.locator(".cell.selected")).toHaveCount(3);
  await expect(page.getByText("3 days selected. Tap more days or say below what applies.")).toBeVisible();

  const sheet = page.getByRole("dialog");
  await sheet.getByRole("textbox", { name: "Note" }).fill("only after 7 pm");
  await sheet.getByRole("button", { name: /^Maybe/ }).tap();
  await expect(maybe).toHaveCount(3);
  await expect(cell(page, nextMonthDay(12)).locator(".note-icon")).toBeVisible();
  await expect(cell(page, nextMonthDay(12))).toHaveAttribute("title", /only after 7 pm/);

  await page.getByRole("button", { name: "Undo" }).tap();
  await expect(maybe).toHaveCount(0);
  await page.reload();
  await page.getByRole("button", { name: "Next month" }).click();
  await expect(cell(page, nextMonthDay(12))).toBeVisible();
  await expect(maybe).toHaveCount(0);
});

test("the intro card shows on the first visit only; ? brings it back with the keyboard help", async ({ browser }) => {
  const page = await (
    await browser.newContext({ locale: "en-US", viewport: { width: 1280, height: 900 } })
  ).newPage();
  const gid = await adminWithGroup(page);
  await page.goto(`/g/${gid}/days`);
  await page.getByRole("button", { name: "EN", exact: true }).click();

  const intro = page.getByRole("heading", { name: "How it works" });
  await expect(intro).toBeVisible();
  await page.getByRole("button", { name: "Got it" }).click();
  await expect(intro).toHaveCount(0);
  await page.reload();
  await expect(page.locator(".cell[data-day]").first()).toBeVisible();
  await expect(intro).toHaveCount(0);

  await page.getByRole("button", { name: "Help" }).click();
  await expect(intro).toBeVisible();
  await expect(page.getByText("Keyboard:")).toBeVisible();
});

test("a group admin marks days for a member, who sees set by", async ({ browser }) => {
  const page = await (
    await browser.newContext({ locale: "en-US", viewport: { width: 1280, height: 900 } })
  ).newPage();
  const gid = await adminWithGroup(page);
  const origin = new URL(page.url()).origin;
  const invite = await (
    await page.request.post(`/api/groups/${gid}/invites`, { headers: { Origin: origin } })
  ).json();

  // A member joins (signed in through the CLI-created account).
  const memberEmail = uniqueEmail("mia");
  createUser(memberEmail, "Mia");
  const member = await (await browser.newContext({ locale: "en-US" })).newPage();
  await signIn(member, memberEmail);
  await member.getByRole("button", { name: "EN", exact: true }).click();
  await member.goto(invite.url);
  await member.getByRole("button", { name: "Join" }).click();
  await expect(member).toHaveURL(/\/days$/);
  await expect(member.getByText("Marking for")).toHaveCount(0);

  await page.goto(`/g/${gid}/days`);
  await page.getByRole("button", { name: "EN", exact: true }).click();
  await page.getByLabel("Marking for").selectOption({ label: "Mia" });
  await cell(page, nextMonthDay(5)).click();
  await page.getByRole("dialog").getByRole("button", { name: /^Busy/ }).click();
  await expect(cell(page, nextMonthDay(5))).toHaveClass(/own-busy/);
  await expect(page.getByText("1 day marked as busy (Mia)")).toBeVisible();

  // Mia sees it as hers, set by Ivo.
  await member.reload();
  await expect(cell(member, nextMonthDay(5))).toHaveClass(/own-busy/);
  await cell(member, nextMonthDay(5)).click();
  await expect(member.getByRole("dialog")).toContainText("set by Ivo");
});

test("× closes the hint on Meine Tage for good; dragging then selects the right days", async ({ browser }) => {
  const page = await (
    await browser.newContext({ locale: "en-US", viewport: { width: 1280, height: 900 } })
  ).newPage();
  const gid = await adminWithGroup(page);
  await page.goto(`/g/${gid}/days`);
  await page.getByRole("button", { name: "EN", exact: true }).click();
  await page.getByRole("button", { name: "Got it" }).click(); // the first visit's intro card

  const hint = page.locator(".hint");
  await expect(hint).toBeVisible();
  await page.getByRole("button", { name: "Close hint" }).click();
  await expect(hint).toHaveCount(0);
  await page.reload();
  await expect(page.locator(".cell[data-day]").first()).toBeVisible();
  await expect(hint).toHaveCount(0);

  // A drag selects exactly the days it went over: the hint doesn't pop up and push the grid down.
  const open = page.locator(".cell[data-day]:not(.past)");
  const [a, b] = [open.nth(7), open.nth(9)];
  const [boxA, boxB] = [(await a.boundingBox())!, (await b.boundingBox())!];
  await page.mouse.move(boxA.x + boxA.width / 2, boxA.y + boxA.height / 2);
  await page.mouse.down();
  await page.mouse.move(boxB.x + boxB.width / 2, boxB.y + boxB.height / 2, { steps: 5 });
  await page.mouse.up();
  await expect(page.getByRole("dialog")).toContainText("3 days selected");
  await expect(hint).toHaveCount(0);
  await page.keyboard.press("Escape");

  await page.getByRole("button", { name: "Show hint" }).click();
  await expect(hint).toBeVisible();
});

test("phone: the day panel opens right under the first day's week and covers no day; more taps add days", async ({
  browser,
}) => {
  const page = await (
    await browser.newContext({ locale: "en-US", viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })
  ).newPage();
  const gid = await adminWithGroup(page);
  await page.goto(`/g/${gid}/days`);
  await page.getByRole("button", { name: "EN", exact: true }).click();
  await page.getByRole("button", { name: "Got it" }).click(); // the first visit's intro card
  await page.getByRole("button", { name: "Next month" }).click();

  const [a, b, c] = [nextMonthDay(8), nextMonthDay(17), nextMonthDay(28)];
  const tap = async (day: string) => {
    await cell(page, day).scrollIntoViewIfNeeded();
    const box = (await cell(page, day).boundingBox())!;
    await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
  };

  await tap(a);
  const panel = page.getByRole("dialog");
  await expect(panel).toBeVisible();
  // Right under the tapped day's row, inside the calendar.
  const dayBox = (await cell(page, a).boundingBox())!;
  const panelBox = (await panel.boundingBox())!;
  expect(panelBox.y).toBeGreaterThanOrEqual(dayBox.y + dayBox.height);
  expect(panelBox.y - (dayBox.y + dayBox.height)).toBeLessThan(24);

  // Days below the panel can be tapped: it doesn't lie over them.
  await tap(b);
  await tap(c);
  await expect(panel).toContainText("3 days selected");
  const after = (await panel.boundingBox())!;
  for (const day of [b, c]) {
    const box = (await cell(page, day).boundingBox())!;
    const overlaps = box.y < after.y + after.height && box.y + box.height > after.y;
    expect(overlaps, `${day} under the panel`).toBe(false);
  }
});

test("phone: hold a day, then drag, selects the days in between; a quick swipe scrolls instead", async ({
  browser,
}) => {
  const page = await (
    await browser.newContext({ locale: "en-US", viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })
  ).newPage();
  const gid = await adminWithGroup(page);
  await page.goto(`/g/${gid}/days`);
  await page.getByRole("button", { name: "EN", exact: true }).click();
  await page.getByRole("button", { name: "Got it" }).click(); // the first visit's intro card
  await page.getByRole("button", { name: "Next month" }).click();

  // Real touch input (Chromium's DevTools protocol): Playwright's touchscreen only taps.
  const cdp = await page.context().newCDPSession(page);
  const touch = async (type: "touchStart" | "touchMove" | "touchEnd", x = 0, y = 0) => {
    await cdp.send("Input.dispatchTouchEvent", { type, touchPoints: type === "touchEnd" ? [] : [{ x, y }] });
    if (type === "touchMove") await page.waitForTimeout(16); // about a frame, like a finger
  };
  const center = async (day: string) => {
    const b = (await cell(page, day).boundingBox())!;
    return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
  };
  const scrollY = () => page.evaluate<number>("window.scrollY");
  const panel = page.getByRole("dialog");
  const [a, d] = [nextMonthDay(9), nextMonthDay(12)];
  await page.evaluate("window.scrollTo(0, 200)"); // room to scroll both ways

  // A quick swipe down: the page scrolls, nothing is selected.
  const p = await center(a);
  const y0 = await scrollY();
  await touch("touchStart", p.x, p.y);
  for (let i = 1; i <= 6; i++) await touch("touchMove", p.x, p.y + i * 25);
  await touch("touchEnd");
  await expect.poll(scrollY).not.toBe(y0);
  await expect(panel).toHaveCount(0);

  // Hold, then drag from the 9th to the 12th: four days, and the page stays put meanwhile.
  let settled = -1; // the swipe's momentum first
  await expect
    .poll(async () => {
      const now = await scrollY();
      const same = now === settled;
      settled = now;
      return same;
    })
    .toBe(true);
  await cell(page, a).scrollIntoViewIfNeeded();
  const [from, to] = [await center(a), await center(d)];
  const y1 = await scrollY();
  await touch("touchStart", from.x, from.y);
  await page.waitForTimeout(500);
  for (let i = 1; i <= 8; i++) {
    await touch("touchMove", from.x + ((to.x - from.x) * i) / 8, from.y + ((to.y - from.y) * i) / 8);
  }
  expect(await scrollY()).toBe(y1);
  await expect(panel).toHaveCount(0); // not while the finger is down: it would push the weeks
  await touch("touchEnd");
  await expect(panel).toContainText("4 days selected");

  // A hold without moving selects just that day, like a tap.
  await panel.getByRole("button", { name: "Clear selection" }).click();
  const one = await center(nextMonthDay(20));
  await touch("touchStart", one.x, one.y);
  await page.waitForTimeout(500);
  await touch("touchEnd");
  await expect(panel).toBeVisible();
  await expect(page.locator(".cell[aria-pressed=true]")).toHaveCount(1);
});
