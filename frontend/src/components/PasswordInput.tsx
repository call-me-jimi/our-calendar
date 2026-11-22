import { useId, useState, type InputHTMLAttributes } from "react";

import { useI18n } from "../i18n/I18n";

/** A password field with a Show/Hide button, so a typo can be caught before it's saved. */
export function PasswordInput({ label, ...props }: { label: string } & InputHTMLAttributes<HTMLInputElement>) {
  const { t } = useI18n();
  const id = useId();
  const [shown, setShown] = useState(false);

  // The label sits outside the row: inside it, the button's text would become part of the field's name.
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <div className="password-row">
        <input {...props} id={id} type={shown ? "text" : "password"} />
        <button type="button" className="secondary" onClick={() => setShown(!shown)}>
          {shown ? t("password.hide") : t("password.show")}
        </button>
      </div>
    </div>
  );
}
