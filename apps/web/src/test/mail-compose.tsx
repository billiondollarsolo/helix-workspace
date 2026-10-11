/* Shared helpers for the compose and reply tests. */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, type ReactNode } from "react";
import { expect } from "vitest";
import { mailAddressQueryKeys, type MailAddresses } from "@/lib/mail-addresses";
import { click, key, mount, settle } from "@/test/ui";

const ME = "me@helix.test";

const ADDRESSES: MailAddresses = {
  actorId: "actor-1",
  primaryEmail: ME,
  loginEmail: ME,
  eligibleDomains: [],
  addresses: [
    {
      id: null,
      address: ME,
      displayName: "Me",
      isPrimary: true,
      receiveEnabled: true,
      sendAsEnabled: true,
      source: "primary",
    },
  ],
};

export function renderWithClient(ui: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  client.setQueryData(mailAddressQueryKeys.current, ADDRESSES);
  client.setQueryData(["account", "preferences"], {
    language: null,
    timeZone: "UTC",
    dateFormat: null,
    timeFormat: null,
    weekStart: null,
    workingHours: null,
    mail: { readingPane: "none", density: "default", conversationView: true },
    updatedAt: null,
  });
  client.setQueryData(["mail", "settings"], {
    signatureText: "",
    signatureHtml: null,
    includeSignatureOnReplies: true,
    blockedSenders: [],
    updatedAt: null,
  });
  const mounted = mount(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
  return { client, ...mounted };
}

/** Let real time pass (the autosave debounce), with React updates flushed. */
export async function sleep(ms: number) {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

export async function waitFor(check: () => boolean, message = "condition") {
  for (let attempt = 0; attempt < 60 && !check(); attempt += 1) await settle();
  expect(check(), message).toBe(true);
}

export function byLabel<T extends Element = HTMLElement>(
  label: string,
  root: ParentNode = document,
): T {
  const element = root.querySelector<T & Element>(`[aria-label="${label}"]`);
  if (element === null) throw new Error(`No element labelled ${label}`);
  return element;
}

export function buttonByText(text: string, root: ParentNode = document): HTMLButtonElement {
  const button = Array.from(root.querySelectorAll("button")).find(
    (candidate) => candidate.textContent?.trim() === text,
  );
  if (button === undefined) throw new Error(`No button ${text}`);
  return button;
}

export function typeInto(input: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto =
    input instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  act(() => {
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

/** Type into the rich body: set its HTML and fire the input event the editor listens to. */
export function typeBody(html: string, root: ParentNode = document) {
  const editor = byLabel<HTMLDivElement>("Message body", root);
  act(() => {
    editor.innerHTML = html;
    editor.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

/** Add a recipient chip by typing an address and pressing Enter in a picker. */
export function addRecipient(
  field: "To" | "Cc" | "Bcc",
  address: string,
  root: ParentNode = document,
) {
  const label = Array.from(root.querySelectorAll("label")).find(
    (candidate) => candidate.textContent === field,
  );
  const input = label?.htmlFor ? document.getElementById(label.htmlFor) : null;
  if (!(input instanceof HTMLInputElement)) throw new Error(`No ${field} field`);
  typeInto(input, address);
  act(() => {
    input.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
    );
  });
}

/** Open a Radix menu from the keyboard (jsdom has no pointer capture). */
export async function openMenu(trigger: HTMLElement) {
  act(() => {
    trigger.focus();
  });
  await key("Enter");
}

export { click, settle };
