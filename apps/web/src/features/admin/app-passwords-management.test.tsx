// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppPasswordsManagement } from "./app-passwords-management";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

describe("AppPasswordsManagement", () => {
  let container: HTMLDivElement;
  let root: Root;
  let queryClient: QueryClient;
  let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;
  let alertMock: ReturnType<typeof vi.fn>;
  let confirmMock: ReturnType<typeof vi.fn>;
  let promptMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    fetchMock = vi.fn<typeof fetch>();
    alertMock = vi.fn();
    confirmMock = vi.fn();
    promptMock = vi.fn();
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: {
        getItem: vi.fn(() => null),
        removeItem: vi.fn(),
        setItem: vi.fn(),
      },
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("alert", alertMock);
    vi.stubGlobal("confirm", confirmMock);
    vi.stubGlobal("prompt", promptMock);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    queryClient.clear();
    container.remove();
    vi.unstubAllGlobals();
  });

  it("lists active app passwords and can include revoked app passwords", async () => {
    fetchMock.mockImplementation((input, init) => {
      if (isAdminUsersRequest(input)) {
        return Promise.resolve(Response.json(adminUsersPage()));
      }
      if (input === "/api/tools/app.passwords.list") {
        const body = requestBody<{ readonly includeRevoked?: boolean }>(init);
        return Promise.resolve(
          Response.json({
            appPasswords: body.includeRevoked
              ? [activeAppPassword(), revokedAppPassword()]
              : [activeAppPassword()],
          }),
        );
      }
      return Promise.resolve(Response.json({ error: "unexpected" }, { status: 500 }));
    });

    renderAppPasswords();

    await waitForText("Calendar sync");
    expect(container.querySelector('table[aria-label="App passwords"]')).not.toBeNull();
    expect(container.textContent).toContain("calendar.read");
    expect(container.textContent).not.toContain("Old calendar sync");

    clickIncludeRevoked();

    await waitForText("Old calendar sync");
    expect(latestListBody()).toEqual({ includeRevoked: true });
    expect(alertMock).not.toHaveBeenCalled();
    expect(confirmMock).not.toHaveBeenCalled();
    expect(promptMock).not.toHaveBeenCalled();
  });

  it("renders the section title as the only h1 and card titles below it", async () => {
    fetchMock.mockImplementation((input) => {
      if (isAdminUsersRequest(input)) {
        return Promise.resolve(Response.json(adminUsersPage()));
      }
      if (input === "/api/tools/app.passwords.list") {
        return Promise.resolve(Response.json({ appPasswords: [] }));
      }
      return Promise.resolve(Response.json({ error: "unexpected" }, { status: 500 }));
    });

    renderAppPasswords();
    await waitForText("Create app password");

    expect(headingTexts("h1")).toEqual(["App passwords"]);
    expect(headingTexts("h2")).toEqual(["Create app password", "Issued app passwords"]);
    expect(headingTexts("h3")).toEqual([]);
  });

  it("picks the actor from the loaded directory instead of a hand-typed id", async () => {
    fetchMock.mockImplementation((input) => {
      if (isAdminUsersRequest(input)) {
        return Promise.resolve(Response.json(adminUsersPage()));
      }
      if (input === "/api/tools/app.passwords.list") {
        return Promise.resolve(Response.json({ appPasswords: [activeAppPassword()] }));
      }
      return Promise.resolve(Response.json({ error: "unexpected" }, { status: 500 }));
    });

    renderAppPasswords();
    await waitFor(() => {
      expect(optionValues("app-password-actor-id")).toEqual([
        "",
        secondAdminUser().id,
        firstAdminUser().id,
      ]);
    });

    // Sorted by the visible label, and the label carries the email so two
    // actors with the same display name stay distinguishable.
    expect(optionLabels("app-password-actor-id")).toEqual([
      "Select an actor",
      "Ada Lovelace (ada@example.com)",
      "Mina Okafor (mina@example.com)",
    ]);
    // The picker replaced a free-text UUID field; no input should ask for one.
    expect(container.querySelector('input[placeholder*="0000-4000"]')).toBeNull();
    // The table resolves the actor id it lists against the same directory page.
    expect(container.textContent).toContain("Mina Okafor");
    expect(container.textContent).not.toContain(firstAdminUser().id);
  });

  it("creates an app password through the pending tool approval flow and shows the one-time password", async () => {
    fetchMock.mockImplementation((input) => {
      if (isAdminUsersRequest(input)) {
        return Promise.resolve(Response.json(adminUsersPage()));
      }
      if (input === "/api/tools/app.passwords.list") {
        return Promise.resolve(Response.json({ appPasswords: [] }));
      }
      if (input === "/api/tools/app.passwords.create") {
        return Promise.resolve(
          Response.json(
            { status: "pending_confirmation", pending: { id: "pending-create" } },
            { status: 202 },
          ),
        );
      }
      if (input === "/api/tools/pending/pending-create/approve") {
        return Promise.resolve(
          Response.json({
            status: "executed",
            output: {
              appPassword: activeAppPassword(),
              password: "one-time-app-password",
            },
          }),
        );
      }
      return Promise.resolve(Response.json({ error: "unexpected" }, { status: 500 }));
    });

    renderAppPasswords();
    await waitForText("No active app passwords.");
    await waitFor(() => {
      expect(optionValues("app-password-actor-id")).toContain(firstAdminUser().id);
    });
    changeInput("app-password-label", activeAppPassword().label);
    changeSelect("app-password-actor-id", firstAdminUser().id);
    clickButton("Create app password");

    await waitFor(() => {
      expect(inputValue("generated-app-password")).toBe("one-time-app-password");
    });
    expect(fetchBody("/api/tools/app.passwords.create")).toMatchObject({
      actorId: firstAdminUser().id,
      label: activeAppPassword().label,
      scopes: ["calendar.read"],
    });
    expect(
      fetchMock.mock.calls.some((call) => call[0] === "/api/tools/pending/pending-create/approve"),
    ).toBe(true);
    expect(alertMock).not.toHaveBeenCalled();
    expect(confirmMock).not.toHaveBeenCalled();
    expect(promptMock).not.toHaveBeenCalled();
  });

  it("styles the create action as the card's primary button", async () => {
    fetchMock.mockImplementation((input) => {
      if (isAdminUsersRequest(input)) {
        return Promise.resolve(Response.json(adminUsersPage()));
      }
      if (input === "/api/tools/app.passwords.list") {
        return Promise.resolve(Response.json({ appPasswords: [] }));
      }
      return Promise.resolve(Response.json({ error: "unexpected" }, { status: 500 }));
    });

    renderAppPasswords();
    await waitForText("Create app password");

    const submit = findButton("Create app password");
    expect(submit.dataset.variant).toBe("default");
    expect(
      Array.from(container.querySelectorAll("button")).filter(
        (button) => button.dataset.variant === "default",
      ),
    ).toEqual([submit]);
  });

  it("disables creation and says so when the actor list cannot load", async () => {
    fetchMock.mockImplementation((input) => {
      if (isAdminUsersRequest(input)) {
        return Promise.resolve(
          Response.json({ error: "Admin users permission denied." }, { status: 403 }),
        );
      }
      if (input === "/api/tools/app.passwords.list") {
        return Promise.resolve(Response.json({ appPasswords: [] }));
      }
      return Promise.resolve(Response.json({ error: "unexpected" }, { status: 500 }));
    });

    renderAppPasswords();
    await waitForText("Admin users permission denied.");

    const picker = selectElement("app-password-actor-id");
    expect(picker.disabled).toBe(true);
    expect(picker.options[0]?.textContent).toBe("Actors unavailable");
    expect(findButton("Create app password").disabled).toBe(true);
    expect(container.querySelector('[role="alert"].admin-banner')).not.toBeNull();
    // The error is recoverable without a reload.
    expect(findButton("Retry")).toBeInstanceOf(HTMLButtonElement);
  });

  it("uses the shared empty row rather than bare text when no app passwords exist", async () => {
    fetchMock.mockImplementation((input) => {
      if (isAdminUsersRequest(input)) {
        return Promise.resolve(Response.json(adminUsersPage()));
      }
      if (input === "/api/tools/app.passwords.list") {
        return Promise.resolve(Response.json({ appPasswords: [] }));
      }
      return Promise.resolve(Response.json({ error: "unexpected" }, { status: 500 }));
    });

    renderAppPasswords();

    await waitForText("No active app passwords.");
    expect(container.querySelector("tbody .admin-empty-row")).not.toBeNull();
  });

  it("keeps the issued-passwords panel top-aligned in its column", async () => {
    fetchMock.mockImplementation((input) => {
      if (isAdminUsersRequest(input)) {
        return Promise.resolve(Response.json(adminUsersPage()));
      }
      if (input === "/api/tools/app.passwords.list") {
        return Promise.resolve(Response.json({ appPasswords: [] }));
      }
      return Promise.resolve(Response.json({ error: "unexpected" }, { status: 500 }));
    });

    renderAppPasswords();
    await waitForText("Issued app passwords");

    /* jsdom has no layout, so the guard is on the alignment classes: a
       stretch-aligned grid is what spread the panel's rows down the card. */
    const panel = findByText("h2", "Issued app passwords")?.closest("section");
    expect(panel?.className).toContain("content-start");
    expect(panel?.parentElement?.className).toContain("items-start");
  });

  it("revokes an app password through the shared confirmation dialog without native confirm", async () => {
    fetchMock.mockImplementation((input) => {
      if (isAdminUsersRequest(input)) {
        return Promise.resolve(Response.json(adminUsersPage()));
      }
      if (input === "/api/tools/app.passwords.list") {
        return Promise.resolve(Response.json({ appPasswords: [activeAppPassword()] }));
      }
      if (input === "/api/tools/app.passwords.revoke") {
        return Promise.resolve(
          Response.json(
            { status: "pending_confirmation", pending: { id: "pending-revoke" } },
            { status: 202 },
          ),
        );
      }
      if (input === "/api/tools/pending/pending-revoke/approve") {
        return Promise.resolve(
          Response.json({
            status: "executed",
            output: {
              status: "revoked",
              appPassword: revokedAppPassword(),
            },
          }),
        );
      }
      return Promise.resolve(Response.json({ error: "unexpected" }, { status: 500 }));
    });

    renderAppPasswords();
    await waitForText("Calendar sync");
    await waitForText("Mina Okafor (mina@example.com)", container);
    clickButton("Revoke", container);
    await waitForText("Revoke app password", document.body);

    /* The shared ConfirmDestructive, so the console's destructive-action policy
       is applied here rather than re-implemented: this is its one-object tier,
       which names the target and stops there — no blast radius invented for a
       credential nothing here counts the holders of, and no typed phrase for
       something a replacement password fixes. */
    const description = document.querySelector('[data-slot="alert-dialog-description"]');
    expect(description?.textContent).toContain("Calendar sync");
    expect(description?.textContent).toContain("Mina Okafor (mina@example.com)");
    expect(description?.textContent).toContain("calendar.read");
    expect(document.body.querySelector(".admin-confirm-blast")).toBeNull();
    expect(document.body.querySelector(".admin-confirm-phrase")).toBeNull();

    clickLastButton("Revoke", document.body);

    await waitFor(() => {
      expect(fetchBody("/api/tools/app.passwords.revoke")).toEqual({
        passwordId: "password-active",
      });
    });
    expect(
      fetchMock.mock.calls.some((call) => call[0] === "/api/tools/pending/pending-revoke/approve"),
    ).toBe(true);
    expect(confirmMock).not.toHaveBeenCalled();
  });

  it("cancelling the revoke confirmation sends nothing", async () => {
    fetchMock.mockImplementation((input) => {
      if (isAdminUsersRequest(input)) {
        return Promise.resolve(Response.json(adminUsersPage()));
      }
      if (input === "/api/tools/app.passwords.list") {
        return Promise.resolve(Response.json({ appPasswords: [activeAppPassword()] }));
      }
      return Promise.resolve(Response.json({ error: "unexpected" }, { status: 500 }));
    });

    renderAppPasswords();
    await waitForText("Calendar sync");
    clickButton("Revoke", container);
    await waitForText("Revoke app password", document.body);
    clickButton("Cancel", document.body);

    await waitFor(() => {
      expect(document.querySelector('[role="alertdialog"]')).toBeNull();
    });
    expect(fetchMock.mock.calls.some((call) => call[0] === "/api/tools/app.passwords.revoke")).toBe(
      false,
    );
    // A dismissed overlay that fails to restore pointer events leaves the whole
    // console unclickable.
    expect(document.body.style.pointerEvents).not.toBe("none");
  });

  function renderAppPasswords() {
    act(() => {
      root.render(
        createElement(
          QueryClientProvider,
          { client: queryClient },
          createElement(AppPasswordsManagement),
        ),
      );
    });
  }

  function headingTexts(tag: "h1" | "h2" | "h3") {
    return Array.from(container.querySelectorAll(tag)).map((heading) =>
      heading.textContent?.trim(),
    );
  }

  function findByText(tag: string, text: string) {
    return Array.from(container.querySelectorAll(tag)).find(
      (element) => element.textContent?.trim() === text,
    );
  }

  function latestListBody() {
    const listCalls = fetchMock.mock.calls.filter(
      (call) => call[0] === "/api/tools/app.passwords.list",
    );
    return requestBody(listCalls.at(-1)?.[1]);
  }

  function fetchBody(path: string) {
    const call = fetchMock.mock.calls.find((candidate) => candidate[0] === path);
    if (call === undefined) {
      throw new Error(`No fetch call found for ${path}`);
    }
    return requestBody(call[1]);
  }
});

