import type { Actor, JsonObject } from "@helix/sdk-types";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  parseTenantIdpAttributeMapping,
  parseTenantIdpPublicConfig,
  type CreateTenantIdpConfigInput,
  type TenantIdpConfigRecord,
  type TenantIdpConfigStore,
  type UpdateTenantIdpConfigInput,
} from "../auth/tenant-idp-configs.js";
import {
  adminConsoleReadScope,
  adminConsoleWriteScope,
  auditAdminAction,
  canReadAdminConsole,
  canWriteAdminConsole,
  conflict,
  invalidRequest,
  notFound,
  sendForbidden,
  type AdminConsoleAuditSink,
} from "./console-shared.js";

export interface RegisterAdminIdentityRoutesOptions {
  readonly idpConfigs: Pick<
    TenantIdpConfigStore,
    "list" | "get" | "create" | "update" | "delete" | "setPrimary" | "runtimeReady"
  >;
  readonly actorFromRequest: (request: FastifyRequest) => Promise<Actor> | Actor;
  readonly auditSink: AdminConsoleAuditSink;
}

type AdminIdentityIdpConfigView = TenantIdpConfigRecord;

interface AdminIdentityView {
  readonly idpConfigs: readonly AdminIdentityIdpConfigView[];
  readonly localLoginRecovery: {
    readonly enabled: true;
    readonly scope: "owner_admin_recovery";
  };
}

type AdminIdentityTestLoginStatus = "configuration_required" | "ready";

export interface AdminIdentityTestLoginResult {
  readonly status: AdminIdentityTestLoginStatus;
  readonly message: string;
}

const idpConfigIdParams = z.object({
  id: z.string().trim().min(1).max(200),
});

const jsonObjectSchema = z
  .record(z.string(), z.unknown())
  .default({})
  .superRefine((value, ctx) => {
    for (const path of plaintextSecretPaths(value)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path,
        message:
          "IdP config must use the dedicated opaque secret handle, not secret values or paths.",
      });
    }
  });

const tenantSecretHandleSchema = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .regex(/^[a-z0-9](?:[a-z0-9._-]{0,98}[a-z0-9])?$/u, {
    message: "Secret handle must be a canonical lowercase identifier.",
  });

const createIdpConfigBody = z
  .object({
    protocol: z.literal("oidc"),
    displayName: z.string().trim().min(1).max(120),
    config: jsonObjectSchema.optional(),
    signingCertSecretHandle: tenantSecretHandleSchema.nullable().optional(),
    attrMapping: jsonObjectSchema.optional(),
    isPrimary: z.boolean().optional(),
    jitProvisioning: z.literal(false).optional(),
    enabled: z.boolean().optional(),
  })
  .strict();

const updateIdpConfigBody = z
  .object({
    protocol: z.literal("oidc").optional(),
    displayName: z.string().trim().min(1).max(120).optional(),
    config: jsonObjectSchema.optional(),
    signingCertSecretHandle: tenantSecretHandleSchema.nullable().optional(),
    attrMapping: jsonObjectSchema.optional(),
    isPrimary: z.boolean().optional(),
    jitProvisioning: z.literal(false).optional(),
    enabled: z.boolean().optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    message: "At least one IdP config field must be updated.",
  });

