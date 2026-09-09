import { randomUUID } from "node:crypto";
import { z } from "zod";
import type postgres from "postgres";
import type {
  EventBus,
  JsonObject,
  JsonValue,
  PluginManifest,
  ToolDefinition,
} from "@helix/sdk-types";
import { isCanonicalPluginId } from "@helix/sdk-types";
import { assertPluginManifest } from "@helix/sdk";
import type { RuntimeToolRegistry } from "../tool-registry.js";
import { zodToolSchema } from "../webhooks/tool-schemas.js";
import {
  calculatePluginBundleDigest,
  discoverPluginById,
  discoverPluginsDirectory,
  type DiscoveredPlugin,
  type PluginDiscoveryOptions,
} from "./loader.js";
import {
  catalogArtifact,
  verifyPluginArtifactSignature,
  verifyPluginCatalog,
  type PluginCatalogPayload,
  type PluginTrustOptions,
} from "./trust.js";

const listSchema = z.object({
  includeConfirmations: z.boolean().default(true),
});

const canonicalPluginIdSchema = z.string().refine(isCanonicalPluginId, "Invalid plugin id");

const installSchema = z.object({
  pluginId: canonicalPluginIdSchema,
  version: z.string().min(1).optional(),
  confirmations: z.array(z.string().min(1)).default([]),
});

const pluginIdSchema = z.object({
  pluginId: canonicalPluginIdSchema,
});

const uninstallSchema = pluginIdSchema.extend({
  confirmations: z.array(z.string().min(1)).default([]),
});

const genericObjectJsonSchema = {
  type: "object",
  additionalProperties: true,
} as const;

export interface RegisterPluginToolsOptions {
  readonly pluginsDir: string;
  readonly discovery?: PluginDiscoveryOptions;
  readonly lifecycle?: PluginLifecycle;
}

export interface PluginLifecycleRecord {
  readonly pluginId: string;
  readonly version: string;
  readonly state: PersistedPluginLifecycleState;
  readonly source: PluginLifecycleSource;
  readonly manifest: PluginManifest;
  readonly updatedAt: string;
}

export interface PluginLifecycleStore {
  get(pluginId: string): Promise<PluginLifecycleRecord | undefined>;
  list(): Promise<readonly PluginLifecycleRecord[]>;
  set(record: PluginLifecycleRecord): Promise<void>;
}

export type PluginLifecycleSource = "official" | "sideload";
export type PersistedPluginLifecycleState =
  "installed" | "enabled" | "disabled" | "degraded" | "uninstalled";
type PersistedPluginManifest = PluginManifest & {
  readonly helixLifecycleSource?: PluginLifecycleSource | undefined;
};

interface ConfirmationRequirement {
  readonly id: string;
  readonly label: string;
  readonly category:
    | "source"
    | "scope"
    | "outbound-network"
    | "filesystem"
    | "envVar"
    | "capability"
    | "signature"
    | "tier";
  readonly detail: string;
}

