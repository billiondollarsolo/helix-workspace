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
      if (isActorDirectoryRequest(input)) {
        return Promise.resolve(actorDirectoryResponse());
      }
      if (input === "/api/tools/agent.credentials.list") {
        const body = requestBody<{ readonly includeRevoked?: boolean }>(init);
        return Promise.resolve(
          Response.json({
            credentials: body.includeRevoked
              ? [activeCredential(), revokedCredential()]
              : [activeCredential()],
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
    // The actor id stays visible, but no longer alone.
    await waitForText("Scheduler Agent (scheduler@agents.example)", container);
    expect(container.textContent).toContain(agentActor().id);

    clickIncludeRevoked();

    await waitForText("client-revoked");
    expect(latestListBody()).toEqual({ includeRevoked: true });
    expect(alertMock).not.toHaveBeenCalled();
    expect(confirmMock).not.toHaveBeenCalled();
    expect(promptMock).not.toHaveBeenCalled();
  });

  it("titles the section with a single h1 and no skipped heading levels", async () => {
    fetchMock.mockImplementation((input) => {
      if (isActorDirectoryRequest(input)) {
        return Promise.resolve(actorDirectoryResponse());
      }
      if (input === "/api/tools/agent.credentials.list") {
        return Promise.resolve(Response.json({ credentials: [] }));
      }
      return Promise.resolve(Response.json({ error: "unexpected" }, { status: 500 }));
    });

    renderAgentCredentials();
    await waitForText("No active credentials", container);

    const headings = Array.from(container.querySelectorAll("h1, h2, h3, h4"));
    expect(headings.map((heading) => heading.tagName)).toEqual(["H1", "H2", "H2"]);
    expect(headings[0]?.textContent).toBe("Agent credentials");
  });

  it("picks the actor from the directory, grouped by actor type", async () => {
    fetchMock.mockImplementation((input) => {
      if (isActorDirectoryRequest(input)) {
        return Promise.resolve(actorDirectoryResponse());
      }
      if (input === "/api/tools/agent.credentials.list") {
        return Promise.resolve(Response.json({ credentials: [] }));
      }
      return Promise.resolve(Response.json({ error: "unexpected" }, { status: 500 }));
    });

    renderAgentCredentials();
    await waitForOption("agent-actor-id", agentActor().id);

    const select = selectElement("agent-actor-id");
    expect(select.disabled).toBe(false);
    expect(Array.from(select.querySelectorAll("optgroup")).map((group) => group.label)).toEqual([
      "Agent actors",
      "Human actors",
    ]);
    expect(optionLabels("agent-actor-id")).toContain("Scheduler Agent (scheduler@agents.example)");
    expect(optionLabels("agent-actor-id")).toContain("Ada Lovelace (ada@example.com)");
    expect(optionValues("agent-actor-id")).toEqual(["", agentActor().id, humanActor().id]);
  });

  it("flags a human actor picked for an agent credential", async () => {
    fetchMock.mockImplementation((input) => {
      if (isActorDirectoryRequest(input)) {
        return Promise.resolve(actorDirectoryResponse());
      }
      if (input === "/api/tools/agent.credentials.list") {
        return Promise.resolve(Response.json({ credentials: [] }));
      }
      return Promise.resolve(Response.json({ error: "unexpected" }, { status: 500 }));
    });

    renderAgentCredentials();
    await waitForOption("agent-actor-id", humanActor().id);

    selectOption("agent-actor-id", agentActor().id);
    expect(container.textContent).not.toContain("not an agent");

    selectOption("agent-actor-id", humanActor().id);
    expect(container.textContent).toContain("is a human actor, not an agent");
  });

  it("blocks creation when the actor directory cannot load", async () => {
    fetchMock.mockImplementation((input) => {
      if (isActorDirectoryRequest(input)) {
        return Promise.resolve(Response.json({ error: "actors offline" }, { status: 500 }));
      }
      if (input === "/api/tools/agent.credentials.list") {
        return Promise.resolve(Response.json({ credentials: [] }));
      }
      return Promise.resolve(Response.json({ error: "unexpected" }, { status: 500 }));
    });

    renderAgentCredentials();
    await waitForText("Credentials cannot be issued until the actor directory loads.", container);

    expect(container.querySelector('[role="alert"]')?.textContent).toContain("actors offline");
    expect(selectElement("agent-actor-id").disabled).toBe(true);
    expect(findButton("Create credential", container).disabled).toBe(true);
    expect(
      fetchMock.mock.calls.some((call) => call[0] === "/api/tools/agent.credentials.create"),
    ).toBe(false);
  });

  it("creates a credential through the pending tool approval flow and shows the one-time secret", async () => {
    fetchMock.mockImplementation((input) => {
      if (isActorDirectoryRequest(input)) {
        return Promise.resolve(actorDirectoryResponse());
      }
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
    await waitForText("No active credentials", container);
    await waitForOption("agent-actor-id", activeCredential().actorId);
    selectOption("agent-actor-id", activeCredential().actorId);
    clickButton("Create credential");

    await waitFor(() => {
      expect(inputValue("agent-client-secret")).toBe("secret-agent-token");
    });
    // The picker is presentation only: the tool still receives a bare actor id.
    expect(fetchBody("/api/tools/agent.credentials.create")).toMatchObject({
      actorId: activeCredential().actorId,
      scopes: ["platform.read", "tools:read"],
    });
    expect(
      fetchMock.mock.calls.some((call) => call[0] === "/api/tools/pending/pending-create/approve"),
    ).toBe(true);
    expect(alertMock).not.toHaveBeenCalled();
    expect(confirmMock).not.toHaveBeenCalled();
    expect(promptMock).not.toHaveBeenCalled();
  });

  it("revokes a credential through the shared confirmation dialog without native confirm", async () => {
    fetchMock.mockImplementation((input) => {
      if (isActorDirectoryRequest(input)) {
        return Promise.resolve(actorDirectoryResponse());
      }
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
    await waitForText("Scheduler Agent (scheduler@agents.example)", container);
    clickButton("Revoke", container);
    await waitForText("Revoke agent credential", document.body);

    const dialog = document.querySelector('[data-slot="alert-dialog-description"]');
    expect(dialog?.textContent).toContain("Scheduler Agent (scheduler@agents.example)");
    expect(dialog?.textContent).toContain(activeCredential().actorId);
    expect(dialog?.textContent).toContain("client-active");
    /* Now the shared ConfirmDestructive rather than a private copy of the same
       AlertDialog stack, at the policy's one-object tier: the scopes the
       credential actually carries, no blast radius invented for holders nothing
       here counts, and no typed phrase for something a new credential fixes. */
    expect(dialog?.textContent).toContain("platform.read, tools:read");
    expect(document.body.querySelector(".admin-confirm-blast")).toBeNull();
    expect(document.body.querySelector(".admin-confirm-phrase")).toBeNull();

    clickLastButton("Revoke", document.body);

    await waitFor(() => {
      expect(fetchBody("/api/tools/agent.credentials.revoke")).toEqual({
        clientId: "client-active",
      });
    });
    expect(
      fetchMock.mock.calls.some((call) => call[0] === "/api/tools/pending/pending-revoke/approve"),
    ).toBe(true);
    expect(confirmMock).not.toHaveBeenCalled();
  });

  it("cancelling the revoke confirmation sends nothing", async () => {
    fetchMock.mockImplementation((input) => {
      if (isActorDirectoryRequest(input)) {
        return Promise.resolve(actorDirectoryResponse());
      }
      if (input === "/api/tools/agent.credentials.list") {
        return Promise.resolve(Response.json({ credentials: [activeCredential()] }));
      }
      return Promise.resolve(Response.json({ error: "unexpected" }, { status: 500 }));
    });

    renderAgentCredentials();
    await waitForText("client-active");
    clickButton("Revoke", container);
    await waitForText("Revoke agent credential", document.body);
    clickButton("Cancel", document.body);

    await waitFor(() => {
      expect(document.querySelector('[role="alertdialog"]')).toBeNull();
    });
    expect(
      fetchMock.mock.calls.some((call) => call[0] === "/api/tools/agent.credentials.revoke"),
    ).toBe(false);
    // A dismissed overlay that fails to restore pointer events leaves the whole
    // console unclickable.
    expect(document.body.style.pointerEvents).not.toBe("none");
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
    const listCalls = fetchMock.mock.calls.filter(
      (call) => call[0] === "/api/tools/agent.credentials.list",
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

function agentActor() {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    orgId: "00000000-0000-4000-8000-000000000099",
    type: "agent",
    email: "scheduler@agents.example",
    displayName: "Scheduler Agent",
    scopes: ["platform.read"],
    disabledAt: null,
    createdAt: "2026-05-01T09:00:00.000Z",
    updatedAt: "2026-05-01T09:00:00.000Z",
  };
}

function humanActor() {
  return {
    ...agentActor(),
    id: "00000000-0000-4000-8000-000000000002",
    type: "human",
    email: "ada@example.com",
    displayName: "Ada Lovelace",
  };
}

/** Humans first on the wire: the picker is expected to order agents up front. */
function actorDirectoryResponse() {
  return Response.json({ users: [humanActor(), agentActor()], nextCursor: null });
}

function isActorDirectoryRequest(input: unknown): boolean {
  return typeof input === "string" && input.startsWith("/api/admin/users");
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

function selectElement(id: string) {
  const select = document.getElementById(id);
  if (!(select instanceof HTMLSelectElement)) {
    throw new Error(`Select not found: ${id}`);
  }
  return select;
}

function optionValues(id: string) {
  return Array.from(selectElement(id).querySelectorAll("option")).map((option) => option.value);
}

function optionLabels(id: string) {
  return Array.from(selectElement(id).querySelectorAll("option")).map((option) =>
    option.textContent?.trim(),
  );
}

async function waitForOption(id: string, value: string) {
  await waitFor(() => {
    expect(optionValues(id)).toContain(value);
  });
}

function selectOption(id: string, value: string) {
  const select = selectElement(id);
  act(() => {
    setSelectValue(select, value);
    select.dispatchEvent(new Event("input", { bubbles: true }));
    select.dispatchEvent(new Event("change", { bubbles: true }));
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

function setSelectValue(select: HTMLSelectElement, value: string) {
  const descriptor = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value");
  if (descriptor?.set === undefined) {
    select.value = value;
    return;
  }
  const setValue: (nextValue: string) => void = descriptor.set.bind(select);
  setValue(value);
}

function inputValue(id: string) {
  const input = document.getElementById(id);
  if (!(input instanceof HTMLInputElement)) {
    throw new Error(`Input not found: ${id}`);
  }
  return input.value;
}
