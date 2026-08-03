import { queryOptions } from "@tanstack/react-query";
import { z } from "zod";
import { authenticatedFetch, type AuthFetch } from "@/lib/auth";
import { callTool } from "@/lib/tool-call";
import { ADMIN_QUERY_DEFAULTS } from "@/features/admin/console/request-budget";

/**
 * Admin Console — Drive storage quota usage + lifecycle policy (D11).
 *
 * Tools:
 *  - `drive.quota.usage`
 *  - `drive.lifecycle.get` / `drive.lifecycle.set`
 *
 * Storage *limit* remains owned by Workspace settings (`storage_bytes_limit`);
 * this surface shows live usage and trash/orphan lifecycle controls.
 */

const uuidSchema = z.string().uuid();

export const DRIVE_PLATFORM_DEFAULT_TRASH_RETENTION_DAYS = 30;
export const DRIVE_PLATFORM_DEFAULT_ORPHAN_GRACE_HOURS = 24;

export const driveQuotaUsageSchema = z.object({
  orgId: uuidSchema,
  usedBytes: z.number().int().nonnegative(),
  limitBytes: z.number().int().nonnegative().nullable(),
  unlimited: z.boolean(),
  percentUsed: z.number().nonnegative().nullable(),
});
export type DriveQuotaUsage = z.infer<typeof driveQuotaUsageSchema>;

export const driveLifecyclePolicySchema = z.object({
  orgId: uuidSchema,
  trashRetentionDays: z.number().int().min(1).max(3650),
  orphanGraceHours: z.number().int().min(1).max(720),
  updatedByActorId: z.string().uuid().nullable(),
  updatedAt: z.string().nullable(),
  configured: z.boolean(),
});
export type DriveLifecyclePolicy = z.infer<typeof driveLifecyclePolicySchema>;

export interface DriveLifecycleFormInput {
  readonly trashRetentionDays: string;
  readonly orphanGraceHours: string;
}

export type MappedLifecycleInput =
  | {
      readonly trashRetentionDays: number;
      readonly orphanGraceHours: number;
    }
  | string;

export function mapLifecycleFormToToolInput(form: DriveLifecycleFormInput): MappedLifecycleInput {
  const trashRetentionDays = parsePositiveInt(
    form.trashRetentionDays,
    "Trash retention (days)",
    1,
    3650,
  );
  if (typeof trashRetentionDays === "string") return trashRetentionDays;
  const orphanGraceHours = parsePositiveInt(form.orphanGraceHours, "Orphan grace (hours)", 1, 720);
  if (typeof orphanGraceHours === "string") return orphanGraceHours;
  return { trashRetentionDays, orphanGraceHours };
}

export function lifecycleFormFromPolicy(policy: DriveLifecyclePolicy): DriveLifecycleFormInput {
  return {
    trashRetentionDays: String(policy.trashRetentionDays),
    orphanGraceHours: String(policy.orphanGraceHours),
  };
}

export function formatQuotaSummary(usage: DriveQuotaUsage): string {
  const used = formatBytes(usage.usedBytes);
  if (usage.unlimited || usage.limitBytes === null) {
    return `${used} used · unlimited plan limit`;
  }
  const limit = formatBytes(usage.limitBytes);
  const pct = usage.percentUsed === null ? "—" : `${String(usage.percentUsed)}%`;
  return `${used} used of ${limit} (${pct})`;
}

export function formatLifecycleSummary(policy: DriveLifecyclePolicy): string {
  const source = policy.configured
    ? `configured${policy.updatedAt === null ? "" : ` · updated ${policy.updatedAt}`}`
    : "platform default (no org policy row yet)";
  return `${String(policy.trashRetentionDays)} day trash retention · ${String(policy.orphanGraceHours)}h orphan grace · ${source}`;
}

export function describeDriveAdminUnavailable(error: Error): string {
  const message = error.message.toLowerCase();
  if (
    message.includes("403") ||
    message.includes("401") ||
    message.includes("forbidden") ||
    message.includes("permission") ||
    message.includes("denied")
  ) {
    return "Drive operator controls are unavailable: your account is missing the admin.drive scope.";
  }
  if (message.includes("404") || message.includes("not found") || message.includes("not support")) {
    return "Drive operator controls are unavailable: Drive is not enabled or lifecycle tools are not registered in this deployment.";
  }
  return `Drive operator controls are unavailable: ${error.message}`;
}

export const driveAdminQueryKeys = {
  quota: () => ["admin", "drive", "quota"] as const,
  lifecycle: () => ["admin", "drive", "lifecycle"] as const,
};

export function driveQuotaQueryOptions(fetchImpl: AuthFetch = authenticatedFetch) {
  return queryOptions({
    ...ADMIN_QUERY_DEFAULTS,
    queryKey: driveAdminQueryKeys.quota(),
    queryFn: () => getDriveQuotaUsage(fetchImpl),
    staleTime: 15_000,
  });
}

export function driveLifecycleQueryOptions(fetchImpl: AuthFetch = authenticatedFetch) {
  return queryOptions({
    ...ADMIN_QUERY_DEFAULTS,
    queryKey: driveAdminQueryKeys.lifecycle(),
    queryFn: () => getDriveLifecyclePolicy(fetchImpl),
    staleTime: 15_000,
  });
}

export async function getDriveQuotaUsage(
  fetchImpl: AuthFetch = authenticatedFetch,
): Promise<DriveQuotaUsage> {
  const raw = await callTool<unknown>("drive.quota.usage", {}, { fetchImpl, autoApprove: false });
  return parseToolOutput(raw, driveQuotaUsageSchema, "read Drive storage quota usage");
}

export async function getDriveLifecyclePolicy(
  fetchImpl: AuthFetch = authenticatedFetch,
): Promise<DriveLifecyclePolicy> {
  const raw = await callTool<unknown>("drive.lifecycle.get", {}, { fetchImpl, autoApprove: false });
  return parseToolOutput(raw, driveLifecyclePolicySchema, "read Drive lifecycle policy");
}

export async function setDriveLifecyclePolicy(
  input: Exclude<MappedLifecycleInput, string>,
  fetchImpl: AuthFetch = authenticatedFetch,
): Promise<DriveLifecyclePolicy> {
  const raw = await callTool<unknown>("drive.lifecycle.set", input, { fetchImpl });
  return parseToolOutput(raw, driveLifecyclePolicySchema, "set Drive lifecycle policy");
}

function parseToolOutput<T>(raw: unknown, schema: z.ZodType<T>, action: string): T {
  const parsed = schema.safeParse(raw);
  if (parsed.success) {
    return parsed.data;
  }
  throw new Error(`Failed to ${action}: malformed response.`);
}

function parsePositiveInt(value: string, label: string, min: number, max: number): number | string {
  const trimmed = value.trim();
  if (trimmed === "") {
    return `${label} is required.`;
  }
  const parsed = Number(trimmed);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    return `${label} must be an integer from ${String(min)} to ${String(max)}.`;
  }
  return parsed;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`;
  const units = ["KB", "MB", "GB", "TB"] as const;
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const rounded = value >= 10 ? Math.round(value) : Math.round(value * 10) / 10;
  return `${String(rounded)} ${units[unit]}`;
}
