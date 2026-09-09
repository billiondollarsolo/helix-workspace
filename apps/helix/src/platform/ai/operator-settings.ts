/**
 * Runtime overlay for operator-configured AI settings (Admin → AI providers).
 * Env remains bootstrap; platform-config overrides win when set.
 */
import type { HelixConfig } from "@helix/sdk";
import { operatorAiEnvFromConfig } from "../config/admin.js";

let overlay: Readonly<Record<string, string | undefined>> = {};

export function applyOperatorAiFromHelixConfig(config: HelixConfig): void {
  overlay = operatorAiEnvFromConfig(config);
}

export function getOperatorAiEnvOverlay(): Readonly<Record<string, string | undefined>> {
  return overlay;
}

/** Merge process env with admin operator overrides (overlay wins). */
export function resolveAiEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
): Readonly<Record<string, string | undefined>> {
  return { ...env, ...overlay };
}
