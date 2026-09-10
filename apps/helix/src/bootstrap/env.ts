import type { SecurityTier } from "@helix/sdk-types";
import { type AgentLimitBudget } from "../platform/limits/index.js";
import { envValueFlag } from "../platform/util/env.js";

export function agentLimitBudgetOverrideFromEnv(
  env: NodeJS.ProcessEnv,
): Partial<AgentLimitBudget> | undefined {
  const override: AgentLimitBudgetOverride = {};
  assignLimitOverride(override, "requestsPerMinute", env.HELIX_AGENT_LIMIT_REQUESTS_PER_MINUTE);
  assignLimitOverride(override, "requestsPerDay", env.HELIX_AGENT_LIMIT_REQUESTS_PER_DAY);
  assignLimitOverride(
    override,
    "costPerDayUsdMicros",
    env.HELIX_AGENT_LIMIT_COST_PER_DAY_USD_MICROS,
  );
  if (env.HELIX_AGENT_LIMIT_COST_WARNING_RATIO !== undefined) {
    const ratio = Number(env.HELIX_AGENT_LIMIT_COST_WARNING_RATIO);
    if (!Number.isFinite(ratio) || ratio <= 0 || ratio > 1) {
      throw new Error("HELIX_AGENT_LIMIT_COST_WARNING_RATIO must be greater than 0 and at most 1");
    }
    override.costWarningThresholdRatio = ratio;
  }
  return Object.keys(override).length === 0 ? undefined : override;
}

function assignLimitOverride(
  override: AgentLimitBudgetOverride,
  key: "requestsPerMinute" | "requestsPerDay" | "costPerDayUsdMicros",
  rawValue: string | undefined,
): void {
  if (rawValue === undefined) {
    return;
  }
  const value = rawValue.trim().toLowerCase();
  if (value === "null" || value === "none" || value === "unlimited") {
    override[key] = null;
    return;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || String(parsed) !== value) {
    throw new Error(
      `HELIX_AGENT_LIMIT override for ${key} must be a non-negative integer or unlimited`,
    );
  }
  override[key] = parsed;
}

export function parseS3ServerSideEncryption(value: string): "AES256" | "aws:kms" {
  if (value !== "AES256" && value !== "aws:kms") {
    throw new TypeError("RUSTFS_SERVER_SIDE_ENCRYPTION must be AES256 or aws:kms");
  }
  return value;
}

export function tenantRootHostFromPublicUrl(value: string | undefined): readonly string[] {
  if (value === undefined) {
    return [];
  }
  try {
    return [new URL(value).hostname];
  } catch {
    return [];
  }
}

export function envFlag(name: string, defaultValue: boolean): boolean {
  // Dynamic flag lookup for keys not all present on Env (e.g. worker toggles).
  // Prefer env() field access for known operational keys; keep process.env only
  // for open-ended HELIX_* feature switches until they are added to the schema.
  // eslint-disable-next-line helix/no-raw-process-env -- dynamic feature-flag names
  const value = process.env[name];
  if (value === undefined) {
    return defaultValue;
  }
  return envValueFlag(value, defaultValue);
}

/**
 * Resolves the per-tier confirmation timeout (PRD §9.9). The default window is
 * 10 minutes; higher-assurance tiers expire stale approvals faster so they do
 * not linger. `CONFIRMATION_TIMEOUT_MS` overrides the resolved value.
 */
export function resolveConfirmationTimeoutMs(tier: SecurityTier, env: NodeJS.ProcessEnv): number {
  const override = env.CONFIRMATION_TIMEOUT_MS;
  if (override !== undefined && override.trim().length > 0) {
    const parsed = Number.parseInt(override, 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }
  const minute = 60000;
  switch (tier) {
    case "personal":
      return 10 * minute;
    case "business":
      return 10 * minute;
    case "enterprise":
      return 5 * minute;
    case "sovereign":
      return 3 * minute;
  }
}

type AgentLimitBudgetOverride = {
  requestsPerMinute?: number | null;
  requestsPerDay?: number | null;
  costPerDayUsdMicros?: number | null;
  costWarningThresholdRatio?: number;
};
