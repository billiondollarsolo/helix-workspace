/* Admin console — static UI taxonomy.
 *
 * The Helix design handoff used to ship a large `*_DATA` seed bundle here
 * (workspace meta, sign-in chart, audit events, OAuth apps, DNS records,
 * etc.) used as offline fallbacks throughout the
 * console. That seed was removed: the console now renders only live data
 * from the platform APIs, and surfaces loading / error / empty states when
 * an endpoint is unavailable. The only thing that lives here now is the
 * static sidebar nav and a couple of view-model types shared by AdminUsers.
 */

/* Workspace membership state from the admin users API: `suspended` is the
 * reversible hold an administrator can lift; `removed` accounts were
 * offboarded or deprovisioned and stay closed. */
export type UserStatus = "active" | "invited" | "suspended" | "removed";

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

/** Whether these scopes open the Admin console: a wildcard or any dotted
 *  `admin.` grant. The bare legacy `admin` marker opens no admin route, so it
 *  alone does not count. */
export function hasAdminConsoleAccess(scopes: readonly string[]): boolean {
  return scopes.some((scope) => isWildcardScope(scope) || scope.startsWith("admin."));
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
  /** When the account was suspended or removed; null while active. */
  readonly disabledAt: string | null;
  /** Last sign-in to this workspace; null if they never signed in. */
  readonly lastSignInAt: string | null;
}

/* ------------------------------------------------------------------ */
/* Navigation taxonomy                                                */
/* ------------------------------------------------------------------ */

/* Sections are grouped the way a workspace administrator looks for them:
 * people first, then each app's settings, then security, reporting, and the
 * account itself. Each id is also its URL segment (`/admin/<id>`).
 *
 * `label` is the page's `<h1>` as well as its nav entry, so the two always
 * agree. */

export const ADMIN_NAV_ROOT = { id: "overview", label: "Home", icon: "Grid" } as const;

export const ADMIN_NAV_GROUPS = [
  {
    title: "Directory",
    items: [
      { id: "users", label: "Users", icon: "Users" },
      { id: "groups", label: "Groups & org units", icon: "Building" },
    ],
  },
  {
    title: "Apps",
    items: [
      { id: "workspace-apps", label: "All apps", icon: "Briefcase" },
      { id: "mail", label: "Mail", icon: "Mail" },
      { id: "drive", label: "Drive", icon: "Drive" },
      { id: "chat", label: "Chat", icon: "Chat" },
      { id: "calendar", label: "Calendar", icon: "Calendar" },
      { id: "meet", label: "Meet", icon: "Video" },
      { id: "assistant", label: "Assistant", icon: "Sparkles" },
      { id: "passwords", label: "Passwords", icon: "Key" },
    ],
  },
  {
    title: "Security",
    items: [
      { id: "policies", label: "Policies", icon: "Lock" },
      { id: "identity", label: "Identity & SSO", icon: "Key" },
      { id: "app-passwords", label: "App passwords", icon: "Key" },
      { id: "oauth-apps", label: "OAuth apps", icon: "Grid" },
      { id: "agent-credentials", label: "Agent credentials", icon: "Code" },
      { id: "agent-secrets", label: "Agent secrets", icon: "Lock" },
      { id: "agent-mail", label: "Agent mail", icon: "Mail" },
      { id: "agent-controls", label: "Agent controls", icon: "Shield" },
      { id: "tier-readiness", label: "Security tier", icon: "Shield" },
    ],
  },
  {
    title: "Reporting",
    items: [
      { id: "audit", label: "Audit log", icon: "Log" },
      { id: "ai-costs", label: "AI costs", icon: "Credit" },
      { id: "ai-observability", label: "AI observability", icon: "Eye" },
    ],
  },
  {
    title: "Account",
    items: [
      { id: "domains", label: "Domains", icon: "Globe" },
      { id: "workspace-settings", label: "Workspace settings", icon: "Settings" },
      { id: "services", label: "Services", icon: "Archive" },
      { id: "webhooks", label: "Webhooks", icon: "Send" },
    ],
  },
] as const;

export type AdminSectionId =
  (typeof ADMIN_NAV_ROOT)["id"] | (typeof ADMIN_NAV_GROUPS)[number]["items"][number]["id"];

/** Every section id, in sidebar order. */
export const ADMIN_SECTION_IDS: readonly AdminSectionId[] = [
  ADMIN_NAV_ROOT.id,
  ...ADMIN_NAV_GROUPS.flatMap((group) => group.items.map((item) => item.id)),
];

export const DEFAULT_ADMIN_SECTION: AdminSectionId = ADMIN_NAV_ROOT.id;

/** Nav label for a section id — the same string as its `PageHeading title`.
 *
 *  Read by the console chrome so the topbar names the destination. That happens
 *  outside the section's Suspense boundary, which is the point: during a cold
 *  navigation the `<h1>` has not rendered yet, and a topbar still reading
 *  "Admin" is why a click used to look like nothing had happened.
 *
 *  Built from `ADMIN_NAV_GROUPS`. */
const SECTION_LABELS: Record<string, string> = Object.fromEntries<string>([
  [ADMIN_NAV_ROOT.id, ADMIN_NAV_ROOT.label],
  ...ADMIN_NAV_GROUPS.flatMap((group) =>
    group.items.map((item): readonly [string, string] => [item.id, item.label]),
  ),
]);

export function adminSectionLabel(id: AdminSectionId): string {
  return SECTION_LABELS[id] ?? id;
}

/** Route-param guard — `/admin/<anything>` has to be narrowed before use. */
export function isAdminSectionId(value: string): value is AdminSectionId {
  return (ADMIN_SECTION_IDS as readonly string[]).includes(value);
}
