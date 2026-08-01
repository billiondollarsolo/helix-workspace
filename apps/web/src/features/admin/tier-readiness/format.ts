/* Security tier readiness — value formatting for requirement facts. */

import { tiers } from "@/features/admin/tier-readiness/catalog";
import type { BackendReadinessStatus, TierId } from "@/features/admin/tier-readiness/types";

export function backendStatusText(status: BackendReadinessStatus): string {
  if (status === "not_required") {
    return "Not required";
  }
  if (status === "ready") {
    return "Ready";
  }
  if (status === "missing") {
    return "Missing";
  }
  if (status === "degraded") {
    return "Degraded";
  }
  return "Unknown";
}

export function titleForTier(tierId: TierId): string {
  return tiers.find((tier) => tier.id === tierId)?.title ?? tierId;
}

export function formatKey(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/gu, "$1 $2")
    .replace(/[-_]+/gu, " ")
    .replace(/\b\w/gu, (match) => match.toUpperCase());
}

export function formatValue(value: unknown): string {
  if (typeof value === "boolean") {
    return value ? "Yes" : "No";
  }
  if (Array.isArray(value)) {
    return value.map(formatValue).join(", ");
  }
  if (value === null || value === undefined) {
    return "None";
  }
  if (typeof value === "string") {
    return formatToken(value);
  }
  if (typeof value === "number") {
    return String(value);
  }
  return JSON.stringify(value);
}

export function formatList(values: readonly string[]): string {
  return values.length === 0 ? "None" : values.join(", ");
}

export function formatUsdLimit(value: number | undefined): string {
  if (value === undefined) {
    return "Unlimited";
  }
  return new Intl.NumberFormat(undefined, {
    currency: "USD",
    maximumFractionDigits: 2,
    style: "currency",
  }).format(value);
}

export function formatToken(value: string): string {
  if (/^\d{4}-\d{2}-\d{2}T/u.test(value) || value.includes("://")) {
    return value;
  }
  const normalized = value
    .replace(/[-_]+/gu, " ")
    .replace(/\b\w/gu, (match) => match.toUpperCase());
  return normalized
    .replace(/\bSiem\b/gu, "SIEM")
    .replace(/\bMfa\b/gu, "MFA")
    .replace(/\bSpire\b/gu, "SPIRE");
}