export function createPluginToolDefinitions(
  options: RegisterPluginToolsOptions,
): readonly ToolDefinition[] {
  const lifecycle =
    options.lifecycle ??
    new PluginLifecycle({
      store: new InMemoryPluginLifecycleStore(),
      pluginsDir: options.pluginsDir,
      ...(options.discovery === undefined ? {} : { discovery: options.discovery }),
    });

  return [
    defineTool<z.output<typeof listSchema>, unknown>({
      id: "plugin.list",
      description:
        "List installable Helix plugins with manifest permissions and install confirmation requirements.",
      permission: "admin.plugins",
      sideEffects: "read",
      inputSchema: zodToolSchema(listSchema, genericObjectJsonSchema),
      outputSchema: zodToolSchema(z.unknown(), genericObjectJsonSchema),
      handler: async (input) => {
        const trustedCatalog = verifyPluginCatalog(options.discovery?.pluginTrust);
        const plugins: Array<{
          readonly plugin: DiscoveredPlugin;
          readonly source: PluginLifecycleSource;
        }> = [];
        for (const plugin of await discoverInstallablePlugins(options)) {
          try {
            plugins.push({
              plugin,
              source: await resolvePluginSource(
                plugin,
                trustedCatalog,
                options.discovery?.pluginTrust,
              ),
            });
          } catch (error) {
            options.discovery?.onError?.(plugin.manifest.id, error);
          }
        }
        const lifecycleRecords = new Map(
          await Promise.all(
            plugins.map(
              async ({ plugin }) =>
                [plugin.manifest.id, await lifecycle.get(plugin.manifest.id)] as const,
            ),
          ),
        );
        return {
          plugins: plugins.map(({ plugin, source }) => {
            const lifecycle = lifecycleRecords.get(plugin.manifest.id);
            return {
              ...serializePlugin(plugin),
              lifecycle:
                lifecycle === undefined
                  ? {
                      state: plugin.state,
                      installed: false,
                    }
                  : serializeLifecycleRecord(lifecycle),
              install: input.includeConfirmations
                ? serializeInstallRequirements(plugin.manifest, source)
                : { confirmationRequired: source !== "official" },
            };
          }),
        };
      },
    }),
    defineTool<z.output<typeof installSchema>, unknown>({
      id: "plugin.install",
      description:
        "Validate a plugin install request and require explicit confirmation for non-official sources.",
      permission: "admin.plugins",
      sideEffects: "write",
      confirmationRequired: true,
      inputSchema: zodToolSchema(installSchema, genericObjectJsonSchema),
      outputSchema: zodToolSchema(z.unknown(), genericObjectJsonSchema),
      handler: async (input, ctx) => {
        const plugin = await discoverInstallablePlugin(options, input.pluginId);
        if (plugin === undefined) {
          return {
            status: "not_found",
            pluginId: input.pluginId,
            message: `Unknown installable plugin: ${input.pluginId}`,
          };
        }
        if (input.version !== undefined && plugin.manifest.version !== input.version) {
          return {
            status: "version_mismatch",
            plugin: serializePlugin(plugin),
            requestedVersion: input.version,
            availableVersion: plugin.manifest.version,
          };
        }

        const source = await resolvePluginSource(
          plugin,
          verifyPluginCatalog(options.discovery?.pluginTrust),
          options.discovery?.pluginTrust,
        );
        const requirements = confirmationRequirements(plugin.manifest, source);
        const confirmedIds = new Set(input.confirmations);
        const missing = requirements.filter((requirement) => !confirmedIds.has(requirement.id));
        if (missing.length > 0) {
          return {
            status: "blocked_confirmation_required",
            plugin: serializePlugin(plugin),
            source,
            confirmations: missing,
          };
        }

        await ctx.audit("plugin.install.validated", {
          pluginId: plugin.manifest.id,
          version: plugin.manifest.version,
          source,
        });
        const existing = await lifecycle.get(plugin.manifest.id);
        const record = await lifecycle.transition(
          plugin,
          existing?.state === "enabled" ? "enabled" : "installed",
          source,
        );

        return {
          status:
            existing !== undefined && existing.version !== plugin.manifest.version
              ? "upgraded"
              : "installed",
          plugin: serializePlugin(plugin),
          lifecycle: serializeLifecycleRecord(record),
          source,
          confirmations: requirements,
        };
      },
    }),
    defineTool<z.output<typeof pluginIdSchema>, unknown>({
      id: "plugin.enable",
      description: "Enable a previously installed Helix plugin.",
      permission: "admin.plugins",
      sideEffects: "write",
      inputSchema: zodToolSchema(pluginIdSchema, genericObjectJsonSchema),
      outputSchema: zodToolSchema(z.unknown(), genericObjectJsonSchema),
      handler: async (input, ctx) => {
        const plugin = await discoverInstallablePlugin(options, input.pluginId);
        if (plugin === undefined) {
          return notFound(input.pluginId);
        }
        const existing = await lifecycle.get(plugin.manifest.id);
        if (existing === undefined || existing.state === "uninstalled") {
          return notInstalled(plugin);
        }

        const record = await lifecycle.transition(plugin, "enabled", existing.source);
        await ctx.audit("plugin.enable.validated", {
          pluginId: plugin.manifest.id,
          version: plugin.manifest.version,
        });

        return {
          status: "enabled",
          plugin: serializePlugin(plugin),
          lifecycle: serializeLifecycleRecord(record),
        };
      },
    }),
    defineTool<z.output<typeof pluginIdSchema>, unknown>({
      id: "plugin.disable",
      description: "Disable a Helix plugin without uninstalling it.",
      permission: "admin.plugins",
      sideEffects: "write",
      inputSchema: zodToolSchema(pluginIdSchema, genericObjectJsonSchema),
      outputSchema: zodToolSchema(z.unknown(), genericObjectJsonSchema),
      handler: async (input, ctx) => {
        const plugin = await discoverInstallablePlugin(options, input.pluginId);
        if (plugin === undefined) {
          return notFound(input.pluginId);
        }
        const existing = await lifecycle.get(plugin.manifest.id);
        if (existing === undefined || existing.state === "uninstalled") {
          return notInstalled(plugin);
        }

        const record = await lifecycle.transition(plugin, "disabled", existing.source);
        await ctx.audit("plugin.disable.validated", {
          pluginId: plugin.manifest.id,
          version: plugin.manifest.version,
        });

        return {
          status: "disabled",
          plugin: serializePlugin(plugin),
          lifecycle: serializeLifecycleRecord(record),
        };
      },
    }),
    defineTool<z.output<typeof uninstallSchema>, unknown>({
      id: "plugin.uninstall",
      description: "Uninstall a Helix plugin after explicit admin confirmation.",
      permission: "admin.plugins",
      sideEffects: "write",
      confirmationRequired: true,
      inputSchema: zodToolSchema(uninstallSchema, genericObjectJsonSchema),
      outputSchema: zodToolSchema(z.unknown(), genericObjectJsonSchema),
      handler: async (input, ctx) => {
        const plugin = await discoverInstallablePlugin(options, input.pluginId);
        if (plugin === undefined) {
          return notFound(input.pluginId);
        }
        const existing = await lifecycle.get(plugin.manifest.id);
        if (existing === undefined || existing.state === "uninstalled") {
          return notInstalled(plugin);
        }

        const requirements = uninstallConfirmationRequirements(plugin.manifest);
        const confirmedIds = new Set(input.confirmations);
        const missing = requirements.filter((requirement) => !confirmedIds.has(requirement.id));
        if (missing.length > 0) {
          return {
            status: "blocked_confirmation_required",
            plugin: serializePlugin(plugin),
            confirmations: missing,
          };
        }

        const record = await lifecycle.transition(plugin, "uninstalled", existing.source);
        await ctx.audit("plugin.uninstall.validated", {
          pluginId: plugin.manifest.id,
          version: plugin.manifest.version,
        });

        return {
          status: "uninstalled",
          plugin: serializePlugin(plugin),
          lifecycle: serializeLifecycleRecord(record),
          confirmations: requirements,
        };
      },
    }),
  ];
}

