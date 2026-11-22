import { useQuery } from "@tanstack/react-query";

import type { Locale } from "../i18n/translate";
import { api, ApiError } from "./api";

export type Me = {
  id: number;
  email: string;
  display_name: string;
  locale: Locale;
  is_instance_admin: boolean;
  has_password: boolean;
};

export const ME_KEY = ["me"] as const;

/** The signed-in user, or `null` when nobody is. */
export function useMe() {
  return useQuery({
    queryKey: ME_KEY,
    queryFn: async (): Promise<Me | null> => {
      try {
        return await api<Me>("/api/me");
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) return null;
        throw e;
      }
    },
    staleTime: 60_000,
  });
}
