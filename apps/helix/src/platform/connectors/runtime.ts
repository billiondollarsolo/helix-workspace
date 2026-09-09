import type { PluginManifest, TierSecurityDefaults } from "@helix/sdk";
import { isCanonicalPluginId } from "@helix/sdk-types";
import { discoverPluginsDirectory, type DiscoveredPlugin } from "../plugins/loader.js";
import type { PluginTrustOptions } from "../plugins/trust.js";
import { ConnectorRegistry } from "./registry.js";
import { ConnectorSandbox } from "./sandbox.js";
import { CONNECTOR_MANIFEST_CATEGORY } from "./types.js";

/**
 * Loads connector artifacts into isolated processes and exposes only their
 * narrow webhook registrations. Core apps remain platform modules wired by
 * the composition root.
 */

export interface ConnectorLoadOptions {
  readonly pluginsDir: string;
  readonly tierDefaults?: TierSecurityDefaults;
  readonly pluginTrust?: PluginTrustOptions;
  readonly enabledPluginIds?: ReadonlySet<string>;
  readonly onConnectorLoaded?: (manifest: PluginManifest) => void;
  readonly onConnectorError?: (error: unknown, manifest: PluginManifest) => void;
  readonly onConnectorSkipped?: (manifest: PluginManifest, reason: string) => void;
}

export interface LoadedConnector {
  readonly manifest: PluginManifest;
  readonly rootDir: string;
}

export interface ConnectorLoadResult {
  readonly registry: ConnectorRegistry;
  readonly loaded: readonly LoadedConnector[];
  readonly prepare: (plugin: DiscoveredPlugin) => Promise<PreparedConnector | undefined>;
  readonly disable: (pluginId: string) => void;
  readonly close: () => void;
}

export interface PreparedConnector {
  commit(): void;
  rollback(): void;
}

/** Read the manifest `category` field (manifests allow additional properties). */
export function manifestCategory(manifest: PluginManifest): string | undefined {
  const category = (manifest as { category?: unknown }).category;
  return typeof category === "string" ? category : undefined;
}

/** True iff the manifest declares the external-connector category. */
export function isConnectorManifest(manifest: PluginManifest): boolean {
  return manifestCategory(manifest) === CONNECTOR_MANIFEST_CATEGORY;
}

/**
 * Discover, validate, load and start every connector-category plugin under
 * `pluginsDir`. Failure to load a single connector is logged and skipped —
 * one bad connector never blocks server startup.
 */
export async function loadConnectors(options: ConnectorLoadOptions): Promise<ConnectorLoadResult> {
  const registry = new ConnectorRegistry();
  const loaded: LoadedConnector[] = [];
  const sandboxes = new Map<string, ConnectorSandbox>();

  const discovered = await discoverPluginsDirectory(options.pluginsDir, {
    ...(options.tierDefaults === undefined ? {} : { tierDefaults: options.tierDefaults }),
    ...(options.pluginTrust === undefined ? {} : { pluginTrust: options.pluginTrust }),
    onError: (artifact, error) =>
      options.onConnectorError?.(error, discoveryErrorManifest(artifact)),
  }).catch((error: unknown) => {
    options.onConnectorError?.(error, discoveryErrorManifest(options.pluginsDir));
    return [] as readonly DiscoveredPlugin[];
  });

  const disable = (pluginId: string): void => {
    registry.removeConnector(pluginId);
    sandboxes.get(pluginId)?.close();
    sandboxes.delete(pluginId);
    const index = loaded.findIndex((connector) => connector.manifest.id === pluginId);
    if (index >= 0) loaded.splice(index, 1);
  };

  const prepare = async (plugin: DiscoveredPlugin): Promise<PreparedConnector | undefined> => {
    const { manifest } = plugin;
    if (!isConnectorManifest(manifest)) return undefined;
    if (manifest.kind !== "sandboxed") {
      throw new Error(`Connector ${manifest.id} must be sandboxed, got ${manifest.kind}.`);
    }
    if (manifest.main === undefined || manifest.main === null || manifest.main.length === 0) {
      throw new Error(`Connector ${manifest.id} is missing a main entry point.`);
    }

    const started = await ConnectorSandbox.start(plugin);
    const formats = started.registration.formats.map((id) => ({
      id,
      render: (event: Parameters<ConnectorSandbox["render"]>[1]) =>
        started.sandbox.render(id, event),
    }));
    const sources = started.registration.sources.map((id) => ({
      id,
      verify: (input: Parameters<ConnectorSandbox["verify"]>[1]) =>
        started.sandbox.verify(id, input),
    }));
    try {
      registry.assertConnectorAvailable(manifest.id, formats, sources);
    } catch (error) {
      started.sandbox.close();
      throw error;
    }
    let finished = false;
    return {
      commit: () => {
        if (finished) return;
        registry.replaceConnector(manifest.id, formats, sources);
        const previous = sandboxes.get(manifest.id);
        sandboxes.set(manifest.id, started.sandbox);
        const index = loaded.findIndex((connector) => connector.manifest.id === manifest.id);
        const connector = { manifest, rootDir: plugin.rootDir };
        if (index < 0) loaded.push(connector);
        else loaded.splice(index, 1, connector);
        finished = true;
        previous?.close();
        options.onConnectorLoaded?.(manifest);
      },
      rollback: () => {
        if (finished) return;
        finished = true;
        started.sandbox.close();
      },
    };
  };

  for (const plugin of discovered) {
    const { manifest } = plugin;
    if (!isConnectorManifest(manifest)) {
      continue;
    }
    if (options.enabledPluginIds !== undefined && !options.enabledPluginIds.has(manifest.id)) {
      options.onConnectorSkipped?.(manifest, "plugin is not enabled");
      continue;
    }
    try {
      const staged = await prepare(plugin);
      try {
        staged?.commit();
      } catch (error) {
        staged?.rollback();
        throw error;
      }
    } catch (error) {
      options.onConnectorError?.(error, manifest);
    }
  }

  return {
    registry,
    loaded,
    prepare,
    disable,
    close: () => {
      for (const pluginId of [...sandboxes.keys()]) disable(pluginId);
    },
  };
}

function discoveryErrorManifest(pluginsDir: string): PluginManifest {
  return {
    id: isCanonicalPluginId(pluginsDir) ? pluginsDir : "com.helix.connector-discovery",
    name: `connector discovery (${pluginsDir})`,
    version: "0.0.0",
    sdkVersion: "^1.0.0",
    kind: "sandboxed",
    capabilities: { provides: [], consumes: [] },
    permissions: { scopes: [], "outbound-network": [], filesystem: [], envVars: [] },
  };
}
