import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type FocusEvent as ReactFocusEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { useSearchParams } from "react-router";

import { introSeenBefore, IntroCard } from "../components/IntroCard";
import { LoadError } from "../components/LoadError";
import { MonthGrid, NoteIcon, type CellInfo } from "../components/MonthGrid";
import { Hint, HintOpener, useHintOpen } from "../components/Hint";
import { useI18n } from "../i18n/I18n";
import { selectionKey } from "../lib/calendarKeys";
import {
  addYearMonth,
  compareDays,
  firstDay,
  inWindow,
  lastDay,
  previousOf,
  todayBerlin,
  windowEnd,
  yearMonthOf,
  type Day,
  type DayChange,
  type State,
  type YearMonth,
} from "../lib/days";
import { useGroupEvents } from "../lib/events";
import { eventsOn, setByLabel, type GroupMark } from "../lib/groupResult";
import { groupKey } from "../lib/groups";
import { holidayLabels, indexHolidays, useHolidays } from "../lib/holidays";
import { applyChanges, marksRoot, putMarks, useGroupMarks } from "../lib/marks";
import { addRange, changesFor, choicesFor, dayParam, noteChanges, sharedState, toggleDay } from "../lib/selection";
import { useMediaQuery } from "../lib/useMediaQuery";
import { useGroupContext } from "./GroupLayout";

const CHIPS_MAX = 8;

/** A drag: `base` is the selection when it started, the range from `anchor` is added to it. A touch
 *  drag starts only after holding still for HOLD_MS (`held`); moving earlier is a scroll. */
type Drag = { anchor: Day; base: ReadonlySet<Day>; moved: boolean; touch?: { x: number; y: number; held: boolean } };
const HOLD_MS = 350;
const HOLD_SLOP = 10; // px a finger may wander while holding
// `hold`: the focus is in the toast, so it doesn't fade away under the keyboard.
type Toast = { message: string; previous: DayChange[]; hold?: boolean };

const ymIndex = (ym: YearMonth) => ym.year * 12 + ym.month;

function dayOf(target: EventTarget | null): Day | null {
  return (target as HTMLElement | null)?.closest<HTMLElement>("[data-day]")?.dataset.day ?? null;
}

