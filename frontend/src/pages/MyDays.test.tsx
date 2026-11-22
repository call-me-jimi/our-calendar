import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { App } from "../App";
import { I18nProvider } from "../i18n/I18n";
import { todayBerlin, type DayChange } from "../lib/days";
import type { GroupMark } from "../lib/groupResult";

// Meine Tage against a fake API: Ivo alone in group 1.
let marks: GroupMark[] = [];
let failSaves = false;

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}

beforeEach(() => {
  marks = [];
  failSaves = false;
  localStorage.setItem("locale", "en");
  localStorage.setItem("introSeen", "1");
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: true, // desktop: three months
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
  vi.stubGlobal(
    "fetch",
    vi.fn(async (path: string, init?: RequestInit) => {
      const url = new URL(path, "http://test");
      if (url.pathname === "/api/me") {
        return json({ id: 1, email: "ivo@test", display_name: "Ivo", locale: "en", is_instance_admin: false });
      }
      if (url.pathname === "/api/groups") return json([{ id: 1, name: "G", role: "admin", is_member: true, member_count: 1 }]);
      if (url.pathname === "/api/groups/1") {
        const ivo = { id: 1, display_name: "Ivo", role: "admin", availability_updated_at: null, is_instance_admin: false };
        return json({ id: 1, name: "G", regions: [], role: "admin", is_member: true, members: [ivo] });
      }
      if (url.pathname === "/api/groups/1/marks") return json({ marks });
      if (url.pathname === "/api/groups/1/events") return json({ events: [] });
      if (url.pathname === "/api/marks" && init?.method === "PUT") {
        if (failSaves) return json({ error: "internal" }, 500);
        const { days } = JSON.parse(String(init.body)) as { days: DayChange[] };
        const touched = new Set(days.map((d) => d.day));
        marks = marks.filter((m) => !touched.has(m.day));
        for (const d of days) {
          if (d.state !== "free") marks.push({ user_id: 1, ...d, state: d.state, set_by_name: null, set_by_former: false });
        }
        return json({ previous: [] });
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

function nextMonthDay(d: number): string {
  const [y, m] = todayBerlin().split("-").map(Number) as [number, number];
  const next = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
  return `${next}-${String(d).padStart(2, "0")}`;
}

const cell = (d: number) => document.querySelector<HTMLElement>(`.cell[data-day="${nextMonthDay(d)}"]`)!;
const count = (cls: string) => document.querySelectorAll(`.cell.${cls}`).length;
const key = (k: string, init: Record<string, unknown> = {}) =>
  fireEvent.keyDown(document.activeElement!, { key: k, ...init });

function Where() {
  const { search } = useLocation();
  return <output data-testid="search">{search}</output>;
}

function renderAt(path = "/g/1/days") {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <I18nProvider>
        <MemoryRouter initialEntries={[path]}>
          <App />
          <Where />
        </MemoryRouter>
      </I18nProvider>
    </QueryClientProvider>,
  );
}

test("keyboard: space selects, B applies, shift+arrows add a range, V, escape, ctrl+z", async () => {
  renderAt();
  await waitFor(() => expect(cell(10)).toBeTruthy());
  // One tab stop in the whole calendar.
  expect(document.querySelectorAll('.cell[tabindex="0"]')).toHaveLength(1);

  act(() => cell(10).focus());
  key(" ");
  expect(cell(10).getAttribute("aria-pressed")).toBe("true");
  const sheet = screen.getByRole("dialog");
  expect(within(sheet).getByText("Can't you make this day?")).toBeTruthy();
  expect(document.activeElement).toBe(cell(10)); // keys keep the focus in the grid
  key("b");
  await waitFor(() => expect(cell(10).className).toMatch(/own-busy/));
  expect(cell(10).getAttribute("aria-label")).toMatch(/you: busy$/);
  expect(await screen.findByText("1 day marked as busy")).toBeTruthy();
  expect(screen.queryByRole("dialog")).toBeNull();

  // Shift+arrows show the range as selected; letting go of Shift keeps it; V marks it maybe.
  key("ArrowRight");
  await waitFor(() => expect(document.activeElement).toBe(cell(11)));
  key("ArrowRight", { shiftKey: true });
  key("ArrowRight", { shiftKey: true });
  await waitFor(() => expect(document.activeElement).toBe(cell(13)));
  expect(count("selected")).toBe(3);
  expect(screen.getByText("3 days selected. Tap more days or say below what applies.")).toBeTruthy();
  fireEvent.keyUp(document.activeElement!, { key: "Shift" });
  expect(count("selected")).toBe(3);
  key("v");
  await waitFor(() => expect(count("own-maybe")).toBe(3));
  expect(count("selected")).toBe(0);

  // Escape clears a selection without marking anything.
  key("ArrowRight");
  key(" ");
  expect(count("selected")).toBe(1);
  key("Escape");
  expect(count("selected")).toBe(0);
  expect(screen.queryByRole("dialog")).toBeNull();

  // Ctrl+Z undoes the last action (the range).
  key("z", { ctrlKey: true });
  await waitFor(() => expect(count("own-maybe")).toBe(0));
  expect(count("own-busy")).toBe(1);
});

test("click: the sheet offers what changes something; a note; enter saves just the note", async () => {
  renderAt();
  await waitFor(() => expect(cell(10)).toBeTruthy());

  fireEvent.click(cell(10));
  let sheet = screen.getByRole("dialog");
  expect(document.activeElement).toBe(sheet); // a click hands the sheet the focus
  fireEvent.click(cell(12));
  expect(within(sheet).getByRole("heading").textContent).toBe("2 days selected");
  expect(within(sheet).getByText("Can't you make these days?")).toBeTruthy();
  expect(within(sheet).getAllByRole("button", { name: /^(Busy|Maybe|Free again)/ }).map((b) => b.textContent)).toEqual([
    "BusyI can't",
    "MaybeNot sure yet",
  ]);
  fireEvent.change(within(sheet).getByRole("textbox", { name: "Note" }), { target: { value: "Holiday" } });
  fireEvent.click(within(sheet).getByRole("button", { name: /^Busy/ }));
  await waitFor(() => expect(count("own-busy")).toBe(2));
  expect(cell(10).querySelector(".note-icon")).toBeTruthy();
  expect(screen.getByText("2 days marked as busy")).toBeTruthy();

  // A busy day offers Maybe and Free again; its note is prefilled.
  fireEvent.click(cell(10));
  sheet = screen.getByRole("dialog");
  expect(within(sheet).getByText("Change this mark?")).toBeTruthy();
  expect(within(sheet).getByText(/So far:/).textContent).toBe("So far: busy");
  expect(within(sheet).queryByRole("button", { name: /^Busy/ })).toBeNull();
  const note = within(sheet).getByRole<HTMLInputElement>("textbox", { name: "Note" });
  expect(note.value).toBe("Holiday");
  fireEvent.change(note, { target: { value: "Trip" } });
  fireEvent.keyDown(note, { key: "Enter" });
  await waitFor(() => expect(marks.find((m) => m.day === nextMonthDay(10))?.note).toBe("Trip"));
  expect(cell(10).className).toMatch(/own-busy/);
  expect(screen.getByText("Note saved")).toBeTruthy();
});

test("?day= selects that day, opens the sheet and leaves the URL", async () => {
  const day = nextMonthDay(20);
  renderAt(`/g/1/days?day=${day}`);
  const sheet = await screen.findByRole("dialog");
  await waitFor(() => expect(cell(20).getAttribute("aria-pressed")).toBe("true"));
  expect(within(sheet).getByRole("heading").textContent).toMatch(/20/);
  await waitFor(() => expect(screen.getByTestId("search").textContent).toBe(""));
});

test("the intro card shows until dismissed, and ? brings it back with the keyboard help", async () => {
  localStorage.removeItem("introSeen");
  renderAt();
  await screen.findByRole("heading", { name: "How it works" });
  fireEvent.click(screen.getByRole("button", { name: "Got it" }));
  expect(screen.queryByRole("heading", { name: "How it works" })).toBeNull();
  expect(localStorage.getItem("introSeen")).toBe("1");

  fireEvent.click(screen.getByRole("button", { name: "Help" }));
  expect(screen.getByRole("heading", { name: "How it works" })).toBeTruthy();
  expect(screen.getByText("Keyboard:")).toBeTruthy();
});

test("a failed save rolls back and says so, with a retry", async () => {
  failSaves = true;
  renderAt();
  await waitFor(() => expect(cell(10)).toBeTruthy());
  act(() => cell(10).focus());
  key("Enter");
  key("b");
  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toMatch(/Couldn't save/);
  await waitFor(() => expect(cell(10).className).not.toMatch(/own-busy/));
  expect(screen.queryByText("1 day marked as busy")).toBeNull(); // not for a change that didn't happen

  failSaves = false;
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  await waitFor(() => expect(cell(10).className).toMatch(/own-busy/));
  expect(screen.queryByRole("alert")).toBeNull();
});
