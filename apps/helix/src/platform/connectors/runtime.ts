import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import type { PluginManifest, TierSecurityDefaults } from "@helix/sdk";
import { discoverPluginsDirectory, type DiscoveredPlugin } from "../plugins/loader.js";
import { ConnectorRegistry } from "./registry.js";
import {
  CONNECTOR_MANIFEST_CATEGORY,
  isConnectorPlugin,
  type ConnectorPlugin,
} from "./types.js";

/**
 * The connector loader — wires the plugin discovery/lifecycle machinery to
 * *actually load* connector-category plugins at startup.
 *
 * Prior to this, `InProcessPluginRuntime` and the loader were built and tested
 * but never invoked against a real plugin (the audit's headline finding). This
 * runtime closes that gap for the connector half of the plugin model: it
 * discovers `/plugins`, keeps only `category === "connector"` in-process
 * plugins, imports each one, and invokes its `register` hook against a shared
 * {@link ConnectorRegistry}.
 *
 * Core apps are explicitly NOT loaded here — they are platform modules wired
 * directly into `server.ts`. Plugins whose manifest category is `core-app` (or
 * is unset) are skipped, keeping the core/connector boundary crisp.
 */

export interface ConnectorLoadOptions {
  readonly pluginsDir: string;
  readonly tierDefaults?: TierSecurityDefaults;
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

interface ImportedConnectorModule {
  readonly default?: unknown;
}

/**
 * Discover, validate, load and start every connector-category plugin under
 * `pluginsDir`. Failure to load a single connector is logged and skipped —
 * one bad connector never blocks server startup.
 */
export async function loadConnectors(
  options: ConnectorLoadOptions,
): Promise<ConnectorLoadResult> {
  const registry = new ConnectorRegistry();
  const loaded: LoadedConnector[] = [];

  const discovered = await discoverPluginsDirectory(options.pluginsDir, {
    ...(options.tierDefaults === undefined ? {} : { tierDefaults: options.tierDefaults }),
  }).catch((error: unknown) => {
    options.onConnectorError?.(error, placeholderManifest(options.pluginsDir));
    return [] as readonly DiscoveredPlugin[];
  });

  for (const plugin of discovered) {
    const { manifest } = plugin;
    if (!isConnectorManifest(manifest)) {
      // Core-app placeholders and uncategorized manifests are not connectors.
      continue;
    }
    if (manifest.kind !== "in-process") {
      options.onConnectorSkipped?.(
        manifest,
        `kind "${manifest.kind}" is not yet loadable; only in-process connectors are supported`,
      );
      continue;
    }
    if (manifest.main === undefined || manifest.main === null || manifest.main.length === 0) {
      options.onConnectorSkipped?.(manifest, "manifest is missing a `main` entry point");
      continue;
    }

    try {
      const connector = await importConnector(plugin.rootDir, manifest.main, manifest.id);
      if (connector === "scaffold") {
        // An `export default {}` placeholder: a declared-but-not-yet-realized
        // connector. Skipped cleanly rather than treated as a load failure.
        options.onConnectorSkipped?.(
          manifest,
          "connector entry point is an unrealized scaffold (no register() hook)",
        );
        continue;
      }
      registry.beginConnector(manifest.id);
      await connector.register(registry);
      registry.endConnector();
      loaded.push({ manifest, rootDir: plugin.rootDir });
      options.onConnectorLoaded?.(manifest);
    } catch (error) {
      registry.endConnector();
      options.onConnectorError?.(error, manifest);
    }
  }

  return { registry, loaded };
}

async function importConnector(
  rootDir: string,
  main: string,
  manifestId: string,
): Promise<ConnectorPlugin | "scaffold"> {
  const entryUrl = pathToFileURL(resolve(rootDir, main)).href;
  const imported = (await import(entryUrl)) as ImportedConnectorModule;
  const exported = imported.default;
  if (isEmptyScaffold(exported)) {
    return "scaffold";
  }
  if (!isConnectorPlugin(exported)) {
    throw new Error(
      `Connector ${manifestId} must default-export a connector definition with a register() function`,
    );
  }
  if (exported.id !== undefined && exported.id !== manifestId) {
    throw new Error(
      `Connector module id "${exported.id}" does not match manifest id "${manifestId}"`,
    );
  }
  return exported;
}

/** An `export default {}` placeholder — a declared-but-unrealized connector. */
function isEmptyScaffold(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length === 0
  );
}

function placeholderManifest(pluginsDir: string): PluginManifest {
  return {
    id: "com.helix.connector-discovery",
    name: `connector discovery (${pluginsDir})`,
    version: "0.0.0",
    sdkVersion: "^1.0.0",
    kind: "in-process",
    capabilities: { provides: [], consumes: [] },
    permissions: { scopes: [], "outbound-network": [], filesystem: [], envVars: [] },
  };
}
