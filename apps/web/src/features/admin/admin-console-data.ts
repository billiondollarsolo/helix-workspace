/* Admin console seed data.
 *
 * The Helix design handoff ships a high-fidelity Admin console with eight
 * sections. The **Users** section is wired to the real `adminUsersQueryOptions`
 * API (see `admin-console.tsx`); every other section's content has no backend
 * endpoint yet, so it is ported here as typed seed data — mirroring the
 * handoff's `USERS_DATA` + per-section literals. Replace each `*_DATA` export
 * with a TanStack Query call once the matching `/api/admin/*` endpoint exists.
 */

export type Severity = "info" | "warning" | "danger";
export type UserStatus = "active" | "invited" | "suspended";
export type UserRole = "Admin" | "Member";

/** Workspace meta shown in the Overview header. */
export interface WorkspaceMeta {
  readonly domain: string;
  readonly plan: string;
  readonly licenses: number;
}

export const WORKSPACE_META: WorkspaceMeta = {
  domain: "helix.io",
  plan: "Business Plus",
  licenses: 124,
};

/** Overview stat cards. */
export interface StatCardData {
  readonly label: string;
  readonly value: string;
  readonly delta?: string;
  readonly deltaPositive?: boolean;
  readonly icon: "Users" | "Shield" | "Mail" | "Drive";
}

export const OVERVIEW_STATS: readonly StatCardData[] = [
  { label: "Active users", value: "118", delta: "+4 this month", deltaPositive: true, icon: "Users" },
  { label: "MFA enrolled", value: "94%", delta: "+6% vs target", deltaPositive: true, icon: "Shield" },
  { label: "Pending invites", value: "3", icon: "Mail" },
  { label: "Storage used", value: "2.4 TB", delta: "of 5 TB plan", icon: "Drive" },
];

/** Seven-day sign-in activity bar chart (percent heights). */
export interface SignInBar {
  readonly day: string;
  readonly value: number;
  /** True for projected/future days — rendered at reduced opacity. */
  readonly projected?: boolean;
}

export const SIGN_IN_ACTIVITY: readonly SignInBar[] = [
  { day: "M", value: 62 },
  { day: "T", value: 78 },
  { day: "W", value: 88 },
  { day: "T", value: 92 },
  { day: "F", value: 74 },
  { day: "S", value: 21, projected: true },
  { day: "S", value: 18, projected: true },
];

export interface AdminEvent {
  readonly who: string;
  readonly what: string;
  readonly when: string;
}

export const RECENT_ADMIN_EVENTS: readonly AdminEvent[] = [
  { who: "Mira Okafor", what: "Updated MFA policy", when: "10m" },
  { who: "Jonas Reichert", what: "Granted Drive admin role", when: "1h" },
  { who: "System", what: "Renewed SSL certificate", when: "3h" },
  { who: "Sasha Levin", what: "Invited 3 new users", when: "1d" },
];

export interface SecurityRecommendation {
  readonly title: string;
  readonly desc: string;
  readonly severity: Severity;
}

export const SECURITY_RECOMMENDATIONS: readonly SecurityRecommendation[] = [
  {
    title: "Require MFA for all users",
    desc: "8 users have not enrolled. Enforcement deadline: June 1.",
    severity: "warning",
  },
  {
    title: "Restrict third-party OAuth scopes",
    desc: "2 apps requesting high-risk scopes are pending review.",
    severity: "danger",
  },
  {
    title: "Review inactive accounts",
    desc: "3 users haven't signed in for 90+ days.",
    severity: "info",
  },
];

/** Fallback user directory — used when the real admin users API is empty or
 *  unavailable, and to enrich live rows with design fields the API lacks
 *  (department / MFA / last-active). */
export interface DirectoryUser {
  readonly name: string;
  readonly email: string;
  readonly role: UserRole;
  readonly dept: string;
  readonly status: UserStatus;
  readonly mfa: boolean;
  readonly lastActive: string;
}

