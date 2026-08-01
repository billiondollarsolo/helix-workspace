// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MailAdminSection } from "./mail-admin";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const providersPayload = {
  providers: [
    {
      id: "p-ses",
      name: "Primary SES",
      kind: "ses",
      isDefault: true,
      enabled: true,
      config: { apiKeyRef: "env:SES_KEY", region: "us-east-1" },
    },
    {
      id: "p-mg",
      name: "Backup Mailgun",
      kind: "mailgun",
      isDefault: false,
      enabled: true,
      config: { apiKeyRef: "env:MG_KEY", domain: "mg.helix.io" },
    },
  ],
};

const domainsPayload = {
  domains: [
    {
      id: "d-1",
      domain: "mail.helix.io",
      spf: "verified",
      dkim: "pending",
      dmarc: "verified",
      dkimKeys: [{ id: "k-1", selector: "helix2026", status: "active" }],
    },
  ],
};

const dmarcPayload = {
  summary: {
    dmarcPassRate: 0.982,
    spfPassRate: 0.95,
    dkimPassRate: 0.99,
    messagesEvaluated: 12000,
    windowDays: 7,
  },
  reports: [
    {
      id: "r-1",
      reporter: "google.com",
      domain: "helix.io",
      rangeStart: "2026-05-14",
      rangeEnd: "2026-05-15",
      total: 500,
      passCount: 492,
      failCount: 8,
    },
  ],
};

interface ApiRoutingRule {
  readonly id: string;
  readonly matchPattern: string;
  readonly action: string;
  readonly destination: string;
  readonly enabled: boolean;
  readonly priority: number;
}

function routingRule(overrides: Partial<ApiRoutingRule> = {}): ApiRoutingRule {
  return {
    id: "rule-1",
    matchPattern: "*@support.helix.io",
    action: "mailbox",
    destination: "support-team",
    enabled: true,
    priority: 10,
    ...overrides,
  };
}

const routingPayload = { rules: [routingRule()] };

