// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TenantConfigManagement } from "./tenant-config-management";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const tenantConfigPayload = {
  tenantConfig: {
    orgId: "org-1",
    byo: {
      storage: {
        kind: "byo",
        provider: "s3-compatible",
        endpoint: "https://storage.example.com",
        region: "us-east-1",
        bucket: "acme-helix-data",
        prefix: "helix/",
        credentials_vault_path: "tenants/org-1/byo-storage/s3",
        force_path_style: true,
        encryption: {
          sse_kms_key_arn: "arn:aws:kms:us-east-1:123456789012:key/acme",
        },
      },
    },
    features: {
      ai_smart_compose: true,
      dlp_enforcement: "warn",
      support_tier: "priority-24h",
    },
    quotas: {
      api_rps_limit: 10,
      actors_limit: null,
    },
    plan: {
      id: "business",
      displayName: "Business",
      featureFlagsDefault: {
        byo_storage: true,
      },
      quotasDefault: {
        api_rps_limit: 25,
        actors_limit: 500,
      },
    },
    effective: {
      byo: {},
      features: {
        ai_smart_compose: true,
        dlp_enforcement: "warn",
        support_tier: "priority-24h",
        byo_storage: true,
      },
      quotas: {
        api_rps_limit: 10,
        actors_limit: 500,
      },
      branding: {
        display_name_override: "Acme",
        accent_color_hex: "#2f6fed",
        logo_url: "https://example.com/logo.png",
      },
    },
    branding: {
      display_name_override: "Acme",
      accent_color_hex: "#2f6fed",
      logo_url: "https://example.com/logo.png",
    },
  },
};

const storageMigrationPayload = {
  migration: {
    id: "5f0951a7-8e65-4634-a6a4-af2f2b4797da",
    orgId: "org-1",
    target: "helix-default",
    status: "dry_run",
    dryRun: true,
    sourceStorage: {
      managedBy: "byo",
      storage: {
        kind: "byo",
        provider: "s3-compatible",
        endpoint: "https://storage.example.com",
        region: "us-east-1",
        bucket: "acme-helix-data",
        prefix: "helix/",
        credentials_vault_path: "tenants/org-1/byo-storage/s3",
        force_path_style: true,
      },
    },
    targetStorage: {
      managedBy: "helix-default",
      storage: null,
    },
    plannedCount: 12,
    copiedCount: 0,
    verifiedCount: 12,
    failures: [],
    lastError: null,
    attemptCount: 1,
    requestedByActorId: "actor-1",
    startedAt: "2026-05-25T10:00:00.000Z",
    completedAt: "2026-05-25T10:01:00.000Z",
    createdAt: "2026-05-25T10:00:00.000Z",
    updatedAt: "2026-05-25T10:01:00.000Z",
  },
};

const liveStorageMigrationPayload = {
  migration: {
    ...storageMigrationPayload.migration,
    target: "helix-default",
    status: "succeeded",
    dryRun: false,
    plannedCount: 12,
    copiedCount: 12,
    verifiedCount: 12,
    completedAt: "2026-05-25T10:01:00.000Z",
  },
};

