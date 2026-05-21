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

  it("creates an app password through the pending tool approval flow and shows the one-time password", async () => {
    fetchMock.mockImplementation((input) => {
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
    await waitForText("No app passwords found.");
    changeInput("app-password-label", activeAppPassword().label);
    changeInput("app-password-actor-id", activeAppPassword().actorId);
    clickButton("Create app password");

    await waitFor(() => {
      expect(inputValue("generated-app-password")).toBe("one-time-app-password");
    });
    expect(fetchBody("/api/tools/app.passwords.create")).toMatchObject({
      actorId: activeAppPassword().actorId,
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

  it("revokes an app password through the shared confirmation dialog without native confirm", async () => {
    fetchMock.mockImplementation((input) => {
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
    clickButton("Revoke", container);
    await waitForText("Revoke app password", document.body);
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

function activeAppPassword() {
  return {
    id: "password-active",
    actorId: "00000000-0000-4000-8000-000000000001",
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

function clickButton(label: string, root: ParentNode = document.body) {
  const button = Array.from(root.querySelectorAll("button")).find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  if (button === undefined) {
    throw new Error(`Button not found: ${label}`);
  }
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
    setInputValue(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
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

function setInputValue(input: HTMLInputElement, value: string) {
  const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
  if (descriptor?.set === undefined) {
    input.value = value;
    return;
  }
  const setValue: (nextValue: string) => void = descriptor.set.bind(input);
  setValue(value);
}

function inputValue(id: string) {
  const input = document.getElementById(id);
  if (!(input instanceof HTMLInputElement)) {
    throw new Error(`Input not found: ${id}`);
  }
  return input.value;
}