export function registerPluginTools(
  registry: RuntimeToolRegistry,
  options: RegisterPluginToolsOptions,
): void {
  for (const tool of createPluginToolDefinitions(options)) {
    registry.register(tool);
  }
}

function defineTool<Input, Output>(
  tool: ToolDefinition<Input, Output>,
): ToolDefinition<Input, Output> {
  return tool;
}

export class InMemoryPluginLifecycleStore implements PluginLifecycleStore {
  private readonly records = new Map<string, PluginLifecycleRecord>();

  async get(pluginId: string): Promise<PluginLifecycleRecord | undefined> {
    return this.records.get(pluginId);
  }

  async list(): Promise<readonly PluginLifecycleRecord[]> {
    return [...this.records.values()];
  }

  async set(record: PluginLifecycleRecord): Promise<void> {
    this.records.set(record.pluginId, record);
  }
}

export class PostgresPluginLifecycleStore implements PluginLifecycleStore {
  constructor(private readonly sql: postgres.Sql) {}

  async get(pluginId: string): Promise<PluginLifecycleRecord | undefined> {
    const rows = await this.sql<
      Array<{
        readonly id: string;
        readonly version: string;
        readonly state: string;
        readonly manifest: unknown;
        readonly updated_at: Date | string;
      }>
    >`
      select id, version, state, manifest, updated_at
      from installed_plugins
      where id = ${pluginId}
      limit 1
    `;
    const row = rows[0];
    if (row === undefined) {
      return undefined;
    }
    return lifecycleRecordFromRow(row);
  }

