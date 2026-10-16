import { z } from "zod";
import { NotFoundError } from "../../api/api-error.js";
import { defineTool } from "../tools/define-tool.js";
import { zodToolSchema } from "../webhooks/tool-schemas.js";
import type { DriveStore } from "./store.js";
const uuidSchema = z.string().uuid();
const genericObjectJsonSchema = { type: "object", additionalProperties: true } as const;
export function createDriveFileDescriptionTool(store: DriveStore) {
  return defineTool({
    id: "drive.file.describe",
    description:
      "Describe a readable, scanned file and its current immutable version before authenticated byte retrieval. Does not return a signed URL.",
    permission: "drive.read",
    sideEffects: "read",
    inputSchema: zodToolSchema(
      z.object({ objectId: uuidSchema }).strict(),
      genericObjectJsonSchema,
    ),
    outputSchema: zodToolSchema(
      z.object({
        objectId: uuidSchema,
        name: z.string(),
        mimeType: z.string(),
        byteSize: z.number().int().nonnegative(),
        sha256: z.string().nullable(),
        versionNumber: z.number().int().positive(),
        etag: z.string(),
        downloadPath: z.string(),
      }),
      genericObjectJsonSchema,
    ),
    handler: async (input, ctx) => {
      if (!store.openFile) throw new Error("Drive content retrieval is unavailable.");
      const file = await store.openFile({
        orgId: ctx.actor.orgId,
        actorId: ctx.actor.id,
        objectId: input.objectId,
      });
      if (!file) throw new NotFoundError("File unavailable.");
      return {
        objectId: input.objectId,
        name: file.entry.name,
        mimeType: file.entry.mimeType ?? "application/octet-stream",
        byteSize: file.byteSize,
        sha256: file.entry.sha256 ?? null,
        versionNumber: file.entry.versionNumber ?? 1,
        etag: file.etag,
        downloadPath: `/v1/api/drive/objects/${input.objectId}/content`,
      };
    },
  });
}
