// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatAdminSection, policyToForm } from "./chat-admin";
import {
  CHAT_PLATFORM_DEFAULT_RETENTION_DAYS,
  mapExportFormToToolInput,
  mapRetentionFormToToolInput,
} from "./chat-admin-api";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const ORG_ID = "22222222-2222-4222-8222-222222222222";
const LAUNCH_ROOM_ID = "33333333-3333-4333-8333-333333333333";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function requestUrl(input: Parameters<typeof fetch>[0]): string {
  return typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
}

/** Answers the room list and workspace settings; everything else gets `policy`. */
function respondWith(policy: Record<string, unknown>, privateRoomsVisible = false) {
  return (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = requestUrl(input);
    if (url.includes("chat.room.list_organization")) {
      return Promise.resolve(
        jsonResponse({
          rooms: [
            {
              id: LAUNCH_ROOM_ID,
              kind: "chat_room",
              name: "Launch",
              privacy: "restricted",
              memberCount: 4,
              agentOnly: false,
              updatedAt: "2026-08-01T00:00:00.000Z",
            },
          ],
          privateRoomsVisible,
          hiddenPrivateCount: privateRoomsVisible ? 0 : 3,
        }),
      );
    }
    if (url.includes("/api/admin/tenant-config")) {
      const features = { chat_admin_private_rooms: privateRoomsVisible };
      return Promise.resolve(
        jsonResponse({
          tenantConfig: {
            orgId: ORG_ID,
            orgName: "Example",
            byo: {},
            features,
            quotas: {},
            branding: {},
            effective: { byo: {}, features, quotas: {}, branding: {} },
          },
        }),
      );
    }
    const asked: unknown = typeof init?.body === "string" ? JSON.parse(init.body) : {};
    const roomId =
      typeof asked === "object" && asked !== null && "roomId" in asked ? asked.roomId : null;
    return Promise.resolve(jsonResponse({ ...policy, roomId }));
  };
}

const CONFIGURED_POLICY = {
  orgId: ORG_ID,
  retentionDays: 90,
  editWindowSeconds: 86_400,
  deleteWindowSeconds: 86_400,
  legalHold: false,
  updatedAt: "2026-08-01T00:00:00.000Z",
  configured: true,
};

const UNSET_POLICY = { retentionDays: 2555, updatedAt: null, configured: false };

describe("policyToForm / mappers (component-adjacent handlers)", () => {
  it("hydrates form fields from a configured policy view", () => {
    expect(
      policyToForm({
        orgId: "22222222-2222-4222-8222-222222222222",
        roomId: null,
        retentionDays: 90,
        editWindowSeconds: 3600,
        deleteWindowSeconds: 7200,
        legalHold: true,
        updatedAt: "2026-08-01T00:00:00.000Z",
        configured: true,
      }),
    ).toEqual({
      retentionDays: "90",
      editWindowMinutes: "60",
      deleteWindowMinutes: "120",
      roomId: "",
    });
  });

  it("keeps export and retention mappers aligned with tool contracts", () => {
    expect(
      mapRetentionFormToToolInput({
        retentionDays: String(CHAT_PLATFORM_DEFAULT_RETENTION_DAYS),
        editWindowMinutes: "1440",
        deleteWindowMinutes: "1440",
        roomId: "",
      }),
    ).toEqual({
      retentionDays: CHAT_PLATFORM_DEFAULT_RETENTION_DAYS,
      editWindowSeconds: 86_400,
      deleteWindowSeconds: 86_400,
    });
    expect(
      mapExportFormToToolInput({
        from: "",
        to: "",
        limit: "250",
        roomIds: [],
      }),
    ).toEqual({ roomIds: [], limit: 250 });
  });
});

