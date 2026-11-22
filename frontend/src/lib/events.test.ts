import { describe, expect, it } from "vitest";

import { monthGrid } from "./days";
import { rowSegments } from "./events";
import type { GroupEvent } from "./groupResult";

const ev = (id: number, start_day: string, end_day: string): GroupEvent => ({ id, title: `E${id}`, start_day, end_day });
const brief = (segs: ReturnType<typeof rowSegments>[number]) =>
  segs.map((s) => ({ id: s.event.id, col: s.col, span: s.span, lane: s.lane, starts: s.starts, ends: s.ends }));

// March 2027 starts on a Monday: weeks are 1–7, 8–14, 15–21, 22–28, 29–31.
const march = monthGrid({ year: 2027, month: 3 });

describe("rowSegments", () => {
  it("splits an event across week rows, rounding only its real start and end", () => {
    const rows = rowSegments(march, [ev(1, "2027-03-05", "2027-03-16")]);
    expect(rows.map(brief)).toEqual([
      [{ id: 1, col: 4, span: 3, lane: 0, starts: true, ends: false }],
      [{ id: 1, col: 0, span: 7, lane: 0, starts: false, ends: false }],
      [{ id: 1, col: 0, span: 2, lane: 0, starts: false, ends: true }],
      [],
      [],
    ]);
  });

  it("clips at the month's edges (padding cells are null)", () => {
    const rows = rowSegments(march, [ev(1, "2027-02-26", "2027-03-02"), ev(2, "2027-03-30", "2027-04-03")]);
    expect(brief(rows[0]!)).toEqual([{ id: 1, col: 0, span: 2, lane: 0, starts: false, ends: true }]);
    expect(brief(rows[4]!)).toEqual([{ id: 2, col: 1, span: 2, lane: 0, starts: true, ends: false }]);
  });

  it("stacks overlapping events in lanes and reuses a free lane", () => {
    const rows = rowSegments(march, [
      ev(3, "2027-03-11", "2027-03-11"),
      ev(1, "2027-03-08", "2027-03-10"),
      ev(2, "2027-03-09", "2027-03-12"),
    ]);
    expect(brief(rows[1]!).map(({ id, lane }) => ({ id, lane }))).toEqual([
      { id: 1, lane: 0 },
      { id: 2, lane: 1 },
      { id: 3, lane: 0 },
    ]);
  });

  it("works on a single row of days", () => {
    const days = ["2027-03-01", "2027-03-02", "2027-03-03"];
    expect(brief(rowSegments([days], [ev(1, "2027-03-02", "2027-03-02")])[0]!)).toEqual([
      { id: 1, col: 1, span: 1, lane: 0, starts: true, ends: true },
    ]);
  });
});
