// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ShellOverlayContext } from "@/components/shell";
import { AdminConsole } from "./admin-console";

/** TopBar calls `sessionUserQueryOptions()` → fetch("/api/auth/get-session").
 * That would consume the per-test fetchMock Response before the AdminUsers
 * query reads it, so we stub the session query to a resolved null instead. */
vi.mock("@/lib/auth", async () => {
  const actual = await vi.importActual<typeof import("@/lib/auth")>("@/lib/auth");
  return {
    ...actual,
    sessionUserQueryOptions: () => ({
      queryKey: ["auth", "session"],
      queryFn: () => Promise.resolve(null),
      staleTime: 30_000,
      throwOnError: false,
    }),
  };
});

vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>();
  return {
    ...actual,
    useRouter: () => ({ invalidate: () => Promise.resolve() }),
  };
});

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const overlayApi = {
  openNotifications: vi.fn(),
  openPalette: vi.fn(),
  openSettings: vi.fn(),
};

const apiUsers = {
  users: [
    {
      id: "u-1",
      orgId: "org-1",
      type: "human",
      email: "mira@helix.io",
      displayName: "Mira Okafor",
      scopes: ["admin"],
      disabledAt: null,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    },
    {
      id: "u-2",
      orgId: "org-1",
      type: "human",
      email: "marcus@helix.io",
      displayName: "Marcus Bell",
      scopes: [],
      disabledAt: "2026-05-01T00:00:00Z",
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-05-01T00:00:00Z",
    },
  ],
  nextCursor: null,
};

const apiBillingAccount = {
  account: {
    orgId: "org-1",
    planName: "Business Plus",
    pricePerSeatCents: 2900,
    billingCycle: "monthly",
    currency: "USD",
    licensesTotal: 20,
    licensesUsed: 12,
    storageUsedBytes: 120_000_000_000,
    storageLimitBytes: 1_000_000_000_000,
    aiCreditsUsed: 500,
    aiCreditsLimit: 1000,
    nextInvoiceCents: 34_800,
    nextInvoiceAt: "2026-06-01T00:00:00.000Z",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-05-01T00:00:00.000Z",
  },
  meters: [
    { id: "licenses", used: 12, limit: 20, fraction: 0.6 },
    { id: "storage", used: 120_000_000_000, limit: 1_000_000_000_000, fraction: 0.12 },
    { id: "ai_credits", used: 500, limit: 1000, fraction: 0.5 },
  ],
};

const apiInvoices = {
  invoices: [
    {
      id: "inv-1",
      orgId: "org-1",
      invoiceNumber: "INV-001",
      amountCents: 34_800,
      currency: "USD",
      status: "paid",
      periodStart: "2026-05-01T00:00:00.000Z",
      periodEnd: "2026-06-01T00:00:00.000Z",
      issuedAt: "2026-05-01T00:00:00.000Z",
      createdAt: "2026-05-01T00:00:00.000Z",
    },
  ],
  nextCursor: null,
};

const apiUsageRollups = {
  rollups: [
    {
      orgId: "org-1",
      periodStart: "2026-05-23",
      periodEnd: "2026-05-24",
      metricKey: "ai_tokens",
      quantity: 1234,
      computedAt: "2026-05-24T00:05:00.000Z",
    },
    {
      orgId: "org-1",
      periodStart: "2026-05-23",
      periodEnd: "2026-05-24",
      metricKey: "storage_avg_bytes",
      quantity: 2_048_000,
      computedAt: "2026-05-24T00:05:00.000Z",
    },
    {
      orgId: "org-1",
      periodStart: "2026-05-23",
      periodEnd: "2026-05-24",
      metricKey: "seats_max",
      quantity: 12,
      computedAt: "2026-05-24T00:05:00.000Z",
    },
  ],
  summary: {
    periodStart: "2026-05-23",
    periodEnd: "2026-05-24",
    metrics: [
      { metricKey: "ai_tokens", quantity: 1234, aggregation: "sum", sampleCount: 1 },
      {
        metricKey: "storage_avg_bytes",
        quantity: 2_048_000,
        aggregation: "average",
        sampleCount: 1,
      },
      { metricKey: "seats_max", quantity: 12, aggregation: "max", sampleCount: 1 },
    ],
  },
};

const apiSecurityPolicies = {
  policies: [
    securityPolicy("mfa", {
      allowedMethods: ["hardware_key", "totp"],
      rememberDeviceDays: 0,
    }),
    securityPolicy("sso", {
      provider: "google",
      metadataUrl: "https://accounts.google.com/.well-known/openid-configuration",
      jitProvisioning: true,
      mappedDomains: ["helix.local"],
      localLoginEnabled: true,
      setupStatus: "draft",
      testLoginStatus: "runtime_pending",
      setupSource: "admin",
    }),
    securityPolicy("session", {
      inactivityTimeoutDays: 14,
      reauthForAdminActions: true,
      maxConcurrentSessions: 10,
    }),
    securityPolicy("external_sharing", {
      mode: "allowlist",
      allowedDomains: ["helix.local"],
      requireExpiry: true,
    }),
    securityPolicy("dlp", {
      detectors: ["ssn"],
      action: "warn",
    }),
    securityPolicy("device_trust", {
      protectedApps: ["admin"],
    }),
  ],
};

