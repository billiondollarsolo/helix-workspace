import { sql } from "drizzle-orm";
import type { DrizzleClient, PluginLifecycleState, PluginMigration } from "@helix/sdk";
import type { LoadedPlugin } from "./loader.js";

export interface AppliedPluginMigration {
  readonly pluginId: string;
  readonly namespace: string;
  readonly migrationId: string;
  readonly appliedAt: Date;
}

export interface PluginMigrationStore {
  listApplied(pluginId: string): Promise<readonly AppliedPluginMigration[]>;
  markApplied(migration: AppliedPluginMigration): Promise<void>;
}

export interface PluginLifecycleStateStore {
  markPluginState(
    plugin: LoadedPlugin,
    state: PluginLifecycleState,
    options?: { readonly migrationsApplied?: readonly string[] },
  ): Promise<void>;
}

export interface PluginMigrationRunnerOptions {
  readonly db: DrizzleClient;
  readonly store?: PluginMigrationStore;
  readonly lifecycleStore?: PluginLifecycleStateStore;
  readonly namespacePrefix?: string;
}

export interface PluginMigrationRunResult {
  readonly pluginId: string;
  readonly applied: readonly string[];
  readonly skipped: readonly string[];
}

export class InMemoryPluginMigrationStore implements PluginMigrationStore {
  private readonly applied = new Map<string, AppliedPluginMigration>();

  async listApplied(pluginId: string): Promise<readonly AppliedPluginMigration[]> {
    return [...this.applied.values()].filter((migration) => migration.pluginId === pluginId);
  }

  async markApplied(migration: AppliedPluginMigration): Promise<void> {
    this.applied.set(`${migration.pluginId}:${migration.migrationId}`, migration);
  }
}

export class PluginMigrationRunner {
  private readonly store: PluginMigrationStore;
  private readonly lifecycleStore: PluginLifecycleStateStore | undefined;
  private readonly namespacePrefix: string;

  constructor(private readonly options: PluginMigrationRunnerOptions) {
    this.store = options.store ?? new InMemoryPluginMigrationStore();
    this.lifecycleStore =
      options.lifecycleStore ?? (isPluginLifecycleStateStore(this.store) ? this.store : undefined);
    this.namespacePrefix = options.namespacePrefix ?? "plugin";
  }

  async run(plugin: LoadedPlugin): Promise<PluginMigrationRunResult> {
    const migrations = plugin.module.migrations ?? [];
    const namespace = pluginMigrationNamespace(this.namespacePrefix, plugin.manifest.id);
    const applied = new Set(
      (await this.store.listApplied(plugin.manifest.id)).map((migration) => migration.migrationId),
    );
    const appliedIds: string[] = [];
    const skippedIds: string[] = [];

    await this.lifecycleStore?.markPluginState(plugin, "migrating");

    try {
      for (const migration of migrations) {
        if (applied.has(migration.id)) {
          skippedIds.push(migration.id);
          continue;
        }

        await this.options.db.transaction(async (tx) => {
          await runMigration(tx, plugin.manifest.id, namespace, migration);
          await this.store.markApplied({
            pluginId: plugin.manifest.id,
            namespace,
            migrationId: migration.id,
            appliedAt: new Date(),
          });
        });
        applied.add(migration.id);
        appliedIds.push(migration.id);
      }
    } catch (error) {
      await this.lifecycleStore?.markPluginState(plugin, "degraded", {
        migrationsApplied: [...applied],
      });
      throw error;
    }

    await this.lifecycleStore?.markPluginState(plugin, "migrated", {
      migrationsApplied: [...applied],
    });

    return {
      pluginId: plugin.manifest.id,
      applied: appliedIds,
      skipped: skippedIds,
    };
  }
}

