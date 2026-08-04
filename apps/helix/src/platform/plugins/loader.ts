import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { readdir, readFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import type {
  PlatformHost,
  PlatformPlugin,
  PluginDependencyDeclaration,
  PluginLifecycleState,
  PluginManifest,
  PluginMigration,
  HelixConfig,
  SecurityTier,
  TierSecurityDefaults,
} from "@helix/sdk";
import {
  assertPluginManifest,
  disablePlugin,
  enablePlugin,
  isJsonObject,
  startPlugin,
  uninstallPlugin,
} from "@helix/sdk";
import { resolveTierDefaults, tierDefaults as securityTierDefaults } from "../config/tier.js";

export interface DiscoveredPlugin {
  readonly rootDir: string;
  readonly manifestPath: string;
  readonly manifest: PluginManifest;
  readonly state: PluginLifecycleState;
}

export interface LoadedPlugin extends DiscoveredPlugin {
  readonly module: PlatformPlugin<PlatformHost>;
}

export interface PluginDiscoveryOptions {
  readonly includeRootManifest?: boolean;
  readonly tierPolicy?: PluginTierPolicy;
  readonly config?: HelixConfig;
  readonly tierDefaults?: TierSecurityDefaults;
}

export interface PluginTierPolicy {
  readonly tier: SecurityTier;
  readonly pluginSignatureRequired?: boolean;
  readonly localAiOnly?: boolean;
  readonly airgapRequired?: boolean;
}

export interface PluginHostFactory {
  createHost(plugin: DiscoveredPlugin): Promise<PlatformHost>;
}

interface ImportedPluginModule {
  readonly default?: unknown;
  readonly migrations?: readonly PluginMigration[];
}

export function pluginTierPolicyFromSecurityDefaults(
  configOrDefaults: HelixConfig | TierSecurityDefaults,
): PluginTierPolicy {
  const defaults = isTierSecurityDefaults(configOrDefaults)
    ? configOrDefaults
    : resolveTierDefaults(configOrDefaults);
  return {
    tier: defaults.tier,
    pluginSignatureRequired: defaults.pluginSignatureRequired,
    localAiOnly: defaults.localAiOnly,
    airgapRequired: defaults.networkEgress === "default-deny",
  };
}

export async function discoverPlugin(
  rootDir: string,
  options: PluginDiscoveryOptions = {},
): Promise<DiscoveredPlugin> {
  const manifestPath = join(rootDir, "plugin.json");
  const manifestText = await readFile(manifestPath, "utf8");
  const manifest = assertPluginManifest(parseManifestJson(manifestText, manifestPath));

  const plugin = {
    rootDir: resolve(rootDir),
    manifestPath: resolve(manifestPath),
    manifest,
    state: "validated",
  } satisfies DiscoveredPlugin;
  const tierPolicy = resolvePluginDiscoveryTierPolicy(options);
  if (tierPolicy !== undefined) {
    await enforcePluginTierPolicy(plugin, tierPolicy);
  }
  return plugin;
}

export async function discoverPluginsDirectory(
  pluginsDir: string,
  options: PluginDiscoveryOptions = {},
): Promise<readonly DiscoveredPlugin[]> {
  const discovered: DiscoveredPlugin[] = [];

  if (options.includeRootManifest === true) {
    const rootPlugin = await discoverPluginIfPresent(pluginsDir, options);
    if (rootPlugin !== undefined) {
      discovered.push(rootPlugin);
    }
  }

  const entries = await readdir(pluginsDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const plugin = await discoverPluginIfPresent(join(pluginsDir, entry.name), options);
    if (plugin !== undefined) {
      discovered.push(plugin);
    }
  }

  return resolvePluginDependencies(discovered);
}

/** Discovers a plugin directory, treating a missing `plugin.json` as "no plugin here". */
async function discoverPluginIfPresent(
  rootDir: string,
  options: PluginDiscoveryOptions,
): Promise<DiscoveredPlugin | undefined> {
  return discoverPlugin(rootDir, options).catch((error: unknown) => {
    if (isFileNotFound(error)) {
      return undefined;
    }
    throw error;
  });
}

export async function enforcePluginTierPolicy(
  plugin: DiscoveredPlugin,
  policy: PluginTierPolicy,
): Promise<void> {
  const manifest = plugin.manifest;
  assertMinimumTier(manifest, policy.tier);
  assertTierRestriction(manifest, policy.tier);

  if (policy.pluginSignatureRequired === true) {
    if (!hasSignatureEvidence(manifest)) {
      throw new Error(
        `Plugin ${manifest.id} requires signed artifact evidence for ${policy.tier} tier.`,
      );
    }
    await assertPluginBundleDigest(plugin);
  }

  if (
    policy.localAiOnly === true &&
    providesAiProvider(manifest) &&
    !isLocalOnlyAiPlugin(manifest)
  ) {
    throw new Error(`Plugin ${manifest.id} is not permitted by local-only AI policy.`);
  }

  if (
    policy.airgapRequired === true &&
    hasExternalNetworkPermission(manifest) &&
    !isAirgapCompatible(manifest)
  ) {
    throw new Error(
      `Plugin ${manifest.id} declares outbound network access without air-gap compatibility.`,
    );
  }
}

export async function calculatePluginBundleDigest(plugin: DiscoveredPlugin): Promise<string> {
  const hash = createHash("sha256");
  const files = await listBundleFiles(plugin.rootDir);
  for (const file of files) {
    hash.update(file.relativePath, "utf8");
    hash.update("\0");
    if (file.relativePath === "plugin.json") {
      hash.update(canonicalManifestWithoutSignature(plugin.manifest), "utf8");
    } else {
      hash.update(await readFile(file.absolutePath));
    }
    hash.update("\0");
  }
  return `sha256:${hash.digest("hex")}`;
}

export function resolvePluginDependencies(
  plugins: readonly DiscoveredPlugin[],
): readonly DiscoveredPlugin[] {
  const byId = new Map<string, DiscoveredPlugin>();
  for (const plugin of plugins) {
    const duplicate = byId.get(plugin.manifest.id);
    if (duplicate !== undefined) {
      throw new Error(
        `Duplicate plugin id ${plugin.manifest.id} in ${duplicate.manifestPath} and ${plugin.manifestPath}`,
      );
    }
    byId.set(plugin.manifest.id, plugin);
  }

  const resolved: DiscoveredPlugin[] = [];
  const visiting = new Set<string>();
  const visited = new Set<string>();

  function visit(plugin: DiscoveredPlugin, stack: readonly string[]): void {
    const pluginId = plugin.manifest.id;
    if (visited.has(pluginId)) {
      return;
    }
    if (visiting.has(pluginId)) {
      throw new Error(`Plugin dependency cycle: ${[...stack, pluginId].join(" -> ")}`);
    }

    visiting.add(pluginId);
    for (const dependency of requiredDependencies(plugin.manifest)) {
      const dependencyPlugin = byId.get(dependency.id);
      if (dependencyPlugin === undefined) {
        throw new Error(`Plugin ${pluginId} depends on missing plugin ${dependency.id}`);
      }
      visit(dependencyPlugin, [...stack, pluginId]);
    }
    visiting.delete(pluginId);
    visited.add(pluginId);
    resolved.push(plugin);
  }

  for (const plugin of plugins) {
    visit(plugin, []);
  }

  return resolved;
}

export async function loadInProcessPlugin(plugin: DiscoveredPlugin): Promise<LoadedPlugin> {
  if (plugin.manifest.kind !== "in-process") {
    throw new Error(
      `Plugin ${plugin.manifest.id} is ${plugin.manifest.kind}; only in-process loading is implemented`,
    );
  }

  if (plugin.manifest.main === undefined || plugin.manifest.main === null) {
    throw new Error(`Plugin ${plugin.manifest.id} is missing manifest.main`);
  }

  const entryUrl = pathToFileURL(resolve(plugin.rootDir, plugin.manifest.main)).href;
  const imported = (await import(entryUrl)) as ImportedPluginModule;
  if (imported.default === undefined || !isPlatformPlugin(imported.default)) {
    throw new Error(`Plugin ${plugin.manifest.id} must default-export a plugin definition`);
  }
  const module =
    imported.migrations === undefined
      ? imported.default
      : {
          ...imported.default,
          migrations: imported.default.migrations ?? imported.migrations,
        };

  if (module.manifest !== undefined && module.manifest.id !== plugin.manifest.id) {
    throw new Error(
      `Plugin module manifest id ${module.manifest.id} does not match ${plugin.manifest.id}`,
    );
  }

  return { ...plugin, module, state: "installed" };
}

export async function startLoadedPlugin(
  loaded: LoadedPlugin,
  hostFactory: PluginHostFactory,
): Promise<LoadedPlugin> {
  const host = await hostFactory.createHost(loaded);
  const starting: LoadedPlugin = { ...loaded, state: "starting" };
  await startPlugin(starting.module, host);
  await enablePlugin(starting.module, host);
  return { ...starting, state: "enabled" };
}

export async function disableLoadedPlugin(
  loaded: LoadedPlugin,
  hostFactory: PluginHostFactory,
): Promise<LoadedPlugin> {
  const host = await hostFactory.createHost(loaded);
  await disablePlugin(loaded.module, host);
  return { ...loaded, state: "disabled" };
}

export async function uninstallLoadedPlugin(
  loaded: LoadedPlugin,
  hostFactory: PluginHostFactory,
): Promise<LoadedPlugin> {
  const host = await hostFactory.createHost(loaded);
  const uninstalling: LoadedPlugin = { ...loaded, state: "uninstalling" };
  await uninstallPlugin(uninstalling.module, host);
  return { ...uninstalling, state: "uninstalled" };
}

export async function loadInProcessPlugins(
  discoveredPlugins: readonly DiscoveredPlugin[],
): Promise<readonly LoadedPlugin[]> {
  const sortedPlugins = resolvePluginDependencies(discoveredPlugins);
  const loaded: LoadedPlugin[] = [];
  for (const plugin of sortedPlugins) {
    loaded.push(await loadInProcessPlugin(plugin));
  }
  return loaded;
}

export class InProcessPluginRuntime {
  private readonly loadedPlugins = new Map<string, LoadedPlugin>();
  private readonly hosts = new Map<string, PlatformHost>();

  constructor(private readonly hostFactory: PluginHostFactory) {}

  async load(plugins: readonly DiscoveredPlugin[]): Promise<readonly LoadedPlugin[]> {
    const loaded = await loadInProcessPlugins(plugins);
    for (const plugin of loaded) {
      this.loadedPlugins.set(plugin.manifest.id, plugin);
    }
    return loaded;
  }

  async loadFromDirectory(
    pluginsDir: string,
    options: PluginDiscoveryOptions = {},
  ): Promise<readonly LoadedPlugin[]> {
    return this.load(await discoverPluginsDirectory(pluginsDir, options));
  }

  async startAll(): Promise<readonly LoadedPlugin[]> {
    const started: LoadedPlugin[] = [];
    for (const plugin of resolveLoadedPluginDependencies([...this.loadedPlugins.values()])) {
      started.push(await this.start(plugin.manifest.id));
    }
    return started;
  }

  async start(pluginId: string): Promise<LoadedPlugin> {
    const loaded = this.requireLoaded(pluginId);
    const host = await this.hostFor(loaded);
    const starting: LoadedPlugin = { ...loaded, state: "starting" };
    this.loadedPlugins.set(pluginId, starting);
    await startPlugin(starting.module, host);
    await enablePlugin(starting.module, host);
    const enabled: LoadedPlugin = { ...starting, state: "enabled" };
    this.loadedPlugins.set(pluginId, enabled);
    return enabled;
  }

  async enable(pluginId: string): Promise<LoadedPlugin> {
    const loaded = this.requireLoaded(pluginId);
    await enablePlugin(loaded.module, await this.hostFor(loaded));
    const enabled: LoadedPlugin = { ...loaded, state: "enabled" };
    this.loadedPlugins.set(pluginId, enabled);
    return enabled;
  }

  async disable(pluginId: string): Promise<LoadedPlugin> {
    const loaded = this.requireLoaded(pluginId);
    await disablePlugin(loaded.module, await this.hostFor(loaded));
    const disabled: LoadedPlugin = { ...loaded, state: "disabled" };
    this.loadedPlugins.set(pluginId, disabled);
    return disabled;
  }

  async uninstall(pluginId: string): Promise<LoadedPlugin> {
    const loaded = this.requireLoaded(pluginId);
    const uninstalling: LoadedPlugin = { ...loaded, state: "uninstalling" };
    this.loadedPlugins.set(pluginId, uninstalling);
    await uninstallPlugin(uninstalling.module, await this.hostFor(uninstalling));
    const uninstalled: LoadedPlugin = { ...uninstalling, state: "uninstalled" };
    this.loadedPlugins.set(pluginId, uninstalled);
    this.hosts.delete(pluginId);
    return uninstalled;
  }

  get(pluginId: string): LoadedPlugin | undefined {
    return this.loadedPlugins.get(pluginId);
  }

  list(): readonly LoadedPlugin[] {
    return resolveLoadedPluginDependencies([...this.loadedPlugins.values()]);
  }

  private requireLoaded(pluginId: string): LoadedPlugin {
    const plugin = this.loadedPlugins.get(pluginId);
    if (plugin === undefined) {
      throw new Error(`Plugin ${pluginId} has not been loaded`);
    }
    return plugin;
  }

  private async hostFor(plugin: LoadedPlugin): Promise<PlatformHost> {
    const existing = this.hosts.get(plugin.manifest.id);
    if (existing !== undefined) {
      return existing;
    }

    const host = await this.hostFactory.createHost(plugin);
    this.hosts.set(plugin.manifest.id, host);
    return host;
  }
}

export async function discoverLoadAndStartDirectory(
  pluginsDir: string,
  hostFactory: PluginHostFactory,
  options: PluginDiscoveryOptions = {},
): Promise<readonly LoadedPlugin[]> {
  const runtime = new InProcessPluginRuntime(hostFactory);
  await runtime.loadFromDirectory(pluginsDir, options);
  return runtime.startAll();
}

export async function discoverLoadAndStart(
  rootDir: string,
  hostFactory: PluginHostFactory,
  options: PluginDiscoveryOptions = {},
): Promise<LoadedPlugin> {
  const discovered = await discoverPlugin(rootDir, options);
  const loaded = await loadInProcessPlugin(discovered);
  return startLoadedPlugin(loaded, hostFactory);
}

function resolvePluginDiscoveryTierPolicy(
  options: PluginDiscoveryOptions,
): PluginTierPolicy | undefined {
  const explicitPolicy = options.tierPolicy;
  const defaultsPolicy = defaultPluginTierPolicy(options);
  if (explicitPolicy === undefined) {
    return defaultsPolicy;
  }
  if (defaultsPolicy === undefined) {
    return explicitPolicy;
  }
  return {
    ...defaultsPolicy,
    ...explicitPolicy,
    tier: explicitPolicy.tier,
  };
}

function defaultPluginTierPolicy(options: PluginDiscoveryOptions): PluginTierPolicy | undefined {
  const explicitTier = options.tierPolicy?.tier;
  if (
    options.tierDefaults !== undefined &&
    (explicitTier === undefined || options.tierDefaults.tier === explicitTier)
  ) {
    return pluginTierPolicyFromSecurityDefaults(options.tierDefaults);
  }

  if (options.config !== undefined) {
    const defaults = resolveTierDefaults(options.config);
    if (explicitTier === undefined || defaults.tier === explicitTier) {
      return pluginTierPolicyFromSecurityDefaults(defaults);
    }
  }

  if (explicitTier !== undefined) {
    return pluginTierPolicyFromSecurityDefaults(securityTierDefaults[explicitTier]);
  }

  return undefined;
}

function resolveLoadedPluginDependencies(
  plugins: readonly LoadedPlugin[],
): readonly LoadedPlugin[] {
  return resolvePluginDependencies(plugins).map((plugin) => {
    const loaded = plugins.find((candidate) => candidate.manifest.id === plugin.manifest.id);
    if (loaded === undefined) {
      throw new Error(`Plugin ${plugin.manifest.id} was resolved but is not loaded`);
    }
    return loaded;
  });
}

function requiredDependencies(manifest: PluginManifest): readonly PluginDependencyDeclaration[] {
  return (manifest.dependencies ?? [])
    .map((dependency) => (typeof dependency === "string" ? { id: dependency } : dependency))
    .filter((dependency) => dependency.optional !== true);
}

function assertMinimumTier(manifest: PluginManifest, tier: SecurityTier): void {
  const minTier = manifest.tierRequirements?.minTier;
  if (minTier === undefined) {
    return;
  }
  if (tierRank(tier) < tierRank(minTier)) {
    throw new Error(`Plugin ${manifest.id} requires at least ${minTier} tier.`);
  }
}

function assertTierRestriction(manifest: PluginManifest, tier: SecurityTier): void {
  const restrictions = manifest.tierRequirements?.tierRestrictions as
    Partial<Record<SecurityTier, unknown>> | undefined;
  const restriction = restrictions?.[tier];
  if (restriction === undefined) {
    return;
  }
  if (restriction === "prohibited") {
    throw new Error(`Plugin ${manifest.id} is prohibited in ${tier} tier.`);
  }
  if (isJsonObject(restriction)) {
    if (
      restriction.prohibited === true ||
      restriction.allowed === false ||
      restriction.install === "prohibited"
    ) {
      throw new Error(`Plugin ${manifest.id} is prohibited in ${tier} tier.`);
    }
  }
}

function hasSignatureEvidence(manifest: PluginManifest): boolean {
  const signature = manifest.signature;
  return (
    typeof signature?.bundleDigest === "string" &&
    /^sha256:[0-9a-f]{64}$/u.test(signature.bundleDigest) &&
    ((typeof signature.sigstoreBundle === "string" && signature.sigstoreBundle.length > 0) ||
      isTrustedSignerIdentity(signature.signerIdentity))
  );
}

async function assertPluginBundleDigest(plugin: DiscoveredPlugin): Promise<void> {
  const expected = plugin.manifest.signature?.bundleDigest;
  if (typeof expected !== "string") {
    return;
  }
  const actual = await calculatePluginBundleDigest(plugin);
  if (actual !== expected) {
    throw new Error(
      `Plugin ${plugin.manifest.id} bundle digest mismatch: expected ${expected}, got ${actual}.`,
    );
  }
}

interface BundleFile {
  readonly relativePath: string;
  readonly absolutePath: string;
}

async function listBundleFiles(rootDir: string): Promise<readonly BundleFile[]> {
  const root = resolve(rootDir);
  const files: BundleFile[] = [];
  await collectBundleFiles(root, root, files);
  return files.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

async function collectBundleFiles(
  rootDir: string,
  currentDir: string,
  files: BundleFile[],
): Promise<void> {
  const entries = await readdir(currentDir, { withFileTypes: true });
  for (const entry of entries) {
    const absolutePath = join(currentDir, entry.name);
    if (entry.isDirectory()) {
      await collectBundleFiles(rootDir, absolutePath, files);
      continue;
    }
    if (!entry.isFile()) {
      throw new Error(`Plugin bundle contains unsupported filesystem entry: ${absolutePath}`);
    }
    files.push({
      absolutePath,
      relativePath: relative(rootDir, absolutePath).split("\\").join("/"),
    });
  }
}

function canonicalManifestWithoutSignature(manifest: PluginManifest): string {
  const { signature: _signature, ...unsignedManifest } = manifest;
  void _signature;
  return `${canonicalizeJson(unsignedManifest)}\n`;
}

function canonicalizeJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalizeJson).join(",")}]`;
  }
  if (isJsonObject(value)) {
    const entries = Object.entries(value).filter((entry) => entry[1] !== undefined);
    entries.sort(([left], [right]) => left.localeCompare(right));
    return `{${entries
      .map(([key, entryValue]) => `${JSON.stringify(key)}:${canonicalizeJson(entryValue)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function isTrustedSignerIdentity(value: unknown): boolean {
  if (typeof value !== "string") {
    return false;
  }
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(value)) {
    return true;
  }
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

function providesAiProvider(manifest: PluginManifest): boolean {
  return manifest.capabilities.provides.some((capability) => capability.startsWith("ai.provider."));
}

function isLocalOnlyAiPlugin(manifest: PluginManifest): boolean {
  const sovereignRestriction = manifest.tierRequirements?.tierRestrictions?.sovereign;
  if (isJsonObject(sovereignRestriction) && sovereignRestriction.localOnly === true) {
    return true;
  }

  const ai = manifest.ai;
  if (!isJsonObject(ai)) {
    return false;
  }
  if (ai.localOnly === true || ai.airGapped === true) {
    return true;
  }
  return Array.isArray(ai.localBaseUrls) && ai.localBaseUrls.some(isLocalAiBaseUrl);
}

function isLocalAiBaseUrl(value: unknown): boolean {
  if (typeof value !== "string") {
    return false;
  }
  try {
    const url = new URL(value);
    return (
      url.hostname === "localhost" ||
      url.hostname === "127.0.0.1" ||
      url.hostname === "::1" ||
      url.hostname.endsWith(".localhost")
    );
  } catch {
    return false;
  }
}

function hasExternalNetworkPermission(manifest: PluginManifest): boolean {
  return manifest.permissions["outbound-network"].length > 0;
}

function isAirgapCompatible(manifest: PluginManifest): boolean {
  const restriction = manifest.tierRequirements?.tierRestrictions?.sovereign;
  if (isJsonObject(restriction)) {
    return restriction.airgapCompatible === true || restriction.outboundNetwork === "none";
  }
  return false;
}

function tierRank(tier: SecurityTier): number {
  switch (tier) {
    case "personal":
      return 1;
    case "business":
      return 2;
    case "enterprise":
      return 3;
    case "sovereign":
      return 4;
  }
}

function parseManifestJson(text: string, manifestPath: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new SyntaxError(`Invalid plugin manifest JSON at ${manifestPath}: ${message}`, {
      cause: error,
    });
  }
}

function isPlatformPlugin(value: unknown): value is PlatformPlugin<PlatformHost> {
  return typeof value === "object" && value !== null;
}

function isTierSecurityDefaults(
  value: HelixConfig | TierSecurityDefaults,
): value is TierSecurityDefaults {
  return "pluginSignatureRequired" in value;
}

function isFileNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
