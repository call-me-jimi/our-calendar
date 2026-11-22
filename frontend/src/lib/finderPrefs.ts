// The "Passende Tage finden" filters, remembered per group in this browser (plan P8.6). The period is
// not remembered: it always starts as 12 months, since a custom from–to would go stale.

export type FinderPrefs = { weekdays: number[]; length: number; maybeCountsAsFree: boolean };

export const DEFAULT_FINDER_PREFS: FinderPrefs = {
  weekdays: [0, 1, 2, 3, 4, 5, 6],
  length: 1,
  maybeCountsAsFree: false,
};

const key = (gid: number) => `finder.${gid}`;
const isIn = (n: unknown, min: number, max: number) => Number.isInteger(n) && (n as number) >= min && (n as number) <= max;

export function readFinderPrefs(gid: number): FinderPrefs {
  try {
    const stored = JSON.parse(localStorage.getItem(key(gid)) ?? "null") as Partial<
      Record<keyof FinderPrefs, unknown>
    > | null;
    const { weekdays, length, maybeCountsAsFree } = stored ?? {};
    return {
      weekdays:
        Array.isArray(weekdays) && weekdays.every((w) => isIn(w, 0, 6))
          ? (weekdays as number[])
          : DEFAULT_FINDER_PREFS.weekdays,
      length: isIn(length, 1, 14) ? (length as number) : DEFAULT_FINDER_PREFS.length,
      maybeCountsAsFree:
        typeof maybeCountsAsFree === "boolean" ? maybeCountsAsFree : DEFAULT_FINDER_PREFS.maybeCountsAsFree,
    };
  } catch {
    return DEFAULT_FINDER_PREFS; // storage blocked or not JSON
  }
}

export function writeFinderPrefs(gid: number, prefs: FinderPrefs): void {
  try {
    localStorage.setItem(key(gid), JSON.stringify(prefs));
  } catch {
    // storage blocked: the choice still holds for this page
  }
}
