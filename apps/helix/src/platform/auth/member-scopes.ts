import type { Actor, ActorRoleBinding } from "@helix/sdk-types";
import type postgres from "postgres";
import { actorHasPermission, parseActorRoleBindings } from "../permissions/roles.js";
import type { Permission } from "../permissions/scope-catalog.js";

/**
 * The app scopes a person gets when they join a workspace as a member: the
 * workspace apps plus Assistant and notifications. Admin invitations add
 * `WORKSPACE_ADMIN_SCOPES`.
 */
export const WORKSPACE_MEMBER_SCOPES = [
  "platform.read",
  "mail.read",
  "mail.write",
  "mail.send",
  "mail.external",
  "drive.read",
  "drive.write",
  "calendar.read",
  "calendar.write",
  "calendar.manage",
  "calendar.external",
  "chat.read",
  "chat.post",
  "chat.create",
  "meet.read",
  "meet.write",
  "contacts.read",
  "contacts.write",
  "assistant.read",
  "assistant.write",
  "assistant.memory",
  "notifications.read",
  "notifications.write",
] as const satisfies readonly Permission[];

/** Added to the member scopes for a person invited as an administrator. */
export const WORKSPACE_ADMIN_SCOPES = [
  "tools:read",
  "tools:write",
  "admin.*",
] as const satisfies readonly Permission[];

/**
 * Self-service scopes every active person holds through the built-in
 * `workspace_member` role (migration 0208): their own profile, preferences and
 * app passwords.
 */
const MEMBER_SELF_SERVICE_SCOPES = ["profile.read", "profile.write"] as const;

/**
 * The member self-service scopes a principal holds through its current role
 * bindings. Agents and service accounts have no membership and hold none, so
 * their credentials stay limited to the scopes they were issued.
 */
export function heldMemberScopes(principal: {
  readonly actorType: string | undefined;
  readonly orgId: string;
  readonly roleBindings: readonly ActorRoleBinding[];
}): readonly string[] {
  if (principal.actorType !== "user") return [];
  const actor: Actor = {
    id: "member-scope-check",
    orgId: principal.orgId,
    type: "user",
    scopes: [],
    roleBindings: principal.roleBindings,
  };
  return MEMBER_SELF_SERVICE_SCOPES.filter((scope) => actorHasPermission(actor, scope));
}

/**
 * The member scopes of an OAuth client's own person, read from their live role
 * bindings, so a person's CLI login can request what their membership grants.
 */
export function createPostgresMemberScopes(
  sql: postgres.Sql,
): (client: { readonly actorId: string; readonly orgId: string }) => Promise<readonly string[]> {
  return async (client) => {
    const rows = await sql<{ readonly type: string; readonly role_bindings: unknown }[]>`
      select a.type, helix_actor_role_bindings(a.org_id, a.id) as role_bindings
      from actors a
      where a.id = ${client.actorId} and a.org_id = ${client.orgId}
      limit 1
    `;
    const row = rows[0];
    return row === undefined
      ? []
      : heldMemberScopes({
          actorType: row.type,
          orgId: client.orgId,
          roleBindings: parseActorRoleBindings(row.role_bindings),
        });
  };
}
