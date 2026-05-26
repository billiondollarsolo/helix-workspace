import { expect, test, type Page, type Route } from "@playwright/test";
import { fulfillCoreAppsRoute } from "./support/api-fixtures";

const accessTokenStorageKey = "helix.accessToken";
const adminToken = "e2e-admin-token";
const expectedAuthorization = `Bearer ${adminToken}`;

interface BackendCall {
  readonly authorization: string | null;
  readonly body: unknown;
  readonly method: string;
  readonly pathname: string;
  readonly search: string;
}

test.describe("/admin tenant storage migration", () => {
  test("drives dry-run, live request, refresh, and guarded cutover from Settings", async ({
    page,
  }) => {
    const backendCalls: BackendCall[] = [];
    const state = {
      latestMigration: null as TenantStorageMigration | null,
    };

    await page.addInitScript(
      ({ key, token }) => {
        window.localStorage.setItem(key, token);
      },
      { key: accessTokenStorageKey, token: adminToken },
    );
    await mockTenantStorageMigrationBackend(page, backendCalls, state);

    await page.goto("/admin");
    await page.getByRole("complementary").getByRole("button", { name: "Settings" }).click();

    const storageForm = page.getByRole("form", { name: "BYO storage" });
    await expect(storageForm.getByRole("heading", { name: "Storage migration" })).toBeVisible();
    await expect(storageForm.getByRole("heading", { name: "Migration history" })).toBeVisible();
    await expect(storageForm.getByText("No storage migration jobs yet.")).toBeVisible();
    await expect(storageForm.getByLabel("Migration target")).toHaveValue("byo");
    await storageForm.getByLabel("Storage mode").selectOption("byo");
    await storageForm.getByLabel("Provider").selectOption("s3-compatible");
    await storageForm.getByLabel("Endpoint").fill("https://storage.example.com");
    await storageForm.getByLabel("Region").fill("us-east-1");
    await storageForm.getByLabel("Bucket").fill("acme-helix-data");
    await storageForm.getByLabel("Prefix").fill("helix/");
    await storageForm.getByLabel("Credentials Vault path").fill("tenants/org-e2e/byo-storage/s3");

    await storageForm.getByRole("button", { name: "Request migration" }).click();

    let activeJob = storageForm
      .getByRole("status")
      .filter({ hasText: "Target customer-owned storage dry run" });
    await expect(activeJob.getByText("Dry Run", { exact: true })).toBeVisible();
    await expect(activeJob.getByText("Planned 12, copied 0, verified 12")).toBeVisible();
    expect(migrationRequestBodies(backendCalls)).toContainEqual(
      expect.objectContaining({
        target: "byo",
        dryRun: true,
        targetStorage: expect.objectContaining({
          kind: "byo",
          provider: "s3-compatible",
          bucket: "acme-helix-data",
          credentials_vault_path: "tenants/org-e2e/byo-storage/s3",
        }),
      }),
    );

    await storageForm.getByLabel("Dry run only").uncheck();
    await expect(storageForm.getByRole("button", { name: "Request migration" })).toBeDisabled();
    await storageForm.getByLabel("Confirm live migration request").check();
    await storageForm.getByRole("button", { name: "Request migration" }).click();

    activeJob = storageForm
      .getByRole("status")
      .filter({ hasText: "Target customer-owned storage live migration" });
    await expect(activeJob.getByText("Running", { exact: true })).toBeVisible();
    expect(migrationRequestBodies(backendCalls)).toContainEqual(
      expect.objectContaining({
        target: "byo",
        dryRun: false,
      }),
    );

    state.latestMigration = migrationJob({
      id: "migration-live",
      dryRun: false,
      status: "succeeded",
      plannedCount: 12,
      copiedCount: 12,
      verifiedCount: 12,
      startedAt: "2026-05-25T10:02:00.000Z",
      completedAt: "2026-05-25T10:03:00.000Z",
      updatedAt: "2026-05-25T10:03:00.000Z",
    });
    await storageForm.getByRole("button", { name: "Refresh status" }).click();

    await expect(activeJob.getByText("Succeeded", { exact: true })).toBeVisible();
    await expect(activeJob.getByText("Planned 12, copied 12, verified 12")).toBeVisible();
    await expect(activeJob.getByRole("button", { name: "Cut over storage" })).toBeDisabled();
    expect(backendCalls).toContainEqual(
      expect.objectContaining({
        method: "GET",
        pathname: "/api/admin/tenant-config/byo-storage/migrations/migration-live",
      }),
    );

    await activeJob.getByLabel("Confirm migration cutover").check();
    await expect(activeJob.getByRole("button", { name: "Cut over storage" })).toBeEnabled();
    await activeJob.getByRole("button", { name: "Cut over storage" }).click();

    await expect.poll(() => cutoverRequestBodies(backendCalls)).toEqual([{ confirm: "CUTOVER" }]);
    await expect(storageForm.getByLabel("Storage mode")).toHaveValue("byo");
    expect(
      backendCalls
        .filter((call) => call.pathname !== "/api/auth/get-session")
        .every((call) => call.authorization === expectedAuthorization),
    ).toBe(true);
  });
});