  async list(): Promise<readonly PluginLifecycleRecord[]> {
    const rows = await this.sql<
      Array<{
        readonly id: string;
        readonly version: string;
        readonly state: string;
        readonly manifest: unknown;
        readonly updated_at: Date | string;
      }>
    >`
      select id, version, state, manifest, updated_at
      from installed_plugins
      order by id
    `;
    return rows.map(lifecycleRecordFromRow);
  }

  async set(record: PluginLifecycleRecord): Promise<void> {
    const persistedManifest: PersistedPluginManifest = {
      ...record.manifest,
      helixLifecycleSource: record.source,
    };
    await this.sql`
      insert into installed_plugins (id, version, enabled, manifest, state, updated_at)
      values (
        ${record.pluginId},
        ${record.version},
        ${record.state === "enabled"},
        ${JSON.stringify(persistedManifest)}::jsonb,
        ${record.state},
        ${record.updatedAt}
      )
      on conflict (id) do update
      set version = excluded.version,
          enabled = excluded.enabled,
          manifest = excluded.manifest,
          state = excluded.state,
          updated_at = excluded.updated_at
    `;
  }
}

export interface PluginRuntimeLifecycle {
  prepare(plugin: DiscoveredPlugin): Promise<
    | {
        commit(): void;
        rollback(): void;
      }
    | undefined
  >;
  disable(pluginId: string): void;
}

export interface PluginLifecycleOptions {
  readonly store: PluginLifecycleStore;
  readonly pluginsDir: string;
  readonly discovery?: PluginDiscoveryOptions;
  readonly runtime?: PluginRuntimeLifecycle;
  readonly events?: EventBus;
  readonly onError?: (error: unknown, pluginId: string) => void;
}

const pluginLifecycleSubject = "plugin.lifecycle.changed";

export class PluginLifecycle {
  readonly #instanceId = randomUUID();
  readonly #options: PluginLifecycleOptions;
  #queue = Promise.resolve();
  #unsubscribe: (() => Promise<void> | void) | undefined;

  constructor(options: PluginLifecycleOptions) {
    this.#options = options;
  }

  get(pluginId: string): Promise<PluginLifecycleRecord | undefined> {
    return this.#options.store.get(pluginId);
  }

  async start(): Promise<void> {
    if (this.#unsubscribe !== undefined || this.#options.events === undefined) {
      await this.#reconcileAll();
      return;
    }
    this.#unsubscribe = await this.#options.events.subscribe(
      pluginLifecycleSubject,
      async (event) => {
        if (!isRecord(event.payload) || event.payload.origin === this.#instanceId) return;
        const pluginId = event.payload.pluginId;
        if (typeof pluginId === "string" && isCanonicalPluginId(pluginId)) {
          await this.#enqueue(() => this.#reconcile(pluginId));
        }
      },
    );
    await this.#reconcileAll();
  }

  async close(): Promise<void> {
    await this.#unsubscribe?.();
    this.#unsubscribe = undefined;
  }

  async transition(
    plugin: DiscoveredPlugin,
    state: PersistedPluginLifecycleState,
    source: PluginLifecycleSource,
  ): Promise<PluginLifecycleRecord> {
    const record = await this.#enqueue(async () => {
      const next = lifecycleRecord(plugin.manifest, state, source);
      const prepared =
        state === "enabled" ? await this.#options.runtime?.prepare(plugin) : undefined;
      try {
        await this.#options.store.set(next);
        prepared?.commit();
        if (state !== "enabled") this.#options.runtime?.disable(plugin.manifest.id);
        return next;
      } catch (error) {
        prepared?.rollback();
        throw error;
      }
    });
    await this.#options.events?.publish(pluginLifecycleSubject, {
      origin: this.#instanceId,
      pluginId: record.pluginId,
      updatedAt: record.updatedAt,
    });
    return record;
  }

  async #reconcileAll(): Promise<void> {
    for (const record of await this.#options.store.list()) {
      await this.#enqueue(() => this.#reconcile(record.pluginId));
    }
  }

  async #reconcile(pluginId: string): Promise<void> {
    const record = await this.#options.store.get(pluginId);
    if (record?.state !== "enabled") {
      this.#options.runtime?.disable(pluginId);
      return;
    }
    try {
      const plugin = await discoverPluginById(
        this.#options.pluginsDir,
        pluginId,
        this.#options.discovery,
      );
      if (plugin.manifest.version !== record.version) {
        throw new Error(
          `Enabled plugin ${pluginId} requires ${record.version}, found ${plugin.manifest.version}.`,
        );
      }
      const prepared = await this.#options.runtime?.prepare(plugin);
      try {
        prepared?.commit();
      } catch (error) {
        prepared?.rollback();
        throw error;
      }
    } catch (error) {
      this.#options.runtime?.disable(pluginId);
      await this.#options.store.set({
        ...record,
        state: "degraded",
        updatedAt: new Date().toISOString(),
      });
      await this.#options.events?.publish(pluginLifecycleSubject, {
        origin: this.#instanceId,
        pluginId,
      });
      this.#options.onError?.(error, pluginId);
    }
  }

  #enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#queue.then(operation, operation);
    this.#queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

