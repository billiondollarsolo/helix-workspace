/* First administrator for a deployment that has no public sign-up.

   Ensures the workspace's owner exists as a full administrator and issues the
   same single-use, 7-day set-password link an administrator invitation uses.
   Run again for the same address to get a fresh link until the owner has
   joined; after that, sign-in recovery goes through password reset. */

import type { Actor } from "@helix/sdk-types";
import type postgres from "postgres";
import { PostgresTenantOwnerActorStore } from "../tenancy/provisioning-owner.js";
import { withTenantPostgresContext } from "../tenancy/postgres-roles.js";
import { PostgresAdminUserInviteStore } from "./admin-user-invites.js";
import { WORKSPACE_ADMIN_SCOPES, WORKSPACE_MEMBER_SCOPES } from "./member-scopes.js";

export type BootstrapOwnerResult =
  | {
      readonly status: "invited";
      readonly actorId: string;
      readonly inviteUrl: string;
      readonly expiresAt: Date;
    }
  | { readonly status: "already_joined"; readonly actorId: string }
  | { readonly status: "workspace_missing" };

export async function bootstrapWorkspaceOwner(
  sql: postgres.Sql,
  input: {
    readonly orgId: string;
    readonly email: string;
    readonly displayName?: string | undefined;
    /** Origin of the web app; the link opens `/signup/invite` there. */
    readonly publicBaseUrl: string;
  },
): Promise<BootstrapOwnerResult> {
  const email = input.email.trim().toLowerCase();
  const workspace = await withTenantPostgresContext(
    sql,
    { orgId: input.orgId },
    (tx) => tx`select 1 from orgs where id = ${input.orgId} limit 1`,
  );
  if (workspace.length === 0) return { status: "workspace_missing" };

  const owner = await new PostgresTenantOwnerActorStore(sql).ensureInitialOwnerActor({
    orgId: input.orgId,
    email,
    ...(input.displayName === undefined ? {} : { displayName: input.displayName }),
    metadata: { source: "bootstrap-owner" },
  });
  // The owner uses the workspace apps too, and holds full administration.
  const scopes = [...new Set([...WORKSPACE_MEMBER_SCOPES, ...WORKSPACE_ADMIN_SCOPES])];
  await withTenantPostgresContext(sql, { orgId: input.orgId, actorId: owner.id }, async (tx) => {
    await tx`
      update actors
      set scopes = (
        select array_agg(distinct scope order by scope)
        from unnest(scopes || ${tx.array(scopes, 1009)}) as merged(scope)
      ), updated_at = now()
      where org_id = ${input.orgId} and id = ${owner.id}
        and not (scopes @> ${tx.array(scopes, 1009)})
    `;
    await tx`
      insert into activity (org_id, actor_id, verb, object_type, object_id, payload, prev_hash, this_hash)
      values (${input.orgId}, ${owner.id}, 'identity.owner.bootstrapped', 'actor', ${owner.id},
        ${tx.json({ email })}, null, '')
    `;
  });

  const self: Actor = { id: owner.id, orgId: input.orgId, type: "user", scopes };
  const invite = await new PostgresAdminUserInviteStore(sql).resend(self, owner.id);
  if (invite === null) return { status: "already_joined", actorId: owner.id };
  const url = new URL("/signup/invite", input.publicBaseUrl);
  url.searchParams.set("token", invite.token);
  return {
    status: "invited",
    actorId: owner.id,
    inviteUrl: url.toString(),
    expiresAt: invite.expiresAt,
  };
}
