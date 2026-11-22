import { useId } from "react";

import { useI18n } from "../i18n/I18n";

const INTRO_KEY = "introSeen";

export function introSeenBefore(): boolean {
  try {
    return localStorage.getItem(INTRO_KEY) === "1";
  } catch {
    return false; // storage blocked: show the card
  }
}

/** "So funktioniert's": shown on the first visit to Meine Tage, and again by "?" on either tab (spec §3.3). */
export function IntroCard({ onDone }: { onDone: () => void }) {
  const { t } = useI18n();
  const id = useId();
  return (
    <section className="intro" aria-labelledby={id}>
      <div>
        <h2 id={id}>{t("mine.intro.title")}</h2>
        <ol className="steps">
          {([1, 2, 3] as const).map((n) => (
            <li key={n}>
              <span className="n" aria-hidden="true">
                {n}
              </span>
              <div>
                <b>{t(`mine.intro.step${n}`)}</b>
                <p>{t(`mine.intro.step${n}Text`)}</p>
              </div>
            </li>
          ))}
        </ol>
      </div>
      <button
        type="button"
        className="btn"
        onClick={() => {
          try {
            localStorage.setItem(INTRO_KEY, "1");
          } catch {
            // storage blocked: the card comes back on the next visit
          }
          onDone();
        }}
      >
        {t("mine.intro.ok")}
      </button>
    </section>
  );
}
