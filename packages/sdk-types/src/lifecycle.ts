import type { PluginManifest } from "./manifest.js";
import type { PluginMigration } from "./migrations.js";

export interface PluginLifecycleHooks<Host> {
  onInstall?(host: Host): Promise<void>;
  onMigrate?(host: Host): Promise<void>;
  onStart?(host: Host): Promise<void>;
  onEnable?(host: Host): Promise<void>;
  onDisable?(host: Host): Promise<void>;
  onStop?(host: Host): Promise<void>;
  onUninstall?(host: Host): Promise<void>;
}

export interface PlatformPlugin<Host = unknown> extends PluginLifecycleHooks<Host> {
  readonly manifest?: PluginManifest;
  readonly migrations?: readonly PluginMigration[];
}

export function definePlugin<Host>(plugin: PlatformPlugin<Host>): PlatformPlugin<Host> {
  return plugin;
}