async function discoverInstallablePlugins(
  options: RegisterPluginToolsOptions,
): Promise<readonly DiscoveredPlugin[]> {
  return discoverPluginsDirectory(options.pluginsDir, options.discovery).catch((error: unknown) => {
    if (isFileNotFound(error)) {
      return [];
    }
    throw error;
  });
}

async function discoverInstallablePlugin(
  options: RegisterPluginToolsOptions,
  pluginId: string,
): Promise<DiscoveredPlugin | undefined> {
  return discoverPluginById(options.pluginsDir, pluginId, options.discovery).catch(
    (error: unknown) => {
      if (isFileNotFound(error)) {
        return undefined;
      }
      throw error;
    },
  );
}

async function resolvePluginSource(
  plugin: DiscoveredPlugin,
  catalog: PluginCatalogPayload | undefined,
  trust: PluginTrustOptions | undefined,
): Promise<PluginLifecycleSource> {
  const artifact = catalogArtifact(catalog, plugin.manifest.id, plugin.manifest.version);
  if (artifact === undefined) {
    return "sideload";
  }
  if (trust === undefined) {
    throw new Error(`Plugin ${plugin.manifest.id} is catalogued without publisher trust.`);
  }
  const actual = await calculatePluginBundleDigest(plugin);
  await verifyPluginArtifactSignature(artifact, actual, trust);
  return "official";
}

function serializeInstallRequirements(
  manifest: PluginManifest,
  source: PluginLifecycleSource,
): JsonObject {
  const confirmations = confirmationRequirements(manifest, source);
  return {
    confirmationRequired: confirmations.length > 0,
    confirmations: confirmations.map((confirmation) => ({ ...confirmation })),
  };
}

function uninstallConfirmationRequirements(
  manifest: PluginManifest,
): readonly ConfirmationRequirement[] {
  return [
    {
      id: "plugin.uninstall",
      label: "Uninstall plugin",
      category: "capability",
      detail: `Uninstall ${manifest.id} and remove its active runtime hooks.`,
    },
  ];
}

function confirmationRequirements(
  manifest: PluginManifest,
  source: PluginLifecycleSource,
): readonly ConfirmationRequirement[] {
  if (source === "official") {
    return [];
  }

  const requirements: ConfirmationRequirement[] = [
    {
      id: "source.non_official",
      label: "Install from a non-official source",
      category: "source",
      detail: `No signed catalog entry authenticates ${manifest.id}; it is treated as ${source}.`,
    },
  ];
  appendArrayConfirmations(
    requirements,
    "scope",
    "permissions.scopes",
    manifest.permissions.scopes,
  );
  appendArrayConfirmations(
    requirements,
    "outbound-network",
    "permissions.outbound-network",
    manifest.permissions["outbound-network"],
  );
  appendArrayConfirmations(
    requirements,
    "filesystem",
    "permissions.filesystem",
    manifest.permissions.filesystem,
  );
  appendArrayConfirmations(
    requirements,
    "envVar",
    "permissions.envVars",
    manifest.permissions.envVars,
  );
  appendArrayConfirmations(
    requirements,
    "capability",
    "capabilities.provides",
    manifest.capabilities.provides,
  );
  appendArrayConfirmations(
    requirements,
    "capability",
    "capabilities.consumes",
    manifest.capabilities.consumes,
  );
  requirements.push({
    id: "artifact.untrusted",
    label: "Untrusted plugin artifact",
    category: "signature",
    detail: "No valid signed catalog entry authenticates this exact plugin artifact.",
  });
  if (manifest.tierRequirements !== undefined) {
    requirements.push({
      id: "tier.requirements",
      label: "Tier requirements declared",
      category: "tier",
      detail: "Review tier requirements before installing this plugin.",
    });
  }
  return requirements;
}

