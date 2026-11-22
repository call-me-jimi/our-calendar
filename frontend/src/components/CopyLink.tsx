import { useState, type ReactNode } from "react";

import { useI18n } from "../i18n/I18n";

/** A secret link with a Copy button (invite and sign-in links). */
export function CopyLink({ url, label, children }: { url: string; label: string; children?: ReactNode }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);

  async function copy() {
    await navigator.clipboard.writeText(url);
    setCopied(true);
  }

  return (
    <div className="new-link stack">
      {children}
      <div className="copy-row">
        <input readOnly value={url} aria-label={label} onFocus={(e) => e.target.select()} />
        <button type="button" onClick={copy}>
          {copied ? t("settings.copied") : t("settings.copy")}
        </button>
      </div>
    </div>
  );
}
