// @vitest-environment jsdom

/* Admin › Apps & integrations › OAuth apps — the destructive-action contract.
 *
 * `admin-console.test.tsx` covers this section's place in the console shell.
 * These cover what the console's destructive-action policy asks of Revoke:
 * revoking kills every user's token, so it must not fire on one click, its
 * confirmation must name the app and the real number of token holders, and it
 * must not look like the reversible Approve beside it. */

import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AdminApps } from "@/features/admin/sections/oauth-apps";

interface ApiOAuthApp {
  readonly id: string;
  readonly orgId: string;
  readonly name: string;
  readonly clientId: string | null;
  readonly publisher: string;
  readonly scopes: readonly string[];
  readonly scopeSummary: string;
  readonly risk: "low" | "medium" | "high";
  readonly status: "approved" | "pending" | "blocked" | "revoked";
  readonly userCount: number;
  readonly firstAuthorizedAt: string | null;
  readonly lastAuthorizedAt: string | null;
  readonly reviewedBy: string | null;
  readonly reviewedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

function apiApp(overrides: Partial<ApiOAuthApp> = {}): ApiOAuthApp {
  return {
    id: "app-1",
    orgId: "org-1",
    name: "Acme Sync",
    clientId: "acme-sync",
    publisher: "Acme",
    scopes: ["mail.read"],
    scopeSummary: "Read mail",
    risk: "high",
    status: "approved",
    userCount: 37,
    firstAuthorizedAt: null,
    lastAuthorizedAt: null,
    reviewedBy: null,
    reviewedAt: null,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

describe("AdminApps — revoking an OAuth app", () => {
  let container: HTMLDivElement;
  let root: Root;
  let queryClient: QueryClient;
  let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;

  function requestUrl(input: RequestInfo | URL): string {
    if (typeof input === "string") {
      return input;
    }
    return input instanceof URL ? input.toString() : input.url;
  }

  function mockApps(apps: readonly ApiOAuthApp[]) {
    fetchMock.mockImplementation((input: RequestInfo | URL) => {
      const url = requestUrl(input);
      if (url.includes("/revoke")) {
        return Promise.resolve(Response.json({ app: apiApp({ status: "revoked" }) }));
      }
      return Promise.resolve(Response.json({ apps, nextCursor: null }));
    });
  }

  /** Calls the section actually sent to the revoke endpoint. */
  function revokeCalls(): readonly string[] {
    return fetchMock.mock.calls
      .map(([input]) => requestUrl(input))
      .filter((url) => url.includes("/revoke"));
  }

  /** Polls with real timers — react-query settles over several ticks, so a
   *  fixed number of microtask flushes is racy. */
  async function waitFor(assertion: () => void, timeout = 1000): Promise<void> {
    const start = Date.now();
    let lastError: unknown;
    while (Date.now() - start <= timeout) {
      try {
        assertion();
        return;
      } catch (error) {
        lastError = error;
      }
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
      });
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  async function renderWith(apps: readonly ApiOAuthApp[]): Promise<void> {
    mockApps(apps);
    await act(() => {
      root.render(
        createElement(
          QueryClientProvider,
          { client: queryClient },
          createElement(AdminApps) as ReactNode,
        ),
      );
      return Promise.resolve();
    });
    await waitFor(() => {
      expect(container.textContent ?? "").toContain(apps[0]?.name ?? "");
    });
  }

  /** The dialog renders through a portal, so it is never inside `container`. */
  function dialog(): HTMLElement | null {
    return document.body.querySelector<HTMLElement>('[data-slot="alert-dialog-content"]');
  }

  function dialogText(): string {
    return dialog()?.textContent ?? "";
  }

  function rowButton(label: string): HTMLButtonElement {
    const match = [...container.querySelectorAll("button")].find(
      (element) => element.getAttribute("aria-label") === label,
    );
    if (!match) {
      const labels = [...container.querySelectorAll("button")].map((element) =>
        element.getAttribute("aria-label"),
      );
      throw new Error(`Button "${label}" not found. Buttons: ${labels.join(" | ")}`);
    }
    return match;
  }

  function dialogButton(slot: "action" | "cancel"): HTMLButtonElement {
    const match = document.body.querySelector<HTMLButtonElement>(
      `[data-slot="alert-dialog-${slot}"]`,
    );
    if (!match) {
      throw new Error(`Dialog ${slot} button not found`);
    }
    return match;
  }

  function click(element: HTMLElement): Promise<void> {
    return act(() => {
      element.click();
      return Promise.resolve();
    });
  }

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    queryClient.clear();
    container.remove();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("does not revoke on the first click — it asks, naming the app", async () => {
    await renderWith([apiApp()]);

    await click(rowButton("Revoke Acme Sync"));

    // The regression this guards: `revokeMutation.mutate(...)` straight off the
    // button, killing every token before the operator saw a word about it.
    expect(revokeCalls()).toEqual([]);
    expect(dialog()).not.toBeNull();
    expect(dialogText()).toContain("Revoke OAuth app");
    expect(dialogText()).toContain("Acme Sync");
  });

  it("states the real token-holder count from the API, not a generic warning", async () => {
    await renderWith([apiApp({ userCount: 37 })]);

    await click(rowButton("Revoke Acme Sync"));

    expect(dialogText()).toContain("37 users currently hold tokens for this app");
  });

  it("reports zero token holders as zero rather than inventing a number", async () => {
    await renderWith([apiApp({ userCount: 0 })]);

    await click(rowButton("Revoke Acme Sync"));

    expect(dialogText()).toContain("No user currently holds a token for this app");
    expect(dialogText()).not.toMatch(/\d+ users? currently hold/u);
  });

  it("uses the singular for a single token holder", async () => {
    await renderWith([apiApp({ userCount: 1 })]);

    await click(rowButton("Revoke Acme Sync"));

    expect(dialogText()).toContain("1 user currently holds a token for this app");
  });

  it("revokes only after the operator confirms, and closes the dialog", async () => {
    await renderWith([apiApp({ id: "app-42" })]);

    await click(rowButton("Revoke Acme Sync"));
    await click(dialogButton("action"));

    await waitFor(() => {
      expect(revokeCalls()).toEqual(["/api/admin/oauth-apps/app-42/revoke"]);
    });
    await waitFor(() => {
      expect(dialog()).toBeNull();
    });
  });

  it("cancelling leaves every token in place", async () => {
    await renderWith([apiApp()]);

    await click(rowButton("Revoke Acme Sync"));
    await click(dialogButton("cancel"));

    await waitFor(() => {
      expect(dialog()).toBeNull();
    });
    expect(revokeCalls()).toEqual([]);
  });

  it("does not ask for a typed phrase — a revoked grant is re-authorizable", async () => {
    await renderWith([apiApp()]);

    await click(rowButton("Revoke Acme Sync"));

    // The policy reserves `confirmPhrase` for recoveries that need a support
    // ticket. Spending it here would train operators to type through dialogs.
    expect(document.body.querySelector(".admin-confirm-phrase")).toBeNull();
    expect(dialogButton("action").disabled).toBe(false);
  });

  it("does not render Revoke in the same style as the reversible actions", async () => {
    await renderWith([apiApp({ status: "pending" })]);

    expect(rowButton("Revoke Acme Sync").dataset.variant).toBe("destructive");
    expect(rowButton("Approve Acme Sync").dataset.variant).toBe("outline");
    expect(rowButton("Block Acme Sync").dataset.variant).toBe("outline");
  });
});
