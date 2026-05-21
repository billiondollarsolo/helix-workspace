import { describe, expect, it } from "vitest";
import type {
  DrizzleClient,
  PlatformHost,
  PlatformPlugin,
  PluginLifecycleState,
  PluginManifest,
  PluginMigration,
} from "@helix/sdk";
import type { LoadedPlugin } from "./loader.js";
import {
  type AppliedPluginMigration,
  type PluginLifecycleStateStore,
  type PluginMigrationStore,
  PluginMigrationRunner,
  PostgresPluginStateStore,
} from "./migrations.js";

describe("plugin migration runner state tracking", () => {
  it("records migrating and migrated states when the store supports lifecycle state", async () => {
    const states: PluginLifecycleState[] = [];
    const store: PluginMigrationStore & PluginLifecycleStateStore = {
      async listApplied() {
        return [];
      },
      async markApplied() {},
      async markPluginState(_plugin, state) {
        states.push(state);
      },
    };
    const db = new RecordingDb();
    const runner = new PluginMigrationRunner({ db, store });
    const plugin = loadedPlugin([
      { id: "001_create_tables", sql: "select 1" },
      {
        id: "002_seed_data",
        async up(context) {
          await context.db.execute("seed");
        },
      },
    ]);

    await expect(runner.run(plugin)).resolves.toEqual({
      pluginId: "com.example.plugin",
      applied: ["001_create_tables", "002_seed_data"],
      skipped: [],
    });
    expect(states).toEqual(["migrating", "migrated"]);
    expect(db.executed).toHaveLength(2);
  });

  it("keeps previously applied migrations in migrated state", async () => {
    const migrated: string[][] = [];
    const store: PluginMigrationStore & PluginLifecycleStateStore = {
      async listApplied() {
        return [
          {
            pluginId: "com.example.plugin",
            namespace: "plugin_com_example_plugin",
            migrationId: "001_create_tables",
            appliedAt: new Date("2026-01-01T00:00:00.000Z"),
          },
        ];
      },
      async markApplied() {},
      async markPluginState(_plugin, state, options) {
        if (state === "migrated" && options?.migrationsApplied !== undefined) {
          migrated.push([...options.migrationsApplied]);
        }
      },
    };
    const runner = new PluginMigrationRunner({
      db: new RecordingDb(),
      store,
    });

    await expect(
      runner.run(
        loadedPlugin([
          { id: "001_create_tables", sql: "select 1" },
          { id: "002_seed_data", sql: "select 2" },
        ]),
      ),
    ).resolves.toMatchObject({
      applied: ["002_seed_data"],
      skipped: ["001_create_tables"],
    });
    expect(migrated).toEqual([["001_create_tables", "002_seed_data"]]);
  });

  it("marks the plugin degraded when a migration fails", async () => {
    const states: {
      state: PluginLifecycleState;
      migrationsApplied: readonly string[] | undefined;
    }[] = [];
    const store = new RecordingMigrationStore({
      async markPluginState(_plugin, state, options) {
        states.push({ state, migrationsApplied: options?.migrationsApplied });
      },
    });
    const runner = new PluginMigrationRunner({
      db: new RecordingDb([], { failOnExecute: "select broken" }),
      store,
    });

    await expect(
      runner.run(
        loadedPlugin([
          { id: "001_create_tables", sql: "select 1" },
          { id: "002_broken", sql: "select broken" },
        ]),
      ),
    ).rejects.toThrow("execute failed: select broken");

    expect(states).toEqual([
      { state: "migrating", migrationsApplied: undefined },
      { state: "degraded", migrationsApplied: ["001_create_tables"] },
    ]);
    expect(await store.listApplied("com.example.plugin")).toMatchObject([
      { migrationId: "001_create_tables" },
    ]);
  });

  it("preserves previously applied migration ids when marking migration failure degraded", async () => {
    const degraded: string[] = [];
    const store = new RecordingMigrationStore({
      applied: [
        {
          pluginId: "com.example.plugin",
          namespace: "plugin_com_example_plugin",
          migrationId: "001_create_tables",
          appliedAt: new Date("2026-01-01T00:00:00.000Z"),
        },
      ],
      async markPluginState(_plugin, state, options) {
        if (state === "degraded" && options?.migrationsApplied !== undefined) {
          degraded.push(...options.migrationsApplied);
        }
      },
    });
    const runner = new PluginMigrationRunner({
      db: new RecordingDb([], { failOnExecute: "select broken" }),
      store,
    });

    await expect(
      runner.run(
        loadedPlugin([
          { id: "001_create_tables", sql: "select 1" },
          { id: "002_broken", sql: "select broken" },
        ]),
      ),
    ).rejects.toThrow("execute failed: select broken");

    expect(degraded).toEqual(["001_create_tables"]);
  });
});

