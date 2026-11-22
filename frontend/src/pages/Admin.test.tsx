import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { I18nProvider } from "../i18n/I18n";
import { Admin } from "./Admin";

const IVO = { id: 1, email: "ivo@test", display_name: "Ivo", locale: "en" as const, is_instance_admin: true, has_password: true };
const user = (id: number, name: string, extra: object = {}) => ({
  id,
  email: `${name.toLowerCase()}@test`,
  display_name: name,
  is_instance_admin: false,
  has_password: true,
  created_at: "2026-11-01T10:00:00+00:00",
  groups: [],
  ...extra,
});
let users: ReturnType<typeof user>[];
let deleteAnswer: { status: number; body?: unknown };

beforeEach(() => {
  localStorage.setItem("locale", "en");
  users = [
    user(2, "Ada", { groups: ["Band", "Chor"] }),
    user(3, "Ben", { has_password: false }),
    user(1, "Ivo", { is_instance_admin: true }),
  ];
  deleteAnswer = { status: 204 };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/admin/users") return Response.json(users);
      if (url.startsWith("/api/admin/users/") && init?.method === "DELETE") {
        if (deleteAnswer.status !== 204) return Response.json(deleteAnswer.body, { status: deleteAnswer.status });
        users = users.filter((u) => `/api/admin/users/${u.id}` !== url);
        return new Response(null, { status: 204 });
      }
      if (url === "/api/groups") return Response.json([]);
      return Response.json({ error: "not_found" }, { status: 404 });
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
});

function renderAdmin() {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <I18nProvider>
        <MemoryRouter>
          <Admin me={IVO} />
        </MemoryRouter>
      </I18nProvider>
    </QueryClientProvider>,
  );
}

const row = (name: string) => screen.getByText(name, { selector: "strong" }).closest("li")!;

test("lists every account with its groups; no delete for yourself", async () => {
  renderAdmin();
  await screen.findByText("Ada", { selector: "strong" });
  expect(within(row("Ada")).getByText("ada@test · Band, Chor")).toBeTruthy();
  expect(within(row("Ben")).getByText("no password")).toBeTruthy();
  expect(within(row("Ben")).getByText("ben@test · in no group")).toBeTruthy();
  expect(within(row("Ivo")).getByText("Instance admin")).toBeTruthy();
  expect(within(row("Ivo")).queryByRole("button", { name: "Delete" })).toBeNull();
});

test("deleting needs the name typed exactly", async () => {
  renderAdmin();
  await screen.findByText("Ben", { selector: "strong" });
  fireEvent.click(within(row("Ben")).getByRole("button", { name: "Delete" }));
  const final = within(row("Ben")).getByRole("button", { name: "Delete for good" }) as HTMLButtonElement;
  const input = within(row("Ben")).getByLabelText(/Type the name “Ben”/);
  fireEvent.change(input, { target: { value: "ben" } });
  expect(final.disabled).toBe(true);
  fireEvent.change(input, { target: { value: "Ben" } });
  fireEvent.click(final);
  await vi.waitFor(() => expect(screen.queryByText("Ben", { selector: "strong" })).toBeNull());
});

test("the last admin of a group can't be deleted", async () => {
  deleteAnswer = { status: 409, body: { error: "last_admin" } };
  renderAdmin();
  await screen.findByText("Ada", { selector: "strong" });
  fireEvent.click(within(row("Ada")).getByRole("button", { name: "Delete" }));
  fireEvent.change(within(row("Ada")).getByLabelText(/Type the name/), { target: { value: "Ada" } });
  fireEvent.click(within(row("Ada")).getByRole("button", { name: "Delete for good" }));
  expect((await screen.findByRole("alert")).textContent).toMatch(/only admin of a group/);
});
