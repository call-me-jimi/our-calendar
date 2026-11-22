import { Fragment, useId, useMemo, type ReactNode } from "react";

import { useI18n } from "../i18n/I18n";
import { monthGrid, type Day, type Mark, type YearMonth } from "../lib/days";
import { rowSegments, type Event } from "../lib/events";
import type { DayHolidays } from "../lib/holidays";

export type MemberBox = "free" | "maybe" | "busy";

/** What one day shows. Meine Tage sets `own`; Gruppe sets `boxes`, `groupKind` and `dim` instead. */
export type CellInfo = {
  own?: Mark; // busy fill / maybe hatch, and the note icon
  boxes?: MemberBox[]; // one small box per member, in the same order every day
  groupKind?: "free" | "maybe" | "missing" | "event"; // the cell's colour
  dim?: boolean; // outside the filters
  editable: boolean; // false: faded (past or after the window)
  isToday: boolean;
  selected: boolean; // the accent ring and aria-pressed
  holidays: DayHolidays | undefined;
  title: string; // hover text
  label: string; // for screen readers: "Tue 3 Mar, you: busy, …"; must contain the day number
  tabbable: boolean; // the one day of the roving focus
};

const MAX_LANES = 2; // more overlapping events still show in the title

const isSchool = (info: CellInfo | null) => !!(info?.holidays?.schoolBE || info?.holidays?.schoolBB);

/**
 * One month, Monday first. Cells are buttons carrying `data-day`; the parent handles all pointer
 * and key input. Event bars lie over the top of each week row and let the pointer through.
 */
export function MonthGrid({
  ym,
  cell,
  events,
  describedBy,
  afterWeek,
}: {
  ym: YearMonth;
  cell: (day: Day) => CellInfo;
  events: readonly Event[];
  describedBy?: string;
  /** Shown right under a week row, e.g. the day panel on phones (Meine Tage). */
  afterWeek?: (week: readonly (Day | null)[]) => ReactNode;
}) {
  const { locale } = useI18n();
  const titleId = useId();
  const weeks = useMemo(() => monthGrid(ym), [ym]);
  const segments = useMemo(() => rowSegments(weeks, events), [weeks, events]);
  const first = Date.UTC(ym.year, ym.month - 1, 1);
  const monthName = new Intl.DateTimeFormat(locale, { month: "long", timeZone: "UTC" }).format(first);
  const weekdayNames = useMemo(() => {
    const fmt = new Intl.DateTimeFormat(locale, { weekday: "short", timeZone: "UTC" });
    // 2024-01-01 was a Monday.
    return Array.from({ length: 7 }, (_, i) => fmt.format(Date.UTC(2024, 0, 1 + i)));
  }, [locale]);

  return (
    <div className="month">
      <h3 className="month-title" id={titleId}>
        {monthName} <small>{ym.year}</small>
      </h3>
      <div className="month-grid" role="group" aria-labelledby={titleId} aria-describedby={describedBy}>
        <div className="week-head" aria-hidden="true">
          {weekdayNames.map((n) => (
            <span key={n}>{n}</span>
          ))}
        </div>
        {weeks.map((week, wi) => {
          const infos = week.map((day) => (day === null ? null : cell(day)));
          const bars = segments[wi]!.filter((s) => s.lane < MAX_LANES);
          const covered = new Set(bars.flatMap((s) => Array.from({ length: s.span }, (_, i) => s.col + i)));
          return (
            <Fragment key={wi}>
              <div className={bars.some((s) => s.lane > 0) ? "week lanes-2" : "week"}>
                {week.map((day, di) =>
                  day === null ? (
                    <span key={di} className="cell empty" />
                  ) : (
                    <DayCell
                      key={day}
                      day={day}
                      info={infos[di]!}
                      event={covered.has(di)}
                      // The ribbon is rounded where a stretch of school holidays (or the week row) starts or ends.
                      school={
                        isSchool(infos[di]!)
                          ? `${isSchool(infos[di - 1] ?? null) ? "" : " s"}${isSchool(infos[di + 1] ?? null) ? "" : " e"}`
                          : null
                      }
                    />
                  ),
                )}
                {bars.length > 0 && (
                  <div className="event-bars" aria-hidden="true">
                    {bars.map((s) => (
                      <span
                        key={s.event.id}
                        className={`event-bar${s.starts ? " starts" : ""}${s.ends ? " ends" : ""}`}
                        style={{ gridColumn: `${s.col + 1} / span ${s.span}`, gridRow: s.lane + 1 }}
                      >
                        {s.event.title}
                      </span>
                    ))}
                  </div>
                )}
              </div>
              {afterWeek?.(week)}
            </Fragment>
          );
        })}
      </div>
    </div>
  );
}

function DayCell({ day, info, event, school }: { day: Day; info: CellInfo; event: boolean; school: string | null }) {
  const classes = [
    "cell",
    info.own && `own-${info.own.state}`,
    info.groupKind && `g-${info.groupKind}`,
    !info.editable && "past",
    info.isToday && "today",
    info.selected && "selected",
    info.holidays?.bank && "bank",
    event && "ev",
    info.boxes && "has-boxes",
    info.dim && "dim",
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <button
      type="button"
      className={classes}
      data-day={day}
      tabIndex={info.tabbable ? 0 : -1}
      title={info.title}
      aria-label={info.label}
      aria-pressed={info.selected}
      aria-current={info.isToday ? "date" : undefined}
      aria-disabled={info.editable ? undefined : true}
    >
      <span className="num">{Number(day.slice(8))}</span>
      {school !== null && <span className={`school${school}`} />}
      {info.holidays?.bank && (
        <span className="hol" aria-hidden="true">
          ✦
        </span>
      )}
      {info.own?.note && <NoteIcon className="note-icon" />}
      {info.boxes && (
        <span className="boxes" aria-hidden="true">
          {info.boxes.map((b, i) => (
            <i key={i} className={b} />
          ))}
        </span>
      )}
    </button>
  );
}

/** A speech bubble: the day has a note. */
export function NoteIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 12 12" aria-hidden="true">
      <path d="M2 1.5h8a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1H5.5L3 10.5V8.5H2a1 1 0 0 1-1-1v-5a1 1 0 0 1 1-1z" fill="currentColor" />
    </svg>
  );
}
