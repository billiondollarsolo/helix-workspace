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

/* `invited` used to be a third member of this union and an option in the Users
 * status filter, but the projection derives status from `disabledAt` alone —
 * nothing can ever produce it, so the filter matched zero rows forever. The
 * actors table has no invite state to source it from; add it back with the
 * column that stores it. */
export type UserStatus = "active" | "suspended";

/** How much of the admin surface an actor can reach.
 *
 *  Three values, not two, because this platform authorizes per scope and the
 *  two-value version was actively wrong. Route guards ask for a *specific*
 *  dotted scope or the wildcard — `canReadAdminUsers` in
 *  `platform/auth/admin-users.ts` is `scopes.includes("admin.users") ||
 *  scopes.includes("admin.*")` — so an operator holding only `admin.audit` is
 *  a real administrator of one surface, and calling them a Member (as
 *  `scopes.includes("admin")` did) hid every scoped admin in the workspace
 *  from the directory and from the Admin filter.
 *
 *  `Admin` is reserved for unrestricted access, because that is the only thing
 *  `platform/api/scopes.ts` treats as unrestricted: `*` and `admin.*` short-
 *  circuit every scope check, and `system` actors bypass them entirely.
 *  Everyone else with admin scopes is `Scoped admin` — named for the mechanism
 *  (an enumerated scope list) rather than implying a lesser operator. Which
 *  surfaces they hold is the scope list itself, so the row exposes it; a
 *  directory that cannot tell a full admin from an auditor is not one. */
export type UserRole = "Admin" | "Scoped admin" | "Member";

/** Filter/legend order — most privileged first. */
export const USER_ROLES: readonly UserRole[] = ["Admin", "Scoped admin", "Member"];

/* Bare `admin` is a legacy marker: it opens no route on its own (no guard in
 * the platform accepts it), but the seeded workspace admin carries it beside
 * the dotted grants, so it still signals "this is an admin account". The dot
 * is part of the prefix test so a future `administrator`-style scope cannot
 * be mistaken for an admin grant. */
function isAdminScope(scope: string): boolean {
  return scope === "admin" || scope.startsWith("admin.");
}

/** Scopes granting unrestricted access — see `actorHasScope`. */
function isWildcardScope(scope: string): boolean {
  return scope === "*" || scope === "admin.*";
}

/** The admin scopes an actor actually holds, in the order the API returned
 *  them. Empty for a Member. This is what distinguishes an auditor from a
 *  full administrator, so the row renders it rather than summarising it away. */
export function adminScopesOf(scopes: readonly string[]): readonly string[] {
  return scopes.filter((scope) => isAdminScope(scope) || isWildcardScope(scope));
}

/** Honest role for an actor, derived the way the platform actually authorizes.
 *
 *  Structurally typed rather than importing `AdminUser` so this stays a pure
 *  function over the two fields that decide the answer. */
export function roleForActor(actor: {
  readonly type: string;
  readonly scopes: readonly string[];
}): UserRole {
  // `actorHasScope` returns true for every scope when the actor is a system
  // actor, so a system identity is unrestricted no matter what it carries.
  if (actor.type === "system" || actor.scopes.some(isWildcardScope)) {
    return "Admin";
  }
  return actor.scopes.some(isAdminScope) ? "Scoped admin" : "Member";
}

/** Row view-model used by the Users table.
 *
 *  Only fields the admin users API actually returns. It previously carried
 *  `dept`, `mfa`, and `lastActive` too: `dept` was filled with the actor type
 *  (so every row read "user" under a Department heading), while `mfa` was
 *  hard-coded false — rendering a red ✗ against every account including the
 *  admin's own — and `lastActive` was always an em dash. Add them back with
 *  the columns when there are endpoints behind them. */
export interface DirectoryUser {
  /** Actor id. The table keys and selects on this: `email` is nullable and
   *  every agent/service actor without one collapsed to the same key, so
   *  ticking one checkbox ticked all of them while the counter said "1". */
  readonly id: string;
  readonly name: string;
  /** Null for actors with no address — rendered as unknown, never as a string
   *  that search or selection can match on. */
  readonly email: string | null;
  readonly role: UserRole;
  /** The admin scopes behind `role`, for the row's detail disclosure. */
  readonly adminScopes: readonly string[];
  /** Actor kind — human sign-ins vs. agent/service identities. */
  readonly actorType: string;
  readonly status: UserStatus;
  readonly createdAt: string;
  /** When the account was disabled; null while active. */
  readonly disabledAt: string | null;
}

/* ------------------------------------------------------------------ */
/* Navigation taxonomy                                                */
/* ------------------------------------------------------------------ */

