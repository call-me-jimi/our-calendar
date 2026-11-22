import { expect, test } from "vitest";

import { indexMarks, type GroupEvent, type GroupMark } from "./groupResult";
import { matchingRuns, periodRange, runsByMonth, type RunFilter } from "./matchingRuns";

// March 2026: Mon 9 … Fri 13, Sat 14, Sun 15, … Fri 20, Sat 21, … Fri 27, Sat 28, Sun 29.
const mark = (user_id: number, day: string, state: "busy" | "maybe"): GroupMark => ({
  user_id,
  day,
  state,
  note: null,
  set_by_name: null,
  set_by_former: false,
});
const ALL = [0, 1, 2, 3, 4, 5, 6];
const base: RunFilter = { from: "2026-03-09", to: "2026-03-29", length: 1, weekdays: ALL, maybeCountsAsFree: false };

test.each([
  {
    name: "Fr+Sa runs of 2 skip a week where Saturday is busy",
    filter: { length: 2, weekdays: [4, 5] },
    marks: [mark(2, "2026-03-21", "busy")],
    want: ["2026-03-13", "2026-03-27"],
  },
  {
    name: "length 3 never crosses an unchosen weekday",
    filter: { length: 3, weekdays: [0, 1, 2, 4, 5, 6], to: "2026-03-15" }, // no Thursday
    marks: [],
    want: ["2026-03-09", "2026-03-13"],
  },
  {
    name: "maybe off: a maybe day breaks the run",
    filter: { length: 2, to: "2026-03-12" },
    marks: [mark(1, "2026-03-10", "maybe")],
    want: ["2026-03-11"],
  },
  {
    name: "maybe on: a maybe day counts as free",
    filter: { length: 2, to: "2026-03-12", maybeCountsAsFree: true },
    marks: [mark(1, "2026-03-10", "maybe")],
    want: ["2026-03-09", "2026-03-10", "2026-03-11"],
  },
  {
    name: "maybe on: busy still breaks the run",
    filter: { length: 2, to: "2026-03-12", maybeCountsAsFree: true },
    marks: [mark(1, "2026-03-10", "busy")],
    want: ["2026-03-11"],
  },
  {
    name: "the period end cuts a run",
    filter: { length: 2, weekdays: [4, 5], to: "2026-03-27" },
    marks: [],
    want: ["2026-03-13", "2026-03-20"],
  },
  {
    name: "marks of non-members are ignored",
    filter: { to: "2026-03-10" },
    marks: [mark(99, "2026-03-09", "busy")],
    want: ["2026-03-09", "2026-03-10"],
  },
] satisfies { name: string; filter: Partial<RunFilter>; marks: GroupMark[]; want: string[] }[])(
  "$name",
  ({ filter, marks, want }) => {
    expect(matchingRuns({ ...base, ...filter }, indexMarks(marks), [1, 2], []).map((r) => r.start)).toEqual(want);
  },
);

test("an event day breaks a run", () => {
  const events: GroupEvent[] = [{ id: 1, title: "Probe", start_day: "2026-03-11", end_day: "2026-03-11" }];
  expect(matchingRuns({ ...base, length: 2, to: "2026-03-13" }, indexMarks([]), [1, 2], events)).toEqual([
    { start: "2026-03-09", end: "2026-03-10" },
    { start: "2026-03-12", end: "2026-03-13" },
  ]);
});

test.each([
  { name: "1 month", period: { months: 1 }, want: { from: "2026-11-20", to: "2026-12-19" } },
  { name: "12 months", period: { months: 12 }, want: { from: "2026-11-20", to: "2027-11-19" } },
  {
    name: "custom period clamped to the editable window",
    period: { from: "2026-10-01", to: "2028-01-01" },
    want: { from: "2026-11-20", to: "2027-11-20" },
  },
  {
    name: "reversed custom period",
    period: { from: "2027-02-01", to: "2026-12-24" },
    want: { from: "2026-12-24", to: "2027-02-01" },
  },
] satisfies { name: string; period: Parameters<typeof periodRange>[1]; want: { from: string; to: string } }[])(
  "period: $name",
  ({ period, want }) => {
    expect(periodRange("2026-11-20", period)).toEqual(want);
  },
);

test("runs are grouped by the month they start in, in order", () => {
  const runs = [
    { start: "2026-11-27", end: "2026-11-28" },
    { start: "2026-11-30", end: "2026-12-01" },
    { start: "2026-12-04", end: "2026-12-05" },
    { start: "2027-01-01", end: "2027-01-02" },
  ];
  expect(runsByMonth(runs)).toEqual([
    { month: "2026-11", runs: runs.slice(0, 2) },
    { month: "2026-12", runs: [runs[2]] },
    { month: "2027-01", runs: [runs[3]] },
  ]);
  expect(runsByMonth([])).toEqual([]);
});
