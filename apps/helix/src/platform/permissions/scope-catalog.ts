/**
 * Canonical Helix OAuth scope catalog (PRD §9.4).
 *
 * This module is the SINGLE source of truth for which scopes exist. Every
 * other view of "the scopes" — the credential-issuance UI catalog, the
 * app-password catalog, the OpenAPI `securitySchemes` scope list, and the
 * enforcement set — must be derived from {@link SCOPE_CATALOG} rather than
 * maintained by hand. Previously the catalog lived as a hand-written array in
 * `auth/tools.ts`, merged ad-hoc with discovered tool permissions, while the
 * OpenAPI scope list was computed separately; the two drifted (PRD §9.4 names
 * no `chat.write`, and the legacy catalog used `tools` where PRD uses
 * `tools:read`/`tools:write`). Defining everything here closes that drift.
 */

/**
 * Surface a scope is primarily issued through.
 *
 * `service` is reserved for service-only scopes (e.g. `mail.system`) that
 * must NEVER appear on agent OAuth credentials or app passwords — only on
 * internal service-account tokens issued out-of-band to platform daemons
 * (SMTP receiver, bridges, etc.). It is intentionally excluded from
 * {@link agentCredentialScopeCatalog} and {@link appPasswordScopeCatalog}.
 */
export type ScopeSurface = "platform" | "agent" | "app_password" | "admin" | "service";

export interface ScopeDefinition {
  /** The scope token, e.g. `mail.send`. */
  readonly scope: string;
  /** Short human-readable description, surfaced in OpenAPI and the credential UI. */
  readonly description: string;
  /**
   * When true the scope is a *composite* scope: it is never sufficient on its
   * own to invoke a tool, but is additionally required by tools whose call
   * input matches a condition (e.g. `mail.external` for external recipients).
   * Composite scopes are still issuable on credentials.
   */
  readonly composite?: boolean;
  /**
   * Legacy/compatibility protocol scopes (CalDAV/CardDAV/WebDAV/IMAP/SMTP)
   * used by app passwords. These are not tool permissions.
   */
  readonly protocolScope?: boolean;
  /** Surfaces this scope may be issued on. */
  readonly surfaces: readonly ScopeSurface[];
}

/**
 * The canonical scope catalog, reconciled with PRD §9.4.
 *
 * Reconciliation notes vs. the previous hand-written catalog:
 *  - `chat.write` (non-PRD) is removed in favour of the PRD scopes
 *    `chat.post` / `chat.create`. Chat tools are remapped onto those.
 *  - `tools` is the canonical projection of the PRD `tools:read` / `tools:write`
 *    pair (both retained).
 *  - composite scopes (`mail.external`, `calendar.external`) are flagged so
 *    enforcement can treat them as never-sufficient-alone. Destructive
 *    operations are already gated by dedicated permissions (`mail.delete`,
 *    `drive.delete`, `assistant.memory`) so no separate `*.destructive`
 *    composite is needed.
 */
