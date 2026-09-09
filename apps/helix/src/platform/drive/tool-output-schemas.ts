import { z } from "zod";
import {
  driveAccessGrantSchema,
  driveCommentSchema,
  driveCommentRevisionSchema,
  driveEntrySchema,
  driveEntryPageSchema,
  drivePdfFormStateSchema,
  driveSearchHitSchema,
  driveShareLinkSchema,
  driveUploadResultSchema,
  driveVersionSchema,
} from "@helix/contracts";

/** drive.create: folder entry or lightweight app create stub */
export const driveCreateOutputSchema = z.union([
  z.object({ id: z.string().uuid(), app: z.string() }),
  driveEntrySchema,
]);

export const driveUploadOutputSchema = driveUploadResultSchema;
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
export const driveEntryOrNullOutputSchema = driveEntrySchema.nullable();
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
