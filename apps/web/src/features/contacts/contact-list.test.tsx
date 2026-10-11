// @vitest-environment jsdom
import type { Contact } from "@helix/contracts";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NotifyOptions } from "@/components/ui/toast";
import { shortcutRegistry } from "@/lib/shortcuts/registry";
import { axeViolations, click, settle, unmountAll } from "@/test/ui";
import { ContactList } from "./contact-list";
import { contact, fakeContactsApi, mountWithQueries } from "./contacts-test-server";

const router = vi.hoisted(() => ({ navigate: vi.fn() }));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => router.navigate }));
const toasts = vi.hoisted(() => ({ list: [] as NotifyOptions[] }));
vi.mock("@/components/ui/toast", () => ({
  notify: (options: NotifyOptions) => {
    toasts.list.push(options);
    return toasts.list.length;
  },
}));

const ada = contact({
  displayName: "Ada Lovelace",
  givenName: "Ada",
  familyName: "Lovelace",
  company: "Engines",
  emails: [{ type: "work", value: "ada@example.com" }],
  labels: ["Family"],
});
const grace = contact({
  displayName: "Grace Hopper",
  givenName: "Grace",
  familyName: "Hopper",
  phones: [{ type: "mobile", value: "+1 555 0100" }],
});
const alan = contact({ displayName: "Alan Turing", givenName: "Alan", familyName: "Turing" });

let contacts: Contact[];
let api: ReturnType<typeof fakeContactsApi>;

function dispatchShortcuts(event: KeyboardEvent) {
  shortcutRegistry.handleKeyDown(event, {
    enabled: true,
    overlayOpen: document.querySelector('[aria-modal="true"], [role="menu"]') !== null,
    isMac: false,
  });
}

function rowNames(): string[] {
  return Array.from(document.querySelectorAll<HTMLElement>('[role="row"] .contacts-name')).map(
    (node) => node.textContent ?? "",
  );
}

function row(name: string): HTMLElement {
  const match = Array.from(document.querySelectorAll<HTMLElement>('[role="row"]')).find((node) =>
    node.textContent?.includes(name),
  );
  if (match === undefined) throw new Error(`No row ${name}`);
  return match;
}

function button(name: string): HTMLButtonElement {
  const match = Array.from(document.querySelectorAll("button")).find(
    (node) => node.getAttribute("aria-label") === name || node.textContent?.trim() === name,
  );
  if (match === undefined) throw new Error(`No button ${name}`);
  return match;
}

async function openMenu(trigger: HTMLElement) {
  act(() => {
    trigger.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
  });
  await settle();
}

function blur() {
  act(() => (document.activeElement as HTMLElement | null)?.blur());
}

function key(name: string, init: KeyboardEventInit = {}) {
  act(() => {
    (document.activeElement ?? document.body).dispatchEvent(
      new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true, ...init }),
    );
  });
}

beforeEach(() => {
  window.addEventListener("keydown", dispatchShortcuts);
  router.navigate.mockClear();
  toasts.list = [];
  contacts = [grace, ada, alan];
  api = fakeContactsApi({
    "contacts.list": () => ({ contacts, total: contacts.length }),
    "contacts.labels.list": () => ({
      labels: [{ name: "Family", count: 1 }],
      total: contacts.length,
    }),
    "contacts.trash": (body) => {
      const ids = body.ids as string[];
      contacts = contacts.filter((entry) => !ids.includes(entry.id));
      return { ids };
    },
    "contacts.restore": (body) => ({ ids: body.ids }),
    "contacts.label.apply": () => ({ contacts: [], total: 0 }),
    "contacts.update": () => ({ contact: ada }),
  });
});

afterEach(() => {
  window.removeEventListener("keydown", dispatchShortcuts);
  unmountAll();
  vi.unstubAllGlobals();
});