/** Set a React-controlled input's value via the native prototype setter so
 *  the synthetic `input` event reflects the new value. */
function setInputValue(input: HTMLInputElement, value: string): void {
  Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set?.call(
    input,
    value,
  );
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function setSelectValue(select: HTMLSelectElement, value: string): void {
  Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value")?.set?.call(
    select,
    value,
  );
  select.dispatchEvent(new Event("change", { bubbles: true }));
}

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

function mockJsonResponse(
  fetchMock: ReturnType<typeof vi.fn<typeof fetch>>,
  payload: unknown,
): void {
  fetchMock.mockImplementation(() => Promise.resolve(Response.json(payload)));
}

function mockAdminBillingResponses(fetchMock: ReturnType<typeof vi.fn<typeof fetch>>): void {
  fetchMock.mockImplementation((input) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input instanceof Request
            ? input.url
            : "";
    if (url.includes("/api/admin/billing/account")) {
      return Promise.resolve(Response.json(apiBillingAccount));
    }
    if (url.includes("/api/admin/billing/invoices")) {
      return Promise.resolve(Response.json(apiInvoices));
    }
    if (url.includes("/api/admin/billing/usage")) {
      return Promise.resolve(Response.json(apiUsageRollups));
    }
    return Promise.resolve(Response.json(apiUsers));
  });
}

function mockAdminSecurityResponses(fetchMock: ReturnType<typeof vi.fn<typeof fetch>>): void {
  fetchMock.mockImplementation((input) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input instanceof Request
            ? input.url
            : "";
    if (url.includes("/api/admin/security-policies")) {
      return Promise.resolve(Response.json(apiSecurityPolicies));
    }
    return Promise.resolve(Response.json(apiUsers));
  });
}

function securityPolicy(policyType: string, settings: Record<string, unknown>) {
  return {
    id: `policy-${policyType}`,
    orgId: "org-1",
    policyType,
    enabled: true,
    enforcement: "optional",
    settings,
    updatedBy: "u-1",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-05-01T00:00:00.000Z",
  };
}

