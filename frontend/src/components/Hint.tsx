import { useState, type ReactNode } from "react";

import { useI18n } from "../i18n/I18n";

/** Whether the hint line above a calendar is open; remembered per page in this browser. */
export function useHintOpen(page: "mine" | "group"): [boolean, (open: boolean) => void] {
  const key = `${page}.hintOpen`;
  const [open, setOpen] = useState(() => {
    try {
      return localStorage.getItem(key) !== "0";
    } catch {
      return true; // storage blocked
    }
  });
  function set(next: boolean) {
    setOpen(next);
    try {
      localStorage.setItem(key, next ? "1" : "0");
    } catch {
      // storage blocked: the choice still holds for this page
    }
  }
  return [open, set];
}

/** The hint line (spec §3.3): an icon, the text, and × to close it. `active` is a step of what the
 *  user is doing (highlighted, no ×). Closed, it stays closed even for a step: appearing would push
 *  the calendar down mid-drag. The text stays for screen readers (it describes the grid), and
 *  `HintOpener` brings it back. */
export function Hint(props: {
  id: string;
  open: boolean;
  active: boolean;
  icon?: ReactNode;
  onClose: () => void;
  children: ReactNode;
}) {
  const { t } = useI18n();
  const { id, open, active, icon = "i", onClose, children } = props;
  const text = (
    <span id={id} role="status" className={open ? undefined : "sr-only"}>
      {children}
    </span>
  );
  if (!open) return text;
  return (
    <div className={active ? "hint active" : "hint"}>
      <span className="ico" aria-hidden="true">
        {icon}
      </span>
      {text}
      {!active && (
        <button type="button" className="hint-close" aria-label={t("hint.close")} title={t("hint.close")} onClick={onClose}>
          ×
        </button>
      )}
    </div>
  );
}

/** The "i" that opens a closed hint again; sits in the toolbar above the calendar. */
export function HintOpener({ onOpen }: { onOpen: () => void }) {
  const { t } = useI18n();
  return (
    <button type="button" className="ico hint-open" aria-label={t("hint.show")} title={t("hint.show")} onClick={onOpen}>
      i
    </button>
  );
}
