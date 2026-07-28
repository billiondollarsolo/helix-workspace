import { z } from "zod3";
import type { JsonObject, ToolDefinition } from "@helix/sdk-types";
import type { RuntimeToolRegistry } from "../tool-registry.js";
import { zodToolSchema } from "../webhooks/tool-schemas.js";
import {
  OAuthClientManager,
  OAuthError,
  parseScope,
  type OAuthClientRecord,
  type OAuthClientStore,
} from "./oauth.js";
import { agentCredentialScopeCatalog } from "../permissions/scope-catalog.js";

export const agentCredentialAdminScope = "admin.agents";

/**
 * Scope catalog for agent OAuth credentials.
 *
 * As of P1-6 this is no longer hand-maintained here; it is re-exported from the
 * single canonical {@link ../permissions/scope-catalog.ts} module so the
 * credential UI, the OpenAPI scope list, and enforcement cannot drift.
 */
export { agentCredentialScopeCatalog };

const genericObjectJsonSchema = {
  type: "object",
  additionalProperties: true,
} as const;

const uuidSchema = z.string().uuid();
const clientIdSchema = z.string().min(1);

const listSchema = z.object({
  actorId: uuidSchema.optional(),
  includeRevoked: z.boolean().default(false),
});

const revokeSchema = z.object({
  clientId: clientIdSchema,
});
const rotateSchema = revokeSchema;

export interface RegisterAgentCredentialToolsOptions {
  readonly clientStore: OAuthClientStore;
  readonly clientManager?: OAuthClientManager;
  readonly scopeCatalog?: readonly string[];
  readonly tokenEndpoint?: string;
}

export function createAgentCredentialToolDefinitions(
  options: RegisterAgentCredentialToolsOptions,
): readonly ToolDefinition[] {
  const clientManager =
    options.clientManager ?? new OAuthClientManager({ clientStore: options.clientStore });
  const scopeCatalog = new Set(options.scopeCatalog ?? agentCredentialScopeCatalog);
  const createSchema = createCredentialCreateSchema(scopeCatalog);

  return [
    defineTool<z.output<typeof createSchema>, unknown>({
      id: "agent.credentials.create",
      description: "Create a scoped OAuth client credential for an agent actor in the current org.",
      permission: agentCredentialAdminScope,
      sideEffects: "write",
      confirmationRequired: true,
      inputSchema: zodToolSchema(createSchema, genericObjectJsonSchema),
      outputSchema: zodToolSchema(z.unknown(), genericObjectJsonSchema),
      handler: async (input, ctx) => {
        const registration = await clientManager.createClient({
          actorId: input.actorId,
          orgId: ctx.actor.orgId,
          approvalOwnerActorId: ctx.actor.id,
          scopes: normalizeScopes(input.scopes),
          expiresAt:
            input.expiresAt === undefined || input.expiresAt === null
              ? null
              : new Date(input.expiresAt),
        });
        await ctx.audit("agent.credential.created", {
          credentialType: "oauth_client",
          targetActorId: registration.client.actorId,
          targetOrgId: registration.client.orgId,
          clientId: registration.client.clientId,
          scopes: [...registration.client.scopes],
          expiresAt: dateToJson(registration.client.expiresAt),
        });
        return {
          credential: serializeClient(registration.client),
          clientSecret: registration.clientSecret,
          grantType: "client_credentials",
          tokenEndpoint: options.tokenEndpoint ?? "/oauth/token",
        };
      },
    }),
    defineTool<z.output<typeof listSchema>, unknown>({
      id: "agent.credentials.list",
      description: "List OAuth client credentials for agent actors in the current org.",
      permission: agentCredentialAdminScope,
      sideEffects: "read",
      inputSchema: zodToolSchema(listSchema, genericObjectJsonSchema),
      outputSchema: zodToolSchema(z.unknown(), genericObjectJsonSchema),
      handler: async (input, ctx) => {
        const credentials = await clientManager.listClients({
          orgId: ctx.actor.orgId,
          ...(input.actorId === undefined ? {} : { actorId: input.actorId }),
          includeRevoked: input.includeRevoked,
        });
        await ctx.audit("agent.credential.listed", {
          credentialType: "oauth_client",
          ...(input.actorId === undefined ? {} : { targetActorId: input.actorId }),
          includeRevoked: input.includeRevoked,
          resultCount: credentials.length,
        });
        return { credentials: credentials.map(serializeClient) };
      },
    }),
    defineTool<z.output<typeof revokeSchema>, unknown>({
      id: "agent.credentials.revoke",
      description: "Revoke an OAuth client credential in the current org.",
      permission: agentCredentialAdminScope,
      sideEffects: "destructive",
      confirmationRequired: true,
      inputSchema: zodToolSchema(revokeSchema, genericObjectJsonSchema),
      outputSchema: zodToolSchema(z.unknown(), genericObjectJsonSchema),
      handler: async (input, ctx) => {
        const existing = await options.clientStore.findClient(input.clientId);
        if (existing === null || existing.orgId !== ctx.actor.orgId) {
          return { status: "not_found", clientId: input.clientId };
        }
        const revoked = await clientManager.revokeClient(input.clientId);
        if (revoked === null) {
          return { status: "not_found", clientId: input.clientId };
        }
        await ctx.audit("agent.credential.revoked", {
          credentialType: "oauth_client",
          targetActorId: revoked.actorId,
          targetOrgId: revoked.orgId,
          clientId: revoked.clientId,
          revokedAt: dateToJson(revoked.revokedAt),
        });
        return {
          status: "revoked",
          credential: serializeClient(revoked),
        };
      },
    }),
    defineTool<z.output<typeof rotateSchema>, unknown>({
      id: "agent.credentials.rotate",
      description:
        "Rotate an OAuth client secret in the current org and return the replacement once.",
      permission: agentCredentialAdminScope,
      sideEffects: "destructive",
      confirmationRequired: true,
      inputSchema: zodToolSchema(rotateSchema, genericObjectJsonSchema),
      outputSchema: zodToolSchema(z.unknown(), genericObjectJsonSchema),
      handler: async (input, ctx) => {
        const existing = await options.clientStore.findClient(input.clientId);
        if (existing === null || existing.orgId !== ctx.actor.orgId) {
          return { status: "not_found", clientId: input.clientId };
        }
        const registration = await clientManager.rotateClientSecret(input.clientId);
        if (registration === null) {
          return { status: "not_found", clientId: input.clientId };
        }
        await ctx.audit("agent.credential.rotated", {
          credentialType: "oauth_client",
          targetActorId: registration.client.actorId,
          targetOrgId: registration.client.orgId,
          clientId: registration.client.clientId,
          rotatedAt: new Date().toISOString(),
        });
        return {
          status: "rotated",
          credential: serializeClient(registration.client),
          clientSecret: registration.clientSecret,
        };
      },
    }),
  ];
}

