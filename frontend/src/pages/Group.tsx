import {
  useEffect,
  useId,
  useMemo,
  useReducer,
  useRef,
  useState,
  type FocusEvent as ReactFocusEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { useNavigate, useSearchParams } from "react-router";

import { DaySummary } from "../components/DaySummary";
import { EventDialog, type EventDraft } from "../components/EventDialog";
import { Finder } from "../components/Finder";
import { Hint, HintOpener, useHintOpen } from "../components/Hint";
import { IntroCard } from "../components/IntroCard";
import { GroupTable } from "../components/GroupTable";
import { LoadError } from "../components/LoadError";
import { MonthGrid } from "../components/MonthGrid";
import { useI18n } from "../i18n/I18n";
import {
  addYearMonth,
  compareDays,
  expandRange,
  firstDay,
  inWindow,
  isDay,
  lastDay,
  todayBerlin,
  windowEnd,
  yearMonthOf,
  type Day,
  type YearMonth,
} from "../lib/days";
import { useGroupEvents } from "../lib/events";
import { readFinderPrefs, writeFinderPrefs, type FinderPrefs } from "../lib/finderPrefs";
import { groupDay, statusText, summarize, type DayFilter, type GroupDay, type MemberState } from "../lib/groupDay";
import { eventsOn, indexMarks } from "../lib/groupResult";
import { holidayLabels, indexHolidays, useHolidays, type DayHolidays } from "../lib/holidays";
import { useGroupMarks } from "../lib/marks";
import { matchingRuns, periodRange, type Period, type Run } from "../lib/matchingRuns";
import { headerKey, orderMembers, selectedRange, selectHeader, type HeaderSelection } from "../lib/overview";
import { useMediaQuery } from "../lib/useMediaQuery";
import { useGroupContext } from "./GroupLayout";

/** Everything a day shows in Gruppe, in either layout. */
export type GroupCell = GroupDay & {
  holidays: DayHolidays | undefined;
  hasEvent: boolean;
  editable: boolean;
  past: boolean;
  isToday: boolean;
  selected: boolean; // in the summary's day or range, or being dragged
  tabbable: boolean; // the one day of the roving focus
  date: string; // "Fr., 4. Dez."
  extras: string[]; // holiday names, "Termin: …"
  status: string; // "2 können nicht", under the maybe switch
  title: string; // hover text, with who can't and who might not
  label: string; // for screen readers: "Fr., 4. Dez., Gruppe: 2 können nicht, …"
};

const ymIndex = (ym: YearMonth) => ym.year * 12 + ym.month;
/** The items with a distinct key, first one kept (the two loads overlap). */
function unique<T>(items: readonly T[], key: (item: T) => string): T[] {
  const seen = new Set<string>();
  return items.filter((item) => !seen.has(key(item)) && Boolean(seen.add(key(item))));
}
const utc = (day: Day) => Date.parse(`${day}T00:00:00Z`);

function dayAt(x: number, y: number): Day | null {
  return document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-day]")?.dataset.day ?? null;
}

/** Keyed by group, so remembered filters and a selection never carry over to another group. */
export function Group() {
  const { group } = useGroupContext();
  return <GroupPage key={group.id} />;
}

