import { queryOptions } from "@tanstack/react-query";
import { authenticatedFetch } from "@/lib/auth";
import { responseError } from "@/lib/tool-call";

export interface BackupPolicy {
  revision: number;
  enabled: boolean;
  intervalMinutes: number;
  retentionDays: number;
  destinationRef: string;
}
interface BackupReceipt {
  backupId: string;
  createdAt: string;
  verifiedAt: string | null;
  restoredAt: string | null;
  coverage: string[];
  appVersion: string;
  schemaVersion: string;
  keyCustodyRef: string;
  artifactDigest: string;
  manifestDigest: string;
}
export interface BackupTarget {
  id: string;
  applicationId: string | null;
  origin: string;
  status: string;
  policy: BackupPolicy;
  pending: boolean;
  error: string | null;
  restoreEnabled: boolean;
  observedAt: string | null;
  observation: {
    scheduler: "worker" | "external";
    owner: "local" | "workspace";
    capabilities: string[];
    minimumRetentionDays: number;
    destinations: string[];
    requiredCoverage: string[];
    applicationHealthy: boolean | null;
    alerts: string[];
    jobs: {
      request: { id: string; kind: string };
      status: string;
      receipt: BackupReceipt | null;
    }[];
  } | null;
}
export interface BackupJob {
  id: string;
  targetId: string;
  status: string;
  request: { kind: string; backupId?: string };
  error: string | null;
  canApprove: boolean;
}
export async function familyBackupMutation<T>(
  path: string,
  method: string,
  body?: unknown,
): Promise<T> {
  const response = await authenticatedFetch(`/api/admin/${path}`, {
    method,
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok)
    throw responseError(
      response,
      await response.json().catch(() => null),
      "Federation recovery",
      "Recovery operation failed. Review its status and retry.",
    );
  return response.json() as Promise<T>;
}
export function familyBackupsQueryOptions() {
  return queryOptions({
    queryKey: ["admin", "family-backups"],
    retry: false,
    refetchInterval: 15000,
    queryFn: async () => {
      const response = await authenticatedFetch("/api/admin/family-backups");
      if (response.status === 404) return { enabled: false, targets: [] as BackupTarget[] };
      if (!response.ok)
        throw responseError(
          response,
          await response.json().catch(() => null),
          "Federation recovery",
          "Recovery status could not be loaded.",
        );
      return { ...((await response.json()) as { targets: BackupTarget[] }), enabled: true };
    },
  });
}
export function familyBackupJobsQueryOptions() {
  return queryOptions({
    queryKey: ["admin", "family-backup-jobs"],
    retry: false,
    refetchInterval: 15000,
    queryFn: async () => {
      const response = await authenticatedFetch("/api/admin/family-backup-jobs");
      if (response.status === 404) return { jobs: [] as BackupJob[] };
      if (!response.ok)
        throw responseError(
          response,
          await response.json().catch(() => null),
          "Federation recovery",
          "Recovery jobs could not be loaded.",
        );
      return response.json() as Promise<{ jobs: BackupJob[] }>;
    },
  });
}