describe("TenantConfigManagement", () => {
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

  it("renders tenant config sections from the admin API", async () => {
    fetchMock.mockResolvedValue(Response.json(tenantConfigPayload));

    await render();

    await waitFor(() => {
      expect(container.textContent).toContain("Tenant settings");
      expect(container.textContent).toContain("AI smart compose");
      expect(container.textContent).toContain("Business plan defaults");
      expect(container.textContent).toContain("API RPS");
      expect(container.textContent).toContain("Override");
    });
    expect(inputByLabel("Display name").value).toBe("Acme");
    expect(selectByLabel("DLP enforcement").value).toBe("warn");
    expect(selectByLabel("Storage mode").value).toBe("byo");
    expect(selectByLabel("Provider").value).toBe("s3-compatible");
    expect(inputByLabel("Bucket").value).toBe("acme-helix-data");
    expect(inputByLabel("Credentials Vault path").value).toBe("tenants/org-1/byo-storage/s3");
    expect(inputByLabel("SSE-KMS key ARN").value).toBe(
      "arn:aws:kms:us-east-1:123456789012:key/acme",
    );
    expect(requestUrlOf(fetchMock.mock.calls[0]?.[0])).toContain("/api/admin/tenant-config");
  });

  it("saves feature flags without writing quotas or branding", async () => {
    fetchMock.mockResolvedValue(Response.json(tenantConfigPayload));

    await render();

    await waitFor(() => {
      expect(checkboxByLabel("AI smart compose").checked).toBe(true);
      expect(selectByLabel("DLP enforcement").value).toBe("warn");
    });
    await act(async () => {
      checkboxByLabel("AI smart compose").click();
      selectByLabel("DLP enforcement").value = "block";
      selectByLabel("DLP enforcement").dispatchEvent(new Event("change", { bubbles: true }));
      buttonByLabel("Save feature flags").click();
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(patchBody()).toMatchObject({
        reason: "admin settings update: features",
      });
    });
    expect(patchBody().features).toStrictEqual({
      ai_smart_compose: false,
      dlp_enforcement: "block",
    });
    expect(patchBody()).not.toHaveProperty("quotas");
    expect(patchBody()).not.toHaveProperty("branding");
  });

  it("shows plan-aware effective quotas without presenting normal quota editing", async () => {
    fetchMock.mockResolvedValue(Response.json(tenantConfigPayload));

    await render();

    await waitFor(() => {
      expect(container.textContent).toContain("Business plan defaults");
      expect(container.textContent).toContain("API RPS");
      expect(container.textContent).toContain("25");
      expect(container.textContent).toContain("10");
      expect(container.textContent).toContain("Actors");
      expect(container.textContent).toContain("500");
    });
    expect(() => inputByLabel("API RPS")).toThrow('Field "API RPS" not found.');
    expect(() => buttonByLabel("Save quotas")).toThrow('Button "Save quotas" not found.');
    expect(fetchMock.mock.calls.filter((call) => call[1]?.method === "PATCH")).toHaveLength(0);
  });

  it("omits blank branding values when saving", async () => {
    fetchMock.mockResolvedValue(Response.json(tenantConfigPayload));

    await render();

    await waitFor(() => {
      expect(inputByLabel("Display name").value).toBe("Acme");
      expect(inputByLabel("Logo URL").value).toBe("https://example.com/logo.png");
    });
    await act(async () => {
      setInputValue(inputByLabel("Display name"), "Helix Labs");
      setInputValue(inputByLabel("Logo URL"), "");
      buttonByLabel("Save branding").click();
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(patchBody()).toMatchObject({
        branding: {
          display_name_override: "Helix Labs",
          accent_color_hex: "#2f6fed",
        },
        reason: "admin settings update: branding",
      });
    });
    expect(patchBody().branding).not.toHaveProperty("logo_url");
    expect(patchBody()).not.toHaveProperty("features");
    expect(patchBody()).not.toHaveProperty("quotas");
  });

  it("saves BYO storage and atomically enables the feature flag", async () => {
    fetchMock.mockResolvedValue(Response.json(tenantConfigPayload));

    await render();

    await waitFor(() => {
      expect(selectByLabel("Storage mode").value).toBe("byo");
      expect(inputByLabel("Bucket").value).toBe("acme-helix-data");
    });
    await act(async () => {
      setSelectValue(selectByLabel("Provider"), "r2");
      setInputValue(inputByLabel("Endpoint"), "https://account.r2.cloudflarestorage.com");
      setInputValue(inputByLabel("Bucket"), "acme-r2-data");
      setInputValue(inputByLabel("Prefix"), "docs/");
      setInputValue(inputByLabel("Credentials Vault path"), "tenants/org-1/byo-storage/r2");
      setInputValue(inputByLabel("SSE-KMS key ARN"), "arn:aws:kms:us-east-1:123456789012:key/r2");
      buttonByLabel("Save BYO storage").click();
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(patchBody()).toMatchObject({
        byo: {
          storage: {
            kind: "byo",
            provider: "r2",
            endpoint: "https://account.r2.cloudflarestorage.com",
            region: "us-east-1",
            bucket: "acme-r2-data",
            prefix: "docs/",
            credentials_vault_path: "tenants/org-1/byo-storage/r2",
            force_path_style: true,
            encryption: {
              sse_kms_key_arn: "arn:aws:kms:us-east-1:123456789012:key/r2",
            },
          },
        },
        reason: "admin settings update: byo storage",
      });
    });
    expect(patchBody().features).toStrictEqual({ byo_storage: true });
    expect(patchBody()).not.toHaveProperty("quotas");
    expect(patchBody()).not.toHaveProperty("branding");
  });

  it("tests BYO storage and renders the returned health result", async () => {
    fetchMock.mockImplementation((_input, init) => {
      if (init?.method === "POST") {
        return Promise.resolve(
          Response.json({
            health: {
              status: "healthy",
              checked_at: "2026-05-24T09:00:00.000Z",
              message: "Tenant object storage write/read/delete probe succeeded.",
              managedBy: "byo",
              prefix: "helix/",
            },
          }),
        );
      }
      return Promise.resolve(Response.json(tenantConfigPayload));
    });

    await render();

    await waitFor(() => {
      expect(buttonByLabel("Test storage").disabled).toBe(false);
    });
    await act(async () => {
      buttonByLabel("Test storage").click();
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(container.textContent).toContain(
        "Tenant object storage write/read/delete probe succeeded.",
      );
      expect(container.textContent).toContain("(byo)");
      expect(container.textContent).toContain("prefix helix/");
    });
    const postCall = fetchMock.mock.calls.find((call) => call[1]?.method === "POST");
    expect(requestUrlOf(postCall?.[0])).toContain("/api/admin/tenant-config/byo-storage/test");
  });

  it("rotates BYO storage credentials without patching tenant config secrets", async () => {
    fetchMock.mockImplementation((input, init) => {
      if (
        init?.method === "POST" &&
        requestUrlOf(input).includes("/api/admin/tenant-config/byo-storage/credentials")
      ) {
        return Promise.resolve(
          Response.json({
            credentials: {
              credentials_vault_path: "tenants/org-1/byo-storage/s3",
              rotated: true,
            },
            health: {
              status: "healthy",
              checked_at: "2026-05-24T09:00:00.000Z",
              message: "Tenant object storage write/read/delete probe succeeded.",
              managedBy: "byo",
              prefix: "helix/",
            },
          }),
        );
      }
      return Promise.resolve(Response.json(tenantConfigPayload));
    });

    await render();

    await waitFor(() => {
      expect(buttonByLabel("Rotate credentials").disabled).toBe(true);
      expect(inputByLabel("Access key ID").disabled).toBe(false);
    });
    await act(async () => {
      setInputValue(inputByLabel("Access key ID"), "rotated-access-key");
      setInputValue(inputByLabel("Secret access key"), "rotated-secret-key");
      setInputValue(inputByLabel("Session token"), "rotated-session-token");
      checkboxByLabel("Confirm credential rotation").click();
      buttonByLabel("Rotate credentials").click();
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(container.textContent).toContain("Credential rotation healthy.");
      expect(container.textContent).toContain(
        "Tenant object storage write/read/delete probe succeeded.",
      );
    });
    expect(postBody("/api/admin/tenant-config/byo-storage/credentials")).toStrictEqual({
      credentials: {
        accessKeyId: "rotated-access-key",
        secretAccessKey: "rotated-secret-key",
        sessionToken: "rotated-session-token",
      },
      reason: "admin settings update: byo storage credentials",
    });
    expect(inputByLabel("Access key ID").value).toBe("");
    expect(inputByLabel("Secret access key").value).toBe("");
    expect(fetchMock.mock.calls.filter((call) => call[1]?.method === "PATCH")).toHaveLength(0);
  });

  it("surfaces credential rotation errors without patching tenant config", async () => {
    fetchMock.mockImplementation((input, init) => {
      if (
        init?.method === "POST" &&
        requestUrlOf(input).includes("/api/admin/tenant-config/byo-storage/credentials")
      ) {
        return Promise.resolve(
          Response.json(
            { error: "BYO storage credential writer is not configured." },
            { status: 503 },
          ),
        );
      }
      return Promise.resolve(Response.json(tenantConfigPayload));
    });

    await render();

    await waitFor(() => {
      expect(inputByLabel("Access key ID").disabled).toBe(false);
    });
    await act(async () => {
      setInputValue(inputByLabel("Access key ID"), "rotated-access-key");
      setInputValue(inputByLabel("Secret access key"), "rotated-secret-key");
      checkboxByLabel("Confirm credential rotation").click();
      buttonByLabel("Rotate credentials").click();
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(container.textContent).toContain("BYO storage credential writer is not configured.");
    });
    expect(fetchMock.mock.calls.filter((call) => call[1]?.method === "PATCH")).toHaveLength(0);
  });

  it("requests a storage migration dry run without mutating tenant config", async () => {
    fetchMock.mockImplementation((input, init) => {
      if (
        init?.method === "POST" &&
        requestUrlOf(input).includes("/api/admin/tenant-config/byo-storage/migrations")
      ) {
        return Promise.resolve(Response.json(storageMigrationPayload));
      }
      return Promise.resolve(Response.json(tenantConfigPayload));
    });

    await render();

    await waitFor(() => {
      expect(selectByLabel("Migration target").value).toBe("helix-default");
      expect(checkboxByLabel("Dry run only").checked).toBe(true);
    });
    await act(async () => {
      buttonByLabel("Request migration").click();
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(container.textContent).toContain("Dry Run");
      expect(container.textContent).toContain("Planned 12, copied 0, verified 12");
    });
    expect(postBody("/api/admin/tenant-config/byo-storage/migrations")).toMatchObject({
      target: "helix-default",
      dryRun: true,
      sourceStorage: {
        kind: "byo",
        provider: "s3-compatible",
        bucket: "acme-helix-data",
        credentials_vault_path: "tenants/org-1/byo-storage/s3",
      },
    });
    expect(fetchMock.mock.calls.filter((call) => call[1]?.method === "PATCH")).toHaveLength(0);
  });

  it("renders storage migration history without blocking tenant settings", async () => {
    fetchMock.mockImplementation((input, init) => {
      const url = requestUrlOf(input);
      if (
        init?.method === "GET" &&
        url.includes("/api/admin/tenant-config/byo-storage/migrations")
      ) {
        return Promise.resolve(
          Response.json({
            migrations: [
              storageMigrationPayload.migration,
              {
                ...liveStorageMigrationPayload.migration,
                id: "6f0951a7-8e65-4634-a6a4-af2f2b4797db",
                createdAt: "2026-05-25T09:00:00.000Z",
              },
            ],
            nextCursor: "cursor-2",
          }),
        );
      }
      return Promise.resolve(Response.json(tenantConfigPayload));
    });

    await render();

    await waitFor(() => {
      expect(container.textContent).toContain("Migration history");
      expect(container.textContent).toContain("Dry Run");
      expect(container.textContent).toContain("Succeeded");
      expect(container.textContent).toContain("More migration jobs are available in history.");
      expect(inputByLabel("Display name").value).toBe("Acme");
    });
    expect(fetchMock.mock.calls.some((call) => requestUrlOf(call[0]).endsWith("?limit=10"))).toBe(
      true,
    );
  });

  it("shows migration history errors without blocking tenant settings", async () => {
    fetchMock.mockImplementation((input, init) => {
      const url = requestUrlOf(input);
      if (
        init?.method === "GET" &&
        url.includes("/api/admin/tenant-config/byo-storage/migrations")
      ) {
        return Promise.resolve(Response.json({ error: "history unavailable" }, { status: 503 }));
      }
      return Promise.resolve(Response.json(tenantConfigPayload));
    });

    await render();

    await waitFor(() => {
      expect(container.textContent).toContain("Storage migration history unavailable.");
      expect(inputByLabel("Display name").value).toBe("Acme");
    });
  });

  it("refreshes the latest storage migration status", async () => {
    fetchMock.mockImplementation((input, init) => {
      const url = requestUrlOf(input);
      if (
        init?.method === "POST" &&
        url.includes("/api/admin/tenant-config/byo-storage/migrations")
      ) {
        return Promise.resolve(Response.json(storageMigrationPayload));
      }
      if (
        init?.method === "GET" &&
        url.includes("/api/admin/tenant-config/byo-storage/migrations/")
      ) {
        return Promise.resolve(
          Response.json({
            migration: {
              ...storageMigrationPayload.migration,
              status: "running",
              dryRun: false,
              plannedCount: 12,
              copiedCount: 4,
              verifiedCount: 3,
              completedAt: null,
              updatedAt: "2026-05-25T10:02:00.000Z",
            },
          }),
        );
      }
      return Promise.resolve(Response.json(tenantConfigPayload));
    });

    await render();

    await waitFor(() => {
      expect(buttonByLabel("Request migration").disabled).toBe(false);
    });
    await act(async () => {
      checkboxByLabel("Dry run only").click();
      checkboxByLabel("Confirm live migration request").click();
      buttonByLabel("Request migration").click();
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(buttonByLabel("Refresh status").disabled).toBe(false);
    });
    await act(async () => {
      buttonByLabel("Refresh status").click();
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(container.textContent).toContain("Running");
      expect(container.textContent).toContain("Planned 12, copied 4, verified 3");
    });
    const getCall = fetchMock.mock.calls.find(
      (call) =>
        call[1]?.method === "GET" &&
        requestUrlOf(call[0]).includes("/api/admin/tenant-config/byo-storage/migrations/"),
    );
    expect(requestUrlOf(getCall?.[0])).toContain(storageMigrationPayload.migration.id);
  });

  it("requires confirmation before requesting live migration and cutting over", async () => {
    fetchMock.mockImplementation((input, init) => {
      const url = requestUrlOf(input);
      if (
        init?.method === "POST" &&
        url.includes("/api/admin/tenant-config/byo-storage/migrations/") &&
        url.endsWith("/cutover")
      ) {
        return Promise.resolve(
          Response.json({
            ...liveStorageMigrationPayload,
            tenantConfig: {
              ...tenantConfigPayload.tenantConfig,
              byo: {
                storage: {
                  kind: "helix-default",
                  prefix: "tenants/org-1/",
                },
              },
            },
          }),
        );
      }
      if (
        init?.method === "POST" &&
        url.includes("/api/admin/tenant-config/byo-storage/migrations")
      ) {
        return Promise.resolve(Response.json(liveStorageMigrationPayload));
      }
      return Promise.resolve(Response.json(tenantConfigPayload));
    });

    await render();

    await waitFor(() => {
      expect(buttonByLabel("Request migration").disabled).toBe(false);
    });
    await act(async () => {
      checkboxByLabel("Dry run only").click();
      await Promise.resolve();
    });
    expect(buttonByLabel("Request migration").disabled).toBe(true);

    await act(async () => {
      checkboxByLabel("Confirm live migration request").click();
      buttonByLabel("Request migration").click();
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(container.textContent).toContain("Succeeded");
      expect(container.textContent).toContain("Planned 12, copied 12, verified 12");
      expect(buttonByLabel("Cut over storage").disabled).toBe(true);
    });
    expect(postBody("/api/admin/tenant-config/byo-storage/migrations")).toMatchObject({
      target: "helix-default",
      dryRun: false,
    });

    await act(async () => {
      checkboxByLabel("Confirm migration cutover").click();
      buttonByLabel("Cut over storage").click();
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(container.textContent).toContain("Helix default storage live migration");
    });
    expect(postBody("/api/admin/tenant-config/byo-storage/migrations/")).toMatchObject({
      confirm: "CUTOVER",
    });
    expect(fetchMock.mock.calls.some((call) => requestUrlOf(call[0]).endsWith("/cutover"))).toBe(
      true,
    );
    expect(fetchMock.mock.calls.filter((call) => call[1]?.method === "PATCH")).toHaveLength(0);
  });

  it("surfaces storage migration request errors without mutating tenant config", async () => {
    fetchMock.mockImplementation((input, init) => {
      if (
        init?.method === "POST" &&
        requestUrlOf(input).includes("/api/admin/tenant-config/byo-storage/migrations")
      ) {
        return Promise.resolve(
          Response.json(
            {
              error:
                "Live tenant storage migration requires staged source and target storage snapshots.",
            },
            { status: 409 },
          ),
        );
      }
      return Promise.resolve(Response.json(tenantConfigPayload));
    });

    await render();

    await waitFor(() => {
      expect(buttonByLabel("Request migration").disabled).toBe(false);
    });
    await act(async () => {
      checkboxByLabel("Dry run only").click();
      checkboxByLabel("Confirm live migration request").click();
      buttonByLabel("Request migration").click();
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(container.textContent).toContain(
        "Live tenant storage migration requires staged source and target storage snapshots.",
      );
    });
    expect(fetchMock.mock.calls.filter((call) => call[1]?.method === "PATCH")).toHaveLength(0);
  });

  it("saves Helix default storage without forcing the BYO feature flag", async () => {
    fetchMock.mockResolvedValue(Response.json(tenantConfigPayload));

    await render();

    await waitFor(() => {
      expect(selectByLabel("Storage mode").value).toBe("byo");
    });
    await act(async () => {
      setSelectValue(selectByLabel("Storage mode"), "helix-default");
      setInputValue(inputByLabel("Prefix"), "tenants/org-1/");
      buttonByLabel("Save BYO storage").click();
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(patchBody()).toMatchObject({
        byo: {
          storage: {
            kind: "helix-default",
            prefix: "tenants/org-1/",
          },
        },
        reason: "admin settings update: byo storage",
      });
    });
    expect(patchBody()).not.toHaveProperty("features");
    expect(patchBody()).not.toHaveProperty("quotas");
    expect(patchBody()).not.toHaveProperty("branding");
  });

  it("rejects invalid BYO storage before calling the backend", async () => {
    fetchMock.mockResolvedValue(Response.json(tenantConfigPayload));

    await render();

    await waitFor(() => {
      expect(inputByLabel("Prefix").value).toBe("helix/");
    });
    await act(async () => {
      setInputValue(inputByLabel("Prefix"), "../bad");
      buttonByLabel("Save BYO storage").click();
      await Promise.resolve();
    });

    expect(container.textContent).toContain("BYO storage prefix must not contain path traversal");
    expect(fetchMock.mock.calls.filter((call) => call[1]?.method === "PATCH")).toHaveLength(0);
  });

  it("requires BYO storage endpoint and scoped Vault path before calling the backend", async () => {
    fetchMock.mockResolvedValue(Response.json(tenantConfigPayload));

    await render();

    await waitFor(() => {
      expect(selectByLabel("Provider").value).toBe("s3-compatible");
    });
    await act(async () => {
      setInputValue(inputByLabel("Endpoint"), "");
      buttonByLabel("Save BYO storage").click();
      await Promise.resolve();
    });

    expect(container.textContent).toContain("BYO storage endpoint is required for this provider.");
    expect(fetchMock.mock.calls.filter((call) => call[1]?.method === "PATCH")).toHaveLength(0);

    await act(async () => {
      setSelectValue(selectByLabel("Provider"), "aws-s3");
      setInputValue(inputByLabel("Credentials Vault path"), "secret/aws");
      buttonByLabel("Save BYO storage").click();
      await Promise.resolve();
    });

    expect(container.textContent).toContain(
      "Credentials Vault path must be scoped under tenants/{tenant}/byo-storage/.",
    );
    expect(fetchMock.mock.calls.filter((call) => call[1]?.method === "PATCH")).toHaveLength(0);
  });

  it("shows an unavailable state when the admin API rejects the request", async () => {
    fetchMock.mockResolvedValue(
      Response.json({ error: "Missing required scope" }, { status: 403 }),
    );

    await render();

    await waitFor(() => {
      expect(container.textContent).toContain("Tenant settings are unavailable.");
    });
  });

  async function render(): Promise<void> {
    await act(() => {
      root.render(
        createElement(
          QueryClientProvider,
          { client: queryClient },
          createElement(TenantConfigManagement),
        ),
      );
      return Promise.resolve();
    });
  }

  function patchBody(): Record<string, unknown> {
    const call = fetchMock.mock.calls.find((candidate) => candidate[1]?.method === "PATCH");
    if (call === undefined || typeof call[1]?.body !== "string") {
      throw new Error("PATCH request not found.");
    }
    return JSON.parse(call[1].body) as Record<string, unknown>;
  }

  function postBody(urlPart: string): Record<string, unknown> {
    const call = fetchMock.mock.calls.find(
      (candidate) =>
        candidate[1]?.method === "POST" && requestUrlOf(candidate[0]).includes(urlPart),
    );
    if (call === undefined || typeof call[1]?.body !== "string") {
      throw new Error(`POST request for "${urlPart}" not found.`);
    }
    return JSON.parse(call[1].body) as Record<string, unknown>;
  }

  function checkboxByLabel(label: string): HTMLInputElement {
    const input = inputByLabel(label);
    if (input.type !== "checkbox") {
      throw new Error(`Checkbox "${label}" not found.`);
    }
    return input;
  }

  function inputByLabel(label: string): HTMLInputElement {
    const element = fieldByLabel(label, "input");
    if (!(element instanceof HTMLInputElement)) {
      throw new Error(`Input "${label}" not found.`);
    }
    return element;
  }

  function selectByLabel(label: string): HTMLSelectElement {
    const element = fieldByLabel(label, "select");
    if (!(element instanceof HTMLSelectElement)) {
      throw new Error(`Select "${label}" not found.`);
    }
    return element;
  }

  function fieldByLabel(label: string, selector: "input" | "select"): Element {
    const match = [...container.querySelectorAll("label")].find((candidate) =>
      candidate.textContent.includes(label),
    );
    const field = match?.querySelector(selector);
    if (field === undefined || field === null) {
      throw new Error(`Field "${label}" not found.`);
    }
    return field;
  }

  function buttonByLabel(label: string): HTMLButtonElement {
    const button = [...container.querySelectorAll("button")].find(
      (candidate) => candidate.textContent.trim() === label,
    );
    if (button === undefined) {
      throw new Error(`Button "${label}" not found.`);
    }
    return button;
  }
});

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
