import { expect, test } from "vitest";

import { selectionKey, type KeyPress, type KeyState } from "./calendarKeys";

const MAX = "2027-11-30";
const at = (focus: string, anchor: string | null = null): KeyState => ({ focus, anchor });
const press = (key: string, mods: Partial<KeyPress> = {}): KeyPress => ({
  key,
  shift: false,
  ctrl: false,
  alt: false,
  meta: false,
  ...mods,
});

test.each([
  // 2026-03-03 is a Tuesday.
  ["ArrowLeft", "2026-03-02"],
  ["ArrowRight", "2026-03-04"],
  ["ArrowUp", "2026-02-24"], // across the month boundary
  ["ArrowDown", "2026-03-10"],
  ["Home", "2026-03-02"], // Monday
  ["End", "2026-03-08"], // Sunday
  ["PageUp", "2026-02-03"],
  ["PageDown", "2026-04-03"],
])("%s moves the focus to %s", (key, focus) => {
  expect(selectionKey(at("2026-03-03"), press(key), MAX)).toEqual({ type: "move", focus, anchor: null });
});

test("PageUp from the 31st lands on the month's last day", () => {
  expect(selectionKey(at("2026-03-31"), press("PageUp"), MAX)).toMatchObject({ focus: "2026-02-28" });
});

test("moving past the last showable day stops there", () => {
  expect(selectionKey(at("2027-11-28"), press("ArrowDown"), MAX)).toMatchObject({ focus: MAX });
  expect(selectionKey(at(MAX), press("PageDown"), MAX)).toMatchObject({ focus: MAX });
});

// --- selectionKey (Meine Tage) ---

test.each([
  ["ArrowRight", {}, at("2026-03-03"), { type: "move", focus: "2026-03-04", anchor: null }],
  ["ArrowDown", { shift: true }, at("2026-03-03"), { type: "move", focus: "2026-03-10", anchor: "2026-03-03" }],
  ["ArrowDown", { shift: true }, at("2026-03-04", "2026-03-03"), { type: "move", focus: "2026-03-11", anchor: "2026-03-03" }],
  ["ArrowLeft", {}, at("2026-03-05", "2026-03-03"), { type: "move", focus: "2026-03-04", anchor: null }],
  ["PageDown", {}, at("2027-11-15"), { type: "move", focus: MAX, anchor: null }],
  [" ", {}, at("2026-03-03"), { type: "toggle", day: "2026-03-03" }],
  ["Enter", {}, at("2026-03-03"), { type: "toggle", day: "2026-03-03" }],
  [" ", {}, at("2026-03-01", "2026-03-03"), { type: "add", from: "2026-03-03", to: "2026-03-01" }],
  ["b", {}, at("2026-03-03"), { type: "apply", state: "busy" }],
  ["B", {}, at("2026-03-03"), { type: "apply", state: "busy" }],
  ["v", {}, at("2026-03-03"), { type: "apply", state: "maybe" }],
  ["Delete", {}, at("2026-03-03"), { type: "apply", state: "free" }],
  ["Backspace", {}, at("2026-03-03"), { type: "apply", state: "free" }],
  ["Escape", {}, at("2026-03-03"), { type: "clear" }],
  ["z", { ctrl: true }, at("2026-03-03"), { type: "undo" }],
  ["z", { meta: true }, at("2026-03-03"), { type: "undo" }],
  ["b", { shift: true }, at("2026-03-03"), null],
  ["b", { ctrl: true }, at("2026-03-03"), null],
  ["z", { ctrl: true, shift: true }, at("2026-03-03"), null],
  ["ArrowLeft", { alt: true }, at("2026-03-03"), null],
  ["d", {}, at("2026-03-03"), null],
  ["Tab", {}, at("2026-03-03"), null],
] satisfies [string, Partial<KeyPress>, KeyState, unknown][])("selection: %s %o at %o → %o", (key, mods, state, want) => {
  expect(selectionKey(state, press(key, mods), MAX)).toEqual(want);
});
