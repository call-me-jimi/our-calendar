import { expect, test } from "vitest";

import {
  addDays,
  addMonths,
  addYearMonth,
  compareDays,
  daysBetween,
  expandRange,
  firstDay,
  inWindow,
  isDay,
  lastDay,
  monthGrid,
  previousOf,
  todayBerlin,
  weekday,
  windowEnd,
  yearMonthOf,
  type Day,
  type DayChange,
  type Mark,
} from "./days";
import { changesFor } from "./selection";

function marks(...list: Mark[]): Map<Day, Mark> {
  return new Map(list.map((m) => [m.day, m]));
}

function apply(current: ReadonlyMap<Day, Mark>, changes: DayChange[]): Map<Day, Mark> {
  const next = new Map(current);
  for (const c of changes) {
    if (c.state === "free") next.delete(c.day);
    else next.set(c.day, { day: c.day, state: c.state, note: c.note });
  }
  return next;
}

// --- isDay ---

test("isDay accepts real dates", () => {
  expect(isDay("2026-11-18")).toBe(true);
  expect(isDay("2028-02-29")).toBe(true);
  expect(isDay("2026-12-31")).toBe(true);
});

test("isDay rejects impossible dates and loose formats", () => {
  expect(isDay("2026-02-30")).toBe(false);
  expect(isDay("2027-02-29")).toBe(false);
  expect(isDay("2026-13-01")).toBe(false);
  expect(isDay("2026-00-10")).toBe(false);
  expect(isDay("2026-04-31")).toBe(false);
  expect(isDay("2026-2-3")).toBe(false);
  expect(isDay("2026-02-03T00:00")).toBe(false);
  expect(isDay(" 2026-02-03")).toBe(false);
  expect(isDay("")).toBe(false);
});

// --- basic arithmetic ---

test("addDays crosses month and year boundaries", () => {
  expect(addDays("2026-01-31", 1)).toBe("2026-02-01");
  expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
  expect(addDays("2027-01-01", -1)).toBe("2026-12-31");
  expect(addDays("2028-02-28", 1)).toBe("2028-02-29");
  expect(addDays("2026-11-18", 0)).toBe("2026-11-18");
});

test("addDays and daysBetween are unaffected by DST changes", () => {
  expect(addDays("2027-03-27", 1)).toBe("2027-03-28");
  expect(addDays("2027-03-28", 1)).toBe("2027-03-29");
  expect(addDays("2027-10-30", 1)).toBe("2027-10-31");
  expect(addDays("2027-10-31", 1)).toBe("2027-11-01");
  expect(daysBetween("2027-03-22", "2027-04-04")).toBe(13);
  expect(daysBetween("2027-10-25", "2027-11-07")).toBe(13);
});

test("compareDays and daysBetween", () => {
  expect(compareDays("2026-11-18", "2026-11-19")).toBeLessThan(0);
  expect(compareDays("2026-11-19", "2026-11-18")).toBeGreaterThan(0);
  expect(compareDays("2026-11-18", "2026-11-18")).toBe(0);
  expect(daysBetween("2026-11-18", "2026-11-25")).toBe(7);
  expect(daysBetween("2026-11-25", "2026-11-18")).toBe(-7);
  expect(daysBetween("2026-01-01", "2027-01-01")).toBe(365);
  expect(daysBetween("2028-01-01", "2029-01-01")).toBe(366);
});

test("weekday is 0 = Monday … 6 = Sunday", () => {
  expect(weekday("2026-11-16")).toBe(0);
  expect(weekday("2026-11-18")).toBe(2);
  expect(weekday("2026-11-22")).toBe(6);
  expect(weekday("2028-02-01")).toBe(1);
});

// --- todayBerlin ---

test("todayBerlin uses the Berlin date around midnight UTC", () => {
  expect(todayBerlin(new Date("2026-11-18T23:30:00Z"))).toBe("2026-11-19"); // CET, +1
  expect(todayBerlin(new Date("2026-11-18T22:59:00Z"))).toBe("2026-11-18");
  expect(todayBerlin(new Date("2026-07-01T22:30:00Z"))).toBe("2026-07-02"); // CEST, +2
  expect(todayBerlin(new Date("2026-07-01T21:59:00Z"))).toBe("2026-07-01");
  expect(todayBerlin(new Date("2026-12-31T23:00:00Z"))).toBe("2027-01-01");
});

test("todayBerlin defaults to now and returns a valid day", () => {
  expect(isDay(todayBerlin())).toBe(true);
});

// --- months and window ---

test("addMonths clamps to the month end", () => {
  expect(addMonths("2027-01-31", 1)).toBe("2027-02-28");
  expect(addMonths("2028-01-31", 1)).toBe("2028-02-29");
  expect(addMonths("2028-02-29", 12)).toBe("2029-02-28");
  expect(addMonths("2026-10-31", 1)).toBe("2026-11-30");
  expect(addMonths("2026-11-18", 2)).toBe("2027-01-18");
  expect(addMonths("2027-01-15", -1)).toBe("2026-12-15");
  expect(addMonths("2027-03-31", -1)).toBe("2027-02-28");
});

test("windowEnd and inWindow", () => {
  expect(windowEnd("2026-11-18")).toBe("2027-11-18");
  expect(windowEnd("2028-02-29")).toBe("2029-02-28");
  expect(inWindow("2026-11-18", "2026-11-18")).toBe(true);
  expect(inWindow("2027-11-18", "2026-11-18")).toBe(true);
  expect(inWindow("2026-11-17", "2026-11-18")).toBe(false);
  expect(inWindow("2027-11-19", "2026-11-18")).toBe(false);
});

