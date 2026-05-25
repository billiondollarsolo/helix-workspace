import type { HelixConfig, HelixMode } from "@helix/sdk-types";

export const DEFAULT_HELIX_MODE: HelixMode = "single-tenant";

export type HelixModeInput = HelixMode | Pick<HelixConfig, "mode"> | null | undefined;

export function resolveHelixMode(input?: HelixModeInput): HelixMode {
  if (typeof input === "string") {
    return input;
  }
  return input?.mode ?? DEFAULT_HELIX_MODE;
}

export function isSaas(input?: HelixModeInput): boolean {
  return resolveHelixMode(input) === "multi-tenant-saas";
}

export function isSingleTenant(input?: HelixModeInput): boolean {
  return resolveHelixMode(input) === "single-tenant";
}
