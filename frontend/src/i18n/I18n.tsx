import { useQueryClient } from "@tanstack/react-query";
import { createContext, use, useCallback, useEffect, useMemo, useState, type ReactNode } from "react";

import { api } from "../lib/api";
import { ME_KEY, useMe, type Me } from "../lib/auth";
import { browserLocale, storeLocale, translate, type Locale, type MessageKey } from "./translate";

type I18n = {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  t: (key: MessageKey, vars?: Record<string, string | number>) => string;
};

const Ctx = createContext<I18n | null>(null);

/** Signed in, the user's stored language wins; otherwise the browser's or the last choice. */
export function I18nProvider({ children }: { children: ReactNode }) {
  const { data: me } = useMe();
  const queryClient = useQueryClient();
  const [anonLocale, setAnonLocale] = useState<Locale>(browserLocale);
  const locale = me?.locale ?? anonLocale;

  const setLocale = useCallback(
    (next: Locale) => {
      setAnonLocale(next);
      storeLocale(next);
      if (me) {
        const updated: Me = { ...me, locale: next };
        queryClient.setQueryData(ME_KEY, updated);
        void api<Me>("/api/me", { method: "PATCH", body: { locale: next } });
      }
    },
    [me, queryClient],
  );

  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  const value = useMemo<I18n>(
    () => ({ locale, setLocale, t: (key, vars) => translate(locale, key, vars) }),
    [locale, setLocale],
  );
  return <Ctx value={value}>{children}</Ctx>;
}

export function useI18n(): I18n {
  const ctx = use(Ctx);
  if (!ctx) throw new Error("useI18n outside I18nProvider");
  return ctx;
}
