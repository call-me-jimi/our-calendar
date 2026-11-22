import { Link } from "react-router";

import { useI18n } from "../i18n/I18n";
import type { MessageKey } from "../i18n/translate";
import { useInfo } from "../lib/info";

const STORED: MessageKey[] = [
  "privacy.stored.account",
  "privacy.stored.days",
  "privacy.stored.events",
  "privacy.stored.sessions",
  "privacy.stored.limits",
  "privacy.stored.logs",
];

/** The privacy note (spec §3.15): public, no sign-in needed. A plain note, not a legal policy. */
export function Privacy() {
  const { t } = useI18n();
  const operator = useInfo().data?.operator_name;

  return (
    <article className="prose card">
      <h1>{t("privacy.title")}</h1>
      <p>{t("privacy.intro")}</p>

      <h2>{t("privacy.stored.title")}</h2>
      <ul>
        {STORED.map((key) => (
          <li key={key}>{t(key)}</li>
        ))}
      </ul>

      <h2>{t("privacy.who.title")}</h2>
      <p>{t("privacy.who.text")}</p>

      <h2>{t("privacy.keep.title")}</h2>
      <p>{t("privacy.keep.text")}</p>

      <h2>{t("privacy.backup.title")}</h2>
      <p>{t("privacy.backup.text")}</p>

      <h2>{t("privacy.tracking.title")}</h2>
      <p>{t("privacy.tracking.text")}</p>
      <p>{t("privacy.tracking.server")}</p>

      <h2>{t("privacy.delete.title")}</h2>
      <p>
        {t("privacy.delete.text")} <Link to="/me">{t("privacy.delete.link")}</Link>
      </p>

      <h2>{t("privacy.contact.title")}</h2>
      <p>
        {operator
          ? t("privacy.contact.named", { name: operator })
          : t("privacy.contact.unnamed")}
      </p>
    </article>
  );
}
