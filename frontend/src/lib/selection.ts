// Meine Tage (spec §3.5): select days first, then choose what applies to them.
import { compareDays, expandRange, inWindow, isDay, type Day, type DayChange, type Mark, type State } from "./days";

const NOTE_MAX = 80;
const STATES: State[] = ["busy", "maybe", "free"];

/** Adds or removes one day; days outside the editable window are never added. */
export function toggleDay(selected: ReadonlySet<Day>, day: Day, today: Day): Set<Day> {
  const next = new Set(selected);
  if (next.has(day)) next.delete(day);
  else if (inWindow(day, today)) next.add(day);
  return next;
}

/** Adds the editable days from `a` to `b`, in either order. */
export function addRange(selected: ReadonlySet<Day>, a: Day, b: Day, today: Day): Set<Day> {
  return new Set([...selected, ...expandRange(a, b).filter((d) => inWindow(d, today))]);
}

/** The states worth offering: all but the one every selected day already has (unmarked = free). */
export function choicesFor(selected: Iterable<Day>, own: ReadonlyMap<Day, Mark>): State[] {
  const states = new Set([...selected].map((d) => own.get(d)?.state ?? "free"));
  return STATES.filter((s) => !(states.size === 1 && states.has(s)));
}

/** The changes for `PUT /api/marks`. An empty note keeps each day's note; free drops it. */
export function changesFor(
  selected: Iterable<Day>,
  state: State,
  note: string,
  own: ReadonlyMap<Day, Mark>,
): DayChange[] {
  const typed = note.trim().slice(0, NOTE_MAX) || null;
  const changes: DayChange[] = [];
  for (const day of [...selected].sort(compareDays)) {
    const mark = own.get(day);
    const newNote = state === "free" ? null : (typed ?? mark?.note ?? null);
    if ((mark?.state ?? "free") === state && (mark?.note ?? null) === newNote) continue;
    changes.push({ day, state, note: newNote });
  }
  return changes;
}

/** The state all selected days share (unmarked = free), or null when they differ; picks the sheet's question. */
export function sharedState(selected: Iterable<Day>, own: ReadonlyMap<Day, Mark>): State | null {
  const states = new Set([...selected].map((d) => own.get(d)?.state ?? "free"));
  return states.size === 1 ? [...states][0]! : null;
}

/** Enter in the note field: the typed note on the selected days that are marked, each keeping its state. */
export function noteChanges(selected: Iterable<Day>, note: string, own: ReadonlyMap<Day, Mark>): DayChange[] {
  const typed = note.trim().slice(0, NOTE_MAX) || null;
  const changes: DayChange[] = [];
  for (const day of [...selected].sort(compareDays)) {
    const mark = own.get(day);
    if (mark && mark.note !== typed) changes.push({ day, state: mark.state, note: typed });
  }
  return changes;
}

/** `?day=` (from Gruppe's "Meinen Eintrag ändern"): the day to select, if it is a valid, editable one. */
export function dayParam(value: string | null, today: Day): Day | null {
  return value !== null && isDay(value) && inWindow(value, today) ? value : null;
}
