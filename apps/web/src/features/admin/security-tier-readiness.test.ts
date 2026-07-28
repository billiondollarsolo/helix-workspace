// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  adminPlatformConfigQueryKey,
  adminPluginCatalogQueryKey,
  backendStatusToCheckStatus,
  formatRequirementFields,
  prefetchAdminReadinessQueries,
  readinessCheckFromBackend,
  readinessChecksForTier,
  SecurityTierReadiness,
  serviceFromBackendRequirement,
  type PlatformConfigPatch,
} from "./security-tier-readiness";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

describe("SecurityTierReadiness admin UI", () => {
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
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    fetchMock = vi.fn<typeof fetch>();
    alertMock = vi.fn();
    confirmMock = vi.fn(() => true);
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

  it("PATCHes the selected security tier shape and reflects success state without native dialogs", async () => {
    fetchMock.mockImplementation((input, init) => {
      if (input === "/api/tools/plugin.list") {
        return Promise.resolve(Response.json(pluginCatalog()));
      }
      if (input === "/api/admin/platform-config" && init?.method === "PATCH") {
        return Promise.resolve(Response.json(platformStatus("enterprise", true)));
      }
      return Promise.resolve(Response.json(platformStatus("business", true)));
    });

    renderAdminUI();
    await waitForText("Live platform config connected");
    await clickButton("Enterprise");
    await clickButton("Apply tier draft");

    await waitFor(() => expect(platformPatchCall()).toBeDefined());
    expect(platformPatchCall()?.[0]).toBe("/api/admin/platform-config");
    expect(platformPatchCall()?.[1]?.method).toBe("PATCH");
    expect(platformPatchCall()?.[1]?.headers).toEqual({ "content-type": "application/json" });

    const payload = requestBodyForCall<PlatformConfigPatch>(platformPatchCall());
    expect(payload).toEqual({ security: { tier: "enterprise" } });
    await waitForText("Enterprise platform state");
    expect(container.textContent).toContain("Live tierEnterprise");
    expect(alertMock).not.toHaveBeenCalled();
    expect(confirmMock).not.toHaveBeenCalled();
    expect(promptMock).not.toHaveBeenCalled();
  });

  it("shows the mutation error state without browser-native alert, confirm, or prompt", async () => {
    fetchMock.mockImplementation((input, init) => {
      if (input === "/api/tools/plugin.list") {
        return Promise.resolve(Response.json(pluginCatalog()));
      }
      if (input === "/api/admin/platform-config" && init?.method === "PATCH") {
        return Promise.resolve(Response.json({ error: "denied" }, { status: 403 }));
      }
      return Promise.resolve(Response.json(platformStatus("business", true)));
    });

    renderAdminUI();
    await waitForText("Live platform config connected");
    await clickButton("Enterprise");
    await clickButton("Apply tier draft");

    await waitForText("Could not apply the tier draft.");
    expect(requestBodyForCall<PlatformConfigPatch>(platformPatchCall())).toEqual({
      security: { tier: "enterprise" },
    });
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      "Could not apply the tier draft.",
    );
    expect(alertMock).not.toHaveBeenCalled();
    expect(confirmMock).not.toHaveBeenCalled();
    expect(promptMock).not.toHaveBeenCalled();
  });

  it("optimistically updates the tier cache and rolls back when the patch fails", async () => {
    const patchResponse = deferred<Response>();
    fetchMock.mockImplementation((input, init) => {
      if (input === "/api/tools/plugin.list") {
        return Promise.resolve(Response.json(pluginCatalog()));
      }
      if (input === "/api/admin/platform-config" && init?.method === "PATCH") {
        return patchResponse.promise;
      }
      return Promise.resolve(Response.json(platformStatus("business", true)));
    });

    renderAdminUI();
    await waitForText("Live platform config connected");
    await clickButton("Enterprise");
    await clickButton("Apply tier draft");

    await waitFor(() => {
      expect(platformPatchCall()).toBeDefined();
      expect(platformConfigCache()?.config.security.tier).toBe("enterprise");
    });

    patchResponse.resolve(Response.json({ error: "denied" }, { status: 403 }));

    await waitForText("Could not apply the tier draft.");
    expect(platformConfigCache()?.config.security.tier).toBe("business");
    expect(container.textContent).toContain("Live tierBusiness");
    expect(alertMock).not.toHaveBeenCalled();
    expect(confirmMock).not.toHaveBeenCalled();
    expect(promptMock).not.toHaveBeenCalled();
  });

  it("surfaces malformed config API responses instead of falling back to static readiness", async () => {
    fetchMock.mockResolvedValue(Response.json({}));

    renderAdminUI();

    await waitForText("Platform config response was missing required fields.");
    expect(container.textContent).toContain("Unavailable platform state");
    expect(container.textContent).toContain(
      "Readiness gates are unavailable until the admin config API returns a valid response.",
    );
    expect(container.textContent).not.toContain("Static preview");
    expect(alertMock).not.toHaveBeenCalled();
    expect(confirmMock).not.toHaveBeenCalled();
    expect(promptMock).not.toHaveBeenCalled();
  });

  it("displays backend Vault and CloudNativePG evidence without placeholder readiness copy", async () => {
    fetchMock.mockImplementation((input) =>
      Promise.resolve(
        Response.json(
          input === "/api/tools/plugin.list" ? pluginCatalog() : enterpriseStatusWithEvidence(),
        ),
      ),
    );

    renderAdminUI();
    await waitForText("Vault endpoint observed from runtime configuration.");
    await waitForText("CloudNativePG wiring observed from runtime configuration.");

    const renderedText = container.textContent ?? "";
    expect(renderedText).toContain("Secrets backend");
    expect(renderedText).toContain("HA Postgres");
    expect(renderedText).toContain("https://vault.internal:8200");
    expect(renderedText).toContain("postgres://helix-postgres-rw:5432/helix");
    expect(renderedText.toLowerCase()).not.toContain("placeholder");
    expect(renderedText).not.toContain("backend wiring lands");
    expect(renderedText).not.toContain("currently a placeholder");
    expect(alertMock).not.toHaveBeenCalled();
    expect(confirmMock).not.toHaveBeenCalled();
    expect(promptMock).not.toHaveBeenCalled();
  });

  it("shows current overrides and resets a control to the selected tier default", async () => {
    fetchMock.mockImplementation((input) =>
      Promise.resolve(
        Response.json(
          input === "/api/tools/plugin.list" ? pluginCatalog() : platformStatus("business", true),
        ),
      ),
    );

    renderAdminUI();
    await waitForText("Live platform config connected");
    await waitForText("Current override");
    expect(container.textContent).toContain("admins required, passkeys enabled");

    await clickButtonByLabel("Reset MFA to tier default");

    expect(container.textContent).not.toContain("admins required, passkeys enabled");
    expect(container.textContent).toContain("admins required");
    expect(alertMock).not.toHaveBeenCalled();
    expect(confirmMock).not.toHaveBeenCalled();
    expect(promptMock).not.toHaveBeenCalled();
  });

  it("surfaces AI cost limits and audit evidence from live admin config", async () => {
    fetchMock.mockImplementation((input) =>
      Promise.resolve(
        Response.json(
          input === "/api/tools/plugin.list"
            ? pluginCatalog()
            : platformStatus("business", true, {
                costLimits: { perUserPerDayUSD: 5, perOrgPerDayUSD: 500 },
                audit: { logRequests: "metadata-only", retainDays: 90 },
                privacy: {
                  classificationGating: true,
                  blockExternalForClassifications: ["confidential", "restricted"],
                },
              }),
        ),
      ),
    );

    renderAdminUI();
    await waitForText("Cost limits and audit evidence");
    await waitForText("Live platform config connected");
    await waitForText("$5.00");

    expect(container.textContent).toContain("User daily AI cost");
    expect(container.textContent).toContain("$5.00");
    expect(container.textContent).toContain("$10.00");
    expect(container.textContent).toContain("Org daily AI cost");
    expect(container.textContent).toContain("$500.00");
    expect(container.textContent).toContain("90 day retention");
    expect(container.textContent).toContain("Blocks Confidential, Restricted");
    expect(alertMock).not.toHaveBeenCalled();
    expect(confirmMock).not.toHaveBeenCalled();
    expect(promptMock).not.toHaveBeenCalled();
  });

  it("renders plugin catalog headers and rows with TanStack table semantics", async () => {
    fetchMock.mockImplementation((input) =>
      Promise.resolve(
        Response.json(
          input === "/api/tools/plugin.list" ? pluginCatalog() : platformStatus("business", true),
        ),
      ),
    );

    renderAdminUI();
    await waitForText("Community importer");

    const pluginTable = tableByLabel("Plugin catalog");
    const headers = Array.from(pluginTable.querySelectorAll('[role="columnheader"]')).map(
      (header) => header.textContent,
    );
    expect(headers).toEqual(["Plugin", "Kind", "Version", "Permissions", "Lifecycle", "Action"]);
    expect(pluginTable.textContent).toContain("Community importer");
    expect(pluginTable.textContent).toContain("com.example.community");
    expect(pluginTable.textContent).toContain("Mail auditor");
    expect(pluginTable.textContent).toContain("com.example.mail-auditor");
    expect(pluginTable.querySelectorAll('[role="row"]')).toHaveLength(3);

    await clickButton("Review");
    expect(container.textContent).toContain("mail.audit");
    expect(alertMock).not.toHaveBeenCalled();
    expect(confirmMock).not.toHaveBeenCalled();
    expect(promptMock).not.toHaveBeenCalled();
  });

  it("blocks non-official plugin install until every permission is confirmed", async () => {
    fetchMock.mockImplementation((input, init) => {
      if (input === "/api/tools/plugin.list") {
        return Promise.resolve(Response.json(pluginCatalog()));
      }
      if (input === "/api/tools/plugin.install" && init?.method === "POST") {
        return Promise.resolve(
          Response.json({
            status: "installed",
            source: "sideload",
            plugin: pluginCatalog().plugins[0],
            confirmations: [],
          }),
        );
      }
      return Promise.resolve(Response.json(platformStatus("business", true)));
    });

    renderAdminUI();
    await waitForText("Community importer");
    expect(tableByLabel("Plugin catalog").textContent).toContain("Community importer");
    await setSelectValue("Plugin source", "sideload");
    await waitForText("Install from a non-official source");
    expect(buttonByText("Install plugin").disabled).toBe(true);

    await clickAllPluginConfirmations();
    expect(buttonByText("Install plugin").disabled).toBe(false);
    await clickButton("Install plugin");

    await waitForText("Install validated for Community importer.");
    const installCall = fetchMock.mock.calls.find(
      (call) => call[0] === "/api/tools/plugin.install",
    );
    expect(requestBodyForCall(installCall)).toMatchObject({
      pluginId: "com.example.community",
      version: "1.2.3",
      source: "sideload",
      confirmations: [
        "source.non_official",
        "permissions.scopes.drive.write",
        "permissions.outbound-network.api.example.com",
        "capabilities.provides.example.importer",
        "signature.missing",
      ],
    });
    expect(alertMock).not.toHaveBeenCalled();
    expect(confirmMock).not.toHaveBeenCalled();
    expect(promptMock).not.toHaveBeenCalled();
  });

  it("calls plugin lifecycle tools from the admin plugin table", async () => {
    fetchMock.mockImplementation((input, init) => {
      if (input === "/api/tools/plugin.list") {
        return Promise.resolve(Response.json(pluginCatalog()));
      }
      if (input === "/api/tools/plugin.enable" && init?.method === "POST") {
        return Promise.resolve(
          Response.json({
            status: "enabled",
            plugin: pluginCatalog().plugins[0],
            lifecycle: { state: "enabled", installed: true },
          }),
        );
      }
      if (input === "/api/tools/plugin.disable" && init?.method === "POST") {
        return Promise.resolve(
          Response.json({
            status: "disabled",
            plugin: pluginCatalog().plugins[1],
            lifecycle: { state: "disabled", installed: true },
          }),
        );
      }
      if (input === "/api/tools/plugin.uninstall" && init?.method === "POST") {
        return Promise.resolve(
          Response.json({
            status: "uninstalled",
            plugin: pluginCatalog().plugins[1],
            lifecycle: { state: "uninstalled", installed: false },
          }),
        );
      }
      return Promise.resolve(Response.json(platformStatus("business", true)));
    });

    renderAdminUI();
    await waitForText("Community importer");
    await waitForText("Disabled");

    await clickPluginAction("com.example.community", "Enable");
    await waitFor(() => expect(pluginLifecycleCall("enable")).toBeDefined());
    expect(requestBodyForCall(pluginLifecycleCall("enable"))).toEqual({
      pluginId: "com.example.community",
    });

    await clickPluginAction("com.example.mail-auditor", "Disable");
    await waitFor(() => expect(pluginLifecycleCall("disable")).toBeDefined());
    expect(requestBodyForCall(pluginLifecycleCall("disable"))).toEqual({
      pluginId: "com.example.mail-auditor",
    });

    await clickPluginAction("com.example.mail-auditor", "Uninstall");
    await waitFor(() => expect(pluginLifecycleCall("uninstall")).toBeDefined());
    expect(requestBodyForCall(pluginLifecycleCall("uninstall"))).toEqual({
      pluginId: "com.example.mail-auditor",
      confirmations: ["plugin.uninstall"],
    });
    expect(alertMock).not.toHaveBeenCalled();
    expect(confirmMock).not.toHaveBeenCalled();
    expect(promptMock).not.toHaveBeenCalled();
  });

  it("optimistically marks plugin install cache and rolls back when validation fails", async () => {
    const installResponse = deferred<Response>();
    fetchMock.mockImplementation((input, init) => {
      if (input === "/api/tools/plugin.list") {
        return Promise.resolve(Response.json(pluginCatalog()));
      }
      if (input === "/api/tools/plugin.install" && init?.method === "POST") {
        return installResponse.promise;
      }
      return Promise.resolve(Response.json(platformStatus("business", true)));
    });

    renderAdminUI();
    await waitForText("Community importer");
    await setSelectValue("Plugin source", "sideload");
    await clickAllPluginConfirmations();
    await clickButton("Install plugin");

    await waitFor(() => {
      expect(pluginInstallCall()).toBeDefined();
      expect(communityPluginCache()?.install).toMatchObject({
        optimisticStatus: "installing",
        source: "sideload",
      });
    });

    installResponse.resolve(Response.json({ error: "denied" }, { status: 403 }));

    await waitForText("Could not validate the plugin install request.");
    expect(pluginCatalogCache()).toEqual(pluginCatalog());
    expect(alertMock).not.toHaveBeenCalled();
    expect(confirmMock).not.toHaveBeenCalled();
    expect(promptMock).not.toHaveBeenCalled();
  });

  function renderAdminUI() {
    act(() => {
      root.render(
        createElement(
          QueryClientProvider,
          { client: queryClient },
          createElement(SecurityTierReadiness),
        ),
      );
    });
  }

  async function clickButton(name: string) {
    const button = buttonByText(name);
    act(() => {
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await act(async () => {
      await Promise.resolve();
    });
  }

  function buttonByText(name: string): HTMLButtonElement {
    const button = Array.from(container.querySelectorAll("button")).find((candidate) =>
      candidate.textContent?.includes(name),
    );
    if (!(button instanceof HTMLButtonElement)) {
      throw new Error(`Button not found: ${name}`);
    }
    return button;
  }

  function tableByLabel(label: string): HTMLElement {
    const table = container.querySelector(`[role="table"][aria-label="${label}"]`);
    if (!(table instanceof HTMLElement)) {
      throw new Error(`Table not found: ${label}`);
    }
    return table;
  }

  async function clickButtonByLabel(label: string) {
    const button = container.querySelector(`button[aria-label="${label}"]`);
    if (!(button instanceof HTMLButtonElement)) {
      throw new Error(`Button not found: ${label}`);
    }
    act(() => {
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await act(async () => {
      await Promise.resolve();
    });
  }

  async function clickPluginAction(pluginId: string, action: string) {
    const row = Array.from(tableByLabel("Plugin catalog").querySelectorAll('[role="row"]')).find(
      (candidate) => candidate.textContent?.includes(pluginId),
    );
    const button = Array.from(row?.querySelectorAll("button") ?? []).find((candidate) =>
      candidate.textContent?.includes(action),
    );
    if (!(button instanceof HTMLButtonElement)) {
      throw new Error(`Plugin action not found: ${pluginId} ${action}`);
    }
    act(() => {
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await act(async () => {
      await Promise.resolve();
    });
  }

  async function setSelectValue(label: string, value: string) {
    const select = container.querySelector(`select[aria-label="${label}"]`);
    if (!(select instanceof HTMLSelectElement)) {
      throw new Error(`Select not found: ${label}`);
    }
    act(() => {
      const valueSetter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")
        ?.set as ((this: HTMLSelectElement, value: string) => void) | undefined;
      if (valueSetter !== undefined) {
        Reflect.apply(valueSetter, select, [value]);
      }
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await act(async () => {
      await Promise.resolve();
    });
  }

  async function clickAllPluginConfirmations() {
    const checkboxes = Array.from(
      container.querySelectorAll(".admin-plugin-confirmations input[type='checkbox']"),
    );
    if (checkboxes.length === 0) {
      throw new Error("Plugin confirmation checkboxes not found.");
    }
    for (const checkbox of checkboxes) {
      if (!(checkbox instanceof HTMLInputElement)) {
        continue;
      }
      act(() => {
        checkbox.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
      await act(async () => {
        await Promise.resolve();
      });
    }
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

  function platformConfigCache() {
    return queryClient.getQueryData<ReturnType<typeof platformStatus>>(adminPlatformConfigQueryKey);
  }

  function pluginCatalogCache() {
    return queryClient.getQueryData<ReturnType<typeof pluginCatalog>>(adminPluginCatalogQueryKey);
  }

  function communityPluginCache() {
    return pluginCatalogCache()?.plugins.find((plugin) => plugin.id === "com.example.community");
  }
});

describe("admin security tier readiness helpers", () => {
  it("prefetches route data for platform config and plugin catalog with contained errors", async () => {
    const ensureQueryData = vi
      .fn<(options: { readonly queryKey: readonly unknown[] }) => Promise<unknown>>()
      .mockRejectedValueOnce(new Error("platform config unavailable"))
      .mockResolvedValueOnce({ plugins: [] });

    await expect(prefetchAdminReadinessQueries({ ensureQueryData })).resolves.toBeUndefined();

    expect(ensureQueryData).toHaveBeenCalledTimes(2);
    expect(ensureQueryData.mock.calls.map(([options]) => options.queryKey)).toEqual([
      adminPlatformConfigQueryKey,
      adminPluginCatalogQueryKey,
    ]);
  });

  it("formats backend expected and observed requirement fields for display", () => {
    const check = readinessCheckFromBackend({
      key: "auditDestinations",
      label: "Audit destinations",
      required: true,
      status: "missing",
      expected: { destinations: ["postgres", "immutable-s3", "siem"] },
      observed: { destinations: ["postgres"], status: "missing" },
      missing: ["immutable-s3", "siem"],
    });

    expect(check.status).toBe("blocked");
    expect(check.expectedFields).toContainEqual({
      label: "Destinations",
      value: "Postgres, Immutable S3, SIEM",
    });
    expect(check.observedFields).toContainEqual({
      label: "Status",
      value: "Missing",
    });
    expect(check.missing).toEqual(["immutable-s3", "siem"]);
  });

  it("overlays backend readiness evidence onto the tier checklist", () => {
    const checks = readinessChecksForTier("enterprise", [
      {
        key: "vault",
        label: "Vault",
        required: true,
        status: "ready",
        expected: { running: true },
        observed: {
          enabled: true,
          endpoint: "https://vault.internal:8200",
          evidence: "Vault endpoint observed from runtime configuration.",
        },
      },
      {
        key: "cloudNativePg",
        label: "CloudNativePG",
        required: true,
        status: "ready",
        expected: { running: true },
        observed: {
          enabled: true,
          endpoint: "postgres://helix-postgres-rw:5432/helix",
          evidence: "CloudNativePG wiring observed from runtime configuration.",
        },
      },
    ]);

    expect(checks.find((check) => check.id === "secrets-backend")).toMatchObject({
      detail: "Vault endpoint observed from runtime configuration.",
      status: "ready",
    });
    expect(checks.find((check) => check.id === "ha-postgres")).toMatchObject({
      detail: "CloudNativePG wiring observed from runtime configuration.",
      status: "ready",
    });
    expect(checks.find((check) => check.id === "audit-destinations")).toMatchObject({
      status: "blocked",
    });
  });

  it("maps backend requirement states to UI status buckets", () => {
    expect(backendStatusToCheckStatus("ready")).toBe("ready");
    expect(backendStatusToCheckStatus("not_required")).toBe("not-required");
    expect(backendStatusToCheckStatus("missing")).toBe("blocked");
    expect(backendStatusToCheckStatus("unknown")).toBe("warning");
    expect(backendStatusToCheckStatus("degraded")).toBe("warning");
  });

  it("projects backend service gates onto service cards", () => {
    const service = serviceFromBackendRequirement(
      {
        id: "vault",
        name: "HashiCorp Vault",
        description: "Mandatory Tier 3+ secrets backend and rotation source",
        icon: (() => null) as never,
        status: "pending",
      },
      {
        key: "vault",
        label: "Vault",
        required: true,
        status: "missing",
        expected: { running: true },
        observed: { enabled: false, status: "missing" },
      },
    );

    expect(service.status).toBe("missing");
    expect(service.backendStatus).toBe("missing");
  });

  it("formats primitive backend field values without raw JSON for common shapes", () => {
    expect(
      formatRequirementFields({
        successfulBackupRequired: true,
        lastSuccessfulBackupAt: "2026-05-20T12:00:00Z",
      }),
    ).toEqual([
      { label: "Successful Backup Required", value: "Yes" },
      { label: "Last Successful Backup At", value: "2026-05-20T12:00:00Z" },
    ]);
  });
});

function requestBodyForCall<T = unknown>(call: Parameters<typeof fetch> | undefined): T {
  const body = call?.[1]?.body;
  if (typeof body !== "string") {
    throw new Error("Expected string request body.");
  }
  return JSON.parse(body) as T;
}

function platformPatchCall(): Parameters<typeof fetch> | undefined {
  return (globalThis.fetch as unknown as ReturnType<typeof vi.fn<typeof fetch>>).mock.calls.find(
    (call) => call[0] === "/api/admin/platform-config" && call[1]?.method === "PATCH",
  );
}

function pluginInstallCall(): Parameters<typeof fetch> | undefined {
  return (globalThis.fetch as unknown as ReturnType<typeof vi.fn<typeof fetch>>).mock.calls.find(
    (call) => call[0] === "/api/tools/plugin.install" && call[1]?.method === "POST",
  );
}

function pluginLifecycleCall(
  action: "enable" | "disable" | "uninstall",
): Parameters<typeof fetch> | undefined {
  return (globalThis.fetch as unknown as ReturnType<typeof vi.fn<typeof fetch>>).mock.calls.find(
    (call) => call[0] === `/api/tools/plugin.${action}` && call[1]?.method === "POST",
  );
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, reject, resolve };
}

function platformStatus(
  tier: PlatformConfigPatch["security"]["tier"],
  ready: boolean,
  ai?: {
    costLimits?: {
      perUserPerDayUSD?: number;
      perOrgPerDayUSD?: number;
      perAgentPerDayUSD?: number;
    };
    audit?: { logRequests?: "off" | "metadata-only" | "full"; retainDays?: number };
    privacy?: {
      classificationGating?: boolean;
      blockExternalForClassifications?: readonly string[];
    };
  },
) {
  return {
    config: {
      security: { tier },
      ...(ai === undefined ? {} : { ai }),
    },
    readiness: {
      ready,
      requirements: [
        {
          key: "auditDestinations",
          label: "Audit destinations",
          required: tier !== "personal",
          status: "ready",
          expected: { destinations: ["postgres", "immutable-s3"] },
          observed: { destinations: ["postgres", "immutable-s3"] },
        },
      ],
    },
  };
}

function enterpriseStatusWithEvidence() {
  return {
    config: {
      security: { tier: "enterprise" },
    },
    readiness: {
      ready: true,
      requirements: [
        {
          key: "auditDestinations",
          label: "Audit destinations",
          required: true,
          status: "ready",
          expected: { destinations: ["postgres", "immutable-s3", "siem"] },
          observed: { destinations: ["postgres", "immutable-s3", "siem"] },
        },
        {
          key: "vault",
          label: "Vault",
          required: true,
          status: "ready",
          expected: { running: true },
          observed: {
            enabled: true,
            endpoint: "https://vault.internal:8200",
            evidence: "Vault endpoint observed from runtime configuration.",
            status: "ready",
          },
        },
        {
          key: "siem",
          label: "SIEM",
          required: true,
          status: "ready",
          expected: { running: true },
          observed: {
            enabled: true,
            endpoint: "https://siem.internal/ingest",
            evidence: "SIEM endpoint observed from runtime configuration with CEF format.",
            status: "ready",
          },
        },
        {
          key: "cloudNativePg",
          label: "CloudNativePG",
          required: true,
          status: "ready",
          expected: { running: true },
          observed: {
            enabled: true,
            endpoint: "postgres://helix-postgres-rw:5432/helix",
            evidence: "CloudNativePG wiring observed from runtime configuration.",
            status: "ready",
          },
        },
      ],
    },
  };
}

function pluginCatalog() {
  return {
    plugins: [
      {
        id: "com.example.community",
        name: "Community importer",
        version: "1.2.3",
        kind: "in-process",
        capabilities: {
          provides: ["example.importer"],
          consumes: [],
        },
        permissions: {
          scopes: ["drive.write"],
          "outbound-network": ["api.example.com"],
          filesystem: [],
          envVars: [],
        },
        install: null,
        lifecycle: {
          state: "disabled",
          installed: true,
        },
        signature: null,
        tierRequirements: null,
      },
      {
        id: "com.example.mail-auditor",
        name: "Mail auditor",
        version: "0.9.0",
        kind: "in-process",
        capabilities: {
          provides: ["mail.audit"],
          consumes: ["mail.message"],
        },
        permissions: {
          scopes: ["mail.read"],
          "outbound-network": [],
          filesystem: [],
          envVars: [],
        },
        install: null,
        lifecycle: {
          state: "enabled",
          installed: true,
        },
        signature: { verified: true },
        tierRequirements: null,
      },
    ],
  };
}
