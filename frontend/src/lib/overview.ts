// Small pure helpers for Gruppe (spec §3.7).
import type { KeyPress } from "./calendarKeys";
import { addDays, compareDays, type Day } from "./days";
import type { Member } from "./groups";

/** The viewer first, then everyone else by name. */
export function orderMembers(members: readonly Member[], meId: number, locale: string): Member[] {
  const collator = new Intl.Collator(locale, { sensitivity: "base" });
  return [...members].sort(
    (a, b) =>
      Number(b.id === meId) - Number(a.id === meId) ||
      collator.compare(a.display_name, b.display_name) ||
      a.id - b.id,
  );
}

const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ["year", 365 * 86400],
  ["month", 30 * 86400],
  ["week", 7 * 86400],
  ["day", 86400],
  ["hour", 3600],
  ["minute", 60],
];

/** "3 weeks ago" for an ISO timestamp, in the largest whole unit; under a minute is "now". */
export function updatedAgo(iso: string, now: Date, locale: string): string {
  const seconds = Math.max(0, (now.getTime() - Date.parse(iso)) / 1000);
  const fmt = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  for (const [unit, size] of UNITS) {
    if (seconds >= size) return fmt.format(-Math.floor(seconds / size), unit);
  }
  return fmt.format(0, "second");
}

/**
 * The day or range of the Gruppe day summary: a mouse drags over days, taps start then end (the
 * same day twice = one day); "done" means the summary is open.
 */
export type HeaderSelection =
  | { kind: "none" }
  | { kind: "drag"; anchor: Day; current: Day }
  | { kind: "pending"; anchor: Day }
  | { kind: "done"; start: Day; end: Day };
export type HeaderAction =
  | { type: "press"; day: Day } // mouse/pen down
  | { type: "over"; day: Day } // pointer moved onto a day while pressed
  | { type: "release" }
  | { type: "tap"; day: Day } // touch
  | { type: "set"; start: Day; end: Day } // a tapped day or a Passende Tage result
  | { type: "extend"; day: Day } // keyboard Shift+Enter: grow the selection to this day
  | { type: "clear" };

const ordered = (a: Day, b: Day) => (compareDays(a, b) <= 0 ? { start: a, end: b } : { start: b, end: a });

export function selectHeader(state: HeaderSelection, action: HeaderAction): HeaderSelection {
  switch (action.type) {
    case "press":
      return { kind: "drag", anchor: action.day, current: action.day };
    case "over":
      return state.kind === "drag" ? { ...state, current: action.day } : state;
    case "release":
      return state.kind === "drag" ? { kind: "done", ...ordered(state.anchor, state.current) } : state;
    case "tap":
      return state.kind === "pending"
        ? { kind: "done", ...ordered(state.anchor, action.day) }
        : { kind: "pending", anchor: action.day };
    case "set":
      return { kind: "done", ...ordered(action.start, action.end) };
    case "extend":
      if (state.kind === "pending") return { kind: "done", ...ordered(state.anchor, action.day) };
      if (state.kind === "done") {
        return {
          kind: "done",
          start: compareDays(action.day, state.start) < 0 ? action.day : state.start,
          end: compareDays(action.day, state.end) > 0 ? action.day : state.end,
        };
      }
      return { kind: "done", start: action.day, end: action.day };
    case "clear":
      return { kind: "none" };
  }
}

/** The days to outline: the finished range, the one being dragged, or the first tap. */
export function selectedRange(state: HeaderSelection): { start: Day; end: Day } | null {
  switch (state.kind) {
    case "none":
      return null;
    case "drag":
      return ordered(state.anchor, state.current);
    case "pending":
      return { start: state.anchor, end: state.anchor };
    case "done":
      return { start: state.start, end: state.end };
  }
}

export type HeaderKey =
  | { type: "move"; day: Day }
  | { type: "select"; action: HeaderAction }
  | { type: "details"; day: Day };

/**
 * Keyboard on Gruppe's days (P6.4): ←/→ (Home/End) move within the shown days, Enter/Space pick
 * the first then the last day like taps, Shift+Enter/Space stretch the selection, Escape clears it,
 * D / the context-menu key / Shift+F10 open that day's summary.
 */
export function headerKey(day: Day, press: KeyPress, first: Day, last: Day): HeaderKey | null {
  if (press.ctrl || press.alt || press.meta) return null;
  switch (press.key) {
    case "ArrowLeft":
      return { type: "move", day: day === first ? first : addDays(day, -1) };
    case "ArrowRight":
      return { type: "move", day: day === last ? last : addDays(day, 1) };
    case "Home":
      return { type: "move", day: first };
    case "End":
      return { type: "move", day: last };
    case " ":
    case "Enter":
      return { type: "select", action: press.shift ? { type: "extend", day } : { type: "tap", day } };
    case "Escape":
      return { type: "select", action: { type: "clear" } };
    case "ContextMenu":
      return { type: "details", day };
    case "F10":
      return press.shift ? { type: "details", day } : null;
    case "d":
    case "D":
      return press.shift ? null : { type: "details", day };
    default:
      return null;
  }
}
