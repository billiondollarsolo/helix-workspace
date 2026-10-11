import type { Actor, JsonObject, ToolDefinition } from "@helix/sdk-types";
import { z } from "zod";
import { ForbiddenError } from "../../../api/api-error.js";
import { actorHasScope } from "../../../api/scopes.js";
import { versionedApiPath } from "../../../api/version.js";
import type { RuntimeToolRegistry } from "../../tool-registry.js";
import { defineTool } from "../../tools/define-tool.js";
import { zodToolSchema } from "../../webhooks/tool-schemas.js";
import {
  DRIVE_S3_KEY_SCOPES,
  type DriveS3AccessKeyRecord,
  type DriveS3KeyScope,
  type DriveS3AccessKeyStore,
} from "./access-keys.js";
import { DRIVE_S3_BUCKETS } from "./buckets.js";

/** Public path of the gateway; clients use `<origin>/v1/s3` as their endpoint URL. */
const DRIVE_S3_ENDPOINT_PATH = versionedApiPath("/s3");
const ADMIN_SCOPE = "admin.users";

const genericObjectJsonSchema = { type: "object", additionalProperties: true } as const;
const scopeSchema = z.enum(DRIVE_S3_KEY_SCOPES);
const createSchema = z.object({
  label: z.string().trim().min(1).max(120),
  /** Defaults to every Drive scope the person holds (see `grantableScopes`). */
  scopes: z.array(scopeSchema).min(1).max(3).optional(),
  expiresAt: z.string().datetime().nullable().optional(),
});
const listSchema = z.object({
  includeRevoked: z.boolean().default(false),
  /** Admins (admin.users) may list every key in the organization. */
  allActors: z.boolean().default(false),
});
const revokeSchema = z.object({ keyId: z.string().uuid() });

function serializeDriveS3AccessKey(key: DriveS3AccessKeyRecord): JsonObject {
  return {
    id: key.id,
    actorId: key.actorId,
    accessKeyId: key.accessKeyId,
    label: key.label,
    scopes: [...key.scopes],
    lastUsedAt: key.lastUsedAt?.toISOString() ?? null,
    expiresAt: key.expiresAt?.toISOString() ?? null,
    revokedAt: key.revokedAt?.toISOString() ?? null,
    createdAt: key.createdAt.toISOString(),
  };
}

/** The S3 key scopes this person holds, in catalog order; a new key can carry only these. */
function grantableDriveS3Scopes(actor: Actor): DriveS3KeyScope[] {
  return DRIVE_S3_KEY_SCOPES.filter((scope) => actorHasScope(actor, scope));
}

function createDriveS3KeyTools(store: DriveS3AccessKeyStore): readonly ToolDefinition[] {
  return [
    defineTool<z.output<typeof createSchema>, unknown>({
      id: "drive.s3-keys.create",
      description:
        "Create an S3 access key for the Drive S3 API. The secret access key is returned once.",
      permission: "drive.write",
      sideEffects: "write",
      confirmationRequired: true,
      sensitiveOutputKeys: ["secretAccessKey"],
      interactiveSessionOnly: true,
      inputSchema: zodToolSchema(createSchema, genericObjectJsonSchema),
      outputSchema: zodToolSchema(z.unknown(), genericObjectJsonSchema),
      handler: async (input, ctx) => {
        if (ctx.actor.type !== "user") {
          throw new ForbiddenError("Only people can create S3 access keys for their own Drive.");
        }
        const grantable = grantableDriveS3Scopes(ctx.actor);
        const scopes = input.scopes ?? grantable;
        const missing = scopes.filter((scope) => !grantable.includes(scope));
        if (missing.length > 0 || scopes.length === 0) {
          throw new ForbiddenError(
            missing.length > 0
              ? `You do not hold these scopes: ${missing.join(", ")}. Choose from: ${grantable.join(", ") || "none"}.`
              : "You hold no Drive scopes an S3 access key can carry.",
          );
        }
        const created = await store.create({
          orgId: ctx.actor.orgId,
          actorId: ctx.actor.id,
          label: input.label,
          scopes,
          expiresAt:
            input.expiresAt === undefined || input.expiresAt === null
              ? null
              : new Date(input.expiresAt),
        });
        await ctx.audit("drive.s3_key.created", {
          credentialType: "drive_s3_access_key",
          keyId: created.accessKey.id,
          accessKeyId: created.accessKey.accessKeyId,
          label: created.accessKey.label,
          scopes: [...created.accessKey.scopes],
          expiresAt: created.accessKey.expiresAt?.toISOString() ?? null,
        });
        return {
          accessKey: serializeDriveS3AccessKey(created.accessKey),
          secretAccessKey: created.secretAccessKey,
          endpointPath: DRIVE_S3_ENDPOINT_PATH,
          buckets: Object.keys(DRIVE_S3_BUCKETS),
          region: "us-east-1",
        };
      },
    }),
    defineTool<z.output<typeof listSchema>, unknown>({
      id: "drive.s3-keys.list",
      description:
        "List your Drive S3 access keys without secrets; admins can list every key in the organization. grantableScopes lists the Drive scopes you hold and can give a new key.",
      permission: "drive.read",
      sideEffects: "read",
      inputSchema: zodToolSchema(listSchema, genericObjectJsonSchema),
      outputSchema: zodToolSchema(z.unknown(), genericObjectJsonSchema),
      handler: async (input, ctx) => {
        if (input.allActors && !actorHasScope(ctx.actor, ADMIN_SCOPE)) {
          throw new ForbiddenError("Listing every S3 access key requires admin.users.");
        }
        const keys = await store.list({
          orgId: ctx.actor.orgId,
          ...(input.allActors ? {} : { actorId: ctx.actor.id }),
          includeRevoked: input.includeRevoked,
        });
        if (input.allActors) {
          await ctx.audit("drive.s3_key.listed", {
            credentialType: "drive_s3_access_key",
            allActors: true,
            resultCount: keys.length,
          });
        }
        return {
          accessKeys: keys.map(serializeDriveS3AccessKey),
          endpointPath: DRIVE_S3_ENDPOINT_PATH,
          grantableScopes: grantableDriveS3Scopes(ctx.actor),
        };
      },
    }),
    defineTool<z.output<typeof revokeSchema>, unknown>({
      id: "drive.s3-keys.revoke",
      description: "Revoke a Drive S3 access key. Admins can revoke any key in the organization.",
      permission: "drive.write",
      sideEffects: "destructive",
      confirmationRequired: true,
      inputSchema: zodToolSchema(revokeSchema, genericObjectJsonSchema),
      outputSchema: zodToolSchema(z.unknown(), genericObjectJsonSchema),
      handler: async (input, ctx) => {
        const admin = actorHasScope(ctx.actor, ADMIN_SCOPE);
        const revoked = await store.revoke({
          orgId: ctx.actor.orgId,
          id: input.keyId,
          ...(admin ? {} : { actorId: ctx.actor.id }),
        });
        if (revoked === null) return { status: "not_found", keyId: input.keyId };
        await ctx.audit("drive.s3_key.revoked", {
          credentialType: "drive_s3_access_key",
          keyId: revoked.id,
          accessKeyId: revoked.accessKeyId,
          targetActorId: revoked.actorId,
        });
        return { status: "revoked", accessKey: serializeDriveS3AccessKey(revoked) };
      },
    }),
  ];
}

export function registerDriveS3KeyTools(
  registry: RuntimeToolRegistry,
  options: { readonly store: DriveS3AccessKeyStore },
): void {
  for (const tool of createDriveS3KeyTools(options.store)) registry.register(tool);
}