export const SCOPE_CATALOG: readonly ScopeDefinition[] = [
  // Platform.
  { scope: "platform.read", description: "Read platform health and metadata.", surfaces: ["platform", "agent"] },
  { scope: "tools:read", description: "List and describe registered tools.", surfaces: ["platform", "agent"] },
  { scope: "tools:write", description: "Invoke registered tools.", surfaces: ["platform", "agent"] },
  { scope: "profile.read", description: "Read the actor profile.", surfaces: ["platform", "agent"] },
  { scope: "profile.write", description: "Update the actor profile.", surfaces: ["platform", "agent"] },

  // Mail.
  { scope: "mail.read", description: "Read the actor's own mail.", surfaces: ["agent", "app_password"] },
  { scope: "mail.read:shared", description: "Read mail shared with the actor.", surfaces: ["agent"] },
  { scope: "mail.send", description: "Send mail to internal recipients.", surfaces: ["agent", "app_password"] },
  { scope: "mail.write", description: "Modify mail (labels, state, filters).", surfaces: ["agent", "app_password"] },
  { scope: "mail.delete", description: "Permanently delete mail.", surfaces: ["agent", "app_password"] },
  {
    scope: "mail.external",
    description: "Send mail to recipients outside the organization's domains.",
    composite: true,
    surfaces: ["agent"],
  },
  {
    // Service-only scope (PRD §9.4 / REVIEW.md CRITICAL-4): authorises the
    // `mail.inbound.accept` bridge tool. Never issued on agent or app-password
    // surfaces — a user-level credential MUST NOT be able to inject inbound
    // mail. The tool additionally gates on `actor.type === "service_account"`
    // so a service token mistakenly granted to a user actor is still rejected.
    scope: "mail.system",
    description: "Service-only: accept inbound mail on behalf of the SMTP/bridge receiver.",
    surfaces: ["service"],
  },

  // Drive.
  { scope: "drive.read", description: "Read the actor's own files.", surfaces: ["agent", "app_password"] },
  { scope: "drive.read:shared", description: "Read files shared with the actor.", surfaces: ["agent"] },
  { scope: "drive.write", description: "Create and modify the actor's files.", surfaces: ["agent", "app_password"] },
  { scope: "drive.write:shared", description: "Modify files shared with the actor.", surfaces: ["agent"] },
  { scope: "drive.delete", description: "Permanently delete files.", surfaces: ["agent", "app_password"] },

  // Chat.
  { scope: "chat.read", description: "Read chat rooms and messages.", surfaces: ["agent"] },
  { scope: "chat.post", description: "Post, edit, and react to chat messages.", surfaces: ["agent"] },
  { scope: "chat.create", description: "Create chat rooms and invite members.", surfaces: ["agent"] },

  // Calendar.
  { scope: "calendar.read", description: "Read calendars and events.", surfaces: ["agent", "app_password"] },
  {
    scope: "calendar.read:freebusy",
    description: "Read free/busy availability.",
    surfaces: ["agent", "app_password"],
  },
  { scope: "calendar.write", description: "Create and modify calendar events.", surfaces: ["agent", "app_password"] },
  {
    scope: "calendar.write:respond",
    description: "Respond to event invitations.",
    surfaces: ["agent", "app_password"],
  },
  {
    scope: "calendar.external",
    description: "Invite or notify attendees outside the organization's domains.",
    composite: true,
    surfaces: ["agent"],
  },

  // Docs.
  { scope: "docs.read", description: "Read documents.", surfaces: ["agent"] },
  { scope: "docs.write", description: "Create and modify documents.", surfaces: ["agent"] },
  { scope: "docs.comment", description: "Comment on documents.", surfaces: ["agent"] },

  // Sheets.
  { scope: "sheets.read", description: "Read spreadsheets, tabs, and cell data.", surfaces: ["agent"] },
  {
    scope: "sheets.write",
    description: "Create and modify spreadsheets, tabs, and cells.",
    surfaces: ["agent"],
  },

  // Slides.
  { scope: "slides.read", description: "Read presentation decks and slides.", surfaces: ["agent"] },
  {
    scope: "slides.write",
    description: "Create and modify presentation decks and slides.",
    surfaces: ["agent"],
  },

  // Meet.
  { scope: "meet.read", description: "Read meeting rooms and join tokens.", surfaces: ["agent"] },
  { scope: "meet.write", description: "Create and end meeting rooms.", surfaces: ["agent"] },

  // Assistant.
  { scope: "assistant.read", description: "Read assistant conversations and history.", surfaces: ["agent"] },
  { scope: "assistant.write", description: "Use the assistant and run conversations.", surfaces: ["agent"] },
  { scope: "assistant.memory", description: "Read and erase assistant memory.", surfaces: ["agent"] },

  // Admin.
  { scope: "admin.users", description: "Administer users.", surfaces: ["admin"] },
  { scope: "admin.config", description: "Administer platform configuration.", surfaces: ["admin"] },
  { scope: "admin.config.read", description: "Read platform configuration.", surfaces: ["admin"] },
  { scope: "admin.config.write", description: "Write platform configuration.", surfaces: ["admin"] },
  { scope: "admin.audit", description: "Read the audit log.", surfaces: ["admin"] },
  { scope: "admin.plugins", description: "Administer plugins.", surfaces: ["admin"] },
  { scope: "admin.webhooks", description: "Administer webhooks.", surfaces: ["admin"] },
  { scope: "admin.agents", description: "Administer agent credentials.", surfaces: ["admin"] },

  // Legacy / protocol scopes for app passwords (DAV, IMAP, SMTP).
  { scope: "caldav", description: "CalDAV protocol access.", protocolScope: true, surfaces: ["app_password"] },
  { scope: "carddav", description: "CardDAV protocol access.", protocolScope: true, surfaces: ["app_password"] },
  {
    scope: "carddav.read",
    description: "CardDAV read-only protocol access.",
    protocolScope: true,
    surfaces: ["app_password"],
  },
  {
    scope: "carddav.write",
    description: "CardDAV read-write protocol access.",
    protocolScope: true,
    surfaces: ["app_password"],
  },
  { scope: "webdav", description: "WebDAV protocol access.", protocolScope: true, surfaces: ["app_password"] },
  { scope: "imap", description: "IMAP protocol access.", protocolScope: true, surfaces: ["app_password"] },
  { scope: "smtp", description: "SMTP protocol access.", protocolScope: true, surfaces: ["app_password"] },
];

