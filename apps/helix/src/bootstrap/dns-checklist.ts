import type { Actor } from "@helix/sdk-types";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type postgres from "postgres";
import type { env } from "../config/env.js";
import { registerDnsChecklistRoutes, type DnsChecklistTarget } from "../platform/edge/index.js";
import { withTenantPostgresContext } from "../platform/tenancy/postgres-roles.js";

function hostnameOf(url: string | undefined): string | undefined {
  if (url === undefined || url.trim() === "") return undefined;
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
}

/**
 * The hostnames this installation answers on, by purpose: the Workspace web
 * address, the public mail hostname, the Meet relay (the Meet install serves
 * TURN on the meeting hostname), and each active federated app's origin.
 */
export function deploymentDnsTargets(bootEnv: ReturnType<typeof env>): DnsChecklistTarget[] {
  const targets: DnsChecklistTarget[] = [];
  const web = hostnameOf(
    bootEnv.HELIX_PUBLIC_URL ?? bootEnv.PUBLIC_BASE_URL ?? bootEnv.BETTER_AUTH_URL,
  );
  if (web !== undefined) targets.push({ hostname: web, role: "web" });
  const mail = bootEnv.HELIX_MAIL_PUBLIC_HOSTNAME?.trim();
  if (mail !== undefined && mail !== "") targets.push({ hostname: mail, role: "mail" });
  const turn = bootEnv.MEET_JITSI_DOMAIN?.trim() || hostnameOf(bootEnv.MEET_JITSI_PUBLIC_URL);
  if (turn !== undefined && turn !== "") targets.push({ hostname: turn, role: "turn" });
  return targets;
}

/** Admin → Domains → DNS and proxy. */
export function installDnsChecklist(input: {
  readonly app: FastifyInstance;
  readonly sql: postgres.Sql;
  readonly bootEnv: ReturnType<typeof env>;
  readonly actorFromRequest: (request: FastifyRequest) => Actor | Promise<Actor>;
}): void {
  const deployment = deploymentDnsTargets(input.bootEnv);
  registerDnsChecklistRoutes(input.app, {
    actorFromRequest: input.actorFromRequest,
    targets: async (actor) => {
      const origins = await withTenantPostgresContext(
        input.sql,
        { orgId: actor.orgId, actorId: actor.id },
        (tx) =>
          tx<{ public_origin: string }[]>`
            select distinct public_origin from federation_applications
            where org_id=${actor.orgId} and status='active' order by public_origin limit 100`,
      );
      const apps = origins.flatMap((row): DnsChecklistTarget[] => {
        const hostname = hostnameOf(row.public_origin);
        return hostname === undefined ? [] : [{ hostname, role: "app" }];
      });
      return [...deployment, ...apps];
    },
  });
}
