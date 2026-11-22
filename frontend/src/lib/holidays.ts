// Holidays from the server's OpenHolidays copy (spec §3.8): information only.
import { useQuery } from "@tanstack/react-query";

import { api } from "./api";
import { compareDays, expandRange, type Day } from "./days";
import { REGIONS, type Region } from "./groups";

export type Holiday = {
  kind: "public" | "school";
  subdivision: "DE" | Region; // "DE" = nationwide public holiday
  start_day: Day;
  end_day: Day;
  name_de: string;
  name_en: string;
};

/** What a day shows: the stripes, the bank-holiday marker, and the holidays behind them. */
export type DayHolidays = { schoolBE: boolean; schoolBB: boolean; bank: boolean; holidays: Holiday[] };
export type HolidayIndex = ReadonlyMap<Day, DayHolidays>;

/** Holidays overlapping [from, to] for the group's regions; none asked for without regions. */
export function useHolidays(from: Day, to: Day, regions: readonly Region[]) {
  const key = [...regions].sort().join(",");
  return useQuery({
    queryKey: ["holidays", from, to, key] as const,
    queryFn: () =>
      api<{ holidays: Holiday[] }>(`/api/holidays?from=${from}&to=${to}&regions=${key}`).then((r) => r.holidays),
    enabled: regions.length > 0,
    staleTime: 60 * 60_000, // changes at most once a day (sync at 04:00)
    placeholderData: (previous) => previous,
  });
}

/** Only nationwide holidays and those of the group's regions count (§3.8). */
export function indexHolidays(holidays: readonly Holiday[], regions: readonly Region[]): HolidayIndex {
  const index = new Map<Day, DayHolidays>();
  if (regions.length === 0) return index;
  for (const h of holidays) {
    if (h.subdivision !== "DE" && !regions.includes(h.subdivision)) continue;
    if (compareDays(h.start_day, h.end_day) > 0) continue;
    for (const day of expandRange(h.start_day, h.end_day)) {
      let entry = index.get(day);
      if (!entry) {
        entry = { schoolBE: false, schoolBB: false, bank: false, holidays: [] };
        index.set(day, entry);
      }
      if (h.kind === "public") entry.bank = true;
      else if (h.subdivision === "DE-BE") entry.schoolBE = true;
      else if (h.subdivision === "DE-BB") entry.schoolBB = true;
      entry.holidays.push(h);
    }
  }
  return index;
}

/**
 * Names in the UI language, public holidays first. Regional ones name their region; the same
 * name in both regions becomes one label, e.g. "Herbstferien (Berlin, Brandenburg)".
 */
export function holidayLabels(
  holidays: readonly Holiday[],
  locale: "de" | "en",
  regionName: (r: Region) => string,
): string[] {
  const merged = new Map<string, { name: string; nationwide: boolean; regions: Region[] }>();
  const sorted = [...holidays].sort((a, b) => Number(a.kind === "school") - Number(b.kind === "school"));
  for (const h of sorted) {
    const name = locale === "de" ? h.name_de : h.name_en;
    const key = `${h.kind}:${name}`;
    const entry = merged.get(key) ?? { name, nationwide: false, regions: [] };
    if (h.subdivision === "DE") entry.nationwide = true;
    else if (!entry.regions.includes(h.subdivision)) entry.regions.push(h.subdivision);
    merged.set(key, entry);
  }
  return [...merged.values()].map(({ name, nationwide, regions }) =>
    nationwide || regions.length === 0 ? name : `${name} (${REGIONS.filter((r) => regions.includes(r)).map(regionName).join(", ")})`,
  );
}
