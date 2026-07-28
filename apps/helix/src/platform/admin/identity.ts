import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Actor, JsonObject } from "@helix/sdk-types";
import { z } from "zod3";
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
import type {
  CreateTenantIdpConfigInput,
  TenantIdpConfigRecord,
  TenantIdpConfigStore,
  UpdateTenantIdpConfigInput,
} from "../auth/tenant-idp-configs.js";
import type { OrgRecord, OrgStore } from "../tenancy/orgs.js";

export interface RegisterAdminIdentityRoutesOptions {
  readonly idpConfigs: Pick<
    TenantIdpConfigStore,
    "list" | "get" | "create" | "update" | "delete" | "setPrimary"
  >;
  readonly orgs?: Pick<OrgStore, "findById"> | undefined;
  readonly actorFromRequest: (request: FastifyRequest) => Promise<Actor> | Actor;
  readonly auditSink?: AdminConsoleAuditSink | undefined;
  readonly publicBaseUrl?: string | undefined;
}

export type AdminIdentityIdpConfigView = TenantIdpConfigRecord & {
  readonly samlSpMetadataUrl: string | null;
};

export interface AdminIdentityView {
  readonly idpConfigs: readonly AdminIdentityIdpConfigView[];
  readonly localLoginRecovery: {
    readonly enabled: true;
    readonly scope: "owner_admin_recovery";
  };
}

export type AdminIdentityTestLoginStatus = "configuration_required" | "runtime_pending";

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
        message: "IdP config must reference secrets by Vault path, not inline secret values.",
      });
    }
  });

const tenantVaultPathSchema = z
  .string()
  .trim()
  .min(1)
  .max(500)
  .regex(/^tenants\/[A-Za-z0-9_-]+\/(?:idp|byo-identity)\/[A-Za-z0-9_./-]+$/u, {
    message:
      "Vault path must be scoped under tenants/{tenant}/idp/ or tenants/{tenant}/byo-identity/.",
  })
  .refine((value) => !value.includes("..") && !value.includes("//"), {
    message: "Vault path must not contain traversal or repeated separators.",
  });

const createIdpConfigBody = z
  .object({
    protocol: z.enum(["saml", "oidc"]),
    displayName: z.string().trim().min(1).max(120),
    config: jsonObjectSchema.optional(),
    signingCertVaultPath: tenantVaultPathSchema.nullable().optional(),
    attrMapping: jsonObjectSchema.optional(),
    isPrimary: z.boolean().optional(),
    jitProvisioning: z.boolean().optional(),
    enabled: z.boolean().optional(),
  })
  .strict();

