import { join } from "node:path";
import { z } from "zod";
import type postgres from "postgres";
import type {
  JsonObject,
  JsonValue,
  PluginLifecycleState,
  PluginManifest,
  ToolDefinition,
} from "@helix/sdk-types";
import { assertPluginManifest } from "@helix/sdk";
import type { RuntimeToolRegistry } from "../tool-registry.js";
import { zodToolSchema } from "../webhooks/tool-schemas.js";
import {
  discoverPlugin,
  discoverPluginsDirectory,
  type DiscoveredPlugin,
  type PluginDiscoveryOptions,
} from "./loader.js";

const listSchema = z.object({
  includeConfirmations: z.boolean().default(true),
});

const installSchema = z.object({
  pluginId: z.string().min(1),
  version: z.string().min(1).optional(),
  source: z.enum(["official", "sideload", "self-hosted"]).default("official"),
  confirmations: z.array(z.string().min(1)).default([]),
});

const pluginIdSchema = z.object({
  pluginId: z.string().min(1),
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
  readonly officialPluginIds?: readonly string[];
  readonly lifecycleStore?: PluginLifecycleStore;
}

export interface PluginLifecycleRecord {
  readonly pluginId: string;
  readonly version: string;
  readonly state: PluginLifecycleState;
  readonly source: z.output<typeof installSchema>["source"];
  readonly manifest: PluginManifest;
  readonly updatedAt: string;
}

export interface PluginLifecycleStore {
  get(pluginId: string): Promise<PluginLifecycleRecord | undefined>;
  set(record: PluginLifecycleRecord): Promise<void>;
}

type PluginLifecycleSource = z.output<typeof installSchema>["source"];
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
  const lifecycleStore = options.lifecycleStore ?? new InMemoryPluginLifecycleStore();

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
        const plugins = await discoverInstallablePlugins(options);
        const lifecycleRecords = new Map(
          await Promise.all(
            plugins.map(
              async (plugin) =>
                [plugin.manifest.id, await lifecycleStore.get(plugin.manifest.id)] as const,
            ),
          ),
        );
        return {
          plugins: plugins.map((plugin) => {
            const source = resolvePluginSource(plugin.manifest.id, options);
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

        const requirements = confirmationRequirements(plugin.manifest, input.source);
        const confirmedIds = new Set(input.confirmations);
        const missing = requirements.filter((requirement) => !confirmedIds.has(requirement.id));
        if (missing.length > 0) {
          return {
            status: "blocked_confirmation_required",
            plugin: serializePlugin(plugin),
            source: input.source,
            confirmations: missing,
          };
        }

        await ctx.audit("plugin.install.validated", {
          pluginId: plugin.manifest.id,
          version: plugin.manifest.version,
          source: input.source,
        });
        const lifecycle = lifecycleRecord(plugin.manifest, "installed", input.source);
        await lifecycleStore.set(lifecycle);

        return {
          status: "installed",
          plugin: serializePlugin(plugin),
          lifecycle: serializeLifecycleRecord(lifecycle),
          source: input.source,
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
        const existing = await lifecycleStore.get(plugin.manifest.id);
        if (existing === undefined || existing.state === "uninstalled") {
          return notInstalled(plugin);
        }

        const lifecycle = lifecycleRecord(plugin.manifest, "enabled", existing.source);
        await lifecycleStore.set(lifecycle);
        await ctx.audit("plugin.enable.validated", {
          pluginId: plugin.manifest.id,
          version: plugin.manifest.version,
        });

        return {
          status: "enabled",
          plugin: serializePlugin(plugin),
          lifecycle: serializeLifecycleRecord(lifecycle),
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
        const existing = await lifecycleStore.get(plugin.manifest.id);
        if (existing === undefined || existing.state === "uninstalled") {
          return notInstalled(plugin);
        }

        const lifecycle = lifecycleRecord(plugin.manifest, "disabled", existing.source);
        await lifecycleStore.set(lifecycle);
        await ctx.audit("plugin.disable.validated", {
          pluginId: plugin.manifest.id,
          version: plugin.manifest.version,
        });

        return {
          status: "disabled",
          plugin: serializePlugin(plugin),
          lifecycle: serializeLifecycleRecord(lifecycle),
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
        const existing = await lifecycleStore.get(plugin.manifest.id);
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

        const lifecycle = lifecycleRecord(plugin.manifest, "uninstalled", existing.source);
        await lifecycleStore.set(lifecycle);
        await ctx.audit("plugin.uninstall.validated", {
          pluginId: plugin.manifest.id,
          version: plugin.manifest.version,
        });

        return {
          status: "uninstalled",
          plugin: serializePlugin(plugin),
          lifecycle: serializeLifecycleRecord(lifecycle),
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
    const persistedManifest = persistedManifestFromUnknown(row.manifest);
    const manifest = assertPluginManifest(persistedManifest);
    return {
      pluginId: row.id,
      version: row.version,
      state: lifecycleStateFromUnknown(row.state),
      source: lifecycleSourceFromUnknown(persistedManifest.helixLifecycleSource),
      manifest,
      updatedAt: timestampToIso(row.updated_at),
    };
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
  return discoverPlugin(join(options.pluginsDir, pluginId), options.discovery).catch(
    (error: unknown) => {
      if (isFileNotFound(error)) {
        return undefined;
      }
      throw error;
    },
  );
}

function resolvePluginSource(
  pluginId: string,
  options: RegisterPluginToolsOptions,
): z.output<typeof installSchema>["source"] {
  if (options.officialPluginIds === undefined) {
    return "official";
  }
  return options.officialPluginIds.includes(pluginId) ? "official" : "sideload";
}

function serializeInstallRequirements(
  manifest: PluginManifest,
  source: z.output<typeof installSchema>["source"],
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
  source: z.output<typeof installSchema>["source"],
): readonly ConfirmationRequirement[] {
  if (source === "official") {
    return [];
  }

  const requirements: ConfirmationRequirement[] = [
    {
      id: "source.non_official",
      label: "Install from a non-official source",
      category: "source",
      detail: `Plugin ${manifest.id} is declared as ${source}.`,
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
  if (manifest.signature === undefined) {
    requirements.push({
      id: "signature.missing",
      label: "Unsigned plugin artifact",
      category: "signature",
      detail: "The manifest does not include signed artifact evidence.",
    });
  }
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
  state: PluginLifecycleState,
  source: z.output<typeof installSchema>["source"],
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
    signature: toJsonValue(plugin.manifest.signature ?? null),
    tierRequirements: toJsonValue(plugin.manifest.tierRequirements ?? null),
  };
}

function toJsonValue(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

function persistedManifestFromUnknown(value: unknown): PersistedPluginManifest {
  if (typeof value === "string") {
    return persistedManifestFromUnknown(JSON.parse(value) as unknown);
  }
  if (!isRecord(value)) {
    throw new Error("Installed plugin manifest must be a JSON object.");
  }
  return value as unknown as PersistedPluginManifest;
}

function lifecycleStateFromUnknown(value: unknown): PluginLifecycleState {
  return typeof value === "string" && pluginLifecycleStates.includes(value as PluginLifecycleState)
    ? (value as PluginLifecycleState)
    : "degraded";
}

function lifecycleSourceFromUnknown(value: unknown): PluginLifecycleSource {
  return value === "official" || value === "sideload" || value === "self-hosted"
    ? value
    : "official";
}

function timestampToIso(value: Date | string): string {
  const date = typeof value === "string" ? new Date(value) : value;
  return Number.isFinite(date.valueOf()) ? date.toISOString() : new Date(0).toISOString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const pluginLifecycleStates: readonly PluginLifecycleState[] = [
  "discovered",
  "validated",
  "installed",
  "migrating",
  "migrated",
  "starting",
  "enabled",
  "disabled",
  "degraded",
  "uninstalling",
  "uninstalled",
];

function isFileNotFound(error: unknown): boolean {
  return (
    error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}
