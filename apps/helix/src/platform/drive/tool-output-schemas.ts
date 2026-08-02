import { z } from "zod3";
import {
  driveAccessGrantSchema,
  driveCommentSchema,
  driveEntrySchema,
  drivePdfFormStateSchema,
  driveSearchHitSchema,
  driveShareLinkSchema,
  driveUploadResultSchema,
  driveUploadStatusSchema,
  driveVersionSchema,
} from "@helix/contracts";

/** drive.create: folder entry or lightweight app create stub */
export const driveCreateOutputSchema = z.union([
  z.object({ id: z.string().uuid(), app: z.string() }),
  driveEntrySchema,
]);

export const driveUploadOutputSchema = driveUploadResultSchema;
export const driveUploadStatusOutputSchema = driveUploadStatusSchema;
export const driveFinalizeOutputSchema = driveVersionSchema;
export const driveListOutputSchema = z.object({ entries: driveEntrySchema.array() });
export const driveShareOutputSchema = z.object({
  objectId: z.string().uuid(),
  sharedWithActorIds: z.string().uuid().array(),
  role: z.string(),
});
export const driveAccessListOutputSchema = z.object({ grants: driveAccessGrantSchema.array() });
export const driveAccessRemoveOutputSchema = z.object({
  objectId: z.string().uuid(),
  actorId: z.string().uuid(),
  removed: z.boolean(),
});
export const driveAccessUpdateOutputSchema = z.object({
  objectId: z.string().uuid(),
  actorId: z.string().uuid(),
  grant: driveAccessGrantSchema.nullable(),
});
/** move / star / trash / restore / rename return a serialized entry (handlers throw if missing). */
export const driveEntryOutputSchema = driveEntrySchema;
export const driveEntryOrNullOutputSchema = driveEntrySchema.nullable();
export const driveDeleteOutputSchema = z.object({ deleted: z.boolean() });
export const driveSearchOutputSchema = z.object({ hits: driveSearchHitSchema.array() });
export const driveCommentOutputSchema = driveCommentSchema;
export const driveCommentListOutputSchema = z.object({ comments: driveCommentSchema.array() });
export const drivePdfFormStateGetOutputSchema = z.object({
  state: drivePdfFormStateSchema.nullable(),
});
export const drivePdfFormStateOutputSchema = drivePdfFormStateSchema;
export const drivePdfFormStateClearOutputSchema = z.object({
  objectId: z.string().uuid(),
  cleared: z.boolean(),
});
export const driveVersionsListOutputSchema = z.object({ versions: driveVersionSchema.array() });
export const driveVersionOutputSchema = driveVersionSchema;
export const driveShareLinkOutputSchema = driveShareLinkSchema;
export const driveShareLinkListOutputSchema = z.object({
  links: driveShareLinkSchema.array(),
});
export const driveShareLinkRevokeOutputSchema = z.object({
  id: z.string().uuid(),
  revoked: z.boolean(),
});

/** D11 operator quota usage snapshot. */
export const driveQuotaUsageOutputSchema = z.object({
  orgId: z.string().uuid(),
  usedBytes: z.number().int().nonnegative(),
  limitBytes: z.number().int().nonnegative().nullable(),
  unlimited: z.boolean(),
  percentUsed: z.number().nonnegative().nullable(),
});

/** D11 operator lifecycle policy. */
export const driveLifecyclePolicyOutputSchema = z.object({
  orgId: z.string().uuid(),
  trashRetentionDays: z.number().int().min(1).max(3650),
  orphanGraceHours: z.number().int().min(1).max(720),
  updatedByActorId: z.string().uuid().nullable(),
  updatedAt: z.string().nullable(),
  configured: z.boolean(),
});
