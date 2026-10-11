// @vitest-environment jsdom

import { useQuery } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PeopleDirectoryPerson } from "@/features/people/api";
import { ContactsPanel } from "./contacts-panel";

const { invalidateQueries } = vi.hoisted(() => ({ invalidateQueries: vi.fn() }));

vi.mock("@tanstack/react-query", () => ({
  keepPreviousData: undefined,
  useQuery: vi.fn(),
  useQueryClient: () => ({ invalidateQueries }),
}));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn() }));

const person = (overrides: Partial<PeopleDirectoryPerson>): PeopleDirectoryPerson => ({
  id: "00000000-0000-4000-8000-000000000111",
  kind: "directory",
  actorId: "00000000-0000-4000-8000-000000000111",
  email: "sam@helix.test",
  displayName: "Sam Patel",
  title: "Engineer",
  favorite: false,
  avatarDataUrl: null,
  relationship: {},
  ...overrides,
});

describe("ContactsPanel", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("shows avatars and human labels instead of raw directory kinds", () => {
    vi.mocked(useQuery).mockReturnValue({
      data: [
        person({}),
        person({
          id: "g1",
          kind: "group",
          actorId: null,
          title: null,
          displayName: "Sales team",
          email: "sales@helix.test",
        }),
        person({
          id: "c1",
          kind: "personal",
          actorId: null,
          title: null,
          displayName: "Ada",
          email: "ada@example.com",
          favorite: true,
        }),
      ],
      isPending: false,
      isError: false,
    } as never);
    act(() => {
      root.render(<ContactsPanel />);
    });

    const rows = Array.from(container.querySelectorAll(".contacts-panel-row"));
    expect(
      rows.map((row) => row.querySelector(".contacts-panel-badge")?.textContent ?? ""),
    ).toEqual(["", "Group", "Contact"]);
    expect(container.textContent).not.toMatch(/directory|personal/u);
    expect(rows[0]?.textContent).toContain("Engineer");
    expect(rows[2]?.textContent).toContain(", favorite");
    expect(rows.every((row) => row.querySelector(".avatar") !== null)).toBe(true);
    expect(rows[0]?.getAttribute("aria-haspopup")).toBe("dialog");
    expect(container.querySelector('input[type="search"]')?.getAttribute("aria-label")).toBe(
      "Search contacts",
    );
  });

  it("offers an actionable retry when loading fails", () => {
    vi.mocked(useQuery).mockReturnValue({
      data: undefined,
      isPending: false,
      isError: true,
    } as never);
    act(() => {
      root.render(<ContactsPanel />);
    });

    expect(container.querySelector('[role="alert"]')?.textContent).toContain("try again");
    act(() => container.querySelector<HTMLButtonElement>('[role="alert"] button')?.click());
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ["people", "directory"] });
  });
});
