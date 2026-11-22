import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { I18nProvider } from "../i18n/I18n";
import { Account } from "./Account";

const ME = { id: 2, email: "ben@test", display_name: "Ben", locale: "en" as const, is_instance_admin: false, has_password: false };

beforeEach(() => {
  localStorage.setItem("locale", "en");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (path: string, init?: RequestInit) =>
      path === "/api/me/password" && init?.method === "PUT"
        ? new Response(null, { status: 204 })
        : new Response(JSON.stringify({ error: "not_found" }), { status: 404 }),
    ),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
});

function renderAccount() {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <I18nProvider>
        <MemoryRouter>
          <Account me={ME} />
        </MemoryRouter>
      </I18nProvider>
    </QueryClientProvider>,
  );
}

test("Save and Set password are active only once something changed", () => {
  renderAccount();
  const save = screen.getByRole("button", { name: "Save" }) as HTMLButtonElement;
  const setPw = screen.getByRole("button", { name: "Set password" }) as HTMLButtonElement;
  expect(save.disabled).toBe(true);
  expect(setPw.disabled).toBe(true);
  fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Benjamin" } });
  expect(save.disabled).toBe(false);
  fireEvent.change(screen.getByLabelText("Name"), { target: { value: " Ben " } });
  expect(save.disabled).toBe(true);
  fireEvent.change(screen.getByLabelText("New password"), { target: { value: "x" } });
  expect(setPw.disabled).toBe(false);
});

test("no sign-out (it's in the header menu) and no link for another device", () => {
  renderAccount();
  expect(screen.queryByRole("button", { name: /Sign out/ })).toBeNull();
  expect(screen.queryByText(/another device/)).toBeNull();
});

test("setting a password", async () => {
  renderAccount();
  expect(screen.getByText(/You don't have a password yet/)).toBeTruthy();
  fireEvent.change(screen.getByLabelText("New password"), { target: { value: "neues-passwort" } });
  fireEvent.click(screen.getByRole("button", { name: "Set password" }));
  expect((await screen.findByRole("status")).textContent).toBe("Password saved.");
  expect((screen.getByLabelText("New password") as HTMLInputElement).value).toBe("");
  const call = vi.mocked(fetch).mock.calls.find(([p]) => p === "/api/me/password");
  expect(JSON.parse(String(call?.[1]?.body))).toEqual({ password: "neues-passwort" });
});
