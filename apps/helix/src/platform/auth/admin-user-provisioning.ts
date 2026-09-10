import { hashPassword } from "@better-auth/utils/password";
import type postgres from "postgres";
import type { JsonObject } from "@helix/sdk-types";
import { withTenantPostgresContext } from "../tenancy/postgres-roles.js";

export interface ProvisionedUserRecord {
  readonly id: string;
  readonly orgId: string;
  readonly type: "user";
  readonly email: string | null;
  readonly displayName: string;
  readonly scopes: readonly string[];
  readonly disabledAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** Default product scopes for an admin-created member in the Business pilot. */
export const ADMIN_CREATED_MEMBER_SCOPES = [
  "platform.read",
  "mail.read",
  "mail.write",
  "mail.send",
  "drive.read",
  "drive.write",
  "calendar.read",
  "calendar.write",
  "calendar.manage",
  "chat.read",
  "chat.post",
  "chat.create",
  "meet.read",
  "meet.write",
  "assistant.read",
  "assistant.write",
  "assistant.memory",
  "notifications.read",
  "notifications.write",
  "search.read",
] as const;

export type AdminProvisionedUserRole = "member" | "admin";

export class AdminUserConflictError extends Error {
  constructor(message = "A user with that email already exists.") {
    super(message);
    this.name = "AdminUserConflictError";
  }
}

export class AdminUserProvisioningError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AdminUserProvisioningError";
  }
}

export interface ProvisionLocalUserInput {
  readonly orgId: string;
  readonly email: string;
  readonly displayName: string;
  readonly password: string;
  readonly role: AdminProvisionedUserRole;
  readonly performedByActorId: string;
  readonly metadata?: JsonObject | undefined;
}

interface ProvisionedUserRow {
  readonly id: string;
  readonly org_id: string;
  readonly type: "user";
  readonly email: string | null;
  readonly display_name: string;
  readonly scopes: readonly string[];
  readonly disabled_at: Date | null;
  readonly created_at: Date;
  readonly updated_at: Date;
}

/**
 * Create a login-capable user: tenant actor, Better Auth credential, and
 * identity membership. Better Auth public sign-up is disabled, so admin
 * create and invite-accept share this path instead of HTTP Basic.
 */
export async function provisionLocalUser(
  sql: postgres.Sql,
  input: ProvisionLocalUserInput,
): Promise<ProvisionedUserRecord> {
  const email = normalizeAdminUserEmail(input.email);
  const displayName = input.displayName.trim() || email;
  const scopes = scopesForProvisionedRole(input.role);
  const passwordHash = await hashPassword(input.password);
  const metadata: JsonObject = {
    ...(input.metadata ?? {}),
    provisionedBy: "admin",
    role: input.role,
  };

  try {
    return await withTenantPostgresContext(
      sql,
      { orgId: input.orgId, actorId: input.performedByActorId },
      async (tx) => {
        const actorRows = await tx<ProvisionedUserRow[]>`
          insert into actors (
            org_id, type, email, display_name, scopes, disabled_at, metadata
          )
          values (
            ${input.orgId},
            'user',
            ${email},
            ${displayName},
            ${tx.array([...scopes], 1009)},
            null,
            ${tx.json(metadata)}
          )
          returning id, org_id, type, email, display_name, scopes, disabled_at, created_at, updated_at
        `;
        const actor = actorRows[0];
        if (actor === undefined) {
          throw new AdminUserProvisioningError("User actor insert returned no rows.");
        }

        const betterAuthUserId = `local-${actor.id}`;
        await tx`
          insert into "user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
          values (${betterAuthUserId}, ${displayName}, ${email}, true, now(), now())
        `;
        await tx`
          insert into account (
            id, "userId", "accountId", "providerId", password, "createdAt", "updatedAt"
          )
          values (
            ${`${betterAuthUserId}-credential`},
            ${betterAuthUserId},
            ${betterAuthUserId},
            'credential',
            ${passwordHash},
            now(),
            now()
          )
        `;
        const activated = await tx<{ readonly actor_id: string | null }[]>`
          select helix_activate_identity_membership(
            'better-auth', ${betterAuthUserId}, ${input.orgId}, ${email}, ${displayName}
          ) as actor_id
        `;
        if (activated[0]?.actor_id !== actor.id) {
          throw new AdminUserProvisioningError("Failed to link the Better Auth identity.");
        }
        await tx`
          insert into activity (org_id, actor_id, verb, object_type, object_id, payload, prev_hash, this_hash)
          values (
            ${input.orgId},
            ${input.performedByActorId},
            'identity.user.created',
            'actor',
            ${actor.id},
            ${tx.json({ role: input.role, source: "admin" })},
            null,
            ''
          )
        `;
        return mapProvisionedUserRow(actor);
      },
    );
  } catch (error) {
    if (error instanceof AdminUserConflictError || error instanceof AdminUserProvisioningError) {
      throw error;
    }
    if (isUniqueViolation(error)) {
      throw new AdminUserConflictError();
    }
    throw error;
  }
}

export function scopesForProvisionedRole(role: AdminProvisionedUserRole): readonly string[] {
  if (role === "admin") {
    return [...ADMIN_CREATED_MEMBER_SCOPES, "admin.*"];
  }
  return [...ADMIN_CREATED_MEMBER_SCOPES];
}

export function buildAdminOrgInviteUrl(publicBaseUrl: string, token: string): string {
  const url = new URL("/signup/invite", publicBaseUrl);
  url.searchParams.set("token", token);
  return url.toString();
}

export function normalizeAdminUserEmail(email: string): string {
  const normalized = email.trim().toLowerCase();
  if (normalized.length === 0) {
    throw new Error("email is required");
  }
  return normalized;
}

export function uniqueEmails(emails: readonly string[]): readonly string[] {
  return [...new Set(emails.map((email) => normalizeAdminUserEmail(email)))];
}

function mapProvisionedUserRow(row: ProvisionedUserRow): ProvisionedUserRecord {
  return {
    id: row.id,
    orgId: row.org_id,
    type: row.type,
    email: row.email,
    displayName: row.display_name,
    scopes: row.scopes,
    disabledAt: row.disabled_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && Reflect.get(error, "code") === "23505";
}
