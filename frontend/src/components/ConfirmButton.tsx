import { useState } from "react";

import { useI18n } from "../i18n/I18n";

/** A two-step button: the first click asks, the second does it. No browser dialogs. */
export function ConfirmButton({
  label,
  question,
  onConfirm,
  disabled,
}: {
  label: string;
  question: string;
  onConfirm: () => void;
  disabled?: boolean;
}) {
  const { t } = useI18n();
  const [asking, setAsking] = useState(false);
  if (!asking) {
    return (
      <button type="button" className="secondary" onClick={() => setAsking(true)} disabled={disabled}>
        {label}
      </button>
    );
  }
  return (
    <span className="confirm" role="group" aria-label={question}>
      <span>{question}</span>
      <button
        type="button"
        onClick={() => {
          setAsking(false);
          onConfirm();
        }}
      >
        {t("common.yes")}
      </button>
      <button type="button" className="secondary" onClick={() => setAsking(false)}>
        {t("common.cancel")}
      </button>
    </span>
  );
}
