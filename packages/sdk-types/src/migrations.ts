import type { DrizzleClient } from "./core.js";

export interface PluginMigrationContext {
  readonly pluginId: string;
  readonly namespace: string;
  readonly db: DrizzleClient;
}

export interface PluginSqlMigration {
  readonly id: string;
  readonly description?: string;
  readonly sql: string | readonly string[];
}

export interface PluginCodeMigration {
  readonly id: string;
  readonly description?: string;
  up(context: PluginMigrationContext): Promise<void>;
  down?(context: PluginMigrationContext): Promise<void>;
}

export type PluginMigration = PluginSqlMigration | PluginCodeMigration;

export interface PluginMigrationProvider {
  readonly migrations?: readonly PluginMigration[];
}
