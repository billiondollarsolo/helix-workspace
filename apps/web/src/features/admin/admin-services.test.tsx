// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AdminServicesOverview,
  adminServicesQueryOptions,
  prefetchAdminServicesQuery,
  type AdminServiceSurface,
  type AdminServicesResponse,
} from "./admin-services";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

describe("AdminServicesOverview admin UI", () => {
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

  it("renders service list rows and selected service detail from the list response", async () => {
    fetchMock.mockResolvedValue(Response.json(adminServicesResponse()));

    renderAdminServices();
    await waitForText("Mail");

    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/admin/services");
    const table = tableByLabel("Admin services");
    const headers = Array.from(table.querySelectorAll('[role="columnheader"]')).map(
      (header) => header.textContent,
    );
    expect(headers).toEqual([
      "Service",
      "Plugin",
      "Status",
      "Category",
      "Dependencies",
      "Routes",
      "Tools",
      "Actions",
    ]);
    expect(table.textContent).toContain("com.helix.core.mail");
    expect(table.textContent).toContain("Configured / Enabled");
    expect(table.textContent).toContain("Communication");
    expect(table.textContent).toContain("2 total, 1 required missing");
    expect(table.textContent).toContain("Ready / Enabled");
    expect(container.textContent).toContain("/api/tools/mail.send");
    expect(container.textContent).toContain("mail.read, mail.send");
    expect(container.textContent).toContain("mail.classification");

    await clickButton("Docs");
    await waitForText("/sync/docs/:docId");
    expect(container.textContent).toContain("docs.smart-write");
    expect(container.textContent).toContain("GET /api/admin/services/docs/routes");
    expect(alertMock).not.toHaveBeenCalled();
    expect(confirmMock).not.toHaveBeenCalled();
    expect(promptMock).not.toHaveBeenCalled();
  });

  it("does not display secret values even when extra response fields contain them", async () => {
    const responseWithExtraSecrets = adminServicesResponse() as unknown as Record<string, unknown>;
    const services = responseWithExtraSecrets.services as Array<Record<string, unknown>>;
    const mail = requireRecord(services[0], "mail service");
    mail.secretValue = "super-secret-value";
    const configuration = mail.configuration as Array<Record<string, unknown>>;
    requireRecord(configuration[0], "mail configuration").value = "smtp-password-secret";
    const dependencies = mail.dependencies as Array<Record<string, unknown>>;
    requireRecord(dependencies[0], "mail dependency").resolvedValue =
      "postgres://helix:secret-password@localhost/helix";

    fetchMock.mockResolvedValue(Response.json(responseWithExtraSecrets));

    renderAdminServices();
    await waitForText("smtp.password (sensitive: Configured)");

    expect(container.textContent).toContain("smtp.password (sensitive: Configured)");
    expect(container.textContent).not.toContain("super-secret-value");
    expect(container.textContent).not.toContain("smtp-password-secret");
    expect(container.textContent).not.toContain("secret-password");
  });

  it("surfaces malformed service API responses without native dialogs", async () => {
    fetchMock.mockResolvedValue(Response.json({ generatedAt: "2026-05-21T14:00:00.000Z" }));

    renderAdminServices();

    await waitForText("Admin services are unavailable or missing admin services scope.");
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      "Admin services are unavailable or missing admin services scope.",
    );
    expect(container.textContent).toContain("No services reported.");
    expect(alertMock).not.toHaveBeenCalled();
    expect(confirmMock).not.toHaveBeenCalled();
    expect(promptMock).not.toHaveBeenCalled();
  });

  it("handles service API errors without native dialogs", async () => {
    fetchMock.mockResolvedValue(Response.json({ error: "denied" }, { status: 403 }));

    renderAdminServices();

    await waitForText("Admin services are unavailable or missing admin services scope.");
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/admin/services");
    expect(alertMock).not.toHaveBeenCalled();
    expect(confirmMock).not.toHaveBeenCalled();
    expect(promptMock).not.toHaveBeenCalled();
  });

  it("prefetches the admin services query with contained errors", async () => {
    const ensureQueryData = vi
      .fn<(options: ReturnType<typeof adminServicesQueryOptions>) => Promise<unknown>>()
      .mockRejectedValue(new Error("services unavailable"));

    await expect(prefetchAdminServicesQuery({ ensureQueryData })).resolves.toBeUndefined();

    expect(ensureQueryData).toHaveBeenCalledTimes(1);
  });

  function renderAdminServices() {
    act(() => {
      root.render(
        createElement(
          QueryClientProvider,
          { client: queryClient },
          createElement(AdminServicesOverview),
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

  async function clickButton(name: string) {
    const button = Array.from(container.querySelectorAll("button")).find((candidate) =>
      candidate.textContent?.includes(name),
    );
    if (!(button instanceof HTMLButtonElement)) {
      throw new Error(`Button not found: ${name}`);
    }
    act(() => {
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await act(async () => {
      await Promise.resolve();
    });
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

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null) {
    throw new Error(`Expected ${label}.`);
  }
  return value as Record<string, unknown>;
}

function adminServicesResponse(): AdminServicesResponse {
  return {
    generatedAt: "2026-05-21T14:00:00.000Z",
    services: [mailService(), docsService()],
  };
}

function mailService(): AdminServiceSurface {
  return {
    adminActions: [
      {
        destructive: false,
        id: "mail-config",
        label: "Mail config",
        method: "GET",
        path: "/api/admin/mail/config",
        requiredScope: "admin.config.read",
      },
    ],
    adminScopes: ["mail.admin", "admin.config.read", "admin.config.write"],
    aiSlots: ["mail.summarize-thread"],
    apiRoutes: ["/api/tools/mail.send", "/api/tools/mail.search"],
    capabilities: ["smtp-inbound", "smtp-outbound"],
    category: "communication",
    configuration: [
      {
        configured: true,
        envKeys: ["MAIL_SMTP_PASS"],
        evidence: "Secret reference present.",
        key: "smtp.password",
        label: "SMTP password",
        sensitive: true,
        status: "configured",
      },
    ],
    consumes: ["object-storage"],
    dataStores: ["messages", "threads", "attachments"],
    dependencies: [
      {
        envKeys: ["DATABASE_URL"],
        evidence: "Database URL present.",
        id: "postgres",
        label: "Postgres",
        required: true,
        status: "configured",
        type: "database",
      },
      {
        envKeys: ["MAIL_SMTP_HOST"],
        evidence: "SMTP host is missing.",
        id: "smtp",
        label: "SMTP relay",
        required: true,
        status: "missing",
        type: "external-service",
      },
    ],
    enabled: true,
    enrichments: ["mail.classification"],
    evidence: "Mail service is configured.",
    id: "mail",
    label: "Mail",
    metrics: ["mail.delivery.latency", "mail.delivery.failed"],
    pluginId: "com.helix.core.mail",
    realtimeRoutes: [],
    scopes: ["mail.read", "mail.send"],
    status: "configured",
    summary: "Inbound and outbound mail.",
    tools: ["mail.send", "mail.search"],
    uiRoutes: ["/mail"],
  };
}

function docsService(): AdminServiceSurface {
  return {
    adminActions: [
      {
        destructive: false,
        id: "docs-routes",
        label: "Docs routes",
        method: "GET",
        path: "/api/admin/services/docs/routes",
        requiredScope: "admin.services.read",
      },
    ],
    adminScopes: ["docs.admin", "admin.config.read"],
    aiSlots: ["docs.smart-write"],
    apiRoutes: ["/api/tools/docs.create"],
    capabilities: ["collaborative-editing"],
    category: "workspace",
    configuration: [],
    consumes: ["ai"],
    dataStores: ["docs_documents", "docs_updates"],
    dependencies: [],
    enabled: true,
    enrichments: ["docs.outline"],
    evidence: "Docs service is ready.",
    id: "docs",
    label: "Docs",
    metrics: ["docs.sync.active"],
    pluginId: "com.helix.core.docs",
    realtimeRoutes: ["/sync/docs/:docId"],
    scopes: ["docs.read", "docs.write"],
    status: "ready",
    summary: "Documents and collaboration.",
    tools: ["docs.create"],
    uiRoutes: ["/docs"],
  };
}