export function registerAgentCredentialTools(
  registry: RuntimeToolRegistry,
  options: RegisterAgentCredentialToolsOptions,
): void {
  for (const tool of createAgentCredentialToolDefinitions(options)) {
    registry.register(tool);
  }
}

function createCredentialCreateSchema(scopeCatalog: ReadonlySet<string>) {
  return z
    .object({
      actorId: uuidSchema,
      scopes: z.array(z.string().min(1)).min(1),
      expiresAt: z.string().datetime().nullable().optional(),
    })
    .superRefine((input, ctx) => {
      let scopes: readonly string[];
      try {
        scopes = normalizeScopes(input.scopes);
      } catch (error) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["scopes"],
          message: error instanceof Error ? error.message : "Invalid scope token.",
        });
        return;
      }
      for (const scope of scopes) {
        if (!scopeCatalog.has(scope)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["scopes"],
            message: `Unknown or unsupported agent credential scope: ${scope}`,
          });
        }
      }
    });
}

function defineTool<Input, Output>(
  tool: ToolDefinition<Input, Output>,
): ToolDefinition<Input, Output> {
  return tool;
}

function normalizeScopes(scopes: readonly string[]): string[] {
  try {
    return parseScope(scopes.join(" "));
  } catch (error) {
    if (error instanceof OAuthError) {
      throw new TypeError(error.message);
    }
    throw error;
  }
}

function serializeClient(client: OAuthClientRecord): JsonObject {
  return {
    clientId: client.clientId,
    actorId: client.actorId,
    orgId: client.orgId,
    scopes: [...client.scopes],
    lastUsedAt: dateToJson(client.lastUsedAt ?? null),
    expiresAt: dateToJson(client.expiresAt),
    revokedAt: dateToJson(client.revokedAt),
  };
}

function dateToJson(date: Date | null): string | null {
  return date === null ? null : date.toISOString();
}
