import { readFile } from "node:fs/promises";
import { parse as parseYaml } from "yaml";
import type {
  EventBus,
  HelixConfig,
  HelixMode,
  JsonObject,
  JsonValue,
  SecurityTier,
} from "@helix/sdk-types";
import { isJsonObject } from "@helix/sdk-types";

type ModuleConfig = NonNullable<HelixConfig["modules"]>[string];
type AiConfig = NonNullable<HelixConfig["ai"]>;
type ObservabilityConfig = NonNullable<HelixConfig["observability"]>;

export interface ConfigSource {
  load(): Promise<PartialHelixConfig>;
}

export interface YamlParser {
  parse(text: string): unknown;
}

export interface PostgresConfigOverrideStore {
  loadOverrides(): Promise<PartialHelixConfig>;
}

export interface ConfigHotReloadOptions {
  readonly events: EventBus;
  readonly reload: () => Promise<HelixConfig>;
  readonly onReload: (config: HelixConfig) => Promise<void> | void;
  readonly subject?: string;
}

export interface PartialHelixConfig {
  readonly mode?: HelixMode;
  readonly security?: {
    readonly tier?: SecurityTier;
    readonly overrides?: HelixConfig["security"]["overrides"];
  };
  readonly modules?: Record<string, ModuleConfig>;
  readonly ai?: AiConfig;
  readonly observability?: ObservabilityConfig;
  readonly plugins?: Record<string, JsonObject>;
  readonly platform?: JsonObject;
}

export class EnvConfigSource implements ConfigSource {
  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {}

  async load(): Promise<PartialHelixConfig> {
    const envConfig = loadConfigFromEnvironment(this.env);
    const tier = parseTier(this.env.HELIX_SECURITY_TIER ?? this.env.HELIX_TIER);
    const mode = parseOptionalHelixMode(this.env.HELIX_MODE, "HELIX_MODE");
    return mergeConfig(
      envConfig,
      mergeConfig(
        tier === undefined ? {} : { security: { tier } },
        mode === undefined ? {} : { mode },
      ),
    );
  }
}

export class StaticConfigSource implements ConfigSource {
  constructor(private readonly config: PartialHelixConfig) {}

  async load(): Promise<PartialHelixConfig> {
    return this.config;
  }
}

export class YamlConfigSource implements ConfigSource {
  constructor(
    private readonly filePath: string,
    private readonly parser: YamlParser = simpleYamlParser,
  ) {}

  async load(): Promise<PartialHelixConfig> {
    const text = await readFile(this.filePath, "utf8");
    return normalizePartialConfig(this.parser.parse(text), this.filePath);
  }
}

export class PostgresOverrideConfigSource implements ConfigSource {
  constructor(private readonly store: PostgresConfigOverrideStore) {}

  async load(): Promise<PartialHelixConfig> {
    return this.store.loadOverrides();
  }
}

export async function loadHelixConfig(sources: readonly ConfigSource[]): Promise<HelixConfig> {
  let merged: PartialHelixConfig = {};

  for (const source of sources) {
    merged = mergeConfig(merged, await source.load());
  }

  return {
    mode: merged.mode ?? "single-tenant",
    security: {
      tier: merged.security?.tier ?? "personal",
      ...(merged.security?.overrides === undefined ? {} : { overrides: merged.security.overrides }),
    },
    ...(merged.modules === undefined ? {} : { modules: merged.modules }),
    ...(merged.ai === undefined ? {} : { ai: merged.ai }),
    ...(merged.observability === undefined ? {} : { observability: merged.observability }),
    ...(merged.plugins === undefined ? {} : { plugins: merged.plugins }),
    ...(merged.platform === undefined ? {} : { platform: merged.platform }),
  };
}

export async function subscribeToConfigHotReload(
  options: ConfigHotReloadOptions,
): Promise<() => Promise<void> | void> {
  return options.events.subscribe(options.subject ?? "helix.config.changed", async () => {
    const config = await options.reload();
    await options.onReload(config);
  });
}

