import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router";

import { LoadError } from "../components/LoadError";
import { useI18n } from "../i18n/I18n";
import { api, ApiError } from "../lib/api";
import type { Me } from "../lib/auth";
import { groupsKey, useGroups, type Group, type GroupSummary } from "../lib/groups";

type Sync = { started_at: string; finished_at: string | null; ok: boolean; message: string | null };
type AdminStatus = { last_sync: Sync | null; last_success: Sync | null };
type AdminUser = {
  id: number;
  email: string;
  display_name: string;
  is_instance_admin: boolean;
  has_password: boolean;
  created_at: string;
  groups: string[];
};
const USERS_KEY = ["admin", "users"] as const;

/** Instance admin only (spec §3.12): all groups (create, delete), all accounts (delete), and the
 *  holiday sync status. */
export function Admin({ me }: { me: Me }) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { data: groups } = useGroups();
  const [name, setName] = useState("");

  const create = useMutation({
    mutationFn: (groupName: string) =>
      api<Group>("/api/groups", { method: "POST", body: { name: groupName } }),
    onSuccess: async (g) => {
      await queryClient.invalidateQueries({ queryKey: groupsKey });
      navigate(`/g/${g.id}/settings`);
    },
  });

  if (!me.is_instance_admin) return <p className="error">{t("admin.notAllowed")}</p>;

  function submit(e: FormEvent) {
    e.preventDefault();
    create.mutate(name.trim());
  }

  return (
    <section>
      <h1>{t("admin.title")}</h1>
      <form onSubmit={submit} className="stack narrow card">
        <label>
          {t("settings.name")}
          <input required maxLength={60} value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <button type="submit" disabled={create.isPending || !name.trim()}>
          {t("admin.create")}
        </button>
        {create.isError && <p className="error">{t("error.generic")}</p>}
      </form>

      <h2>{t("admin.groups")}</h2>
      {groups?.length === 0 && <p className="muted">{t("admin.noGroups")}</p>}
      <ul className="rows">
        {groups?.map((g) => (
          <AdminGroupRow key={g.id} group={g} />
        ))}
      </ul>

      <Users me={me} />

      <HolidaySync />
    </section>
  );
}

function AdminGroupRow({ group }: { group: GroupSummary }) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const [typed, setTyped] = useState("");
  const remove = useMutation({
    mutationFn: () => api(`/api/groups/${group.id}`, { method: "DELETE" }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: groupsKey }),
  });

  return (
    <li>
      <span className="row-main">
        <Link to={`/g/${group.id}/days`}>{group.name}</Link>
        <span className="muted"> · {t("admin.members", { count: group.member_count })}</span>
      </span>
      <span className="row-actions">
        {confirming ? (
          <span className="confirm">
            <label>
              {t("admin.deleteConfirm", { name: group.name })}
              <input value={typed} onChange={(e) => setTyped(e.target.value)} />
            </label>
            <button
              type="button"
              disabled={typed !== group.name || remove.isPending}
              onClick={() => remove.mutate()}
            >
              {t("admin.deleteFinal")}
            </button>
            <button type="button" className="secondary" onClick={() => setConfirming(false)}>
              {t("common.cancel")}
            </button>
          </span>
        ) : (
          <button type="button" className="secondary" onClick={() => setConfirming(true)}>
            {t("admin.delete")}
          </button>
        )}
      </span>
      {remove.isError && <p className="error">{t("error.generic")}</p>}
    </li>
  );
}

/** Every account with its groups; delete someone else's, confirmed by typing the name. */
function Users({ me }: { me: Me }) {
  const { t } = useI18n();
  const users = useQuery({ queryKey: USERS_KEY, queryFn: () => api<AdminUser[]>("/api/admin/users") });
  return (
    <section>
      <h2>{t("admin.users")}</h2>
      {users.isError && <LoadError onRetry={() => void users.refetch()} />}
      <ul className="rows">
        {users.data?.map((u) => (
          <AdminUserRow key={u.id} user={u} isMe={u.id === me.id} />
        ))}
      </ul>
    </section>
  );
}

function AdminUserRow({ user, isMe }: { user: AdminUser; isMe: boolean }) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const [typed, setTyped] = useState("");
  const remove = useMutation({
    mutationFn: () => api(`/api/admin/users/${user.id}`, { method: "DELETE" }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: USERS_KEY });
      await queryClient.invalidateQueries({ queryKey: groupsKey }); // member counts
    },
  });
  const code = remove.error instanceof ApiError ? remove.error.code : null;
  const cancel = () => {
    setConfirming(false);
    setTyped("");
    remove.reset();
  };

  return (
    <li>
      <span className="row-main">
        <strong>{user.display_name}</strong>
        {isMe && <span className="muted">{t("admin.you")}</span>}
        {user.is_instance_admin && <span className="badge admin">{t("admin.instanceAdmin")}</span>}
        {!user.has_password && <span className="badge">{t("admin.noPassword")}</span>}
        <span className="muted small user-detail">
          {user.email} · {user.groups.length > 0 ? user.groups.join(", ") : t("admin.noGroup")}
        </span>
      </span>
      {!isMe && !user.is_instance_admin && (
        <span className="row-actions">
          {confirming ? (
            <span className="confirm">
              <span className="muted small">{t("admin.deleteUserWhat")}</span>
              <label>
                {t("admin.deleteUserConfirm", { name: user.display_name })}
                <input autoComplete="off" value={typed} onChange={(e) => setTyped(e.target.value)} />
              </label>
              <button
                type="button"
                disabled={typed !== user.display_name || remove.isPending}
                onClick={() => remove.mutate()}
              >
                {t("admin.deleteFinal")}
              </button>
              <button type="button" className="secondary" onClick={cancel}>
                {t("common.cancel")}
              </button>
            </span>
          ) : (
            <button type="button" className="secondary" onClick={() => setConfirming(true)}>
              {t("admin.delete")}
            </button>
          )}
        </span>
      )}
      {remove.isError && (
        <p className="error" role="alert">
          {code === "last_admin" ? t("admin.deleteUserLastAdmin") : t("error.generic")}
        </p>
      )}
    </li>
  );
}

/** The last holiday sync and the last successful one (§3.8: failures keep the old data). */
function HolidaySync() {
  const { t, locale } = useI18n();
  const status = useQuery({
    queryKey: ["admin", "status"],
    queryFn: () => api<AdminStatus>("/api/admin/status"),
  });
  const fmt = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" });
  const when = (s: Sync | null) => (s ? fmt.format(new Date(s.finished_at ?? s.started_at)) : t("admin.never"));
  const last = status.data?.last_sync ?? null;
  const result = !last
    ? null
    : !last.finished_at
      ? t("admin.syncRunning")
      : last.ok
        ? t("admin.syncOk")
        : t("admin.syncFailed");

  return (
    <section>
      <h2>{t("admin.holidays")}</h2>
      {status.isError && <LoadError onRetry={() => void status.refetch()} />}
      {status.data && (
        <ul className="rows">
          <li>
            <span className="row-main">
              {t("admin.lastSync", { time: when(last) })}
              {result && <span className={last?.finished_at && !last.ok ? "error" : "muted"}>· {result}</span>}
              {last && !last.ok && last.message && <span className="muted">· {last.message}</span>}
            </span>
          </li>
          <li>
            <span className="row-main">{t("admin.lastSuccess", { time: when(status.data.last_success) })}</span>
          </li>
        </ul>
      )}
    </section>
  );
}
