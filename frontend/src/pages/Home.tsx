import { Link, Navigate } from "react-router";

import { LoadError } from "../components/LoadError";
import { useI18n } from "../i18n/I18n";
import type { Me } from "../lib/auth";
import { useGroups } from "../lib/groups";

/** One group: go straight in. Several: pick one. None: ask for an invite (spec §3.3). */
export function Home({ me }: { me: Me }) {
  const { t } = useI18n();
  const { data: groups, isPending, isError, refetch } = useGroups();
  if (isPending) return null;
  if (isError) return <LoadError onRetry={() => void refetch()} />;

  const mine = groups.filter((g) => g.is_member);
  if (mine.length === 1 && !me.is_instance_admin) {
    return <Navigate to={`/g/${mine[0]!.id}/days`} replace />;
  }

  return (
    <section>
      <h1>{t("home.hello", { name: me.display_name })}</h1>
      {groups.length === 0 ? (
        <p className="muted">{me.is_instance_admin ? t("home.adminHint") : t("home.noGroups")}</p>
      ) : (
        <>
          <h2>{t("home.title")}</h2>
          <ul className="cards">
            {groups.map((g) => (
              <li key={g.id}>
                <Link to={`/g/${g.id}/days`}>{g.name}</Link>
                <span className="muted"> · {t("admin.members", { count: g.member_count })}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
