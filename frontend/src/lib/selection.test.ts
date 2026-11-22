import { expect, test } from "vitest";

import type { Day, Mark, State } from "./days";
import { addRange, changesFor, choicesFor, dayParam, noteChanges, sharedState, toggleDay } from "./selection";

const TODAY = "2026-11-20";
const own = new Map<Day, Mark>([
  ["2026-12-01", { day: "2026-12-01", state: "busy", note: "Urlaub" }],
  ["2026-12-02", { day: "2026-12-02", state: "busy", note: null }],
  ["2026-12-03", { day: "2026-12-03", state: "maybe", note: "Evtl." }],
  ["2026-12-04", { day: "2026-12-04", state: "maybe", note: null }],
]);

test.each([
  { name: "unmarked", days: ["2026-12-10"], want: ["busy", "maybe"] },
  { name: "unmarked, several", days: ["2026-12-10", "2026-12-11"], want: ["busy", "maybe"] },
  { name: "all busy", days: ["2026-12-01", "2026-12-02"], want: ["maybe", "free"] },
  { name: "all maybe", days: ["2026-12-03", "2026-12-04"], want: ["busy", "free"] },
  { name: "busy + maybe", days: ["2026-12-01", "2026-12-03"], want: ["busy", "maybe", "free"] },
  { name: "busy + unmarked", days: ["2026-12-01", "2026-12-10"], want: ["busy", "maybe", "free"] },
] satisfies { name: string; days: Day[]; want: State[] }[])("choices: $name → $want", ({ days, want }) => {
  expect(choicesFor(days, own)).toEqual(want);
});

test("toggle adds and removes a day", () => {
  const one = toggleDay(new Set(), "2026-12-10", TODAY);
  expect([...one]).toEqual(["2026-12-10"]);
  expect([...toggleDay(one, "2026-12-10", TODAY)]).toEqual([]);
});

test("past days and days after the window are never selected", () => {
  expect([...toggleDay(new Set(), "2026-11-19", TODAY)]).toEqual([]);
  expect([...toggleDay(new Set(), "2027-11-21", TODAY)]).toEqual([]);
  expect([...toggleDay(new Set(), TODAY, TODAY)]).toEqual([TODAY]);
  expect([...addRange(new Set(), "2026-11-18", "2026-11-21", TODAY)]).toEqual([TODAY, "2026-11-21"]);
});

test("a reversed range across a month boundary adds every day, keeping the selection", () => {
  const selected = addRange(new Set(["2026-12-10"]), "2026-12-02", "2026-11-29", TODAY);
  expect([...selected].sort()).toEqual(["2026-11-29", "2026-11-30", "2026-12-01", "2026-12-02", "2026-12-10"]);
});

test("an empty note keeps each day's note", () => {
  expect(changesFor(["2026-12-01", "2026-12-03", "2026-12-10"], "maybe", " ", own)).toEqual([
    { day: "2026-12-01", state: "maybe", note: "Urlaub" },
    { day: "2026-12-10", state: "maybe", note: null },
  ]);
});

test("a typed note replaces the notes, trimmed and cut to 80 characters", () => {
  expect(changesFor(["2026-12-03", "2026-12-01"], "busy", "  Konzert ", own)).toEqual([
    { day: "2026-12-01", state: "busy", note: "Konzert" },
    { day: "2026-12-03", state: "busy", note: "Konzert" },
  ]);
  expect(changesFor(["2026-12-10"], "busy", "x".repeat(90), own)[0]?.note).toBe("x".repeat(80));
});

test("free removes the mark and its note; unmarked days are skipped", () => {
  expect(changesFor(["2026-12-01", "2026-12-04", "2026-12-10"], "free", "ignored", own)).toEqual([
    { day: "2026-12-01", state: "free", note: null },
    { day: "2026-12-04", state: "free", note: null },
  ]);
});

test.each([
  { name: "unmarked", days: ["2026-12-10", "2026-12-11"], want: "free" },
  { name: "all busy", days: ["2026-12-01", "2026-12-02"], want: "busy" },
  { name: "all maybe", days: ["2026-12-03"], want: "maybe" },
  { name: "mixed", days: ["2026-12-01", "2026-12-10"], want: null },
] satisfies { name: string; days: Day[]; want: State | null }[])("shared state: $name → $want", ({ days, want }) => {
  expect(sharedState(days, own)).toBe(want);
});

test("enter in the note field sets the note on marked days only, keeping their state", () => {
  expect(noteChanges(["2026-12-10", "2026-12-03", "2026-12-02"], " Konzert ", own)).toEqual([
    { day: "2026-12-02", state: "busy", note: "Konzert" },
    { day: "2026-12-03", state: "maybe", note: "Konzert" },
  ]);
  // An empty note clears it; a day that already has the note is skipped.
  expect(noteChanges(["2026-12-01", "2026-12-02"], "", own)).toEqual([{ day: "2026-12-01", state: "busy", note: null }]);
  expect(noteChanges(["2026-12-10"], "x", own)).toEqual([]);
});

test.each([
  ["2026-12-24", "2026-12-24"],
  [TODAY, TODAY],
  ["2026-11-19", null], // past
  ["2027-11-21", null], // after the window
  ["2026-02-30", null],
  ["24.12.2026", null],
  [null, null],
])("?day=%s → %s", (value, want) => {
  expect(dayParam(value, TODAY)).toBe(want);
});
