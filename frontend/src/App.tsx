import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRef, type ReactElement } from "react";
import { Link, Navigate, Route, Routes, useLocation, useNavigate } from "react-router";

import { useI18n } from "./i18n/I18n";
import { api } from "./lib/api";
import { ME_KEY, useMe, type Me } from "./lib/auth";
import { useCloseOnOutsideClick } from "./lib/useCloseOnOutsideClick";
import { Account } from "./pages/Account";
import { Admin } from "./pages/Admin";
import { Group } from "./pages/Group";
import { GroupLayout } from "./pages/GroupLayout";
import { GroupSettings } from "./pages/GroupSettings";
import { Home } from "./pages/Home";
import { Join } from "./pages/Join";
import { MyDays } from "./pages/MyDays";
import { Placeholder } from "./pages/Placeholder";
import { Privacy } from "./pages/Privacy";
import { SignIn } from "./pages/SignIn";
import { Verify } from "./pages/Verify";

// Routes from spec §3; placeholders are filled in by the phase named.
export function App() {
  return (
    <div className="app">
      <Header />
      <main>
        <PasswordNudge />
        <Routes>
          <Route path="/signin" element={<SignIn />} />
          <Route path="/auth/verify" element={<Verify />} />
          <Route path="/join/:token" element={<Join />} />
          <Route path="/privacy" element={<Privacy />} />
          <Route path="/" element={<Private render={(me) => <Home me={me} />} />} />
          <Route path="/me" element={<Private render={(me) => <Account me={me} />} />} />
          <Route path="/g/:gid" element={<Private render={(me) => <GroupLayout me={me} />} />}>
            <Route index element={<Navigate to="days" replace />} />
            <Route path="days" element={<MyDays />} />
            <Route path="group" element={<Group />} />
            {/* Old URLs, kept for links and installed apps. */}
            <Route path="calendar" element={<Navigate to="../days" replace />} />
            <Route path="overview" element={<Navigate to="../group?layout=table" replace />} />
            <Route path="settings" element={<GroupSettings />} />
          </Route>
          <Route path="/admin" element={<Private render={(me) => <Admin me={me} />} />} />
          <Route path="*" element={<Placeholder name="404" />} />
        </Routes>
      </main>
      <Footer />
    </div>
  );
}

/** The avatar opens a menu: who is signed in, the account page, and sign out. */
function UserMenu({ me }: { me: Me }) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const ref = useRef<HTMLDetailsElement>(null);
  useCloseOnOutsideClick(ref);
  const close = () => {
    if (ref.current) ref.current.open = false;
  };
  const signOut = useMutation({
    mutationFn: () => api("/api/auth/logout", { method: "POST" }),
    onSuccess: () => {
      close();
      queryClient.clear();
      queryClient.setQueryData(ME_KEY, null);
      navigate("/signin", { replace: true });
    },
  });
  return (
    <details className="menu user-menu" ref={ref}>
      <summary className="avatar" aria-label={t("nav.account")} title={t("nav.account")}>
        {me.display_name.charAt(0).toUpperCase()}
      </summary>
      <div className="menu-body stack">
        <p className="user-menu-who">
          <strong>{me.display_name}</strong>
          <span className="muted small">{me.email}</span>
        </p>
        <Link to="/me" className="btn ghost" onClick={close}>
          {t("nav.account")}
        </Link>
        <button type="button" onClick={() => signOut.mutate()} disabled={signOut.isPending}>
          {t("me.signOut")}
        </button>
        {signOut.isError && <p className="error">{t("error.generic")}</p>}
      </div>
    </details>
  );
}

/** Until a signed-in user has a password, a reminder on every page but the account page. */
function PasswordNudge() {
  const { t } = useI18n();
  const { data: me } = useMe();
  const { pathname } = useLocation();
  if (!me || me.has_password || pathname === "/me") return null;
  return (
    <p className="notice">
      {t("nudge.password")} <Link to="/me#password">{t("nudge.passwordLink")}</Link>
    </p>
  );
}

function Footer() {
  const { t } = useI18n();
  return (
    <footer className="app-footer">
      <Link to="/privacy">{t("nav.privacy")}</Link>
    </footer>
  );
}

/** Signed-in pages: render with the user, or send to /signin. */
function Private({ render }: { render: (me: Me) => ReactElement }) {
  const { data: me, isPending, isError } = useMe();
  const { t } = useI18n();
  if (isPending) return null;
  if (isError) return <p className="error">{t("error.generic")}</p>;
  if (!me) return <Navigate to="/signin" replace />;
  return render(me);
}

// The logo mark: a 3 × 3 grid of days, some taken.
const LOGO = [false, true, false, true, true, true, false, true, false];

function Header() {
  const { t, locale, setLocale } = useI18n();
  const { data: me } = useMe();
  return (
    <header className="app-header">
      <div className="wrap">
        <Link to="/" className="brand">
          <span className="logo" aria-hidden="true">
            {LOGO.map((on, i) => (
              <i key={i} className={on ? "on" : undefined} />
            ))}
          </span>
          {t("app.name")}
        </Link>
        <div className="header-right">
          <nav className="lang" aria-label={t("lang.switch")}>
            {(["de", "en"] as const).map((l) => (
              <button key={l} type="button" aria-pressed={locale === l} onClick={() => setLocale(l)}>
                {l.toUpperCase()}
              </button>
            ))}
          </nav>
          {me?.is_instance_admin && (
            <Link to="/admin" className="quiet">
              {t("nav.admin")}
            </Link>
          )}
          {me ? (
            <UserMenu me={me} />
          ) : (
            <Link to="/signin" className="quiet">
              {t("nav.signIn")}
            </Link>
          )}
        </div>
      </div>
    </header>
  );
}
