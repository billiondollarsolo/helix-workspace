import {
  driveAccessGrantSchema,
  driveCommentRevisionSchema,
  driveCommentSchema,
  driveEntryPageSchema,
  driveEntrySchema,
  driveSearchHitSchema,
  driveShareLinkSchema,
  driveUploadResultSchema,
  driveUploadStatusSchema,
  driveVersionSchema,
} from "@helix/contracts";
import { z } from "zod";
export const driveCreateOutputSchema = driveEntrySchema;
export const driveUploadOutputSchema = driveUploadResultSchema;
export const driveUploadStatusOutputSchema = driveUploadStatusSchema;
export const driveFinalizeOutputSchema = driveVersionSchema;
export const driveListOutputSchema = driveEntryPageSchema;
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
export const driveDeleteOutputSchema = z.object({ deleted: z.boolean() });
export const driveSearchOutputSchema = z.object({ hits: driveSearchHitSchema.array() });
export const driveCommentOutputSchema = driveCommentSchema;
export const driveCommentListOutputSchema = z.object({
  comments: driveCommentSchema.array(),
  nextCursor: z.string().nullable(),
});
export const driveCommentRevisionListOutputSchema = z.object({
  revisions: driveCommentRevisionSchema.array(),
  nextCursor: z.string().nullable(),
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
export const driveDocumentSurfaceViewOutputSchema = z.object({
  view: z.enum(["grid", "list"]),
});
export const driveWorkflowSchema = z.object({
  id: z.string().uuid(),
  kind: z.enum([
    "shortcut",
    "file_request",
    "approval",
    "ownership_transfer",
    "shared_drive",
    "classification",
    "hold",
    "investigation",
  ]),
  resourceType: z.enum(["object", "folder"]),
  resourceId: z.string().uuid(),
  requestedByActorId: z.string().uuid(),
  assignedToActorId: z.string().uuid().nullable(),
  state: z.enum(["open", "approved", "rejected", "cancelled", "completed"]),
  version: z.string(),
  payload: z.record(z.unknown()),
  policySnapshot: z.record(z.unknown()),
  dueAt: z.string().datetime().nullable(),
  decidedAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export const driveWorkflowListOutputSchema = z.object({ workflows: driveWorkflowSchema.array() });
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
