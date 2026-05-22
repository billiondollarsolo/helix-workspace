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

const routingPayload = {
  rules: [
    {
      id: "rule-1",
      matchPattern: "*@support.helix.io",
      action: "mailbox",
      destination: "support-team",
      enabled: true,
      priority: 10,
    },
  ],
};

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

/** Route fetch mock by URL substring. */
function routedFetch(): ReturnType<typeof vi.fn<typeof fetch>> {
  return vi.fn<typeof fetch>((input) => {
    const url = requestUrlOf(input);
    if (url.includes("/api/admin/mail/providers")) {
      return Promise.resolve(jsonResponse(providersPayload));
    }
    if (url.includes("/api/admin/mail/sending-domains")) {
      return Promise.resolve(jsonResponse(domainsPayload));
    }
    if (url.includes("/api/admin/mail/dmarc")) {
      return Promise.resolve(jsonResponse(dmarcPayload));
    }
    if (url.includes("/api/admin/mail/routing-rules")) {
      return Promise.resolve(jsonResponse(routingPayload));
    }
    if (url.includes("/api/admin/mail/spam")) {
      return Promise.resolve(jsonResponse(spamPayload));
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
      root.render(
        createElement(QueryClientProvider, { client: queryClient }, node),
      );
      return Promise.resolve();
    });
  }

  function clickButton(label: string): Promise<void> {
    const button = [...container.querySelectorAll("button")].find(
      (element) => element.textContent?.trim() === label,
    );
    if (!button) {
      throw new Error(`Button "${label}" not found`);
    }
    return act(() => {
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
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
          requestUrlOf(call[0]).includes("/api/admin/mail/providers") &&
          call[1]?.method === "POST",
      );
      expect(post).toBeDefined();
    });
  });

  it("navigates to sending domains and shows DKIM keys and verification badges", async () => {
    vi.stubGlobal("fetch", routedFetch());

    await render(createElement(MailAdminSection));
    await clickButton("Sending domains");

    await waitFor(() => {
      expect(container.textContent).toContain("mail.helix.io");
    });
    expect(container.textContent).toContain("helix2026");
    expect(container.textContent).toContain("active");
    expect(container.querySelector('[title="DKIM: pending"]')).not.toBeNull();
  });

  it("generates a DKIM key via the API", async () => {
    const fetchMock = routedFetch();
    vi.stubGlobal("fetch", fetchMock);

    await render(createElement(MailAdminSection));
    await clickButton("Sending domains");
    await waitFor(() => {
      expect(container.textContent).toContain("mail.helix.io");
    });

    const generate = container.querySelector<HTMLButtonElement>(
      '[aria-label="Generate DKIM key for mail.helix.io"]',
    );
    await act(() => {
      generate?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      return Promise.resolve();
    });

    await waitFor(() => {
      const post = fetchMock.mock.calls.find(
        (call) =>
          requestUrlOf(call[0]).includes("/dkim") && call[1]?.method === "POST",
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

  it("lists routing rules and deletes one via the API", async () => {
    const fetchMock = routedFetch();
    vi.stubGlobal("fetch", fetchMock);

    await render(createElement(MailAdminSection));
    await clickButton("Routing rules");

    await waitFor(() => {
      expect(container.textContent).toContain("*@support.helix.io");
    });

    const del = container.querySelector<HTMLButtonElement>(
      '[aria-label="Delete rule *@support.helix.io"]',
    );
    await act(() => {
      del?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      return Promise.resolve();
    });

    await waitFor(() => {
      const deleteCall = fetchMock.mock.calls.find(
        (call) =>
          requestUrlOf(call[0]).includes("/api/admin/mail/routing-rules/") &&
          call[1]?.method === "DELETE",
      );
      expect(deleteCall).toBeDefined();
    });
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
});

/** Set a React-controlled input value via the native setter. */
function setInputValue(input: HTMLInputElement, value: string): void {
  Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "value",
  )?.set?.call(input, value);
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