describe("ChatAdminSection", () => {
  let container: HTMLDivElement;
  let root: Root;
  let queryClient: QueryClient;
  let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;

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
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: {
        getItem: vi.fn(() => null),
        removeItem: vi.fn(),
        setItem: vi.fn(),
      },
    });
    vi.stubGlobal("fetch", fetchMock);
    // jsdom lacks URL.createObjectURL / anchor downloads.
    vi.stubGlobal(
      "URL",
      class extends URL {
        static override createObjectURL = vi.fn(() => "blob:export");
        static override revokeObjectURL = vi.fn();
      },
    );
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    queryClient.clear();
    container.remove();
    vi.unstubAllGlobals();
  });

  it("loads the org retention policy and enables real controls", async () => {
    fetchMock.mockImplementation(respondWith(CONFIGURED_POLICY));

    await renderSection();

    await waitFor(() => {
      expect(container.textContent ?? "").toContain("Messages kept for 90 days");
    });

    expect(headingOutline()).toEqual([
      "H1:Chat",
      "H2:Service status",
      "H2:Room visibility",
      "H2:Retention policy",
      "H2:Organization export",
    ]);

    const retentionInput = inputByLabel("Retention days");
    expect(retentionInput.value).toBe("90");
    expect(retentionInput.disabled).toBe(false);
    expect(buttonByText("Save retention policy").disabled).toBe(false);
    expect(buttonByText("Run organization export").disabled).toBe(false);

    const requestUrls = fetchMock.mock.calls.map(([requestInput]) => requestUrl(requestInput));
    expect(requestUrls.some((url) => url.includes("/v1/api/tools/chat.retention.get"))).toBe(true);
  });

  it("offers rooms by name and says how many private ones are left out", async () => {
    fetchMock.mockImplementation(respondWith(CONFIGURED_POLICY));
    await renderSection();

    const scope = selectByLabel("Retention applies to");
    await waitFor(() => {
      expect([...scope.options].map((option) => option.textContent)).toEqual([
        "Whole organization",
        "Launch (invitation only)",
      ]);
    });
    expect(container.textContent ?? "").toContain(
      "3 private rooms and direct messages are not listed.",
    );
    expect(container.textContent ?? "").toContain("Rooms (every room)");
    expect(container.querySelector('input[aria-label="Room ID override"]')).toBeNull();

    act(() => {
      scope.value = LAUNCH_ROOM_ID;
      scope.dispatchEvent(new Event("change", { bubbles: true }));
    });

    // The room's own policy is read, so the form and the hold buttons describe that room.
    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(
          ([input, init]) =>
            requestUrl(input).includes("chat.retention.get") &&
            typeof init?.body === "string" &&
            init.body.includes(LAUNCH_ROOM_ID),
        ),
      ).toBe(true);
    });

    const roomCheckbox = container.querySelector('fieldset input[type="checkbox"]');
    if (!(roomCheckbox instanceof HTMLInputElement)) throw new Error("Room checkbox not found.");
    act(() => {
      roomCheckbox.click();
    });
    expect(container.textContent ?? "").toContain("Rooms (1 chosen)");
  });

  it("asks for agent-only rooms only when the switch is on", async () => {
    fetchMock.mockImplementation(respondWith(CONFIGURED_POLICY, true));
    await renderSection();
    await waitFor(() => {
      expect(roomListRequests()).toEqual([false]);
    });
    expect(container.textContent ?? "").not.toContain("not listed");

    const agentSwitch = [...container.querySelectorAll('[role="switch"]')].find((candidate) =>
      document
        .getElementById(candidate.getAttribute("aria-labelledby") ?? "")
        ?.textContent?.includes("Show agent-only rooms"),
    );
    if (!(agentSwitch instanceof HTMLElement)) throw new Error("Agent-only switch not found.");
    act(() => {
      agentSwitch.click();
    });
    await waitFor(() => {
      expect(roomListRequests()).toEqual([false, true]);
    });
  });

  it("disables controls with an explicit reason when retention tools are unauthorized", async () => {
    fetchMock.mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify({ error: "forbidden" }), {
          status: 403,
          headers: { "content-type": "application/json" },
        }),
      ),
    );

    await renderSection();

    await waitFor(() => {
      expect(
        [...container.querySelectorAll('[role="alert"]')].map((alert) => alert.textContent).join(),
      ).toContain("Chat retention controls are unavailable");
    });

    expect(container.querySelector(".admin-unavailable-reason")?.textContent ?? "").toContain(
      "admin.chat",
    );
    expect(buttonByText("Save retention policy").disabled).toBe(true);
    expect(buttonByText("Run organization export").disabled).toBe(true);
    expect(buttonByText("Enable legal hold").disabled).toBe(true);
  });

  it("opens a confirmation dialog before posting retention.set (no silent write)", async () => {
    fetchMock.mockImplementation(respondWith({ ...CONFIGURED_POLICY, ...UNSET_POLICY }));

    await renderSection();

    // Wait for the policy summary from the query — form defaults are also 2555,
    // so the input value alone does not prove the load finished (controls stay
    // disabled while the query is pending).
    await waitFor(() => {
      expect(container.textContent ?? "").toContain("Default settings");
    });

    const callsBefore = fetchMock.mock.calls.length;
    const saveButton = buttonByText("Save retention policy");
    expect(saveButton.disabled).toBe(false);

    act(() => {
      saveButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    // AlertDialog portals to document.body. The write must not fire until the
    // operator confirms — chat-admin-api.test covers pending/approve tool flow.
    await waitFor(() => {
      expect(
        document.body.querySelector('[data-slot="alert-dialog-content"]')?.textContent ?? "",
      ).toContain("Save Chat retention policy");
    });
    expect(document.body.querySelector('[data-slot="alert-dialog-action"]')?.textContent).toContain(
      "Save policy",
    );
    expect(document.body.querySelector(".admin-confirm-blast")).not.toBeNull();
    expect(fetchMock.mock.calls.length).toBe(callsBefore);
    expect(
      fetchMock.mock.calls.some((call) => {
        const url = call[0];
        return typeof url === "string" && url.includes("chat.retention.set");
      }),
    ).toBe(false);
  });

  async function renderSection(): Promise<void> {
    await act(() => {
      root.render(
        createElement(
          QueryClientProvider,
          { client: queryClient },
          createElement(ChatAdminSection),
        ),
      );
      return Promise.resolve();
    });
  }

  /** The `includeAgentOnly` value of each room list request, in order. */
  function roomListRequests(): unknown[] {
    return fetchMock.mock.calls
      .filter(([input]) => requestUrl(input).includes("chat.room.list_organization"))
      .map(([, init]) => {
        const body: unknown = typeof init?.body === "string" ? JSON.parse(init.body) : {};
        return typeof body === "object" && body !== null && "includeAgentOnly" in body
          ? body.includeAgentOnly
          : undefined;
      });
  }

  function selectByLabel(label: string): HTMLSelectElement {
    const select = container.querySelector(`select[aria-label="${label}"]`);
    if (!(select instanceof HTMLSelectElement)) {
      throw new Error(`Select not found: ${label}`);
    }
    return select;
  }

  function headingOutline(): string[] {
    return Array.from(container.querySelectorAll("h1, h2, h3, h4, h5, h6")).map(
      (heading) => `${heading.tagName}:${heading.textContent ?? ""}`,
    );
  }

  function buttonByText(name: string): HTMLButtonElement {
    return buttonIn(container, name);
  }

  function buttonIn(rootNode: ParentNode, name: string): HTMLButtonElement {
    const button = Array.from(rootNode.querySelectorAll("button")).find((candidate) =>
      candidate.textContent?.includes(name),
    );
    if (!(button instanceof HTMLButtonElement)) {
      throw new Error(`Button not found: ${name}`);
    }
    return button;
  }

  function inputByLabel(label: string): HTMLInputElement {
    const input = container.querySelector(`input[aria-label="${label}"]`);
    if (!(input instanceof HTMLInputElement)) {
      throw new Error(`Input not found: ${label}`);
    }
    return input;
  }

  async function waitFor(assertion: () => void, timeoutMs = 2_000): Promise<void> {
    const started = Date.now();
    let lastError: unknown;
    while (Date.now() - started <= timeoutMs) {
      try {
        assertion();
        return;
      } catch (error) {
        lastError = error;
        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 20));
        });
      }
    }
    throw lastError instanceof Error ? lastError : new Error("waitFor timed out");
  }
});
