// @vitest-environment jsdom

import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PeopleDirectoryPerson } from "@/features/people/api";
import type { PersonRef } from "@/features/people/person-ref";
import { PeoplePicker, type PeoplePickerProps } from "./people-picker";

const { search } = vi.hoisted(() => ({
  search: vi.fn<(query: string) => readonly PeopleDirectoryPerson[]>(),
}));

vi.mock("@/features/people/api", () => ({
  usePeopleSearch: (query: string) => ({
    people: query.trim() === "" ? [] : search(query),
    loading: false,
    error: false,
  }),
}));

const sam: PeopleDirectoryPerson = {
  id: "00000000-0000-4000-8000-000000000111",
  kind: "directory",
  actorId: "00000000-0000-4000-8000-000000000111",
  email: "sam@helix.test",
  displayName: "Sam Patel",
  title: "Engineer",
  favorite: false,
  avatarDataUrl: null,
  relationship: {},
};
const sasha: PeopleDirectoryPerson = {
  ...sam,
  id: "00000000-0000-4000-8000-000000000112",
  actorId: "00000000-0000-4000-8000-000000000112",
  email: "sasha@helix.test",
  displayName: "Sasha Wu",
  title: null,
};
const team: PeopleDirectoryPerson = {
  ...sam,
  id: "00000000-0000-4000-8000-000000000900",
  kind: "group",
  actorId: null,
  email: "team@helix.test",
  displayName: "Sales team",
};

describe("PeoplePicker", () => {
  let container: HTMLDivElement;
  let root: Root;
  let latest: PersonRef[];

  function Harness(props: Partial<PeoplePickerProps>) {
    const [value, setValue] = useState<PersonRef[]>([]);
    return (
      <PeoplePicker
        label="To"
        {...props}
        value={value}
        onChange={(next) => {
          latest = next;
          setValue(next);
        }}
      />
    );
  }

  function render(props: Partial<PeoplePickerProps> = {}) {
    act(() => {
      root.render(<Harness {...props} />);
    });
  }

  function input(): HTMLInputElement {
    const element = container.querySelector<HTMLInputElement>('input[role="combobox"]');
    if (element === null) throw new Error("combobox missing");
    return element;
  }

  function type(text: string) {
    const element = input();
    act(() => {
      element.focus();
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setter?.call(element, text);
      element.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  function press(key: string) {
    act(() => {
      input().dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
    });
  }

  function chipNames(): string[] {
    return Array.from(container.querySelectorAll(".person-chip-name")).map(
      (chip) => chip.textContent ?? "",
    );
  }

  beforeEach(() => {
    latest = [];
    search.mockImplementation((query) =>
      [sam, sasha, team].filter((person) =>
        person.displayName.toLowerCase().startsWith(query.toLowerCase()),
      ),
    );
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("exposes the combobox pattern with an active descendant", () => {
    render();
    const combobox = input();
    expect(combobox.getAttribute("aria-autocomplete")).toBe("list");
    expect(combobox.getAttribute("aria-expanded")).toBe("false");
    expect(container.querySelector("label")?.textContent).toBe("To");

    type("sa");
    const listbox = container.querySelector('[role="listbox"]');
    expect(combobox.getAttribute("aria-expanded")).toBe("true");
    expect(combobox.getAttribute("aria-controls")).toBe(listbox?.id);
    const options = Array.from(container.querySelectorAll('[role="option"]'));
    expect(
      options.map((option) => option.querySelector(".people-option-text")?.textContent),
    ).toEqual(["Sam Patelsam@helix.test · Engineer", "Sasha Wusasha@helix.test"]);
    expect(combobox.getAttribute("aria-activedescendant")).toBe(options[0]?.id);
    expect(options[0]?.getAttribute("aria-selected")).toBe("true");

    press("ArrowDown");
    expect(combobox.getAttribute("aria-activedescendant")).toBe(options[1]?.id);
    expect(options[1]?.getAttribute("aria-selected")).toBe("true");

    press("Escape");
    expect(combobox.getAttribute("aria-expanded")).toBe("false");
    expect(combobox.hasAttribute("aria-activedescendant")).toBe(false);
  });

  it("commits with Enter and Tab and removes the last chip with Backspace", () => {
    render();
    type("sam");
    press("Enter");
    expect(chipNames()).toEqual(["Sam Patel"]);
    expect(latest[0]).toMatchObject({ kind: "member", actorId: sam.actorId });
    expect(input().value).toBe("");

    type("sas");
    press("Tab");
    expect(chipNames()).toEqual(["Sam Patel", "Sasha Wu"]);

    press("Backspace");
    expect(chipNames()).toEqual(["Sam Patel"]);
  });

  it("commits typed text with a comma and flags external addresses unless allowed", () => {
    render();
    type("guest@example.com");
    press(",");
    expect(chipNames()).toEqual(["guest@example.com"]);
    expect(container.querySelector(".person-chip")?.hasAttribute("data-invalid")).toBe(true);
    expect(container.querySelector(".person-chip")?.getAttribute("title")).toBe(
      "guest@example.com",
    );
  });

  it("accepts valid external addresses and rejects malformed ones when allowExternal is set", () => {
    render({ allowExternal: true });
    type("guest@example.com");
    press(",");
    type("not-an-address");
    press(",");
    const chips = Array.from(container.querySelectorAll(".person-chip"));
    expect(chips.map((chip) => chip.hasAttribute("data-invalid"))).toEqual([false, true]);
    expect(chips[1]?.textContent).toContain("invalid address");
  });

  it("hides groups unless allowGroups is set", () => {
    render();
    type("sal");
    expect(container.querySelectorAll('[role="option"]')).toHaveLength(0);

    act(() => root.unmount());
    root = createRoot(container);
    render({ allowGroups: true });
    type("sal");
    expect(container.querySelector('[role="option"]')?.textContent).toContain("Sales team");
  });

  it("turns a pasted list into one chip per address", () => {
    render({ allowExternal: true });
    const element = input();
    const paste = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(paste, "clipboardData", {
      value: { getData: () => "a@example.com, Bo <bo@example.org>;\nc@example.net" },
    });
    act(() => {
      element.focus();
      element.dispatchEvent(paste);
    });
    expect(paste.defaultPrevented).toBe(true);
    expect(latest.map((ref) => ref.email)).toEqual([
      "a@example.com",
      "bo@example.org",
      "c@example.net",
    ]);
    expect(chipNames()).toEqual(["a@example.com", "Bo", "c@example.net"]);
  });

  it("edits a chip by clicking it and respects max", () => {
    render({ max: 1 });
    type("sam");
    press("Enter");
    expect(container.querySelector('input[role="combobox"]')).toBeNull();

    const edit = container.querySelector<HTMLButtonElement>(".person-chip-label");
    expect(edit?.getAttribute("aria-label")).toBe("Edit Sam Patel <sam@helix.test>");
    act(() => edit?.click());
    expect(chipNames()).toEqual([]);
    expect(input().value).toBe("sam@helix.test");
  });

  it("removes a chip with its remove button", () => {
    render();
    type("sam");
    press("Enter");
    act(() =>
      container.querySelector<HTMLButtonElement>('[aria-label="Remove Sam Patel"]')?.click(),
    );
    expect(latest).toEqual([]);
  });
});
