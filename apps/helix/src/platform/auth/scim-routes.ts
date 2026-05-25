import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { OrgStore } from "../tenancy/orgs.js";

export interface RegisterTenantScimRoutesOptions {
  readonly orgs: Pick<OrgStore, "findBySlug">;
  readonly documentationUri?: string | undefined;
}

const scimTenantParams = z.object({
  tenantSlug: z
    .string()
    .min(1)
    .max(63)
    .regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u),
});

const SCIM_JSON = "application/scim+json; charset=utf-8";
const LIST_RESPONSE_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:ListResponse";
const ERROR_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:Error";

export async function registerTenantScimRoutes(
  app: FastifyInstance,
  options: RegisterTenantScimRoutesOptions,
): Promise<void> {
  app.get("/api/scim/v2/:tenantSlug/ServiceProviderConfig", async (request, reply) => {
    const tenant = await resolveActiveScimTenant(request.params, options);
    if (!tenant.success) {
      return reply.code(tenant.status).header("content-type", SCIM_JSON).send(tenant.body);
    }
    return reply
      .code(200)
      .header("content-type", SCIM_JSON)
      .header("cache-control", "no-store")
      .send(serviceProviderConfig(options.documentationUri));
  });

  app.get("/api/scim/v2/:tenantSlug/ResourceTypes", async (request, reply) => {
    const tenant = await resolveActiveScimTenant(request.params, options);
    if (!tenant.success) {
      return reply.code(tenant.status).header("content-type", SCIM_JSON).send(tenant.body);
    }
    return reply
      .code(200)
      .header("content-type", SCIM_JSON)
      .header("cache-control", "no-store")
      .send(scimListResponse(resourceTypes(tenant.slug)));
  });

  app.get("/api/scim/v2/:tenantSlug/Schemas", async (request, reply) => {
    const tenant = await resolveActiveScimTenant(request.params, options);
    if (!tenant.success) {
      return reply.code(tenant.status).header("content-type", SCIM_JSON).send(tenant.body);
    }
    return reply
      .code(200)
      .header("content-type", SCIM_JSON)
      .header("cache-control", "no-store")
      .send(scimListResponse(scimSchemas()));
  });

  app.route({
    method: ["GET", "POST", "PUT", "PATCH", "DELETE"],
    url: "/api/scim/v2/:tenantSlug/Users",
    handler: async (request, reply) => {
      const tenant = await resolveActiveScimTenant(request.params, options);
      if (!tenant.success) {
        return reply.code(tenant.status).header("content-type", SCIM_JSON).send(tenant.body);
      }
      return reply
        .code(501)
        .header("content-type", SCIM_JSON)
        .send(scimError(501, "Users SCIM provisioning is not implemented yet."));
    },
  });

  app.route({
    method: ["GET", "POST", "PUT", "PATCH", "DELETE"],
    url: "/api/scim/v2/:tenantSlug/Groups",
    handler: async (request, reply) => {
      const tenant = await resolveActiveScimTenant(request.params, options);
      if (!tenant.success) {
        return reply.code(tenant.status).header("content-type", SCIM_JSON).send(tenant.body);
      }
      return reply
        .code(501)
        .header("content-type", SCIM_JSON)
        .send(scimError(501, "Groups SCIM provisioning is not implemented yet."));
    },
  });
}

function serviceProviderConfig(documentationUri: string | undefined) {
  return {
    schemas: ["urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig"],
    ...(documentationUri === undefined ? {} : { documentationUri }),
    patch: { supported: false },
    bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
    filter: { supported: false, maxResults: 0 },
    changePassword: { supported: false },
    sort: { supported: false },
    etag: { supported: false },
    authenticationSchemes: [
      {
        type: "oauthbearertoken",
        name: "OAuth Bearer Token",
        description:
          "Per-tenant SCIM bearer token. Rotation UI and provisioning writes are pending.",
        specUri: "https://www.rfc-editor.org/rfc/rfc6750",
        primary: true,
      },
    ],
  };
}

function resourceTypes(tenantSlug: string) {
  return [
    {
      schemas: ["urn:ietf:params:scim:schemas:core:2.0:ResourceType"],
      id: "User",
      name: "User",
      endpoint: `/api/scim/v2/${tenantSlug}/Users`,
      schema: "urn:ietf:params:scim:schemas:core:2.0:User",
      schemaExtensions: [],
    },
    {
      schemas: ["urn:ietf:params:scim:schemas:core:2.0:ResourceType"],
      id: "Group",
      name: "Group",
      endpoint: `/api/scim/v2/${tenantSlug}/Groups`,
      schema: "urn:ietf:params:scim:schemas:core:2.0:Group",
      schemaExtensions: [],
    },
  ];
}

function scimSchemas() {
  return [
    {
      id: "urn:ietf:params:scim:schemas:core:2.0:User",
      name: "User",
      description: "User account representation. CRUD provisioning is pending.",
      attributes: [
        {
          name: "userName",
          type: "string",
          multiValued: false,
          required: true,
          mutability: "readWrite",
        },
        {
          name: "active",
          type: "boolean",
          multiValued: false,
          required: false,
          mutability: "readWrite",
        },
        {
          name: "name",
          type: "complex",
          multiValued: false,
          required: false,
          mutability: "readWrite",
        },
        {
          name: "emails",
          type: "complex",
          multiValued: true,
          required: false,
          mutability: "readWrite",
        },
        {
          name: "externalId",
          type: "string",
          multiValued: false,
          required: false,
          mutability: "readWrite",
        },
      ],
    },
    {
      id: "urn:ietf:params:scim:schemas:core:2.0:Group",
      name: "Group",
      description: "Group representation. CRUD provisioning is pending.",
      attributes: [
        {
          name: "displayName",
          type: "string",
          multiValued: false,
          required: true,
          mutability: "readWrite",
        },
        {
          name: "members",
          type: "complex",
          multiValued: true,
          required: false,
          mutability: "readWrite",
        },
        {
          name: "externalId",
          type: "string",
          multiValued: false,
          required: false,
          mutability: "readWrite",
        },
      ],
    },
  ];
}

function scimListResponse<T>(resources: readonly T[]) {
  return {
    schemas: [LIST_RESPONSE_SCHEMA],
    totalResults: resources.length,
    startIndex: 1,
    itemsPerPage: resources.length,
    Resources: resources,
  };
}

async function resolveActiveScimTenant(
  params: unknown,
  options: RegisterTenantScimRoutesOptions,
): Promise<
  | { readonly success: true; readonly id: string; readonly slug: string }
  | { readonly success: false; readonly status: number; readonly body: unknown }
> {
  const parsed = scimTenantParams.safeParse(params);
  if (!parsed.success) {
    return {
      success: false,
      status: 400,
      body: scimError(400, "Invalid SCIM tenant slug."),
    };
  }
  const org = await options.orgs.findBySlug(parsed.data.tenantSlug);
  if (org === null || org.status !== "active") {
    return {
      success: false,
      status: 404,
      body: scimError(404, "SCIM tenant was not found."),
    };
  }
  return { success: true, id: org.id, slug: org.slug };
}

function scimError(status: number, detail: string) {
  return {
    schemas: [ERROR_SCHEMA],
    status: String(status),
    detail,
  };
}