export class PostgresPluginStateStore
  implements PluginMigrationStore, PluginLifecycleStateStore
{
  constructor(
    private readonly db: DrizzleClient,
    private readonly namespacePrefix = "plugin",
  ) {}

  async listApplied(pluginId: string): Promise<readonly AppliedPluginMigration[]> {
    const result = await this.db.execute(sql`
      select plugin_id, name, applied_at
      from plugin_migrations
      where plugin_id = ${pluginId}
      order by name asc
    `);

    return rowsFromResult(result).map((row) => {
      const record = objectRecord(row);
      return {
        pluginId: stringValue(record.plugin_id) ?? pluginId,
        namespace: pluginMigrationNamespace(this.namespacePrefix, pluginId),
        migrationId: stringValue(record.name) ?? "",
        appliedAt: dateValue(record.applied_at),
      };
    });
  }

  async markApplied(migration: AppliedPluginMigration): Promise<void> {
    await this.db.execute(sql`
      insert into plugin_migrations (plugin_id, name, applied_at)
      values (${migration.pluginId}, ${migration.migrationId}, ${migration.appliedAt})
      on conflict (plugin_id, name) do nothing
    `);

    await this.db.execute(sql`
      update installed_plugins
      set migrations_applied =
            case
              when ${migration.migrationId} = any(migrations_applied) then migrations_applied
              else array_append(migrations_applied, ${migration.migrationId})
            end,
          updated_at = now()
      where id = ${migration.pluginId}
    `);
  }

  async markPluginState(
    plugin: LoadedPlugin,
    state: PluginLifecycleState,
    options: { readonly migrationsApplied?: readonly string[] } = {},
  ): Promise<void> {
    const enabled = state === "enabled";
    const manifestJson = JSON.stringify(plugin.manifest);
    const migrationsApplied = options.migrationsApplied;

    if (migrationsApplied === undefined) {
      await this.db.execute(sql`
        insert into installed_plugins (id, version, enabled, manifest, state, updated_at)
        values (
          ${plugin.manifest.id},
          ${plugin.manifest.version},
          ${enabled},
          ${manifestJson}::jsonb,
          ${state},
          now()
        )
        on conflict (id) do update
        set version = excluded.version,
            enabled = excluded.enabled,
            manifest = excluded.manifest,
            state = excluded.state,
            updated_at = now()
      `);
      return;
    }

    await this.db.execute(sql`
      insert into installed_plugins (
        id,
        version,
        enabled,
        manifest,
        state,
        migrations_applied,
        updated_at
      )
      values (
        ${plugin.manifest.id},
        ${plugin.manifest.version},
        ${enabled},
        ${manifestJson}::jsonb,
        ${state},
        ${migrationsApplied}::text[],
        now()
      )
      on conflict (id) do update
      set version = excluded.version,
          enabled = excluded.enabled,
          manifest = excluded.manifest,
          state = excluded.state,
          migrations_applied = excluded.migrations_applied,
          updated_at = now()
    `);
  }
}

export function pluginMigrationNamespace(prefix: string, pluginId: string): string {
  return `${prefix}_${pluginId.replaceAll(".", "_").replaceAll("-", "_")}`;
}

async function runMigration(
  db: DrizzleClient,
  pluginId: string,
  namespace: string,
  migration: PluginMigration,
): Promise<void> {
  if ("sql" in migration) {
    const statements = Array.isArray(migration.sql) ? migration.sql : [migration.sql];
    for (const statement of statements) {
      await db.execute(statement);
    }
    return;
  }

  await migration.up({ pluginId, namespace, db });
}

function isPluginLifecycleStateStore(value: unknown): value is PluginLifecycleStateStore {
  return (
    typeof value === "object" &&
    value !== null &&
    "markPluginState" in value &&
    typeof value.markPluginState === "function"
  );
}

function rowsFromResult(result: unknown): readonly unknown[] {
  if (Array.isArray(result)) {
    return result;
  }
  if (typeof result === "object" && result !== null && "rows" in result) {
    const rows = result.rows;
    if (Array.isArray(rows)) {
      return rows;
    }
  }
  return [];
}

function objectRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function dateValue(value: unknown): Date {
  if (value instanceof Date) {
    return value;
  }
  if (typeof value === "string" || typeof value === "number") {
    const date = new Date(value);
    if (!Number.isNaN(date.valueOf())) {
      return date;
    }
  }
  return new Date(0);
}
