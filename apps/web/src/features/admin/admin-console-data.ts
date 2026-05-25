/* Admin console — static UI taxonomy.
 *
 * The Helix design handoff used to ship a large `*_DATA` seed bundle here
 * (workspace meta, sign-in chart, audit events, OAuth apps, DNS records,
 * billing plan/invoices, etc.) used as offline fallbacks throughout the
 * console. That seed was removed: the console now renders only live data
 * from the platform APIs, and surfaces loading / error / empty states when
 * an endpoint is unavailable. The only thing that lives here now is the
 * static sidebar nav and a couple of view-model types shared by AdminUsers.
 */

export type UserStatus = "active" | "invited" | "suspended";
export type UserRole = "Admin" | "Member";

/** Row view-model used by the Users table. */
export interface DirectoryUser {
  readonly name: string;
  readonly email: string;
  readonly role: UserRole;
  readonly dept: string;
  readonly status: UserStatus;
  readonly mfa: boolean;
  readonly lastActive: string;
}

export const ADMIN_NAV = [
  { id: "overview", label: "Overview", icon: "Grid" },
  { id: "users", label: "Users", icon: "Users" },
  { id: "groups", label: "Groups & OUs", icon: "Building" },
  { id: "security", label: "Security", icon: "Shield" },
  { id: "identity", label: "Identity", icon: "Key" },
  { id: "apps", label: "Apps", icon: "Grid" },
  { id: "core-apps", label: "Core apps", icon: "Briefcase" },
  { id: "services", label: "Services", icon: "Settings" },
  { id: "app-passwords", label: "App passwords", icon: "Key" },
  { id: "agents", label: "Agent credentials", icon: "Sparkles" },
  { id: "ai-costs", label: "AI cost limits", icon: "Credit" },
  { id: "ai-observability", label: "AI observability", icon: "Eye" },
  { id: "billing", label: "Billing", icon: "Credit" },
  { id: "audit", label: "Audit log", icon: "Log" },
  { id: "domain", label: "Domain", icon: "Globe" },
  { id: "mail", label: "Mail", icon: "Mail" },
  { id: "webhooks", label: "Webhooks", icon: "Globe" },
] as const;

export type AdminSectionId = (typeof ADMIN_NAV)[number]["id"];
