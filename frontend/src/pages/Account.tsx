import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router";

import { PasswordInput } from "../components/PasswordInput";
import { useI18n } from "../i18n/I18n";
import type { Locale } from "../i18n/translate";
import { api, ApiError } from "../lib/api";
import { ME_KEY, type Me } from "../lib/auth";

export function Account({ me }: { me: Me }) {
  const { t, setLocale } = useI18n();
  const queryClient = useQueryClient();
  const [name, setName] = useState(me.display_name);

  const save = useMutation({
    mutationFn: (display_name: string) =>
      api<Me>("/api/me", { method: "PATCH", body: { display_name } }),
    onSuccess: (updated) => queryClient.setQueryData(ME_KEY, updated),
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    save.mutate(name.trim());
  }

  return (
    <section className="narrow">
      <h1>{t("me.title")}</h1>
      <form onSubmit={submit} className="stack card">
        <label>
          {t("me.name")}
          <input
            required
            maxLength={40}
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              save.reset();
            }}
          />
        </label>
        <label>
          {t("me.email")}
          <input value={me.email} readOnly disabled />
        </label>
        <label>
          {t("me.language")}
          <select value={me.locale} onChange={(e) => setLocale(e.target.value as Locale)}>
            <option value="de">Deutsch</option>
            <option value="en">English</option>
          </select>
        </label>
        <button type="submit" disabled={save.isPending || !name.trim() || name.trim() === me.display_name}>
          {t("me.save")}
        </button>
        {save.isSuccess && <p role="status">{t("me.saved")}</p>}
        {save.isError && (
        <p className="error">
          {save.error instanceof ApiError && save.error.code === "common_password"
            ? t("password.common")
            : t("error.generic")}
        </p>
      )}
      </form>

      <Password me={me} />

      <DeleteAccount me={me} />
    </section>
  );
}

/** Set or change the password (spec §3.1). The session is enough: without mail, a sign-in link
 *  from an admin followed by this is how a forgotten password is reset. */
function Password({ me }: { me: Me }) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const [password, setPassword] = useState("");
  const save = useMutation({
    mutationFn: () => api("/api/me/password", { method: "PUT", body: { password } }),
    onSuccess: () => {
      setPassword("");
      queryClient.setQueryData(ME_KEY, { ...me, has_password: true });
    },
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    save.mutate();
  }

  return (
    <form id="password" onSubmit={submit} className="stack card">
      <h2>{t("me.password.title")}</h2>
      <p className="muted">{me.has_password ? t("me.password.has") : t("me.password.none")}</p>
      {/* Lets password managers file the new password under the right account. */}
      <input type="email" autoComplete="username" value={me.email} readOnly hidden />
      <PasswordInput
        label={t("me.password.new")}
        required
        minLength={8}
        maxLength={200}
        autoComplete="new-password"
        aria-describedby="password-hint"
        value={password}
        onChange={(e) => {
          setPassword(e.target.value);
          save.reset();
        }}
      />
      <p id="password-hint" className="muted small">
        {t("me.password.hint")}
      </p>
      <button type="submit" disabled={save.isPending || !password}>
        {me.has_password ? t("me.password.change") : t("me.password.set")}
      </button>
      {save.isSuccess && <p role="status">{t("me.password.saved")}</p>}
      {save.isError && (
        <p className="error">
          {save.error instanceof ApiError && save.error.code === "common_password"
            ? t("password.common")
            : t("error.generic")}
        </p>
      )}
    </form>
  );
}

/** Delete the account (spec §3.11), confirmed by typing the display name. */
function DeleteAccount({ me }: { me: Me }) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const [confirming, setConfirming] = useState(false);
  const [typed, setTyped] = useState("");

  const remove = useMutation({
    mutationFn: () => api("/api/me", { method: "DELETE" }),
    // /signin clears the query cache once it shows: clearing it here would let this private page
    // redirect to /signin first (navigation is a transition) and drop the "deleted" notice.
    onSuccess: () => navigate("/signin", { replace: true, state: { deleted: true } }),
  });
  const code = remove.error instanceof ApiError ? remove.error.code : null;

  function submit(e: FormEvent) {
    e.preventDefault();
    remove.mutate();
  }

  return (
    <div className="stack card">
      <h2>{t("me.delete.title")}</h2>
      <p>{t("me.delete.what")}</p>
      <p className="muted">
        {t("me.delete.backups")} <Link to="/privacy">{t("nav.privacy")}</Link>
      </p>
      {confirming ? (
        <form onSubmit={submit} className="stack">
          <label>
            {t("me.delete.typeName", { name: me.display_name })}
            <input autoComplete="off" value={typed} onChange={(e) => setTyped(e.target.value)} />
          </label>
          <button type="submit" disabled={typed !== me.display_name || remove.isPending}>
            {t("me.delete.final")}
          </button>
          <button
            type="button"
            className="secondary"
            onClick={() => {
              setConfirming(false);
              setTyped("");
              remove.reset();
            }}
          >
            {t("common.cancel")}
          </button>
        </form>
      ) : (
        <button type="button" className="secondary" onClick={() => setConfirming(true)}>
          {t("me.delete.start")}
        </button>
      )}
      {remove.isError && (
        <p className="error" role="alert">
          {code === "last_admin"
            ? t("me.delete.lastAdmin")
            : code === "last_instance_admin"
              ? t("me.delete.lastInstanceAdmin")
              : t("error.generic")}
        </p>
      )}
    </div>
  );
}