const scopesByName = new Map(SCOPE_CATALOG.map((entry) => [entry.scope, entry]));

/** Every scope token in the canonical catalog. */
export const ALL_SCOPES: readonly string[] = SCOPE_CATALOG.map((entry) => entry.scope);

/** True when {@link scope} is a known canonical scope. */
export function isKnownScope(scope: string): boolean {
  return scopesByName.has(scope);
}

/** Look up a scope definition, or `undefined` when unknown. */
export function getScopeDefinition(scope: string): ScopeDefinition | undefined {
  return scopesByName.get(scope);
}

/** True when {@link scope} is a composite scope (never sufficient on its own). */
export function isCompositeScope(scope: string): boolean {
  return scopesByName.get(scope)?.composite === true;
}

/**
 * Scopes issuable on a given surface. Used to derive the agent-credential UI
 * catalog and the app-password catalog from this single source.
 */
export function scopesForSurface(surface: ScopeSurface): readonly string[] {
  return SCOPE_CATALOG.filter((entry) => entry.surfaces.includes(surface)).map((entry) => entry.scope);
}

/**
 * The credential-issuance scope catalog for agent OAuth clients. Replaces the
 * hand-written `agentCredentialScopeCatalog` array.
 */
export const agentCredentialScopeCatalog: readonly string[] = [
  ...scopesForSurface("platform"),
  ...scopesForSurface("agent"),
  ...scopesForSurface("admin"),
].filter((scope, index, all) => all.indexOf(scope) === index);

/** The scope catalog for legacy app passwords (DAV/IMAP/SMTP + tool scopes). */
export const appPasswordScopeCatalog: readonly string[] = scopesForSurface("app_password");

/**
 * Build the OpenAPI `securitySchemes` scope map. Tool permissions are unioned
 * in so that any tool whose `permission` is (transitionally) not yet in the
 * canonical catalog is still documented, but the canonical descriptions win.
 */
export function openApiScopeCatalog(toolPermissions: readonly string[]): Record<string, string> {
  const entries = new Map<string, string>();
  for (const definition of SCOPE_CATALOG) {
    entries.set(definition.scope, definition.description);
  }
  for (const permission of toolPermissions) {
    if (!entries.has(permission)) {
      entries.set(permission, `Allows ${permission} tool operations.`);
    }
  }
  return Object.fromEntries(
    [...entries.entries()].sort(([left], [right]) => left.localeCompare(right)),
  );
}
