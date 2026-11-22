import { describe, expect, test } from "vitest";

import { translate, type MessageKey } from "../i18n/translate";
import { groupDay, memberText, statusText, summarize, tone, type DayFilter } from "./groupDay";
import { indexMarks, type GroupEvent, type GroupMark } from "./groupResult";

// Today Fri 2026-11-20; members in the fixed order: you (3), then Anna (1), Ben (2).
const TODAY = "2026-11-20";
const ORDER = [3, 1, 2];
const mark = (user_id: number, day: string, state: "busy" | "maybe", note: string | null = null): GroupMark => ({
  user_id,
  day,
  state,
  note,
  set_by_name: null,
  set_by_former: false,
});
const filter: DayFilter = { from: TODAY, to: "2027-11-19", weekdays: [0, 1, 2, 3, 4, 5, 6], maybeCountsAsFree: false };
const index = indexMarks([
  mark(1, "2026-11-23", "busy"),
  mark(3, "2026-11-23", "maybe"),
  mark(2, "2026-11-24", "maybe", "only after 7"),
  mark(1, "2026-11-25", "busy"),
]);
const event: GroupEvent = { id: 1, title: "Probe", start_day: "2026-11-26", end_day: "2026-11-26" };
const day = (d: string, f: Partial<DayFilter> = {}) => groupDay(d, ORDER, index, [event], { ...filter, ...f }, TODAY);

describe("groupDay", () => {
  test("boxes follow the member order, not the user ids", () => {
    expect(day("2026-11-23").boxes).toEqual(["maybe", "busy", "free"]);
  });

  test.each([
    { name: "everyone free", d: "2026-11-27", maybe: false, kind: "free", missing: 0 },
    { name: "someone busy", d: "2026-11-23", maybe: false, kind: "missing", missing: 2 },
    { name: "busy stays missing with maybe as free", d: "2026-11-23", maybe: true, kind: "missing", missing: 1 },
    { name: "maybe only, maybe not free", d: "2026-11-24", maybe: false, kind: "missing", missing: 1 },
    { name: "maybe only, maybe as free", d: "2026-11-24", maybe: true, kind: "maybe", missing: 0 },
    { name: "an event day", d: "2026-11-26", maybe: false, kind: "event", missing: 0 },
  ])("$name", ({ d, maybe, kind, missing }) => {
    expect(day(d, { maybeCountsAsFree: maybe })).toMatchObject({ kind, missing });
  });

  test.each([
    { name: "a ticked weekday inside the period", d: "2026-11-27", f: {}, dim: false },
    { name: "an unticked weekday", d: "2026-11-27", f: { weekdays: [5, 6] }, dim: true },
    { name: "after the period", d: "2026-12-21", f: { to: "2026-12-20" }, dim: true },
    { name: "a past day is not dimmed by the period", d: "2026-11-19", f: {}, dim: false },
    { name: "a past day on an unticked weekday", d: "2026-11-19", f: { weekdays: [4] }, dim: true },
  ])("dim: $name", ({ d, f, dim }) => {
    expect(day(d, f).dim).toBe(dim);
  });
});

const t = (key: MessageKey, vars?: Record<string, string | number>) => translate("de", key, vars);

describe("summary", () => {
  test("a single day: members in order, with marks, status following the maybe switch", () => {
    const s = summarize(["2026-11-24"], ORDER, index, false);
    expect(s.members.map((m) => [m.id, m.state, m.mark?.note ?? null])).toEqual([
      [3, "free", null],
      [1, "free", null],
      [2, "maybe", "only after 7"],
    ]);
    expect(s.members.map((m) => memberText(m, 1, t))).toEqual(["kann", "kann", "vielleicht"]);
    expect(statusText(s, t)).toBe("1 kann nicht");
    expect(tone(s)).toBe("bad");

    const free = summarize(["2026-11-24"], ORDER, index, true);
    expect(statusText(free, t)).toBe("Alle können, 1 nur vielleicht");
    expect(tone(free)).toBe("meh");

    const all = summarize(["2026-11-27"], ORDER, index, false);
    expect(statusText(all, t)).toBe("Alle können");
    expect(tone(all)).toBe("good");
  });

  test("a range: busy on any day wins, counts per member, no single-day marks", () => {
    const s = summarize(["2026-11-23", "2026-11-24", "2026-11-25"], ORDER, index, false);
    expect(s.members.map((m) => memberText(m, 3, t))).toEqual([
      "an 1 von 3 Tagen vielleicht",
      "an 2 von 3 Tagen nicht",
      "an 1 von 3 Tagen vielleicht",
    ]);
    expect(s.members.every((m) => m.mark === undefined)).toBe(true);
    expect(statusText(s, t)).toBe("3 Tage · 3 können nicht");
    expect(statusText(summarize(["2026-11-23", "2026-11-24"], ORDER, index, true), t)).toBe("2 Tage · 1 kann nicht");
    expect(memberText(summarize(["2026-11-27", "2026-11-28"], ORDER, index, false).members[0]!, 2, t)).toBe(
      "kann an allen Tagen",
    );
  });
});
