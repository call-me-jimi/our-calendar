import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { useI18n } from "../i18n/I18n";
import { api } from "../lib/api";
import { LoadError } from "./LoadError";
import { Sheet } from "./Sheet";

const feedKey = (gid: number) => ["group", gid, "feed-token"] as const;

/** "Subscribe to events" (spec §3.10): a personal feed URL, shown once; a new one replaces it. */
export function FeedSheet({ gid, onClose }: { gid: number; onClose: () => void }) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const [url, setUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const status = useQuery({
    queryKey: feedKey(gid),
    queryFn: () => api<{ active: boolean }>(`/api/groups/${gid}/feed-token`),
  });
  const create = useMutation({
    mutationFn: () => api<{ url: string }>(`/api/groups/${gid}/feed-token`, { method: "POST" }),
    onSuccess: (r) => {
      setUrl(r.url);
      setCopied(false);
      queryClient.setQueryData(feedKey(gid), { active: true });
    },
  });

  async function copy() {
    if (!url) return;
    await navigator.clipboard.writeText(url);
    setCopied(true);
  }

  return (
    <Sheet title={t("feed.title")} onClose={onClose}>
      <p>{t("feed.explain")}</p>
      {url ? (
        <div className="new-link stack">
          <p>{t("feed.newLink")}</p>
          <div className="copy-row">
            <input readOnly value={url} aria-label={t("feed.label")} onFocus={(e) => e.target.select()} />
            <button type="button" onClick={copy}>
              {copied ? t("settings.copied") : t("settings.copy")}
            </button>
          </div>
        </div>
      ) : (
        status.data && (
          <button type="button" onClick={() => create.mutate()} disabled={create.isPending}>
            {status.data.active ? t("feed.recreate") : t("feed.create")}
          </button>
        )
      )}
      {status.isError && <LoadError onRetry={() => void status.refetch()} />}
      {create.isError && (
        <p className="error" role="alert">
          {t("error.generic")}
        </p>
      )}
    </Sheet>
  );
}
