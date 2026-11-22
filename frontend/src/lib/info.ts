import { useQuery } from "@tanstack/react-query";

import { api } from "./api";

/** Public facts about this instance (spec §5). */
export type Info = { mail_enabled: boolean; operator_name: string | null };

export const INFO_KEY = ["info"] as const;

export function useInfo() {
  return useQuery({
    queryKey: INFO_KEY,
    queryFn: () => api<Info>("/api/info"),
    staleTime: Infinity,
    retry: false, // on failure, pages fall back to the mail flow
  });
}
