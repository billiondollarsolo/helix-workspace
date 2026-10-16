import { collaborationAuthorization } from "../tools/collaboration-authorization.js";
import { z } from "zod";
import { BadRequestError, ForbiddenError } from "../../api/api-error.js";
import { actorHasScope } from "../../api/scopes.js";
import { sha256Hex } from "../crypto/index.js";
import type { DlpGuard } from "../dlp.js";
import type { RuntimeToolRegistry } from "../tool-registry.js";
import { defineTool } from "../tools/define-tool.js";
import { zodToolSchema } from "../webhooks/tool-schemas.js";
import { DriveNotFoundError } from "./errors.js";
import type { DriveStore } from "./store.js";
import { toUint8Array } from "./store/storage.js";

/**
 * `drive.copy`: make a copy of a file the actor can read.
 *
 * A copy leaves the original's control, like a download: it is the copier's
 * own file. So it passes the same checks a download does, and it is written
 * through the ordinary upload path, which counts it against storage and
 * malware-scans it like any other new file.
 */

const uuidSchema = z.string().uuid();
const genericObjectJsonSchema = { type: "object", additionalProperties: true } as const;

const copySchema = z.object({
  objectId: uuidSchema,
  /** Where the copy goes. Left out, it sits beside an original you own, or in My Drive. */
  folderId: uuidSchema.nullable().optional(),
});
const copiedSchema = z.object({
  objectId: uuidSchema,
  name: z.string(),
  folderId: uuidSchema.nullable(),
});

/** Copies are read into memory to be scanned, so they share the S3 gateway's CopyObject limit. */
const MAX_COPY_BYTES = 128 * 1024 * 1024;

function driveCopyName(name: string): string {
  return name.startsWith("Copy of ") ? name : `Copy of ${name}`;
}

export function registerDriveCopyTool(
  registry: RuntimeToolRegistry,
  options: {
    readonly store: Pick<
      DriveStore,
      "openFile" | "prepareUpload" | "finalizeUpload" | "trash" | "delete"
    > & {
      /** False for a meeting recording whose export is turned off. */
      canExportFile?(input: {
        readonly orgId: string;
        readonly actorId: string;
        readonly objectId: string;
      }): Promise<boolean>;
    };
    readonly dlp?: DlpGuard | undefined;
    readonly maxBytes?: number | undefined;
  },
): void {
  const { store } = options;
  const maxBytes = options.maxBytes ?? MAX_COPY_BYTES;
  registry.register(
    defineTool<z.output<typeof copySchema>, unknown>({
      id: "drive.copy",
      description:
        "Make a copy of a Drive file you can open. The copy is yours and is scanned and counted against storage like an upload.",
      permission: "drive.write",
      sideEffects: "write",
      standingAuthorization: collaborationAuthorization("drive.write"),
      confirmationRequired: false,
      inputSchema: zodToolSchema(copySchema, genericObjectJsonSchema),
      outputSchema: zodToolSchema(copiedSchema, genericObjectJsonSchema),
      handler: async (input, ctx) => {
        const scope = { orgId: ctx.actor.orgId, actorId: ctx.actor.id };
        // Copying reads the original, which a write-only credential may not do.
        if (!actorHasScope(ctx.actor, "drive.read")) {
          throw new ForbiddenError("Copying a file also needs the drive.read permission.");
        }
        const source = await store.openFile?.({ ...scope, objectId: input.objectId });
        if (source === undefined || source === null) {
          throw new DriveNotFoundError("That file isn't available to copy.");
        }
        if (source.byteSize > maxBytes) {
          throw new BadRequestError(
            `Files over ${String(Math.floor(maxBytes / (1024 * 1024)))} MB can't be copied here. Download it and upload it again instead.`,
          );
        }
        const decision = await options.dlp?.evaluate({
          ...scope,
          boundary: "drive_download",
          resources: [{ resourceType: "drive.file", resourceId: input.objectId }],
        });
        if (decision?.action === "block" || decision?.action === "quarantine") {
          throw new ForbiddenError(
            "Your organization's data-loss policy doesn't allow copies of this file.",
          );
        }
        if (
          store.canExportFile !== undefined &&
          !(await store.canExportFile({ ...scope, objectId: input.objectId }))
        ) {
          throw new ForbiddenError("Copies are turned off for this recording.");
        }
        const stream = await source.open();
        if (stream === null) throw new DriveNotFoundError("That file isn't available to copy.");
        const content = Buffer.from(await toUint8Array(stream));
        const sha256 = sha256Hex(content);
        const name = driveCopyName(source.entry.name);
        const mimeType = source.entry.mimeType ?? "application/octet-stream";
        const folderId =
          input.folderId !== undefined
            ? input.folderId
            : source.entry.ownerActorId === ctx.actor.id
              ? source.entry.folderId
              : null;
        const prepared = await store.prepareUpload({
          ...scope,
          name,
          folderId,
          mimeType,
          byteSize: content.byteLength,
          sha256,
        });
        try {
          await store.finalizeUpload({
            ...scope,
            objectId: prepared.objectId,
            byteSize: content.byteLength,
            sha256,
            mimeType,
            content,
          });
        } catch (error) {
          // Nothing usable was stored; do not leave a half-made file behind.
          const target = { ...scope, objectId: prepared.objectId };
          await store.trash(target).catch(() => undefined);
          await store.delete(target).catch(() => undefined);
          throw error;
        }
        return { objectId: prepared.objectId, name, folderId };
      },
    }),
  );
}