const updateIdpConfigBody = z
  .object({
    protocol: z.enum(["saml", "oidc"]).optional(),
    displayName: z.string().trim().min(1).max(120).optional(),
    config: jsonObjectSchema.optional(),
    signingCertVaultPath: tenantVaultPathSchema.nullable().optional(),
    attrMapping: jsonObjectSchema.optional(),
    isPrimary: z.boolean().optional(),
    jitProvisioning: z.boolean().optional(),
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
    if (!canReadAdminConsole(actor)) {
      return sendForbidden(reply, adminConsoleReadScope);
    }

    const configs = await options.idpConfigs.list(actor.orgId);
    return identityView(configs, {
      org: await options.orgs?.findById(actor.orgId),
      publicBaseUrl: options.publicBaseUrl,
    });
  });

  app.post("/api/admin/identity/idp-configs", async (request, reply) => {
    const actor = await options.actorFromRequest(request);
    if (!canWriteAdminConsole(actor)) {
      return sendForbidden(reply, adminConsoleWriteScope);
    }
    const body = createIdpConfigBody.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send(invalidRequest("Invalid tenant IdP config.", body.error.issues));
    }

    const input: CreateTenantIdpConfigInput = {
      orgId: actor.orgId,
      protocol: body.data.protocol,
      displayName: body.data.displayName,
      config: toJsonObject(body.data.config ?? {}),
      signingCertVaultPath: body.data.signingCertVaultPath ?? null,
      attrMapping: toJsonObject(body.data.attrMapping ?? {}),
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
      idpConfig: idpConfigView(config, {
        org: await options.orgs?.findById(actor.orgId),
        publicBaseUrl: options.publicBaseUrl,
      }),
      localLoginRecovery: localLoginRecoveryView(),
    });
  });

  app.patch("/api/admin/identity/idp-configs/:id", async (request, reply) => {
    const actor = await options.actorFromRequest(request);
    if (!canWriteAdminConsole(actor)) {
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

    const input: UpdateTenantIdpConfigInput = {
      orgId: actor.orgId,
      id: params.data.id,
      ...(body.data.protocol === undefined ? {} : { protocol: body.data.protocol }),
      ...(body.data.displayName === undefined ? {} : { displayName: body.data.displayName }),
      ...(body.data.config === undefined ? {} : { config: toJsonObject(body.data.config) }),
      ...(body.data.signingCertVaultPath === undefined
        ? {}
        : { signingCertVaultPath: body.data.signingCertVaultPath }),
      ...(body.data.attrMapping === undefined
        ? {}
        : { attrMapping: toJsonObject(body.data.attrMapping) }),
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
      idpConfig: idpConfigView(config, {
        org: await options.orgs?.findById(actor.orgId),
        publicBaseUrl: options.publicBaseUrl,
      }),
      localLoginRecovery: localLoginRecoveryView(),
    };
  });

  app.delete("/api/admin/identity/idp-configs/:id", async (request, reply) => {
    const actor = await options.actorFromRequest(request);
    if (!canWriteAdminConsole(actor)) {
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
      idpConfig: idpConfigView(config, {
        org: await options.orgs?.findById(actor.orgId),
        publicBaseUrl: options.publicBaseUrl,
      }),
      localLoginRecovery: localLoginRecoveryView(),
    };
  });

  app.post("/api/admin/identity/idp-configs/:id/primary", async (request, reply) => {
    const actor = await options.actorFromRequest(request);
    if (!canWriteAdminConsole(actor)) {
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
      idpConfig: idpConfigView(config, {
        org: await options.orgs?.findById(actor.orgId),
        publicBaseUrl: options.publicBaseUrl,
      }),
      localLoginRecovery: localLoginRecoveryView(),
    };
  });

  app.post("/api/admin/identity/idp-configs/:id/test-login", async (request, reply) => {
    const actor = await options.actorFromRequest(request);
    if (!canWriteAdminConsole(actor)) {
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

    const testLogin = testTenantIdpConfigLogin(config);
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

function identityView(
  configs: readonly TenantIdpConfigRecord[],
  options: {
    readonly org?: OrgRecord | null | undefined;
    readonly publicBaseUrl?: string | undefined;
  },
): AdminIdentityView {
  return {
    idpConfigs: configs.map((config) => idpConfigView(config, options)),
    localLoginRecovery: localLoginRecoveryView(),
  };
}

function idpConfigView(
  config: TenantIdpConfigRecord,
  options: {
    readonly org?: Pick<OrgRecord, "slug"> | null | undefined;
    readonly publicBaseUrl?: string | undefined;
  },
): AdminIdentityIdpConfigView {
  return {
    ...config,
    samlSpMetadataUrl: samlSpMetadataUrl(config, options),
  };
}

function samlSpMetadataUrl(
  config: TenantIdpConfigRecord,
  options: {
    readonly org?: Pick<OrgRecord, "slug"> | null | undefined;
    readonly publicBaseUrl?: string | undefined;
  },
): string | null {
  if (config.protocol !== "saml" || !config.enabled || !config.isPrimary || options.org === null) {
    return null;
  }
  const slug = options.org?.slug;
  if (slug === undefined || slug.length === 0) {
    return null;
  }
  const baseUrl = (options.publicBaseUrl ?? "").replace(/\/+$/u, "");
  const path = `/api/auth/saml/${encodeURIComponent(slug)}/metadata`;
  return baseUrl.length === 0 ? path : `${baseUrl}${path}`;
}

function localLoginRecoveryView(): AdminIdentityView["localLoginRecovery"] {
  return {
    enabled: true,
    scope: "owner_admin_recovery",
  };
}

function toJsonObject(value: unknown): JsonObject {
  return JSON.parse(JSON.stringify(value)) as JsonObject;
}

function idpConfigConflictMessage(error: unknown): string {
  return error instanceof Error && error.message.length > 0
    ? error.message
    : "Tenant IdP config could not be created.";
}

export function testTenantIdpConfigLogin(
  config: TenantIdpConfigRecord,
): AdminIdentityTestLoginResult {
  if (!config.enabled) {
    return {
      status: "configuration_required",
      message: "Enable this IdP config before testing login readiness.",
    };
  }
  if (config.protocol === "saml") {
    const metadataUrl = stringConfig(config.config, "metadataUrl");
    const entityId = stringConfig(config.config, "entityId");
    const ssoUrl = stringConfig(config.config, "ssoUrl");
    if (metadataUrl === undefined && (entityId === undefined || ssoUrl === undefined)) {
      return {
        status: "configuration_required",
        message: "SAML metadata URL or static entity ID and SSO URL are required.",
      };
    }
    return {
      status: "runtime_pending",
      message:
        "SAML configuration is ready. Runtime AuthnRequest/ACS handling is not connected yet.",
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
  return {
    status: "runtime_pending",
    message:
      "OIDC configuration is ready. Runtime authorization callback handling is not connected yet.",
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
      (normalized.includes("secret") ||
        normalized.includes("password") ||
        normalized.includes("private_key")) &&
      !normalized.endsWith("vault_path")
    ) {
      paths.push(childPath);
    }
    visitSecretKeys(child, childPath, paths);
  }
}
