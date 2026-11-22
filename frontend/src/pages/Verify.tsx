import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useNavigate } from "react-router";

import { useI18n } from "../i18n/I18n";
import { api, ApiError } from "../lib/api";
import { ME_KEY, type Me } from "../lib/auth";

/** The token sits in the URL fragment (never sent to the server) and is only used on click,
 *  so mail scanners that open links don't use it up (spec §3.1). */
export function Verify() {
  const { t } = useI18n();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [token] = useState(() => new URLSearchParams(window.location.hash.slice(1)).get("t"));

  const verify = useMutation({
    mutationFn: (tok: string) =>
      api<Me>("/api/auth/verify", { method: "POST", body: { token: tok } }),
    onSuccess: (me) => {
      queryClient.setQueryData(ME_KEY, me);
      navigate("/", { replace: true });
    },
  });

  if (!token) {
    return (
      <section className="narrow card auth">
        <h1>{t("verify.title")}</h1>
        <p className="error">{t("verify.missing")}</p>
        <Link to="/signin">{t("verify.newLink")}</Link>
      </section>
    );
  }

  const invalid = verify.error instanceof ApiError && verify.error.status === 400;
  return (
    <section className="narrow card auth">
      <h1>{t("verify.title")}</h1>
      {invalid ? (
        <>
          <p className="error">{t("verify.invalid")}</p>
          <Link to="/signin">{t("verify.newLink")}</Link>
        </>
      ) : (
        <>
          <button type="button" onClick={() => verify.mutate(token)} disabled={verify.isPending}>
            {t("verify.button")}
          </button>
          {verify.isError && <p className="error">{t("error.generic")}</p>}
        </>
      )}
    </section>
  );
}