/* Nineteen peer entries in one flat list gave no hint that "Apps" meant
 * third-party OAuth grants while "Core apps" meant first-party modules, or
 * that "Tier readiness" is a view of security posture rather than a sibling
 * of it. Sections are grouped by the question an admin is answering, and
 * each id is also its URL segment (`/admin/<id>`), so labels can be reworded
 * without breaking links.
 *
 * Overview sits above the groups: it is the console's landing page, not a
 * member of any category.
 *
 * `label` is also the name of the page it opens: every section's
 * `PageHeading title` must be this exact string. Seven sections drifted apart
 * from it — clicking `Domains` landed on a page headed "Domain", `OAuth apps`
 * on one headed "App permissions" — which reads as having navigated somewhere
 * else. The group title supplies the qualifier, so a label stays the short
 * noun ("Policies" under Security, not "Security policies") and the section's
 * subtitle carries the scope. Reword a label and you are renaming the h1 with
 * it; ids are URLs (`/admin/<id>`) and never change with a rename. */

export const ADMIN_NAV_ROOT = { id: "overview", label: "Overview", icon: "Grid" } as const;

export const ADMIN_NAV_GROUPS = [
  {
    title: "Organization",
    items: [
      { id: "domains", label: "Domains", icon: "Globe" },
      { id: "billing", label: "Billing & usage", icon: "Credit" },
      { id: "workspace-settings", label: "Workspace settings", icon: "Settings" },
    ],
  },
  {
    title: "People",
    items: [
      { id: "users", label: "Users", icon: "Users" },
      { id: "groups", label: "Groups & org units", icon: "Building" },
    ],
  },
  {
    title: "Security",
    items: [
      { id: "policies", label: "Policies", icon: "Lock" },
      { id: "identity", label: "Identity & SSO", icon: "Key" },
      { id: "tier-readiness", label: "Tier readiness", icon: "Shield" },
      { id: "audit", label: "Audit log", icon: "Log" },
    ],
  },
  {
    title: "Apps & integrations",
    items: [
      { id: "workspace-apps", label: "Workspace apps", icon: "Briefcase" },
      { id: "mail", label: "Mail", icon: "Mail" },
      { id: "chat", label: "Chat", icon: "Chat" },
      { id: "oauth-apps", label: "OAuth apps", icon: "Grid" },
      { id: "app-passwords", label: "App passwords", icon: "Key" },
      { id: "agent-credentials", label: "Agent credentials", icon: "Sparkles" },
      { id: "webhooks", label: "Webhooks", icon: "Send" },
    ],
  },
  {
    title: "AI",
    items: [
      { id: "ai-costs", label: "Cost limits", icon: "Credit" },
      { id: "ai-observability", label: "Observability", icon: "Eye" },
    ],
  },
  {
    title: "Platform",
    items: [{ id: "services", label: "Services", icon: "Settings" }],
  },
] as const;

export type AdminSectionId =
  (typeof ADMIN_NAV_ROOT)["id"] | (typeof ADMIN_NAV_GROUPS)[number]["items"][number]["id"];

/** Every section id, in sidebar order. */
/* Sections a deployment does not run.
 *
 * Billing is metered SaaS plumbing. A self-hosted install has no billing
 * service, so `/api/admin/billing/*` answers 404 and the section can only ever
 * render its own error — a top-level slot advertising a feature that is not
 * there. Off by default, matching this repo's fail-closed rule; a hosted build
 * sets VITE_HELIX_BILLING_ENABLED=true.
 *
 * Build-time rather than a capability probe: the sidebar renders on every admin
 * page, and giving it a runtime query would put one more request into the burst
 * that already trips the session rate limiter on Overview. */
const BILLING_ENABLED = import.meta.env.VITE_HELIX_BILLING_ENABLED === "true";

const DISABLED_SECTIONS: ReadonlySet<string> = new Set(BILLING_ENABLED ? [] : ["billing"]);

/** Nav groups this deployment actually serves. Groups left empty are dropped
 *  rather than rendered as a heading with nothing under it. */
export const ADMIN_NAV_GROUPS_FOR_BUILD = ADMIN_NAV_GROUPS.map((group) => ({
  title: group.title,
  items: group.items.filter((item) => !DISABLED_SECTIONS.has(item.id)),
})).filter((group) => group.items.length > 0);

export const ADMIN_SECTION_IDS: readonly AdminSectionId[] = [
  ADMIN_NAV_ROOT.id,
  ...ADMIN_NAV_GROUPS.flatMap((group) => group.items.map((item) => item.id)),
];

export const DEFAULT_ADMIN_SECTION: AdminSectionId = ADMIN_NAV_ROOT.id;

/** Route-param guard — `/admin/<anything>` has to be narrowed before use.
 *
 *  A section this deployment does not serve is treated as unknown, so
 *  `/admin/billing` 404s on a self-hosted install rather than rendering a page
 *  that is unreachable from the nav and can only show an error. */
export function isAdminSectionId(value: string): value is AdminSectionId {
  return (ADMIN_SECTION_IDS as readonly string[]).includes(value) && !DISABLED_SECTIONS.has(value);
}
