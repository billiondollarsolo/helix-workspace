/* Section id -> how to fetch that section's code and warm its data.
 *
 * Deliberately a separate module from `admin-console.tsx`, and deliberately
 * free of React and of any static import into the console's own tree.
 *
 * The route's `loader` is NOT code-split by `tanstackRouter({
 * autoCodeSplitting: true })` — only `component` is. So when
 * `routes/_shell/admin/$section.tsx` imported its prefetch entry point from
 * `admin-console.tsx`, it pulled the console shell, the sidebar, the shared
 * primitives, the icon set and the realtime hub into the *initial* JavaScript
 * graph for every page of the app. The bundle budget caught it: 605.0 kB
 * against a 450.0 kB ceiling, up from 389.8 kB.
 *
 * Everything below is either a plain value or a thunk around a dynamic
 * `import()`, so the eager cost of this module is the table itself. */

import type { AdminSectionId } from "@/features/admin/admin-console-data";

/** A `QueryClient`, structurally. Typing the real one here would import
 *  `@tanstack/react-query` into the eager route graph for no benefit — every
 *  `prefetchAdmin*Query` helper declares its own structural interface for the
 *  same reason. */
export interface AdminPrefetchClient {
  ensureQueryData: (options: never) => Promise<unknown>;
}

/** A section module's prefetch helper. */
type PrefetchHelper = (queryClient: AdminPrefetchClient) => Promise<void>;

export interface AdminSectionLoader {
  /** Fetches the section's chunk. Safe to call repeatedly: the browser's module
   *  map dedupes, and `React.lazy` shares the resolved module, so this never
   *  duplicates the work the lazy factory does on mount. */
  readonly load: () => Promise<Record<string, unknown>>;
  /** Named export that renders the section. Checked at load time. */
  readonly exportName: string;
  /** Wrap in the standard `PageScroll` container — for sections that render
   *  their own padding but no outer scroll. */
  readonly scroll?: boolean;
  /** Name of the module's exported `prefetchAdmin*Query` helper, when it has
   *  one. Sections without one still get their chunk preloaded. */
  readonly prefetch?: string;
}

/** Keyed by `AdminSectionId`, so adding a nav entry without wiring content — or
 *  leaving a stale entry behind — is a type error. */
export const ADMIN_SECTION_LOADERS: Record<AdminSectionId, AdminSectionLoader> = {
  overview: {
    load: () => import("@/features/admin/sections/overview"),
    exportName: "AdminOverview",
    prefetch: "prefetchAdminOverviewQueries",
  },
  domains: {
    load: () => import("@/features/admin/sections/domains"),
    exportName: "AdminDomain",
    prefetch: "prefetchAdminDomainsQuery",
  },
  billing: {
    load: () => import("@/features/admin/sections/billing"),
    exportName: "AdminBilling",
  },
  "workspace-settings": {
    load: () => import("@/features/admin/tenant-config-management"),
    exportName: "TenantConfigManagement",
    scroll: true,
    prefetch: "prefetchAdminTenantConfigQuery",
  },
  users: {
    load: () => import("@/features/admin/sections/users"),
    exportName: "AdminUsers",
    prefetch: "prefetchAdminDirectoryQuery",
  },
  groups: {
    load: () => import("@/features/admin/sections/groups"),
    exportName: "AdminGroups",
  },
  policies: {
    load: () => import("@/features/admin/sections/policies"),
    exportName: "AdminSecurity",
    prefetch: "prefetchAdminPoliciesQuery",
  },
  identity: {
    load: () => import("@/features/admin/identity-management"),
    exportName: "IdentityManagement",
    scroll: true,
    prefetch: "prefetchAdminIdentityQuery",
  },
  "tier-readiness": {
    load: () => import("@/features/admin/security-tier-readiness"),
    exportName: "SecurityTierReadiness",
    scroll: true,
    prefetch: "prefetchAdminReadinessQueries",
  },
  audit: {
    load: () => import("@/features/admin/audit-log"),
    exportName: "AuditLogList",
    scroll: true,
    prefetch: "prefetchAdminAuditLogQuery",
  },
  "workspace-apps": {
    load: () => import("@/features/admin/core-apps-management"),
    exportName: "CoreAppsManagement",
    scroll: true,
    prefetch: "prefetchAdminCoreAppsQuery",
  },
  mail: {
    load: () => import("@/features/admin/mail-admin"),
    exportName: "MailAdminSection",
  },
  chat: {
    load: () => import("@/features/admin/chat-admin"),
    exportName: "ChatAdminSection",
    scroll: true,
  },
  drive: {
    load: () => import("@/features/admin/drive-admin"),
    exportName: "DriveAdminSection",
    scroll: true,
  },
  "oauth-apps": {
    load: () => import("@/features/admin/sections/oauth-apps"),
    exportName: "AdminApps",
  },
  "app-passwords": {
    load: () => import("@/features/admin/app-passwords-management"),
    exportName: "AppPasswordsManagement",
    scroll: true,
  },
  "agent-credentials": {
    load: () => import("@/features/admin/agent-credentials-management"),
    exportName: "AgentCredentialsManagement",
    scroll: true,
  },
  "agent-controls": {
    load: () => import("@/features/admin/agent-controls"),
    exportName: "AgentControlsManagement",
    scroll: true,
  },
  webhooks: {
    load: () => import("@/features/webhooks/webhook-management"),
    exportName: "WebhookManagement",
    scroll: true,
  },
  "ai-providers": {
    load: () => import("@/features/admin/ai-providers-management"),
    exportName: "AIProvidersManagement",
    scroll: true,
  },
  "ai-costs": {
    load: () => import("@/features/admin/ai-cost-limits-management"),
    exportName: "AICostLimitsManagement",
    scroll: true,
    prefetch: "prefetchAdminAICostLimitsQuery",
  },
  "ai-observability": {
    load: () => import("@/features/admin/ai-observability"),
    exportName: "AIObservabilityDashboard",
    scroll: true,
    prefetch: "prefetchAdminAIObservabilityQuery",
  },
  services: {
    load: () => import("@/features/admin/admin-services"),
    exportName: "AdminServicesOverview",
    scroll: true,
    prefetch: "prefetchAdminServicesQuery",
  },
};

/** Start fetching a section's chunk without navigating to it.
 *
 *  Fire-and-forget by design: this runs on pointer-enter and focus, where a
 *  rejected promise is not something the operator needs to hear about — the
 *  click that follows will surface any real failure properly. */
export function preloadAdminSection(id: AdminSectionId): void {
  void ADMIN_SECTION_LOADERS[id].load().catch(() => undefined);
}

/** Start a section's chunk *and* its first request(s).
 *
 *  Called from the route loader, which TanStack also runs under `preloadRoute`
 *  — so hovering a sidebar link now warms the data as well as the code.
 *
 *  Never rejects. A prefetch is an optimisation; a failure here must not block
 *  navigation or replace the page with an error boundary. The component's own
 *  `useQuery` will re-request and report the failure in the console's own
 *  banner, which is where an operator can act on it. */
export async function prefetchAdminSectionData(
  queryClient: AdminPrefetchClient,
  id: AdminSectionId,
): Promise<void> {
  const entry = ADMIN_SECTION_LOADERS[id];
  const prefetchName = entry.prefetch;
  await entry
    .load()
    .then(async (loaded) => {
      if (prefetchName === undefined) {
        return;
      }
      const prefetch = loaded[prefetchName] as PrefetchHelper | undefined;
      /* A renamed or removed helper must not break navigation — the section
         still renders and fetches on mount. */
      await prefetch?.(queryClient);
    })
    .catch(() => undefined);
}
