import { describe, expect, it } from "vitest";

import type { Member } from "./groups";
import {
  headerKey,
  orderMembers,
  selectedRange,
  selectHeader,
  updatedAgo,
  type HeaderAction,
  type HeaderSelection,
} from "./overview";

const member = (id: number, display_name: string): Member => ({
  id,
  display_name,
  role: "member",
  availability_updated_at: null,
  is_instance_admin: false,
});

describe("orderMembers", () => {
  it("puts the viewer first, then sorts by name ignoring case and accents", () => {
    const members = [member(1, "zoe"), member(2, "Ben"), member(3, "Änne"), member(4, "Mia")];
    expect(orderMembers(members, 4, "de").map((m) => m.display_name)).toEqual([
      "Mia",
      "Änne",
      "Ben",
      "zoe",
    ]);
  });
});

describe("updatedAgo", () => {
  const now = new Date("2026-11-18T12:00:00Z");
  it.each([
    ["2026-11-18T11:59:30Z", "en", "now"],
    ["2026-11-18T11:55:00Z", "en", "5 minutes ago"],
    ["2026-11-18T09:00:00+00:00", "en", "3 hours ago"],
    ["2026-11-17T12:00:00Z", "en", "yesterday"],
    ["2026-10-28T12:00:00Z", "en", "3 weeks ago"],
    ["2026-10-28T12:00:00Z", "de", "vor 3 Wochen"],
    ["2025-11-01T12:00:00Z", "en", "last year"],
  ])("%s (%s) → %s", (iso, locale, expected) => {
    expect(updatedAgo(iso, now, locale)).toBe(expected);
  });
});

describe("selectHeader", () => {
  const run = (...actions: HeaderAction[]) => actions.reduce(selectHeader, { kind: "none" } as HeaderSelection);

  it("mouse: press, drag backwards, release gives an ordered range", () => {
    const dragging = run({ type: "press", day: "2027-03-10" }, { type: "over", day: "2027-03-07" });
    expect(selectedRange(dragging)).toEqual({ start: "2027-03-07", end: "2027-03-10" });
    expect(selectHeader(dragging, { type: "release" })).toEqual({ kind: "done", start: "2027-03-07", end: "2027-03-10" });
  });

  it("mouse: a click is one day", () => {
    expect(run({ type: "press", day: "2027-03-10" }, { type: "release" })).toEqual({
      kind: "done",
      start: "2027-03-10",
      end: "2027-03-10",
    });
  });

  it("touch: first tap is the start, second the end; the same day twice is one day", () => {
    const first = run({ type: "tap", day: "2027-03-12" });
    expect(first).toEqual({ kind: "pending", anchor: "2027-03-12" });
    expect(selectedRange(first)).toEqual({ start: "2027-03-12", end: "2027-03-12" });
    expect(selectHeader(first, { type: "tap", day: "2027-03-09" })).toEqual({
      kind: "done",
      start: "2027-03-09",
      end: "2027-03-12",
    });
    expect(selectHeader(first, { type: "tap", day: "2027-03-12" })).toEqual({
      kind: "done",
      start: "2027-03-12",
      end: "2027-03-12",
    });
    // A tap after a finished range starts a new one.
    expect(run({ type: "tap", day: "2027-03-01" }, { type: "tap", day: "2027-03-02" }, { type: "tap", day: "2027-03-05" })).toEqual(
      { kind: "pending", anchor: "2027-03-05" },
    );
  });

  it("ignores moves and releases without a press; set and clear", () => {
    expect(run({ type: "over", day: "2027-03-01" }, { type: "release" })).toEqual({ kind: "none" });
    expect(run({ type: "set", start: "2027-03-06", end: "2027-03-07" })).toEqual({
      kind: "done",
      start: "2027-03-06",
      end: "2027-03-07",
    });
    expect(selectedRange(run({ type: "set", start: "2027-03-06", end: "2027-03-07" }, { type: "clear" }))).toBeNull();
  });
});

describe("selectHeader: keyboard extend", () => {
  const run = (...actions: HeaderAction[]) => actions.reduce(selectHeader, { kind: "none" } as HeaderSelection);

  it("finishes a pending start, grows a finished range either way, or picks one day", () => {
    expect(run({ type: "tap", day: "2027-03-12" }, { type: "extend", day: "2027-03-09" })).toEqual({
      kind: "done",
      start: "2027-03-09",
      end: "2027-03-12",
    });
    const range = run({ type: "set", start: "2027-03-06", end: "2027-03-07" });
    expect(selectHeader(range, { type: "extend", day: "2027-03-10" })).toEqual({
      kind: "done",
      start: "2027-03-06",
      end: "2027-03-10",
    });
    expect(selectHeader(range, { type: "extend", day: "2027-03-02" })).toEqual({
      kind: "done",
      start: "2027-03-02",
      end: "2027-03-07",
    });
    expect(run({ type: "extend", day: "2027-03-04" })).toEqual({ kind: "done", start: "2027-03-04", end: "2027-03-04" });
  });
});

describe("headerKey", () => {
  const press = (key: string, shift = false) => ({ key, shift, ctrl: false, alt: false, meta: false });
  const first = "2027-03-01";
  const last = "2027-03-31";

  it("moves within the month and stops at its ends", () => {
    expect(headerKey("2027-03-10", press("ArrowRight"), first, last)).toEqual({ type: "move", day: "2027-03-11" });
    expect(headerKey("2027-03-10", press("ArrowLeft"), first, last)).toEqual({ type: "move", day: "2027-03-09" });
    expect(headerKey(first, press("ArrowLeft"), first, last)).toEqual({ type: "move", day: first });
    expect(headerKey(last, press("ArrowRight"), first, last)).toEqual({ type: "move", day: last });
    expect(headerKey("2027-03-10", press("Home"), first, last)).toEqual({ type: "move", day: first });
    expect(headerKey("2027-03-10", press("End"), first, last)).toEqual({ type: "move", day: last });
  });

  it("selects like a tap, extends with shift, clears with escape, opens details with d", () => {
    const day = "2027-03-10";
    expect(headerKey(day, press("Enter"), first, last)).toEqual({ type: "select", action: { type: "tap", day } });
    expect(headerKey(day, press(" ", true), first, last)).toEqual({ type: "select", action: { type: "extend", day } });
    expect(headerKey(day, press("Escape"), first, last)).toEqual({ type: "select", action: { type: "clear" } });
    expect(headerKey(day, press("d"), first, last)).toEqual({ type: "details", day });
    expect(headerKey(day, press("F10", true), first, last)).toEqual({ type: "details", day });
    expect(headerKey(day, { ...press("ArrowLeft"), ctrl: true }, first, last)).toBeNull();
    expect(headerKey(day, press("Tab"), first, last)).toBeNull();
  });
});
