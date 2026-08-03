// @vitest-environment jsdom

/* Admin › Organization › Domains — the destructive-action contract.
 *
 * `admin-console.test.tsx` covers this section's place in the console shell.
 * These cover what the console's destructive-action policy asks of domain
 * deletion: it is the top tier, so the operator types the hostname, and the
 * blast radius has to describe this domain — its real DNS record count, and a
 * mail consequence only where mail is actually flowing. */

import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AdminDomain } from "@/features/admin/sections/domains";

interface ApiDomain {
  readonly id: string;
  readonly orgId: string;
  readonly domain: string;
  readonly isPrimary: boolean;
  readonly verificationStatus: "verified" | "pending" | "failed";
  readonly verifiedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface ApiDnsRecord {
  readonly id: string;
  readonly orgId: string;
  readonly domainId: string;
  readonly recordType: "MX" | "SPF" | "DKIM" | "DMARC" | "TXT" | "CNAME" | "A";
  readonly host: string;
  readonly expectedValue: string;
  readonly observedValue: string | null;
  readonly status: "verified" | "pending" | "failed";
  readonly lastCheckedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

const TIMESTAMPS = {
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
} as const;

function apiDomain(overrides: Partial<ApiDomain> = {}): ApiDomain {
  return {
    id: "dom-1",
    orgId: "org-1",
    domain: "helix.io",
    isPrimary: false,
    verificationStatus: "verified",
    verifiedAt: "2026-01-01T00:00:00Z",
    ...TIMESTAMPS,
    ...overrides,
  };
}

function apiDnsRecord(id: string, overrides: Partial<ApiDnsRecord> = {}): ApiDnsRecord {
  return {
    id,
    orgId: "org-1",
    domainId: "dom-1",
    recordType: "MX",
    host: "helix.io",
    expectedValue: "10 mx1.helix.io",
    observedValue: null,
    status: "verified",
    lastCheckedAt: null,
    ...TIMESTAMPS,
    ...overrides,
  };
}

interface Entry {
  readonly domain: ApiDomain;
  readonly dnsRecords: readonly ApiDnsRecord[];
  /* Capabilities are required-nullable in the response schema, so a server
     that stops sending them fails the parse rather than rendering a domain
     that silently looks unused. Defaulted in `mockDomains`. */
  readonly sending?: {
    id: string;
    isDefault: boolean;
    verifiedAt: string | null;
    dkimKeyCount: number;
  } | null;
  readonly receiving?: {
    id: string;
    status: "pending" | "verified" | "active" | "disabled";
  } | null;
}

describe("AdminDomain — deleting a domain", () => {
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

  function mockDomains(domains: readonly Entry[]) {
    fetchMock.mockImplementation((_input: RequestInfo | URL, init?: RequestInit) => {
      if ((init?.method ?? "GET") === "DELETE") {
        return Promise.resolve(new Response(null, { status: 204 }));
      }
      return Promise.resolve(Response.json({ domains }));
    });
  }

  /** DELETE calls the section actually sent. */
  function deleteCalls(): readonly string[] {
    return fetchMock.mock.calls
      .filter(([, init]) => (init?.method ?? "GET") === "DELETE")
      .map(([input]) => requestUrl(input));
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

  async function renderWith(domains: readonly Entry[]): Promise<void> {
    mockDomains(
      domains.map((entry) => ({
        ...entry,
        sending: entry.sending ?? null,
        receiving: entry.receiving ?? null,
      })),
    );
    await act(() => {
      root.render(
        createElement(
          QueryClientProvider,
          { client: queryClient },
          createElement(AdminDomain) as ReactNode,
        ),
      );
      return Promise.resolve();
    });
    await waitFor(() => {
      expect(container.textContent ?? "").toContain(domains[0]?.domain.domain ?? "");
    });
  }

  /** The dialog renders through a portal, so it is never inside `container`. */
  function dialog(): HTMLElement | null {
    return document.body.querySelector<HTMLElement>('[data-slot="alert-dialog-content"]');
  }

  function dialogText(): string {
    return dialog()?.textContent ?? "";
  }

  function labelled(label: string): HTMLButtonElement {
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

  /* React tracks the last value it wrote to a control, so assigning `.value`
     directly is swallowed as a no-op change. The native prototype descriptor
     defeats that tracker. */
  function typePhrase(value: string): Promise<void> {
    const input = document.body.querySelector<HTMLInputElement>(".admin-confirm-phrase input");
    if (!input) {
      throw new Error("Confirmation phrase input not found");
    }
    return act(() => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set?.call(
        input,
        value,
      );
      input.dispatchEvent(new Event("input", { bubbles: true }));
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

  it("does not delete on the first click, and the control says what it does", async () => {
    await renderWith([{ domain: apiDomain(), dnsRecords: [apiDnsRecord("rec-1")] }]);

    const remove = labelled("Delete helix.io");
    // Was a bare trash glyph styled identically to "Make primary".
    expect(remove.textContent).toContain("Delete");
    expect(remove.dataset.variant).toBe("destructive");
    expect(labelled("Make helix.io primary").dataset.variant).toBe("outline");

    await click(remove);

    expect(deleteCalls()).toEqual([]);
    expect(dialogText()).toContain("Delete domain");
    expect(dialogText()).toContain("helix.io");
  });

  it("holds the confirm button until the operator types the hostname", async () => {
    await renderWith([{ domain: apiDomain(), dnsRecords: [] }]);

    await click(labelled("Delete helix.io"));
    expect(dialogButton("action").disabled).toBe(true);

    await typePhrase("helix.i");
    expect(dialogButton("action").disabled).toBe(true);

    await typePhrase("helix.io");
    expect(dialogButton("action").disabled).toBe(false);

    await click(dialogButton("action"));
    await waitFor(() => {
      expect(deleteCalls()).toEqual(["/api/admin/domains/dom-1"]);
    });
    await waitFor(() => {
      expect(dialog()).toBeNull();
    });
  });

  it("names the real DNS record count rather than a round number", async () => {
    await renderWith([
      {
        domain: apiDomain(),
        dnsRecords: [
          apiDnsRecord("rec-1"),
          apiDnsRecord("rec-2", { recordType: "SPF" }),
          apiDnsRecord("rec-3", { recordType: "DKIM" }),
        ],
      },
    ]);

    await click(labelled("Delete helix.io"));

    expect(dialogText()).toContain("Its 3 configured DNS records go with it");
  });

  it("says so when there are no DNS records under the domain", async () => {
    await renderWith([{ domain: apiDomain(), dnsRecords: [] }]);

    await click(labelled("Delete helix.io"));

    expect(dialogText()).toContain("No DNS records are configured under it");
  });

  it("claims mail stops only for a verified domain", async () => {
    await renderWith([{ domain: apiDomain(), dnsRecords: [] }]);

    await click(labelled("Delete helix.io"));

    expect(dialogText()).toContain("Mail delivery stops for every address at helix.io");
  });

  it("does not claim mail stops for a domain that was never verified", async () => {
    await renderWith([
      {
        domain: apiDomain({ verificationStatus: "pending", verifiedAt: null }),
        dnsRecords: [],
      },
    ]);

    await click(labelled("Delete helix.io"));

    // The signature bug this guards: asserting a consequence the workspace is
    // not actually exposed to, because the copy ignored the real status.
    expect(dialogText()).not.toContain("Mail delivery stops");
    expect(dialogText()).toContain("helix.io is not verified, so no mail is flowing through it");
  });

  it("surfaces that the target is the primary domain", async () => {
    await renderWith([{ domain: apiDomain({ isPrimary: true }), dnsRecords: [] }]);

    await click(labelled("Delete helix.io"));

    expect(dialogText()).toContain("This is the workspace's primary domain");
  });

  /* The DNS list was a CSS-grid pseudo-table: a stack of anonymous divs that a
     screen reader announced as nothing at all. */
  it("renders DNS records as a named table with real rows", async () => {
    await renderWith([
      {
        domain: apiDomain(),
        dnsRecords: [apiDnsRecord("rec-1"), apiDnsRecord("rec-2", { recordType: "SPF" })],
      },
    ]);

    const table = container.querySelector<HTMLTableElement>(
      'table[aria-label="DNS records for helix.io"]',
    );
    if (!table) {
      throw new Error("DNS records table not found");
    }
    expect([...table.querySelectorAll("thead th")].map((cell) => cell.textContent)).toEqual([
      "Type",
      "Host",
      "Value",
      "Status",
      "Verify record",
    ]);
    expect(table.querySelectorAll("tbody tr")).toHaveLength(2);
  });

  it("says why a domain has no DNS records rather than showing a blank table", async () => {
    await renderWith([{ domain: apiDomain(), dnsRecords: [] }]);

    const table = container.querySelector<HTMLTableElement>(
      'table[aria-label="DNS records for helix.io"]',
    );
    // An empty table body with no explanation reads as a broken panel — and
    // "no records" here means the deployment has no public mail hostname, not
    // that the request failed.
    expect(table?.querySelector("tbody")?.textContent ?? "").toContain(
      "HELIX_MAIL_PUBLIC_HOSTNAME",
    );
  });

  it("cancelling leaves the domain in place", async () => {
    await renderWith([{ domain: apiDomain(), dnsRecords: [] }]);

    await click(labelled("Delete helix.io"));
    await click(dialogButton("cancel"));

    await waitFor(() => {
      expect(dialog()).toBeNull();
    });
    expect(deleteCalls()).toEqual([]);
  });
});
