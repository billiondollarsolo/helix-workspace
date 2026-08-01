// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CoreAppsManagement } from "./core-apps-management";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const adminStatus = {
  role: "all",
  apps: [
    {
      id: "mail",
      name: "Mail",
      description: "SMTP send/receive.",
      enabled: true,
      inRole: true,
      registered: true,
    },
    {
      id: "chat",
      name: "Chat",
      description: "Realtime channels.",
      enabled: false,
      inRole: true,
      registered: false,
    },
    {
      id: "editors",
      name: "Editors",
      description: "Native editor suite.",
      enabled: true,
      inRole: true,
      registered: true,
    },
  ],
};

describe("CoreAppsManagement", () => {
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
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    queryClient.clear();
    container.remove();
    vi.unstubAllGlobals();
  });

  it("renders core apps with enabled/disabled status from the admin API", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify(adminStatus), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    await act(() => {
      root.render(
        createElement(
          QueryClientProvider,
          { client: queryClient },
          createElement(CoreAppsManagement),
        ),
      );
      return Promise.resolve();
    });

    await waitFor(() => {
      expect(container.textContent ?? "").toContain("Mail");
    });
    expect(container.textContent).toContain("Workspace apps");
    expect(container.textContent).toContain("2 of 3 enabled");

    // Per-app state lives on the switches. It used to be duplicated into an
    // Enabled/Disabled text pill beside each name, which this test matched on;
    // asserting `aria-checked` instead checks the state assistive tech is
    // actually told, and pins it per app rather than "the word appears once".
    const switches = [...container.querySelectorAll('[role="switch"]')];
    expect(switches.map((element) => element.getAttribute("aria-checked"))).toEqual([
      "true",
      "false",
      "true",
    ]);
    expect(switches.map((element) => element.getAttribute("aria-label"))).toEqual([
      "Disable Mail",
      "Enable Chat",
      "Disable Editors",
    ]);
    expect(container.textContent).toContain("Alpha");
    expect(container.textContent).toContain("Disable to keep Drive storage");
    const requestUrl = requestUrlOf(fetchMock.mock.calls[0]?.[0]);
    expect(requestUrl).toContain("/api/admin/core-apps");
  });

  /* Disabling is org-wide and one click away, so it is the console's
   * irreversible/many-affected tier: the PATCH must not leave until a
   * confirmation naming the app has been accepted. The assertions on the PATCH
   * itself are unchanged — only the route to it is. */
  it("confirms before disabling a core app, then toggles it off via the admin API", async () => {
    mockToggleOf("mail");

    await renderManagement();

    await waitFor(() => {
      expect(container.querySelector('[aria-label="Disable Mail"]')).not.toBeNull();
    });
    await clickSwitch("Disable Mail");

    // Nothing may have left for the backend on the strength of one toggle click.
    expect(toggleCallFor("mail")).toBeUndefined();

    const dialog = confirmDialog();
    // The modal really does blank the page behind it, which is what makes the
    // restore assertions below (and in the cancel case) worth making.
    expect(document.body.style.pointerEvents).toBe("none");
    expect(dialog.textContent).toContain("Disable Mail");
    expect(dialog.textContent).toContain("everyone in your organization");
    expect(blastRadiusText()).toBe(
      "Every user loses the inbox, composing, and mail results in search.",
    );
    // Still on, still reported as on, until the operator confirms.
    expect(
      container.querySelector('[aria-label="Disable Mail"]')?.getAttribute("aria-checked"),
    ).toBe("true");

    await clickDialogButton("Disable Mail");

    await waitFor(() => {
      const toggleCall = toggleCallFor("mail");
      expect(toggleCall).toBeDefined();
      expect(toggleCall?.[1]?.method).toBe("PATCH");
      expect(requestBodyOf(toggleCall)).toEqual({ enabled: false });
    });
    await waitFor(() => {
      expect(document.querySelector('[role="alertdialog"]')).toBeNull();
    });
    expect(document.body.style.pointerEvents).not.toBe("none");
  });

  it("cancelling the confirmation leaves the app enabled and sends nothing", async () => {
    mockToggleOf("mail");

    await renderManagement();

    await waitFor(() => {
      expect(container.querySelector('[aria-label="Disable Mail"]')).not.toBeNull();
    });
    await clickSwitch("Disable Mail");
    await clickDialogButton("Cancel");

    await waitFor(() => {
      expect(document.querySelector('[role="alertdialog"]')).toBeNull();
    });
    // The modal blanks body pointer events while open; a dismissed dialog that
    // fails to restore them leaves the whole console unclickable.
    expect(document.body.style.pointerEvents).not.toBe("none");
    expect(toggleCallFor("mail")).toBeUndefined();
    expect(
      container.querySelector('[aria-label="Disable Mail"]')?.getAttribute("aria-checked"),
    ).toBe("true");
  });

  /* Enabling is additive and instantly reversible from this same switch.
   * Confirming it would be friction that teaches operators to click through
   * dialogs — which is exactly what makes the disable dialog worth reading. */
  it("enables a core app in one click with no confirmation", async () => {
    mockToggleOf("chat");

    await renderManagement();

    await waitFor(() => {
      expect(container.querySelector('[aria-label="Enable Chat"]')).not.toBeNull();
    });
    await clickSwitch("Enable Chat");

    await waitFor(() => {
      const toggleCall = toggleCallFor("chat");
      expect(toggleCall).toBeDefined();
      expect(requestBodyOf(toggleCall)).toEqual({ enabled: true });
    });
    expect(document.querySelector('[role="alertdialog"]')).toBeNull();
  });

  /* Per-app consequence text, not one generic warning: the file already knows
   * Editors is the row where Drive survives the toggle. */
  it("states the app's own consequence in the blast radius", async () => {
    mockToggleOf("editors");

    await renderManagement();

    await waitFor(() => {
      expect(container.querySelector('[aria-label="Disable Editors"]')).not.toBeNull();
    });
    await clickSwitch("Disable Editors");

    expect(confirmDialog().textContent).toContain("Disable Editors");
    expect(blastRadiusText()).toBe(
      "Drive keeps storage, previews, download, and sharing, but nobody can open or create an editable Doc, Sheet, Slide, or PDF.",
    );
    expect(blastRadiusText()).not.toContain("cannot be undone");
  });

  it("shows an unavailable notice when the admin API denies access", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: "Missing required scope" }), {
        status: 403,
        headers: { "content-type": "application/json" },
      }),
    );

    await act(() => {
      root.render(
        createElement(
          QueryClientProvider,
          { client: queryClient },
          createElement(CoreAppsManagement),
        ),
      );
      return Promise.resolve();
    });

    await waitFor(() => {
      expect(container.textContent ?? "").toContain("unavailable");
    });
  });

  async function renderManagement() {
    await act(() => {
      root.render(
        createElement(
          QueryClientProvider,
          { client: queryClient },
          createElement(CoreAppsManagement),
        ),
      );
      return Promise.resolve();
    });
  }

  function mockToggleOf(appId: string) {
    fetchMock.mockImplementation((input) => {
      const url = requestUrlOf(input);
      if (url.includes(`/api/admin/core-apps/${appId}`)) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              role: "all",
              apps: adminStatus.apps,
              changed: { appId, from: true, to: false, requiresRestart: true },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
        );
      }
      return Promise.resolve(
        new Response(JSON.stringify(adminStatus), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    });
  }

  function toggleCallFor(appId: string) {
    return fetchMock.mock.calls.find((call) =>
      requestUrlOf(call[0]).includes(`/api/admin/core-apps/${appId}`),
    );
  }

  async function clickSwitch(label: string) {
    const control = container.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`);
    if (control === null) {
      throw new Error(`Switch not found: ${label}`);
    }
    await act(async () => {
      control.click();
      await Promise.resolve();
    });
  }

  // The dialog is portaled to document.body, not into the section's container.
  function confirmDialog(): HTMLElement {
    const dialog = document.querySelector('[role="alertdialog"]');
    if (!(dialog instanceof HTMLElement)) {
      throw new Error("Confirmation dialog not found.");
    }
    return dialog;
  }

  function blastRadiusText(): string {
    return confirmDialog().querySelector(".admin-confirm-blast")?.textContent ?? "";
  }

  async function clickDialogButton(label: string) {
    const button = [...confirmDialog().querySelectorAll("button")].find(
      (candidate) => candidate.textContent?.trim() === label,
    );
    if (button === undefined) {
      throw new Error(`Dialog button not found: ${label}`);
    }
    await act(async () => {
      button.click();
      await Promise.resolve();
    });
  }
});

function requestBodyOf(call: Parameters<typeof fetch> | undefined): unknown {
  const body = call?.[1]?.body;
  if (typeof body !== "string") {
    throw new Error("Expected a string request body.");
  }
  return JSON.parse(body);
}

function requestUrlOf(input: unknown): string {
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof URL) {
    return input.toString();
  }
  if (input instanceof Request) {
    return input.url;
  }
  return "";
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
