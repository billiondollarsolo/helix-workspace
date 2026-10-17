import { z } from "zod";

export const familyBackupProtocol = "helix.family.backup.v1";
const id = z.string().uuid();
const time = z.string().datetime();
export const backupCoverage = z.enum(["database", "files", "objects", "configuration"]);
export const familyBackupPolicy = z
  .object({
    revision: z.number().int().safe().nonnegative(),
    enabled: z.boolean(),
    intervalMinutes: z.number().int().min(5).max(10080),
    retentionDays: z.number().int().min(1).max(3650),
    destinationRef: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/u),
  })
  .strict();
export type FamilyBackupPolicy = z.infer<typeof familyBackupPolicy>;
export const familyBackupBinding = z
  .object({
    application: z.enum(["bot", "workspace"]),
    installationId: id,
    tenantId: id,
    orgId: id,
    connectionId: id.nullable(),
  })
  .strict();
export const familyBackupRequest = z
  .object({
    id,
    kind: z.enum(["backup", "verify", "restore"]),
    backupId: id.optional(),
    targetDatabase: z
      .string()
      .regex(/^helix_restore_[a-z0-9_]{1,49}$/u)
      .optional(),
    targetObjectBucket: z
      .string()
      .max(63)
      .regex(/^helix-restore-[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/u)
      .refine((value) => !value.includes(".."), "Use a valid isolated object bucket.")
      .optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.kind !== "backup" && !value.backupId)
      context.addIssue({ code: "custom", message: "Choose a completed backup." });
    if (value.kind === "restore" && !value.targetDatabase)
      context.addIssue({
        code: "custom",
        message: "Choose a new isolated database target.",
      });
    if (value.kind !== "restore" && (value.targetDatabase || value.targetObjectBucket))
      context.addIssue({ code: "custom", message: "Only restore jobs accept isolated targets." });
  });
export type FamilyBackupRequest = z.infer<typeof familyBackupRequest>;
export const familyBackupReceipt = z
  .object({
    backupId: id,
    createdAt: time,
    artifactDigest: z.string().regex(/^[a-f0-9]{64}$/u),
    manifestDigest: z.string().regex(/^[a-f0-9]{64}$/u),
    encrypted: z.literal(true),
    destinationRef: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/u),
    retentionDays: z.number().int().min(1).max(3650),
    offHost: z.boolean(),
    keyCustodyRef: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z0-9:/._-]+$/u),
    coverage: z.array(backupCoverage).min(1).max(4),
    appVersion: z.string().min(1).max(64),
    schemaVersion: z.string().min(1).max(64),
    databaseRecoveryPoint: z.string().min(1).max(128),
    objectRecoveryPoint: z.string().min(1).max(128).nullable(),
    verifiedAt: time.nullable(),
    restoredAt: time.nullable(),
    targetDatabase: z.string().max(64).nullable(),
    targetObjectBucket: z.string().max(64).nullable(),
  })
  .strict();
export type FamilyBackupReceipt = z.infer<typeof familyBackupReceipt>;
export const familyBackupJob = z
  .object({
    request: familyBackupRequest,
    status: z.enum(["queued", "running", "completed", "failed", "unknown"]),
    createdAt: time,
    completedAt: time.nullable(),
    authorityExpiresAt: time.nullable(),
    error: z
      .enum(["execution_failed", "invalid_receipt", "interrupted", "source_unavailable"])
      .nullable(),
    receipt: familyBackupReceipt.nullable(),
  })
  .strict();
export type FamilyBackupJob = z.infer<typeof familyBackupJob>;
export const familyBackupStatus = z
  .object({
    protocol: z.literal(familyBackupProtocol),
    binding: familyBackupBinding,
    capabilities: z.array(z.enum(["backup", "verify", "restore"])).max(3),
    scheduler: z.enum(["worker", "external"]),
    owner: z.enum(["local", "workspace"]),
    policy: familyBackupPolicy,
    minimumRetentionDays: z.number().int().positive(),
    destinations: z.array(z.string().max(64)).max(32),
    requiredCoverage: z.array(backupCoverage).min(1).max(4),
    observedAt: time,
    applicationHealthy: z.boolean().nullable(),
    alerts: z.array(
      z.enum([
        "backup_missing",
        "backup_stale",
        "verification_missing",
        "restore_drill_missing",
        "unknown_job",
        "application_unavailable",
      ]),
    ),
    jobs: z.array(familyBackupJob).max(100),
  })
  .strict();
export type FamilyBackupStatus = z.infer<typeof familyBackupStatus>;