export async function registerAdminIdentityRoutes(
  app: FastifyInstance,
  options: RegisterAdminIdentityRoutesOptions,
): Promise<void> {
  app.get("/api/admin/identity/idp-configs", async (request, reply) => {
    const actor = await options.actorFromRequest(request);
    if (!canReadAdminConsole(actor, "admin.security")) {
      return sendForbidden(reply, adminConsoleReadScope);
    }

    const configs = await options.idpConfigs.list(actor.orgId);
    return identityView(configs);
  });

  app.post("/api/admin/identity/idp-configs", async (request, reply) => {
    const actor = await options.actorFromRequest(request);
    if (!canWriteAdminConsole(actor, "admin.security")) {
      return sendForbidden(reply, adminConsoleWriteScope);
    }
    const body = createIdpConfigBody.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send(invalidRequest("Invalid tenant IdP config.", body.error.issues));
    }

    let publicConfig: JsonObject;
    let attrMapping: JsonObject;
    try {
      publicConfig = parseTenantIdpPublicConfig(body.data.protocol, body.data.config ?? {});
      attrMapping = parseTenantIdpAttributeMapping(body.data.attrMapping ?? {});
    } catch (error) {
      return reply
        .code(400)
        .send(invalidRequest(error instanceof Error ? error.message : "Invalid IdP config."));
    }
    const input: CreateTenantIdpConfigInput = {
      orgId: actor.orgId,
      protocol: body.data.protocol,
      displayName: body.data.displayName,
      config: publicConfig,
      signingCertSecretHandle: body.data.signingCertSecretHandle ?? null,
      attrMapping,
      ...(body.data.isPrimary === undefined ? {} : { isPrimary: body.data.isPrimary }),
      ...(body.data.jitProvisioning === undefined
        ? {}
        : { jitProvisioning: body.data.jitProvisioning }),
      ...(body.data.enabled === undefined ? {} : { enabled: body.data.enabled }),
    };

    let config: TenantIdpConfigRecord;
    try {
      config = await options.idpConfigs.create(input);
    } catch (error) {
      return reply.code(409).send(conflict(idpConfigConflictMessage(error)));
    }

    await auditAdminAction(options.auditSink, {
      orgId: actor.orgId,
      actorId: actor.id,
      verb: "admin.identity.idp_config.created",
      objectType: "tenant_idp_config",
      objectId: config.id,
      metadata: {
        protocol: config.protocol,
        isPrimary: config.isPrimary,
        enabled: config.enabled,
      },
    });

    return reply.code(201).send({
      idpConfig: config,
      localLoginRecovery: localLoginRecoveryView(),
    });
  });

  app.patch("/api/admin/identity/idp-configs/:id", async (request, reply) => {
    const actor = await options.actorFromRequest(request);
    if (!canWriteAdminConsole(actor, "admin.security")) {
      return sendForbidden(reply, adminConsoleWriteScope);
    }
    const params = idpConfigIdParams.safeParse(request.params);
    if (!params.success) {
      return reply
        .code(400)
        .send(invalidRequest("Invalid tenant IdP config id.", params.error.issues));
    }
    const body = updateIdpConfigBody.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send(invalidRequest("Invalid tenant IdP config.", body.error.issues));
    }

    const current = await options.idpConfigs.get(actor.orgId, params.data.id);
    if (current === null) {
      return reply.code(404).send(notFound("Tenant IdP config not found."));
    }
    let publicConfig: JsonObject;
    let attrMapping: JsonObject | undefined;
    try {
      publicConfig = parseTenantIdpPublicConfig(
        body.data.protocol ?? current.protocol,
        body.data.config ?? current.config,
      );
      attrMapping =
        body.data.attrMapping === undefined
          ? undefined
          : parseTenantIdpAttributeMapping(body.data.attrMapping);
    } catch (error) {
      return reply
        .code(400)
        .send(invalidRequest(error instanceof Error ? error.message : "Invalid IdP config."));
    }

    const input: UpdateTenantIdpConfigInput = {
      orgId: actor.orgId,
      id: params.data.id,
      ...(body.data.protocol === undefined ? {} : { protocol: body.data.protocol }),
      ...(body.data.displayName === undefined ? {} : { displayName: body.data.displayName }),
      config: publicConfig,
      ...(body.data.signingCertSecretHandle === undefined
        ? {}
        : { signingCertSecretHandle: body.data.signingCertSecretHandle }),
      ...(body.data.attrMapping === undefined ? {} : { attrMapping }),
      ...(body.data.isPrimary === undefined ? {} : { isPrimary: body.data.isPrimary }),
      ...(body.data.jitProvisioning === undefined
        ? {}
        : { jitProvisioning: body.data.jitProvisioning }),
      ...(body.data.enabled === undefined ? {} : { enabled: body.data.enabled }),
    };

    const config = await options.idpConfigs.update(input);
    if (config === null) {
      return reply.code(404).send(notFound("Tenant IdP config not found."));
    }

    await auditAdminAction(options.auditSink, {
      orgId: actor.orgId,
      actorId: actor.id,
      verb: "admin.identity.idp_config.updated",
      objectType: "tenant_idp_config",
      objectId: config.id,
      metadata: {
        protocol: config.protocol,
        isPrimary: config.isPrimary,
        enabled: config.enabled,
        changedFields: Object.keys(body.data).sort(),
      },
    });

    return {
      idpConfig: config,
      localLoginRecovery: localLoginRecoveryView(),
    };
  });

  app.delete("/api/admin/identity/idp-configs/:id", async (request, reply) => {
    const actor = await options.actorFromRequest(request);
    if (!canWriteAdminConsole(actor, "admin.security")) {
      return sendForbidden(reply, adminConsoleWriteScope);
    }
    const params = idpConfigIdParams.safeParse(request.params);
    if (!params.success) {
      return reply
        .code(400)
        .send(invalidRequest("Invalid tenant IdP config id.", params.error.issues));
    }

    const config = await options.idpConfigs.delete(actor.orgId, params.data.id);
    if (config === null) {
      return reply.code(404).send(notFound("Tenant IdP config not found."));
    }

    await auditAdminAction(options.auditSink, {
      orgId: actor.orgId,
      actorId: actor.id,
      verb: "admin.identity.idp_config.deleted",
      objectType: "tenant_idp_config",
      objectId: config.id,
      metadata: {
        protocol: config.protocol,
        wasPrimary: config.isPrimary,
        wasEnabled: config.enabled,
      },
    });

    return {
      idpConfig: config,
      localLoginRecovery: localLoginRecoveryView(),
    };
  });

  app.post("/api/admin/identity/idp-configs/:id/primary", async (request, reply) => {
    const actor = await options.actorFromRequest(request);
    if (!canWriteAdminConsole(actor, "admin.security")) {
      return sendForbidden(reply, adminConsoleWriteScope);
    }
    const params = idpConfigIdParams.safeParse(request.params);
    if (!params.success) {
      return reply
        .code(400)
        .send(invalidRequest("Invalid tenant IdP config id.", params.error.issues));
    }

    const config = await options.idpConfigs.setPrimary(actor.orgId, params.data.id);
    if (config === null) {
      return reply.code(404).send(notFound("Tenant IdP config not found."));
    }

    await auditAdminAction(options.auditSink, {
      orgId: actor.orgId,
      actorId: actor.id,
      verb: "admin.identity.idp_config.primary_set",
      objectType: "tenant_idp_config",
      objectId: config.id,
      metadata: {
        protocol: config.protocol,
      },
    });

    return {
      idpConfig: config,
      localLoginRecovery: localLoginRecoveryView(),
    };
  });

  app.post("/api/admin/identity/idp-configs/:id/test-login", async (request, reply) => {
    const actor = await options.actorFromRequest(request);
    if (!canWriteAdminConsole(actor, "admin.security")) {
      return sendForbidden(reply, adminConsoleWriteScope);
    }
    const params = idpConfigIdParams.safeParse(request.params);
    if (!params.success) {
      return reply
        .code(400)
        .send(invalidRequest("Invalid tenant IdP config id.", params.error.issues));
    }

    const config = await options.idpConfigs.get(actor.orgId, params.data.id);
    if (config === null) {
      return reply.code(404).send(notFound("Tenant IdP config not found."));
    }

    const testLogin = testTenantIdpConfigLogin(
      config,
      await options.idpConfigs.runtimeReady(actor.orgId, config.id),
    );
    await auditAdminAction(options.auditSink, {
      orgId: actor.orgId,
      actorId: actor.id,
      verb: "admin.identity.idp_config.test_login_checked",
      objectType: "tenant_idp_config",
      objectId: config.id,
      metadata: {
        protocol: config.protocol,
        status: testLogin.status,
      },
    });

    return {
      testLogin,
      localLoginRecovery: localLoginRecoveryView(),
    };
  });
}

