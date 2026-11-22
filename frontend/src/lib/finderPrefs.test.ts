import { afterEach, expect, test, vi } from "vitest";

import { DEFAULT_FINDER_PREFS, readFinderPrefs, writeFinderPrefs } from "./finderPrefs";

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

test("prefs round-trip per group", () => {
  const prefs = { weekdays: [4, 5], length: 2, maybeCountsAsFree: true };
  writeFinderPrefs(1, prefs);
  expect(readFinderPrefs(1)).toEqual(prefs);
  expect(readFinderPrefs(2)).toEqual(DEFAULT_FINDER_PREFS);
});

test.each([
  ["not JSON", "{oops", DEFAULT_FINDER_PREFS],
  ["not an object", "5", DEFAULT_FINDER_PREFS],
  ["bad fields", '{"weekdays":[7],"length":15,"maybeCountsAsFree":"yes"}', DEFAULT_FINDER_PREFS],
  [
    "one bad field",
    '{"weekdays":[5,6],"length":0.5,"maybeCountsAsFree":true}',
    { ...DEFAULT_FINDER_PREFS, weekdays: [5, 6], maybeCountsAsFree: true },
  ],
])("garbage falls back to the defaults: %s", (_, stored, want) => {
  localStorage.setItem("finder.1", stored);
  expect(readFinderPrefs(1)).toEqual(want);
});

test("blocked storage: defaults, and writing does not throw", () => {
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
    throw new Error("blocked");
  });
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("blocked");
  });
  expect(readFinderPrefs(1)).toEqual(DEFAULT_FINDER_PREFS);
  expect(() => writeFinderPrefs(1, DEFAULT_FINDER_PREFS)).not.toThrow();
});
