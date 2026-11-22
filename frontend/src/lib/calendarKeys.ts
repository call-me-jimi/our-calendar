// Keyboard in Meine Tage (spec §3.5). One day has the focus (a roving tabindex); the arrows move
// it, Space/Enter select it, Shift+arrows stretch a range from an anchor that is added to the
// selection when Shift is let go (or on Space/Enter). B / V / Delete apply a state to the selection.
import { addDays, addMonths, compareDays, weekday, type Day, type State } from "./days";

export type KeyState = { focus: Day; anchor: Day | null };
export type KeyPress = { key: string; shift: boolean; ctrl: boolean; alt: boolean; meta: boolean };
type Move = { type: "move"; focus: Day; anchor: Day | null };
export type SelectionKeyAction =
  | Move
  | { type: "toggle"; day: Day }
  | { type: "add"; from: Day; to: Day } // add the anchor → focus range to the selection
  | { type: "apply"; state: State } // to the selection
  | { type: "clear" }
  | { type: "undo" };

function target(focus: Day, key: string): Day | null {
  switch (key) {
    case "ArrowLeft":
      return addDays(focus, -1);
    case "ArrowRight":
      return addDays(focus, 1);
    case "ArrowUp":
      return addDays(focus, -7);
    case "ArrowDown":
      return addDays(focus, 7);
    case "Home":
      return addDays(focus, -weekday(focus)); // Monday
    case "End":
      return addDays(focus, 6 - weekday(focus)); // Sunday
    case "PageUp":
      return addMonths(focus, -1);
    case "PageDown":
      return addMonths(focus, 1);
    default:
      return null;
  }
}

/** Arrows, Home/End, PageUp/PageDown; with Shift the anchor stays (or is set) for a range. */
function move(state: KeyState, press: KeyPress, max: Day): Move | null {
  const next = target(state.focus, press.key);
  if (next === null) return null;
  const focus = compareDays(next, max) > 0 ? max : next;
  return { type: "move", focus, anchor: press.shift ? (state.anchor ?? state.focus) : null };
}

/**
 * What a key press on the focused day does. `max` is the last day that can be shown (the end of
 * the editable window's month); moving past it stops there. Null: not ours, let the browser have it.
 */
export function selectionKey(state: KeyState, press: KeyPress, max: Day): SelectionKeyAction | null {
  const { key, shift } = press;
  if (press.alt) return null;
  if (press.ctrl || press.meta) return key.toLowerCase() === "z" && !shift ? { type: "undo" } : null;

  const moved = move(state, press, max);
  if (moved) return moved;
  switch (key) {
    case " ":
    case "Enter":
      return state.anchor ? { type: "add", from: state.anchor, to: state.focus } : { type: "toggle", day: state.focus };
    case "b":
    case "B":
      return shift ? null : { type: "apply", state: "busy" };
    case "v":
    case "V":
      return shift ? null : { type: "apply", state: "maybe" };
    case "Delete":
    case "Backspace":
      return { type: "apply", state: "free" };
    case "Escape":
      return { type: "clear" };
    default:
      return null;
  }
}
