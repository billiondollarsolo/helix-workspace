// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentCredentialsManagement } from "./agent-credentials-management";
import { withAdminRouter } from "@/features/admin/console/test-router";

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
      if (input === "/v1/api/tools/agent.credentials.list") {
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

    await waitForText("Scheduler key");
    expect(container.querySelector('table[aria-label="Agent credentials"]')).not.toBeNull();
    expect(container.textContent).toContain("platform.read");
    expect(container.textContent).toContain("API key");
    expect(container.textContent).not.toContain("Retired client");
    // The agent is named, not shown as an id.
    await waitForText("Scheduler Agent", container);

    clickIncludeRevoked();

    await waitForText("Retired client");
    // An OAuth client shows the client ID an operator has to configure.
    expect(container.textContent).toContain("OAuth client · client-revoked");
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
      if (input === "/v1/api/tools/agent.credentials.list") {
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

  it("picks from the organization's agents and service accounts, agents first", async () => {
    fetchMock.mockImplementation((input) => {
      if (isActorDirectoryRequest(input)) {
        return Promise.resolve(actorDirectoryResponse());
      }
      if (input === "/v1/api/tools/agent.credentials.list") {
        return Promise.resolve(Response.json({ credentials: [] }));
      }
      return Promise.resolve(Response.json({ error: "unexpected" }, { status: 500 }));
    });

    renderAgentCredentials();
    await waitForOption("agent-actor-id", agentActor().id);

    const select = selectElement("agent-actor-id");
    expect(select.disabled).toBe(false);
    expect(Array.from(select.querySelectorAll("optgroup")).map((group) => group.label)).toEqual([
      "Agents",
      "Service accounts",
    ]);
    // A disabled agent cannot be given a new credential.
    expect(optionLabels("agent-actor-id")).toEqual([
      "Select an agent",
      "Scheduler Agent",
      "Reporting",
    ]);
    expect(optionValues("agent-actor-id")).toEqual(["", agentActor().id, serviceAccount().id]);
  });

  it("adds an agent and selects it for its first credential", async () => {
    const agents = [agentActor()];
    fetchMock.mockImplementation((input, init) => {
      if (input === "/v1/api/admin/agents" && init?.method === "POST") {
        const created = { ...agentActor(), id: NEW_AGENT_ID, displayName: "Release bot" };
        agents.push(created);
        return Promise.resolve(Response.json({ agent: created }, { status: 201 }));
      }
      if (isActorDirectoryRequest(input)) {
        return Promise.resolve(Response.json({ agents }));
      }
      if (input === "/v1/api/tools/agent.credentials.list") {
        return Promise.resolve(Response.json({ credentials: [] }));
      }
      return Promise.resolve(Response.json({ error: "unexpected" }, { status: 500 }));
    });

    renderAgentCredentials();
    await waitForOption("agent-actor-id", agentActor().id);
    expect(findButton("Add agent", container).disabled).toBe(true);

    typeInto("New agent name", "Release bot");
    clickButton("Add agent", container);

    await waitForOption("agent-actor-id", NEW_AGENT_ID);
    const added = fetchMock.mock.calls.find(
      (call) => call[0] === "/v1/api/admin/agents" && call[1]?.method === "POST",
    );
    expect(requestBody(added?.[1])).toEqual({ displayName: "Release bot", description: "" });
    await waitFor(() => {
      expect(selectElement("agent-actor-id").value).toBe(NEW_AGENT_ID);
    });
  });

  it("blocks creation when the agents cannot be loaded", async () => {
    fetchMock.mockImplementation((input) => {
      if (isActorDirectoryRequest(input)) {
        return Promise.resolve(Response.json({ error: "actors offline" }, { status: 500 }));
      }
      if (input === "/v1/api/tools/agent.credentials.list") {
        return Promise.resolve(Response.json({ credentials: [] }));
      }
      return Promise.resolve(Response.json({ error: "unexpected" }, { status: 500 }));
    });

    renderAgentCredentials();
    await waitForText("Credentials cannot be issued until the list loads.", container);

    expect(container.querySelector('[role="alert"]')?.textContent).toContain("actors offline");
    expect(selectElement("agent-actor-id").disabled).toBe(true);
    expect(findButton("Create credential", container).disabled).toBe(true);
    expect(
      fetchMock.mock.calls.some((call) => call[0] === "/v1/api/tools/agent.credentials.create"),
    ).toBe(false);
  });

  it("creates a credential through the pending tool approval flow and shows the one-time secret", async () => {
    fetchMock.mockImplementation((input) => {
      if (isActorDirectoryRequest(input)) {
        return Promise.resolve(actorDirectoryResponse());
      }
      if (input === "/v1/api/tools/agent.credentials.list") {
        return Promise.resolve(Response.json({ credentials: [] }));
      }
      if (input === "/v1/api/tools/agent.credentials.create") {
        return Promise.resolve(
          Response.json(
            { status: "pending_confirmation", pending: { id: "pending-create" } },
            { status: 202 },
          ),
        );
      }
      if (input === "/v1/api/tools/pending/pending-create/approve") {
        return Promise.resolve(
          Response.json({
            status: "executed",
            output: {
              credential: activeCredential(),
              secret: "helix_ak_secret-agent-token",
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
    typeInto("Label", "Scheduler key");
    typeInto("What it is for", "Books rooms");
    clickButton("Create credential");

    await waitFor(() => {
      expect(inputValue("agent-client-secret")).toBe("helix_ak_secret-agent-token");
    });
    expect(container.textContent).toContain("Send it in the x-api-key header.");
    // Everything the server requires, including an expiry it will accept.
    const sent = fetchBody("/v1/api/tools/agent.credentials.create") as {
      readonly expiresAt: string;
    };
    expect(sent).toEqual({
      actorId: activeCredential().actorId,
      credentialType: "api_key",
      label: "Scheduler key",
      purpose: "Books rooms",
      scopes: ["platform.read", "tools:read"],
      expiresAt: expect.any(String),
    });
    const lifetimeDays = (new Date(sent.expiresAt).getTime() - Date.now()) / 86_400_000;
    expect(lifetimeDays).toBeGreaterThan(89);
    expect(lifetimeDays).toBeLessThan(91);
    expect(
      fetchMock.mock.calls.some(
        (call) => call[0] === "/v1/api/tools/pending/pending-create/approve",
      ),
    ).toBe(true);
    expect(alertMock).not.toHaveBeenCalled();
    expect(confirmMock).not.toHaveBeenCalled();
    expect(promptMock).not.toHaveBeenCalled();
  });

  it("says what to do when issuing waits for a second administrator", async () => {
    fetchMock.mockImplementation((input) => {
      if (isActorDirectoryRequest(input)) {
        return Promise.resolve(actorDirectoryResponse());
      }
      if (input === "/v1/api/tools/agent.credentials.list") {
        return Promise.resolve(Response.json({ credentials: [] }));
      }
      if (input === "/v1/api/tools/agent.credentials.create") {
        return Promise.resolve(
          Response.json(
            { code: "crown_jewel_approval_required", approval: { id: "approval-1" } },
            { status: 202 },
          ),
        );
      }
      return Promise.resolve(Response.json({ error: "unexpected" }, { status: 500 }));
    });

    renderAgentCredentials();
    await waitForOption("agent-actor-id", activeCredential().actorId);
    selectOption("agent-actor-id", activeCredential().actorId);
    typeInto("Label", "Scheduler key");
    typeInto("What it is for", "Books rooms");
    clickButton("Create credential");

    await waitForText("A second administrator must approve this change (request approval-1)");
    expect(container.textContent).toContain("under Admin → Policies");
  });

  it("revokes a credential through the shared confirmation dialog without native confirm", async () => {
    fetchMock.mockImplementation((input) => {
      if (isActorDirectoryRequest(input)) {
        return Promise.resolve(actorDirectoryResponse());
      }
      if (input === "/v1/api/tools/agent.credentials.list") {
        return Promise.resolve(Response.json({ credentials: [activeCredential()] }));
      }
      if (input === "/v1/api/tools/agent.credentials.revoke") {
        return Promise.resolve(
          Response.json(
            { status: "pending_confirmation", pending: { id: "pending-revoke" } },
            { status: 202 },
          ),
        );
      }
      if (input === "/v1/api/tools/pending/pending-revoke/approve") {
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
    await waitForText("Scheduler key");
    await waitForText("Scheduler Agent", container);
    clickButton("Revoke", container);
    await waitForText("Revoke agent credential", document.body);

    const dialog = document.querySelector('[data-slot="alert-dialog-description"]');
    expect(dialog?.textContent).toContain("Scheduler key stops working for Scheduler Agent");
    /* Now the shared ConfirmDestructive rather than a private copy of the same
       AlertDialog stack, at the policy's one-object tier: the scopes the
       credential actually carries, no blast radius invented for holders nothing
       here counts, and no typed phrase for something a new credential fixes. */
    expect(dialog?.textContent).toContain("platform.read, tools:read");
    expect(document.body.querySelector(".admin-confirm-blast")).toBeNull();
    expect(document.body.querySelector(".admin-confirm-phrase")).toBeNull();

    clickLastButton("Revoke", document.body);

    await waitFor(() => {
      expect(fetchBody("/v1/api/tools/agent.credentials.revoke")).toEqual({
        credentialId: activeCredential().id,
      });
    });
    expect(
      fetchMock.mock.calls.some(
        (call) => call[0] === "/v1/api/tools/pending/pending-revoke/approve",
      ),
    ).toBe(true);
    expect(confirmMock).not.toHaveBeenCalled();
  });

  it("cancelling the revoke confirmation sends nothing", async () => {
    fetchMock.mockImplementation((input) => {
      if (isActorDirectoryRequest(input)) {
        return Promise.resolve(actorDirectoryResponse());
      }
      if (input === "/v1/api/tools/agent.credentials.list") {
        return Promise.resolve(Response.json({ credentials: [activeCredential()] }));
      }
      return Promise.resolve(Response.json({ error: "unexpected" }, { status: 500 }));
    });

    renderAgentCredentials();
    await waitForText("Scheduler key");
    clickButton("Revoke", container);
    await waitForText("Revoke agent credential", document.body);
    clickButton("Cancel", document.body);

    await waitFor(() => {
      expect(document.querySelector('[role="alertdialog"]')).toBeNull();
    });
    expect(
      fetchMock.mock.calls.some((call) => call[0] === "/v1/api/tools/agent.credentials.revoke"),
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
          withAdminRouter(createElement(AgentCredentialsManagement)),
        ),
      );
    });
  }

  function latestListBody() {
    const listCalls = fetchMock.mock.calls.filter(
      (call) => call[0] === "/v1/api/tools/agent.credentials.list",
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

const NEW_AGENT_ID = "00000000-0000-4000-8000-000000000009";

function activeCredential() {
  return {
    id: "00000000-0000-4000-8000-0000000000c1",
    credentialType: "api_key",
    actorId: "00000000-0000-4000-8000-000000000001",
    label: "Scheduler key",
    purpose: "Books rooms",
    scopes: ["platform.read", "tools:read"],
    clientId: null,
    expiresAt: "2026-12-01T09:00:00.000Z",
    revokedAt: null,
    lastUsedAt: null,
  };
}

function revokedCredential() {
  return {
    ...activeCredential(),
    id: "00000000-0000-4000-8000-0000000000c2",
    credentialType: "oauth_client",
    label: "Retired client",
    clientId: "client-revoked",
    revokedAt: "2026-05-20T16:00:00.000Z",
  };
}

function agentActor() {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    displayName: "Scheduler Agent",
    type: "agent",
    description: "",
    disabled: false,
    createdAt: "2026-05-01T09:00:00.000Z",
  };
}

function serviceAccount() {
  return {
    ...agentActor(),
    id: "00000000-0000-4000-8000-000000000002",
    type: "service_account",
    displayName: "Reporting",
  };
}

/** Service accounts first on the wire: the picker is expected to put agents up front. */
function actorDirectoryResponse() {
  return Response.json({
    agents: [
      serviceAccount(),
      agentActor(),
      { ...agentActor(), id: "00000000-0000-4000-8000-000000000003", disabled: true },
    ],
  });
}

function isActorDirectoryRequest(input: unknown): boolean {
  return input === "/v1/api/admin/agents";
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

/** Type into the field with this label, the way React hears it. */
function typeInto(label: string, value: string) {
  const input = Array.from(containerLabels())
    .find((candidate) => candidate.textContent?.trim().startsWith(label))
    ?.querySelector("input");
  if (input === null || input === undefined) {
    throw new Error(`Field not found: ${label}`);
  }
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  act(() => {
    setValue?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function inputValue(id: string) {
  const input = document.getElementById(id);
  if (!(input instanceof HTMLInputElement)) {
    throw new Error(`Input not found: ${id}`);
  }
  return input.value;
}