describe("postgres plugin state store", () => {
  it("reads applied plugin migrations from postgres-style row results", async () => {
    const appliedAt = new Date("2026-02-03T04:05:06.000Z");
    const db = new RecordingDb([
      { rows: [{ plugin_id: "com.example.plugin", name: "001", applied_at: appliedAt }] },
    ]);
    const store = new PostgresPluginStateStore(db);

    await expect(store.listApplied("com.example.plugin")).resolves.toEqual([
      {
        pluginId: "com.example.plugin",
        namespace: "plugin_com_example_plugin",
        migrationId: "001",
        appliedAt,
      },
    ]);
  });

  it("persists installed plugin state and applied migration ids", async () => {
    const db = new RecordingDb();
    const store = new PostgresPluginStateStore(db);

    await store.markPluginState(loadedPlugin([]), "migrated", {
      migrationsApplied: ["001"],
    });
    await store.markApplied({
      pluginId: "com.example.plugin",
      namespace: "plugin_com_example_plugin",
      migrationId: "001",
      appliedAt: new Date("2026-01-01T00:00:00.000Z"),
    });

    expect(db.executed).toHaveLength(3);
  });
});

class RecordingMigrationStore implements PluginMigrationStore, PluginLifecycleStateStore {
  private readonly applied = new Map<string, AppliedPluginMigration>();
  private readonly onMarkPluginState:
    | PluginLifecycleStateStore["markPluginState"]
    | undefined;

  constructor(
    options: {
      readonly applied?: readonly AppliedPluginMigration[];
      readonly markPluginState?: PluginLifecycleStateStore["markPluginState"];
    } = {},
  ) {
    for (const migration of options.applied ?? []) {
      this.applied.set(`${migration.pluginId}:${migration.migrationId}`, migration);
    }
    this.onMarkPluginState = options.markPluginState;
  }

  async listApplied(pluginId: string): Promise<readonly AppliedPluginMigration[]> {
    return [...this.applied.values()].filter((migration) => migration.pluginId === pluginId);
  }

  async markApplied(migration: AppliedPluginMigration): Promise<void> {
    this.applied.set(`${migration.pluginId}:${migration.migrationId}`, migration);
  }

  async markPluginState(
    plugin: LoadedPlugin,
    state: PluginLifecycleState,
    options?: { readonly migrationsApplied?: readonly string[] },
  ): Promise<void> {
    await this.onMarkPluginState?.(plugin, state, options);
  }
}

class RecordingDb implements DrizzleClient {
  readonly executed: unknown[] = [];
  private readonly results: unknown[];

  constructor(
    results: readonly unknown[] = [],
    private readonly options: { readonly failOnExecute?: unknown } = {},
  ) {
    this.results = [...results];
  }

  async execute(query: unknown): Promise<unknown> {
    this.executed.push(query);
    if (query === this.options.failOnExecute) {
      throw new Error(`execute failed: ${String(query)}`);
    }
    return this.results.shift() ?? [];
  }

  async transaction<T>(fn: (tx: DrizzleClient) => Promise<T>): Promise<T> {
    return fn(this);
  }
}

function loadedPlugin(migrations: readonly PluginMigration[]): LoadedPlugin {
  const manifest = baseManifest();
  const module: PlatformPlugin<PlatformHost> = { manifest, migrations };
  return {
    rootDir: "/tmp/com.example.plugin",
    manifestPath: "/tmp/com.example.plugin/plugin.json",
    manifest,
    module,
    state: "installed",
  };
}

function baseManifest(): PluginManifest {
  return {
    id: "com.example.plugin",
    name: "Example Plugin",
    version: "1.0.0",
    sdkVersion: "^1.0.0",
    kind: "in-process",
    main: "index.js",
    capabilities: {
      provides: ["example.capability"],
      consumes: [],
    },
    permissions: {
      scopes: [],
      "outbound-network": [],
      filesystem: [],
      envVars: [],
    },
  };
}
