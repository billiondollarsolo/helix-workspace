// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  adminMailConfigurationQueryOptions,
  MailConfiguration,
  prefetchAdminMailConfigurationQuery,
  type AdminMailConfigurationResponse,
} from "./mail-configuration";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

describe("MailConfiguration admin UI", () => {
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
        mutations: { retry: false },
        queries: { retry: false },
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

  it("renders inbound, outbound, DNS, quota, and delivery health values", async () => {
    fetchMock.mockResolvedValue(Response.json(mailConfiguration()));

    renderMailConfiguration();
    await waitForText("mail-in.helix.test:2525");

    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/admin/mail/config");
    expect(container.textContent).toContain("mail-in.helix.test:2525");
    expect(container.textContent).toContain("SES");
    expect(container.textContent).toContain("email-smtp.us-east-1.amazonaws.com:587");
    expect(container.textContent).toContain("example.com");
    expect(container.textContent).toContain("10 MB");
    expect(container.textContent).toContain("SMTP receiver bound to runtime config.");
    expect(container.textContent).toContain("Transient SES throttle");

    const table = tableByLabel("Mail DNS records");
    const headers = Array.from(table.querySelectorAll('[role="columnheader"]')).map(
      (header) => header.textContent,
    );
    expect(headers).toEqual(["Domain", "Record", "Status", "Expected", "Evidence"]);
    expect(table.textContent).toContain("example.com (default)");
    expect(table.textContent).toContain("MX");
    expect(table.textContent).toContain("mx1.helix.test");
    expect(table.textContent).toContain("DMARC policy present.");
    expect(alertMock).not.toHaveBeenCalled();
    expect(confirmMock).not.toHaveBeenCalled();
    expect(promptMock).not.toHaveBeenCalled();
  });

  it("surfaces malformed config API responses without native dialogs", async () => {
    fetchMock.mockResolvedValue(Response.json({ generatedAt: "2026-05-21T13:00:00.000Z" }));

    renderMailConfiguration();

    await waitForText(
      "Mail configuration is unavailable or missing admin mail configuration scope.",
    );
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      "Mail configuration is unavailable or missing admin mail configuration scope.",
    );
    expect(container.textContent).toContain("No mail DNS records reported.");
    expect(alertMock).not.toHaveBeenCalled();
    expect(confirmMock).not.toHaveBeenCalled();
    expect(promptMock).not.toHaveBeenCalled();
  });

  it("handles mail config API errors without native dialogs", async () => {
    fetchMock.mockResolvedValue(Response.json({ error: "denied" }, { status: 403 }));

    renderMailConfiguration();

    await waitForText(
      "Mail configuration is unavailable or missing admin mail configuration scope.",
    );
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/admin/mail/config");
    expect(alertMock).not.toHaveBeenCalled();
    expect(confirmMock).not.toHaveBeenCalled();
    expect(promptMock).not.toHaveBeenCalled();
  });

  it("prefetches the mail configuration query with contained errors", async () => {
    const ensureQueryData = vi
      .fn<(options: ReturnType<typeof adminMailConfigurationQueryOptions>) => Promise<unknown>>()
      .mockRejectedValue(new Error("mail unavailable"));

    await expect(prefetchAdminMailConfigurationQuery({ ensureQueryData })).resolves.toBeUndefined();

    expect(ensureQueryData).toHaveBeenCalledTimes(1);
  });

  function renderMailConfiguration() {
    act(() => {
      root.render(
        createElement(
          QueryClientProvider,
          { client: queryClient },
          createElement(MailConfiguration),
        ),
      );
    });
  }

  function tableByLabel(label: string): HTMLElement {
    const table = container.querySelector(`[role="table"][aria-label="${label}"]`);
    if (!(table instanceof HTMLElement)) {
      throw new Error(`Table not found: ${label}`);
    }
    return table;
  }

  async function waitForText(text: string) {
    await waitFor(() => expect(container.textContent).toContain(text));
  }

  async function waitFor(assertion: () => void | Promise<void>) {
    let lastError: unknown;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      try {
        await act(async () => {
          await Promise.resolve();
        });
        await assertion();
        return;
      } catch (error) {
        lastError = error;
        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 10));
        });
      }
    }
    throw lastError;
  }
});

function mailConfiguration(): AdminMailConfigurationResponse {
  return {
    deliveryHealth: {
      counts: {
        cancelled: 1,
        failed: 2,
        queued: 3,
        sending: 1,
        sent: 42,
      },
      failedLast24h: 1,
      lastError: "Transient SES throttle",
      lastFailureAt: "2026-05-21T12:00:00.000Z",
      since: "2026-05-20T13:00:00.000Z",
    },
    domains: [
      {
        defaultFrom: true,
        domain: "example.com",
        records: [
          {
            evidence: "MX record points at inbound receiver.",
            expected: "mx1.helix.test",
            status: "ready",
            type: "MX",
          },
          {
            evidence: "SPF includes outbound relay.",
            expected: "v=spf1 include:amazonses.com -all",
            status: "configured",
            type: "SPF",
          },
          {
            evidence: "DKIM selector present.",
            status: "ready",
            type: "DKIM",
          },
          {
            evidence: "DMARC policy present.",
            status: "ready",
            type: "DMARC",
          },
        ],
      },
    ],
    generatedAt: "2026-05-21T13:00:00.000Z",
    inboundReceiver: {
      enabled: true,
      evidence: "SMTP receiver bound to runtime config.",
      host: "mail-in.helix.test",
      orgId: "org_123",
      port: 2525,
      status: "ready",
    },
    outboundRelay: {
      authConfigured: true,
      configured: true,
      evidence: "SES credentials loaded from runtime secrets.",
      host: "email-smtp.us-east-1.amazonaws.com",
      port: 587,
      provider: "ses",
      secure: true,
      status: "configured",
    },
    quotas: {
      evidence: "Runtime quota config loaded.",
      maxMessageBytes: 10_485_760,
      perActorPerDay: 1000,
      perActorPerHour: 100,
    },
  };
}
