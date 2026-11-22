// Calendar-day logic. Days are plain dates "YYYY-MM-DD"; all arithmetic is done in UTC
// so local time zones and DST never shift a day.

export type Day = string; // "YYYY-MM-DD"
export type MarkState = "busy" | "maybe";
export type State = MarkState | "free";
export type Mark = { day: Day; state: MarkState; note: string | null };
export type DayChange = { day: Day; state: State; note: string | null };
export type YearMonth = { year: number; month: number }; // month 1–12

const MS_PER_DAY = 86_400_000;
const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function utc(year: number, month: number, day: number): Date {
  const d = new Date(0);
  d.setUTCFullYear(year, month - 1, day); // avoids Date.UTC's 0–99 → 1900s mapping
  return d;
}

function parse(day: Day): Date {
  const [y, m, d] = day.split("-").map(Number);
  return utc(y ?? NaN, m ?? NaN, d ?? NaN);
}

function format(date: Date): Day {
  const y = String(date.getUTCFullYear()).padStart(4, "0");
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function daysInMonth(year: number, month: number): number {
  return utc(year, month + 1, 0).getUTCDate();
}

export function isDay(s: string): boolean {
  const m = DAY_RE.exec(s);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  return mo >= 1 && mo <= 12 && d >= 1 && d <= daysInMonth(y, mo);
}

export function addDays(day: Day, n: number): Day {
  const d = parse(day);
  d.setUTCDate(d.getUTCDate() + n);
  return format(d);
}

export function compareDays(a: Day, b: Day): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function daysBetween(a: Day, b: Day): number {
  return Math.round((parse(b).getTime() - parse(a).getTime()) / MS_PER_DAY);
}

export function weekday(day: Day): number {
  return (parse(day).getUTCDay() + 6) % 7;
}

export function todayBerlin(now: Date = new Date()): Day {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Berlin",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

export function addMonths(day: Day, n: number): Day {
  const { year, month } = addYearMonth(yearMonthOf(day), n);
  const d = Number(day.slice(8, 10));
  return format(utc(year, month, Math.min(d, daysInMonth(year, month))));
}

export function windowEnd(today: Day): Day {
  return addMonths(today, 12);
}

export function inWindow(day: Day, today: Day): boolean {
  return compareDays(today, day) <= 0 && compareDays(day, windowEnd(today)) <= 0;
}

export function expandRange(a: Day, b: Day): Day[] {
  const [start, end] = compareDays(a, b) <= 0 ? [a, b] : [b, a];
  const n = daysBetween(start, end);
  const out: Day[] = [];
  for (let i = 0; i <= n; i++) out.push(addDays(start, i));
  return out;
}

export function yearMonthOf(day: Day): YearMonth {
  return { year: Number(day.slice(0, 4)), month: Number(day.slice(5, 7)) };
}

export function addYearMonth(ym: YearMonth, n: number): YearMonth {
  const total = ym.year * 12 + (ym.month - 1) + n;
  return { year: Math.floor(total / 12), month: (((total % 12) + 12) % 12) + 1 };
}

export function firstDay(ym: YearMonth): Day {
  return format(utc(ym.year, ym.month, 1));
}

export function lastDay(ym: YearMonth): Day {
  return format(utc(ym.year, ym.month, daysInMonth(ym.year, ym.month)));
}

export function monthGrid(ym: YearMonth): (Day | null)[][] {
  const cells: (Day | null)[] = Array<Day | null>(weekday(firstDay(ym))).fill(null);
  cells.push(...expandRange(firstDay(ym), lastDay(ym)));
  while (cells.length % 7 !== 0) cells.push(null);
  const weeks: (Day | null)[][] = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
  return weeks;
}

export function previousOf(days: Day[], current: ReadonlyMap<Day, Mark>): DayChange[] {
  return days.map((day) => {
    const mark = current.get(day);
    return mark ? { day, state: mark.state, note: mark.note } : { day, state: "free", note: null };
  });
}