export function mergeConfig(
  left: PartialHelixConfig,
  right: PartialHelixConfig,
): PartialHelixConfig {
  const tier = right.security?.tier ?? left.security?.tier;
  const mode = right.mode ?? left.mode;
  const modules = mergeModuleConfig(left.modules, right.modules);
  const ai = mergeTypedJsonObject(left.ai, right.ai);
  const observability = mergeTypedJsonObject(left.observability, right.observability);
  const platform =
    left.platform === undefined && right.platform === undefined
      ? undefined
      : mergeJsonObjects(left.platform, right.platform);
  return {
    security: {
      ...(tier === undefined ? {} : { tier }),
      overrides: {
        ...(left.security?.overrides ?? {}),
        ...(right.security?.overrides ?? {}),
      },
    },
    ...(mode === undefined ? {} : { mode }),
    plugins: {
      ...mergePluginConfig(left.plugins, right.plugins),
    },
    ...(modules === undefined ? {} : { modules }),
    ...(ai === undefined ? {} : { ai }),
    ...(observability === undefined ? {} : { observability }),
    ...(platform === undefined ? {} : { platform }),
  };
}

export function loadConfigFromEnvironment(env: NodeJS.ProcessEnv): PartialHelixConfig {
  const configJson = env.HELIX_CONFIG_JSON;
  const parsedJson =
    configJson === undefined || configJson.length === 0
      ? {}
      : normalizePartialConfig(JSON.parse(configJson), "HELIX_CONFIG_JSON");
  let merged = parsedJson;

  for (const [key, value] of Object.entries(env)) {
    if (!key.startsWith("HELIX_CONFIG__") || value === undefined) {
      continue;
    }

    const path = key
      .slice("HELIX_CONFIG__".length)
      .split("__")
      .filter((part) => part.length > 0)
      .map((part) => part.toLowerCase());
    if (path.length === 0) {
      continue;
    }

    merged = mergeConfig(
      merged,
      normalizePartialConfig(setNestedValue(path, parseEnvValue(value)), key),
    );
  }

  return merged;
}

/**
 * Real YAML parser backed by the `yaml` library. Replaces the previous
 * hand-rolled parser (P2-4): the library handles flow collections, block
 * scalars, anchors/aliases, multi-line strings, and the full YAML 1.2 grammar
 * that the brittle line-based parser silently mishandled. `null` documents
 * (an empty file) normalize to an empty object so callers always receive a
 * config object.
 */
export const simpleYamlParser: YamlParser = {
  parse(text: string): unknown {
    const parsed: unknown = parseYaml(text);
    return parsed ?? {};
  },
};

function parseTier(value: string | undefined): SecurityTier | undefined {
  if (
    value === "personal" ||
    value === "business" ||
    value === "enterprise" ||
    value === "sovereign"
  ) {
    return value;
  }

  return undefined;
}

function parseHelixMode(value: string | undefined): HelixMode | undefined {
  if (value === "single-tenant" || value === "multi-tenant-saas") {
    return value;
  }
  return undefined;
}

function parseOptionalHelixMode(value: string | undefined, label: string): HelixMode | undefined {
  if (value === undefined || value.length === 0) {
    return undefined;
  }
  const mode = parseHelixMode(value);
  if (mode === undefined) {
    throw new TypeError(`${label} must be single-tenant or multi-tenant-saas`);
  }
  return mode;
}

function normalizePartialConfig(value: unknown, label: string): PartialHelixConfig {
  if (!isJsonObject(value)) {
    throw new TypeError(`${label} must contain a config object`);
  }

  const security = value.security;
  const mode = value.mode;
  const modules = value.modules;
  const ai = value.ai;
  const observability = value.observability;
  const plugins = value.plugins;
  const platform = value.platform;
  const config: PartialHelixConfig = {};

  if (mode !== undefined) {
    const parsedMode = parseHelixMode(typeof mode === "string" ? mode : undefined);
    if (parsedMode === undefined) {
      throw new TypeError(`${label}.mode must be single-tenant or multi-tenant-saas`);
    }
    Object.assign(config, { mode: parsedMode });
  }

  if (security !== undefined) {
    if (!isJsonObject(security)) {
      throw new TypeError(`${label}.security must be an object`);
    }

    const tier = parseTier(typeof security.tier === "string" ? security.tier : undefined);
    if (security.tier !== undefined && tier === undefined) {
      throw new TypeError(
        `${label}.security.tier must be personal, business, enterprise, or sovereign`,
      );
    }

    const overrides = security.overrides;
    const normalizedSecurity: NonNullable<PartialHelixConfig["security"]> = {
      ...(tier === undefined ? {} : { tier }),
      ...(overrides === undefined ? {} : { overrides: normalizeTierOverrides(overrides, label) }),
    };
    Object.assign(config, { security: normalizedSecurity });
  }

  if (plugins !== undefined) {
    Object.assign(config, { plugins: normalizeJsonObject(plugins, `${label}.plugins`) });
  }

  if (modules !== undefined) {
    Object.assign(config, { modules: normalizeModuleConfig(modules, `${label}.modules`) });
  }

  if (ai !== undefined) {
    Object.assign(config, { ai: normalizeAiConfig(ai, `${label}.ai`) });
  }

  if (observability !== undefined) {
    Object.assign(config, {
      observability: normalizeObservabilityConfig(observability, `${label}.observability`),
    });
  }

  if (platform !== undefined) {
    Object.assign(config, { platform: normalizeJsonObject(platform, `${label}.platform`) });
  }

  return config;
}

