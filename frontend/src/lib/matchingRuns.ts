// "Passende Tage finden" (spec §3.7): every run of days on which the whole group can.
import { addDays, addMonths, compareDays, weekday, windowEnd, type Day } from "./days";
import { eventsOn, type GroupEvent, type MarksIndex } from "./groupResult";

export type RunFilter = {
  /** Inclusive period; a run must lie completely inside. */
  from: Day;
  to: Day;
  /** 1–14 consecutive days. */
  length: number;
  /** 0 = Monday … 6 = Sunday; every day of a run must be one of these. */
  weekdays: readonly number[];
  maybeCountsAsFree: boolean;
};
export type Run = { start: Day; end: Day };
export type Period = { months: 1 | 3 | 6 | 12 } | { from: Day; to: Day };

/** All runs in date order (overlapping ones too); no event day, and every member free. */
export function matchingRuns(
  filter: RunFilter,
  index: MarksIndex,
  memberIds: readonly number[],
  events: readonly GroupEvent[],
): Run[] {
  const { from, to, length, maybeCountsAsFree } = filter;
  const chosen = new Set(filter.weekdays);
  const fits = (day: Day) =>
    chosen.has(weekday(day)) &&
    eventsOn(day, events).length === 0 &&
    memberIds.every((id) => {
      const state = index.get(day)?.get(id)?.state;
      return state === undefined || (state === "maybe" && maybeCountsAsFree);
    });

  const runs: Run[] = [];
  let streak = 0; // fitting days in a row, ending at `day`
  for (let day = from; compareDays(day, to) <= 0; day = addDays(day, 1)) {
    streak = fits(day) ? streak + 1 : 0;
    if (streak >= length) runs.push({ start: addDays(day, 1 - length), end: day });
  }
  return runs;
}

/** The period to search: from today for n months, or a chosen from–to kept inside today … the window end. */
export function periodRange(today: Day, period: Period): { from: Day; to: Day } {
  const last = windowEnd(today);
  const clamp = (d: Day) => (compareDays(d, today) < 0 ? today : compareDays(d, last) > 0 ? last : d);
  if ("months" in period) return { from: today, to: clamp(addDays(addMonths(today, period.months), -1)) };
  const [a, b] = [clamp(period.from), clamp(period.to)];
  return compareDays(a, b) <= 0 ? { from: a, to: b } : { from: b, to: a };
}

/** Runs grouped by the month they start in ("YYYY-MM"), keeping their order. */
export function runsByMonth(runs: readonly Run[]): { month: string; runs: Run[] }[] {
  const groups: { month: string; runs: Run[] }[] = [];
  for (const run of runs) {
    const month = run.start.slice(0, 7);
    const last = groups[groups.length - 1];
    if (last?.month === month) last.runs.push(run);
    else groups.push({ month, runs: [run] });
  }
  return groups;
}
