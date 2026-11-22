import de from "./de.json";
import en from "./en.json";

export type Locale = "de" | "en";
export type MessageKey = keyof typeof de;

// Typed against the German file: a key missing in English fails the type check.
const messages: Record<Locale, Record<MessageKey, string>> = { de, en };

export function translate(
  locale: Locale,
  key: MessageKey,
  vars: Record<string, string | number> = {},
): string {
  return messages[locale][key].replace(/\{(\w+)\}/g, (m, name: string) =>
    name in vars ? String(vars[name]) : m,
  );
}

const STORAGE_KEY = "locale";

/** Before sign-in: the stored choice, else the browser's language (spec §3.13). */
export function browserLocale(): Locale {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === "de" || stored === "en") return stored;
  } catch {
    // storage blocked: fall through
  }
  return navigator.language.toLowerCase().startsWith("de") ? "de" : "en";
}

export function storeLocale(locale: Locale): void {
  try {
    localStorage.setItem(STORAGE_KEY, locale);
  } catch {
    // storage blocked: the choice still holds for this page
  }
}