export const USERS_DATA: readonly DirectoryUser[] = [
  { name: "Mira Okafor", email: "mira@helix.io", role: "Admin", dept: "Product", status: "active", mfa: true, lastActive: "2 min ago" },
  { name: "Jonas Reichert", email: "jonas@helix.io", role: "Member", dept: "Engineering", status: "active", mfa: true, lastActive: "5 min ago" },
  { name: "Priya Anand", email: "priya@helix.io", role: "Member", dept: "Design", status: "active", mfa: true, lastActive: "1 hour ago" },
  { name: "Daniel Cho", email: "daniel@helix.io", role: "Member", dept: "Engineering", status: "active", mfa: true, lastActive: "1 hour ago" },
  { name: "Sasha Levin", email: "sasha@helix.io", role: "Member", dept: "People", status: "active", mfa: false, lastActive: "Yesterday" },
  { name: "Rumi Tanaka", email: "rumi@helix.io", role: "Member", dept: "Sales", status: "active", mfa: true, lastActive: "Yesterday" },
  { name: "Owen Hart", email: "owen@helix.io", role: "Member", dept: "Marketing", status: "active", mfa: true, lastActive: "2 days ago" },
  { name: "Naveen Iyer", email: "naveen@helix.io", role: "Member", dept: "Finance", status: "active", mfa: true, lastActive: "1 hour ago" },
  { name: "Iris Lambert", email: "iris@helix.io", role: "Member", dept: "Legal", status: "active", mfa: true, lastActive: "3 days ago" },
  { name: "Theo Marchetti", email: "theo@helix.io", role: "Member", dept: "Support", status: "active", mfa: true, lastActive: "30 min ago" },
  { name: "Lin Wei", email: "lin@helix.io", role: "Member", dept: "Engineering", status: "invited", mfa: false, lastActive: "—" },
  { name: "Marcus Bell", email: "marcus@helix.io", role: "Member", dept: "Sales", status: "suspended", mfa: false, lastActive: "2 weeks ago" },
];

export interface OrgUnit {
  readonly name: string;
  readonly members: number;
  readonly type: "OU" | "Group";
  /** Tree indent level for OU rows. */
  readonly indent?: number;
}

export const GROUPS_DATA: readonly OrgUnit[] = [
  { name: "Engineering", members: 42, type: "OU" },
  { name: "Engineering › Platform", members: 12, type: "OU", indent: 1 },
  { name: "Engineering › Product", members: 24, type: "OU", indent: 1 },
  { name: "Engineering › Infra", members: 6, type: "OU", indent: 1 },
  { name: "Design", members: 9, type: "OU" },
  { name: "Product", members: 8, type: "OU" },
  { name: "Sales", members: 14, type: "OU" },
  { name: "Marketing", members: 7, type: "OU" },
  { name: "Operations", members: 11, type: "OU" },
  { name: "all-hands@helix.io", members: 124, type: "Group" },
  { name: "leads@helix.io", members: 18, type: "Group" },
  { name: "security@helix.io", members: 6, type: "Group" },
];

export interface PolicyChip {
  readonly label: string;
  /** Chip variant — undefined renders the neutral chip. */
  readonly variant?: "success" | "warning";
  /** Reduce opacity for disabled options. */
  readonly muted?: boolean;
  /** Show a check glyph instead of a dot. */
  readonly check?: boolean;
  /** Show a dot glyph. */
  readonly dot?: boolean;
}

export interface PolicyCardData {
  readonly title: string;
  readonly desc: string;
  /** State chip text (Required / Active / Limited …). */
  readonly level: string;
  /** Whether the policy is on (drives the level chip color). */
  readonly on: boolean;
  /** Optional plain-text detail line. */
  readonly detail?: string;
  /** Optional chip row. */
  readonly chips?: readonly PolicyChip[];
}

