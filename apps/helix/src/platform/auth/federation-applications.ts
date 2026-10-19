import { APIError } from "better-auth/api";
import type postgres from "postgres";
import { z } from "zod";
import { withTenantPostgresContext } from "../tenancy/postgres-roles.js";

const binding = z.object({
  helix_org_id: z.string().uuid(),
  helix_app_id: z.string().uuid(),
  helix_client_id: z.string().min(1).max(256),
});

/** Only registered clients and currently assigned, active directory people receive claims. */
export class FederationApplications {
  authorizeSession: (userId: string, headers: Headers) => Promise<boolean> = async () => {
    throw new APIError("FORBIDDEN", { message: "Federation sign-in policy is unavailable." });
  };
  constructor(private readonly sql: postgres.Sql) {}

  async claims(
    userId: string,
    metadata: Record<string, unknown> | undefined,
  ): Promise<Record<string, unknown>> {
    const parsed = binding.safeParse(metadata);
    if (!parsed.success || userId.length === 0)
      throw new APIError("FORBIDDEN", { message: "Application access is unavailable." });
    const { helix_org_id: orgId, helix_app_id: appId } = parsed.data;
    return withTenantPostgresContext(this.sql, { orgId }, async (tx) => {
      const [person] = await tx<{ actor_id: string }[]>`
        select m.actor_id from federation_applications app
        join "oauthClient" client on client."clientId"=app.oidc_client_id and client.disabled is not true
        join federation_app_assignments assigned on assigned.org_id=app.org_id and assigned.application_id=app.id
        join organization_memberships m on m.org_id=app.org_id and m.actor_id=assigned.actor_id and m.status='active'
        join identity_subjects s on s.id=m.subject_id and s.status='active' and s.federation_generation=assigned.identity_generation
        join identity_provider_subjects p on p.subject_id=s.id and p.provider='better-auth' and p.provider_subject=${userId}
        join actors a on a.org_id=m.org_id and a.id=m.actor_id and a.type='user' and a.disabled_at is null
        where app.org_id=${orgId} and app.id=${appId} and app.oidc_client_id=${parsed.data.helix_client_id} and app.status='active'
        limit 1
      `;
      if (person === undefined)
        throw new APIError("FORBIDDEN", { message: "You are not assigned to this application." });
      const groups = await tx<{ id: string }[]>`select g.id from admin_groups g
        join admin_group_members gm on gm.org_id=g.org_id and gm.group_id=g.id
        where g.org_id=${orgId} and gm.actor_id=${person.actor_id} order by g.id limit 500`;
      return {
        helix_org_id: orgId,
        helix_app_id: appId,
        helix_client_id: parsed.data.helix_client_id,
        groups: groups.map((group) => group.id),
      };
    });
  }
}
