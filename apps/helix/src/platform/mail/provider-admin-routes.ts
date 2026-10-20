import type { DomainsStore } from "../admin/domains.js";
import type { OutboundProviderConfig } from "./providers.js";
import type { Actor } from "@helix/sdk-types";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  canWriteAdminConsole,
  sendForbidden,
  auditAdminAction,
  type AdminConsoleAuditSink,
} from "../admin/console-shared.js";
import { MailAdminConflictError, type OutboundProviderStore } from "./admin-store.js";
import type { MailProviderCredentials } from "./provider-credentials.js";
import { resolveMailProviderSecret, type MailSecretProvider } from "./outbound-routing.js";
import { checkMailProvider } from "./provider-checks.js";

const paramsSchema = z.object({ id: z.string().uuid() });
const credentialSchema = z
  .object({
    purpose: z.enum(["sending", "feedback"]),
    value: z.string().min(1).max(16384).nullable(),
  })
  .strict();

export async function registerMailProviderAdminRoutes(
  app: FastifyInstance,
  options: {
    readonly providers: OutboundProviderStore;
    readonly credentials: MailProviderCredentials;
    readonly secrets: MailSecretProvider;
    readonly actorFromRequest: (request: FastifyRequest) => Promise<Actor> | Actor;
    readonly auditSink: AdminConsoleAuditSink;
    readonly check?: typeof checkMailProvider;
  },
): Promise<void> {
  for (const action of ["credentials", "check"] as const) {
    app.post(`/api/admin/mail/providers/:id/${action}`, async (request, reply) => {
      const actor = await options.actorFromRequest(request);
      if (
        !canWriteAdminConsole(actor, "mail.admin", {
          type: "product",
          id: "mail",
          orgId: actor.orgId,
        })
      )
        return sendForbidden(reply, "mail.admin");
      const params = paramsSchema.safeParse(request.params);
      if (!params.success) return reply.code(400).send({ error: "Invalid provider id." });
      const provider = await options.providers.getProvider(actor.orgId, params.data.id);
      if (provider === null) return reply.code(404).send({ error: "Provider not found." });
      if (action === "credentials") {
        const body = credentialSchema.safeParse(request.body);
        if (!body.success)
          return reply.code(400).send({ error: "Enter a valid credential, or null to remove it." });
        if (
          !(await options.credentials.write(
            actor.orgId,
            provider.id,
            body.data.purpose,
            body.data.value,
          ))
        )
          return reply.code(404).send({ error: "Provider not found." });
        await auditAdminAction(options.auditSink, {
          orgId: actor.orgId,
          actorId: actor.id,
          verb: "mail.provider.credential.updated",
          objectType: "mail_outbound_provider",
          objectId: provider.id,
          metadata: { purpose: body.data.purpose, removed: body.data.value === null },
        });
        return { saved: true };
      }
      let ok = false;
      try {
        const secret = await resolveMailProviderSecret(options.secrets, provider, "sending");
        await (options.check ?? checkMailProvider)(provider, secret);
        ok = true;
      } catch {
        /* Provider errors may contain credentials; return fixed actionable guidance. */
      }
      await auditAdminAction(options.auditSink, {
        orgId: actor.orgId,
        actorId: actor.id,
        verb: "mail.provider.connection.checked",
        objectType: "mail_outbound_provider",
        objectId: provider.id,
        metadata: { ok },
      });
      return reply.code(ok ? 200 : 422).send(
        ok
          ? {
              ok: true,
              checkedAt: new Date().toISOString(),
              message:
                "Connection and credentials verified. No email was sent; domain signing and recipient delivery are not verified.",
            }
          : {
              error:
                "Connection check failed. Check the endpoint, TLS settings, credential and provider permissions.",
            },
      );
    });
  }
}

export function serializeProvider(provider: OutboundProviderConfig): Record<string, unknown> {
  return {
    id: provider.id,
    orgId: provider.orgId,
    name: provider.name,
    kind: provider.kind,
    enabled: provider.enabled,
    isDefault: provider.isDefault,
    config: provider.config,
    // Only opaque tenant secret handles are surfaced.
    secretRef: provider.secretRef,
    hasSecret: provider.secretRef !== null,
    webhookSecretRef: provider.webhookSecretRef,
    hasWebhookSecret: provider.webhookSecretRef !== null,
    createdAt: provider.createdAt,
    updatedAt: provider.updatedAt,
  };
}

export async function deleteUnusedMailProvider(
  providers: OutboundProviderStore,
  domains: Pick<DomainsStore, "listDomains">,
  orgId: string,
  id: string,
): Promise<boolean> {
  if ((await providers.getProvider(orgId, id))?.isDefault)
    throw new MailAdminConflictError("Choose another default provider before deleting this one.");
  if ((await domains.listDomains(orgId)).some((domain) => domain.providerId === id))
    throw new MailAdminConflictError("Move this provider's domain assignments before deleting it.");
  try {
    return await providers.deleteProvider(orgId, id);
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "23503")
      throw new MailAdminConflictError(
        "This provider has domain assignments or delivery history. Disable it instead, or move its assignments first.",
      );
    throw error;
  }
}
