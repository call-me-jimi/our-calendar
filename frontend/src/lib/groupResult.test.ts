import { expect, test } from "vitest";
import {
  dayResult,
  indexMarks,
  resultsForRange,
  setByLabel,
  type GroupEvent,
  type GroupMark,
} from "./groupResult";

const mark = (user_id: number, day: string, state: "busy" | "maybe"): GroupMark => ({
  user_id,
  day,
  state,
  note: null,
  set_by_name: null,
  set_by_former: false,
});
const event: GroupEvent = { id: 7, title: "Trip", start_day: "2026-03-10", end_day: "2026-03-12" };
const members = [3, 1, 2];

test.each([
  { name: "everyone free", marks: [], events: [], want: { kind: "free", busy: [], maybe: [] } },
  {
    name: "only maybe → light green",
    marks: [mark(2, "2026-03-11", "maybe"), mark(1, "2026-03-11", "maybe")],
    events: [],
    want: { kind: "maybe", busy: [], maybe: [1, 2] },
  },
  {
    name: "one busy wins over maybe",
    marks: [mark(3, "2026-03-11", "busy"), mark(1, "2026-03-11", "maybe")],
    events: [],
    want: { kind: "busy", busy: [3], maybe: [1] },
  },
  {
    name: "event takes precedence, counts still filled",
    marks: [mark(3, "2026-03-11", "busy"), mark(1, "2026-03-11", "maybe")],
    events: [event],
    want: { kind: "event", events: [event], busy: [3], maybe: [1] },
  },
  {
    name: "non-member marks are ignored",
    marks: [mark(99, "2026-03-11", "busy"), mark(98, "2026-03-11", "maybe")],
    events: [],
    want: { kind: "free", busy: [], maybe: [] },
  },
  {
    name: "marks on other days are ignored",
    marks: [mark(1, "2026-03-12", "busy")],
    events: [],
    want: { kind: "free", busy: [], maybe: [] },
  },
])("dayResult: $name", ({ marks, events, want }) => {
  expect(dayResult("2026-03-11", members, indexMarks(marks), events)).toEqual(want);
});

test("event covers start and end day inclusive, not outside", () => {
  const index = indexMarks([]);
  expect(dayResult("2026-03-09", members, index, [event]).kind).toBe("free");
  expect(dayResult("2026-03-10", members, index, [event]).kind).toBe("event");
  expect(dayResult("2026-03-12", members, index, [event]).kind).toBe("event");
  expect(dayResult("2026-03-13", members, index, [event]).kind).toBe("free");
});

test("resultsForRange returns one result per day of the inclusive range", () => {
  const results = resultsForRange("2026-03-08", "2026-03-11", members, [mark(1, "2026-03-09", "busy")], [event]);
  expect([...results.keys()]).toEqual(["2026-03-08", "2026-03-09", "2026-03-10", "2026-03-11"]);
  expect([...results.values()].map((r) => r.kind)).toEqual(["free", "busy", "event", "event"]);
});

test("setByLabel: own mark, someone else's, and a deleted setter", () => {
  const own = mark(1, "2026-03-09", "busy");
  expect(setByLabel(undefined, "former")).toBeNull();
  expect(setByLabel(own, "former")).toBeNull();
  expect(setByLabel({ ...own, set_by_name: "Ada" }, "former")).toBe("Ada");
  expect(setByLabel({ ...own, set_by_former: true }, "former")).toBe("former");
});
