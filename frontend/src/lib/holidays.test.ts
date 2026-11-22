import { describe, expect, it } from "vitest";

import { holidayLabels, indexHolidays, type Holiday } from "./holidays";

const h = (kind: Holiday["kind"], subdivision: Holiday["subdivision"], start: string, end: string, de: string, en = de): Holiday => ({
  kind,
  subdivision,
  start_day: start,
  end_day: end,
  name_de: de,
  name_en: en,
});

const holidays = [
  h("public", "DE", "2027-10-03", "2027-10-03", "Tag der Deutschen Einheit", "German Unity Day"),
  h("public", "DE-BB", "2027-10-31", "2027-10-31", "Reformationstag", "Reformation Day"),
  h("public", "DE-BE", "2027-03-08", "2027-03-08", "Frauentag", "Women's Day"),
  h("school", "DE-BE", "2027-10-11", "2027-10-23", "Herbstferien", "Autumn holidays"),
  h("school", "DE-BB", "2027-10-11", "2027-10-23", "Herbstferien", "Autumn holidays"),
  h("school", "DE-BB", "2027-10-25", "2027-10-25", "Unterrichtsfreier Tag"),
];
const regionName = (r: string) => (r === "DE-BE" ? "Berlin" : "Brandenburg");

describe("indexHolidays", () => {
  it("classifies stripes and bank holidays per day for the group's regions", () => {
    const index = indexHolidays(holidays, ["DE-BE", "DE-BB"]);
    expect(index.get("2027-10-03")).toMatchObject({ bank: true, schoolBE: false, schoolBB: false });
    expect(index.get("2027-10-31")).toMatchObject({ bank: true });
    expect(index.get("2027-10-11")).toMatchObject({ bank: false, schoolBE: true, schoolBB: true });
    expect(index.get("2027-10-23")).toMatchObject({ schoolBE: true, schoolBB: true });
    expect(index.get("2027-10-25")).toMatchObject({ schoolBE: false, schoolBB: true });
    expect(index.has("2027-10-24")).toBe(false);
  });

  it("leaves out other regions but keeps nationwide holidays", () => {
    const index = indexHolidays(holidays, ["DE-BE"]);
    expect(index.get("2027-10-03")?.bank).toBe(true);
    expect(index.has("2027-10-31")).toBe(false); // Reformationstag is Brandenburg only
    expect(index.get("2027-03-08")?.bank).toBe(true);
    expect(index.get("2027-10-11")).toMatchObject({ schoolBE: true, schoolBB: false });
    expect(index.has("2027-10-25")).toBe(false);
  });

  it("shows nothing without regions", () => {
    expect(indexHolidays(holidays, []).size).toBe(0);
  });
});

describe("holidayLabels", () => {
  it("names the region of regional holidays, in the UI language", () => {
    const day = indexHolidays(holidays, ["DE-BE", "DE-BB"]).get("2027-10-31")!.holidays;
    expect(holidayLabels(day, "de", regionName)).toEqual(["Reformationstag (Brandenburg)"]);
    expect(holidayLabels(day, "en", regionName)).toEqual(["Reformation Day (Brandenburg)"]);
  });

  it("keeps nationwide names plain and merges the same school holiday of both regions", () => {
    const list = [holidays[3]!, holidays[0]!, holidays[4]!];
    expect(holidayLabels(list, "de", regionName)).toEqual([
      "Tag der Deutschen Einheit",
      "Herbstferien (Berlin, Brandenburg)",
    ]);
  });
});
