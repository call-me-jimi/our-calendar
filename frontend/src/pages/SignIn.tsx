import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState, type FormEvent } from "react";
import { Link, useLocation, useNavigate } from "react-router";

import { PasswordInput } from "../components/PasswordInput";
import { useI18n } from "../i18n/I18n";
import { api, ApiError } from "../lib/api";
import { ME_KEY, type Me } from "../lib/auth";
import { INFO_KEY, useInfo } from "../lib/info";

export function SignIn() {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  // Set by the account page after deleting the account: drop everything cached for it.
  const deleted = (useLocation().state as { deleted?: boolean } | null)?.deleted === true;
  useEffect(() => {
    if (!deleted) return;
    // Update "me" in place (so the header notices), then drop every other user's query.
    queryClient.setQueryData(ME_KEY, null);
    queryClient.removeQueries({
      predicate: (q) => q.queryKey[0] !== ME_KEY[0] && q.queryKey[0] !== INFO_KEY[0],
    });
  }, [deleted, queryClient]);
  const info = useInfo();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  // With mail, a sign-in link by email is the other way in (e.g. a forgotten password).
  const [byLink, setByLink] = useState(false);
  const login = useMutation({
    mutationFn: () => api<Me>("/api/auth/login", { method: "POST", body: { email, password } }),
    onSuccess: (me) => {
      queryClient.setQueryData(ME_KEY, me);
      navigate("/", { replace: true });
    },
  });
  const loginCode = login.error instanceof ApiError ? login.error.code : null;
  const send = useMutation({
    mutationFn: (address: string) =>
      api("/api/auth/request", { method: "POST", body: { email: address } }),
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    send.mutate(email);
  }

  function submitLogin(e: FormEvent) {
    e.preventDefault();
    login.mutate();
  }

  // Without mail, links come from an admin (spec §3.1).
  const linkMode = info.data?.mail_enabled === false;

  const emailInput = (
    <label>
      {t("signin.email")}
      <input
        type="email"
        autoComplete="email"
        required
        maxLength={254}
        value={email}
        onChange={(e) => setEmail(e.target.value)}
      />
    </label>
  );

  return (
    <section className="narrow card auth">
      <h1>{t("signin.title")}</h1>
      {deleted && !send.isSuccess && <p role="status">{t("signin.deleted")}</p>}
      {info.isPending ? null : !byLink ? (
        <>
          <form onSubmit={submitLogin} className="stack">
            {emailInput}
            <PasswordInput
              label={t("signin.password")}
              autoComplete="current-password"
              required
              maxLength={200}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
            <button type="submit" disabled={login.isPending}>
              {t("signin.login")}
            </button>
            {login.isError && (
              <p className="error" role="alert">
                {loginCode === "invalid_credentials"
                  ? t("signin.wrong")
                  : loginCode === "rate_limited"
                    ? t("error.tooManyAttempts")
                    : t("error.generic")}
              </p>
            )}
          </form>
          {linkMode ? (
            <>
              <p>
                {t("signin.forgot")} {t("signin.linkMode.admin")}
              </p>
              <p className="muted">{t("signin.forgotThen")}</p>
            </>
          ) : (
            <button type="button" className="link" onClick={() => setByLink(true)}>
              {t("signin.useLink")}
            </button>
          )}
        </>
      ) : send.isSuccess ? (
        <>
          <p role="status">{t("signin.sent", { email: email.trim() })}</p>
          <button type="button" className="link" onClick={() => send.reset()}>
            {t("signin.again")}
          </button>
        </>
      ) : (
        <>
          <form onSubmit={submit} className="stack">
            {emailInput}
            <button type="submit" disabled={send.isPending}>
              {t("signin.submit")}
            </button>
            {send.isError && <p className="error">{t("error.generic")}</p>}
          </form>
          <button type="button" className="link" onClick={() => setByLink(false)}>
            {t("signin.usePassword")}
          </button>
        </>
      )}
      <p className="muted">{t("signin.newHere")}</p>
      <p className="muted small">
        <Link to="/privacy">{t("signin.privacy")}</Link>
      </p>
    </section>
  );
}