async function mockTenantStorageMigrationBackend(
  page: Page,
  backendCalls: BackendCall[],
  state: { latestMigration: TenantStorageMigration | null },
) {
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const body = parsePostData(request.postData());
    const call = {
      authorization: request.headers().authorization ?? null,
      body,
      method: request.method(),
      pathname: url.pathname,
      search: url.search,
    } satisfies BackendCall;
    backendCalls.push(call);

    if (call.method === "GET" && call.pathname === "/api/auth/get-session") {
      await fulfillJson(route, {
        user: {
          id: "user-admin-e2e",
          email: "admin-e2e@example.test",
          name: "E2E Admin",
          actorId: "actor-admin-e2e",
        },
      });
      return;
    }

    if (call.authorization !== expectedAuthorization) {
      await fulfillJson(route, { error: "missing bearer token" }, 401);
      return;
    }

    if (await fulfillCoreAppsRoute(route)) {
      return;
    }

    if (call.method === "POST" && call.pathname === "/api/tools/notifications.unread-count") {
      await fulfillJson(route, { count: 0 });
      return;
    }
    if (call.method === "POST" && call.pathname === "/api/tools/notifications.list") {
      await fulfillJson(route, { items: [] });
      return;
    }

    if (call.method === "GET" && call.pathname === "/api/admin/tenant-config") {
      await fulfillJson(route, tenantConfigResponse());
      return;
    }

    if (
      call.method === "GET" &&
      call.pathname === "/api/admin/tenant-config/byo-storage/migrations"
    ) {
      await fulfillJson(route, {
        migrations: state.latestMigration === null ? [] : [state.latestMigration],
        nextCursor: null,
      });
      return;
    }

    if (
      call.method === "POST" &&
      call.pathname === "/api/admin/tenant-config/byo-storage/migrations"
    ) {
      const dryRun = requestBodyRecord(call.body).dryRun !== false;
      state.latestMigration = dryRun
        ? migrationJob({
            id: "migration-dry-run",
            dryRun: true,
            status: "dry_run",
            plannedCount: 12,
            copiedCount: 0,
            verifiedCount: 12,
          })
        : migrationJob({
            id: "migration-live",
            dryRun: false,
            status: "running",
            plannedCount: 12,
            copiedCount: 4,
            verifiedCount: 3,
            completedAt: null,
          });
      await fulfillJson(route, { migration: state.latestMigration });
      return;
    }

    const migrationMatch =
      /^\/api\/admin\/tenant-config\/byo-storage\/migrations\/(?<id>[^/]+)$/u.exec(call.pathname);
    if (call.method === "GET" && migrationMatch !== null) {
      await fulfillJson(route, {
        migration:
          state.latestMigration ??
          migrationJob({
            id: migrationMatch.groups?.["id"] ?? "migration-live",
            dryRun: false,
            status: "succeeded",
            plannedCount: 12,
            copiedCount: 12,
            verifiedCount: 12,
          }),
      });
      return;
    }

    if (
      call.method === "POST" &&
      call.pathname === "/api/admin/tenant-config/byo-storage/migrations/migration-live/cutover"
    ) {
      state.latestMigration = migrationJob({
        id: "migration-live",
        dryRun: false,
        status: "succeeded",
        plannedCount: 12,
        copiedCount: 12,
        verifiedCount: 12,
      });
      await fulfillJson(route, {
        migration: {
          ...state.latestMigration,
          status: "succeeded",
        },
        tenantConfig: {
          ...tenantConfigResponse().tenantConfig,
          byo: { storage: targetStorageConfig() },
          features: {
            ...tenantConfigResponse().tenantConfig.features,
            byo_storage: true,
          },
        },
      });
      return;
    }

    await fulfillJson(route, { error: `Unexpected ${call.method} ${call.pathname}` }, 404);
  });
}