const spamPayload = {
  enabled: true,
  threshold: 5,
  rejectThreshold: 12,
  daemonStatus: "running",
  rulesetVersion: "2026.05",
  taggedLast24h: 47,
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
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

interface PayloadOverrides {
  readonly providers?: unknown;
  readonly domains?: unknown;
  readonly dmarc?: unknown;
  readonly routing?: unknown;
  readonly spam?: unknown;
}

/** Route fetch mock by URL substring. */
function routedFetch(overrides: PayloadOverrides = {}): ReturnType<typeof vi.fn<typeof fetch>> {
  return vi.fn<typeof fetch>((input) => {
    const url = requestUrlOf(input);
    if (url.includes("/api/admin/mail/providers")) {
      return Promise.resolve(jsonResponse(overrides.providers ?? providersPayload));
    }
    if (url.includes("/api/admin/mail/sending-domains")) {
      return Promise.resolve(jsonResponse(overrides.domains ?? domainsPayload));
    }
    if (url.includes("/api/admin/mail/dmarc")) {
      return Promise.resolve(jsonResponse(overrides.dmarc ?? dmarcPayload));
    }
    if (url.includes("/api/admin/mail/routing-rules")) {
      return Promise.resolve(jsonResponse(overrides.routing ?? routingPayload));
    }
    if (url.includes("/api/admin/mail/spam")) {
      return Promise.resolve(jsonResponse(overrides.spam ?? spamPayload));
    }
    return Promise.resolve(jsonResponse({ error: "not found" }, 404));
  });
}

describe("MailAdminSection", () => {
  let container: HTMLDivElement;
  let root: Root;
  let queryClient: QueryClient;

  function render(node: ReactNode): Promise<void> {
    return act(() => {
      root.render(createElement(QueryClientProvider, { client: queryClient }, node));
      return Promise.resolve();
    });
  }

  function buttonsLabelled(label: string): readonly HTMLButtonElement[] {
    return [...container.querySelectorAll("button")].filter(
      (element) => element.textContent?.trim() === label,
    );
  }

  function clickButton(label: string): Promise<void> {
    const [button] = buttonsLabelled(label);
    if (!button) {
      throw new Error(`Button "${label}" not found`);
    }
    return act(() => {
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      return Promise.resolve();
    });
  }

  function clickElement(element: Element | null | undefined): Promise<void> {
    if (!element) {
      throw new Error("Element to click not found");
    }
    return act(() => {
      /* `.click()` rather than a hand-built MouseEvent: the confirmation
         dialog's action button calls `preventDefault()` to stay open until the
         mutation settles, and a non-cancelable event would skip that path. */
      if (element instanceof HTMLElement) {
        element.click();
      } else {
        element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      }
      return Promise.resolve();
    });
  }

  function activeTabLabel(): string {
    return container.querySelector('[role="tab"][aria-selected="true"]')?.textContent?.trim() ?? "";
  }

  /** The confirmation dialog renders through a portal, so it is never inside
   *  `container`. */
  function dialog(): HTMLElement | null {
    return document.body.querySelector<HTMLElement>('[data-slot="alert-dialog-content"]');
  }

  function dialogText(): string {
    return dialog()?.textContent ?? "";
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

  function labelled(label: string): HTMLButtonElement {
    const match = [...container.querySelectorAll("button")].find(
      (element) => element.getAttribute("aria-label") === label,
    );
    if (!match) {
      throw new Error(`Button "${label}" not found`);
    }
    return match;
  }

  /** Requests the view actually sent with the given method. */
  function callsWithMethod(
    fetchMock: ReturnType<typeof routedFetch>,
    method: string,
  ): readonly string[] {
    return fetchMock.mock.calls
      .filter((call) => call[1]?.method === method)
      .map((call) => requestUrlOf(call[0]));
  }

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: { getItem: vi.fn(() => null), removeItem: vi.fn(), setItem: vi.fn() },
    });
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

  it("renders outbound providers from the admin API by default", async () => {
    const fetchMock = routedFetch();
    vi.stubGlobal("fetch", fetchMock);

    await render(createElement(MailAdminSection));

    await waitFor(() => {
      expect(container.textContent).toContain("Primary SES");
    });
    expect(container.textContent).toContain("Outbound providers");
    expect(container.textContent).toContain("Backup Mailgun");
    expect(container.textContent).toContain("Default");
    /* The default provider states itself with a chip; a disabled "Set default"
       button on the same row would be a control that can never do anything. */
    expect(container.querySelector('[aria-label="Make Primary SES default"]')).toBeNull();
    expect(container.querySelector('[aria-label="Make Backup Mailgun default"]')).not.toBeNull();
    expect(
      fetchMock.mock.calls.some((call) =>
        requestUrlOf(call[0]).includes("/api/admin/mail/providers"),
      ),
    ).toBe(true);
  });

  it("posts a new provider with kind-specific config", async () => {
    const fetchMock = routedFetch();
    vi.stubGlobal("fetch", fetchMock);

    await render(createElement(MailAdminSection));
    await waitFor(() => {
      expect(container.textContent).toContain("Primary SES");
    });

    await clickButton("Add provider");

    const nameInput = container.querySelector<HTMLInputElement>(
      'input[aria-label="Provider name"]',
    );
    if (!nameInput) {
      throw new Error("Provider name input not found");
    }
    await act(() => {
      setInputValue(nameInput, "New SES");
      return Promise.resolve();
    });

    const submit = [...container.querySelectorAll("button")].find(
      (element) => element.textContent?.trim() === "Add provider" && element.type === "submit",
    );
    await act(() => {
      submit?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      return Promise.resolve();
    });

    await waitFor(() => {
      const post = fetchMock.mock.calls.find(
        (call) =>
          requestUrlOf(call[0]).includes("/api/admin/mail/providers") && call[1]?.method === "POST",
      );
      expect(post).toBeDefined();
    });
  });

  it("shows the DMARC deliverability summary with pass rates", async () => {
    vi.stubGlobal("fetch", routedFetch());

    await render(createElement(MailAdminSection));
    await clickButton("Deliverability");

    await waitFor(() => {
      expect(container.textContent).toContain("DMARC pass rate");
    });
    expect(container.textContent).toContain("98.2%");
    expect(container.textContent).toContain("google.com");
  });

  /* This test used to assert that the first click on the trash glyph sent the
     DELETE. That assertion encoded the bug it was guarding: a deleted rule's
     pattern, action and destination exist nowhere else in this console, so the
     one-click path was unrecoverable by design. The behaviour changed and the
     assertion changed with it — the click now opens the confirmation, and the
     DELETE is asserted on the confirm. */
  it("lists routing rules and deletes one only after the confirmation", async () => {
    const fetchMock = routedFetch();
    vi.stubGlobal("fetch", fetchMock);

    await render(createElement(MailAdminSection));
    await clickButton("Routing rules");

    await waitFor(() => {
      expect(container.textContent).toContain("*@support.helix.io");
    });

    const del = labelled("Delete rule *@support.helix.io");
    // Was styled identically to the reversible "Disable" toggle beside it.
    expect(del.dataset.variant).toBe("destructive");
    expect(labelled("Disable rule *@support.helix.io").dataset.variant).toBe("outline");

    await clickElement(del);
    expect(callsWithMethod(fetchMock, "DELETE")).toEqual([]);
    expect(dialogText()).toContain("Delete routing rule");

    await clickElement(dialogButton("action"));

    await waitFor(() => {
      expect(callsWithMethod(fetchMock, "DELETE")).toEqual([
        "/api/admin/mail/routing-rules/rule-1",
      ]);
    });
    await waitFor(() => {
      expect(dialog()).toBeNull();
    });
  });

  it("shows the routing rule's own pattern, action and destination before deleting it", async () => {
    const fetchMock = routedFetch();
    vi.stubGlobal("fetch", fetchMock);

    await render(createElement(MailAdminSection));
    await clickButton("Routing rules");
    await waitFor(() => {
      expect(container.textContent).toContain("*@support.helix.io");
    });

    await clickElement(labelled("Delete rule *@support.helix.io"));

    // The three values an operator would have to retype, and the priority.
    expect(dialogText()).toContain("*@support.helix.io");
    expect(dialogText()).toContain("Deliver to mailbox");
    expect(dialogText()).toContain("support-team");
    expect(dialogText()).toContain("Deleting priority 10");
    /* Re-creating a rule is the form at the top of this view, so it is the
       named-target tier, not the typed-phrase tier. */
    expect(document.body.querySelector(".admin-confirm-phrase")).toBeNull();
    expect(dialogButton("action").disabled).toBe(false);
  });

  it("says an active routing rule is carrying mail and a disabled one is not", async () => {
    vi.stubGlobal("fetch", routedFetch());

    await render(createElement(MailAdminSection));
    await clickButton("Routing rules");
    await waitFor(() => {
      expect(container.textContent).toContain("*@support.helix.io");
    });

    await clickElement(labelled("Delete rule *@support.helix.io"));
    expect(dialogText()).toContain("This rule is active");
    expect(dialogText()).toContain("falls through");
    await clickElement(dialogButton("cancel"));
    await waitFor(() => {
      expect(dialog()).toBeNull();
    });
  });

  it("does not claim mail stops for a routing rule that is switched off", async () => {
    const fetchMock = routedFetch({
      routing: { rules: [routingRule({ enabled: false })] },
    });
    vi.stubGlobal("fetch", fetchMock);

    await render(createElement(MailAdminSection));
    await clickButton("Routing rules");
    await waitFor(() => {
      expect(container.textContent).toContain("*@support.helix.io");
    });

    await clickElement(labelled("Delete rule *@support.helix.io"));

    /* The signature bug this guards: asserting a consequence the workspace is
       not exposed to, because the copy ignored the rule's reported state. */
    expect(dialogText()).not.toContain("This rule is active");
    expect(dialogText()).toContain("no inbound mail is being routed by it right now");
  });

  it("cancelling the routing rule dialog leaves the rule in place", async () => {
    const fetchMock = routedFetch();
    vi.stubGlobal("fetch", fetchMock);

    await render(createElement(MailAdminSection));
    await clickButton("Routing rules");
    await waitFor(() => {
      expect(container.textContent).toContain("*@support.helix.io");
    });

    await clickElement(labelled("Delete rule *@support.helix.io"));
    await clickElement(dialogButton("cancel"));

    await waitFor(() => {
      expect(dialog()).toBeNull();
    });
    expect(callsWithMethod(fetchMock, "DELETE")).toEqual([]);
  });

  it("shows spam filtering thresholds and daemon status", async () => {
    vi.stubGlobal("fetch", routedFetch());

    await render(createElement(MailAdminSection));
    await clickButton("Spam filtering");

    await waitFor(() => {
      expect(container.textContent).toContain("spamd daemon");
    });
    expect(container.textContent).toContain("Spam threshold");
    expect(container.textContent).toContain("running");
    expect(container.textContent).toContain("Reject threshold");
  });

  it("shows an unavailable notice when the providers API denies access", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(() =>
        Promise.resolve(jsonResponse({ error: "Missing required scope" }, 403)),
      ),
    );

    await render(createElement(MailAdminSection));

    await waitFor(() => {
      expect(container.textContent).toContain("unavailable");
    });
  });

  it("gives a failed query the shared failure banner with a working retry", async () => {
    const fetchMock = vi.fn<typeof fetch>(() =>
      Promise.resolve(jsonResponse({ error: "Missing required scope" }, 403)),
    );
    vi.stubGlobal("fetch", fetchMock);

    await render(createElement(MailAdminSection));

    await waitFor(() => {
      expect(container.textContent).toContain("Outbound providers are unavailable");
    });
    /* The raw server message is the only thing an operator can quote to
       support — the old dead-end banner threw it away. */
    expect(container.textContent).toContain("Missing required scope");

    const callsBeforeRetry = fetchMock.mock.calls.length;
    const retry = [...container.querySelectorAll("button")].find((element) =>
      element.textContent?.includes("Retry"),
    );
    expect(retry).toBeDefined();
    await clickElement(retry);

    await waitFor(() => {
      expect(fetchMock.mock.calls.length).toBeGreaterThan(callsBeforeRetry);
    });
  });

  it("titles the page Mail once and steps sub-views down to h2", async () => {
    vi.stubGlobal("fetch", routedFetch());

    await render(createElement(MailAdminSection));
    await waitFor(() => {
      expect(container.textContent).toContain("Primary SES");
    });

    const headings = [...container.querySelectorAll("h1")];
    expect(headings).toHaveLength(1);
    expect(headings[0]?.textContent).toBe("Mail");
    expect(container.querySelector("h2")?.textContent).toBe("Outbound providers");

    await clickButton("Routing rules");
    expect([...container.querySelectorAll("h1")]).toHaveLength(1);
    expect(container.querySelector("h1")?.textContent).toBe("Mail");
    expect(container.querySelector("h2")?.textContent).toBe("Routing rules");
  });

  it("wires the sub-view tabs to their panel and moves selection with arrow keys", async () => {
    vi.stubGlobal("fetch", routedFetch());

    await render(createElement(MailAdminSection));

    const tablist = container.querySelector('[role="tablist"]');
    expect(tablist?.getAttribute("aria-label")).toBe("Mail admin views");
    expect(activeTabLabel()).toBe("Outbound providers");

    const selected = container.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]');
    const panel = container.querySelector<HTMLElement>('[role="tabpanel"]');
    expect(panel?.getAttribute("aria-labelledby")).toBe(selected?.id);
    expect(selected?.getAttribute("aria-controls")).toBe(panel?.id);
    /* Roving tabindex: only the selected tab is a tab stop. */
    expect(
      [...container.querySelectorAll('[role="tab"]')].filter(
        (tab) => tab.getAttribute("tabindex") === "0",
      ),
    ).toHaveLength(1);

    await act(() => {
      selected?.dispatchEvent(
        new window.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
      );
      return Promise.resolve();
    });
    expect(activeTabLabel()).toBe("Deliverability");

    await act(() => {
      container
        .querySelector('[role="tab"][aria-selected="true"]')
        ?.dispatchEvent(new window.KeyboardEvent("keydown", { key: "End", bubbles: true }));
      return Promise.resolve();
    });
    expect(activeTabLabel()).toBe("Spam filtering");
  });

  it("explains an empty routing view instead of showing bare grey text", async () => {
    vi.stubGlobal("fetch", routedFetch({ routing: { rules: [] } }));

    await render(createElement(MailAdminSection));
    await clickButton("Routing rules");

    await waitFor(() => {
      expect(container.textContent).toContain("No inbound routing rules");
    });
    expect(container.textContent).toContain("deliver to a mailbox");
    expect(container.textContent).toContain("ascending priority order");
    /* The empty state owns the only call to action, so the sub-view header
       does not repeat it. */
    expect(buttonsLabelled("Add rule")).toHaveLength(1);

    await clickButton("Add rule");
    expect(container.querySelector('input[aria-label="Match pattern"]')).not.toBeNull();
  });

  it("explains an empty providers view and opens the form from it", async () => {
    vi.stubGlobal("fetch", routedFetch({ providers: { providers: [] } }));

    await render(createElement(MailAdminSection));

    await waitFor(() => {
      expect(container.textContent).toContain("No outbound providers");
    });
    expect(container.textContent).toContain("Amazon SES");
    expect(buttonsLabelled("Add provider")).toHaveLength(1);

    await clickButton("Add provider");
    expect(container.querySelector('input[aria-label="Provider name"]')).not.toBeNull();
  });

  it("keeps DMARC pass rates in front and the per-reporter rows behind a disclosure", async () => {
    vi.stubGlobal("fetch", routedFetch());

    await render(createElement(MailAdminSection));
    await clickButton("Deliverability");

    await waitFor(() => {
      expect(container.textContent).toContain("DMARC pass rate");
    });
    const summary = container.querySelector("details > summary");
    expect(summary?.textContent).toContain("Per-reporter aggregate reports (1)");
    expect(container.querySelector("details")?.open).toBe(false);
  });

  it("says a missing spam value is unknown rather than inventing one", async () => {
    vi.stubGlobal(
      "fetch",
      routedFetch({
        spam: {
          enabled: true,
          threshold: 5,
          rejectThreshold: null,
          daemonStatus: "unknown",
          rulesetVersion: null,
          taggedLast24h: null,
        },
      }),
    );

    await render(createElement(MailAdminSection));
    await clickButton("Spam filtering");

    await waitFor(() => {
      expect(container.textContent).toContain("spamd daemon");
    });
    expect(container.textContent).toContain("Ruleset Unknown");
    /* Reject threshold, ruleset version and the tagged counter are all absent
       from this payload; each has to read as unknown, not as a dash or a zero. */
    expect(container.textContent?.match(/Unknown/g)?.length ?? 0).toBeGreaterThanOrEqual(3);
    const summary = container.querySelector("details > summary");
    expect(summary?.textContent).toContain("reject threshold");
  });
});

/** Set a React-controlled input value via the native setter. */
function setInputValue(input: HTMLInputElement, value: string): void {
  Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set?.call(
    input,
    value,
  );
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

async function waitFor(assertion: () => void, timeout = 2000): Promise<void> {
  const startedAt = Date.now();
  let lastError: unknown;
  while (Date.now() - startedAt < timeout) {
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
