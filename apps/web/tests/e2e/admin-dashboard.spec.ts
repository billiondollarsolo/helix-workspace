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
}

test.describe("/admin dashboard", () => {
  test("renders mocked admin evidence with bearer-authenticated backend calls", async ({
    page,
  }) => {
    const backendCalls: BackendCall[] = [];

    await page.addInitScript(
      ({ key, token }) => {
        window.localStorage.setItem(key, token);
      },
      { key: accessTokenStorageKey, token: adminToken },
    );
    await mockAdminDashboardBackend(page, backendCalls);

    await page.goto("/admin");

    await expect(page.getByRole("heading", { name: "Audit log" })).toBeVisible();
    await expect(page.getByRole("table", { name: "Audit log" })).toContainText("tool.invoked");
    await expect(page.getByRole("table", { name: "Audit log" })).toContainText(
      "source: playwright",
    );

    await expect(page.getByRole("heading", { name: "User directory" })).toBeVisible();
    await expect(page.getByRole("table", { name: "Admin users" })).toContainText("E2E Admin");
    await expect(page.getByRole("table", { name: "Admin users" })).toContainText(
      "admin-e2e@example.test",
    );

    await expect(page.getByRole("heading", { name: "OAuth client credentials" })).toBeVisible();
    await expect(page.getByRole("table", { name: "Agent credentials" })).toContainText(
      "agent-client-e2e",
    );
    await expect(page.getByRole("table", { name: "Agent credentials" })).toContainText(
      "admin.agents",
    );

    await expect(page.getByRole("heading", { name: "Scoped app access" })).toBeVisible();
    await expect(page.getByRole("table", { name: "App passwords" })).toContainText(
      "Calendar sync e2e",
    );
    await expect(page.getByRole("table", { name: "App passwords" })).toContainText("caldav");

    await expect(page.getByRole("heading", { name: "Security tier readiness" })).toBeVisible();
    await expect(page.getByText("Live platform config connected").first()).toBeVisible();
    await expect(page.getByRole("heading", { name: "Business platform state" })).toBeVisible();
    await expect(page.getByText("Audit destinations").first()).toBeVisible();
    await expect(page.getByRole("heading", { name: "Install permissions prompt" })).toBeVisible();
    await expect(page.getByRole("table", { name: "Plugin catalog" })).toContainText(
      "Evidence Plugin",
    );
    await expect(page.getByRole("heading", { name: "AI observability" })).toBeVisible();
    await expect(page.getByText("30 day retention").first()).toBeVisible();
    await expect(page.getByRole("heading", { name: "Services overview" })).toBeVisible();
    await expect(page.getByRole("table", { name: "Admin services" })).toContainText("Mail");
    await expect(page.getByRole("table", { name: "Admin services" })).toContainText(
      "com.helix.core.mail",
    );

    expect(backendCalls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ method: "GET", pathname: "/api/admin/audit-log" }),
        expect.objectContaining({ method: "GET", pathname: "/api/admin/users" }),
        expect.objectContaining({ method: "GET", pathname: "/api/admin/platform-config" }),
        expect.objectContaining({ method: "GET", pathname: "/api/admin/services" }),
        expect.objectContaining({ method: "GET", pathname: "/api/admin/mail/config" }),
        expect.objectContaining({ method: "POST", pathname: "/api/tools/plugin.list" }),
        expect.objectContaining({ method: "POST", pathname: "/api/tools/webhook.outbound.list" }),
        expect.objectContaining({ method: "POST", pathname: "/api/tools/webhook.inbound.list" }),
        expect.objectContaining({ method: "POST", pathname: "/api/tools/webhook.delivery.list" }),
        expect.objectContaining({
          body: { includeRevoked: false },
          method: "POST",
          pathname: "/api/tools/agent.credentials.list",
        }),
        expect.objectContaining({
          body: { includeRevoked: false },
          method: "POST",
          pathname: "/api/tools/app.passwords.list",
        }),
      ]),
    );
    expect(backendCalls.every((call) => call.authorization === expectedAuthorization)).toBe(true);
  });
});

