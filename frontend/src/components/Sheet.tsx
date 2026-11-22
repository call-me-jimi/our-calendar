import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";

import { useI18n } from "../i18n/I18n";

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex="0"]';

/**
 * A bottom sheet as a modal dialog (P6.4): named by its heading, Escape closes it, focus moves in
 * when it opens, Tab stays inside, and focus goes back where it was when it closes.
 */
export function Sheet({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const { t } = useI18n();
  const ref = useRef<HTMLDivElement>(null);
  const headingId = useId();

  // Where the focus was before opening (read on the first render, before an autoFocus field moves it).
  const [previous] = useState(() => (document.activeElement instanceof HTMLElement ? document.activeElement : null));

  useEffect(() => {
    // An autoFocus field inside has already taken the focus; otherwise the sheet itself takes it.
    if (!ref.current?.contains(document.activeElement)) ref.current?.focus();
    return () => {
      // Only if the focus went down with the sheet (not when another sheet took it, e.g. "Edit").
      const lost = document.activeElement === null || document.activeElement === document.body;
      if (lost && previous?.isConnected) previous.focus();
    };
  }, [previous]);

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key === "Escape") {
      e.stopPropagation();
      onClose();
      return;
    }
    if (e.key !== "Tab") return;
    const items = Array.from(e.currentTarget.querySelectorAll<HTMLElement>(FOCUSABLE));
    const first = items[0];
    const last = items[items.length - 1];
    if (!first || !last) return;
    const active = document.activeElement;
    if (e.shiftKey && (active === first || active === e.currentTarget)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  }

  return (
    <div
      ref={ref}
      className="sheet"
      role="dialog"
      aria-modal="true"
      aria-labelledby={headingId}
      tabIndex={-1}
      onKeyDown={onKeyDown}
    >
      <div className="sheet-top">
        <h3 id={headingId} className="sheet-title">
          {title}
        </h3>
        <button type="button" className="icon-btn close" onClick={onClose} aria-label={t("common.close")}>
          ✕
        </button>
      </div>
      {children}
    </div>
  );
}