test("yearMonth helpers", () => {
  expect(yearMonthOf("2026-11-18")).toEqual({ year: 2026, month: 11 });
  expect(addYearMonth({ year: 2026, month: 11 }, 2)).toEqual({ year: 2027, month: 1 });
  expect(addYearMonth({ year: 2026, month: 1 }, -1)).toEqual({ year: 2025, month: 12 });
  expect(addYearMonth({ year: 2026, month: 1 }, -13)).toEqual({ year: 2024, month: 12 });
  expect(addYearMonth({ year: 2026, month: 5 }, 12)).toEqual({ year: 2027, month: 5 });
  expect(firstDay({ year: 2028, month: 2 })).toBe("2028-02-01");
  expect(lastDay({ year: 2028, month: 2 })).toBe("2028-02-29");
  expect(lastDay({ year: 2027, month: 2 })).toBe("2027-02-28");
  expect(lastDay({ year: 2026, month: 12 })).toBe("2026-12-31");
});

// --- expandRange ---

test("expandRange across a month boundary", () => {
  expect(expandRange("2026-11-29", "2026-12-02")).toEqual([
    "2026-11-29",
    "2026-11-30",
    "2026-12-01",
    "2026-12-02",
  ]);
});

test("expandRange across a year boundary", () => {
  expect(expandRange("2026-12-30", "2027-01-02")).toEqual([
    "2026-12-30",
    "2026-12-31",
    "2027-01-01",
    "2027-01-02",
  ]);
});

test("expandRange is order-independent and inclusive", () => {
  expect(expandRange("2026-12-02", "2026-11-29")).toEqual(expandRange("2026-11-29", "2026-12-02"));
  expect(expandRange("2026-11-18", "2026-11-18")).toEqual(["2026-11-18"]);
});

test("expandRange through DST weeks has no gaps or duplicates", () => {
  const spring = expandRange("2027-03-22", "2027-04-04");
  expect(spring).toHaveLength(14);
  expect(new Set(spring).size).toBe(14);
  expect(spring).toContain("2027-03-28");
  const autumn = expandRange("2027-10-25", "2027-11-07");
  expect(autumn).toHaveLength(14);
  expect(new Set(autumn).size).toBe(14);
  expect(autumn).toContain("2027-10-31");
  expect(autumn.at(-1)).toBe("2027-11-07");
});

// --- monthGrid ---

test("monthGrid for 2028-02 (leap year, starts Tuesday)", () => {
  const grid = monthGrid({ year: 2028, month: 2 });
  expect(grid).toHaveLength(5);
  for (const week of grid) expect(week).toHaveLength(7);
  expect(grid[0]).toEqual([
    null,
    "2028-02-01",
    "2028-02-02",
    "2028-02-03",
    "2028-02-04",
    "2028-02-05",
    "2028-02-06",
  ]);
  expect(grid[4]).toEqual(["2028-02-28", "2028-02-29", null, null, null, null, null]);
  expect(grid.flat().filter((d) => d !== null)).toHaveLength(29);
});

test("monthGrid for a month starting on Monday (2027-02, exactly 4 weeks)", () => {
  const grid = monthGrid({ year: 2027, month: 2 });
  expect(grid).toHaveLength(4);
  expect(grid[0]?.[0]).toBe("2027-02-01");
  expect(grid[3]?.[6]).toBe("2027-02-28");
  expect(grid.flat()).not.toContain(null);
});

test("monthGrid for a month ending on Sunday (2026-05) has no trailing null week", () => {
  const grid = monthGrid({ year: 2026, month: 5 });
  expect(grid).toHaveLength(5);
  expect(grid[0]).toEqual([null, null, null, null, "2026-05-01", "2026-05-02", "2026-05-03"]);
  expect(grid[4]?.[6]).toBe("2026-05-31");
  for (const week of grid) expect(week.some((d) => d !== null)).toBe(true);
});

test("monthGrid can need 6 weeks (2026-08 starts Saturday)", () => {
  const grid = monthGrid({ year: 2026, month: 8 });
  expect(grid).toHaveLength(6);
  expect(grid[0]?.[5]).toBe("2026-08-01");
  expect(grid[5]?.[0]).toBe("2026-08-31");
});

// --- previousOf ---

test("previousOf reports current state in the same order", () => {
  const current = marks({ day: "2026-11-21", state: "maybe", note: "x" });
  expect(previousOf(["2026-11-22", "2026-11-21"], current)).toEqual([
    { day: "2026-11-22", state: "free", note: null },
    { day: "2026-11-21", state: "maybe", note: "x" },
  ]);
});

test("applying previousOf restores the map (undo round trip)", () => {
  const before = marks(
    { day: "2026-11-28", state: "maybe", note: "Concert?" },
    { day: "2026-11-30", state: "busy", note: "Work" },
    { day: "2026-12-05", state: "busy", note: "Outside the range" },
  );
  for (const brush of ["busy", "maybe", "free"] as const) {
    const changes = changesFor(expandRange("2026-11-27", "2026-12-02"), brush, "", before);
    const undo = previousOf(
      changes.map((c) => c.day),
      before,
    );
    const after = apply(before, changes);
    expect(apply(after, undo)).toEqual(before);
  }
});
