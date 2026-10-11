// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { MailUserSettings } from "@/features/mail/api";
import { mailUserSettingsQueryOptions } from "@/features/mail/queries";
import { SignatureSection } from "./settings-signature";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

/** Runs `action` inside act and lets pending fetch promises settle. */
async function settle(action: () => void): Promise<void> {
  await act(() => {
    action();
    return new Promise<void>((resolve) => setTimeout(resolve, 0));
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

const loaded: MailUserSettings = {
  signatureText: "Old signature",
  signatureHtml: "<b>Old signature</b>",
  includeSignatureOnReplies: true,
  blockedSenders: ["spam@example.net"],
  updatedAt: "2026-10-01T00:00:00.000Z",
};

function setTextarea(element: HTMLTextAreaElement, value: string): void {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(
      element,
      value,
    );
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function renderSection(client: QueryClient) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const render = () =>
    root.render(
      <QueryClientProvider client={client}>
        <SignatureSection />
      </QueryClientProvider>,
    );
  await settle(() => render());
  return { container, root, render };
}

function saveButton(container: HTMLElement): HTMLButtonElement {
  return Array.from(container.querySelectorAll("button")).find(
    (button) => button.textContent === "Save mail settings",
  )!;
}

it("sends only the edited fields and keeps the saved value when reopened", async () => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  client.setQueryData(mailUserSettingsQueryOptions().queryKey, loaded);
  const saved = { ...loaded, signatureText: "New signature", updatedAt: "2026-10-10T00:00:00Z" };
  document.cookie = `helix_csrf=${"s".repeat(43)}; Path=/`;
  const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json(saved));

  const first = await renderSection(client);
  setTextarea(
    first.container.querySelector<HTMLTextAreaElement>("#settings-mail-signature")!,
    "New signature",
  );
  await settle(() => saveButton(first.container).click());

  const [url, init] = fetchMock.mock.calls[0]!;
  expect(url).toEqual(expect.stringContaining("/api/tools/mail.settings.set"));
  const body = JSON.parse(init?.body as string) as Record<string, unknown>;
  // The form has no HTML signature control, so it must not clear one.
  expect(body).not.toHaveProperty("signatureHtml");
  expect(body).toEqual({
    signatureText: "New signature",
    includeSignatureOnReplies: true,
    blockedSenders: ["spam@example.net"],
  });
  expect(first.container.querySelector('[role="status"]')?.textContent).toBe(
    "Mail settings saved.",
  );
  expect(client.getQueryData(mailUserSettingsQueryOptions().queryKey)).toEqual(saved);
  act(() => first.root.unmount());

  const reopened = await renderSection(client);
  expect(
    reopened.container.querySelector<HTMLTextAreaElement>("#settings-mail-signature")?.value,
  ).toBe("New signature");
  act(() => reopened.root.unmount());
});

it("reports a failed save as an alert", async () => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  client.setQueryData(mailUserSettingsQueryOptions().queryKey, loaded);
  document.cookie = `helix_csrf=${"s".repeat(43)}; Path=/`;
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    Response.json({ error: { message: "Mail settings are not available." } }, { status: 400 }),
  );

  const { container, root } = await renderSection(client);
  await settle(() => saveButton(container).click());

  expect(container.querySelector('[role="alert"]')?.textContent).toBe(
    "Mail settings are not available.",
  );
  expect(container.querySelector('[role="status"]')).toBeNull();
  act(() => root.unmount());
});
