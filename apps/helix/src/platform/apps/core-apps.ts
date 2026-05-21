/**
 * Core-app registry — the confirmed Helix architecture model.
 *
 * Core apps (mail, chat, drive, docs, calendar, meet, assistant) are
 * **toggleable modules of the Helix platform** — not plugins, not per-user
 * containers. They ship in a single deployable, are multi-tenant, and scale by
 * horizontal replicas. The plugin SDK / loader is reserved for *external
 * connectors* only (see {@link ../plugins/loader.ts} and the connector model).
 *
 * Two orthogonal switches gate whether a core app's module is registered:
 *
 *  1. **Org-admin enablement** (`config.modules[appId].enabled`, default true):
 *     a disabled app is not registered or served at all — no routes, no tools,
 *     no event subscribers, no indexers, no enrichments. This is global,
 *     org-wide, and persisted through the platform-config admin API.
 *
 *  2. **Role-based boot** (`HELIX_ROLE` / `HELIX_APPS`): the same image can be
 *     booted as a role that runs only a subset of apps, so WS-heavy apps
 *     (chat, meet) can run as their own k8s Deployment of the *same image*.
 *     The default role runs every enabled app.
 *
 * An app is registered iff it is enabled AND in the booting role's app set.
 */

export const CORE_APP_IDS = [
  "mail",
  "chat",
  "drive",
  "docs",
  "calendar",
  "meet",
  "assistant",
] as const;

export type CoreAppId = (typeof CORE_APP_IDS)[number];

export interface CoreAppDefinition {
  readonly id: CoreAppId;
  /** Human-readable name shown in the admin UI. */
  readonly name: string;
  readonly description: string;
}

export const CORE_APPS: readonly CoreAppDefinition[] = [
  { id: "mail", name: "Mail", description: "SMTP send/receive, threading, labels, filters." },
  { id: "chat", name: "Chat", description: "Realtime channels, presence, read receipts." },
  { id: "drive", name: "Drive", description: "File storage, folders, sharing, previews." },
  { id: "docs", name: "Docs", description: "Collaborative documents with Yjs sync." },
  { id: "calendar", name: "Calendar", description: "Events, invitations, free/busy, CalDAV." },
  { id: "meet", name: "Meet", description: "Video meetings via Jitsi." },
  {
    id: "assistant",
    name: "Assistant",
    description: "The Helix conversational AI assistant.",
  },
];

export function isCoreAppId(value: string): value is CoreAppId {
  return (CORE_APP_IDS as readonly string[]).includes(value);
}

/** Module-config shape: only the fields the core-app registry consults. */
export interface ModuleEnablementConfig {
  readonly enabled?: boolean;
}

export interface CoreAppEnablementInput {
  /** `config.modules` from the merged {@link HelixConfig}. */
  readonly modules?: Record<string, ModuleEnablementConfig>;
  /** `HELIX_ROLE` env value — names a role from {@link HELIX_ROLES}. */
  readonly role?: string;
  /** `HELIX_APPS` env value — a comma-separated explicit app subset. */
  readonly apps?: string;
}

/**
 * The status of a single core app for the *currently booting process*.
 */
export interface CoreAppStatus {
  readonly id: CoreAppId;
  readonly name: string;
  readonly description: string;
  /** Org-admin global enablement. Disabled => never served anywhere. */
  readonly enabled: boolean;
  /** True if this app is in the booting role's app set. */
  readonly inRole: boolean;
  /** Registered (routes/tools/workers) iff `enabled && inRole`. */
  readonly registered: boolean;
}

/**
 * Named roles for role-based boot. The `all` role (the default) runs every
 * enabled core app. Additional roles run a curated subset of the *same image*
 * so they can be deployed as their own k8s Deployment + HPA. Keeping the set
 * here (rather than scattered across Helm) means a future per-app image build
 * is a trivial `HELIX_APPS=<single-app>` boot.
 */
export const HELIX_ROLES: Record<string, readonly CoreAppId[]> = {
  /** Default: every core app. */
  all: CORE_APP_IDS,
  /** WebSocket-heavy realtime apps — chat presence + Yjs + Meet signalling. */
  realtime: ["chat", "meet"],
  /** Async/worker-heavy apps — mail SMTP + indexing/enrichment. */
  workers: ["mail"],
  /** Web/API surface without realtime fan-out. */
  web: ["mail", "drive", "docs", "calendar", "assistant"],
};

