import type { FeatureFlagEvaluationContext, FeatureFlagProvider } from "@helix/sdk";
import type { TenantConfig } from "@helix/sdk-types";

export type TenantConfigLoader = (input: {
  readonly orgId: string;
  readonly context: FeatureFlagEvaluationContext;
}) => Promise<TenantConfig | null>;

export interface TenantFeatureFlagContext extends FeatureFlagEvaluationContext {
  readonly tenantConfig?: TenantConfig;
}

export interface TenantConfigFeatureFlagProviderOptions {
  readonly loadTenantConfig?: TenantConfigLoader;
  readonly environment?: string;
}

export class TenantConfigFeatureFlagProvider implements FeatureFlagProvider {
  constructor(private readonly options: TenantConfigFeatureFlagProviderOptions = {}) {}

  get<T>(key: string, defaultValue: T, context?: TenantFeatureFlagContext): T {
    return readTenantFlag(context?.tenantConfig, key, defaultValue);
  }

  async getAsync<T>(
    key: string,
    defaultValue: T,
    context: TenantFeatureFlagContext = {},
  ): Promise<T> {
    const environment = context.environment ?? this.options.environment;
    const tenantConfig =
      context.tenantConfig ??
      (context.orgId === undefined
        ? null
        : await this.options.loadTenantConfig?.({
            orgId: context.orgId,
            context: environment === undefined ? context : { ...context, environment },
          }));
    return readTenantFlag(tenantConfig, key, defaultValue);
  }
}

export function readTenantFlag<T>(
  tenantConfig: TenantConfig | null | undefined,
  key: string,
  defaultValue: T,
): T {
  return coerceFlagValue(tenantConfig?.features[key], defaultValue);
}

function coerceFlagValue<T>(value: unknown, defaultValue: T): T {
  if (value === undefined) {
    return defaultValue;
  }
  if (defaultValue === null) {
    return (value ?? defaultValue) as T;
  }
  if (Array.isArray(defaultValue)) {
    return Array.isArray(value) ? (value as T) : defaultValue;
  }
  if (typeof defaultValue === "object") {
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as T)
      : defaultValue;
  }
  return typeof value === typeof defaultValue ? (value as T) : defaultValue;
}