function isAdminUsersRequest(input: RequestInfo | URL) {
  return typeof input === "string" && input.startsWith("/api/admin/users");
}

function firstAdminUser() {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    orgId: "00000000-0000-4000-8000-0000000000aa",
    type: "user",
    email: "mina@example.com",
    displayName: "Mina Okafor",
    scopes: ["calendar.read"],
    disabledAt: null,
    createdAt: "2026-05-01T10:00:00.000Z",
    updatedAt: "2026-05-01T10:00:00.000Z",
  };
}

function secondAdminUser() {
  return {
    ...firstAdminUser(),
    id: "00000000-0000-4000-8000-000000000002",
    email: "ada@example.com",
    displayName: "Ada Lovelace",
  };
}

function adminUsersPage() {
  return { users: [firstAdminUser(), secondAdminUser()], nextCursor: null };
}

function activeAppPassword() {
  return {
    id: "password-active",
    actorId: firstAdminUser().id,
    label: "Calendar sync",
    scopes: ["calendar.read"],
    lastUsedAt: null,
    expiresAt: null,
    revokedAt: null,
    createdAt: "2026-05-20T15:00:00.000Z",
  };
}

function revokedAppPassword() {
  return {
    ...activeAppPassword(),
    id: "password-revoked",
    label: "Old calendar sync",
    revokedAt: "2026-05-20T16:00:00.000Z",
  };
}