/** Gruppe (spec §3.7): Kalender or Tabelle, "Passende Tage finden", and the day summary. */
function GroupPage() {
  const { me, group } = useGroupContext();
  const { t, locale } = useI18n();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const table = params.get("layout") === "table";
  const wide = useMediaQuery("(min-width: 720px)");
  const monthsShown = table || !wide ? 1 : 3;

  const [today] = useState(() => todayBerlin());
  const lastYm = yearMonthOf(windowEnd(today));
  const [initialDay] = useState(() => {
    const day = params.get("day");
    return day && isDay(day) ? day : null;
  });
  const [start, setStart] = useState<YearMonth>(() => yearMonthOf(initialDay ?? today));
  // The summary is open while the selection is "done": a tapped day, a dragged range or a result.
  const [sel, dispatch] = useReducer(
    selectHeader,
    (initialDay ? { kind: "done", start: initialDay, end: initialDay } : { kind: "none" }) as HeaderSelection,
  );
  const [jumpTo, setJumpTo] = useState<Day | null>(null);
  const [prefs, setPrefs] = useState(() => readFinderPrefs(group.id));
  const [period, setPeriod] = useState<Period>({ months: 12 });
  const [eventDraft, setEventDraft] = useState<EventDraft | null>(null);
  const [help, setHelp] = useState(false);
  const [hintOpen, setHintOpen] = useHintOpen("group");
  const [focusDay, setFocusDay] = useState<Day | null>(null);
  const moveFocus = useRef(false);
  const daysRef = useRef<HTMLDivElement>(null);
  const hintId = useId();

  const months = Array.from({ length: monthsShown }, (_, i) => addYearMonth(start, i));
  const from = firstDay(months[0]!);
  const to = lastDay(months[months.length - 1]!);
  const range = useMemo(() => periodRange(today, period), [today, period]);
  // Two loads: the shown months, and the finder's period (so a result's summary has its data).
  // Not one load over both: going back from today, that grows past the server's 400-day limit.
  const shownMarks = useGroupMarks(group.id, from, to);
  const periodMarks = useGroupMarks(group.id, range.from, range.to);
  const index = useMemo(
    () => indexMarks([...(periodMarks.data ?? []), ...(shownMarks.data ?? [])]),
    [periodMarks.data, shownMarks.data],
  );
  const shownEvents = useGroupEvents(group.id, from, to);
  const periodEvents = useGroupEvents(group.id, range.from, range.to);
  const events = useMemo(
    () => unique([...(periodEvents.data ?? []), ...(shownEvents.data ?? [])], (e) => String(e.id)),
    [periodEvents.data, shownEvents.data],
  );
  const shownHolidays = useHolidays(from, to, group.regions);
  const periodHolidays = useHolidays(range.from, range.to, group.regions);
  const holidays = useMemo(
    () =>
      indexHolidays(
        unique([...(periodHolidays.data ?? []), ...(shownHolidays.data ?? [])], (h) =>
          [h.kind, h.subdivision, h.start_day, h.end_day, h.name_de].join("|"),
        ),
        group.regions,
      ),
    [periodHolidays.data, shownHolidays.data, group.regions],
  );
  const members = useMemo(() => orderMembers(group.members, me.id, locale), [group.members, me.id, locale]);
  const memberIds = useMemo(() => members.map((m) => m.id), [members]);

  const filter = useMemo<DayFilter>(
    () => ({ ...range, weekdays: prefs.weekdays, maybeCountsAsFree: prefs.maybeCountsAsFree }),
    [range, prefs],
  );
  const loads = [shownMarks, periodMarks, shownEvents, periodEvents, shownHolidays, periodHolidays];
  // The finder needs only the period's data.
  const loading =
    !periodMarks.data || !periodEvents.data || periodMarks.isPlaceholderData || periodEvents.isPlaceholderData;
  const runs = useMemo(
    () => (loading ? null : matchingRuns({ ...filter, length: prefs.length }, index, memberIds, events)),
    [loading, filter, prefs.length, index, memberIds, events],
  );

  const picked = selectedRange(sel);
  const isPicked = (day: Day) =>
    picked !== null && compareDays(picked.start, day) <= 0 && compareDays(day, picked.end) <= 0;
  const shown = (day: Day) => compareDays(from, day) <= 0 && compareDays(day, to) <= 0;
  const active = focusDay && shown(focusDay) ? focusDay : shown(today) ? today : from;

  // After an arrow key, focus the day it moved to.
  useEffect(() => {
    if (!moveFocus.current) return;
    moveFocus.current = false;
    daysRef.current?.querySelector<HTMLElement>(`[data-day="${active}"][tabindex="0"]`)?.focus();
  }, [active]);

  const fmtDay = new Intl.DateTimeFormat(locale, { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
  const fmtMonth = new Intl.DateTimeFormat(locale, { month: "long", year: "numeric", timeZone: "UTC" });
  const monthTitle = (ym: YearMonth) => fmtMonth.format(Date.UTC(ym.year, ym.month - 1, 1));

  function cell(day: Day): GroupCell {
    const g = groupDay(day, memberIds, index, events, filter, today);
    const dayEvents = eventsOn(day, events);
    const date = fmtDay.format(utc(day));
    const extras = [
      ...holidayLabels(holidays.get(day)?.holidays ?? [], locale, (r) => t(`region.${r}`)),
      ...dayEvents.map((e) => t("summary.event", { title: e.title })),
    ];
    const status = statusText({ days: 1, missing: g.missing, maybe: g.boxes.filter((b) => b === "maybe").length }, t);
    const names = (state: MemberState) =>
      members
        .filter((_, i) => g.boxes[i] === state)
        .map((m) => m.display_name)
        .join(", ");
    const who = [];
    if (names("busy")) who.push(t("summary.cantNames", { names: names("busy") }));
    if (names("maybe")) who.push(t("summary.maybeNames", { names: names("maybe") }));
    return {
      ...g,
      holidays: holidays.get(day),
      hasEvent: dayEvents.length > 0,
      editable: inWindow(day, today),
      past: compareDays(day, today) < 0,
      isToday: day === today,
      selected: isPicked(day),
      tabbable: day === active,
      date,
      extras,
      status,
      title: [date, ...extras, ...who].join(" · "),
      label: [date, t("group.cellStatus", { status }), ...extras].join(", "),
    };
  }

  const pending = sel.kind === "pending";

  function changePrefs(next: FinderPrefs) {
    setPrefs(next);
    writeFinderPrefs(group.id, next);
  }

  // Month arrows, "Heute" and the layout switch close the summary (§3.7).
  function go(ym: YearMonth) {
    setStart(ym);
    setJumpTo(null);
    dispatch({ type: "clear" });
  }

  function setLayout(toTable: boolean) {
    setParams(toTable ? { layout: "table" } : {}, { replace: true });
    dispatch({ type: "clear" });
  }

  function pick(run: Run) {
    const i = ymIndex(yearMonthOf(run.start));
    if (i < ymIndex(start) || i > ymIndex(start) + monthsShown - 1) setStart(yearMonthOf(run.start));
    setJumpTo(run.start);
    dispatch({ type: "set", start: run.start, end: run.end });
  }

  const isOpen = (day: Day) => sel.kind === "done" && sel.start === day && sel.end === day;

  // Days carry data-day (calendar cells; table header and group row). A mouse drags a range; a tap
  // (or click) on the open day closes it. Touch never drags, so the page still scrolls.
  function onPointerDown(e: ReactPointerEvent<HTMLDivElement>) {
    const day = (e.target as HTMLElement).closest<HTMLElement>("[data-day]")?.dataset.day;
    if (!day || e.button !== 0 || e.pointerType === "touch") return;
    e.preventDefault();
    setFocusDay(day);
    if (isOpen(day)) {
      dispatch({ type: "clear" });
      return;
    }
    e.currentTarget.setPointerCapture(e.pointerId);
    dispatch({ type: "press", day });
  }

  function onPointerMove(e: ReactPointerEvent) {
    if (sel.kind !== "drag") return;
    const day = dayAt(e.clientX, e.clientY);
    if (day && day !== sel.current) dispatch({ type: "over", day });
  }

  function onPointerUp(e: ReactPointerEvent) {
    if (e.pointerType !== "touch") {
      dispatch({ type: "release" });
      return;
    }
    const day = (e.target as HTMLElement).closest<HTMLElement>("[data-day]")?.dataset.day;
    if (day) dispatch(isOpen(day) ? { type: "clear" } : { type: "set", start: day, end: day });
  }

  function onKeyDown(e: ReactKeyboardEvent) {
    const day = (e.target as HTMLElement).closest<HTMLElement>("[data-day]")?.dataset.day;
    if (!day) return;
    const press = { key: e.key, shift: e.shiftKey, ctrl: e.ctrlKey, alt: e.altKey, meta: e.metaKey };
    const r = headerKey(day, press, from, to);
    if (!r) return;
    e.preventDefault();
    if (r.type === "move") {
      if (r.day !== active) moveFocus.current = true;
      setFocusDay(r.day);
    } else if (r.type === "select") {
      if (!e.repeat) dispatch(r.action);
    } else {
      dispatch({ type: "set", start: r.day, end: r.day });
    }
  }

  function onFocus(e: ReactFocusEvent) {
    const day = (e.target as HTMLElement).dataset.day;
    if (day && day !== focusDay) setFocusDay(day);
  }

  const summaryDays = sel.kind === "done" ? expandRange(sel.start, sel.end) : null;
  const canForward = ymIndex(addYearMonth(start, monthsShown - 1)) < ymIndex(lastYm);
  const boxNames = members.map((m) => (m.id === me.id ? t("summary.you") : m.display_name)).join(", ");

  return (
    <div className="card">
      {help && <IntroCard onDone={() => setHelp(false)} />}
      <div className="toolbar group-actions">
        <button
          type="button"
          className="today-btn"
          aria-label={t("event.add")}
          onClick={() => setEventDraft({ start: today, end: today })}
        >
          + <span className="add-event-label">{t("group.event")}</span>
        </button>
        <button
          type="button"
          className="icon-btn help"
          aria-label={t("group.help")}
          aria-expanded={help}
          onClick={() => setHelp(!help)}
        >
          ?
        </button>
      </div>

      <Finder
        today={today}
        prefs={prefs}
        period={period}
        runs={runs}
        onPrefs={changePrefs}
        onPeriod={setPeriod}
        onPick={pick}
      />

      <div className="toolbar month-nav">
        <div className="seg" role="group" aria-label={t("group.layout")}>
          <button type="button" aria-pressed={!table} onClick={() => setLayout(false)}>
            {t("group.layout.calendar")}
          </button>
          <button type="button" aria-pressed={table} onClick={() => setLayout(true)}>
            {t("group.layout.table")}
          </button>
        </div>
        {!hintOpen && <HintOpener onOpen={() => setHintOpen(true)} />}
        <div className="spacer" />
        <div className="nav">
          <button
            type="button"
            className="icon-btn"
            aria-label={t("calendar.prev")}
            onClick={() => go(addYearMonth(start, -1))}
          >
            ‹
          </button>
          <button type="button" className="today-btn" onClick={() => go(yearMonthOf(today))}>
            {t("calendar.today")}
          </button>
          <button
            type="button"
            className="icon-btn"
            aria-label={t("calendar.next")}
            disabled={!canForward}
            onClick={() => go(addYearMonth(start, 1))}
          >
            ›
          </button>
        </div>
      </div>

      <Hint id={hintId} open={hintOpen} active={pending} onClose={() => setHintOpen(false)}>
        {pending ? t("group.hint.pickEnd") : t(table ? "group.hint.table" : "group.hint.calendar")}
      </Hint>

      <div
        ref={daysRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={() => sel.kind === "drag" && dispatch({ type: "clear" })}
        onKeyDown={onKeyDown}
        onFocus={onFocus}
      >
        {table ? (
          <GroupTable
            title={monthTitle(start)}
            days={expandRange(from, to)}
            cell={cell}
            members={members}
            meId={me.id}
            index={index}
            today={today}
            jumpTo={jumpTo}
          />
        ) : (
          <div className="months" style={{ gridTemplateColumns: `repeat(${monthsShown}, minmax(0, 1fr))` }}>
            {months.map((ym) => (
              <MonthGrid
                key={`${ym.year}-${ym.month}`}
                ym={ym}
                cell={(day) => {
                  const c = cell(day);
                  return { ...c, groupKind: c.kind };
                }}
                events={events}
                describedBy={hintId}
              />
            ))}
          </div>
        )}
      </div>

      <ul className="legend">
        {table ? (
          <>
            <li>
              <span className="sw sw-busy" />
              {t("group.legend.cant")}
            </li>
            <li>
              <span className="sw sw-maybe" />
              {t("group.legend.maybe")}
            </li>
            <li>
              <span className="sw sw-free" />
              {t("group.legend.can")}
            </li>
            <li>
              <span className="sw sw-gfree" />
              {t("group.legend.groupAllCan")}
            </li>
            <li>
              <span className="sw sw-gmissing" />
              {t("group.legend.groupCount")}
            </li>
          </>
        ) : (
          <>
            <li>
              <span className="sw sw-gfree" />
              {t("group.legend.allCan")}
            </li>
            <li>
              <span className="sw sw-gmaybe" />
              {t("group.legend.allCanMaybe")}
            </li>
            <li>
              <span className="sw-boxes" aria-hidden="true">
                <i className="free" />
                <i className="maybe" />
                <i className="busy" />
                <i className="free" />
              </span>
              {t("group.legend.boxes", { names: boxNames })}
            </li>
          </>
        )}
        <li>
          <span className="sw sw-ev" />
          {t("group.legend.event")}
        </li>
        {group.regions.length > 0 && (
          <>
            <li>
              <span className="sw sw-hol" aria-hidden="true">
                ✦
              </span>
              {t("group.legend.bank")}
            </li>
            <li>
              <span className="sw sw-school" />
              {t("group.legend.school")}
            </li>
          </>
        )}
      </ul>
      {help && <p className="helpbox">{t("group.keys")}</p>}

      {loads.some((q) => q.isError) && (
        <LoadError onRetry={() => loads.forEach((q) => void q.refetch())} />
      )}

      {summaryDays && (
        <DaySummary
          days={summaryDays}
          summary={summarize(summaryDays, memberIds, index, prefs.maybeCountsAsFree)}
          members={members}
          meId={me.id}
          holidays={holidays}
          events={events.filter(
            (e) => compareDays(e.start_day, summaryDays.at(-1)!) <= 0 && compareDays(summaryDays[0]!, e.end_day) <= 0,
          )}
          editable={summaryDays.length === 1 && inWindow(summaryDays[0]!, today)}
          anchor={`${table ? "tr.sum td" : ""}[data-day="${summaryDays.at(-1)!}"]`}
          onPlan={() => {
            setEventDraft({ start: summaryDays[0]!, end: summaryDays.at(-1)! });
            dispatch({ type: "clear" });
          }}
          onEditEvent={(event) => {
            setEventDraft({ event });
            dispatch({ type: "clear" });
          }}
          onEditMine={() => navigate(`/g/${group.id}/days?day=${summaryDays[0]!}`)}
          onClose={() => dispatch({ type: "clear" })}
        />
      )}

      {eventDraft && (
        <EventDialog
          key={"event" in eventDraft ? eventDraft.event.id : "new"}
          groupId={group.id}
          draft={eventDraft}
          onClose={() => setEventDraft(null)}
        />
      )}
    </div>
  );
}
