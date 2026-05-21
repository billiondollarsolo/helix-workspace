import type { QueryClient } from "@tanstack/react-query";
import {
  Activity,
  Bot,
  KeyRound,
  LayoutGrid,
  type LucideIcon,
  Mail,
  PlugZap,
  ServerCog,
  ShieldCheck,
  SlidersHorizontal,
  UsersRound,
  Webhook,
} from "lucide-react";
import type { ReactNode } from "react";
import { AgentCredentialsManagement } from "./agent-credentials-management";
import { agentCredentialsQueryOptions } from "./agent-credentials-api";
import { AppPasswordsManagement } from "./app-passwords-management";
import { appPasswordsQueryOptions } from "./app-passwords-api";
import { AdminServicesOverview, prefetchAdminServicesQuery } from "./admin-services";
import { AdminUsersList, prefetchAdminUsersQuery } from "./admin-users";
import { CoreAppsManagement, prefetchAdminCoreAppsQuery } from "./core-apps-management";
import { AICostLimitsManagement, prefetchAdminAICostLimitsQuery } from "./ai-cost-limits-management";
import { AIObservabilityDashboard, prefetchAdminAIObservabilityQuery } from "./ai-observability";
import { AuditLogList, prefetchAdminAuditLogQuery } from "./audit-log";
import { MailConfiguration, prefetchAdminMailConfigurationQuery } from "./mail-configuration";
import { prefetchAdminReadinessQueries, SecurityTierReadiness } from "./security-tier-readiness";
import {
  inboundWebhooksQueryOptions,
  outboundWebhooksQueryOptions,
  webhookDeliveriesQueryOptions,
} from "@/features/webhooks/api";
import { WebhookManagement } from "@/features/webhooks/webhook-management";

export async function prefetchAdminDashboardQueries(queryClient: QueryClient) {
  await Promise.all([
    prefetchAdminUsersQuery(queryClient),
    prefetchAdminAuditLogQuery(queryClient),
    prefetchAdminReadinessQueries(queryClient).catch(() => undefined),
    prefetchAdminServicesQuery(queryClient).catch(() => undefined),
    prefetchAdminCoreAppsQuery(queryClient).catch(() => undefined),
    prefetchAdminAIObservabilityQuery(queryClient).catch(() => undefined),
    prefetchAdminAICostLimitsQuery(queryClient).catch(() => undefined),
    prefetchAdminMailConfigurationQuery(queryClient).catch(() => undefined),
    queryClient.ensureQueryData(agentCredentialsQueryOptions(false)).catch(() => undefined),
    queryClient.ensureQueryData(appPasswordsQueryOptions(false)).catch(() => undefined),
    queryClient.ensureQueryData(outboundWebhooksQueryOptions()).catch(() => undefined),
    queryClient.ensureQueryData(inboundWebhooksQueryOptions()).catch(() => undefined),
    queryClient.ensureQueryData(webhookDeliveriesQueryOptions()).catch(() => undefined),
  ]);
}