function clickIncludeRevoked() {
  const input = Array.from(containerLabels())
    .find((label) => label.textContent?.includes("Include revoked"))
    ?.querySelector("input");
  if (input === null || input === undefined) {
    throw new Error("Include revoked checkbox not found.");
  }
  act(() => {
    input.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

function findButton(label: string, root: ParentNode = document.body) {
  const button = Array.from(root.querySelectorAll("button")).find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  if (button === undefined) {
    throw new Error(`Button not found: ${label}`);
  }
  return button;
}

function clickButton(label: string, root: ParentNode = document.body) {
  const button = findButton(label, root);
  act(() => {
    button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

function clickLastButton(label: string, root: ParentNode = document.body) {
  const button = Array.from(root.querySelectorAll("button"))
    .reverse()
    .find((candidate) => candidate.textContent?.trim() === label);
  if (button === undefined) {
    throw new Error(`Button not found: ${label}`);
  }
  act(() => {
    button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

function changeInput(id: string, value: string) {
  const input = document.getElementById(id);
  if (!(input instanceof HTMLInputElement)) {
    throw new Error(`Input not found: ${id}`);
  }
  act(() => {
    setNativeValue(HTMLInputElement.prototype, input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

function changeSelect(id: string, value: string) {
  const select = selectElement(id);
  act(() => {
    setNativeValue(HTMLSelectElement.prototype, select, value);
    select.dispatchEvent(new Event("input", { bubbles: true }));
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

function selectElement(id: string) {
  const select = document.getElementById(id);
  if (!(select instanceof HTMLSelectElement)) {
    throw new Error(`Select not found: ${id}`);
  }
  return select;
}

function optionValues(id: string) {
  return Array.from(selectElement(id).options).map((option) => option.value);
}

function optionLabels(id: string) {
  return Array.from(selectElement(id).options).map((option) => option.textContent);
}

async function waitForText(text: string, root: ParentNode = document.body) {
  await waitFor(() => {
    expect(root.textContent ?? "").toContain(text);
  });
}

async function waitFor(assertion: () => void) {
  const startedAt = Date.now();
  let lastError: unknown;
  while (Date.now() - startedAt < 2_000) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
      });
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Timed out waiting for assertion.");
}

function requestBody<T = unknown>(init: RequestInit | undefined): T {
  const body = init?.body;
  if (body === undefined) {
    return JSON.parse("{}") as T;
  }
  if (typeof body !== "string") {
    throw new TypeError("Expected request body to be a JSON string.");
  }
  return JSON.parse(body) as T;
}

function containerLabels() {
  return document.querySelectorAll("label");
}

function setNativeValue(
  prototype: HTMLInputElement | HTMLSelectElement,
  element: HTMLInputElement | HTMLSelectElement,
  value: string,
) {
  const descriptor = Object.getOwnPropertyDescriptor(prototype, "value");
  if (descriptor?.set === undefined) {
    element.value = value;
    return;
  }
  const setValue: (nextValue: string) => void = descriptor.set.bind(element);
  setValue(value);
}

function inputValue(id: string) {
  const input = document.getElementById(id);
  if (!(input instanceof HTMLInputElement)) {
    throw new Error(`Input not found: ${id}`);
  }
  return input.value;
}