function normalizeTierOverrides(
  value: unknown,
  label: string,
): HelixConfig["security"]["overrides"] {
  return normalizeJsonObject(value, `${label}.security.overrides`);
}

function normalizeJsonObject(value: unknown, label: string): JsonObject {
  if (!isJsonObject(value) || !isJsonValue(value)) {
    throw new TypeError(`${label} must be a JSON object`);
  }
  return value;
}

function normalizeModuleConfig(value: unknown, label: string): Record<string, ModuleConfig> {
  const object = normalizeJsonObject(value, label);
  const result: Record<string, ModuleConfig> = {};
  for (const [key, entry] of Object.entries(object)) {
    result[key] = normalizeJsonObject(entry, `${label}.${key}`);
  }
  return result;
}

function normalizeAiConfig(value: unknown, label: string): AiConfig {
  return normalizeJsonObject(value, label);
}

function normalizeObservabilityConfig(value: unknown, label: string): ObservabilityConfig {
  return normalizeJsonObject(value, label);
}

function mergePluginConfig(
  left: Record<string, JsonObject> | undefined,
  right: Record<string, JsonObject> | undefined,
): Record<string, JsonObject> {
  const result: Record<string, JsonObject> = { ...(left ?? {}) };
  for (const [pluginId, config] of Object.entries(right ?? {})) {
    result[pluginId] = mergeJsonObjects(result[pluginId], config);
  }
  return result;
}

function mergeModuleConfig(
  left: Record<string, ModuleConfig> | undefined,
  right: Record<string, ModuleConfig> | undefined,
): Record<string, ModuleConfig> | undefined {
  if (left === undefined && right === undefined) {
    return undefined;
  }
  const result: Record<string, ModuleConfig> = { ...(left ?? {}) };
  for (const [moduleId, config] of Object.entries(right ?? {})) {
    const merged = mergeTypedJsonObject(result[moduleId], config);
    if (merged !== undefined) {
      result[moduleId] = merged;
    }
  }
  return result;
}

function mergeTypedJsonObject<T extends object>(
  left: T | undefined,
  right: T | undefined,
): T | undefined {
  if (left === undefined && right === undefined) {
    return undefined;
  }
  return mergeJsonObjects(
    left as JsonObject | undefined,
    right as JsonObject | undefined,
  ) as unknown as T;
}

function mergeJsonObjects(left: JsonObject | undefined, right: JsonObject | undefined): JsonObject {
  const result: Record<string, JsonValue> = { ...(left ?? {}) };
  for (const [key, value] of Object.entries(right ?? {})) {
    const existing = result[key];
    result[key] =
      isJsonObject(existing) && isJsonObject(value) ? mergeJsonObjects(existing, value) : value;
  }
  return result;
}

function isJsonValue(value: unknown): value is JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return true;
  }

  if (Array.isArray(value)) {
    return value.every(isJsonValue);
  }

  if (isJsonObject(value)) {
    return Object.values(value).every(isJsonValue);
  }

  return false;
}

function setNestedValue(path: readonly string[], value: JsonValue): PartialHelixConfig {
  const root: Record<string, JsonValue> = {};
  let cursor: Record<string, JsonValue> = root;

  for (const segment of path.slice(0, -1)) {
    const next: Record<string, JsonValue> = {};
    cursor[segment] = next;
    cursor = next;
  }

  const leaf = path.at(-1);
  if (leaf !== undefined) {
    cursor[leaf] = value;
  }

  return root;
}

function parseEnvValue(value: string): JsonValue {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (isJsonValue(parsed)) {
      return parsed;
    }
  } catch {
    // Fall through to scalar parsing.
  }

  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }
  if (value === "null") {
    return null;
  }

  const numericValue = Number(value);
  return Number.isFinite(numericValue) && value.trim() !== "" ? numericValue : value;
}
