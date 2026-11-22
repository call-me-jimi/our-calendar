import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { App } from "./App";
import { I18nProvider } from "./i18n/I18n";

beforeEach(() => {
  // Nobody signed in.
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify({ error: "unauthenticated" }), { status: 401 })),
  );
  localStorage.setItem("locale", "en");
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
});

function renderAt(path: string) {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <I18nProvider>
        <MemoryRouter initialEntries={[path]}>
          <App />
        </MemoryRouter>
      </I18nProvider>
    </QueryClientProvider>,
  );
}

test("a private page sends a signed-out visitor to sign-in", async () => {
  renderAt("/g/1/calendar");
  expect(await screen.findByRole("heading", { name: "Sign in" })).toBeTruthy();
  expect(screen.getByText("Our Calendar")).toBeTruthy();
});

test("German users see the German name in the header and the title", async () => {
  localStorage.setItem("locale", "de");
  renderAt("/signin");
  expect(await screen.findByText("Unser Kalender")).toBeTruthy();
  expect(document.title).toBe("Unser Kalender");
});

test("verify without a token says the link is incomplete", async () => {
  renderAt("/auth/verify");
  expect(await screen.findByText(/This link is incomplete/)).toBeTruthy();
});

test("the privacy note is public and names who runs the instance", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) =>
      url === "/api/info"
        ? Response.json({ mail_enabled: false, operator_name: "Kim" })
        : Response.json({ error: "unauthenticated" }, { status: 401 }),
    ),
  );
  renderAt("/privacy");
  expect(await screen.findByRole("heading", { name: "Privacy", level: 1 })).toBeTruthy();
  expect(await screen.findByText(/Kim runs this instance/)).toBeTruthy();
  expect(screen.getByRole("contentinfo").textContent).toContain("Privacy");
});

test("without an operator name the privacy note names no one", async () => {
  renderAt("/privacy");
  expect(await screen.findByText(/contact the person who runs this instance/)).toBeTruthy();
});

function withMail(enabled: boolean) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) =>
      url === "/api/info"
        ? new Response(JSON.stringify({ mail_enabled: enabled }), { status: 200 })
        : new Response(JSON.stringify({ error: "unauthenticated" }), { status: 401 }),
    ),
  );
}

test("with mail, sign-in asks for email and password, or sends a link instead", async () => {
  withMail(true);
  renderAt("/signin");
  expect(await screen.findByLabelText("Password")).toBeTruthy();
  expect(screen.getByLabelText("Email address")).toBeTruthy();
  expect(screen.queryByText(/Forgot your password/)).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Email me a sign-in link instead" }));
  expect(screen.getByRole("button", { name: "Send link" })).toBeTruthy();
  expect(screen.queryByLabelText("Password")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Sign in with password" }));
  expect(screen.getByLabelText("Password")).toBeTruthy();
});

test("without mail, sign-in asks for email and password and says where links come from", async () => {
  withMail(false);
  renderAt("/signin");
  expect(await screen.findByLabelText("Password")).toBeTruthy();
  expect(screen.getByText(/Forgot your password, or don't have one yet\? Ask your group's admin for a sign-in link/)).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Email me a sign-in link instead" })).toBeNull();
  expect(screen.getByRole("link", { name: "What happens to your data" })).toBeTruthy();
});

test("the password can be shown to check it, and hidden again", async () => {
  withMail(false);
  renderAt("/signin");
  const field = (await screen.findByLabelText("Password")) as HTMLInputElement;
  expect(field.type).toBe("password");
  fireEvent.click(screen.getByRole("button", { name: "Show" }));
  expect(field.type).toBe("text");
  fireEvent.click(screen.getByRole("button", { name: "Hide" }));
  expect(field.type).toBe("password");
});

test("a wrong password says so", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) =>
      url === "/api/info"
        ? Response.json({ mail_enabled: false })
        : url === "/api/auth/login"
          ? Response.json({ error: "invalid_credentials" }, { status: 401 })
          : Response.json({ error: "unauthenticated" }, { status: 401 }),
    ),
  );
  renderAt("/signin");
  fireEvent.change(await screen.findByLabelText("Email address"), { target: { value: "ben@test.de" } });
  fireEvent.change(screen.getByLabelText("Password"), { target: { value: "falsch123" } });
  fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
  expect((await screen.findByRole("alert")).textContent).toBe("Email or password is wrong.");
});