/** Meine Tage (spec §3.5): select your days, then say what applies to them. Only your own marks show. */
export function MyDays() {
  const { me, group } = useGroupContext();
  const { t, locale } = useI18n();
  const queryClient = useQueryClient();
  const wide = useMediaQuery("(min-width: 720px)");
  const monthsShown = wide ? 3 : 1;
  const [params, setParams] = useSearchParams();

  const [today] = useState(() => todayBerlin());
  const [linked] = useState(() => dayParam(params.get("day"), today)); // from Gruppe's "Meinen Eintrag ändern"
  const lastYm = yearMonthOf(windowEnd(today));
  const [start, setStart] = useState<YearMonth>(() => yearMonthOf(linked ?? today));
  const months = Array.from({ length: monthsShown }, (_, i) => addYearMonth(start, i));
  const from = firstDay(months[0]!);
  const to = lastDay(months[months.length - 1]!);

  const [target, setTarget] = useState(me.id);
  const [selection, setSelection] = useState<ReadonlySet<Day>>(() => new Set(linked ? [linked] : []));
  const [toast, setToast] = useState<Toast | null>(null);
  const [failed, setFailed] = useState<DayChange[] | null>(null); // a save that didn't go through
  const [introSeen, setIntroSeen] = useState(introSeenBefore);
  const [help, setHelp] = useState(false);
  const drag = useRef<Drag | null>(null);
  const dragged = useRef(false); // a drag just ended: the click that follows isn't a tap
  const holdTimer = useRef<number | undefined>(undefined);
  // A touch drag is on: the phone panel waits for the finger to lift (it would push the weeks down).
  const [touchDragging, setTouchDragging] = useState(false);
  // While a drag is on, the hint keeps the count it had when the drag began: a new text can wrap to
  // another number of lines and move the weeks under the pointer.
  const [hintFrozen, setHintFrozen] = useState<number | null>(null);
  const focusSheet = useRef(linked !== null); // the sheet takes the focus when a click opens it
  const gridRef = useRef<HTMLDivElement>(null);
  const sheetRef = useRef<HTMLDivElement>(null);
  const noteRef = useRef<HTMLInputElement>(null);
  const hintId = useId();
  const [hintOpen, setHintOpen] = useHintOpen("mine");
  const sheetTitleId = useId();

  // Keyboard: a roving focus over the days; Shift+arrows stretch a range from `anchor`.
  const [focusDay, setFocusDay] = useState<Day>(linked ?? today);
  const [anchor, setAnchor] = useState<Day | null>(null);
  // Phones: the day panel opens under this day's week (the first one tapped).
  const [panelDay, setPanelDay] = useState<Day | null>(null);
  const moveFocus = useRef(false);
  const shown = (day: Day) => compareDays(from, day) <= 0 && compareDays(day, to) <= 0;
  const active = shown(focusDay) ? focusDay : shown(today) ? today : from;

  // ?day= is in the state now; drop it so a reload doesn't select the day again.
  useEffect(() => {
    if (params.has("day")) {
      setParams(
        (p) => {
          p.delete("day");
          return p;
        },
        { replace: true },
      );
    }
  }, [params, setParams]);

  const marksQuery = useGroupMarks(group.id, from, to);
  const eventsQuery = useGroupEvents(group.id, from, to);
  const events = useMemo(() => eventsQuery.data ?? [], [eventsQuery.data]);
  const holidaysQuery = useHolidays(from, to, group.regions);
  const holidays = useMemo(
    () => indexHolidays(holidaysQuery.data ?? [], group.regions),
    [holidaysQuery.data, group.regions],
  );
  const holidayNames = (day: Day) =>
    holidayLabels(holidays.get(day)?.holidays ?? [], locale, (r) => t(`region.${r}`));
  const own = useMemo(() => {
    const map = new Map<Day, GroupMark>();
    for (const m of marksQuery.data ?? []) if (m.user_id === target) map.set(m.day, m);
    return map;
  }, [marksQuery.data, target]);
  const targetName = group.members.find((m) => m.id === target)?.display_name ?? me.display_name;

  // The selection as shown: with the range being stretched by Shift+arrows.
  const selected = useMemo(
    () => (anchor ? addRange(selection, anchor, active, today) : selection),
    [selection, anchor, active, today],
  );
  const days = useMemo(() => [...selected].sort(compareDays), [selected]);

  const save = useMutation({
    mutationFn: (changes: DayChange[]) => putMarks(target, group.id, changes),
    onMutate: async (changes) => {
      await queryClient.cancelQueries({ queryKey: marksRoot });
      const snapshot = queryClient.getQueriesData<GroupMark[]>({ queryKey: ["marks", group.id] });
      const setBy = target === me.id ? null : me.display_name;
      queryClient.setQueriesData<GroupMark[]>({ queryKey: ["marks", group.id] }, (old) =>
        old ? applyChanges(old, target, changes, setBy) : old,
      );
      return { snapshot };
    },
    onError: (_e, changes, ctx) => {
      for (const [key, data] of ctx?.snapshot ?? []) queryClient.setQueryData(key, data);
      setToast(null);
      setFailed(changes);
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: marksRoot });
      void queryClient.invalidateQueries({ queryKey: groupKey(group.id) });
    },
  });

  const dayCount = (n: number) => (n === 1 ? t("mine.days.one") : t("mine.days.other", { count: n }));

  /** Back to the grid, e.g. when the sheet or a toast button that had the focus goes away. */
  function focusGrid() {
    gridRef.current?.querySelector<HTMLElement>('[data-day][tabindex="0"]')?.focus();
  }

  function clearSelection() {
    if (sheetRef.current?.contains(document.activeElement)) focusGrid();
    setSelection(new Set());
    setAnchor(null);
  }

  /** Saves `changes`, clears the selection and offers Undo. */
  function commit(changes: DayChange[], message: string) {
    clearSelection();
    if (changes.length === 0) return;
    save.mutate(changes);
    setFailed(null);
    setToast({
      message: target === me.id ? message : `${message} (${targetName})`,
      previous: previousOf(
        changes.map((c) => c.day),
        own,
      ),
    });
  }

  function apply(state: State) {
    if (days.length === 0) return;
    const changes = changesFor(days, state, noteRef.current?.value ?? "", own);
    commit(changes, t(`mine.toast.${state}`, { days: dayCount(days.length) }));
  }

  function undo() {
    if (!toast) return;
    save.mutate(toast.previous);
    setToast(null);
  }

  // After a key moved the focus (maybe into another month), focus that day's cell.
  useEffect(() => {
    if (!moveFocus.current) return;
    moveFocus.current = false;
    gridRef.current?.querySelector<HTMLElement>(`[data-day="${active}"]`)?.focus();
  }, [active]);

  // A click that opened the sheet hands it the focus (spec §3.5); keys keep it in the grid.
  useEffect(() => {
    if (focusSheet.current && selection.size > 0) {
      const sheet = sheetRef.current;
      // Phones: the panel is in the page; bring it into view without moving more than needed.
      sheet?.focus({ preventScroll: !wide });
      if (!wide) sheet?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
    focusSheet.current = false;
  }, [selection, wide, touchDragging]);

  // The toast fades after a while, unless the focus is in it.
  useEffect(() => {
    if (!toast || toast.hold) return;
    const id = window.setTimeout(() => setToast(null), 8000);
    return () => window.clearTimeout(id);
  }, [toast]);

  // Once a touch drag holds, the finger selects instead of scrolling the page. Not passive, so it may
  // cancel; on the document, so it's there before the grid renders.
  useEffect(() => {
    const stop = (e: TouchEvent) => {
      if (drag.current?.touch?.held) e.preventDefault();
    };
    document.addEventListener("touchmove", stop, { passive: false });
    return () => document.removeEventListener("touchmove", stop);
  }, []);

  // A drag ends wherever the pointer is let go, also outside the grid.
  useEffect(() => {
    const end = () => {
      window.clearTimeout(holdTimer.current);
      const d = drag.current;
      const held = d?.touch?.held ?? false;
      if (d?.moved || held) {
        dragged.current = true;
        // A touch's click can come a while after the finger lifts.
        window.setTimeout(() => (dragged.current = false), held ? 600 : 0);
      }
      if (held) {
        focusSheet.current = true; // like a tap: the panel, shown now, takes the focus
        setTouchDragging(false);
      }
      setHintFrozen(null);
      drag.current = null;
    };
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
    return () => {
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
    };
  }, []);

  function showMonthOf(day: Day) {
    const i = ymIndex(yearMonthOf(day));
    if (i < ymIndex(start)) setStart(yearMonthOf(day));
    else if (i > ymIndex(start) + monthsShown - 1) setStart(addYearMonth(yearMonthOf(day), 1 - monthsShown));
  }

  function onKeyDown(e: ReactKeyboardEvent) {
    if (!dayOf(e.target)) return;
    const press = { key: e.key, shift: e.shiftKey, ctrl: e.ctrlKey, alt: e.altKey, meta: e.metaKey };
    const action = selectionKey({ focus: active, anchor }, press, lastDay(lastYm));
    if (!action) return;
    e.preventDefault();
    switch (action.type) {
      case "move":
        if (action.focus !== active) {
          moveFocus.current = true;
          showMonthOf(action.focus);
        }
        setFocusDay(action.focus);
        setAnchor(action.anchor);
        return;
      case "toggle":
        if (!e.repeat) setSelection((s) => toggleDay(s, action.day, today)); // holding Space would flicker
        return;
      case "add":
        setSelection((s) => addRange(s, action.from, action.to, today));
        setAnchor(null);
        return;
      case "apply":
        if (!e.repeat) apply(action.state);
        return;
      case "clear":
        clearSelection();
        return;
      case "undo":
        undo();
        return;
    }
  }

  function onKeyUp(e: ReactKeyboardEvent) {
    if (!dayOf(e.target)) return;
    if (e.key === " ") e.preventDefault(); // the button's own click on Space would toggle the day back
    if (e.key === "Shift" && anchor) {
      setSelection((s) => addRange(s, anchor, active, today));
      setAnchor(null);
    }
  }

  // The roving focus follows wherever the focus lands (a click, Tab, a script).
  function onFocus(e: ReactFocusEvent) {
    const day = dayOf(e.target);
    if (day && day !== focusDay) setFocusDay(day);
  }

  // Shift+Tab out of the grid mid-range: drop the range rather than leave it hanging.
  function onBlur(e: ReactFocusEvent) {
    if (moveFocus.current) return; // a key just moved to another month; its cell gets the focus next
    if (anchor && !e.currentTarget.contains(e.relatedTarget as Node | null)) setAnchor(null);
  }

  // Mouse and pen drag a range. Touch: a swipe scrolls the page; holding a day still for a moment,
  // then dragging, selects a range (a tap still toggles one day, via the click).
  function onPointerDown(e: ReactPointerEvent) {
    const day = dayOf(e.target);
    if (e.button !== 0 || !day || !inWindow(day, today)) return;
    setAnchor(null);
    if (e.pointerType === "touch") {
      const d: Drag = { anchor: day, base: selection, moved: false, touch: { x: e.clientX, y: e.clientY, held: false } };
      drag.current = d;
      window.clearTimeout(holdTimer.current);
      holdTimer.current = window.setTimeout(() => {
        if (drag.current !== d) return;
        d.touch!.held = true;
        setTouchDragging(true);
        setHintFrozen(d.base.size);
        if (d.base.size === 0) setPanelDay(day);
        setSelection(addRange(d.base, day, day, today));
        navigator.vibrate?.(10);
      }, HOLD_MS);
      return;
    }
    e.preventDefault(); // no text selection while dragging
    drag.current = { anchor: day, base: selection, moved: false };
    setHintFrozen(selection.size);
  }

  function onPointerMove(e: ReactPointerEvent) {
    const d = drag.current;
    if (!d) return;
    if (d.touch && !d.touch.held) {
      // Moving before the hold is up: a scroll, not a selection.
      if (Math.hypot(e.clientX - d.touch.x, e.clientY - d.touch.y) > HOLD_SLOP) {
        window.clearTimeout(holdTimer.current);
        drag.current = null;
      }
      return;
    }
    const day = dayOf(document.elementFromPoint(e.clientX, e.clientY));
    if (!day || (day === d.anchor && !d.moved)) return;
    d.moved = true;
    setSelection(addRange(d.base, d.anchor, day, today));
  }

  // A tap or a click without moving toggles the day.
  function onClick(e: ReactMouseEvent) {
    const day = dayOf(e.target);
    if (!day || dragged.current) return;
    setFocusDay(day);
    setAnchor(null);
    if (!inWindow(day, today)) return;
    if (selection.size === 0) {
      focusSheet.current = true;
      setPanelDay(day);
    }
    setSelection(toggleDay(selection, day, today));
  }

  const fmtShort = new Intl.DateTimeFormat(locale, { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
  const fmtLong = new Intl.DateTimeFormat(locale, { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" });
  const date = (day: Day) => Date.parse(`${day}T00:00:00Z`);
  const stateWord = (day: Day) => t(`state.${own.get(day)?.state ?? "free"}`).toLocaleLowerCase(locale);

  /** "Tue, 3 Mar, you: busy, note: …" plus holidays and events (P6.4); the title joins the same with " · ". */
  function cell(day: Day): CellInfo {
    const mark = own.get(day);
    const parts = [
      fmtShort.format(date(day)),
      t("cell.own", { who: target === me.id ? t("cell.you") : targetName, state: stateWord(day) }),
    ];
    if (mark?.note) parts.push(t("cell.note", { note: mark.note }));
    parts.push(...holidayNames(day));
    parts.push(...eventsOn(day, events).map((e) => t("cell.event", { title: e.title })));
    return {
      own: mark,
      editable: inWindow(day, today),
      isToday: day === today,
      selected: selected.has(day),
      holidays: holidays.get(day),
      title: parts.join(" · "),
      label: parts.join(", "),
      tabbable: day === active,
    };
  }

  function onNoteKey(e: ReactKeyboardEvent<HTMLInputElement>) {
    if (e.key !== "Enter" || e.nativeEvent.isComposing) return;
    e.preventDefault();
    // On marked days, Enter saves just the note; unmarked days still need a choice.
    if (days.some((d) => own.has(d))) commit(noteChanges(days, e.currentTarget.value, own), t("mine.toast.note"));
  }

  const single = days.length === 1 ? days[0]! : null;
  const shared = sharedState(days, own);
  const question =
    shared === null
      ? t("mine.question.mixed")
      : t(`mine.question.${shared === "free" ? "unmarked" : "change"}.${single ? "one" : "other"}`);
  let sub: ReactNode[] = [];
  if (single) {
    const setBy = setByLabel(own.get(single), t("event.formerMember"));
    sub = [
      <span key="before">
        {t("mine.before")} <b>{stateWord(single)}</b>
      </span>,
      ...(setBy ? [t("mine.setBy", { name: setBy })] : []),
      ...holidayNames(single),
      ...eventsOn(single, events).map((e) => t("cell.event", { title: e.title })),
    ].flatMap((part, i) => (i === 0 ? [part] : [" · ", part]));
  }

  const canForward = ymIndex(addYearMonth(start, monthsShown - 1)) < ymIndex(lastYm);
  const isAdmin = group.role === "admin";
  const kbd = (k: string) => <kbd>{k}</kbd>;

  // The day panel: a sheet floating at the bottom on wide screens. On phones it would cover the lower
  // weeks (and the taps meant for them), so it opens inside the calendar, right under the week of
  // the first day tapped, and stays there while more days are added.
  const hintCount = hintFrozen ?? selected.size;
  const panelAt = panelDay && selection.has(panelDay) ? panelDay : (days[0] ?? null);
  const panelShown = panelAt !== null && months.some((ym) => ymIndex(yearMonthOf(panelAt)) === ymIndex(ym));
  const panel =
    days.length > 0 && !(touchDragging && !wide) ? (
    <div
      ref={sheetRef}
      className={wide ? "sheet" : "sheet inline"}
      role="dialog"
      aria-labelledby={sheetTitleId}
      tabIndex={-1}
      onKeyDown={(e) => {
        if (e.key === "Escape") clearSelection();
      }}
    >
      <div className="sheet-top">
        <div>
          <h2 id={sheetTitleId} className="sheet-title">
            {single ? fmtLong.format(date(single)) : t("mine.selected", { count: days.length })}
          </h2>
          {single ? (
            <p className="sheet-sub">{sub}</p>
          ) : (
            <div className="chips">
              {days.slice(0, CHIPS_MAX).map((d) => (
                <span key={d} className="chip">
                  {fmtShort.format(date(d))}
                </span>
              ))}
              {days.length > CHIPS_MAX && <span className="chip">+{days.length - CHIPS_MAX}</span>}
            </div>
          )}
        </div>
        <button type="button" className="icon-btn close" aria-label={t("mine.clear")} onClick={clearSelection}>
          ✕
        </button>
      </div>
      <p className="question">{question}</p>
      <div className="choices">
        {choicesFor(days, own).map((s) => (
          <button key={s} type="button" className="choice" onClick={() => apply(s)}>
            <span className={`sw sw-${s}`} />
            <span>
              {t(`mine.choice.${s}`)}
              <small>{t(`mine.choiceHint.${s}`)}</small>
            </span>
          </button>
        ))}
      </div>
      <div className="note-row">
        <input
          // A fresh field for another single day, prefilled with its note; kept while adding days.
          key={single ? `${single}|${own.get(single)?.note ?? ""}` : "many"}
          ref={noteRef}
          maxLength={80}
          defaultValue={single ? (own.get(single)?.note ?? "") : ""}
          placeholder={t("mine.notePlaceholder")}
          aria-label={t("mine.note")}
          onKeyDown={onNoteKey}
        />
      </div>
    </div>
    ) : null;

  return (
    <div className={days.length > 0 ? "my-days selecting" : "my-days"}>
      {(!introSeen || help) && (
        <IntroCard
          onDone={() => {
            setIntroSeen(true);
            setHelp(false);
          }}
        />
      )}

      <section className="card">
        <div className="toolbar">
          {isAdmin && group.members.length > 1 && (
            <label className="marking-for">
              {t("calendar.markingFor")}
              <select
                value={target}
                onChange={(e) => {
                  setTarget(Number(e.target.value));
                  clearSelection();
                  setToast(null); // its Undo would go to the member chosen now
                }}
              >
                {group.members.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.id === me.id ? t("calendar.me") : m.display_name}
                  </option>
                ))}
              </select>
            </label>
          )}
          {!hintOpen && <HintOpener onOpen={() => setHintOpen(true)} />}
          <div className="spacer" />
          <div className="nav">
            <button
              type="button"
              className="icon-btn"
              aria-label={t("calendar.prev")}
              onClick={() => setStart((s) => addYearMonth(s, -1))}
            >
              ‹
            </button>
            <button type="button" className="today-btn" onClick={() => setStart(yearMonthOf(today))}>
              {t("calendar.today")}
            </button>
            <button
              type="button"
              className="icon-btn"
              aria-label={t("calendar.next")}
              disabled={!canForward}
              onClick={() => setStart((s) => addYearMonth(s, 1))}
            >
              ›
            </button>
          </div>
          <button
            type="button"
            className="icon-btn help"
            aria-label={t("mine.help")}
            aria-expanded={help}
            onClick={() => setHelp((h) => !h)}
          >
            ?
          </button>
        </div>

        <Hint
          id={hintId}
          open={hintOpen}
          active={hintCount > 0}
          icon={hintCount > 0 ? "✓" : "i"}
          onClose={() => setHintOpen(false)}
        >
          {hintCount > 0 ? t("mine.hint.selected", { days: dayCount(hintCount) }) : t("mine.hint.start")}
        </Hint>

        <div
          ref={gridRef}
          className="months"
          style={{ gridTemplateColumns: `repeat(${monthsShown}, minmax(0, 1fr))` }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onContextMenu={(e) => {
            if (drag.current?.touch) e.preventDefault(); // no long-press menu while holding a day
          }}
          onClick={onClick}
          onKeyDown={onKeyDown}
          onKeyUp={onKeyUp}
          onFocus={onFocus}
          onBlur={onBlur}
        >
          {months.map((ym) => (
            <MonthGrid
              key={`${ym.year}-${ym.month}`}
              ym={ym}
              cell={cell}
              events={events}
              describedBy={hintId}
              afterWeek={(week) => (!wide && panelShown && panelAt && week.includes(panelAt) ? panel : null)}
            />
          ))}
        </div>
        {!wide && !panelShown && panel}

        <ul className="legend">
          <li>
            <span className="sw sw-busy" /> {t("mine.legend.busy")}
          </li>
          <li>
            <span className="sw sw-maybe" /> {t("mine.legend.maybe")}
          </li>
          <li>
            <span className="sw sw-free" /> {t("mine.legend.free")}
          </li>
          <li>
            <span className="sw sw-note">
              <NoteIcon />
            </span>{" "}
            {t("mine.legend.note")}
          </li>
          <li>
            <span className="sw sw-ev" /> {t("mine.legend.event")}
          </li>
          {group.regions.length > 0 && (
            <>
              <li>
                <span className="sw sw-hol" aria-hidden="true">
                  ✦
                </span>{" "}
                {t("mine.legend.holiday")}
              </li>
              <li>
                <span className="sw sw-school" /> {t("mine.legend.school")}
              </li>
            </>
          )}
        </ul>
        {help && (
          <p className="helpbox">
            <b>{t("mine.keys.title")}</b> {kbd("←")}
            {kbd("→")}
            {kbd("↑")}
            {kbd("↓")} {t("mine.keys.move")} · {kbd(t("mine.keys.space"))} {t("mine.keys.toggle")} ·{" "}
            {kbd(t("mine.keys.shift"))}+{t("mine.keys.arrows")} {t("mine.keys.range")} · {kbd("B")} {t("mine.keys.busy")} ·{" "}
            {kbd("V")} {t("mine.keys.maybe")} · {kbd(t("mine.keys.del"))} {t("mine.keys.free")} · {kbd("Esc")}{" "}
            {t("mine.clear")} · {kbd(t("mine.keys.ctrl"))}+{kbd("Z")} {t("mine.keys.undo")}
          </p>
        )}
        {(marksQuery.isError || eventsQuery.isError || holidaysQuery.isError) && (
          <LoadError
            onRetry={() => {
              void marksQuery.refetch();
              void eventsQuery.refetch();
              void holidaysQuery.refetch();
            }}
          />
        )}
      </section>

      {wide && panel}

      {/* The toasts wait while the sheet is open: both sit at the bottom. */}
      {failed && days.length === 0 && (
        <div className="toast" role="alert">
          <span>{t("calendar.saveFailed")}</span>
          <button
            type="button"
            onClick={() => {
              save.mutate(failed);
              setFailed(null);
              focusGrid();
            }}
          >
            {t("common.retry")}
          </button>
          <button
            type="button"
            aria-label={t("common.close")}
            onClick={() => {
              setFailed(null);
              focusGrid();
            }}
          >
            ✕
          </button>
        </div>
      )}

      {toast && days.length === 0 && (
        <div
          className="toast"
          role="status"
          onFocus={() => setToast((cur) => cur && { ...cur, hold: true })}
          onBlur={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setToast((cur) => cur && { ...cur, hold: false });
          }}
        >
          <span>{toast.message}</span>
          <button
            type="button"
            onClick={() => {
              undo();
              focusGrid();
            }}
          >
            {t("calendar.undo")}
          </button>
        </div>
      )}
    </div>
  );
}
