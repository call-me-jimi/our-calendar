import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useParams } from "react-router";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { I18nProvider } from "../i18n/I18n";
import { Join } from "./Join";

// Joining (spec §3.2): the request answers 201 and signs in; 401 for a known address with another
// password, 409 for a known address without one.
let joinAnswer: { status: number; body: unknown };
let signedIn = false;

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}

beforeEach(() => {
  signedIn = false;
  localStorage.setItem("locale", "en");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (path: string) => {
      if (path === "/api/me") {
        return signedIn
          ? json({ id: 2, email: "ben@test", display_name: "Ben", locale: "en", is_instance_admin: false, has_password: true })
          : json({ error: "unauthenticated" }, 401);
      }
      if (path === "/api/join/tok") return json({ group_name: "Band" });
      if (path === "/api/join/tok/request") {
        if (joinAnswer.status === 201) signedIn = true;
        return json(joinAnswer.body, joinAnswer.status);
      }
      return json({ error: "not_found" }, 404);
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
});

function Calendar() {
  return <p>calendar of {useParams().gid}</p>;
}

function fillAndJoin() {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <I18nProvider>
        <MemoryRouter initialEntries={["/join/tok"]}>
          <Routes>
            <Route path="/join/:token" element={<Join />} />
            <Route path="/g/:gid/days" element={<Calendar />} />
          </Routes>
        </MemoryRouter>
      </I18nProvider>
    </QueryClientProvider>,
  );
  return screen.findByLabelText("Your name").then((name) => {
    fireEvent.change(name, { target: { value: "Ben" } });
    fireEvent.change(screen.getByLabelText("Email address"), { target: { value: "ben@test.de" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "geheim123" } });
    fireEvent.click(screen.getByRole("button", { name: "Join" }));
  });
}

test("a new person goes straight to the group's calendar", async () => {
  joinAnswer = { status: 201, body: { joined: true, group_id: 7 } };
  await fillAndJoin();
  expect(await screen.findByText("calendar of 7")).toBeTruthy();
  const call = vi.mocked(fetch).mock.calls.find(([p]) => p === "/api/join/tok/request");
  expect(JSON.parse(String(call?.[1]?.body))).toEqual({
    email: "ben@test.de",
    display_name: "Ben",
    password: "geheim123",
    locale: "en",
  });
});

test("a known address with another password is told so", async () => {
  joinAnswer = { status: 401, body: { error: "invalid_credentials" } };
  await fillAndJoin();
  expect((await screen.findByRole("alert")).textContent).toMatch(/that's not its password/);
  expect(screen.queryByText(/calendar of/)).toBeNull();
});

test("a known address without a password is told to sign in first", async () => {
  joinAnswer = { status: 409, body: { error: "account_exists" } };
  await fillAndJoin();
  expect((await screen.findByRole("alert")).textContent).toMatch(/no password yet. Sign in first/);
  expect(screen.queryByText(/calendar of/)).toBeNull();
});