export interface SecuritySection {
  readonly label: string;
  readonly cards: readonly PolicyCardData[];
}

export const SECURITY_SECTIONS: readonly SecuritySection[] = [
  {
    label: "Authentication",
    cards: [
      {
        title: "Multi-factor authentication",
        desc: "Enforce MFA for all users on this domain. Hardware keys preferred; TOTP allowed.",
        level: "Required",
        on: true,
        chips: [
          { label: "Hardware key" },
          { label: "TOTP" },
          { label: "SMS (off)", muted: true },
        ],
      },
      {
        title: "Single sign-on (SSO)",
        desc: "SAML SSO with Okta. JIT provisioning is enabled for matched email domains.",
        level: "Active",
        on: true,
        detail: "okta.helix.io · 124 users mapped",
      },
      {
        title: "Session management",
        desc: "Session expires after 14 days of inactivity. Force re-auth for sensitive admin actions.",
        level: "Active",
        on: true,
        chips: [{ label: "14 day session" }, { label: "2 step for admin" }],
      },
    ],
  },
  {
    label: "Access & data",
    cards: [
      {
        title: "External sharing",
        desc: "Allow sharing files and docs outside the organization with allowlist for trusted domains.",
        level: "Limited",
        on: false,
        chips: [
          { label: "atlas-holdings.com" },
          { label: "brightline.io" },
          { label: "northwind.co" },
        ],
      },
      {
        title: "DLP — Data loss prevention",
        desc: "Scan outgoing mail and shared docs for PII, credentials, and credit card numbers.",
        level: "Active",
        on: true,
        detail: "3 detectors active · 12 incidents this month",
      },
      {
        title: "Device trust",
        desc: "Require company-managed devices for accessing Drive and Mail.",
        level: "Active",
        on: true,
        chips: [
          { label: "118 trusted", variant: "success", check: true },
          { label: "4 pending", variant: "warning", dot: true },
        ],
      },
    ],
  },
];

export type AppRisk = "low" | "medium" | "high";
export type AppState = "approved" | "pending" | "blocked";

export interface OAuthApp {
  readonly name: string;
  readonly scope: string;
  readonly users: number;
  readonly risk: AppRisk;
  readonly state: AppState;
}

export const OAUTH_APPS: readonly OAuthApp[] = [
  { name: "GitHub", scope: "Read repos, write commits", users: 42, risk: "low", state: "approved" },
  { name: "Linear", scope: "Read/write issues", users: 38, risk: "low", state: "approved" },
  { name: "Slack", scope: "Profile, calendar", users: 124, risk: "low", state: "approved" },
  { name: "Notion", scope: "Drive read", users: 12, risk: "medium", state: "approved" },
  { name: "Apollo.io", scope: "Read contacts, send mail on behalf", users: 4, risk: "high", state: "pending" },
  { name: "DataDog", scope: "Read audit log", users: 6, risk: "medium", state: "approved" },
  { name: "Loom", scope: "Drive write", users: 22, risk: "low", state: "approved" },
  { name: "Unknown app (helper-bot)", scope: "Full mail access", users: 1, risk: "high", state: "blocked" },
];

export interface BillingMeter {
  readonly label: string;
  readonly value: string;
  /** Fill fraction 0–1. */
  readonly bar: number;
}

export interface BillingPlan {
  readonly name: string;
  readonly priceLine: string;
  readonly meters: readonly BillingMeter[];
}

export const BILLING_PLAN: BillingPlan = {
  name: "Business Plus",
  priceLine: "$28 per user / month · billed annually",
  meters: [
    { label: "Licenses used", value: "118 / 124", bar: 0.95 },
    { label: "Storage", value: "2.4 / 5 TB", bar: 0.48 },
    { label: "AI credits", value: "184k / 250k", bar: 0.74 },
  ],
};

export interface NextInvoice {
  readonly amount: string;
  readonly date: string;
}

