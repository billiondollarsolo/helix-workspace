import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod3";
import { invalidRequest, notFound } from "../admin/console-shared.js";
import type { OrgStore } from "../tenancy/orgs.js";
import type { TenantIdpConfigStore } from "./tenant-idp-configs.js";

export interface RegisterTenantSamlRoutesOptions {
  readonly orgs: Pick<OrgStore, "findBySlug">;
  readonly idpConfigs: Pick<TenantIdpConfigStore, "getPrimary">;
  readonly publicBaseUrl?: string | undefined;
}

const samlTenantParams = z.object({
  tenantSlug: z
    .string()
    .min(1)
    .max(63)
    .regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u),
});

export async function registerTenantSamlRoutes(
  app: FastifyInstance,
  options: RegisterTenantSamlRoutesOptions,
): Promise<void> {
  app.get("/api/auth/saml/:tenantSlug/metadata", async (request, reply) => {
    const params = samlTenantParams.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send(invalidRequest("Invalid SAML tenant slug.", params.error.issues));
    }

    const org = await options.orgs.findBySlug(params.data.tenantSlug);
    if (org === null || org.status !== "active") {
      return reply.code(404).send(notFound("SAML tenant was not found."));
    }

    const idpConfig = await options.idpConfigs.getPrimary(org.id);
    if (idpConfig === null || idpConfig.protocol !== "saml") {
      return reply.code(404).send(notFound("SAML IdP config was not found."));
    }

    const metadata = renderSamlServiceProviderMetadata({
      baseUrl: options.publicBaseUrl ?? originFromRequest(request),
      tenantSlug: org.slug,
    });

    return reply
      .code(200)
      .header("content-type", "application/samlmetadata+xml; charset=utf-8")
      .header("cache-control", "no-store")
      .send(metadata);
  });
}

export function renderSamlServiceProviderMetadata(input: {
  readonly baseUrl: string;
  readonly tenantSlug: string;
}): string {
  const baseUrl = input.baseUrl.replace(/\/+$/u, "");
  const pathTenant = encodeURIComponent(input.tenantSlug);
  const entityId = `${baseUrl}/api/auth/saml/${pathTenant}/metadata`;
  const acsUrl = `${baseUrl}/api/auth/saml/${pathTenant}/acs`;
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata" entityID="${escapeXmlAttribute(entityId)}">`,
    '  <md:SPSSODescriptor protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol" AuthnRequestsSigned="false" WantAssertionsSigned="true">',
    "    <md:NameIDFormat>urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress</md:NameIDFormat>",
    `    <md:AssertionConsumerService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="${escapeXmlAttribute(acsUrl)}" index="0" isDefault="true"/>`,
    "  </md:SPSSODescriptor>",
    "</md:EntityDescriptor>",
    "",
  ].join("\n");
}

function originFromRequest(request: FastifyRequest): string {
  const forwardedProto = firstHeader(request.headers["x-forwarded-proto"]);
  const proto = forwardedProto?.split(",")[0]?.trim() || "https";
  const host =
    firstHeader(request.headers["x-forwarded-host"]) ?? firstHeader(request.headers.host);
  return `${proto}://${host ?? "localhost"}`;
}

function firstHeader(value: string | readonly string[] | undefined): string | undefined {
  return typeof value === "string" ? value : value?.[0];
}

function escapeXmlAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
