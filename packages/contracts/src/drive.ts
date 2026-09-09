import { z } from "zod";
export const DRIVE_ROLES = ["reader", "commenter", "editor", "owner"] as const;
export const driveRoleSchema = z.enum(DRIVE_ROLES);
export type DriveRole = z.infer<typeof driveRoleSchema>;
export const driveItemKindSchema = z.enum(["file", "folder"]);
export type DriveItemKind = z.infer<typeof driveItemKindSchema>;
export const DRIVE_UPLOAD_STATES = [
  "pending_upload",
  "uploaded",
  "scanning",
  "active",
  "quarantined",
  "scan_failed",
  "trashed",
] as const;
export const driveUploadStateSchema = z.enum(DRIVE_UPLOAD_STATES);
export type DriveUploadState = z.infer<typeof driveUploadStateSchema>;
const jsonObjectSchema = z.record(z.string(), z.unknown());
export const driveEntrySchema = z.object({
  id: z.string().uuid(),
  type: driveItemKindSchema,
  name: z.string(),
  folderId: z.string().uuid().nullable(),
  ownerActorId: z.string().uuid().nullable(),
  ownerDisplayName: z.string().optional(),
  ownerEmail: z.string().optional(),
  mimeType: z.string().optional(),
  byteSize: z.number().int().nonnegative().optional(),
  sha256: z.string().nullable().optional(),
  storageKey: z.string().optional(),
  versionNumber: z.number().int().positive().optional(),
  /** Upload/scan lifecycle state. Content is only available when `active`. */
  uploadState: driveUploadStateSchema.optional(),
  /** User-facing label for non-active processing/quarantine states. */
  uploadStatusLabel: z.string().optional(),
  /** False while scanning/quarantined/failed; true only for active objects. */
  available: z.boolean().optional(),
  metadata: jsonObjectSchema.default({}),
  deletedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type DriveEntry = z.infer<typeof driveEntrySchema>;
export const driveEntryPageSchema = z.object({
  entries: driveEntrySchema.array(),
  nextCursor: z.string().nullable(),
});
export type DriveEntryPage = z.infer<typeof driveEntryPageSchema>;
export const driveMultipartInfoSchema = z.object({
  uploadId: z.string().min(1),
  partSize: z.number().int().positive(),
  partCount: z.number().int().positive(),
  partUrls: z.array(z.string().min(1)),
  expiresAt: z.string().datetime(),
});
export type DriveMultipartInfo = z.infer<typeof driveMultipartInfoSchema>;
export const driveUploadResultSchema = z.object({
  objectId: z.string().uuid(),
  orgId: z.string().uuid(),
  ownerActorId: z.string().uuid(),
  name: z.string(),
  folderId: z.string().uuid().nullable(),
  storageKey: z.string(),
  mimeType: z.string(),
  byteSize: z.number().int().nonnegative(),
  sha256: z.string().nullable(),
  status: driveUploadStateSchema,
  uploadUrl: z.string().nullable(),
  uploadHeaders: z.record(z.string(), z.string()).default({}),
  metadata: jsonObjectSchema.default({}),
  createdAt: z.string(),
  updatedAt: z.string(),
  multipart: driveMultipartInfoSchema.optional(),
});
export type DriveUploadResult = z.infer<typeof driveUploadResultSchema>;
export const driveUploadStatusSchema = z.object({
  objectId: z.string().uuid(),
  state: driveUploadStateSchema,
  label: z.string().min(1),
  available: z.boolean(),
  terminal: z.boolean(),
  updatedAt: z.string(),
});
export type DriveUploadStatus = z.infer<typeof driveUploadStatusSchema>;
export const driveUploadCompleteInputSchema = z.object({
  objectId: z.string().uuid(),
  uploadId: z.string().min(1),
  parts: z
    .array(
      z.object({
        partNumber: z.number().int().positive(),
        etag: z.string().min(1),
      }),
    )
    .min(1),
  byteSize: z.number().int().nonnegative(),
  sha256: z
    .string()
    .regex(/^[a-f0-9]{64}$/i)
    .optional(),
  mimeType: z.string().min(1).optional(),
  metadata: jsonObjectSchema.default({}),
});
export type DriveUploadCompleteInput = z.infer<typeof driveUploadCompleteInputSchema>;
export const driveVersionSchema = z.object({
  id: z.string().uuid(),
  orgId: z.string().uuid(),
  objectId: z.string().uuid(),
  versionNumber: z.number().int().positive(),
  storageKey: z.string(),
  mimeType: z.string(),
  byteSize: z.number().int().nonnegative(),
  sha256: z.string(),
  metadata: jsonObjectSchema.default({}),
  createdByActorId: z.string().uuid().nullable(),
  createdAt: z.string(),
});
export type DriveVersion = z.infer<typeof driveVersionSchema>;
export const driveAccessGrantSchema = z.object({
  actorId: z.string().uuid(),
  role: z.string(),
  displayName: z.string().optional(),
  email: z.string().optional(),
  grantedByActorId: z.string().uuid().nullable(),
  expiresAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type DriveAccessGrant = z.infer<typeof driveAccessGrantSchema>;
export const driveSearchHitSchema = z.object({
  objectId: z.string().uuid(),
  name: z.string(),
  mimeType: z.string(),
  byteSize: z.number().int().nonnegative(),
  sha256: z.string().nullable(),
  folderId: z.string().uuid().nullable(),
  preview: z.string(),
  updatedAt: z.string(),
});
export type DriveSearchHit = z.infer<typeof driveSearchHitSchema>;
export const driveCommentSchema = z.object({
  id: z.string().uuid(),
  orgId: z.string().uuid(),
  objectId: z.string().uuid(),
  parentCommentId: z.string().uuid().nullable(),
  actorId: z.string().uuid().nullable(),
  anchor: jsonObjectSchema.default({}),
  body: z.string(),
  status: z.string(),
  metadata: jsonObjectSchema.default({}),
  resolvedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string().nullable(),
  author: z
    .object({
      id: z.string(),
      displayName: z.string().optional(),
      email: z.string().optional(),
    })
    .optional(),
});
export type DriveComment = z.infer<typeof driveCommentSchema>;
export const driveCommentRevisionSchema = z.object({
  id: z.string().uuid(),
  orgId: z.string().uuid(),
  objectId: z.string().uuid(),
  commentId: z.string().uuid(),
  revision: z.number().int().positive(),
  changeKind: z.enum(["created", "edited", "resolved", "reopened", "deleted"]),
  parentCommentId: z.string().uuid().nullable(),
  commentActorId: z.string().uuid().nullable(),
  anchor: jsonObjectSchema,
  body: z.string(),
  status: z.enum(["open", "resolved"]),
  metadata: jsonObjectSchema,
  resolvedAt: z.string().nullable(),
  resolvedByActorId: z.string().uuid().nullable(),
  deletedAt: z.string().nullable(),
  deletedByActorId: z.string().uuid().nullable(),
  changedByActorId: z.string().uuid(),
  capturedAt: z.string(),
});
export type DriveCommentRevision = z.infer<typeof driveCommentRevisionSchema>;
export const driveShareLinkSchema = z.object({
  id: z.string().uuid(),
  orgId: z.string().uuid(),
  objectId: z.string().uuid(),
  token: z.string().min(43).nullable(),
  role: z.literal("reader"),
  expiresAt: z.string().nullable(),
  passwordProtected: z.boolean(),
  oneTime: z.boolean(),
  allowedDomains: z.array(z.string()).max(50),
  allowDownload: z.boolean(),
  consumedAt: z.string().nullable(),
  createdByActorId: z.string().uuid().nullable(),
  createdAt: z.string(),
  revokedAt: z.string().nullable(),
  maxDownloads: z.number().int().positive().nullable(),
  downloadCount: z.number().int().nonnegative(),
  rateLimitPerHour: z.number().int().positive(),
  lastUsedAt: z.string().nullable(),
});
export type DriveShareLink = z.infer<typeof driveShareLinkSchema>;
export const driveRenameInputSchema = z.object({
  objectId: z.string().uuid(),
  name: z.string().min(1).max(512),
});
export type DriveRenameInput = z.infer<typeof driveRenameInputSchema>;
export const driveListVersionsInputSchema = z.object({
  objectId: z.string().uuid(),
});
export const driveRevertVersionInputSchema = z.object({
  objectId: z.string().uuid(),
  versionNumber: z.number().int().positive(),
});