export const DEFAULT_HELIX_ROLE = "all";

export class CoreAppRoleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CoreAppRoleError";
  }
}

/**
 * Resolve the set of core app ids this process's role is permitted to run.
 * `HELIX_APPS` (explicit list) takes precedence over `HELIX_ROLE` (named role).
 */
export function resolveRoleAppSet(input: Pick<CoreAppEnablementInput, "role" | "apps">): {
  readonly role: string;
  readonly appIds: ReadonlySet<CoreAppId>;
} {
  const explicit = (input.apps ?? "").trim();
  if (explicit.length > 0) {
    const ids = explicit
      .split(",")
      .map((part) => part.trim())
      .filter((part) => part.length > 0);
    const resolved = new Set<CoreAppId>();
    for (const id of ids) {
      if (!isCoreAppId(id)) {
        throw new CoreAppRoleError(
          `HELIX_APPS contains unknown core app "${id}"; valid apps: ${CORE_APP_IDS.join(", ")}`,
        );
      }
      resolved.add(id);
    }
    if (resolved.size === 0) {
      throw new CoreAppRoleError("HELIX_APPS was set but resolved to an empty app set.");
    }
    return { role: "custom", appIds: resolved };
  }

  const roleName = (input.role ?? DEFAULT_HELIX_ROLE).trim() || DEFAULT_HELIX_ROLE;
  const roleApps = HELIX_ROLES[roleName];
  if (roleApps === undefined) {
    throw new CoreAppRoleError(
      `HELIX_ROLE "${roleName}" is not a known role; valid roles: ${Object.keys(HELIX_ROLES).join(
        ", ",
      )}`,
    );
  }
  return { role: roleName, appIds: new Set(roleApps) };
}

/**
 * Compute the registration status of every core app for this process.
 *
 * An app is `enabled` when its module config does not set `enabled: false`
 * (default-on). It is `registered` only when it is both enabled and in the
 * booting role's app set.
 */
export function resolveCoreAppStatuses(input: CoreAppEnablementInput): {
  readonly role: string;
  readonly statuses: readonly CoreAppStatus[];
} {
  const { role, appIds } = resolveRoleAppSet(input);
  const statuses = CORE_APPS.map((app): CoreAppStatus => {
    const enabled = isCoreAppEnabled(input.modules, app.id);
    const inRole = appIds.has(app.id);
    return {
      id: app.id,
      name: app.name,
      description: app.description,
      enabled,
      inRole,
      registered: enabled && inRole,
    };
  });
  return { role, statuses };
}

/** Org-admin global enablement check for a single core app (default-on). */
export function isCoreAppEnabled(
  modules: Record<string, ModuleEnablementConfig> | undefined,
  appId: CoreAppId,
): boolean {
  return modules?.[appId]?.enabled !== false;
}

/**
 * A resolved view of which core-app modules this process should register.
 * Built once at startup and consulted by every conditional `register*Module`
 * call in `server.ts`.
 */
export class CoreAppRegistrationPlan {
  readonly role: string;
  private readonly byId: Map<CoreAppId, CoreAppStatus>;

  constructor(input: CoreAppEnablementInput) {
    const { role, statuses } = resolveCoreAppStatuses(input);
    this.role = role;
    this.byId = new Map(statuses.map((status) => [status.id, status]));
  }

  /** True iff the app's module should be registered in this process. */
  shouldRegister(appId: CoreAppId): boolean {
    return this.byId.get(appId)?.registered ?? false;
  }

  /** Org-admin enablement, independent of role. */
  isEnabled(appId: CoreAppId): boolean {
    return this.byId.get(appId)?.enabled ?? false;
  }

  status(appId: CoreAppId): CoreAppStatus {
    const status = this.byId.get(appId);
    if (status === undefined) {
      throw new Error(`Unknown core app: ${appId}`);
    }
    return status;
  }

  statuses(): readonly CoreAppStatus[] {
    return [...this.byId.values()];
  }

  /** Core app ids actually registered in this process. */
  registeredAppIds(): readonly CoreAppId[] {
    return this.statuses()
      .filter((status) => status.registered)
      .map((status) => status.id);
  }
}