describe("AdminConsole", () => {
  let container: HTMLDivElement;
  let root: Root;
  let queryClient: QueryClient;
  let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;

  function render(node: ReactNode): Promise<void> {
    return act(() => {
      root.render(
        createElement(
          QueryClientProvider,
          { client: queryClient },
          createElement(ShellOverlayContext.Provider, { value: overlayApi }, node),
        ),
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
    vi.clearAllMocks();
  });

  it("renders the Overview placeholder by default (telemetry not yet wired)", async () => {
    mockJsonResponse(fetchMock, apiUsers);

    await render(createElement(AdminConsole));

    expect(container.textContent).toContain("Workspace overview");
    expect(container.textContent).toContain("Telemetry not yet wired");
  });

  it("navigates to each admin section from the sidebar", async () => {
    mockJsonResponse(fetchMock, apiUsers);

    await render(createElement(AdminConsole));

    await clickButton("Groups & OUs");
    expect(container.textContent).toContain("Organizational Units");

    await clickButton("Security");
    // The Security section now renders real policies only. With fetch mocked
    // to return the users payload, the policies query errors and the section
    // surfaces its error banner rather than fabricated reference cards.
    await waitFor(() => {
      expect(container.textContent).toContain("Security policies unavailable");
    });

    await clickButton("Apps");
    await waitFor(() => {
      expect(container.textContent).toContain("App permissions");
    });

    await clickButton("Billing");
    // The billing section now renders real-data only. With fetch mocked to
    // return the users payload, the billing account query errors and the
    // section renders its error banner instead of fabricated rows.
    await waitFor(() => {
      expect(container.textContent).toContain("Billing & licenses");
    });

    await clickButton("Settings");
    await waitFor(() => {
      expect(container.textContent).toContain("Tenant settings");
    });

    await clickButton("Audit log");
    // The audit section now renders the live AuditLogList component, which
    // fetches from /api/admin/audit-log. The mocked fetch returns the users
    // payload here, so we assert on stable surface chrome rather than rows.
    await waitFor(() => {
      expect(container.textContent).toContain("Recent immutable activity records");
    });

    await clickButton("Domain");
    // The Domain section now renders real domains only. With fetch mocked to
    // return the users payload, the domains query errors and the section
    // surfaces its error banner rather than fabricated DNS records.
    await waitFor(() => {
      expect(container.textContent).toContain("Domains unavailable");
    });
  });

  it("wires the Users table to the admin users API", async () => {
    mockJsonResponse(fetchMock, apiUsers);

    await render(createElement(AdminConsole));
    await clickButton("Users");

    await waitFor(() => {
      expect(container.textContent).toContain("Mira Okafor");
    });
    // disabledAt -> suspended status projection
    expect(container.textContent).toContain("suspended");
    const requestedUsers = fetchMock.mock.calls.some((call) => {
      const input = call[0];
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input instanceof Request
              ? input.url
              : "";
      return url.includes("/api/admin/users");
    });
    expect(requestedUsers).toBe(true);
  });

  it("shows local email/password login alongside the SSO policy", async () => {
    mockAdminSecurityResponses(fetchMock);

    await render(createElement(AdminConsole));
    await clickButton("Security");

    await waitFor(() => {
      expect(container.textContent).toContain("Single sign-on (SSO)");
      expect(container.textContent).toContain("Provider: google");
      expect(container.textContent).toContain("Local email/password login");
      expect(container.textContent).toContain("Local email/password: enabled");
      expect(container.textContent).toContain("Owner/admin recovery path; SSO is additive.");
    });
    expect((container.textContent ?? "").indexOf("Local email/password login")).toBeLessThan(
      (container.textContent ?? "").indexOf("Single sign-on (SSO)"),
    );

    const editSso = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Edit Single sign-on (SSO)"]',
    );
    if (!editSso) {
      throw new Error("SSO edit button not found");
    }
    await act(() => {
      editSso.click();
      return Promise.resolve();
    });

    const localLogin = container.querySelector<HTMLInputElement>(
      'input[aria-label="Local email/password login enabled"]',
    );
    expect(container.textContent).toContain("Local email/password login remains enabled");
    expect(localLogin?.checked).toBe(true);
    expect(localLogin?.disabled).toBe(true);
  });

  it("shows the empty-state row when the users API returns no rows", async () => {
    mockJsonResponse(fetchMock, { users: [], nextCursor: null });

    await render(createElement(AdminConsole));
    await clickButton("Users");

    await waitFor(() => {
      expect(container.textContent).toContain("No users match the current filters.");
    });
  });

  it("filters users by search query (using real API rows)", async () => {
    mockJsonResponse(fetchMock, apiUsers);

    await render(createElement(AdminConsole));
    await clickButton("Users");

    await waitFor(() => {
      expect(container.textContent).toContain("Mira Okafor");
      expect(container.textContent).toContain("Marcus Bell");
    });

    const search = container.querySelector<HTMLInputElement>('input[aria-label="Filter users"]');
    if (!search) {
      throw new Error("Search input not found");
    }
    await act(() => {
      setInputValue(search, "marcus");
      return Promise.resolve();
    });

    expect(container.textContent).toContain("Marcus Bell");
    expect(container.textContent).not.toContain("Mira Okafor");
  });

  it("shows bulk actions when users are selected", async () => {
    mockJsonResponse(fetchMock, apiUsers);

    await render(createElement(AdminConsole));
    await clickButton("Users");

    await waitFor(() => {
      expect(container.textContent).toContain("Mira Okafor");
    });

    const selectAll = container.querySelector<HTMLInputElement>(
      'input[aria-label="Select all users"]',
    );
    if (!selectAll) {
      throw new Error("Select-all checkbox not found");
    }
    await act(() => {
      selectAll.click();
      return Promise.resolve();
    });

    expect(container.textContent).toContain("selected");
    expect(container.textContent).toContain("Change role");
    expect(container.textContent).toContain("Suspend");
  });

  it("renders billing usage rollups from the billing API", async () => {
    mockAdminBillingResponses(fetchMock);

    await render(createElement(AdminConsole));
    await clickButton("Billing");

    await waitFor(() => {
      expect(container.textContent).toContain("Billing-period usage");
      expect(container.textContent).toContain("Business Plus");
      expect(container.textContent).toContain("Upgrade plan");
      expect(container.textContent).toContain("AI tokens");
      expect(container.textContent).toContain("1,234");
      expect(container.textContent).toContain("Average storage");
      expect(container.textContent).toContain("2.0 MB");
      expect(container.textContent).toContain("Max seats");
      expect(container.textContent).toContain("12");
    });

    const planChangeLink = container.querySelector<HTMLAnchorElement>(
      'a[href^="mailto:sales@helix.example"]',
    );
    expect(planChangeLink?.href).toContain("Current%20plan%3A%20Business%20Plus");

    const metricFilter = container.querySelector<HTMLSelectElement>(
      'select[aria-label="Usage metric filter"]',
    );
    const fromFilter = container.querySelector<HTMLInputElement>(
      'input[aria-label="Usage from date"]',
    );
    const toFilter = container.querySelector<HTMLInputElement>('input[aria-label="Usage to date"]');
    if (metricFilter === null || fromFilter === null || toFilter === null) {
      throw new Error("Usage filters were not rendered.");
    }

    await act(() => {
      setSelectValue(metricFilter, "storage_avg_bytes");
      setInputValue(fromFilter, "2026-05-01");
      setInputValue(toFilter, "2026-05-31");
      return Promise.resolve();
    });

    await waitFor(() => {
      const requestedUrls = fetchMock.mock.calls.map(([input]) => requestUrl(input));
      expect(requestedUrls).toContain(
        "/api/admin/billing/usage?from=2026-05-01&to=2026-05-31&metricKey=storage_avg_bytes",
      );
    });
  });
});

function requestUrl(input: RequestInfo | URL): string {
  return typeof input === "string"
    ? input
    : input instanceof URL
      ? input.href
      : input instanceof Request
        ? input.url
        : "";
}
