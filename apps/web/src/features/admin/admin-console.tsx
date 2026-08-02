/* Helix Admin console — the surface shell.
 *
 * This file owns three things and nothing else: the chrome, the sidebar, and
 * the map from a URL section to the component that renders it. Each section
 * lives in its own module under `sections/`, and the pieces they share (page
 * header, scroll container, state banners, table cells) live in
 * `console/primitives`.
 *
 * Sections render live platform data only. When an endpoint is unavailable
 * they surface a loading / error / empty state rather than seed values. */

import { lazy, Suspense, type ComponentType } from "react";
import { Icons } from "@/components/icons";
import { SurfaceFrame } from "@/components/shell";
import { AdminSidebar } from "@/features/admin/console/sidebar";
import { PageScroll } from "@/features/admin/console/primitives";
import type { AdminSectionId } from "@/features/admin/admin-console-data";

/** Load one section on demand.
 *
 * Every section used to be imported eagerly here, which put all eighteen into
 * a single route chunk — 503.8 kB against a 500 kB budget, and an operator
 * opening Overview downloaded the AI observability dashboard to get there.
 * Each is now its own chunk, fetched when its URL is visited.
 *
 * `scroll` wraps the section in the standard `PageScroll` container, for the
 * ones that render their own padding but no outer scroll. */
function section(
  /* `unknown` values, not `ComponentType`: a section module also exports types,
     query options and constants, so a narrower signature would reject every
     real module. The named export is checked at load time instead. */
  load: () => Promise<Record<string, unknown>>,
  name: string,
  options: { readonly scroll?: boolean } = {},
): ComponentType {
  return lazy(async () => {
    const loaded = await load();
    const Component = loaded[name] as ComponentType | undefined;
    if (Component === undefined) {
      throw new Error(`Admin section module has no export named ${name}`);
    }
    return {
      default: options.scroll
        ? function ScrolledSection() {
            return (
              <PageScroll>
                <Component />
              </PageScroll>
            );
          }
        : Component,
    };
  });
}

/** Section id (and URL segment) -> the component that renders it.
 *  Keyed by `AdminSectionId`, so adding a nav entry without wiring content —
 *  or leaving a stale entry behind — is a type error. */
const SECTION_CONTENT: Record<AdminSectionId, ComponentType> = {
  overview: section(() => import("@/features/admin/sections/overview"), "AdminOverview"),
  domains: section(() => import("@/features/admin/sections/domains"), "AdminDomain"),
  billing: section(() => import("@/features/admin/sections/billing"), "AdminBilling"),
  "workspace-settings": section(
    () => import("@/features/admin/tenant-config-management"),
    "TenantConfigManagement",
    { scroll: true },
  ),
  users: section(() => import("@/features/admin/sections/users"), "AdminUsers"),
  groups: section(() => import("@/features/admin/sections/groups"), "AdminGroups"),
  policies: section(() => import("@/features/admin/sections/policies"), "AdminSecurity"),
  identity: section(() => import("@/features/admin/identity-management"), "IdentityManagement", {
    scroll: true,
  }),
  "tier-readiness": section(
    () => import("@/features/admin/security-tier-readiness"),
    "SecurityTierReadiness",
    { scroll: true },
  ),
  audit: section(() => import("@/features/admin/audit-log"), "AuditLogList", { scroll: true }),
  "workspace-apps": section(
    () => import("@/features/admin/core-apps-management"),
    "CoreAppsManagement",
    { scroll: true },
  ),
  mail: section(() => import("@/features/admin/mail-admin"), "MailAdminSection"),
  chat: section(() => import("@/features/admin/chat-admin"), "ChatAdminSection", { scroll: true }),
  drive: section(() => import("@/features/admin/drive-admin"), "DriveAdminSection", {
    scroll: true,
  }),
  "oauth-apps": section(() => import("@/features/admin/sections/oauth-apps"), "AdminApps"),
  "app-passwords": section(
    () => import("@/features/admin/app-passwords-management"),
    "AppPasswordsManagement",
    { scroll: true },
  ),
  "agent-credentials": section(
    () => import("@/features/admin/agent-credentials-management"),
    "AgentCredentialsManagement",
    { scroll: true },
  ),
  webhooks: section(() => import("@/features/webhooks/webhook-management"), "WebhookManagement", {
    scroll: true,
  }),
  "ai-costs": section(
    () => import("@/features/admin/ai-cost-limits-management"),
    "AICostLimitsManagement",
    { scroll: true },
  ),
  "ai-observability": section(
    () => import("@/features/admin/ai-observability"),
    "AIObservabilityDashboard",
    { scroll: true },
  ),
  services: section(() => import("@/features/admin/admin-services"), "AdminServicesOverview", {
    scroll: true,
  }),
};

/** The console body for one section. The section comes from the route, not
 *  component state, so every surface is linkable and survives refresh and
 *  back/forward. */
export function AdminConsole({ section }: { readonly section: AdminSectionId }) {
  const Section = SECTION_CONTENT[section];

  return (
    <SurfaceFrame title="Admin" icon={<Icons.Shield />}>
      <AdminSidebar section={section} />
      {/* The sidebar renders immediately; only the panel waits on its chunk.
          The fallback is deliberately empty: the chunk resolves in a tick on a
          local network, and a flashed skeleton reads as a slower load than no
          skeleton at all. Sections render their own loading state for data. */}
      <Suspense fallback={null}>
        <Section />
      </Suspense>
    </SurfaceFrame>
  );
}