export function AdminDashboard() {
  return (
    <div className="admin-control-plane">
      <aside className="admin-sidebar" aria-label="Admin sections">
        <div className="admin-sidebar-header">
          <p>Admin</p>
          <h1>Control plane</h1>
        </div>
        <nav className="admin-nav" aria-label="Admin navigation">
          {adminSections.map((section) => {
            const Icon = section.icon;
            return (
              <a href={`#${section.id}`} key={section.id}>
                <Icon aria-hidden="true" size={17} />
                <span>{section.label}</span>
              </a>
            );
          })}
        </nav>
      </aside>

      <main className="admin-page" aria-labelledby="admin-overview-title">
        <section className="admin-overview" id="overview" aria-labelledby="admin-overview-title">
          <div>
            <p className="admin-section-kicker">Overview</p>
            <h2 id="admin-overview-title">Admin</h2>
            <p>
              Operational controls for users, security, integrations, email, AI, audit, and
              deployment readiness.
            </p>
          </div>
          <div className="admin-overview-grid" aria-label="Admin scope">
            <AdminScopeCard
              icon={UsersRound}
              title="Users"
              text="People, agents, service accounts"
            />
            <AdminScopeCard
              icon={ShieldCheck}
              title="Policy"
              text="Security tier, permissions, plugins"
            />
            <AdminScopeCard
              icon={Webhook}
              title="Integrations"
              text="Webhooks, mail, delivery paths"
            />
            <AdminScopeCard
              icon={Activity}
              title="Evidence"
              text="Audit, observability, readiness"
            />
          </div>
        </section>

        <AdminSection id="services" kicker="Platform services" title="Services overview">
          <AdminServicesOverview />
        </AdminSection>

        <AdminSection id="core-apps" kicker="Platform apps" title="Core apps">
          <CoreAppsManagement />
        </AdminSection>

        <AdminSection id="users" kicker="Users & actors" title="Users">
          <AdminUsersList />
        </AdminSection>

        <AdminSection id="access" kicker="Permissions" title="Credentials and access">
          <div className="admin-stack">
            <AgentCredentialsManagement />
            <AppPasswordsManagement />
          </div>
        </AdminSection>

        <AdminSection id="security" kicker="Security tier" title="Policy and plugin readiness">
          <SecurityTierReadiness />
        </AdminSection>

        <AdminSection id="email" kicker="Email" title="Mail configuration">
          <MailConfiguration />
        </AdminSection>

        <AdminSection id="webhooks" kicker="Integrations" title="Webhooks">
          <WebhookManagement />
        </AdminSection>

        {/*
         * Section title is "AI & agents" (not "AI observability"): this section
         * wraps both the observability dashboard AND cost-limits management.
         * `AIObservabilityDashboard` renders the single `<h2>AI observability</h2>`
         * for its own panel — duplicating it here caused two identical headings.
         */}
        <AdminSection id="ai" kicker="AI & agents" title="AI & agents">
          <div className="admin-stack">
            <AIObservabilityDashboard />
            <AICostLimitsManagement />
          </div>
        </AdminSection>

        <AdminSection id="audit" kicker="Audit" title="Audit log">
          <AuditLogList />
        </AdminSection>
      </main>
    </div>
  );
}

const adminSections = [
  { id: "overview", label: "Overview", icon: SlidersHorizontal },
  { id: "services", label: "Services", icon: ServerCog },
  { id: "core-apps", label: "Core apps", icon: LayoutGrid },
  { id: "users", label: "Users", icon: UsersRound },
  { id: "access", label: "Access", icon: KeyRound },
  { id: "security", label: "Security", icon: ShieldCheck },
  { id: "email", label: "Email", icon: Mail },
  { id: "webhooks", label: "Webhooks", icon: PlugZap },
  { id: "ai", label: "AI & agents", icon: Bot },
  { id: "audit", label: "Audit", icon: Activity },
] as const;

function AdminSection({
  children,
  id,
  kicker,
  title,
}: {
  readonly children: ReactNode;
  readonly id: string;
  readonly kicker: string;
  readonly title: string;
}) {
  return (
    <section className="admin-section" id={id} aria-labelledby={`${id}-title`}>
      <header className="admin-section-header">
        <div>
          <p className="admin-section-kicker">{kicker}</p>
          <h2 id={`${id}-title`}>{title}</h2>
        </div>
      </header>
      {children}
    </section>
  );
}

function AdminScopeCard({
  icon: Icon,
  text,
  title,
}: {
  readonly icon: LucideIcon;
  readonly text: string;
  readonly title: string;
}) {
  return (
    <div className="admin-scope-card">
      <Icon aria-hidden="true" size={18} />
      <div>
        <strong>{title}</strong>
        <span>{text}</span>
      </div>
    </div>
  );
}
