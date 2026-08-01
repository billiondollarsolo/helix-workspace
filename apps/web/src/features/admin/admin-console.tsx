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

import type { ReactNode } from "react";
import { Icons } from "@/components/icons";
import { SurfaceFrame } from "@/components/shell";
import { AdminSidebar } from "@/features/admin/console/sidebar";
import { PageScroll } from "@/features/admin/console/primitives";
import { AdminOverview } from "@/features/admin/sections/overview";
import { AdminUsers } from "@/features/admin/sections/users";
import { AdminGroups } from "@/features/admin/sections/groups";
import { AdminSecurity } from "@/features/admin/sections/policies";
import { AdminApps } from "@/features/admin/sections/oauth-apps";
import { AdminBilling } from "@/features/admin/sections/billing";
import { AdminDomain } from "@/features/admin/sections/domains";
import { MailAdminSection } from "@/features/admin/mail-admin";
import { AdminServicesOverview } from "@/features/admin/admin-services";
import { AppPasswordsManagement } from "@/features/admin/app-passwords-management";
import { AgentCredentialsManagement } from "@/features/admin/agent-credentials-management";
import { AICostLimitsManagement } from "@/features/admin/ai-cost-limits-management";
import { AIObservabilityDashboard } from "@/features/admin/ai-observability";
import { CoreAppsManagement } from "@/features/admin/core-apps-management";
import { IdentityManagement } from "@/features/admin/identity-management";
import { SecurityTierReadiness } from "@/features/admin/security-tier-readiness";
import { TenantConfigManagement } from "@/features/admin/tenant-config-management";
import { AuditLogList } from "@/features/admin/audit-log";
import { WebhookManagement } from "@/features/webhooks/webhook-management";
import type { AdminSectionId } from "@/features/admin/admin-console-data";

/** Wrap a section component in the standard PageScroll container so it picks
 * up the admin console's flex sizing and scroll behavior. Used for sections
 * that render their own internal padding but no outer scroll. */
function withPageScroll(Component: () => ReactNode): () => ReactNode {
  return function ScrolledSection() {
    return <PageScroll>{Component()}</PageScroll>;
  };
}

/** Section id (and URL segment) -> the component that renders it.
 *  Keyed by `AdminSectionId`, so adding a nav entry without wiring content —
 *  or leaving a stale entry behind — is a type error. */
const SECTION_CONTENT: Record<AdminSectionId, () => ReactNode> = {
  overview: AdminOverview,
  domains: AdminDomain,
  billing: AdminBilling,
  "workspace-settings": withPageScroll(TenantConfigManagement),
  users: AdminUsers,
  groups: AdminGroups,
  policies: AdminSecurity,
  identity: withPageScroll(IdentityManagement),
  "tier-readiness": withPageScroll(SecurityTierReadiness),
  audit: withPageScroll(AuditLogList),
  "workspace-apps": withPageScroll(CoreAppsManagement),
  mail: MailAdminSection,
  "oauth-apps": AdminApps,
  "app-passwords": withPageScroll(AppPasswordsManagement),
  "agent-credentials": withPageScroll(AgentCredentialsManagement),
  webhooks: withPageScroll(WebhookManagement),
  "ai-costs": withPageScroll(AICostLimitsManagement),
  "ai-observability": withPageScroll(AIObservabilityDashboard),
  services: withPageScroll(AdminServicesOverview),
};

/** The console body for one section. The section comes from the route, not
 *  component state, so every surface is linkable and survives refresh and
 *  back/forward. */
export function AdminConsole({ section }: { readonly section: AdminSectionId }) {
  const Section = SECTION_CONTENT[section];

  return (
    <SurfaceFrame title="Admin" icon={<Icons.Shield />}>
      <AdminSidebar section={section} />
      <Section />
    </SurfaceFrame>
  );
}
