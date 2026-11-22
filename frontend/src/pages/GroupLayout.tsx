import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { NavLink, Outlet, useNavigate, useOutletContext, useParams } from "react-router";

import { ConfirmButton } from "../components/ConfirmButton";
import { FeedSheet } from "../components/FeedSheet";
import { LoadError } from "../components/LoadError";
import { useI18n } from "../i18n/I18n";
import { api, ApiError } from "../lib/api";
import type { Me } from "../lib/auth";
import { groupsKey, useGroup, useGroups, type Group } from "../lib/groups";
import { useCloseOnOutsideClick } from "../lib/useCloseOnOutsideClick";

export type GroupContext = { me: Me; group: Group };

export function useGroupContext(): GroupContext {
  return useOutletContext<GroupContext>();
}

/** Group name (with a switcher), tabs, and the group menu; the tab renders in the outlet. */
export function GroupLayout({ me }: { me: Me }) {
  const { t } = useI18n();
  const gid = Number(useParams().gid);
  const { data: group, error, isPending, refetch } = useGroup(gid);
  const { data: groups } = useGroups();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const menuRef = useRef<HTMLDetailsElement>(null);
  useCloseOnOutsideClick(menuRef);
  const [feedOpen, setFeedOpen] = useState(false);

  const leave = useMutation({
    mutationFn: () => api(`/api/groups/${gid}/members/${me.id}`, { method: "DELETE" }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: groupsKey });
      navigate("/", { replace: true });
    },
  });

  if (isPending) return null;
  if (error) {
    if (error instanceof ApiError && error.status === 404) return <p className="error">{t("group.notFound")}</p>;
    return <LoadError onRetry={() => void refetch()} />;
  }

  const switchable = (groups ?? []).filter((g) => g.is_member || me.is_instance_admin);
  const lastAdminError = leave.error instanceof ApiError && leave.error.code === "last_admin";

  return (
    <section>
      <div className="group-head">
        {switchable.length > 1 ? (
          <select
            className="group-switch"
            aria-label={t("group.switch")}
            value={gid}
            onChange={(e) => navigate(`/g/${e.target.value}/days`)}
          >
            {switchable.map((g) => (
              <option key={g.id} value={g.id}>
                {g.name}
              </option>
            ))}
          </select>
        ) : (
          <h1 className="group-name">{group.name}</h1>
        )}
        <div className="group-meta">
          <span className="faces" aria-hidden="true">
            {group.members.slice(0, 5).map((m) => (
              <span key={m.id} title={m.display_name}>
                {m.display_name.charAt(0).toUpperCase()}
              </span>
            ))}
          </span>
          <span>{t("admin.members", { count: group.members.length })}</span>
        </div>
        <nav className="tabs">
          <NavLink to="days">{t("group.tab.mine")}</NavLink>
          <NavLink to="group">{t("group.tab.group")}</NavLink>
          {group.role === "admin" && <NavLink to="settings">{t("group.tab.settings")}</NavLink>}
        </nav>
        {group.is_member && (
          <details className="menu" ref={menuRef}>
            <summary aria-label={t("group.menu")}>⋯</summary>
            <div className="menu-body stack">
              <button
                type="button"
                className="secondary"
                onClick={() => {
                  if (menuRef.current) menuRef.current.open = false;
                  setFeedOpen(true);
                }}
              >
                {t("feed.title")}
              </button>
              <ConfirmButton
                label={t("group.leave")}
                question={t("group.leaveConfirm")}
                onConfirm={() => leave.mutate()}
                disabled={leave.isPending}
              />
              {lastAdminError && <p className="error">{t("group.lastAdmin")}</p>}
              {leave.isError && !lastAdminError && <p className="error">{t("error.generic")}</p>}
            </div>
          </details>
        )}
      </div>
      <Outlet context={{ me, group } satisfies GroupContext} />
      {feedOpen && <FeedSheet key={gid} gid={gid} onClose={() => setFeedOpen(false)} />}
    </section>
  );
}
