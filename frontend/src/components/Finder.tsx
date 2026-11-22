import { useId, useMemo } from "react";

import { useI18n } from "../i18n/I18n";
import { windowEnd, type Day } from "../lib/days";
import { DEFAULT_FINDER_PREFS, type FinderPrefs } from "../lib/finderPrefs";
import { periodRange, runsByMonth, type Period, type Run } from "../lib/matchingRuns";

const MONTHS = [1, 3, 6, 12] as const;
const PRESETS = {
  all: [0, 1, 2, 3, 4, 5, 6],
  weekend: [5, 6],
  workdays: [0, 1, 2, 3, 4],
} as const;

const utc = (day: Day) => Date.parse(`${day}T00:00:00Z`);

/** "Passende Tage finden" (spec §3.7): the filters as questions, and every matching run by month. */
export function Finder({
  today,
  prefs,
  period,
  runs,
  onPrefs,
  onPeriod,
  onPick,
}: {
  today: Day;
  prefs: FinderPrefs;
  period: Period;
  runs: Run[] | null; // null while loading
  onPrefs: (prefs: FinderPrefs) => void;
  onPeriod: (period: Period) => void;
  onPick: (run: Run) => void;
}) {
  const { t, locale } = useI18n();
  const id = useId();
  const custom = !("months" in period);
  const changed =
    prefs.weekdays.length !== 7 ||
    prefs.length !== DEFAULT_FINDER_PREFS.length ||
    prefs.maybeCountsAsFree !== DEFAULT_FINDER_PREFS.maybeCountsAsFree ||
    custom ||
    period.months !== 12;

  const fmt = useMemo(() => {
    const f = (o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat(locale, { ...o, timeZone: "UTC" });
    return {
      weekday: f({ weekday: "short" }),
      day: f({ weekday: "short", day: "numeric" }),
      short: f({ weekday: "short", day: "numeric", month: "short" }),
      long: f({ weekday: "long", day: "numeric", month: "long", year: "numeric" }),
      month: f({ month: "short", year: "2-digit" }),
    };
  }, [locale]);
  // 2024-01-01 was a Monday.
  const weekdayNames = Array.from({ length: 7 }, (_, i) => fmt.weekday.format(Date.UTC(2024, 0, 1 + i)));

  const setPrefs = (change: Partial<FinderPrefs>) => onPrefs({ ...prefs, ...change });
  function toggleWeekday(w: number) {
    if (!prefs.weekdays.includes(w)) setPrefs({ weekdays: [...prefs.weekdays, w].sort((a, b) => a - b) });
    else if (prefs.weekdays.length > 1) setPrefs({ weekdays: prefs.weekdays.filter((x) => x !== w) });
  }
  const range = periodRange(today, period);
  const setDate = (which: "from" | "to", value: string) => {
    if (value) onPeriod(periodRange(today, { ...range, [which]: value }));
  };

  const runLabel = (r: Run) =>
    r.start === r.end
      ? fmt.day.format(utc(r.start))
      : `${fmt.day.format(utc(r.start))} – ${(r.start.slice(0, 7) === r.end.slice(0, 7) ? fmt.day : fmt.short).format(utc(r.end))}`;
  const countKey = prefs.length === 1 ? "finder.count.days" : "finder.count.runs";

  return (
    <div className="finder">
      <div className="finder-head">
        <svg viewBox="0 0 20 20" aria-hidden="true">
          <path
            d="M3 4h14l-5.5 6.5V16l-3 1.5v-7L3 4z"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinejoin="round"
          />
        </svg>
        <h3>{t("finder.title")}</h3>
        {changed && (
          <button
            type="button"
            className="reset"
            onClick={() => {
              onPrefs(DEFAULT_FINDER_PREFS);
              onPeriod({ months: 12 });
            }}
          >
            {t("finder.reset")}
          </button>
        )}
      </div>

      <div className="frow" role="group" aria-labelledby={`${id}-period`}>
        <span className="flabel" id={`${id}-period`}>
          {t("finder.period")}
          <small>{t("finder.period.hint")}</small>
        </span>
        <div className="fopts">
          <div className="seg">
            {MONTHS.map((n) => (
              <button
                key={n}
                type="button"
                aria-pressed={!custom && period.months === n}
                onClick={() => onPeriod({ months: n })}
              >
                {n === 1 ? t("finder.months.one") : t("finder.months.other", { n })}
              </button>
            ))}
            <button type="button" aria-pressed={custom} onClick={() => !custom && onPeriod(range)}>
              {t("finder.custom")}
            </button>
          </div>
          {custom && (
            <span className="dates">
              <input
                type="date"
                aria-label={t("finder.from")}
                min={today}
                max={windowEnd(today)}
                value={range.from}
                onChange={(e) => setDate("from", e.target.value)}
              />
              {t("finder.until")}
              <input
                type="date"
                aria-label={t("finder.to")}
                min={today}
                max={windowEnd(today)}
                value={range.to}
                onChange={(e) => setDate("to", e.target.value)}
              />
            </span>
          )}
        </div>
      </div>

      <div className="frow" role="group" aria-labelledby={`${id}-length`}>
        <span className="flabel" id={`${id}-length`}>
          {t("finder.length")}
          <small>{t("finder.length.hint")}</small>
        </span>
        <div className="fopts">
          <span className="stepper">
            <button
              type="button"
              className="icon-btn"
              aria-label={t("finder.fewer")}
              disabled={prefs.length <= 1}
              onClick={() => setPrefs({ length: prefs.length - 1 })}
            >
              −
            </button>
            <output aria-live="polite">
              {prefs.length === 1 ? t("finder.days.one") : t("finder.days.other", { n: prefs.length })}
            </output>
            <button
              type="button"
              className="icon-btn"
              aria-label={t("finder.more")}
              disabled={prefs.length >= 14}
              onClick={() => setPrefs({ length: prefs.length + 1 })}
            >
              +
            </button>
          </span>
        </div>
      </div>

      <div className="frow" role="group" aria-labelledby={`${id}-weekdays`}>
        <span className="flabel" id={`${id}-weekdays`}>
          {t("finder.weekdays")}
          <small>{t("finder.weekdays.hint")}</small>
        </span>
        <div className="fopts">
          {weekdayNames.map((name, w) => (
            <button
              key={w}
              type="button"
              className="cchip"
              aria-pressed={prefs.weekdays.includes(w)}
              onClick={() => toggleWeekday(w)}
            >
              <span className="box" aria-hidden="true">
                ✓
              </span>
              {name}
            </button>
          ))}
          <span className="presets">
            {(Object.keys(PRESETS) as (keyof typeof PRESETS)[]).map((p) => (
              <button key={p} type="button" onClick={() => setPrefs({ weekdays: [...PRESETS[p]] })}>
                {t(`finder.preset.${p}`)}
              </button>
            ))}
          </span>
        </div>
      </div>

      <div className="frow" role="group" aria-labelledby={`${id}-unsure`}>
        <span className="flabel" id={`${id}-unsure`}>
          {t("finder.unsure")}
        </span>
        <div className="fopts">
          <button
            type="button"
            className="switch"
            aria-pressed={prefs.maybeCountsAsFree}
            onClick={() => setPrefs({ maybeCountsAsFree: !prefs.maybeCountsAsFree })}
          >
            <span className="track" aria-hidden="true" />
            {t("finder.maybeFree")}
          </button>
        </div>
      </div>

      <div className="result" role="group" aria-labelledby={`${id}-result`}>
        <span className="flabel" id={`${id}-result`}>
          {t("finder.result")}
          <small aria-live="polite">
            {runs === null
              ? "…"
              : t(runs.length === 1 ? `${countKey}.one` : `${countKey}.other`, { n: runs.length })}
          </small>
        </span>
        {runs !== null &&
          (runs.length > 0 ? (
            <div className="matches">
              {runsByMonth(runs).map(({ month, runs: inMonth }) => (
                <div key={month} className="mgroup">
                  <span className="mname">{fmt.month.format(utc(`${month}-01`))}</span>
                  {inMonth.map((r) => (
                    <button
                      key={r.start}
                      type="button"
                      className="bchip"
                      data-start={r.start}
                      title={
                        r.start === r.end
                          ? fmt.long.format(utc(r.start))
                          : `${fmt.long.format(utc(r.start))} – ${fmt.long.format(utc(r.end))}`
                      }
                      onClick={() => onPick(r)}
                    >
                      {runLabel(r)}
                    </button>
                  ))}
                </div>
              ))}
            </div>
          ) : (
            <span className="none">{t("finder.none")}</span>
          ))}
      </div>
    </div>
  );
}
