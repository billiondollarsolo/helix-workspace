import type { SecurityTier } from "@helix/sdk-types";
import { tierDefaults } from "./tier.js";

/**
 * Startup tier-hardening readiness check (PRD §9, P2-1).
 *
 * The tier engine declares the controls a tier requires but nothing verified,
 * at boot, that those controls are actually satisfiable. This module evaluates
 * the configured tier's required controls against the runtime environment:
 *
 *  - `satisfied` — the control is verifiably configured in-app.
 *  - `unsatisfied` — a required, in-app-enforceable control is missing; the
 *    server fails closed (Tier 2+ only — Tier 1/`personal` never blocks).
 *  - `unverifiable` — the control genuinely cannot be checked from inside the
 *    process (mTLS termination, disk encryption); it is surfaced as an explicit
 *    startup warning naming the control rather than silently passing.
 */

export type TierControlStatus = "satisfied" | "unsatisfied" | "unverifiable";

export interface TierControlResult {
  readonly control: string;
  readonly status: TierControlStatus;
  readonly detail: string;
}

export interface TierReadinessResult {
  readonly tier: SecurityTier;
  /** False when a required, in-app-enforceable control is unsatisfied. */
  readonly ok: boolean;
  readonly controls: readonly TierControlResult[];
  /** Controls whose status is `unverifiable` — surfaced as startup warnings. */
  readonly warnings: readonly TierControlResult[];
  /** Controls whose status is `unsatisfied` — cause a fail-closed boot. */
  readonly failures: readonly TierControlResult[];
}

function envFlag(env: NodeJS.ProcessEnv, name: string): boolean {
  const value = env[name]?.toLowerCase();
  return value === "1" || value === "true" || value === "yes";
}

function envSet(env: NodeJS.ProcessEnv, name: string): boolean {
  const value = env[name];
  return value !== undefined && value.trim().length > 0;
}

/**
 * Record a required control as either `satisfied` or `unsatisfied`.
 *
 * Every required control follows the same shape — a boolean probe plus the two
 * operator-facing details — so the branch lives here rather than being repeated
 * at each call site.
 */
function pushRequiredControl(
  controls: TierControlResult[],
  control: string,
  satisfied: boolean,
  satisfiedDetail: string,
  unsatisfiedDetail: string,
): void {
  if (satisfied) {
    controls.push({ control, status: "satisfied", detail: satisfiedDetail });
    return;
  }
  controls.push({ control, status: "unsatisfied", detail: unsatisfiedDetail });
}

/**
 * Evaluate whether the configured tier's required controls are satisfiable.
 *
 * Tier 1 (`personal`) returns `ok: true` with no controls — it intentionally
 * imposes no hardening requirements. Tier 2+ checks audit shipping, secrets
 * backing, and (Tier 3+) the SIEM destination; it also reports the controls
 * that cannot be verified in-app.
 */
export function evaluateTierReadiness(
  tier: SecurityTier,
  env: NodeJS.ProcessEnv = process.env,
): TierReadinessResult {
  if (tier === "personal") {
    return { tier, ok: true, controls: [], warnings: [], failures: [] };
  }

  const controls: TierControlResult[] = [];
  const defaults = tierDefaults[tier];

  // Tier 2+: audit log shipping to an immutable / SIEM destination must be
  // configured — the hash-chained Postgres log alone is not tamper-evident
  // off-host. Any one shipping destination satisfies the control.
  if (defaults.auditHashChain) {
    const shippingConfigured =
      envFlag(env, "AUDIT_IMMUTABLE_S3_ENABLED") ||
      envFlag(env, "AUDIT_SIEM_SYSLOG_ENABLED") ||
      envFlag(env, "AUDIT_WORM_POSTGRES_ENABLED");
    pushRequiredControl(
      controls,
      "audit-shipping",
      shippingConfigured,
      "An immutable / SIEM audit shipping destination is configured.",
      `Tier '${tier}' requires audit shipping. Enable one of ` +
        "AUDIT_IMMUTABLE_S3_ENABLED, AUDIT_SIEM_SYSLOG_ENABLED, or AUDIT_WORM_POSTGRES_ENABLED.",
    );
  }

  // Tier 3+ (`enterprise`, `sovereign`): secrets must be backed by Vault, not
  // plain environment variables. The Vault address is the in-app-checkable
  // signal that a real secrets backend is wired.
  if (defaults.secrets === "vault") {
    const vaultConfigured = envSet(env, "VAULT_ADDR") || envSet(env, "HELIX_VAULT_ADDR");
    pushRequiredControl(
      controls,
      "secrets-vault",
      vaultConfigured,
      "A Vault address is configured for the secrets backend.",
      `Tier '${tier}' requires Vault-backed secrets. Set VAULT_ADDR (or HELIX_VAULT_ADDR).`,
    );
  }

  // Tier 3+: a SIEM destination is mandated. This is an explicit control
  // distinct from generic audit shipping above.
  if (defaults.auditDestinations.includes("siem")) {
    pushRequiredControl(
      controls,
      "audit-siem",
      envFlag(env, "AUDIT_SIEM_SYSLOG_ENABLED"),
      "A SIEM syslog audit destination is configured.",
      `Tier '${tier}' mandates a SIEM destination. Enable AUDIT_SIEM_SYSLOG_ENABLED.`,
    );
  }

  // Controls that genuinely cannot be verified from inside the process — the
  // app cannot prove the transit encryption or disk encryption posture, so it
  // names the control as unverified rather than silently passing.
  if (defaults.internalTransit !== "plaintext") {
    controls.push({
      control: "internal-mtls",
      status: "unverifiable",
      detail:
        `Tier '${tier}' requires internal mTLS (${defaults.internalTransit}). This is enforced ` +
        "by the service mesh / proxy and cannot be verified in-app — confirm out of band.",
    });
  }
  controls.push({
    control: "encryption-at-rest",
    status: "unverifiable",
    detail:
      `Tier '${tier}' requires encryption at rest (LUKS/TDE/SSE). This is a host / storage ` +
      "control and cannot be verified in-app — confirm out of band.",
  });

  const failures = controls.filter((control) => control.status === "unsatisfied");
  const warnings = controls.filter((control) => control.status === "unverifiable");
  return {
    tier,
    ok: failures.length === 0,
    controls,
    warnings,
    failures,
  };
}
