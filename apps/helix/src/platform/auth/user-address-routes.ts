import type { Actor } from "@helix/sdk-types";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  BadRequestError,
  ForbiddenError,
  NotFoundError,
  UnauthorizedError,
} from "../../api/api-error.js";
import { actorHasScope } from "../../api/scopes.js";
import {
  auditAdminAction,
  canReadAdminConsole,
  canWriteAdminConsole,
  type AdminConsoleAuditSink,
} from "../admin/console-shared.js";
import { assertActorMatchesRequestTenant } from "../tenancy/middleware.js";
import { setTenantPostgresActorId } from "../tenancy/postgres-roles.js";
import type { PostgresUserAddressStore } from "./user-addresses.js";

const addressSchema = z.string().trim().min(3).max(320);
const modes = z
  .object({ receiveEnabled: z.boolean().optional(), sendAsEnabled: z.boolean().optional() })
  .strict();
const paramsSchema = z.object({
  actorId: z.string().uuid(),
  addressId: z.string().uuid().optional(),
});

export function registerUserAddressRoutes(
  app: FastifyInstance,
  options: {
    store: Pick<PostgresUserAddressStore, "get" | "create" | "update" | "remove" | "setPrimary">;
    actorFromRequest: (request: FastifyRequest) => Actor | Promise<Actor>;
    auditSink: AdminConsoleAuditSink;
  },
): void {
  app.get("/api/mail/addresses", async (request) => {
    const actor = await principal(request);
    if (actor.type !== "user" || !actorHasScope(actor, "mail.read"))
      throw new ForbiddenError("Mail access is required.");
    const result = await options.store.get(actor.orgId, actor.id);
    if (result === null) throw new NotFoundError("Active member mailbox not found.");
    return result;
  });
  for (const action of ["get", "create", "update", "remove", "setPrimary"] as const) {
    app.route({
      method: { get: "GET", create: "POST", update: "PATCH", remove: "DELETE", setPrimary: "PUT" }[
        action
      ],
      url:
        "/api/admin/users/:actorId/addresses" +
        (action === "setPrimary"
          ? "/primary"
          : action === "update" || action === "remove"
            ? "/:addressId"
            : ""),
      async handler(request, reply) {
        const actor = await principal(request);
        const allowed = action === "get" ? canReadAdminConsole : canWriteAdminConsole;
        if (!allowed(actor, "admin.users"))
          throw new ForbiddenError("User administration permission is required.");
        const params = paramsSchema.safeParse(request.params);
        if (!params.success) throw new BadRequestError("Invalid user or address ID.");
        const target = params.data.actorId;
        const addressId = params.data.addressId;
        if ((action === "update" || action === "remove") && addressId === undefined)
          throw new BadRequestError("Invalid address ID.");
        let result;
        if (action === "get") result = await options.store.get(actor.orgId, target);
        else if (action === "remove")
          result = await options.store.remove(actor.orgId, target, addressId ?? "");
        else if (action === "setPrimary") {
          const body = z.object({ address: addressSchema }).strict().safeParse(request.body);
          if (!body.success) throw new BadRequestError("Enter the new primary mail address.");
          result = await options.store.setPrimary(actor.orgId, target, body.data);
        } else if (action === "create") {
          const body = modes.extend({ address: addressSchema }).safeParse(request.body);
          if (!body.success) throw new BadRequestError("Invalid additional email address.");
          result = await options.store.create(actor.orgId, target, body.data);
        } else {
          const body = modes
            .refine((input) => Object.keys(input).length > 0)
            .safeParse(request.body);
          if (!body.success) throw new BadRequestError("Choose receiving or sending settings.");
          result = await options.store.update(actor.orgId, target, addressId ?? "", body.data);
        }
        if (result === null) throw new NotFoundError("Active member mailbox not found.");
        if (action !== "get")
          await auditAdminAction(options.auditSink, {
            orgId: actor.orgId,
            actorId: actor.id,
            verb: `user.address.${action}`,
            objectType: "actor",
            objectId: target,
            metadata: {
              addressId: params.data.addressId ?? null,
              primaryChanged: action === "setPrimary",
            },
          });
        return reply.code(action === "create" ? 201 : 200).send(result);
      },
    });
  }
  async function principal(request: FastifyRequest): Promise<Actor> {
    const actor = await options.actorFromRequest(request);
    if (actor.id === "anonymous") throw new UnauthorizedError("Sign in to manage email addresses.");
    assertActorMatchesRequestTenant(request, actor);
    await setTenantPostgresActorId(actor.id);
    return actor;
  }
}
