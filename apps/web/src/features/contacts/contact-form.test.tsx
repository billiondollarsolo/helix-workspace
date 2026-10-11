// @vitest-environment jsdom
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NotifyOptions } from "@/components/ui/toast";
import { axeViolations, click, settle, unmountAll } from "@/test/ui";
import { ContactForm } from "./contact-form";
import { contact, fakeContactsApi, mountWithQueries } from "./contacts-test-server";

const router = vi.hoisted(() => ({ navigate: vi.fn() }));
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => router.navigate,
  useBlocker: () => ({ status: "idle" }),
}));
const toasts = vi.hoisted(() => ({ list: [] as NotifyOptions[] }));
vi.mock("@/components/ui/toast", () => ({
  notify: (options: NotifyOptions) => {
    toasts.list.push(options);
    return toasts.list.length;
  },
}));

const stored = contact({
  displayName: "Ada Lovelace",
  givenName: "Ada",
  familyName: "Lovelace",
  emails: [{ type: "work", value: "ada@example.com" }],
  labels: ["Family"],
});

let api: ReturnType<typeof fakeContactsApi>;

function field(label: string): HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement {
  const match = document.querySelector<HTMLInputElement>(`[aria-label="${label}"]`);
  if (match === null) throw new Error(`No field ${label}`);
  return match;
}

function type(target: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement, value: string) {
  const prototype = Object.getPrototypeOf(target) as object;
  const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
  act(() => {
    setter?.call(target, value);
    target.dispatchEvent(
      new Event(target instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }),
    );
  });
}

function button(name: string): HTMLButtonElement {
  const match = Array.from(document.querySelectorAll("button")).find(
    (node) => node.getAttribute("aria-label") === name || node.textContent?.trim() === name,
  );
  if (match === undefined) throw new Error(`No button ${name}`);
  return match;
}

async function save() {
  act(() => {
    document
      .querySelector("form.contacts-form")
      ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
  await settle();
  await settle();
}

beforeEach(() => {
  router.navigate.mockClear();
  toasts.list = [];
  api = fakeContactsApi({
    "contacts.labels.list": () => ({ labels: [{ name: "Family", count: 1 }], total: 1 }),
    "contacts.get": () => ({ contact: stored }),
    "contacts.create": (body) => ({
      contact: { ...stored, ...body, id: "00000000-0000-4000-8000-0000000000c1" },
    }),
    "contacts.update": (body) => ({ contact: { ...stored, ...body } }),
    "contacts.list": () => ({ contacts: [], total: 0 }),
  });
});

afterEach(() => {
  unmountAll();
  vi.unstubAllGlobals();
});

describe("ContactForm", () => {
  it("creates a contact from typed fields and repeatable rows", async () => {
    mountWithQueries(<ContactForm defaultLabel="Family" />);
    await settle();
    type(field("First name"), "Grace");
    type(field("Last name"), "Hopper");
    type(field("Email 1"), "grace@example.org");
    type(field("Email 1 type"), "work");
    click(button("Add email"));
    type(field("Email 2"), "  ");
    type(field("Phone 1"), "+1 555 0100");
    click(button("Add address"));
    type(field("Address 1 city"), "Arlington");
    type(field("Notes"), "Compilers");
    expect(await axeViolations()).toEqual([]);

    await save();

    expect(api.called("contacts.create")[0]?.body).toEqual({
      givenName: "Grace",
      familyName: "Hopper",
      company: "",
      jobTitle: "",
      emails: [{ type: "work", value: "grace@example.org" }],
      phones: [{ type: "mobile", value: "+1 555 0100" }],
      addresses: [
        { type: "home", street: "", city: "Arlington", region: "", postalCode: "", country: "" },
      ],
      birthday: null,
      notes: "Compilers",
      labels: ["Family"],
      photoDataUrl: null,
      starred: false,
    });
    expect(toasts.list.at(-1)?.message).toBe("Contact created");
    expect(router.navigate).toHaveBeenLastCalledWith({
      to: "/contacts/$contactId",
      params: { contactId: "00000000-0000-4000-8000-0000000000c1" },
      search: {},
      replace: true,
    });
  });

  it("explains what is missing instead of saving", async () => {
    mountWithQueries(<ContactForm />);
    await settle();
    await save();
    expect(document.body.textContent).toContain("Add a name, company, email or phone.");
    type(field("Email 1"), "not-an-email");
    await save();
    expect(field("Email 1").getAttribute("aria-invalid")).toBe("true");
    expect(document.body.textContent).toContain("Enter a valid email address.");
    expect(api.called("contacts.create")).toEqual([]);
  });

  it("edits a contact by sending only what changed", async () => {
    mountWithQueries(<ContactForm contactId={stored.id} />);
    await settle();
    await settle();
    expect((field("First name") as HTMLInputElement).value).toBe("Ada");
    type(field("Job title"), "Mathematician");
    click(button("Remove label Family"));
    await save();
    expect(api.called("contacts.update")[0]?.body).toEqual({
      id: stored.id,
      jobTitle: "Mathematician",
      labels: [],
    });
    expect(toasts.list.at(-1)?.message).toBe("Contact saved");
  });
});
