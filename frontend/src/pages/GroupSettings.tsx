import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";

import { ConfirmButton } from "../components/ConfirmButton";
import { CopyLink } from "../components/CopyLink";
import { useI18n } from "../i18n/I18n";
import { api, ApiError } from "../lib/api";
import type { Me } from "../lib/auth";
import {
  groupKey,
  groupsKey,
  invitesKey,
  REGIONS,
  type Group,
  type Invite,
  type Member,
  type Region,
} from "../lib/groups";
import { useGroupContext } from "./GroupLayout";

/** Group admins only (spec §3.3): name, holiday regions, members, invite links. */
export function GroupSettings() {
  const { t } = useI18n();
  const { me, group } = useGroupContext();
  if (group.role !== "admin") return <p className="error">{t("group.notFound")}</p>;
  return (
    <div className="settings">
      <NameAndRegions group={group} key={`${group.id}:${group.name}`} />
      <Members group={group} me={me} />
      <Invites gid={group.id} />
    </div>
  );
}

function useGroupUpdate(gid: number) {
  const queryClient = useQueryClient();
  return (updated: Group) => {
    queryClient.setQueryData(groupKey(gid), updated);
    void queryClient.invalidateQueries({ queryKey: groupsKey });
  };
}

function NameAndRegions({ group }: { group: Group }) {
  const { t } = useI18n();
  const [name, setName] = useState(group.name);
  const update = useGroupUpdate(group.id);
  const patch = useMutation({
    mutationFn: (body: { name?: string; regions?: Region[] }) =>
      api<Group>(`/api/groups/${group.id}`, { method: "PATCH", body }),
    onSuccess: update,
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    patch.mutate({ name: name.trim() });
  }

  function toggle(region: Region, on: boolean) {
    const regions = on ? [...group.regions, region] : group.regions.filter((r) => r !== region);
    patch.mutate({ regions });
  }

  return (
    <section className="card narrow">
      <form onSubmit={submit} className="stack">
        <label>
          {t("settings.name")}
          <input required maxLength={60} value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <button type="submit" disabled={patch.isPending || !name.trim() || name.trim() === group.name}>
          {t("common.save")}
        </button>
      </form>
      <fieldset className="stack">
        <legend>{t("settings.regions")}</legend>
        {REGIONS.map((r) => (
          <label key={r} className="check">
            <input
              type="checkbox"
              checked={group.regions.includes(r)}
              onChange={(e) => toggle(r, e.target.checked)}
              disabled={patch.isPending}
            />
            {t(r === "DE-BE" ? "region.DE-BE" : "region.DE-BB")}
          </label>
        ))}
      </fieldset>
      {patch.isError && <p className="error">{t("error.generic")}</p>}
    </section>
  );
}

function Members({ group, me }: { group: Group; me: Me }) {
  const { t } = useI18n();
  const meId = me.id;
  const update = useGroupUpdate(group.id);
  const queryClient = useQueryClient();

  const setRole = useMutation({
    mutationFn: ({ member, role }: { member: Member; role: Member["role"] }) =>
      api<Group>(`/api/groups/${group.id}/members/${member.id}`, {
        method: "PATCH",
        body: { role },
      }),
    onSuccess: update,
  });
  const remove = useMutation({
    mutationFn: (member: Member) =>
      api(`/api/groups/${group.id}/members/${member.id}`, { method: "DELETE" }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: groupKey(group.id) }),
  });
  const [link, setLink] = useState<{ member: Member; url: string } | null>(null);
  const signinLink = useMutation({
    mutationFn: (member: Member) =>
      api<{ url: string }>(`/api/groups/${group.id}/members/${member.id}/signin-link`, {
        method: "POST",
      }),
    onSuccess: ({ url }, member) => setLink({ member, url }),
  });
  // Same rules as the server (spec §3.1): never yourself or the instance admin; other admins
  // only for the instance admin.
  const mayLink = (m: Member) =>
    m.id !== meId && !m.is_instance_admin && (me.is_instance_admin || m.role === "member");
  const linkCode = signinLink.error instanceof ApiError ? signinLink.error.code : null;
  const error = setRole.error ?? remove.error;
  const adminCount = group.members.filter((m) => m.role === "admin").length;
  const lastAdmin = error instanceof ApiError && error.code === "last_admin";

  return (
    <section>
      <h2>{t("settings.members")}</h2>
      <ul className="rows">
        {group.members.map((m) => (
          <li key={m.id}>
            <span className="row-main">
              {m.display_name} {m.id === meId && <span className="muted">{t("settings.you")}</span>}
              <span className={`badge ${m.role}`}>{t(m.role === "admin" ? "role.admin" : "role.member")}</span>
            </span>
            <span className="row-actions">
              {mayLink(m) && (
                <button
                  type="button"
                  className="secondary"
                  disabled={signinLink.isPending}
                  onClick={() => {
                    setLink(null);
                    signinLink.mutate(m);
                  }}
                >
                  {t("settings.signinLink")}
                </button>
              )}
              {/* The last admin can't step down (409 last_admin); don't offer it. */}
              {!(m.role === "admin" && adminCount === 1) && (
                <button
                  type="button"
                  className="secondary"
                  disabled={setRole.isPending}
                  onClick={() =>
                    setRole.mutate({ member: m, role: m.role === "admin" ? "member" : "admin" })
                  }
                >
                  {t(m.role === "admin" ? "settings.makeMember" : "settings.makeAdmin")}
                </button>
              )}
              {m.id !== meId && (
                <ConfirmButton
                  label={t("settings.remove")}
                  question={t("settings.removeConfirm", { name: m.display_name })}
                  onConfirm={() => remove.mutate(m)}
                  disabled={remove.isPending}
                />
              )}
            </span>
          </li>
        ))}
      </ul>
      {link && (
        <CopyLink key={link.url} url={link.url} label={t("settings.signinLinkFor", { name: link.member.display_name })}>
          <p>{t("settings.signinLinkFor", { name: link.member.display_name })}</p>
          <p className="muted">{t("settings.signinLinkHint", { name: link.member.display_name })}</p>
        </CopyLink>
      )}
      {signinLink.isError && (
        <p className="error">
          {linkCode === "target_is_admin"
            ? t("settings.signinLinkAdmin")
            : linkCode === "rate_limited"
              ? t("error.tooManyLinks")
              : t("error.generic")}
        </p>
      )}
      {lastAdmin && <p className="error">{t("group.lastAdmin")}</p>}
      {error && !lastAdmin && <p className="error">{t("error.generic")}</p>}
    </section>
  );
}