test("a signed-in user without a password is reminded to set one, except on the account page", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) =>
      url === "/api/me"
        ? Response.json({ id: 1, email: "ivo@test", display_name: "Ivo", locale: "en", is_instance_admin: false, has_password: false })
        : Response.json([], { status: 200 }),
    ),
  );
  renderAt("/privacy");
  expect(await screen.findByText(/You don't have a password yet/)).toBeTruthy();
  expect(screen.getByRole("link", { name: "Set one now" }).getAttribute("href")).toBe("/me#password");
});

test("the avatar menu shows who is signed in, links the account page and signs out", async () => {
  let signedIn = true;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/auth/logout" && init?.method === "POST") {
        signedIn = false;
        return new Response(null, { status: 204 });
      }
      if (url === "/api/me") {
        return signedIn
          ? Response.json({ id: 1, email: "ivo@test", display_name: "Ivo", locale: "en", is_instance_admin: false, has_password: true })
          : Response.json({ error: "unauthenticated" }, { status: 401 });
      }
      return Response.json({ mail_enabled: false });
    }),
  );
  render(
    <QueryClientProvider client={new QueryClient()}>
      <I18nProvider>
        <MemoryRouter initialEntries={["/privacy"]}>
          <App />
          <Where />
        </MemoryRouter>
      </I18nProvider>
    </QueryClientProvider>,
  );
  const menu = (await screen.findByLabelText("Account")).closest("details")!;
  fireEvent.click(screen.getByLabelText("Account"));
  expect(menu.open).toBe(true);
  // A click anywhere else closes it; a click inside doesn't.
  fireEvent.pointerDown(screen.getByText("ivo@test"));
  expect(menu.open).toBe(true);
  fireEvent.pointerDown(document.body);
  expect(menu.open).toBe(false);
  fireEvent.click(screen.getByLabelText("Account"));
  expect(screen.getByText("ivo@test")).toBeTruthy();
  expect(screen.getByRole("link", { name: "Account" }).getAttribute("href")).toBe("/me");
  fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
  await waitFor(() => expect(screen.getByTestId("where").textContent).toBe("/signin"));
});

function Where() {
  const { pathname, search } = useLocation();
  return <output data-testid="where">{pathname + search}</output>;
}

test.each([
  ["/g/1", "/g/1/days"],
  ["/g/1/calendar", "/g/1/days"],
  ["/g/1/calendar?day=2026-12-01", "/g/1/days"],
  ["/g/1/overview", "/g/1/group?layout=table"],
])("%s redirects to %s", async (from, to) => {
  vi.stubGlobal("matchMedia", () => ({ matches: true, addEventListener: () => {}, removeEventListener: () => {} }));
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url === "/api/me") {
        return Response.json({ id: 1, email: "ivo@test", display_name: "Ivo", locale: "en", is_instance_admin: false, has_password: true });
      }
      if (url === "/api/groups/1") {
        return Response.json({ id: 1, name: "G", regions: [], role: "member", is_member: true, members: [] });
      }
      return Response.json({ error: "not_found" }, { status: 404 });
    }),
  );
  render(
    <QueryClientProvider client={new QueryClient()}>
      <I18nProvider>
        <MemoryRouter initialEntries={[from]}>
          <App />
          <Where />
        </MemoryRouter>
      </I18nProvider>
    </QueryClientProvider>,
  );
  await waitFor(() => expect(screen.getByTestId("where").textContent).toBe(to));
});
