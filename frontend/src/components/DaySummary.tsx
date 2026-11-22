import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";

import { useI18n } from "../i18n/I18n";
import type { Day } from "../lib/days";
import type { Event } from "../lib/events";
import { memberText, statusText, tone, type Summary } from "../lib/groupDay";
import { setByLabel } from "../lib/groupResult";
import type { Member } from "../lib/groups";
import { holidayLabels, type HolidayIndex } from "../lib/holidays";

const utc = (day: Day) => Date.parse(`${day}T00:00:00Z`);

/**
 * Who can on a day or a range (spec §3.7): a popover next to `anchor` (a CSS selector); on phones
 * full width, always right under it, scrolled into view. A non-modal dialog: takes the focus and gives it back; ✕, Escape or a tap
 * elsewhere close it. A tap on another day ([data-day]) is left to the page, which switches days.
 */
export function DaySummary({
  days,
  summary,
  members,
  meId,
  holidays,
  events,
  editable,
  anchor,
  onPlan,
  onEditEvent,
  onEditMine,
  onClose,
}: {
  days: Day[];
  summary: Summary;
  members: Member[]; // in the order of summary.members
  meId: number;
  holidays: HolidayIndex;
  events: Event[];
  editable: boolean;
  anchor: string;
  onPlan: () => void;
  onEditEvent: (event: Event) => void;
  onEditMine: () => void;
  onClose: () => void;
}) {
  const { t, locale } = useI18n();
  const ref = useRef<HTMLDivElement>(null);
  const headingId = useId();
  const [previous] = useState(() => (document.activeElement instanceof HTMLElement ? document.activeElement : null));
  const first = days[0]!;
  const last = days[days.length - 1]!;

  useEffect(() => {
    ref.current?.focus();
    return () => {
      const lost = document.activeElement === null || document.activeElement === document.body;
      // Without scrolling: the page stays where the user left it, even if `previous` is far up.
      if (lost && previous?.isConnected) previous.focus({ preventScroll: true });
    };
  }, [previous]);

  useEffect(() => {
    function onDown(e: PointerEvent) {
      const target = e.target as Element;
      if (!ref.current?.contains(target) && !target.closest("[data-day]")) onClose();
    }
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [onClose]);

  // Next to the anchor, below it or else above. Phones: always below (the CSS sets the width), and
  // once per anchor the page scrolls just enough to show it.
  const shownFor = useRef<string | null>(null);
  useLayoutEffect(() => {
    function place() {
      const pop = ref.current;
      if (!pop) return;
      const phone = matchMedia("(max-width: 719px)").matches;
      const w = pop.offsetWidth;
      const h = pop.offsetHeight;
      const cell = document.querySelector(anchor)?.getBoundingClientRect();
      let left = (innerWidth - w) / 2;
      let top = 120;
      if (cell) {
        left = Math.max(12, Math.min(cell.left + cell.width / 2 - w / 2, innerWidth - w - 12));
        top = cell.bottom + (phone ? 8 : 12);
        if (!phone && top + h > innerHeight - 12 && cell.top - h - 12 > 12) top = cell.top - h - 12;
      }
      pop.style.left = `${left + scrollX}px`;
      pop.style.top = `${top + scrollY}px`;
      if (phone && shownFor.current !== anchor) {
        shownFor.current = anchor;
        pop.scrollIntoView({ block: "nearest", behavior: "smooth" });
      }
    }
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  });

  function onKeyDown(e: KeyboardEvent) {
    if (e.key !== "Escape") return;
    e.stopPropagation();
    onClose();
  }

  const fmtLong = new Intl.DateTimeFormat(locale, { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" });
  const fmtShort = new Intl.DateTimeFormat(locale, { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
  const title = days.length === 1 ? fmtLong.format(utc(first)) : `${fmtShort.format(utc(first))} – ${fmtShort.format(utc(last))}`;

  const found = [...new Set(days.flatMap((d) => holidays.get(d)?.holidays ?? []))];
  const labels = (kind: "public" | "school") =>
    holidayLabels(
      found.filter((h) => h.kind === kind),
      locale,
      (r) => t(`region.${r}`),
    );

  return createPortal(
    <div ref={ref} className="pop" role="dialog" aria-labelledby={headingId} tabIndex={-1} onKeyDown={onKeyDown}>
      <div className="pop-head">
        <div>
          <h3 id={headingId} className="sheet-title">
            {title}
          </h3>
          <span className={`status ${tone(summary)}`}>{statusText(summary, t)}</span>
        </div>
        <button type="button" className="icon-btn close" aria-label={t("common.close")} onClick={onClose}>
          ✕
        </button>
      </div>
      <ul className="mlist">
        {summary.members.map((s, i) => {
          const m = members[i]!;
          const setBy = setByLabel(s.mark, t("event.formerMember"));
          return (
            <li key={s.id} className="mrow">
              <span className={`av av-${i % 4}`} aria-hidden="true">
                {m.display_name.charAt(0).toUpperCase()}
              </span>
              <span>
                <span className="nm">{m.id === meId ? t("summary.you") : m.display_name}</span>
                {s.mark?.note && <span className="nt">„{s.mark.note}“</span>}
                {setBy && <span className="nt">{t("summary.setBy", { name: setBy })}</span>}
              </span>
              <span className={`st st-${s.state}`}>{memberText(s, days.length, t)}</span>
            </li>
          );
        })}
      </ul>
      {(found.length > 0 || events.length > 0) && (
        <div className="extras">
          {labels("public").map((name) => (
            <span key={name} className="x-hol">
              <i aria-hidden="true">✦</i>
              {name}
            </span>
          ))}
          {labels("school").map((name) => (
            <span key={name} className="x-sc">
              {name}
            </span>
          ))}
          {events.map((e) => (
            <button key={e.id} type="button" className="x-ev" onClick={() => onEditEvent(e)}>
              {t("summary.event", { title: e.title })}
            </button>
          ))}
        </div>
      )}
      <div className="pop-actions">
        <button type="button" className="btn" onClick={onPlan}>
          {t("summary.plan")}
        </button>
        {editable && (
          <button type="button" className="btn ghost" onClick={onEditMine}>
            {t("summary.editMine")}
          </button>
        )}
      </div>
    </div>,
    document.body,
  );
}