function lifecycleRecord(
  manifest: PluginManifest,
  state: PersistedPluginLifecycleState,
  source: PluginLifecycleSource,
): PluginLifecycleRecord {
  return {
    pluginId: manifest.id,
    version: manifest.version,
    state,
    source,
    manifest,
    updatedAt: new Date().toISOString(),
  };
}

function serializeLifecycleRecord(record: PluginLifecycleRecord): JsonObject {
  return {
    pluginId: record.pluginId,
    version: record.version,
    state: record.state,
    source: record.source,
    installed: record.state !== "uninstalled",
    updatedAt: record.updatedAt,
  };
}

function notFound(pluginId: string): JsonObject {
  return {
    status: "not_found",
    pluginId,
    message: `Unknown installable plugin: ${pluginId}`,
  };
}

function notInstalled(plugin: DiscoveredPlugin): JsonObject {
  return {
    status: "not_installed",
    plugin: serializePlugin(plugin),
    message: `Plugin ${plugin.manifest.id} is not installed.`,
  };
}

function appendArrayConfirmations(
  requirements: ConfirmationRequirement[],
  category: ConfirmationRequirement["category"],
  field: string,
  values: readonly string[],
): void {
  for (const value of values) {
    requirements.push({
      id: `${field}.${value}`,
      label: `Allow ${field}`,
      category,
      detail: value,
    });
  }
}

function serializePlugin(plugin: DiscoveredPlugin): JsonObject {
  return {
    id: plugin.manifest.id,
    name: plugin.manifest.name,
    version: plugin.manifest.version,
    description: plugin.manifest.description ?? null,
    kind: plugin.manifest.kind,
    state: plugin.state,
    manifestPath: plugin.manifestPath,
    capabilities: {
      provides: [...plugin.manifest.capabilities.provides],
      consumes: [...plugin.manifest.capabilities.consumes],
    },
    permissions: {
      scopes: [...plugin.manifest.permissions.scopes],
      "outbound-network": [...plugin.manifest.permissions["outbound-network"]],
      filesystem: [...plugin.manifest.permissions.filesystem],
      envVars: [...plugin.manifest.permissions.envVars],
    },
    tierRequirements: toJsonValue(plugin.manifest.tierRequirements ?? null),
  };
}

function toJsonValue(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

function persistedManifestFromUnknown(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    return persistedManifestFromUnknown(JSON.parse(value) as unknown);
  }
  if (!isRecord(value)) {
    throw new Error("Installed plugin manifest must be a JSON object.");
  }
  return value;
}

function lifecycleRecordFromRow(row: {
  readonly id: string;
  readonly version: string;
  readonly state: string;
  readonly manifest: unknown;
  readonly updated_at: Date | string;
}): PluginLifecycleRecord {
  const persistedManifest = persistedManifestFromUnknown(row.manifest);
  return {
    pluginId: row.id,
    version: row.version,
    state: lifecycleStateFromUnknown(row.state),
    source: lifecycleSourceFromUnknown(persistedManifest.helixLifecycleSource),
    manifest: assertPluginManifest(persistedManifest),
    updatedAt: timestampToIso(row.updated_at),
  };
}

function lifecycleStateFromUnknown(value: unknown): PersistedPluginLifecycleState {
  return typeof value === "string" &&
    pluginLifecycleStates.includes(value as PersistedPluginLifecycleState)
    ? (value as PersistedPluginLifecycleState)
    : "degraded";
}

function lifecycleSourceFromUnknown(value: unknown): PluginLifecycleSource {
  return value === "official" ? "official" : "sideload";
}

function timestampToIso(value: Date | string): string {
  const date = typeof value === "string" ? new Date(value) : value;
  return Number.isFinite(date.valueOf()) ? date.toISOString() : new Date(0).toISOString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const pluginLifecycleStates: readonly PersistedPluginLifecycleState[] = [
  "installed",
  "enabled",
  "disabled",
  "degraded",
  "uninstalled",
];

function isFileNotFound(error: unknown): boolean {
  return (
    error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}
