/**
 * Signed-in session for the accessibility audit.
 *
 * Every route in `quality-gates.routes.json` behind the app shell — Mail, Chat,
 * Drive, and all nineteen `/admin/*` entries — redirects to `/login` without a
 * session. The audit never established one, so it has been reporting a pass for
 * twenty-plus routes while scanning the login page over and over. That is worse
 * than no coverage: it is a green light nobody earned.
 *
 * The audit runs against a `vite preview` of the built app with no backend
 * behind it (see `.github/workflows/quality-gates.yml`), so a session has to be
 * fabricated the same way the mocked E2E specs do it: provide the session response the
 * shell reads, and answer `/v1/api/**` from fixtures.
 *
 * The fixtures are deliberately minimal — enough for each surface to reach its
 * *loaded* state rather than its error state, which is the state worth auditing.
 * Where a surface has no fixture it renders its own empty or failure state, and
 * that is still real, audit-worthy markup rather than a redirect.
 */

const AUDIT_ACTOR = {
  id: "00000000-0000-4000-8000-0000000000a1",
  orgId: "00000000-0000-0000-0000-000000000000",
  type: "user",
  email: "a11y-audit@helix.local",
  displayName: "Accessibility Audit",
  scopes: ["*"],
  status: "active",
  disabledAt: null,
  lastSignInAt: "2026-01-02T09:00:00.000Z",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const CORE_APPS = [
  { id: "mail", name: "Mail" },
  { id: "chat", name: "Chat" },
  { id: "drive", name: "Drive" },
  { id: "calendar", name: "Calendar" },
  { id: "meet", name: "Meet" },
  { id: "assistant", name: "Assistant" },
];

/* `{}` is not a valid `CoreAppShellStatus` and crashes the whole shell, which is
   why this one endpoint cannot fall through to the generic responder. Same
   reasoning as `tests/e2e/support/api-fixtures.ts`. */
function coreAppsShell() {
  return {
    role: "all-in-one",
    apps: CORE_APPS.map((app) => ({ ...app, enabled: true, registered: true })),
  };
}

function coreAppsAdmin() {
  return {
    role: "all-in-one",
    apps: CORE_APPS.map((app) => ({
      ...app,
      description: `${app.name} core app`,
      enabled: true,
      inRole: true,
      registered: true,
    })),
  };
}

/** Path -> body. Anything not listed falls through to `{}`, which every surface
 *  renders as an empty or unavailable state rather than crashing. */
const FIXTURES = new Map([
  ["/v1/api/auth/csrf-token", { csrfToken: "a11y-csrf-token" }],
  [
    "/v1/api/auth/get-session",
    {
      user: { ...AUDIT_ACTOR, actorId: AUDIT_ACTOR.id, name: AUDIT_ACTOR.displayName },
      session: { id: "a11y-session" },
    },
  ],
  [
    "/v1/api/profile",
    {
      profile: {
        actorId: AUDIT_ACTOR.id,
        orgId: AUDIT_ACTOR.orgId,
        email: AUDIT_ACTOR.email,
        displayName: AUDIT_ACTOR.displayName,
        pronouns: "they/them",
        jobTitle: "Workspace administrator",
        about: "Keeping the workspace accessible.",
      },
    },
  ],
  ["/v1/api/core-apps", coreAppsShell()],
  /* Settings → Security: this device and one other, so the list and its
     per-device Sign out button are audited. */
  [
    "/v1/api/account/sessions",
    {
      sessions: [
        {
          id: "a11y-session",
          current: true,
          createdAt: "2026-01-01T00:00:00.000Z",
          lastActiveAt: "2026-01-01T00:00:00.000Z",
          expiresAt: "2026-02-01T00:00:00.000Z",
          ipAddress: "203.0.113.10",
          userAgent: null,
          browser: "Chrome",
          os: "Linux",
          deviceType: "desktop",
        },
        {
          id: "a11y-phone",
          current: false,
          createdAt: "2026-01-01T00:00:00.000Z",
          lastActiveAt: "2026-01-01T00:00:00.000Z",
          expiresAt: "2026-02-01T00:00:00.000Z",
          ipAddress: null,
          userAgent: null,
          browser: "Safari",
          os: "iOS",
          deviceType: "mobile",
        },
      ],
    },
  ],
  [
    "/v1/api/people",
    {
      people: [
        {
          id: "a11y-person",
          email: "harbor.lead@helix.local",
          displayName: "Harbor Lead",
          kind: "directory",
          favorite: false,
          avatarDataUrl: null,
          relationship: {},
          actorId: null,
          title: null,
        },
      ],
    },
  ],
  ["/v1/api/admin/core-apps", coreAppsAdmin()],
  ["/v1/api/admin/users", { users: [AUDIT_ACTOR], nextCursor: null }],
  ["/v1/api/admin/domains", { domains: [] }],
  ["/v1/api/admin/security-policies", { policies: [] }],
  ["/v1/api/admin/audit-log", { records: [], nextCursor: null }],
  ["/v1/api/admin/services", { generatedAt: "2026-01-01T00:00:00.000Z", services: [] }],
  /* The console's landing page reads one aggregate now. Without this it fell
     through to `{}`, failed its schema, and the audit measured five error
     banners instead of the page — auditing a surface's failure state and
     reporting it as the surface. */
  [
    "/v1/api/admin/overview",
    {
      signals: {
        domains: { status: "ok", data: { domains: [] } },
        policies: { status: "ok", data: { policies: [] } },
        platformConfig: {
          status: "ok",
          data: {
            config: { security: { tier: "personal" } },
            readiness: { ready: true, requirements: [] },
          },
        },
        directory: { status: "ok", data: { users: [AUDIT_ACTOR], nextCursor: null } },
        coreApps: { status: "ok", data: coreAppsAdmin() },
      },
    },
  ],
]);

/** Tool calls answer with the shape their caller parses; `{}` is fine for the
 *  rest because the console renders an empty list rather than throwing. */
const MAIL_LABEL = {
  id: "00000000-0000-4000-8000-0000000000b1",
  slug: "clients",
  name: "Clients",
  color: "#007c76",
  colorName: "teal",
  parentId: null,
  sortOrder: 100,
  threadCount: 3,
  unreadCount: 1,
  shared: false,
};

const AUDIT_CONTACT = {
  id: "00000000-0000-4000-8000-0000000000e1",
  displayName: "Ada Lovelace",
  givenName: "Ada",
  familyName: "Lovelace",
  company: "Analytical Engines",
  jobTitle: "Mathematician",
  emails: [{ type: "work", value: "ada@example.com" }],
  phones: [{ type: "mobile", value: "+44 20 7946 0000" }],
  addresses: [
    {
      type: "home",
      street: "12 St James's Square",
      city: "London",
      region: "",
      postalCode: "SW1Y 4JH",
      country: "United Kingdom",
    },
  ],
  birthday: "1815-12-10",
  notes: "Wrote the first published algorithm.",
  labels: ["Family"],
  photoDataUrl: null,
  starred: true,
  memberActorId: null,
  updatedAt: "2026-01-01T00:00:00.000Z",
  deletedAt: null,
};

const TOOL_FIXTURES = new Map([
  /* Contacts: one starred, labelled contact so the list, the contact page and
     the edit form audit their populated states. */
  ["contacts.list", { contacts: [AUDIT_CONTACT], total: 1 }],
  ["contacts.get", { contact: AUDIT_CONTACT }],
  ["contacts.labels.list", { labels: [{ name: "Family", count: 1 }], total: 1 }],
  ["contacts.duplicates.list", { groups: [] }],
  [
    "contacts.directory.list",
    {
      members: [
        {
          actorId: AUDIT_ACTOR.id,
          displayName: AUDIT_ACTOR.displayName,
          email: AUDIT_ACTOR.email,
          jobTitle: "Auditor",
          avatarDataUrl: null,
        },
      ],
      total: 1,
    },
  ],
  ["notifications.unread-count", { count: 0 }],
  /* Settings → Mail: one label, one filter and one blocked address, so each
     tab audits its populated list rather than an empty state. */
  ["mail.labels.list", { labels: [MAIL_LABEL] }],
  [
    "mail.filter.list",
    {
      filters: [
        {
          id: "00000000-0000-4000-8000-0000000000c1",
          name: "from:billing@example.com",
          enabled: true,
          priority: 100,
          criteria: { fromContains: "billing@example.com" },
          actions: { archive: true, applyLabels: ["clients"] },
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    },
  ],
  ["mail.vacation.get", { vacation: null }],
  [
    "mail.settings.get",
    {
      signatureText: "Thanks,\nAccessibility Audit",
      signatureHtml: null,
      includeSignatureOnReplies: true,
      blockedSenders: ["spam@example.net"],
      updatedAt: null,
    },
  ],
  [
    "account.preferences.get",
    {
      language: null,
      timeZone: null,
      dateFormat: null,
      timeFormat: null,
      weekStart: null,
      workingHours: null,
      mail: { readingPane: "none", density: "default", conversationView: true },
      updatedAt: null,
    },
  ],
  ["notifications.list", { notifications: [] }],
  [
    "app.passwords.list",
    {
      appPasswords: [
        {
          id: "a11y-app-password",
          label: "Phone calendar",
          scopes: ["calendar.read", "calendar.write"],
          lastUsedAt: null,
          expiresAt: null,
          revokedAt: null,
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      ],
      grantableScopes: ["mail.send", "calendar.read", "calendar.write", "drive.read"],
    },
  ],
  [
    "drive.s3-keys.list",
    {
      accessKeys: [
        {
          id: "a11y-s3-key",
          accessKeyId: "HLXA11YAAAAAAAAAAAAA",
          label: "Home NAS",
          scopes: ["drive.read", "drive.write"],
          lastUsedAt: null,
          expiresAt: null,
          revokedAt: null,
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      ],
      endpointPath: "/v1/s3",
      grantableScopes: ["drive.read", "drive.write"],
    },
  ],
  ["meet.status", { available: true }],
  ["webhook.overview", { outbound: [], inbound: [], deliveries: [] }],
  [
    "drive.list",
    {
      entries: [
        {
          id: "00000000-0000-4000-8000-0000000000d1",
          type: "folder",
          name: "Audit folder",
          folderId: null,
          ownerActorId: AUDIT_ACTOR.id,
          metadata: {},
          deletedAt: null,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
        {
          id: "00000000-0000-4000-8000-0000000000d2",
          type: "file",
          name: "Audit report.pdf",
          folderId: null,
          ownerActorId: AUDIT_ACTOR.id,
          mimeType: "application/pdf",
          byteSize: 2048,
          uploadState: "active",
          available: true,
          metadata: {},
          deletedAt: null,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
      nextCursor: null,
    },
  ],
  [
    "search.query",
    {
      query: "harbor",
      estimatedTotalHits: 2,
      hits: [
        {
          id: "mail:a11y",
          type: "mail",
          title: "Harbor review",
          body: "Harbor review\nCan we move the harbor review to Thursday?",
          attributes: { threadId: "00000000-0000-4000-8000-0000000000b1", fromName: "Nora" },
        },
        {
          id: "drive:a11y",
          type: "drive",
          title: "Harbor brief.md",
          body: "Harbor brief.md",
          attributes: { fileId: "a11y-file", ownerName: "Samara" },
        },
      ],
    },
  ],
]);

/**
 * Give a browser context a signed-in session and a backend to talk to.
 *
 * Call once per context, before any `page.goto`.
 */
export async function installAuditSession(context) {
  await context.route("**/v1/api/**", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    const toolId = pathname.startsWith("/v1/api/tools/")
      ? pathname.slice("/v1/api/tools/".length)
      : null;
    const body =
      toolId !== null ? (TOOL_FIXTURES.get(toolId) ?? {}) : (FIXTURES.get(pathname) ?? {});
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(body),
    });
  });
}

/** Routes that only make sense signed *out*. Seeding a session on these would
 *  bounce the audit straight back into the shell and silently stop auditing the
 *  auth surfaces — the mirror image of the bug this module fixes. */
const SIGNED_OUT_ROUTES = ["/login", "/signup", "/oauth/consent"];

export function routeNeedsSession(routePath) {
  const pathname = new URL(routePath, "http://audit.invalid").pathname;
  return !SIGNED_OUT_ROUTES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}
