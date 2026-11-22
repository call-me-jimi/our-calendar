import { useI18n } from "../i18n/I18n";

/** A failed load, said out loud, with a retry (P6.4). */
export function LoadError({ onRetry }: { onRetry: () => void }) {
  const { t } = useI18n();
  return (
    <p className="error" role="alert">
      {t("error.load")}{" "}
      <button type="button" className="link" onClick={onRetry}>
        {t("common.retry")}
      </button>
    </p>
  );
}