function tenantConfigResponse() {
  return {
    tenantConfig: {
      orgId: "org-e2e",
      byo: {
        storage: {
          kind: "helix-default",
          prefix: "tenants/org-e2e/",
        },
      },
      features: {
        ai_smart_compose: true,
        byo_storage: false,
        dlp_enforcement: "warn",
        support_tier: "priority-24h",
      },
      quotas: {
        api_rps_limit: 25,
        actors_limit: 500,
      },
      branding: {
        display_name_override: "Acme",
        accent_color_hex: "#2f6fed",
        logo_url: "https://example.com/logo.png",
      },
      plan: {
        id: "business",
        displayName: "Business",
        featureFlagsDefault: { byo_storage: false },
        quotasDefault: { api_rps_limit: 25, actors_limit: 500 },
      },
      effective: {
        byo: {},
        features: {
          ai_smart_compose: true,
          byo_storage: false,
          dlp_enforcement: "warn",
          support_tier: "priority-24h",
        },
        quotas: { api_rps_limit: 25, actors_limit: 500 },
        branding: {
          display_name_override: "Acme",
          accent_color_hex: "#2f6fed",
          logo_url: "https://example.com/logo.png",
        },
      },
    },
  };
}

type TenantStorageMigrationStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "succeeded_with_errors"
  | "failed"
  | "dry_run";

interface TenantStorageMigration {
  readonly id: string;
  readonly orgId: string;
  readonly target: "byo";
  readonly status: TenantStorageMigrationStatus;
  readonly dryRun: boolean;
  readonly sourceStorage: {
    readonly managedBy: "helix-default";
    readonly storage: null;
  };
  readonly targetStorage: {
    readonly managedBy: "byo";
    readonly storage: ReturnType<typeof targetStorageConfig>;
  };
  readonly plannedCount: number;
  readonly copiedCount: number;
  readonly verifiedCount: number;
  readonly failures: readonly unknown[];
  readonly lastError: string | null;
  readonly attemptCount: number;
  readonly requestedByActorId: string;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

function migrationJob(
  overrides: Partial<
    Pick<
      TenantStorageMigration,
      | "id"
      | "status"
      | "dryRun"
      | "plannedCount"
      | "copiedCount"
      | "verifiedCount"
      | "startedAt"
      | "completedAt"
      | "updatedAt"
    >
  >,
): TenantStorageMigration {
  return {
    id: overrides.id ?? "migration-dry-run",
    orgId: "org-e2e",
    target: "byo",
    status: overrides.status ?? "dry_run",
    dryRun: overrides.dryRun ?? true,
    sourceStorage: { managedBy: "helix-default", storage: null },
    targetStorage: { managedBy: "byo", storage: targetStorageConfig() },
    plannedCount: overrides.plannedCount ?? 12,
    copiedCount: overrides.copiedCount ?? 0,
    verifiedCount: overrides.verifiedCount ?? 12,
    failures: [],
    lastError: null,
    attemptCount: 1,
    requestedByActorId: "actor-admin-e2e",
    startedAt: overrides.startedAt ?? "2026-05-25T10:00:00.000Z",
    completedAt: overrides.completedAt ?? "2026-05-25T10:01:00.000Z",
    createdAt: "2026-05-25T10:00:00.000Z",
    updatedAt: overrides.updatedAt ?? "2026-05-25T10:01:00.000Z",
  };
}

function targetStorageConfig() {
  return {
    kind: "byo",
    provider: "s3-compatible",
    endpoint: "https://storage.example.com",
    region: "us-east-1",
    bucket: "acme-helix-data",
    prefix: "helix/",
    credentials_vault_path: "tenants/org-e2e/byo-storage/s3",
    force_path_style: true,
  };
}

function migrationRequestBodies(calls: readonly BackendCall[]): readonly unknown[] {
  return calls
    .filter(
      (call) =>
        call.method === "POST" &&
        call.pathname === "/api/admin/tenant-config/byo-storage/migrations",
    )
    .map((call) => call.body);
}

function cutoverRequestBodies(calls: readonly BackendCall[]): readonly unknown[] {
  return calls
    .filter((call) => call.method === "POST" && call.pathname.endsWith("/cutover"))
    .map((call) => call.body);
}

function requestBodyRecord(body: unknown): Record<string, unknown> {
  return typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
}

function parsePostData(postData: string | null): unknown {
  if (postData === null) {
    return null;
  }
  try {
    return JSON.parse(postData) as unknown;
  } catch {
    return null;
  }
}

async function fulfillJson(route: Route, value: unknown, status = 200) {
  await route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(value),
  });
}