export const NEXT_INVOICE: NextInvoice = {
  amount: "$41,664.00",
  date: "June 1, 2026",
};

export interface Invoice {
  readonly id: string;
  readonly date: string;
  readonly amount: string;
  readonly status: string;
}

export const RECENT_INVOICES: readonly Invoice[] = [
  { id: "INV-2026-0521", date: "May 1, 2026", amount: "$41,440.00", status: "Paid" },
  { id: "INV-2026-0421", date: "Apr 1, 2026", amount: "$41,216.00", status: "Paid" },
  { id: "INV-2026-0321", date: "Mar 1, 2026", amount: "$40,768.00", status: "Paid" },
  { id: "INV-2026-0221", date: "Feb 1, 2026", amount: "$40,320.00", status: "Paid" },
];

export interface AuditEvent {
  readonly time: string;
  readonly actor: string;
  readonly action: string;
  readonly target: string;
  readonly ip: string;
  readonly severity: Severity;
}

export const AUDIT_EVENTS: readonly AuditEvent[] = [
  { time: "10:42:11", actor: "Mira Okafor", action: "policy.update", target: "mfa-policy", ip: "10.0.4.21", severity: "info" },
  { time: "10:38:02", actor: "alex@helix.io", action: "user.role_change", target: "jonas@helix.io → Admin", ip: "10.0.4.21", severity: "warning" },
  { time: "10:21:45", actor: "System", action: "sso.token_refresh", target: "okta-saml", ip: "—", severity: "info" },
  { time: "09:55:19", actor: "lin@helix.io", action: "auth.signin", target: "helix-mail (web)", ip: "172.16.2.4", severity: "info" },
  { time: "09:42:08", actor: "Naveen Iyer", action: "drive.share_external", target: "Q3-Forecast.xlsx → atlas-holdings.com", ip: "10.0.4.12", severity: "warning" },
  { time: "09:30:00", actor: "System", action: "dlp.detect", target: "Outbound mail flagged (credit card)", ip: "—", severity: "danger" },
  { time: "09:14:32", actor: "Sasha Levin", action: "user.invite", target: "marcus@helix.io", ip: "10.0.4.18", severity: "info" },
  { time: "08:59:01", actor: "Jonas Reichert", action: "admin.signin", target: "admin console", ip: "10.0.4.22", severity: "info" },
  { time: "08:42:17", actor: "Daniel Cho", action: "app.authorize", target: "Apollo.io (high-risk)", ip: "10.0.4.41", severity: "danger" },
];

export interface DnsRecord {
  readonly type: string;
  readonly host: string;
  readonly value: string;
  readonly status: "Verified" | "Pending";
}

export const DOMAIN_DNS_RECORDS: readonly DnsRecord[] = [
  { type: "MX", host: "helix.io", value: "10 mx1.helix.io", status: "Verified" },
  { type: "SPF", host: "helix.io", value: "v=spf1 include:_spf.helix.io ~all", status: "Verified" },
  { type: "DKIM", host: "helix._domainkey", value: "v=DKIM1; k=rsa; p=MIGfMA0…", status: "Verified" },
  { type: "DMARC", host: "_dmarc.helix.io", value: "v=DMARC1; p=quarantine; rua=…", status: "Verified" },
];

export const ADMIN_NAV = [
  { id: "overview", label: "Overview", icon: "Grid" },
  { id: "users", label: "Users", icon: "Users" },
  { id: "groups", label: "Groups & OUs", icon: "Building" },
  { id: "security", label: "Security", icon: "Shield" },
  { id: "apps", label: "Apps", icon: "Grid" },
  { id: "billing", label: "Billing", icon: "Credit" },
  { id: "audit", label: "Audit log", icon: "Log" },
  { id: "domain", label: "Domain", icon: "Globe" },
  { id: "mail", label: "Mail", icon: "Mail" },
] as const;

export type AdminSectionId = (typeof ADMIN_NAV)[number]["id"];