function Invites({ gid }: { gid: number }) {
  const { t, locale } = useI18n();
  const queryClient = useQueryClient();
  const invites = useQuery({
    queryKey: invitesKey(gid),
    queryFn: () => api<Invite[]>(`/api/groups/${gid}/invites`),
  });
  const refresh = () => queryClient.invalidateQueries({ queryKey: invitesKey(gid) });

  const create = useMutation({
    mutationFn: () =>
      api<{ invite: Invite; url: string }>(`/api/groups/${gid}/invites`, { method: "POST" }),
    onSuccess: refresh,
  });
  const revoke = useMutation({
    mutationFn: (id: number) => api(`/api/groups/${gid}/invites/${id}`, { method: "DELETE" }),
    onSuccess: refresh,
  });

  const date = new Intl.DateTimeFormat(locale, { dateStyle: "medium" });

  return (
    <section>
      <h2>{t("settings.invites")}</h2>
      <p className="muted">{t("settings.invitesHint")}</p>
      <button type="button" onClick={() => create.mutate()} disabled={create.isPending}>
        {t("settings.createInvite")}
      </button>
      {invites.data && invites.data.length === 0 && <p className="muted">{t("settings.noInvites")}</p>}
      <ul className="rows">
        {invites.data?.map((i) => (
          <li key={i.id}>
            <span className="row-main">
              {t("settings.inviteRow", {
                created: date.format(new Date(i.created_at)),
                by: i.created_by_name ?? t("event.formerMember"),
                expires: date.format(new Date(i.expires_at)),
                uses: i.use_count,
              })}
            </span>
            <span className="row-actions">
              <button
                type="button"
                className="secondary"
                onClick={() => revoke.mutate(i.id)}
                disabled={revoke.isPending}
              >
                {t("settings.revoke")}
              </button>
            </span>
            {i.url ? (
              <CopyLink url={i.url} label={t("settings.inviteLink")} />
            ) : (
              <p className="muted small">{t("settings.inviteNoUrl")}</p>
            )}
          </li>
        ))}
      </ul>
      {(create.isError || revoke.isError || invites.isError) && (
        <p className="error">{t("error.generic")}</p>
      )}
    </section>
  );
}
