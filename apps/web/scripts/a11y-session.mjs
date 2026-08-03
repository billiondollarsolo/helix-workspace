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
 * fabricated the same way the mocked E2E specs do it: seed the access token the
 * shell reads, and answer `/api/**` from fixtures.
 *
 * The fixtures are deliberately minimal — enough for each surface to reach its
 * *loaded* state rather than its error state, which is the state worth auditing.
 * Where a surface has no fixture it renders its own empty or failure state, and
 * that is still real, audit-worthy markup rather than a redirect.
 */

/** Storage key the web shell reads its bearer token from. */
const ACCESS_TOKEN_KEY = "helix.accessToken";
const AUDIT_TOKEN = "a11y-audit-token";

const AUDIT_ACTOR = {
  id: "00000000-0000-4000-8000-0000000000a1",
  orgId: "00000000-0000-0000-0000-000000000000",
  type: "user",
  email: "a11y-audit@helix.local",
  displayName: "Accessibility Audit",
  scopes: ["*"],
  disabledAt: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const CORE_APPS = [
  { id: "mail", name: "Mail" },
  { id: "chat", name: "Chat" },
  { id: "drive", name: "Drive" },
  { id: "docs", name: "Docs" },
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
  ["/api/auth/get-session", { user: AUDIT_ACTOR, session: { id: "a11y-session" } }],
  ["/api/core-apps", coreAppsShell()],
  ["/api/admin/core-apps", coreAppsAdmin()],
  ["/api/admin/users", { users: [AUDIT_ACTOR], nextCursor: null }],
  ["/api/admin/domains", { domains: [] }],
  ["/api/admin/security-policies", { policies: [] }],
  ["/api/admin/audit-log", { records: [], nextCursor: null }],
  ["/api/admin/services", { generatedAt: "2026-01-01T00:00:00.000Z", services: [] }],
  /* The console's landing page reads one aggregate now. Without this it fell
     through to `{}`, failed its schema, and the audit measured five error
     banners instead of the page — auditing a surface's failure state and
     reporting it as the surface. */
  [
    "/api/admin/overview",
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
const TOOL_FIXTURES = new Map([
  ["notifications.unread-count", { count: 0 }],
  ["notifications.list", { notifications: [] }],
  ["webhook.overview", { outbound: [], inbound: [], deliveries: [] }],
]);

/**
 * Give a browser context a signed-in session and a backend to talk to.
 *
 * Call once per context, before any `page.goto`.
 */
export async function installAuditSession(context) {
  await context.addInitScript(
    ([key, token]) => {
      window.localStorage.setItem(key, token);
    },
    [ACCESS_TOKEN_KEY, AUDIT_TOKEN],
  );

  await context.route("**/api/**", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    const toolId = pathname.startsWith("/api/tools/") ? pathname.slice("/api/tools/".length) : null;
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
const SIGNED_OUT_ROUTES = new Set(["/login", "/signup"]);

export function routeNeedsSession(routePath) {
  return !SIGNED_OUT_ROUTES.has(routePath);
}
