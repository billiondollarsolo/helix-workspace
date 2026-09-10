import type { JsonObject, ToolDefinition } from "@helix/sdk-types";
import { z } from "zod";
import { getCryptoProvider } from "../crypto/index.js";
import { agentCredentialScopeCatalog } from "../permissions/scope-catalog.js";
import type { RuntimeToolRegistry } from "../tool-registry.js";
import { defineTool } from "../tools/define-tool.js";
import { zodToolSchema } from "../webhooks/tool-schemas.js";
import {
  generateApiKey,
  hashApiKey,
  normalizeCertFingerprint,
  type AgentCredentialInventoryRecord,
  type AgentCredentialLifecycleStore,
  type AgentCredentialType,
} from "./credentials.js";
import { hashSecret, OAuthError, parseScope } from "./oauth.js";

const agentCredentialAdminScope = "admin.agents";
export { agentCredentialScopeCatalog };

const genericObjectJsonSchema = { type: "object", additionalProperties: true } as const;
const uuidSchema = z.string().uuid();
const credentialTypeSchema = z.enum(["oauth_client", "api_key", "mtls_cert"]);
const listSchema = z.object({
  actorId: uuidSchema.optional(),
  includeRevoked: z.boolean().default(false),
});
const revokeSchema = z.object({ credentialId: uuidSchema });
const rotateSchema = z
  .object({
    credentialId: uuidSchema,
    expiresAt: z.string().datetime(),
    certificateFingerprint: z.string().trim().optional(),
  })
  .superRefine(requireFutureExpiry);

export interface RegisterAgentCredentialToolsOptions {
  readonly store: AgentCredentialLifecycleStore;
  readonly scopeCatalog?: readonly string[];
  readonly tokenEndpoint?: string;
}

function createAgentCredentialToolDefinitions(
  options: RegisterAgentCredentialToolsOptions,
): readonly ToolDefinition[] {
  const scopeCatalog = new Set(options.scopeCatalog ?? agentCredentialScopeCatalog);
  const createSchema = createCredentialSchema(scopeCatalog);

  return [
    defineTool<z.output<typeof createSchema>, unknown>({
      id: "agent.credentials.create",
      description: "Issue a scoped OAuth, API-key, or mTLS credential to a non-human principal.",
      permission: agentCredentialAdminScope,
      sideEffects: "write",
      confirmationRequired: true,
      inputSchema: zodToolSchema(createSchema, genericObjectJsonSchema),
      outputSchema: zodToolSchema(z.unknown(), genericObjectJsonSchema),
      handler: async (input, ctx) => {
        assertIssuerScopeCeiling(ctx.actor, input.scopes);
        const material = await newCredentialMaterial(
          input.credentialType,
          input.certificateFingerprint,
        );
        const credential = await options.store.issue({
          orgId: ctx.actor.orgId,
          operatorActorId: ctx.actor.id,
          principalActorId: input.actorId,
          credentialType: input.credentialType,
          label: input.label,
          purpose: input.purpose,
          scopes: normalizeScopes(input.scopes),
          expiresAt: new Date(input.expiresAt),
          ...material.persisted,
        });
        return credentialMutationOutput(
          credential,
          material.secret,
          options.tokenEndpoint ?? "/oauth/token",
        );
      },
    }),
    defineTool<z.output<typeof listSchema>, unknown>({
      id: "agent.credentials.list",
      description: "Inventory governed credentials for agents and service accounts.",
      permission: agentCredentialAdminScope,
      sideEffects: "read",
      inputSchema: zodToolSchema(listSchema, genericObjectJsonSchema),
      outputSchema: zodToolSchema(z.unknown(), genericObjectJsonSchema),
      handler: async (input, ctx) => {
        const credentials = await options.store.list({
          orgId: ctx.actor.orgId,
          ...(input.actorId === undefined ? {} : { principalActorId: input.actorId }),
          includeRevoked: input.includeRevoked,
        });
        await ctx.audit("nonhuman.credential.inventory.viewed", {
          ...(input.actorId === undefined ? {} : { targetActorId: input.actorId }),
          includeRevoked: input.includeRevoked,
          resultCount: credentials.length,
        });
        return { credentials: credentials.map(serializeCredential) };
      },
    }),
    defineTool<z.output<typeof rotateSchema>, unknown>({
      id: "agent.credentials.rotate",
      description: "Rotate credential material and invalidate the previous material immediately.",
      permission: agentCredentialAdminScope,
      sideEffects: "destructive",
      confirmationRequired: true,
      inputSchema: zodToolSchema(rotateSchema, genericObjectJsonSchema),
      outputSchema: zodToolSchema(z.unknown(), genericObjectJsonSchema),
      handler: async (input, ctx) => {
        const existing = (
          await options.store.list({ orgId: ctx.actor.orgId, includeRevoked: false })
        ).find((credential) => credential.id === input.credentialId);
        if (existing === undefined)
          return { status: "not_found", credentialId: input.credentialId };
        const material = await newCredentialMaterial(
          existing.credentialType,
          input.certificateFingerprint,
        );
        const credential = await options.store.rotate({
          orgId: ctx.actor.orgId,
          operatorActorId: ctx.actor.id,
          credentialId: input.credentialId,
          expiresAt: new Date(input.expiresAt),
          ...material.persisted,
        });
        return credential === null
          ? { status: "not_found", credentialId: input.credentialId }
          : {
              status: "rotated",
              ...credentialMutationOutput(
                credential,
                material.secret,
                options.tokenEndpoint ?? "/oauth/token",
              ),
            };
      },
    }),
    defineTool<z.output<typeof revokeSchema>, unknown>({
      id: "agent.credentials.revoke",
      description: "Immediately revoke one non-human credential in the current tenant.",
      permission: agentCredentialAdminScope,
      sideEffects: "destructive",
      confirmationRequired: true,
      inputSchema: zodToolSchema(revokeSchema, genericObjectJsonSchema),
      outputSchema: zodToolSchema(z.unknown(), genericObjectJsonSchema),
      handler: async (input, ctx) => {
        const credential = await options.store.revoke({
          orgId: ctx.actor.orgId,
          operatorActorId: ctx.actor.id,
          credentialId: input.credentialId,
        });
        return credential === null
          ? { status: "not_found", credentialId: input.credentialId }
          : { status: "revoked", credential: serializeCredential(credential) };
      },
    }),
  ];
}

