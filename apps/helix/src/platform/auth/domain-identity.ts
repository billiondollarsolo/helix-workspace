import type { FastifyInstance } from "fastify";
import type postgres from "postgres";
import { z } from "zod";

export interface DomainIdentityDiscovery {
  readonly orgSlug: string;
  readonly canonicalEmail: string;
  readonly protocol: "saml" | "oidc" | null;
}

interface DiscoveryRow {
  readonly org_slug: string;
  readonly canonical_email: string;
  readonly protocol: "saml" | "oidc" | null;
}

const discoveryBody = z.object({ email: z.string().trim().email().max(320) }).strict();

export class PostgresDomainIdentityStore {
  constructor(private readonly sql: postgres.Sql) {}

  async discover(email: string): Promise<DomainIdentityDiscovery | null> {
    const rows = await this.sql<DiscoveryRow[]>`
      select org_slug, canonical_email, protocol
      from helix_discover_domain_identity(${email.toLowerCase()})
    `;
    const row = rows[0];
    return row === undefined
      ? null
      : {
          orgSlug: row.org_slug,
          canonicalEmail: row.canonical_email,
          protocol: row.protocol,
        };
  }

  async canonicalize(orgId: string, email: string): Promise<string | null> {
    const rows = await this.sql<{ readonly email: string | null }[]>`
      select helix_canonical_login_email(${orgId}, ${email.toLowerCase()}) as email
    `;
    return rows[0]?.email ?? null;
  }
}

export function registerDomainIdentityDiscoveryRoute(
  app: FastifyInstance,
  store: Pick<PostgresDomainIdentityStore, "discover">,
): void {
  app.post("/api/auth/domain-discovery", async (request, reply) => {
    const body = discoveryBody.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: "A valid email address is required." });
    }
    const email = body.data.email.toLowerCase();
    const discovery = await store.discover(email);
    return discovery === null
      ? { managed: false, canonicalEmail: email, orgSlug: null, protocol: null }
      : { managed: true, ...discovery };
  });
}
