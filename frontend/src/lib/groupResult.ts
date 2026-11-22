// Group result per day (spec §3.6): event > someone busy > light green (maybe only) > green.
import { compareDays, expandRange, type Day, type MarkState } from "./days";

export type GroupMark = {
  user_id: number;
  day: Day;
  state: MarkState;
  note: string | null;
  set_by_name: string | null; // only when someone else set it (a group admin)
  set_by_former: boolean; // the setter deleted their account (§3.11)
};
export type GroupEvent = { id: number; title: string; start_day: Day; end_day: Day };
export type DayResult =
  | { kind: "event"; events: GroupEvent[]; busy: number[]; maybe: number[] }
  | { kind: "busy"; busy: number[]; maybe: number[] }
  | { kind: "maybe"; busy: []; maybe: number[] }
  | { kind: "free"; busy: []; maybe: [] };

/** day → user_id → mark */
export type MarksIndex = ReadonlyMap<Day, ReadonlyMap<number, GroupMark>>;

export function indexMarks(marks: GroupMark[]): MarksIndex {
  const index = new Map<Day, Map<number, GroupMark>>();
  for (const mark of marks) {
    let byUser = index.get(mark.day);
    if (!byUser) {
      byUser = new Map();
      index.set(mark.day, byUser);
    }
    byUser.set(mark.user_id, mark);
  }
  return index;
}

/** The "set by" name to show: a name, `formerMember` for a deleted setter, or null (set by themselves). */
export function setByLabel(mark: GroupMark | undefined, formerMember: string): string | null {
  if (!mark) return null;
  return mark.set_by_name ?? (mark.set_by_former ? formerMember : null);
}

export function eventsOn<E extends GroupEvent>(day: Day, events: readonly E[]): E[] {
  return events.filter((e) => compareDays(e.start_day, day) <= 0 && compareDays(day, e.end_day) <= 0);
}

export function dayResult(
  day: Day,
  memberIds: readonly number[],
  index: MarksIndex,
  events: readonly GroupEvent[],
): DayResult {
  const byUser = index.get(day);
  const busy: number[] = [];
  const maybe: number[] = [];
  for (const id of memberIds) {
    const state = byUser?.get(id)?.state;
    if (state === "busy") busy.push(id);
    else if (state === "maybe") maybe.push(id);
  }
  busy.sort((a, b) => a - b);
  maybe.sort((a, b) => a - b);

  const covering = eventsOn(day, events);
  if (covering.length > 0) return { kind: "event", events: covering, busy, maybe };
  if (busy.length > 0) return { kind: "busy", busy, maybe };
  if (maybe.length > 0) return { kind: "maybe", busy: [], maybe };
  return { kind: "free", busy: [], maybe: [] };
}

export function resultsForRange(
  from: Day,
  to: Day,
  memberIds: readonly number[],
  marks: GroupMark[],
  events: readonly GroupEvent[],
): Map<Day, DayResult> {
  const index = indexMarks(marks);
  const results = new Map<Day, DayResult>();
  for (const day of expandRange(from, to)) results.set(day, dayResult(day, memberIds, index, events));
  return results;
}
