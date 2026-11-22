import { expect, test } from "vitest";

import de from "./de.json";
import en from "./en.json";
import { translate } from "./translate";

test("both languages have the same keys", () => {
  expect(Object.keys(en).sort()).toEqual(Object.keys(de).sort());
});

test("no empty messages", () => {
  for (const dict of [de, en]) {
    for (const [key, text] of Object.entries(dict)) expect(text, key).not.toBe("");
  }
});

test("both languages use the same placeholders", () => {
  const vars = (text: string) => [...new Set(text.match(/\{\w+\}/g) ?? [])].sort();
  const english: Record<string, string> = en;
  for (const [key, text] of Object.entries(de)) {
    expect(vars(english[key] ?? ""), key).toEqual(vars(text));
  }
});

test("placeholders are filled, unknown ones kept", () => {
  expect(translate("de", "home.hello", { name: "Anna" })).toBe("Hallo Anna!");
  expect(translate("en", "home.hello")).toBe("Hi {name}!");
});
