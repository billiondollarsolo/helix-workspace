import type { WebPlatformHost } from "./platform";

export interface WebPluginDependency {
  readonly id: string;
  readonly optional?: boolean;
}

export interface WebPluginManifest {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly main?: string | null;
  readonly dependencies?: readonly (string | WebPluginDependency)[];
}

export interface WebPlugin {
  readonly manifest?: WebPluginManifest;
  register(host: WebPlatformHost): void | Promise<void>;
  onEnable?(host: WebPlatformHost): void | Promise<void>;
  onDisable?(host: WebPlatformHost): void | Promise<void>;
}

export interface WebPluginDescriptor {
  readonly manifest: WebPluginManifest;
  readonly load: () => unknown;
}

export interface LoadedWebPlugin {
  readonly manifest: WebPluginManifest;
  readonly module: WebPlugin;
  readonly state: "loaded" | "enabled" | "disabled";
}

export function validateWebPluginManifest(value: WebPluginManifest): WebPluginManifest {
  if (value.id.length === 0) {
    throw new TypeError("Web plugin manifest id must be a non-empty string");
  }
  if (value.name.length === 0) {
    throw new TypeError(`Web plugin ${value.id} name must be a non-empty string`);
  }
  if (value.version.length === 0) {
    throw new TypeError(`Web plugin ${value.id} version must be a non-empty string`);
  }
  return value;
}

export function discoverWebPlugins(
  descriptors: readonly WebPluginDescriptor[],
): readonly WebPluginDescriptor[] {
  const byId = new Map<string, WebPluginDescriptor>();
  for (const descriptor of descriptors) {
    const manifest = validateWebPluginManifest(descriptor.manifest);
    if (byId.has(manifest.id)) {
      throw new Error(`Duplicate web plugin id ${manifest.id}`);
    }
    byId.set(manifest.id, descriptor);
  }

  const resolved: WebPluginDescriptor[] = [];
  const visiting = new Set<string>();
  const visited = new Set<string>();

  const visit = (descriptor: WebPluginDescriptor, stack: readonly string[]): void => {
    const pluginId = descriptor.manifest.id;
    if (visited.has(pluginId)) {
      return;
    }
    if (visiting.has(pluginId)) {
      throw new Error(`Web plugin dependency cycle: ${[...stack, pluginId].join(" -> ")}`);
    }

    visiting.add(pluginId);
    for (const dependency of requiredWebDependencies(descriptor.manifest)) {
      const dependencyDescriptor = byId.get(dependency.id);
      if (dependencyDescriptor === undefined) {
        throw new Error(`Web plugin ${pluginId} depends on missing plugin ${dependency.id}`);
      }
      visit(dependencyDescriptor, [...stack, pluginId]);
    }
    visiting.delete(pluginId);
    visited.add(pluginId);
    resolved.push(descriptor);
  };

  for (const descriptor of descriptors) {
    visit(descriptor, []);
  }

  return resolved;
}

export async function loadWebPlugin(descriptor: WebPluginDescriptor): Promise<LoadedWebPlugin> {
  const imported = await descriptor.load();
  const plugin = unwrapWebPluginModule(imported);
  if (plugin.manifest !== undefined && plugin.manifest.id !== descriptor.manifest.id) {
    throw new Error(
      `Web plugin module manifest id ${plugin.manifest.id} does not match ${descriptor.manifest.id}`,
    );
  }

  return {
    manifest: descriptor.manifest,
    module: plugin,
    state: "loaded",
  };
}

export async function loadWebPlugins(
  descriptors: readonly WebPluginDescriptor[],
): Promise<readonly LoadedWebPlugin[]> {
  const loaded: LoadedWebPlugin[] = [];
  for (const descriptor of discoverWebPlugins(descriptors)) {
    loaded.push(await loadWebPlugin(descriptor));
  }
  return loaded;
}

export async function registerWebPluginContributions(
  host: WebPlatformHost,
  plugins: readonly LoadedWebPlugin[],
): Promise<readonly LoadedWebPlugin[]> {
  const enabled: LoadedWebPlugin[] = [];
  for (const plugin of plugins) {
    await plugin.module.register(host);
    await plugin.module.onEnable?.(host);
    enabled.push({ ...plugin, state: "enabled" });
  }
  return enabled;
}

export async function disableWebPlugin(
  host: WebPlatformHost,
  plugin: LoadedWebPlugin,
): Promise<LoadedWebPlugin> {
  await plugin.module.onDisable?.(host);
  return { ...plugin, state: "disabled" };
}

function unwrapWebPluginModule(value: unknown): WebPlugin {
  const candidate =
    typeof value === "object" && value !== null && "default" in value ? value.default : value;
  if (!isWebPlugin(candidate)) {
    throw new TypeError("Web plugin module must export a plugin with register(host)");
  }
  return candidate;
}

function isWebPlugin(value: unknown): value is WebPlugin {
  return (
    typeof value === "object" &&
    value !== null &&
    "register" in value &&
    typeof value.register === "function"
  );
}

function requiredWebDependencies(manifest: WebPluginManifest): readonly WebPluginDependency[] {
  return (manifest.dependencies ?? [])
    .map((dependency) => (typeof dependency === "string" ? { id: dependency } : dependency))
    .filter((dependency) => dependency.optional !== true);
}
