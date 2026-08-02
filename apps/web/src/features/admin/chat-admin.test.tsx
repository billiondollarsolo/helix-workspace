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
      editWindowSeconds: "3600",
      deleteWindowSeconds: "7200",
      roomId: "",
    });
  });

  it("keeps export and retention mappers aligned with tool contracts", () => {
    expect(
      mapRetentionFormToToolInput({
        retentionDays: String(CHAT_PLATFORM_DEFAULT_RETENTION_DAYS),
        editWindowSeconds: "86400",
        deleteWindowSeconds: "86400",
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
        roomIds: "",
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
    vi.stubGlobal("URL", {
      ...URL,
      createObjectURL: vi.fn(() => "blob:export"),
      revokeObjectURL: vi.fn(),
    });
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
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          orgId: "22222222-2222-4222-8222-222222222222",
          roomId: null,
          retentionDays: 90,
          editWindowSeconds: 86_400,
          deleteWindowSeconds: 86_400,
          legalHold: false,
          updatedAt: "2026-08-01T00:00:00.000Z",
          configured: true,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

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

    await waitFor(() => {
      expect(container.textContent ?? "").toContain("90 day retention");
    });

    expect(headingOutline()).toEqual(["H1:Chat", "H2:Retention policy", "H2:Organization export"]);

    const retentionInput = inputByLabel("Retention days");
    expect(retentionInput.value).toBe("90");
    expect(retentionInput.disabled).toBe(false);
    expect(buttonByText("Save retention policy").disabled).toBe(false);
    expect(buttonByText("Run organization export").disabled).toBe(false);

    const requestInput = fetchMock.mock.calls[0]?.[0];
    const requestUrl =
      typeof requestInput === "string"
        ? requestInput
        : requestInput instanceof URL
          ? requestInput.toString()
          : (requestInput?.url ?? "");
    expect(requestUrl).toContain("/api/tools/chat.retention.get");
  });

  it("disables controls with an explicit reason when retention tools are unauthorized", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: "forbidden" }), {
        status: 403,
        headers: { "content-type": "application/json" },
      }),
    );

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

    await waitFor(() => {
      expect(container.querySelector('[role="alert"]')?.textContent ?? "").toContain(
        "Chat retention controls are unavailable",
      );
    });

    expect(container.querySelector(".admin-unavailable-reason")?.textContent ?? "").toContain(
      "admin.chat",
    );
    expect(buttonByText("Save retention policy").disabled).toBe(true);
    expect(buttonByText("Run organization export").disabled).toBe(true);
    expect(buttonByText("Enable legal hold").disabled).toBe(true);
  });

  it("opens a confirmation dialog before posting retention.set (no silent write)", async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          orgId: "22222222-2222-4222-8222-222222222222",
          roomId: null,
          retentionDays: 2555,
          editWindowSeconds: 86_400,
          deleteWindowSeconds: 86_400,
          legalHold: false,
          updatedAt: null,
          configured: false,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

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

    // Wait for the policy summary from the query — form defaults are also 2555,
    // so the input value alone does not prove the load finished (controls stay
    // disabled while the query is pending).
    await waitFor(() => {
      expect(container.textContent ?? "").toContain("platform default");
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
