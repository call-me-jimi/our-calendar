import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { useNavigate, useParams } from "react-router";

import { PasswordInput } from "../components/PasswordInput";
import { useI18n } from "../i18n/I18n";
import { api, ApiError } from "../lib/api";
import { ME_KEY, useMe } from "../lib/auth";
import { groupsKey } from "../lib/groups";

/** /join/:token — signed in: one button; otherwise name, email and password, then straight in
 *  (spec §3.2). An existing account joins with its own password. */
export function Join() {
  const { t, locale } = useI18n();
  const token = useParams().token ?? "";
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { data: me, isPending: mePending } = useMe();
  const info = useQuery({
    queryKey: ["join", token],
    queryFn: () => api<{ group_name: string }>(`/api/join/${encodeURIComponent(token)}`),
  });
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  const joinNow = useMutation({
    mutationFn: () =>
      api<{ group_id: number }>(`/api/join/${encodeURIComponent(token)}`, { method: "POST" }),
    onSuccess: async ({ group_id }) => {
      await queryClient.invalidateQueries({ queryKey: groupsKey });
      navigate(`/g/${group_id}/days`, { replace: true });
    },
  });
  const request = useMutation({
    mutationFn: () =>
      api<{ joined: true; group_id: number }>(`/api/join/${encodeURIComponent(token)}/request`, {
        method: "POST",
        body: { email, display_name: name.trim(), password, locale },
      }),
    onSuccess: async ({ group_id }) => {
      // Signed in now: fetch who that is before the private page checks.
      await queryClient.invalidateQueries({ queryKey: ME_KEY });
      await queryClient.invalidateQueries({ queryKey: groupsKey });
      navigate(`/g/${group_id}/days`, { replace: true });
    },
  });
  const code = request.error instanceof ApiError ? request.error.code : null;

  if (info.isPending || mePending) return null;
  if (request.isSuccess) return null; // on the way to the group
  if (info.isError) {
    return (
      <section className="narrow card auth">
        <h1>{t("join.title")}</h1>
        <p className="error">{t("join.invalid")}</p>
      </section>
    );
  }

  const group = info.data.group_name;

  function submit(e: FormEvent) {
    e.preventDefault();
    request.mutate();
  }

  return (
    <section className="narrow card auth">
      <h1>{t("join.heading", { group })}</h1>
      {me ? (
        <div className="stack">
          <p>{t("join.asUser", { name: me.display_name })}</p>
          <button type="button" onClick={() => joinNow.mutate()} disabled={joinNow.isPending}>
            {t("join.submit")}
          </button>
          {joinNow.isError && <p className="error">{t("join.invalid")}</p>}
        </div>
      ) : (
        <form onSubmit={submit} className="stack">
          <label>
            {t("join.name")}
            <input
              required
              maxLength={40}
              autoComplete="name"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <label>
            {t("join.email")}
            <input
              type="email"
              required
              maxLength={254}
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </label>
          <PasswordInput
            label={t("join.password")}
            required
            minLength={8}
            maxLength={200}
            autoComplete="new-password"
            aria-describedby="join-password-hint"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <p id="join-password-hint" className="muted small">
            {t("join.passwordHint")}
          </p>
          <button type="submit" disabled={request.isPending || !name.trim()}>
            {t("join.submit")}
          </button>
          {request.isError && (
            <p className="error" role="alert">
              {code === "account_exists"
                ? t("join.accountExists")
                : code === "invalid_credentials"
                  ? t("join.wrongPassword")
                  : code === "common_password"
                    ? t("password.common")
                    : code === "rate_limited"
                      ? t("error.tooManyAttempts")
                      : t("error.generic")}
            </p>
          )}
        </form>
      )}
    </section>
  );
}