async function mockAdminDashboardBackend(page: Page, backendCalls: BackendCall[]) {
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const body = parsePostData(request.postData());
    const call = {
      authorization: request.headers().authorization ?? null,
      body,
      method: request.method(),
      pathname: url.pathname,
    } satisfies BackendCall;
    backendCalls.push(call);

    if (call.authorization !== expectedAuthorization) {
      await route.fulfill({
        status: 401,
        contentType: "application/json",
        body: JSON.stringify({ error: "missing bearer token" }),
      });
      return;
    }

    // The production shell calls GET /api/core-apps (and the admin core-apps
    // panel calls GET /api/admin/core-apps) on mount; serve the shared valid
    // fixtures so the shell renders instead of white-screening.
    if (call.method === "GET" && (await fulfillCoreAppsRoute(route))) {
      return;
    }

    if (call.method === "GET" && call.pathname === "/api/admin/audit-log") {
      await fulfillJson(route, auditLogResponse());
      return;
    }
    if (call.method === "GET" && call.pathname === "/api/admin/users") {
      await fulfillJson(route, adminUsersResponse());
      return;
    }
    if (call.method === "GET" && call.pathname === "/api/admin/platform-config") {
      await fulfillJson(route, platformConfigResponse());
      return;
    }
    if (call.method === "GET" && call.pathname === "/api/admin/services") {
      await fulfillJson(route, adminServicesResponse());
      return;
    }
    if (call.method === "GET" && call.pathname === "/api/admin/mail/config") {
      await fulfillJson(route, mailConfigResponse());
      return;
    }
    if (call.method === "POST" && call.pathname === "/api/tools/plugin.list") {
      await fulfillJson(route, pluginListResponse());
      return;
    }
    if (call.method === "POST" && call.pathname === "/api/tools/webhook.outbound.list") {
      await fulfillJson(route, { webhooks: [] });
      return;
    }
    if (call.method === "POST" && call.pathname === "/api/tools/webhook.inbound.list") {
      await fulfillJson(route, { webhooks: [] });
      return;
    }
    if (call.method === "POST" && call.pathname === "/api/tools/webhook.delivery.list") {
      await fulfillJson(route, { deliveries: [] });
      return;
    }
    if (call.method === "POST" && call.pathname === "/api/tools/agent.credentials.list") {
      await fulfillJson(route, agentCredentialsListResponse());
      return;
    }
    if (call.method === "POST" && call.pathname === "/api/tools/app.passwords.list") {
      await fulfillJson(route, appPasswordsListResponse());
      return;
    }

    await route.fulfill({
      status: 404,
      contentType: "application/json",
      body: JSON.stringify({ error: `Unexpected ${call.method} ${call.pathname}` }),
    });
  });
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

async function fulfillJson(route: Route, value: unknown) {
  await route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(value),
  });
}

function auditLogResponse() {
  return {
    records: [
      {
        id: "audit-e2e-1",
        orgId: "org-e2e",
        actorId: "actor-admin-e2e",
        verb: "tool.invoked",
        objectType: "tool",
        objectId: "agent.credentials.list",
        traceId: "trace-e2e-admin",
        payload: { source: "playwright", result: "rendered" },
        prevHash: null,
        thisHash: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        createdAt: "2026-05-20T14:00:00.000Z",
      },
    ],
    nextCursor: null,
  };
}

function adminUsersResponse() {
  return {
    users: [
      {
        id: "actor-admin-e2e",
        orgId: "org-e2e",
        type: "user",
        email: "admin-e2e@example.test",
        displayName: "E2E Admin",
        scopes: ["admin.audit", "admin.users", "admin.agents"],
        disabledAt: null,
        createdAt: "2026-05-19T14:00:00.000Z",
        updatedAt: "2026-05-20T14:00:00.000Z",
      },
    ],
    nextCursor: null,
  };
}

function platformConfigResponse() {
  return {
    config: {
      security: { tier: "business" },
      ai: {
        costLimits: {
          perUserPerDayUSD: 12,
          perOrgPerDayUSD: 400,
          perAgentPerDayUSD: 8,
        },
        audit: {
          logRequests: "metadata-only",
          retainDays: 30,
        },
        privacy: {
          redactPIIBeforeSend: true,
          classificationGating: true,
          blockExternalForClassifications: ["restricted"],
        },
      },
    },
    readiness: {
      ready: true,
      requirements: [
        {
          key: "encryptedBackups",
          label: "Encrypted backups",
          required: true,
          status: "ready",
          expected: { encryption: "age" },
          observed: { encryption: "age" },
        },
        {
          key: "auditDestinations",
          label: "Audit destinations",
          required: true,
          status: "ready",
          expected: { destinations: ["postgres", "immutable-s3"] },
          observed: { destinations: ["postgres", "immutable-s3"] },
        },
        {
          key: "vault",
          label: "Secrets backend",
          required: false,
          status: "not_required",
          expected: { backend: "sops-or-vault" },
          observed: { backend: "sops" },
        },
      ],
    },
  };
}