export function registerAgentCredentialTools(
  registry: RuntimeToolRegistry,
  options: RegisterAgentCredentialToolsOptions,
): void {
  for (const tool of createAgentCredentialToolDefinitions(options)) registry.register(tool);
}

function createCredentialSchema(scopeCatalog: ReadonlySet<string>) {
  return z
    .object({
      actorId: uuidSchema,
      credentialType: credentialTypeSchema,
      label: z.string().trim().min(1).max(200),
      purpose: z.string().trim().min(1).max(500),
      scopes: z.array(z.string().min(1)).min(1),
      expiresAt: z.string().datetime(),
      certificateFingerprint: z.string().trim().optional(),
    })
    .superRefine((input, ctx) => {
      requireFutureExpiry(input, ctx);
      validateScopes(input.scopes, scopeCatalog, ctx);
      if (
        input.credentialType === "mtls_cert" &&
        normalizeCertFingerprint(input.certificateFingerprint ?? "").length !== 64
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["certificateFingerprint"],
          message: "A SHA-256 certificate fingerprint is required for mTLS.",
        });
      }
    });
}

function requireFutureExpiry(input: { readonly expiresAt: string }, ctx: z.RefinementCtx): void {
  const lifetime = new Date(input.expiresAt).getTime() - Date.now();
  if (lifetime <= 0 || lifetime > 366 * 86_400_000) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["expiresAt"],
      message: "Must be within 366 days.",
    });
  }
}

function validateScopes(
  input: readonly string[],
  scopeCatalog: ReadonlySet<string>,
  ctx: z.RefinementCtx,
): void {
  let scopes: readonly string[];
  try {
    scopes = normalizeScopes(input);
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
}

async function newCredentialMaterial(
  credentialType: AgentCredentialType,
  certificateFingerprint: string | undefined,
): Promise<{
  readonly persisted: {
    readonly clientId?: string;
    readonly secretHash?: string;
    readonly apiKeyHash?: string;
    readonly certFingerprint?: string;
  };
  readonly secret?: string;
}> {
  if (credentialType === "mtls_cert") {
    const certFingerprint = normalizeCertFingerprint(certificateFingerprint ?? "");
    if (certFingerprint.length !== 64) throw new TypeError("A SHA-256 fingerprint is required.");
    return { persisted: { certFingerprint } };
  }
  if (credentialType === "api_key") {
    const secret = generateApiKey();
    return { persisted: { apiKeyHash: hashApiKey(secret) }, secret };
  }
  const secret = `helix_cs_${getCryptoProvider().randomBytes(32).toString("base64url")}`;
  return {
    persisted: {
      clientId: `helix_client_${getCryptoProvider().randomBytes(18).toString("base64url")}`,
      secretHash: await hashSecret(secret),
    },
    secret,
  };
}

function credentialMutationOutput(
  credential: AgentCredentialInventoryRecord,
  secret: string | undefined,
  tokenEndpoint: string,
): JsonObject {
  return {
    credential: serializeCredential(credential),
    ...(secret === undefined ? {} : { secret }),
    ...(credential.credentialType === "oauth_client"
      ? { grantType: "client_credentials", tokenEndpoint }
      : {}),
  };
}

function serializeCredential(credential: AgentCredentialInventoryRecord): JsonObject {
  return {
    id: credential.id,
    credentialType: credential.credentialType,
    principalType: credential.principalType,
    actorId: credential.actorId,
    orgId: credential.orgId,
    ownerActorId: credential.ownerActorId,
    label: credential.label,
    purpose: credential.purpose,
    scopes: [...credential.scopes],
    clientId: credential.clientId,
    certFingerprint: credential.certFingerprint,
    expiresAt: dateToJson(credential.expiresAt),
    revokedAt: dateToJson(credential.revokedAt),
    createdAt: credential.createdAt.toISOString(),
    rotatedAt: dateToJson(credential.rotatedAt),
    lastUsedAt: dateToJson(credential.lastUsedAt),
  };
}

function normalizeScopes(scopes: readonly string[]): string[] {
  try {
    return parseScope(scopes.join(" "));
  } catch (error) {
    if (error instanceof OAuthError) {
      throw new TypeError(error.message, { cause: error });
    }
    throw error;
  }
}

function assertIssuerScopeCeiling(
  actor: { readonly type: string; readonly scopes?: readonly string[] },
  scopes: readonly string[],
): void {
  if (actor.type === "system") return;
  const held = new Set(actor.scopes ?? []);
  if (held.has("*")) return;
  const unauthorized = normalizeScopes(scopes).filter((scope) => !held.has(scope));
  if (unauthorized.length > 0) throw new CredentialScopeCeilingError(unauthorized);
}

class CredentialScopeCeilingError extends Error {
  readonly statusCode = 403;

  constructor(scopes: readonly string[]) {
    super(`Credential issuer cannot grant scopes it does not hold: ${scopes.join(", ")}`);
    this.name = "CredentialScopeCeilingError";
  }
}

function dateToJson(date: Date | null): string | null {
  return date === null ? null : date.toISOString();
}
