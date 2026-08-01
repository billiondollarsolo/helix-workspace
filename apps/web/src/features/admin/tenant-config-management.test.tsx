// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BOOLEAN_FEATURE_FLAG_GROUPS,
  BOOLEAN_FEATURE_FLAG_KEYS,
  TenantConfigManagement,
} from "./tenant-config-management";

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

describe("boolean feature-flag groups", () => {
  /* The form renders flags by walking the groups, so a flag missing from every
   * group is simply absent from the UI — no error, no empty row, nothing. This
   * is the only thing that catches it. */
  it("place every boolean flag in exactly one group", () => {
    const grouped = BOOLEAN_FEATURE_FLAG_GROUPS.flatMap((group) => [...group.keys]);
    expect(new Set(grouped).size, "a flag appears in more than one group").toBe(grouped.length);

    // Derived from the labels map the form uses, so this stays honest if the
    // flag list grows.
    const declared = new Set(BOOLEAN_FEATURE_FLAG_KEYS);
    expect([...declared].filter((key) => !grouped.includes(key)).sort()).toEqual([]);
    expect(grouped.filter((key) => !declared.has(key)).sort()).toEqual([]);
  });
});

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
      expect(container.textContent).toContain("Workspace settings");
      expect(container.textContent).toContain("AI smart compose");
      expect(container.textContent).toContain("Business plan defaults");
      expect(container.textContent).toContain("API RPS");
      expect(container.textContent).toContain("Override");
    });
    // The flag list is grouped rather than one flat column of 19 checkboxes.
    expect(
      [...container.querySelectorAll("fieldset > legend")].map((element) => element.textContent),
    ).toEqual(BOOLEAN_FEATURE_FLAG_GROUPS.map((group) => group.title));
    // The tenant id stays on the page, just not as the page's title.
    expect(container.textContent).toContain("org-1");
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
      /* The job is fully copied and verified, so nothing is holding the button
         back any more. The gate that used to live here — an inline checkbox —
         is retired; the assertion that it kept the button disabled went with
         it, because the consent it stood for is now the dialog below. */
      expect(buttonByLabel("Cut over storage").disabled).toBe(false);
    });
    expect(checkboxLabels()).not.toContain("Confirm migration cutover");
    // Destructive, not the card's third filled primary.
    expect(buttonByLabel("Cut over storage").dataset.variant).toBe("destructive");
    expect(postBody("/api/admin/tenant-config/byo-storage/migrations")).toMatchObject({
      target: "helix-default",
      dryRun: false,
    });

    await act(async () => {
      buttonByLabel("Cut over storage").click();
      await Promise.resolve();
    });

    // Opening the confirmation must not have repointed anything on its own.
    expect(cutoverCalls()).toHaveLength(0);
    expect(dialogText()).toContain("Cut over tenant storage");
    expect(dialogText()).toContain("org-1");
    expect(dialogText()).toContain("Helix default storage");
    // Real numbers off the job, not a generic "this cannot be undone".
    expect(blastRadiusText()).toContain("All 12 verified objects");
    expect(blastRadiusText()).toContain("tenant org-1");

    // Top tier: the action stays dead until the tenant id shown on the page is
    // typed, and a near miss does not count.
    expect(dialogButton("action").disabled).toBe(true);
    await typePhrase("org-2");
    expect(dialogButton("action").disabled).toBe(true);
    await typePhrase("org-1");
    expect(dialogButton("action").disabled).toBe(false);
    expect(cutoverCalls()).toHaveLength(0);

    await act(async () => {
      dialogButton("action").click();
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(container.textContent).toContain("Helix default storage live migration");
    });
    expect(postBody("/api/admin/tenant-config/byo-storage/migrations/")).toMatchObject({
      confirm: "CUTOVER",
    });
    expect(cutoverCalls()).toHaveLength(1);
    // The overlay blanks the page behind it; a dialog left open would hide the
    // migration panel that reports what happened.
    await waitFor(() => {
      expect(document.querySelector('[role="alertdialog"]')).toBeNull();
    });
    expect(fetchMock.mock.calls.filter((call) => call[1]?.method === "PATCH")).toHaveLength(0);
  });

  it("cancelling the cutover confirmation repoints nothing", async () => {
    mockSucceededLiveMigration();

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
      expect(buttonByLabel("Cut over storage").disabled).toBe(false);
    });

    await act(async () => {
      buttonByLabel("Cut over storage").click();
      await Promise.resolve();
    });
    await act(async () => {
      dialogButton("cancel").click();
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(document.querySelector('[role="alertdialog"]')).toBeNull();
    });
    expect(cutoverCalls()).toHaveLength(0);
    // A dismissed overlay that fails to restore pointer events leaves the whole
    // console unclickable.
    expect(document.body.style.pointerEvents).not.toBe("none");
  });

  it("says why cutover is blocked when the job has not verified every object", async () => {
    fetchMock.mockImplementation((input, init) => {
      const url = requestUrlOf(input);
      if (
        init?.method === "POST" &&
        url.includes("/api/admin/tenant-config/byo-storage/migrations")
      ) {
        return Promise.resolve(
          Response.json({
            migration: {
              ...liveStorageMigrationPayload.migration,
              copiedCount: 11,
              verifiedCount: 9,
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

    /* A dark button with no stated reason is a dead end: the panel has to say
       which count is short, not merely refuse. */
    await waitFor(() => {
      expect(buttonByLabel("Cut over storage").disabled).toBe(true);
      expect(container.textContent).toContain(
        "Cutover needs all 12 planned objects copied and verified — 11 copied, 9 verified so far.",
      );
    });

    await act(async () => {
      buttonByLabel("Cut over storage").click();
      await Promise.resolve();
    });
    expect(document.querySelector('[role="alertdialog"]')).toBeNull();
    expect(cutoverCalls()).toHaveLength(0);
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

  /* Progressive disclosure is only safe if the summary is honest about what it
   * is covering. These pin the two halves of that: rare/read-only detail folds
   * away, and anything already set stays visible. */
  it("folds read-only quotas away and says how many overrides are inside", async () => {
    fetchMock.mockResolvedValue(Response.json(tenantConfigPayload));

    await render();

    await waitFor(() => {
      expect(container.textContent).toContain("Business plan defaults");
    });
    const quotas = detailsBySummary("Effective limits");
    expect(quotas.querySelector("summary")?.textContent).toContain("2 tenant overrides");
    expect(quotas.querySelector("summary")?.textContent).toContain("Read-only");
    // Two quota keys carry a tenant override, so the panel must not start shut.
    expect(quotas.open).toBe(true);
    expect(quotas.textContent).toContain("API RPS");
  });

  it("reads an unreported quota as unknown rather than unlimited", async () => {
    fetchMock.mockResolvedValue(Response.json(tenantConfigPayload));

    await render();

    await waitFor(() => {
      expect(container.textContent).toContain("Business plan defaults");
    });
    const quotas = detailsBySummary("Effective limits");
    // The payload reports no `storage_bytes_limit` anywhere; claiming
    // "unlimited" would tell an operator the cap was lifted.
    expect(rowByLabel(quotas, "Storage bytes").textContent).toContain("Not reported");
    // `actors_limit` is an explicit null override — that one really is uncapped.
    expect(rowByLabel(quotas, "Actors").textContent).toContain("Unlimited");
    expect(container.textContent).not.toContain("unlimited");
  });

  it("keeps storage mode visible while folding the connection fields it gates", async () => {
    fetchMock.mockResolvedValue(Response.json(tenantConfigPayload));

    await render();

    await waitFor(() => {
      expect(selectByLabel("Storage mode").value).toBe("byo");
    });
    const connection = detailsBySummary("Connection details");
    // This tenant is on customer-owned storage: a live bucket must not be
    // hidden behind a closed lid.
    expect(connection.open).toBe(true);
    expect(connection.querySelector("summary")?.textContent).toContain("acme-helix-data");
    expect(connection.contains(inputByLabel("Bucket"))).toBe(true);
    // The decision itself stays at the top level, outside the disclosure.
    expect(connection.contains(selectByLabel("Storage mode"))).toBe(false);
  });

  it("starts the connection fields closed when Helix manages storage", async () => {
    fetchMock.mockResolvedValue(
      Response.json({
        tenantConfig: {
          ...tenantConfigPayload.tenantConfig,
          quotas: {},
          byo: { storage: { kind: "helix-default", prefix: "tenants/org-1/" } },
        },
      }),
    );

    await render();

    await waitFor(() => {
      expect(selectByLabel("Storage mode").value).toBe("helix-default");
    });
    const connection = detailsBySummary("Connection details");
    expect(connection.open).toBe(false);
    expect(connection.querySelector("summary")?.textContent).toContain("Helix manages the bucket");
    // Nothing is set, so the read-only quota panel folds away too.
    expect(detailsBySummary("Effective limits").open).toBe(false);
    expect(detailsBySummary("Effective limits").querySelector("summary")?.textContent).toContain(
      "no tenant overrides",
    );
  });

  it("keeps storage migration closed until a job exists, then reveals it", async () => {
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
      expect(buttonByLabel("Request migration").disabled).toBe(false);
    });
    const migration = detailsBySummary("Storage migration");
    expect(migration.open).toBe(false);
    expect(migration.querySelector("summary")?.textContent).toContain(
      "cutover repoints live reads",
    );

    await act(async () => {
      buttonByLabel("Request migration").click();
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(container.textContent).toContain("Planned 12, copied 0, verified 12");
    });
    // An in-flight migration is never left concealed.
    expect(migration.open).toBe(true);
    expect(migration.querySelector("summary")?.textContent).toContain("Dry Run");
  });

  it("gates the feature-flag save on there being something to save", async () => {
    fetchMock.mockResolvedValue(Response.json(tenantConfigPayload));

    await render();

    await waitFor(() => {
      expect(checkboxByLabel("AI smart compose").checked).toBe(true);
    });
    expect(buttonByLabel("Save feature flags").disabled).toBe(true);
    expect(container.textContent).toContain("No unsaved flag changes.");

    await act(async () => {
      checkboxByLabel("AI smart compose").click();
      await Promise.resolve();
    });

    expect(buttonByLabel("Save feature flags").disabled).toBe(false);
    expect(container.textContent).toContain("1 unsaved flag change.");
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
      candidate.textContent?.includes(label),
    );
    const field = match?.querySelector(selector);
    if (field === undefined || field === null) {
      throw new Error(`Field "${label}" not found.`);
    }
    return field;
  }

  function detailsBySummary(title: string): HTMLDetailsElement {
    const match = [...container.querySelectorAll("details")].find((candidate) =>
      candidate.querySelector("summary")?.textContent?.startsWith(title),
    );
    if (match === undefined) {
      throw new Error(`Disclosure "${title}" not found.`);
    }
    return match;
  }

  function rowByLabel(scope: HTMLElement, label: string): HTMLElement {
    const row = [...scope.querySelectorAll<HTMLElement>('[role="listitem"]')].find((candidate) =>
      candidate.textContent?.startsWith(label),
    );
    if (row === undefined) {
      throw new Error(`Quota row "${label}" not found.`);
    }
    return row;
  }

  function buttonByLabel(label: string): HTMLButtonElement {
    const button = [...container.querySelectorAll("button")].find(
      (candidate) => candidate.textContent?.trim() === label,
    );
    if (button === undefined) {
      throw new Error(`Button "${label}" not found.`);
    }
    return button;
  }

  function checkboxLabels(): readonly string[] {
    return [...container.querySelectorAll("label")]
      .filter((label) => label.querySelector('input[type="checkbox"]') !== null)
      .map((label) => label.textContent?.trim() ?? "");
  }

  function mockSucceededLiveMigration(): void {
    fetchMock.mockImplementation((input, init) => {
      const url = requestUrlOf(input);
      if (init?.method === "POST" && url.endsWith("/cutover")) {
        return Promise.resolve(
          Response.json({
            ...liveStorageMigrationPayload,
            tenantConfig: {
              ...tenantConfigPayload.tenantConfig,
              byo: { storage: { kind: "helix-default", prefix: "tenants/org-1/" } },
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
  }

  function cutoverCalls() {
    return fetchMock.mock.calls.filter((call) => requestUrlOf(call[0]).endsWith("/cutover"));
  }

  // The confirmation is portaled to document.body, not into the section.
  function dialogText(): string {
    return document.querySelector('[role="alertdialog"]')?.textContent ?? "";
  }

  function blastRadiusText(): string {
    return document.body.querySelector(".admin-confirm-blast")?.textContent ?? "";
  }

  function dialogButton(slot: "action" | "cancel"): HTMLButtonElement {
    const button = document.body.querySelector<HTMLButtonElement>(
      `[data-slot="alert-dialog-${slot}"]`,
    );
    if (button === null) {
      throw new Error(`Dialog ${slot} button not found.`);
    }
    return button;
  }

  async function typePhrase(value: string): Promise<void> {
    const input = document.body.querySelector<HTMLInputElement>(".admin-confirm-phrase input");
    if (input === null) {
      throw new Error("Confirmation phrase input not found.");
    }
    await act(async () => {
      setInputValue(input, value);
      await Promise.resolve();
    });
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
