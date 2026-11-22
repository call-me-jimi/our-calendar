// Gruppe (spec §3.6, §3.7): what a day shows, and the day summary for a day or a range.
import type { MessageKey } from "../i18n/translate";
import { compareDays, inWindow, weekday, type Day } from "./days";
import { dayResult, type GroupEvent, type GroupMark, type MarksIndex } from "./groupResult";
import type { RunFilter } from "./matchingRuns";

export type MemberState = "free" | "maybe" | "busy";
/** "missing": someone can't, counting maybe as can't unless the switch says otherwise. */
export type GroupKind = "free" | "maybe" | "missing" | "event";
export type GroupDay = {
  kind: GroupKind;
  /** One per member, in the order given (you first, then by name). */
  boxes: MemberState[];
  /** Members who can't, under the maybe switch. */
  missing: number;
  /** Filtered out: an unticked weekday, or an editable day outside the period. */
  dim: boolean;
};
export type DayFilter = Pick<RunFilter, "from" | "to" | "weekdays" | "maybeCountsAsFree">;

const stateOf = (index: MarksIndex, day: Day, id: number): MemberState => index.get(day)?.get(id)?.state ?? "free";

export function groupDay(
  day: Day,
  memberIds: readonly number[],
  index: MarksIndex,
  events: readonly GroupEvent[],
  filter: DayFilter,
  today: Day,
): GroupDay {
  const r = dayResult(day, memberIds, index, events);
  const missing = r.busy.length + (filter.maybeCountsAsFree ? 0 : r.maybe.length);
  const kind = r.kind === "event" ? "event" : missing > 0 ? "missing" : r.maybe.length > 0 ? "maybe" : "free";
  const outside = compareDays(day, filter.from) < 0 || compareDays(day, filter.to) > 0;
  return {
    kind,
    boxes: memberIds.map((id) => stateOf(index, day, id)),
    missing,
    dim: !filter.weekdays.includes(weekday(day)) || (inWindow(day, today) && outside),
  };
}

export type MemberSummary = {
  id: number;
  /** Busy on any day wins over maybe. */
  state: MemberState;
  /** On how many of the days the member has that state. */
  count: number;
  /** A single day's mark, for its note and "set by". */
  mark: GroupMark | undefined;
};
export type Summary = { days: number; missing: number; maybe: number; members: MemberSummary[] };

export function summarize(
  days: readonly Day[],
  memberIds: readonly number[],
  index: MarksIndex,
  maybeCountsAsFree: boolean,
): Summary {
  const members = memberIds.map((id): MemberSummary => {
    const states = days.map((day) => stateOf(index, day, id));
    const busy = states.filter((s) => s === "busy").length;
    const maybe = states.filter((s) => s === "maybe").length;
    return {
      id,
      state: busy ? "busy" : maybe ? "maybe" : "free",
      count: busy || maybe || days.length,
      mark: days.length === 1 ? index.get(days[0]!)?.get(id) : undefined,
    };
  });
  return {
    days: days.length,
    missing: members.filter((m) => m.state === "busy" || (m.state === "maybe" && !maybeCountsAsFree)).length,
    maybe: members.filter((m) => m.state === "maybe").length,
    members,
  };
}

type T = (key: MessageKey, vars?: Record<string, string | number>) => string;

export const tone = (s: Pick<Summary, "missing" | "maybe">) => (s.missing ? "bad" : s.maybe ? "meh" : "good");

/** "Alle können" / "Alle können, 1 nur vielleicht" / "2 können nicht", for a range prefixed "3 Tage · ". */
export function statusText(s: Pick<Summary, "days" | "missing" | "maybe">, t: T): string {
  const status = s.missing
    ? t(s.missing === 1 ? "summary.cant.one" : "summary.cant.other", { n: s.missing })
    : s.maybe
      ? t("summary.allCanMaybe", { n: s.maybe })
      : t("summary.allCan");
  return s.days === 1 ? status : t("summary.days", { n: s.days, status });
}

/** "kann" / "vielleicht" / "kann nicht"; for a range "kann an allen Tagen" / "an 2 von 3 Tagen nicht". */
export function memberText(m: MemberSummary, days: number, t: T): string {
  if (days === 1) return t(`summary.state.${m.state}`);
  return t(`summary.range.${m.state}`, { x: m.count, n: days });
}
