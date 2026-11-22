import { useLayoutEffect, useRef } from "react";

import { useI18n } from "../i18n/I18n";
import { weekday, type Day } from "../lib/days";
import { setByLabel, type MarksIndex } from "../lib/groupResult";
import type { Member } from "../lib/groups";
import { updatedAgo } from "../lib/overview";
import type { GroupCell } from "../pages/Group";

const NOTE_PATH = "M2 1.5h8a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1H5.5L3 10.5V8.5H2a1 1 0 0 1-1-1v-5a1 1 0 0 1 1-1z";

/**
 * Gruppe as a table (spec §3.7): one month, a row per member in the fixed order, the group result
 * on top. Pointer and key input are handled by the page: header days and the group row carry
 * `data-day`.
 */
export function GroupTable({
  title,
  days,
  cell,
  members,
  meId,
  index,
  today,
  jumpTo,
}: {
  title: string;
  days: Day[];
  cell: (day: Day) => GroupCell;
  members: Member[];
  meId: number;
  index: MarksIndex;
  today: Day;
  jumpTo: Day | null; // bring this day's column into view
}) {
  const { t, locale } = useI18n();
  const wrapRef = useRef<HTMLDivElement>(null);
  const cells = days.map(cell);
  const school = (i: number) => !!(cells[i]?.holidays?.schoolBE || cells[i]?.holidays?.schoolBB);
  const fmtWeekday = new Intl.DateTimeFormat(locale, { weekday: "short", timeZone: "UTC" });
  const first = days[0]!;

  // Phones: a new month starts scrolled to its 1st, or to today in the current month.
  useLayoutEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const th = wrap.querySelector<HTMLElement>(`th[data-day="${today}"]`);
    const name = wrap.querySelector<HTMLElement>("th.name");
    wrap.scrollLeft = th && name ? th.offsetLeft - name.offsetWidth - th.offsetWidth : 0;
  }, [first, today]);

  useLayoutEffect(() => {
    if (jumpTo) wrapRef.current?.querySelector(`th[data-day="${jumpTo}"]`)?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [jumpTo, first]);

  return (
    <>
      <h3 className="ov-month">{title}</h3>
      <div ref={wrapRef} className="ov-scroll">
        <table className="ov" aria-label={title}>
          <thead>
            <tr>
              <th className="name" scope="col">
                <span className="sr-only">{t("group.member")}</span>
              </th>
              {cells.map((c, i) => {
                const day = days[i]!;
                const text = [c.date, ...c.extras];
                const cls = [
                  "ovh",
                  weekday(day) >= 5 && "we",
                  c.isToday && "today",
                  c.holidays?.bank && "bank",
                  c.dim && "dim",
                  c.selected && "selected",
                ];
                return (
                  <th
                    key={day}
                    scope="col"
                    data-day={day}
                    className={cls.filter(Boolean).join(" ")}
                    title={text.join(" · ")}
                    aria-label={text.join(", ")}
                    aria-selected={c.selected}
                    tabIndex={c.tabbable ? 0 : -1}
                  >
                    {c.hasEvent && <span className="ev" />}
                    {c.holidays?.bank && (
                      <span className="hol" aria-hidden="true">
                        ✦
                      </span>
                    )}
                    {school(i) && (
                      <span className={`school${school(i - 1) ? "" : " s"}${school(i + 1) ? "" : " e"}`} />
                    )}
                    <span className="wdl">{fmtWeekday.format(Date.parse(`${day}T00:00:00Z`))}</span>
                    <span className="dn">{Number(day.slice(8))}</span>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            <tr className="sum">
              <th className="name" scope="row">
                <div>
                  <span>
                    {t("group.row")}
                    <small>{t("group.rowHint")}</small>
                  </span>
                </div>
              </th>
              {cells.map((c, i) => {
                const text = `${c.date} · ${c.status}`;
                const cls = [`g-${c.kind}`, c.past && "past", c.dim && "dim", c.selected && "selected"];
                return (
                  <td
                    key={days[i]}
                    data-day={days[i]}
                    className={cls.filter(Boolean).join(" ")}
                    title={text}
                    aria-label={text}
                  >
                    {c.kind === "missing" && c.missing}
                  </td>
                );
              })}
            </tr>
            <tr className="gap" aria-hidden="true">
              <td colSpan={days.length + 1} />
            </tr>
            {members.map((m, row) => (
              <tr key={m.id} data-member={m.display_name}>
                <th className="name" scope="row">
                  <div>
                    <span className={`av av-${row % 4}`} aria-hidden="true">
                      {m.display_name.charAt(0).toUpperCase()}
                    </span>
                    <span>
                      {m.id === meId ? t("summary.you") : m.display_name}
                      <small>
                        {m.availability_updated_at
                          ? t("group.updated", { ago: updatedAgo(m.availability_updated_at, new Date(), locale) })
                          : t("group.neverUpdated")}
                      </small>
                    </span>
                  </div>
                </th>
                {cells.map((c, i) => {
                  const day = days[i]!;
                  const mark = index.get(day)?.get(m.id);
                  const parts = [`${m.display_name}, ${c.date}: ${t(`summary.state.${c.boxes[row]!}`)}`];
                  if (mark?.note) parts.push(`„${mark.note}“`);
                  const setBy = setByLabel(mark, t("event.formerMember"));
                  if (setBy) parts.push(t("summary.setBy", { name: setBy }));
                  const cls = [mark?.state, c.past && "past", c.dim && "dim"];
                  return (
                    <td
                      key={day}
                      className={cls.filter(Boolean).join(" ")}
                      title={parts.join(" · ")}
                      aria-label={parts.join(" · ")}
                    >
                      {mark?.note && (
                        <svg className="note" viewBox="0 0 12 12" aria-hidden="true">
                          <path d={NOTE_PATH} fill="currentColor" />
                        </svg>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