function adminServicesResponse() {
  return {
    generatedAt: "2026-05-20T14:00:00.000Z",
    services: [
      {
        id: "mail",
        pluginId: "com.helix.core.mail",
        label: "Mail",
        summary: "Inbound and outbound mail",
        category: "communication",
        status: "configured",
        enabled: true,
        evidence: "Mail runtime evidence from e2e mock.",
        scopes: ["mail.read", "mail.send"],
        adminScopes: ["mail.admin", "admin.config.read"],
        uiRoutes: ["/mail"],
        apiRoutes: ["/api/admin/mail/config", "/api/tools/mail.*"],
        realtimeRoutes: [],
        tools: ["mail.send", "mail.search"],
        capabilities: ["smtp-listener", "smtp-relay"],
        consumes: ["storage", "search-engine"],
        dataStores: ["threads", "messages", "mail_outbound_messages"],
        dependencies: [
          {
            id: "postgres",
            label: "Postgres",
            type: "database",
            required: true,
            status: "configured",
            envKeys: ["DATABASE_URL"],
            evidence: "DATABASE_URL configured.",
          },
        ],
        configuration: [
          {
            key: "smtpCredentials",
            label: "Outbound SMTP credentials",
            envKeys: ["MAIL_SMTP_PASS"],
            configured: true,
            sensitive: true,
            status: "configured",
            evidence: "Credential reference is present.",
          },
        ],
        aiSlots: ["mail.summarize-thread"],
        enrichments: ["mail.classification"],
        adminActions: [
          {
            id: "mail.config.read",
            label: "Read mail configuration status",
            method: "GET",
            path: "/api/admin/mail/config",
            requiredScope: "admin.config.read",
            destructive: false,
          },
        ],
        metrics: ["helix_tool_invocations_total"],
      },
    ],
  };
}

function mailConfigResponse() {
  return {
    generatedAt: "2026-05-20T14:00:00.000Z",
    inboundReceiver: {
      enabled: true,
      status: "ready",
      host: "0.0.0.0",
      port: 2525,
      orgId: "org-e2e",
      evidence: "SMTP receiver configured.",
    },
    outboundRelay: {
      configured: true,
      status: "ready",
      provider: "smtp",
      host: "smtp.example.test",
      port: 587,
      secure: true,
      authConfigured: true,
      evidence: "Outbound relay configured.",
    },
    domains: [
      {
        domain: "example.test",
        defaultFrom: true,
        records: [
          {
            type: "MX",
            status: "ready",
            expected: "mx.example.test",
            evidence: "MX verified.",
          },
        ],
      },
    ],
    quotas: {
      perActorPerHour: 60,
      perActorPerDay: 200,
      maxMessageBytes: 10485760,
      evidence: "Default quotas active.",
    },
    deliveryHealth: {
      since: "2026-05-19T14:00:00.000Z",
      counts: { queued: 0, sending: 0, sent: 12, failed: 0, cancelled: 0 },
      failedLast24h: 0,
      lastFailureAt: null,
      lastError: null,
    },
  };
}

function pluginListResponse() {
  return {
    plugins: [
      {
        id: "com.helix.evidence-plugin",
        name: "Evidence Plugin",
        version: "1.2.3",
        description: "E2E plugin catalog evidence",
        kind: "connector",
        capabilities: {
          provides: ["admin.evidence"],
          consumes: ["audit.read"],
        },
        permissions: {
          scopes: ["admin.audit"],
          "outbound-network": ["https://evidence.example.test"],
          filesystem: [],
          envVars: [],
        },
        lifecycle: {
          state: "enabled",
          installed: true,
          source: "official",
          updatedAt: "2026-05-20T14:00:00.000Z",
        },
        install: {
          confirmationRequired: false,
          confirmations: [],
          source: "official",
        },
        signature: {
          digest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          signer: "helix",
        },
        tierRequirements: null,
      },
    ],
  };
}

function agentCredentialsListResponse() {
  return {
    credentials: [
      {
        clientId: "agent-client-e2e",
        actorId: "agent-actor-e2e",
        orgId: "org-e2e",
        scopes: ["platform.read", "admin.agents"],
        expiresAt: null,
        revokedAt: null,
      },
    ],
  };
}

function appPasswordsListResponse() {
  return {
    appPasswords: [
      {
        id: "app-password-e2e",
        actorId: "actor-admin-e2e",
        label: "Calendar sync e2e",
        scopes: ["calendar.read", "caldav"],
        lastUsedAt: "2026-05-20T13:00:00.000Z",
        expiresAt: null,
        revokedAt: null,
        createdAt: "2026-05-19T14:00:00.000Z",
      },
    ],
  };
}
