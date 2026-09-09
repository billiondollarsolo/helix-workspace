/**
 * ADM.1 — Admin control inventory.
 *
 * Single code-side inventory of operator-facing admin surfaces and whether
 * they are enforced, honestly disabled, or recorded-only. Tests pin this list
 * so new admin UI without a backend path fails CI.
 */

import {
  SECURITY_POLICY_RUNTIME_CAPABILITIES,
  type PolicyRuntimeMode,
} from "./security-policy-runtime.js";

export type AdminControlSurface =
  | "security_policies"
  | "identity_idp"
  | "scim"
  | "app_passwords"
  | "audit_log"
  | "users_groups"
  | "domains_dns"
  | "core_apps"
  | "billing_plan"
  | "oauth_apps"
  | "tenant_config"
  | "mail_admin"
  | "chat_admin"
  | "agent_credentials";

export interface AdminControlInventoryEntry {
  readonly id: string;
  readonly surface: AdminControlSurface;
  readonly title: string;
  /** Primary HTTP/tool paths the operator action hits. */
  readonly paths: readonly string[];
  readonly mode: PolicyRuntimeMode | "enforced" | "honest_disable" | "partial";
  readonly notes: string;
}

export const ADMIN_CONTROL_INVENTORY: readonly AdminControlInventoryEntry[] = [
  ...SECURITY_POLICY_RUNTIME_CAPABILITIES.map((capability) => ({
    id: `security_policy.${capability.policyType}`,
    surface: "security_policies" as const,
    title: `Security policy: ${capability.policyType}`,
    paths: [
      "GET /api/admin/security-policies",
      `PUT /api/admin/security-policies/${capability.policyType}`,
      ...capability.enforcementPoints,
    ],
    mode: capability.mode,
    notes: capability.summary,
  })),
  {
    id: "identity.idp_configs",
    surface: "identity_idp",
    title: "Tenant IdP (SAML/OIDC) configuration",
    paths: [
      "GET /api/admin/identity/idp-configs",
      "POST /api/admin/identity/idp-configs",
      "GET /api/auth/saml/:tenantSlug/metadata",
    ],
    mode: "partial",
    notes:
      "IdP configs and SP metadata are live; ACS/OIDC login runtime remains partial (test-login → runtime_pending).",
  },
  {
    id: "identity.scim",
    surface: "scim",
    title: "SCIM v2 provisioning",
    paths: [
      "GET /api/scim/v2/:tenantSlug/ServiceProviderConfig",
      "GET /api/scim/v2/:tenantSlug/Users",
    ],
    mode: "partial",
    notes:
      "Auth is enforced per-tenant bearer; mutations return honest 501 until provisioning is complete.",
  },
  {
    id: "auth.app_passwords",
    surface: "app_passwords",
    title: "App passwords",
    paths: ["tool:app.passwords.list", "tool:app.passwords.create", "tool:app.passwords.revoke"],
    mode: "enforced",
    notes: "Create/list/revoke tools enforce scopes; Basic auth uses hashed secrets.",
  },
  {
    id: "audit.log",
    surface: "audit_log",
    title: "Immutable audit log",
    paths: ["GET /api/admin/audit-log", "admin console audit mutations via auditAdminAction"],
    mode: "enforced",
    notes: "Admin mutations append through the immutable audit store.",
  },
  {
    id: "directory.users_groups",
    surface: "users_groups",
    title: "Users & groups",
    paths: ["GET /api/admin/users", "GET/POST /api/admin/groups"],
    mode: "enforced",
    notes: "Admin console scope gates; org_id scoped stores.",
  },
  {
    id: "domains.dns",
    surface: "domains_dns",
    title: "Domain registry & DNS verification",
    paths: ["GET/POST /api/admin/domains", "domain verify tools"],
    mode: "partial",
    notes: "Domain registry + DNS checks exist; continuous monitoring/alerts remain partial.",
  },
  {
    id: "apps.core_enablement",
    surface: "core_apps",
    title: "Core apps enablement",
    paths: ["GET/PUT /api/admin/core-apps", "HELIX_APPS / production-assertions"],
    mode: "partial",
    notes: "Admin UI + packaging gates; production fail-closed on MVP allowlist.",
  },
  {
    id: "billing.plan",
    surface: "billing_plan",
    title: "Plan / license UI",
    paths: ["GET /api/admin/billing"],
    mode: "partial",
    notes: "Self-host plan surface; SaaS billing is out of v1 GA scope.",
  },
  {
    id: "oauth.apps",
    surface: "oauth_apps",
    title: "OAuth apps",
    paths: ["GET/POST /api/admin/oauth-apps"],
    mode: "enforced",
    notes: "Admin-managed OAuth clients with audit.",
  },
  {
    id: "tenant.config",
    surface: "tenant_config",
    title: "Tenant feature config",
    paths: ["GET/PUT /api/admin/tenant-config"],
    mode: "enforced",
    notes: "Feature flags/storage config with org scope.",
  },
  {
    id: "mail.admin",
    surface: "mail_admin",
    title: "Mail admin",
    paths: ["mail admin tools / receiving domains"],
    mode: "partial",
    notes: "Mail admin surfaces exist; full capability matrix partial.",
  },
  {
    id: "chat.admin",
    surface: "chat_admin",
    title: "Chat retention / legal hold / export",
    paths: [
      "tool:chat.retention.get",
      "tool:chat.retention.set",
      "tool:chat.legal_hold.set",
      "tool:chat.export.organization",
    ],
    mode: "enforced",
    notes: "Admin Chat section uses real tools with confirmation gates.",
  },
  {
    id: "agents.credentials",
    surface: "agent_credentials",
    title: "Agent credentials & cost limits",
    paths: ["agent credential admin tools", "AI cost limit admin tools"],
    mode: "enforced",
    notes: "Credential policy enforcement on tool surfaces.",
  },
];

export function adminControlsBySurface(
  surface: AdminControlSurface,
): readonly AdminControlInventoryEntry[] {
  return ADMIN_CONTROL_INVENTORY.filter((entry) => entry.surface === surface);
}

export function adminControlById(id: string): AdminControlInventoryEntry | undefined {
  return ADMIN_CONTROL_INVENTORY.find((entry) => entry.id === id);
}