describe("ContactList", () => {
  it("lists contacts A–Z with section letters and sorts by last name", async () => {
    mountWithQueries(<ContactList query="" />);
    await settle();
    await settle();
    expect(rowNames()).toEqual(["Ada Lovelace", "Alan Turing", "Grace Hopper"]);
    expect(
      Array.from(document.querySelectorAll(".contacts-letter")).map((node) => node.textContent),
    ).toEqual(["", "A", "", "G"]);
    expect(document.querySelector("h1")?.textContent).toBe("Contacts (3)");

    await openMenu(button("Sort contacts"));
    const lastName = Array.from(document.querySelectorAll('[role="menuitemradio"]')).find(
      (node) => node.textContent === "Last name",
    );
    click(lastName ?? null);
    await settle();
    expect(rowNames()).toEqual(["Hopper, Grace", "Lovelace, Ada", "Turing, Alan"]);
    expect(await axeViolations()).toEqual([]);
  });

  it("filters by search text and label", async () => {
    mountWithQueries(<ContactList query="555" />);
    await settle();
    await settle();
    expect(rowNames()).toEqual(["Grace Hopper"]);
    unmountAll();
    mountWithQueries(<ContactList label="Family" query="" />);
    await settle();
    await settle();
    expect(rowNames()).toEqual(["Ada Lovelace"]);
  });

  it("shows the empty state with Create contact and Import", async () => {
    contacts = [];
    mountWithQueries(<ContactList query="" />);
    await settle();
    await settle();
    expect(document.body.textContent).toContain("No contacts yet");
    click(button("Create contact"));
    expect(router.navigate).toHaveBeenCalledWith({ to: "/contacts/new", search: {} });
    expect(button("Import")).toBeTruthy();
  });

  it("deletes the selection from the toolbar and undoes it from the snackbar", async () => {
    mountWithQueries(<ContactList query="" />);
    await settle();
    await settle();
    click(row("Ada Lovelace").querySelector('input[type="checkbox"]'));
    click(row("Grace Hopper").querySelector('input[type="checkbox"]'));
    expect(document.body.textContent).toContain("2 selected");
    click(button("Delete"));
    await settle();
    await settle();
    expect(api.called("contacts.trash")[0]?.body).toEqual({ ids: [ada.id, grace.id] });
    expect(toasts.list.at(-1)?.message).toBe("2 contacts moved to Trash");
    await act(async () => {
      toasts.list.at(-1)?.action?.onAction();
      await Promise.resolve();
    });
    await settle();
    expect(api.called("contacts.restore")[0]?.body).toEqual({ ids: [ada.id, grace.id] });
  });

  it("adds the selection to a label", async () => {
    mountWithQueries(<ContactList query="" />);
    await settle();
    await settle();
    click(row("Alan Turing").querySelector('input[type="checkbox"]'));
    await openMenu(button("Manage labels"));
    const family = Array.from(document.querySelectorAll('[role="menuitemcheckbox"]')).find(
      (node) => node.textContent === "Family",
    );
    click(family ?? null);
    await settle();
    expect(api.called("contacts.label.apply")[0]?.body).toEqual({
      ids: [alan.id],
      add: ["Family"],
      remove: [],
    });
  });

  it("wires c, j/k, x, e and # to the contacts shortcuts", async () => {
    mountWithQueries(<ContactList query="" />);
    await settle();
    await settle();
    key("c");
    expect(router.navigate).toHaveBeenLastCalledWith({ to: "/contacts/new", search: {} });

    blur();
    key("j");
    expect(document.activeElement).toBe(row("Ada Lovelace"));
    blur();
    key("k");
    expect(document.activeElement).toBe(row("Grace Hopper"));

    key("e");
    expect(router.navigate).toHaveBeenLastCalledWith({
      to: "/contacts/$contactId",
      params: { contactId: grace.id },
      search: { edit: true },
    });

    // x on a control inside a row selects that row.
    act(() => row("Ada Lovelace").querySelector<HTMLElement>(".contacts-star")?.focus());
    key("x");
    expect(document.body.textContent).toContain("1 selected");
    key("Escape");
    click(button("Clear selection"));

    act(() => row("Alan Turing").focus());
    key("#", { shiftKey: true });
    await settle();
    await settle();
    expect(api.called("contacts.trash")[0]?.body).toEqual({ ids: [alan.id] });
    expect(toasts.list.at(-1)?.action?.label).toBe("Undo");
  });
});
