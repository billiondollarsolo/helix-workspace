import type { Actor } from "@helix/sdk-types";
import { fromNodeHeaders } from "better-auth/node";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  federationRotationInput,
  prepareFederationRotation,
  deliverFederationRotation,
} from "./federation-credentials.js";
import { ForbiddenError } from "../../api/api-error.js";
import { assertActorMatchesRequestTenant } from "../tenancy/middleware.js";
import { withTenantPostgresContext } from "../tenancy/postgres-roles.js";
import {
  federationRegistrationInput,
  federationRedemptionInput,
  type FederationPairing,
} from "./federation-pairing.js";

export function registerFederationRoutes(
  app: FastifyInstance,
  federation: FederationPairing,
  actorFromRequest: (request: FastifyRequest) => Promise<Actor>,
) {
  const admin = async (request: FastifyRequest) => {
    const actor = await actorFromRequest(request);
    assertActorMatchesRequestTenant(request, actor);
    federation.admin(actor);
    return actor;
  };
  const appId = (request: FastifyRequest) =>
    z.object({ appId: z.string().uuid() }).parse(request.params).appId;
  app.get("/api/admin/federation-applications", async (request) => ({
    applications: await federation.list(await admin(request)),
  }));
  app.post("/api/admin/federation-applications", async (request, reply) => {
    reply.header("cache-control", "no-store");
    return federation.register(
      await admin(request),
      federationRegistrationInput.parse(request.body),
      fromNodeHeaders(request.headers),
    );
  });
  app.get("/api/admin/federation-applications/:appId/assignments", async (request) =>
    federation.assignments(await admin(request), appId(request)),
  );
  app.put("/api/admin/federation-applications/:appId/assignments", async (request) => {
    const input = z
      .object({
        revision: z.string().regex(/^(0|[1-9][0-9]{0,18})$/u),
        assignments: z
          .array(
            z
              .object({ actorId: z.string().uuid(), role: z.enum(["viewer", "member", "admin"]) })
              .strict(),
          )
          .max(5000),
      })
      .strict()
      .parse(request.body);
    await federation.assign(
      await admin(request),
      appId(request),
      input.assignments,
      input.revision,
    );
    return { updated: true };
  });
  app.post("/api/admin/federation-applications/:appId/rotate", async (request) => {
    const row = await prepareFederationRotation(
      federation,
      await admin(request),
      appId(request),
      federationRotationInput.parse(request.body),
      fromNodeHeaders(request.headers),
    );
    await deliverFederationRotation(federation, row);
    return { rotated: true };
  });
  app.delete("/api/admin/federation-applications/:appId", async (request) => {
    await federation.revoke(await admin(request), appId(request));
    return { revoked: true };
  });
  for (const [path, activate] of [
    ["redeem", false],
    ["activate", true],
  ] as const) {
    app.post(`/api/federation/${path}`, async (request, reply) => {
      reply.header("cache-control", "no-store");
      if (request.headers.cookie !== undefined)
        throw new ForbiddenError(
          "Application pairing uses installation authority, without a browser session.",
        );
      return federation.redeem(federationRedemptionInput.parse(request.body), activate);
    });
  }
  app.post("/api/federation/disconnect", async (request) => {
    const authorization = request.headers.authorization;
    if (
      request.headers.cookie !== undefined ||
      typeof authorization !== "string" ||
      !/^Bearer [a-f0-9]{64}$/u.test(authorization)
    )
      throw new ForbiddenError("Installation authority is required.");
    const input = z
      .object({
        orgId: z.string().uuid(),
        appId: z.string().uuid(),
        connectionId: z.string().uuid(),
      })
      .strict()
      .parse(request.body);
    return federation.revokeByPeer(
      input.orgId,
      input.appId,
      input.connectionId,
      authorization.slice(7),
    );
  });
  app.get("/api/federation/apps", async (request) => {
    const actor = await actorFromRequest(request);
    assertActorMatchesRequestTenant(request, actor);
    if (actor.type !== "user")
      throw new ForbiddenError("Sign in as a person to open federation applications.");
    return withTenantPostgresContext(
      federation.sql,
      { orgId: actor.orgId, actorId: actor.id },
      async (tx) => {
        const rows = await tx<
          { id: string; public_origin: string }[]
        >`select app.id,app.public_origin from federation_applications app
        join federation_app_assignments assigned on assigned.org_id=app.org_id and assigned.application_id=app.id
        join "oauthClient" client on client."clientId"=app.oidc_client_id and client.disabled is not true
        where app.org_id=${actor.orgId} and assigned.actor_id=${actor.id} and app.status='active' order by app.created_at limit 100`;
        return {
          applications: rows.map((row) => ({
            id: row.id,
            label: "Helix Agentspace",
            url: row.public_origin,
          })),
        };
      },
    );
  });
}
