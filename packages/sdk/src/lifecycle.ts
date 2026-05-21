import type { PlatformPlugin } from "@helix/sdk-types";
import type { PlatformHost } from "./host.js";

export async function startPlugin(plugin: PlatformPlugin<PlatformHost>, host: PlatformHost): Promise<void> {
  await plugin.onStart?.(host);
}

export async function enablePlugin(plugin: PlatformPlugin<PlatformHost>, host: PlatformHost): Promise<void> {
  await plugin.onEnable?.(host);
}

export async function disablePlugin(plugin: PlatformPlugin<PlatformHost>, host: PlatformHost): Promise<void> {
  await plugin.onDisable?.(host);
}

export async function stopPlugin(plugin: PlatformPlugin<PlatformHost>, host: PlatformHost): Promise<void> {
  await plugin.onStop?.(host);
}

export async function installPlugin(plugin: PlatformPlugin<PlatformHost>, host: PlatformHost): Promise<void> {
  await plugin.onInstall?.(host);
}

export async function migratePlugin(plugin: PlatformPlugin<PlatformHost>, host: PlatformHost): Promise<void> {
  await plugin.onMigrate?.(host);
}

export async function uninstallPlugin(plugin: PlatformPlugin<PlatformHost>, host: PlatformHost): Promise<void> {
  await plugin.onUninstall?.(host);
}
