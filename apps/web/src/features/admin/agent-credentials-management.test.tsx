// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentCredentialsManagement } from "./agent-credentials-management";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

describe("AgentCredentialsManagement", () => {
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

  it("lists active agent credentials and can include revoked credentials", async () => {
    fetchMock.mockImplementation((input, init) => {
      if (input === "/api/tools/agent.credentials.list") {
        const body = requestBody<{ readonly includeRevoked?: boolean }>(init);
        return Promise.resolve(
          Response.json({
            credentials: body.includeRevoked ? [activeCredential(), revokedCredential()] : [activeCredential()],
          }),
        );
      }
      return Promise.resolve(Response.json({ error: "unexpected" }, { status: 500 }));
    });

    renderAgentCredentials();

    await waitForText("client-active");
    expect(container.querySelector('table[aria-label="Agent credentials"]')).not.toBeNull();
    expect(container.textContent).toContain("platform.read");
    expect(container.textContent).not.toContain("client-revoked");

    clickIncludeRevoked();

    await waitForText("client-revoked");
    expect(latestListBody()).toEqual({ includeRevoked: true });
    expect(alertMock).not.toHaveBeenCalled();
    expect(confirmMock).not.toHaveBeenCalled();
    expect(promptMock).not.toHaveBeenCalled();
  });

  it("creates a credential through the pending tool approval flow and shows the one-time secret", async () => {
    fetchMock.mockImplementation((input) => {
      if (input === "/api/tools/agent.credentials.list") {
        return Promise.resolve(Response.json({ credentials: [] }));
      }
      if (input === "/api/tools/agent.credentials.create") {
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
              credential: activeCredential(),
              clientSecret: "secret-agent-token",
              grantType: "client_credentials",
              tokenEndpoint: "/oauth/token",
            },
          }),
        );
      }
      return Promise.resolve(Response.json({ error: "unexpected" }, { status: 500 }));
    });

    renderAgentCredentials();
    await waitForText("No agent credentials found.");
    changeInput("agent-actor-id", activeCredential().actorId);
    clickButton("Create credential");

    await waitFor(() => {
      expect(inputValue("agent-client-secret")).toBe("secret-agent-token");
    });
    expect(fetchBody("/api/tools/agent.credentials.create")).toMatchObject({
      actorId: activeCredential().actorId,
      scopes: ["platform.read", "tools:read"],
    });
    expect(fetchMock.mock.calls.some((call) => call[0] === "/api/tools/pending/pending-create/approve")).toBe(
      true,
    );
    expect(alertMock).not.toHaveBeenCalled();
    expect(confirmMock).not.toHaveBeenCalled();
    expect(promptMock).not.toHaveBeenCalled();
  });

  it("revokes a credential through the shared confirmation dialog without native confirm", async () => {
    fetchMock.mockImplementation((input) => {
      if (input === "/api/tools/agent.credentials.list") {
        return Promise.resolve(Response.json({ credentials: [activeCredential()] }));
      }
      if (input === "/api/tools/agent.credentials.revoke") {
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
              credential: revokedCredential(),
            },
          }),
        );
      }
      return Promise.resolve(Response.json({ error: "unexpected" }, { status: 500 }));
    });

    renderAgentCredentials();
    await waitForText("client-active");
    clickButton("Revoke", container);
    await waitForText("Revoke agent credential", document.body);
    clickLastButton("Revoke", document.body);

    await waitFor(() => {
      expect(fetchBody("/api/tools/agent.credentials.revoke")).toEqual({ clientId: "client-active" });
    });
    expect(fetchMock.mock.calls.some((call) => call[0] === "/api/tools/pending/pending-revoke/approve")).toBe(
      true,
    );
    expect(confirmMock).not.toHaveBeenCalled();
  });

  function renderAgentCredentials() {
    act(() => {
      root.render(
        createElement(
          QueryClientProvider,
          { client: queryClient },
          createElement(AgentCredentialsManagement),
        ),
      );
    });
  }

  function latestListBody() {
    const listCalls = fetchMock.mock.calls.filter((call) => call[0] === "/api/tools/agent.credentials.list");
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

function activeCredential() {
  return {
    clientId: "client-active",
    actorId: "00000000-0000-4000-8000-000000000001",
    orgId: "00000000-0000-4000-8000-000000000099",
    scopes: ["platform.read", "tools:read"],
    expiresAt: null,
    revokedAt: null,
  };
}

function revokedCredential() {
  return {
    ...activeCredential(),
    clientId: "client-revoked",
    revokedAt: "2026-05-20T16:00:00.000Z",
  };
}

function clickIncludeRevoked() {
  const input = Array.from(containerLabels()).find((label) =>
    label.textContent?.includes("Include revoked"),
  )?.querySelector("input");
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
