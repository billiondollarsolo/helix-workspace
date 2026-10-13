/* Who a confirmed tool call runs as once it is approved: the requesting
   person (with their own scopes and role bindings) or the delegated agent
   credential, re-checked at execution time. */

import type { Actor } from "@helix/sdk-types";
import type postgres from "postgres";
import { enforceCredentialPolicy } from "../platform/auth/credentials.js";
import type { PostgresAgentCredentialStore } from "../platform/auth/postgres-store.js";
import { parseActorRoleBindings } from "../platform/permissions/roles.js";
import { sessionPermissions } from "../platform/permissions/scope-catalog.js";
import type { ToolRegistryOptions } from "../platform/tool-registry.js";

type PendingPrincipalResolver = NonNullable<ToolRegistryOptions["resolvePendingPrincipal"]>;

export function createPendingPrincipalResolver(
  sql: postgres.Sql,
  agentCredentialStore: Pick<PostgresAgentCredentialStore, "findById">,
): PendingPrincipalResolver {
  return async (record) => {
    if (record.requesterCredentialId === null) {
      // Role bindings authorize a person as much as their own scopes do;
      // without them a role-granted tool is denied when it is approved.
      const rows = (await sql`
        select id, org_id, type, display_name, email, scopes,
          helix_actor_role_bindings(org_id, id) as role_bindings
        from actors
        where id = ${record.requesterActorId}
          and org_id = ${record.orgId}
          and disabled_at is null
        limit 1
      `) as unknown as readonly {
        readonly id: string;
        readonly org_id: string;
        readonly type: Actor["type"];
        readonly display_name: string;
        readonly email: string | null;
        readonly scopes: readonly string[];
        readonly role_bindings: unknown;
      }[];
      const requester = rows[0];
      if (requester === undefined) {
        return null;
      }
      const roleBindings = parseActorRoleBindings(requester.role_bindings);
      return {
        actor: {
          id: requester.id,
          orgId: requester.org_id,
          type: requester.type,
          displayName: requester.display_name,
          ...(requester.email === null ? {} : { email: requester.email }),
          // The same permissions the person's session carried when they asked.
          scopes: sessionPermissions(requester.scopes),
          ...(roleBindings.length === 0 ? {} : { roleBindings }),
        },
      };
    }
    const credential = await agentCredentialStore.findById(record.requesterCredentialId);
    if (
      credential === null ||
      credential.actorId !== record.requesterActorId ||
      credential.orgId !== record.orgId
    ) {
      return null;
    }
    const enforcement = enforceCredentialPolicy(credential, {
      ...(record.requesterIp === null ? {} : { ip: record.requesterIp }),
      ...(credential.certFingerprint === null
        ? {}
        : { certFingerprint: credential.certFingerprint }),
    });
    if (!enforcement.ok) {
      return null;
    }
    // Identity comes from the actor row: without its email, approved mail sends
    // defaulted their From to `<actor-id>@localhost` and were rejected.
    const identityRows = (await sql`
      select display_name, email
      from actors
      where id = ${credential.actorId}
        and org_id = ${credential.orgId}
        and disabled_at is null
      limit 1
    `) as unknown as readonly {
      readonly display_name: string;
      readonly email: string | null;
    }[];
    const identity = identityRows[0];
    if (identity === undefined) {
      return null;
    }
    return {
      actor: {
        id: credential.actorId,
        orgId: credential.orgId,
        type: "agent",
        displayName: identity.display_name,
        ...(identity.email === null ? {} : { email: identity.email }),
        scopes: credential.scopes,
      },
      credentialId: credential.id,
      ...(credential.approvalOwnerActorId === undefined || credential.approvalOwnerActorId === null
        ? {}
        : { credentialOwnerActorId: credential.approvalOwnerActorId }),
      credentialPolicy: credential.policy,
    };
  };
}