function identityView(configs: readonly TenantIdpConfigRecord[]): AdminIdentityView {
  return {
    idpConfigs: configs,
    localLoginRecovery: localLoginRecoveryView(),
  };
}

function localLoginRecoveryView(): AdminIdentityView["localLoginRecovery"] {
  return {
    enabled: true,
    scope: "owner_admin_recovery",
  };
}

function idpConfigConflictMessage(error: unknown): string {
  return error instanceof Error && error.message.length > 0
    ? error.message
    : "Tenant IdP config could not be created.";
}

export function testTenantIdpConfigLogin(
  config: TenantIdpConfigRecord,
  runtimeReady: boolean,
): AdminIdentityTestLoginResult {
  if (!config.enabled) {
    return {
      status: "configuration_required",
      message: "Enable this IdP config before testing login readiness.",
    };
  }
  const issuer =
    stringConfig(config.config, "issuer") ?? stringConfig(config.config, "metadataUrl");
  const clientId = stringConfig(config.config, "clientId");
  if (issuer === undefined || clientId === undefined) {
    return {
      status: "configuration_required",
      message: "OIDC issuer/discovery URL and client ID are required.",
    };
  }
  if (config.signingCertSecretHandle === null) {
    return {
      status: "configuration_required",
      message: "A tenant Vault handle for the OIDC private-key client credential is required.",
    };
  }
  if (!runtimeReady) {
    return {
      status: "configuration_required",
      message: "Enable this primary IdP on a verified federation domain before testing login.",
    };
  }
  return {
    status: "ready",
    message:
      "OIDC discovery, PKCE, signed callback validation, and tenant session routing are ready.",
  };
}

function stringConfig(config: JsonObject, key: string): string | undefined {
  const value = config[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function plaintextSecretPaths(value: Record<string, unknown>): Array<Array<string | number>> {
  const paths: Array<Array<string | number>> = [];
  visitSecretKeys(value, [], paths);
  return paths;
}

function visitSecretKeys(
  value: unknown,
  path: Array<string | number>,
  paths: Array<Array<string | number>>,
): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      visitSecretKeys(item, [...path, index], paths);
    });
    return;
  }
  if (typeof value !== "object" || value === null) {
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    const childPath = [...path, key];
    const normalized = key.toLowerCase();
    if (
      normalized.includes("secret") ||
      normalized.includes("password") ||
      normalized.includes("private_key") ||
      normalized.includes("vault")
    ) {
      paths.push(childPath);
    }
    visitSecretKeys(child, childPath, paths);
  }
}
