import type postgres from "postgres";
import type { Actor, ActorType } from "@helix/sdk-types";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { actorHasScope } from "../../api/scopes.js";
import type { OutboxStore } from "../outbox/outbox.js";
import { signupOnboardingInviteEmailSubject } from "../signup/email-delivery.js";
import type { SignupOnboardingInviteTokenStore } from "../signup/invites.js";
import {
  AdminUserConflictError,
  AdminUserProvisioningError,
  buildAdminOrgInviteUrl,
  normalizeAdminUserEmail,
  provisionLocalUser,
  uniqueEmails,
  type AdminProvisionedUserRole,
} from "./admin-user-provisioning.js";

const adminUsersScope = "admin.users";
const actorTypeSchema = z.enum(["user", "agent", "service_account", "system"]);
const uuidSchema = z.string().uuid();
const provisionedRoleSchema = z.enum(["member", "admin"]);
const createAdminUserBodySchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(12).max(1024),
  displayName: z.string().trim().min(1).max(120).optional(),
  role: provisionedRoleSchema.default("member"),
});
const inviteAdminUsersBodySchema = z.object({
  emails: z.array(z.string().trim().toLowerCase().email()).min(1).max(10),
  role: provisionedRoleSchema.default("member"),
});
const acceptAdminInviteBodySchema = z.object({
  token: z.string().min(1).max(4096),
  password: z.string().min(12).max(1024),
  displayName: z.string().trim().min(1).max(120).optional(),
});
const adminUsersQuerySchema = z.object({
  cursor: emptyStringToUndefined(z.string().trim().min(1).max(1000).optional()),
  includeDisabled: booleanQuerySchema().default(false),
  limit: z.coerce.number().int().min(1).max(250).default(50),
  query: z
    .string()
    .trim()
    .max(200)
    .transform((value) => (value.length === 0 ? undefined : value))
    .optional(),
  type: emptyStringToUndefined(actorTypeSchema.optional()),
});
const peopleDirectoryQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(25),
  query: z
    .string()
    .trim()
    .max(200)
    .transform((value) => (value.length === 0 ? undefined : value))
    .optional(),
});

export interface AdminUserRecord {
  readonly id: string;
  readonly orgId: string;
  readonly type: ActorType;
  readonly email: string | null;
  readonly displayName: string;
  readonly scopes: readonly string[];
  readonly disabledAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface AdminUsersCursor {
  readonly createdAt: Date;
  readonly id: string;
}

export interface ListAdminUsersInput {
  readonly orgId: string;
  readonly cursor?: AdminUsersCursor | undefined;
  readonly includeDisabled: boolean;
  readonly limit: number;
  readonly query?: string | undefined;
  readonly type?: ActorType | undefined;
}

export interface CreateAdminUserInput {
  readonly orgId: string;
  readonly email: string;
  readonly displayName: string;
  readonly password: string;
  readonly role: AdminProvisionedUserRole;
  readonly performedByActorId: string;
}

export interface AdminUsersStore {
  listUsers(input: ListAdminUsersInput): Promise<readonly AdminUserRecord[]>;
  findUserByEmail?(input: {
    readonly orgId: string;
    readonly email: string;
  }): Promise<AdminUserRecord | null>;
  createUser?(input: CreateAdminUserInput): Promise<AdminUserRecord>;
  resetMfa(input: {
    readonly orgId: string;
    readonly targetActorId: string;
    readonly performedByActorId: string;
  }): Promise<boolean>;
}

export interface AdminUserInviteOptions {
  readonly invites: SignupOnboardingInviteTokenStore;
  readonly outbox: Pick<OutboxStore, "insert">;
  readonly findOrgById: (orgId: string) => Promise<{ readonly slug: string } | null>;
  readonly publicBaseUrl: string;
}

export interface RegisterAdminUsersRoutesOptions {
  readonly store: AdminUsersStore;
  readonly actorFromRequest: (request: FastifyRequest) => Promise<Actor> | Actor;
  /**
   * When set, exposes `POST /api/admin/users/:actorId/offboard` (E7.2 cascade:
   * disable actor, revoke sessions, app passwords, agent credentials) and
   * `POST /api/admin/users/:actorId/suspend`.
   */
  readonly offboardStores?: OffboardUserStores;
  /**
   * When set, exposes `POST /api/admin/users/invites` (org-scoped outbox email)
   * and `POST /api/invites/accept` (token + password; no SaaS signup).
   */
  readonly invites?: AdminUserInviteOptions;
}

export interface PeopleDirectoryRecord {
  readonly id: string;
  readonly email: string | null;
  readonly displayName: string;
}

/**
 * Minimal store surfaces for offboarding cascade (E7.2).
 * Wired to real app-password / OAuth-client / session revoke methods —
 * not faked envelope shapes.
 */
export interface OffboardAppPasswordRecord {
  readonly id: string;
  readonly orgId: string;
  readonly revokedAt: Date | null;
}

export interface OffboardAppPasswordStore {
  listAppPasswords(input: {
    readonly orgId: string;
    readonly actorId?: string;
    readonly includeRevoked?: boolean;
  }): Promise<readonly OffboardAppPasswordRecord[]>;
  revokeAppPassword(input: {
    readonly id: string;
    readonly orgId: string;
    readonly revokedAt: Date;
  }): Promise<OffboardAppPasswordRecord | null>;
}

export interface OffboardAgentCredentialRecord {
  readonly clientId: string;
  readonly orgId: string;
  readonly actorId: string;
  readonly revokedAt: Date | null;
}

export interface OffboardAgentCredentialStore {
  listClients(input: {
    readonly orgId: string;
    readonly actorId?: string;
    readonly includeRevoked?: boolean;
  }): Promise<readonly OffboardAgentCredentialRecord[]>;
  revokeClient(clientId: string, revokedAt: Date): Promise<OffboardAgentCredentialRecord | null>;
}

export interface OffboardUserInput {
  readonly orgId: string;
  readonly actorId: string;
  /** Defaults to now. Used for disable + revoke timestamps. */
  readonly at?: Date;
}

export interface OffboardUserStores {
  /**
   * Fail-closed tenant check: true only when `actorId` exists in `orgId`.
   * Must run before any revoke/disable side effects.
   */
  readonly resolveTargetInOrg: (input: {
    readonly orgId: string;
    readonly actorId: string;
  }) => Promise<boolean>;
  /**
   * Marks the actor disabled. Optional when only credential cascade is wired.
   * Returns true when a previously-active actor was disabled.
   */
  readonly disableActor?: (input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly disabledAt: Date;
  }) => Promise<boolean>;
  /**
   * Deletes Better Auth sessions for users linked to the actor, scoped to the
   * admin's organization (actor_id + org_id).
   */
  readonly revokeSessionsForActor: (input: {
    readonly orgId: string;
    readonly actorId: string;
  }) => Promise<number>;
  readonly appPasswords: OffboardAppPasswordStore;
  readonly agentCredentials: OffboardAgentCredentialStore;
}

export interface OffboardUserResult {
  readonly actorId: string;
  readonly orgId: string;
  readonly disabled: boolean;
  readonly sessionsRevoked: number;
  readonly appPasswordsRevoked: number;
  readonly agentCredentialsRevoked: number;
}

/**
 * Offboard cascade: verify target is in org, then disable actor (when provided),
 * revoke browser sessions, revoke active app passwords, revoke agent OAuth credentials.
 *
 * Returns `null` when the target actor is not in the admin org (fail closed —
 * no side effects). Callers supply real store methods (PostgresAppPasswordStore,
 * OAuth client store, SQL session delete).
 */
export async function offboardUser(
  input: OffboardUserInput,
  stores: OffboardUserStores,
): Promise<OffboardUserResult | null> {
  const at = input.at ?? new Date();

  const inOrg = await stores.resolveTargetInOrg({
    orgId: input.orgId,
    actorId: input.actorId,
  });
  if (!inOrg) {
    return null;
  }

  let disabled = false;
  if (stores.disableActor !== undefined) {
    disabled = await stores.disableActor({
      orgId: input.orgId,
      actorId: input.actorId,
      disabledAt: at,
    });
  }

  const sessionsRevoked = await stores.revokeSessionsForActor({
    orgId: input.orgId,
    actorId: input.actorId,
  });

  const appPasswords = await stores.appPasswords.listAppPasswords({
    orgId: input.orgId,
    actorId: input.actorId,
    includeRevoked: false,
  });
  let appPasswordsRevoked = 0;
  for (const password of appPasswords) {
    if (password.orgId !== input.orgId) {
      continue;
    }
    const revoked = await stores.appPasswords.revokeAppPassword({
      id: password.id,
      orgId: input.orgId,
      revokedAt: at,
    });
    if (revoked !== null) {
      appPasswordsRevoked += 1;
    }
  }

  const credentials = await stores.agentCredentials.listClients({
    orgId: input.orgId,
    actorId: input.actorId,
    includeRevoked: false,
  });
  let agentCredentialsRevoked = 0;
  for (const credential of credentials) {
    if (credential.orgId !== input.orgId || credential.actorId !== input.actorId) {
      continue;
    }
    const revoked = await stores.agentCredentials.revokeClient(credential.clientId, at);
    if (revoked !== null) {
      agentCredentialsRevoked += 1;
    }
  }

  return {
    actorId: input.actorId,
    orgId: input.orgId,
    disabled,
    sessionsRevoked,
    appPasswordsRevoked,
    agentCredentialsRevoked,
  };
}

/** Postgres helper: set actors.disabled_at when still active. */
export async function disableActorForOffboard(
  sql: postgres.Sql,
  input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly disabledAt: Date;
  },
): Promise<boolean> {
  const rows = await sql<readonly { readonly id: string }[]>`
    update actors
    set disabled_at = ${input.disabledAt}, updated_at = ${input.disabledAt}
    where id = ${input.actorId}
      and org_id = ${input.orgId}
      and disabled_at is null
    returning id
  `;
  await sql`
    update organization_memberships
    set
      status = 'suspended',
      suspended_at = ${input.disabledAt},
      updated_at = ${input.disabledAt}
    where org_id = ${input.orgId}
      and actor_id = ${input.actorId}
      and status = 'active'
  `;
  return rows.length > 0;
}

/**
 * Postgres helper: true when the actor row exists in the given organization.
 */
export async function actorExistsInOrg(
  sql: postgres.Sql,
  input: { readonly orgId: string; readonly actorId: string },
): Promise<boolean> {
  const rows = await sql<readonly { readonly id: string }[]>`
    select id
    from actors
    where id = ${input.actorId}
      and org_id = ${input.orgId}
    limit 1
  `;
  return rows.length > 0;
}

/**
 * Postgres helper: delete Better Auth sessions for user rows linked to the
 * actor, scoped by actors.org_id so cross-tenant session kill is impossible.
 */
export async function revokeSessionsForActorSql(
  sql: postgres.Sql,
  input: { readonly orgId: string; readonly actorId: string },
): Promise<number> {
  const result = await sql`
    delete from session
    using "user", actors
    where session."userId" = "user".id
      and "user".actor_id = actors.id
      and actors.id = ${input.actorId}
      and actors.org_id = ${input.orgId}
  `;
  return typeof result.count === "number" ? result.count : 0;
}

export class PostgresAdminUsersStore implements AdminUsersStore {
  constructor(private readonly sql: postgres.Sql) {}

  async findUserByEmail(input: {
    readonly orgId: string;
    readonly email: string;
  }): Promise<AdminUserRecord | null> {
    const email = normalizeAdminUserEmail(input.email);
    const rows = await this.sql<AdminUserRow[]>`
      select
        id,
        org_id,
        type,
        email,
        display_name,
        scopes,
        disabled_at,
        created_at,
        updated_at
      from actors
      where org_id = ${input.orgId}
        and type = 'user'
        and lower(email) = ${email}
      limit 1
    `;
    const row = rows[0];
    return row === undefined ? null : mapAdminUserRow(row);
  }

  async createUser(input: CreateAdminUserInput): Promise<AdminUserRecord> {
    return provisionLocalUser(this.sql, input);
  }

  async listUsers(input: ListAdminUsersInput): Promise<readonly AdminUserRecord[]> {
    const cursorCreatedAt = input.cursor?.createdAt ?? null;
    const cursorId = input.cursor?.id ?? null;
    const query = input.query?.trim().toLowerCase() ?? null;
    const queryPattern = query === null ? null : `%${escapeLikePattern(query)}%`;
    const type = input.type ?? null;
    const rows = await this.sql<AdminUserRow[]>`
      select
        id,
        org_id,
        type,
        email,
        display_name,
        scopes,
        disabled_at,
        created_at,
        updated_at
      from actors
      where org_id = ${input.orgId}
        and (${type}::actor_type is null or type = ${type}::actor_type)
        and (${input.includeDisabled}::boolean or disabled_at is null)
        and (
          ${query}::text is null
          or lower(coalesce(email, '')) like ${queryPattern}::text escape '\'
          or lower(display_name) like ${queryPattern}::text escape '\'
          or id::text like ${queryPattern}::text escape '\'
        )
        and (
          ${cursorCreatedAt}::timestamptz is null
          or (created_at, id) < (${cursorCreatedAt}::timestamptz, ${cursorId}::uuid)
        )
      order by created_at desc, id desc
      limit ${input.limit}
    `;
    return rows.map(mapAdminUserRow);
  }

  async resetMfa(input: {
    readonly orgId: string;
    readonly targetActorId: string;
    readonly performedByActorId: string;
  }): Promise<boolean> {
    return this.sql.begin(async (tx) => {
      await tx`select set_config('helix.org_id', ${input.orgId}, true)`;
      await tx`select set_config('helix.actor_id', ${input.performedByActorId}, true)`;
      const rows = await tx<{ readonly auth_user_id: string }[]>`
        select provider.provider_subject as auth_user_id
        from organization_memberships membership
        join identity_provider_subjects provider on provider.subject_id = membership.subject_id
        where membership.org_id = ${input.orgId}
          and membership.actor_id = ${input.targetActorId}
          and membership.status = 'active'
          and provider.provider = 'better-auth'
        limit 1
        for update of membership
      `;
      const userId = rows[0]?.auth_user_id;
      if (userId === undefined) return false;
      await tx`delete from auth_recovery_codes where auth_user_id = ${userId}`;
      await tx`delete from passkey where "userId" = ${userId}`;
      await tx`delete from "twoFactor" where "userId" = ${userId}`;
      await tx`delete from "session" where "userId" = ${userId}`;
      await tx`update "user" set "twoFactorEnabled" = false, "updatedAt" = now() where id = ${userId}`;
      await tx`
        insert into activity (org_id, actor_id, verb, object_type, object_id, payload, prev_hash, this_hash)
        values (
          ${input.orgId}, ${input.performedByActorId}, 'identity.mfa.reset', 'actor',
          ${input.targetActorId},
          ${tx.json({ sessionsRevoked: true, factorsRevoked: true })},
          null, ''
        )
      `;
      return true;
    });
  }
}

export async function registerAdminUsersRoutes(
  app: FastifyInstance,
  options: RegisterAdminUsersRoutesOptions,
): Promise<void> {
  app.get("/api/admin/users", async (request, reply) => {
    const actor = await options.actorFromRequest(request);
    if (!canReadAdminUsers(actor)) {
      return reply.code(403).send(permissionDeniedResponse());
    }

    const parsed = adminUsersQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "Invalid admin users query.", issues: parsed.error.issues });
    }

    const cursor =
      parsed.data.cursor === undefined ? undefined : decodeAdminUsersCursor(parsed.data.cursor);
    if (cursor === null) {
      return reply.code(400).send({ error: "Invalid admin users cursor." });
    }

    const limit = parsed.data.limit;
    const users = await options.store.listUsers({
      orgId: actor.orgId,
      includeDisabled: parsed.data.includeDisabled,
      limit: limit + 1,
      ...(cursor === undefined ? {} : { cursor }),
      ...(parsed.data.query === undefined ? {} : { query: parsed.data.query }),
      ...(parsed.data.type === undefined ? {} : { type: parsed.data.type }),
    });
    const pageUsers = users.slice(0, limit);
    const lastUser = pageUsers.at(-1);
    const nextCursor =
      users.length > limit && lastUser !== undefined ? encodeAdminUsersCursor(lastUser) : null;

    return {
      users: pageUsers,
      nextCursor,
    };
  });

  if (options.store.createUser !== undefined) {
    const createUser = options.store.createUser.bind(options.store);
    app.post("/api/admin/users", async (request, reply) => {
      const actor = await options.actorFromRequest(request);
      if (!canReadAdminUsers(actor)) {
        return reply.code(403).send(permissionDeniedResponse());
      }
      const parsed = createAdminUserBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return reply
          .code(400)
          .send({ error: "Invalid admin user create body.", issues: parsed.error.issues });
      }
      if (parsed.data.role === "admin" && !canAssignAdminRole(actor)) {
        return reply.code(403).send({
          error: "Full administration permission is required to create an admin user.",
          requiredScope: "admin.*",
        });
      }
      try {
        const user = await createUser({
          orgId: actor.orgId,
          email: parsed.data.email,
          displayName: parsed.data.displayName ?? parsed.data.email,
          password: parsed.data.password,
          role: parsed.data.role,
          performedByActorId: actor.id,
        });
        return await reply.code(201).send({ user });
      } catch (error) {
        if (error instanceof AdminUserConflictError) {
          return reply.code(409).send({ error: error.message });
        }
        if (error instanceof AdminUserProvisioningError) {
          return reply.code(500).send({ error: error.message });
        }
        throw error;
      }
    });
  }

  if (options.invites !== undefined) {
    const inviteOptions = options.invites;
    app.post("/api/admin/users/invites", async (request, reply) => {
      const actor = await options.actorFromRequest(request);
      if (!canReadAdminUsers(actor)) {
        return reply.code(403).send(permissionDeniedResponse());
      }
      const parsed = inviteAdminUsersBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return reply
          .code(400)
          .send({ error: "Invalid admin user invite body.", issues: parsed.error.issues });
      }
      if (parsed.data.role === "admin" && !canAssignAdminRole(actor)) {
        return reply.code(403).send({
          error: "Full administration permission is required to invite an admin user.",
          requiredScope: "admin.*",
        });
      }
      const org = await inviteOptions.findOrgById(actor.orgId);
      if (org === null) {
        return reply.code(409).send({
          error: "Invite delivery could not resolve the current workspace.",
        });
      }

      const emails = uniqueEmails(parsed.data.emails);
      const skipped: string[] = [];
      let inviteCount = 0;
      for (const email of emails) {
        const existing = await options.store.findUserByEmail?.({ orgId: actor.orgId, email });
        if (existing !== null && existing !== undefined) {
          skipped.push(email);
          continue;
        }
        const invite = await inviteOptions.invites.issue({
          orgId: actor.orgId,
          invitedByActorId: actor.id,
          email,
          metadata: { source: "admin", role: parsed.data.role },
        });
        await inviteOptions.outbox.insert({
          subject: signupOnboardingInviteEmailSubject,
          payload: {
            orgId: actor.orgId,
            orgSlug: org.slug,
            actorId: actor.id,
            email,
            inviteUrl: buildAdminOrgInviteUrl(inviteOptions.publicBaseUrl, invite.token),
            source: "admin",
          },
        });
        inviteCount += 1;
      }

      return reply.code(202).send({
        status: "accepted",
        inviteCount,
        skippedCount: skipped.length,
      });
    });

    app.post("/api/invites/accept", async (request, reply) => {
      const parsed = acceptAdminInviteBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return reply
          .code(400)
          .send({ error: "Invalid invite acceptance body.", issues: parsed.error.issues });
      }
      const findActive = inviteOptions.invites.findActive?.bind(inviteOptions.invites);
      const markAccepted = inviteOptions.invites.markAccepted?.bind(inviteOptions.invites);
      const createUser = options.store.createUser?.bind(options.store);
      if (findActive === undefined || markAccepted === undefined || createUser === undefined) {
        return reply.code(501).send({ error: "Invite acceptance is not configured." });
      }
      const invite = await findActive({ token: parsed.data.token });
      if (invite === null) {
        return reply.code(400).send({ error: "Invite is invalid or expired." });
      }
      const role = inviteRoleFromMetadata(invite.metadata);
      try {
        const user = await createUser({
          orgId: invite.orgId,
          email: invite.email,
          displayName: parsed.data.displayName ?? invite.email,
          password: parsed.data.password,
          role,
          performedByActorId: invite.invitedByActorId,
        });
        await markAccepted({
          token: parsed.data.token,
          acceptedByActorId: user.id,
        });
        const org = await inviteOptions.findOrgById(invite.orgId);
        return await reply.code(201).send({
          status: "accepted",
          user,
          org: org === null ? null : { slug: org.slug },
        });
      } catch (error) {
        if (error instanceof AdminUserConflictError) {
          return reply.code(409).send({ error: error.message });
        }
        if (error instanceof AdminUserProvisioningError) {
          return reply.code(500).send({ error: error.message });
        }
        throw error;
      }
    });
  }

  app.post<{ Params: { actorId: string } }>(
    "/api/admin/users/:actorId/mfa/reset",
    async (request, reply) => {
      const actor = await options.actorFromRequest(request);
      const target = uuidSchema.safeParse(request.params.actorId);
      if (!actorHasScope(actor, "admin.security")) {
        return reply.code(403).send({
          error: "Security administration permission denied.",
          requiredScope: "admin.security",
        });
      }
      if (!target.success) return reply.code(400).send({ error: "Invalid actor id." });
      if (target.data === actor.id) {
        return reply.code(409).send({ error: "Administrators cannot reset their own MFA." });
      }
      if (
        !(await options.store.resetMfa({
          orgId: actor.orgId,
          targetActorId: target.data,
          performedByActorId: actor.id,
        }))
      ) {
        return reply.code(404).send({ error: "User identity not found." });
      }
      return reply.code(204).send();
    },
  );
  if (options.offboardStores !== undefined) {
    const offboardStores = options.offboardStores;
    app.post("/api/admin/users/:actorId/offboard", async (request, reply) => {
      const actor = await options.actorFromRequest(request);
      if (!canReadAdminUsers(actor)) {
        return reply.code(403).send(permissionDeniedResponse());
      }
      const actorIdParsed = uuidSchema.safeParse(
        (request.params as { readonly actorId?: unknown }).actorId,
      );
      if (!actorIdParsed.success) {
        return reply.code(400).send({ error: "Invalid actor id." });
      }
      if (actorIdParsed.data === actor.id) {
        return reply.code(400).send({ error: "Administrators cannot offboard themselves." });
      }
      const result = await offboardUser(
        { orgId: actor.orgId, actorId: actorIdParsed.data },
        offboardStores,
      );
      if (result === null) {
        return reply.code(404).send({ error: "User not found in this organization." });
      }
      return reply.code(200).send({ offboard: result });
    });
    app.post("/api/admin/users/:actorId/suspend", async (request, reply) => {
      const actor = await options.actorFromRequest(request);
      if (!canReadAdminUsers(actor)) {
        return reply.code(403).send(permissionDeniedResponse());
      }
      const actorIdParsed = uuidSchema.safeParse(
        (request.params as { readonly actorId?: unknown }).actorId,
      );
      if (!actorIdParsed.success) {
        return reply.code(400).send({ error: "Invalid actor id." });
      }
      if (actorIdParsed.data === actor.id) {
        return reply.code(400).send({ error: "Administrators cannot suspend themselves." });
      }
      const result = await offboardUser(
        { orgId: actor.orgId, actorId: actorIdParsed.data },
        offboardStores,
      );
      if (result === null) {
        return reply.code(404).send({ error: "User not found in this organization." });
      }
      return reply.code(200).send({ suspend: result });
    });
  }
}

export async function registerPeopleDirectoryRoutes(
  app: FastifyInstance,
  options: RegisterAdminUsersRoutesOptions,
): Promise<void> {
  app.get("/api/people", async (request, reply) => {
    const actor = await options.actorFromRequest(request);
    const parsed = peopleDirectoryQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "Invalid people directory query.", issues: parsed.error.issues });
    }

    const users = await options.store.listUsers({
      orgId: actor.orgId,
      includeDisabled: false,
      limit: parsed.data.limit,
      ...(parsed.data.query === undefined ? {} : { query: parsed.data.query }),
      type: "user",
    });

    return {
      people: users.map(personDirectoryRecordFromUser),
    };
  });
}

export function canReadAdminUsers(actor: Actor): boolean {
  return actorHasScope(actor, adminUsersScope);
}

export function canAssignAdminRole(actor: Actor): boolean {
  return actorHasScope(actor, "admin.*");
}

function inviteRoleFromMetadata(metadata: unknown): AdminProvisionedUserRole {
  if (
    typeof metadata === "object" &&
    metadata !== null &&
    "role" in metadata &&
    (metadata as { readonly role?: unknown }).role === "admin"
  ) {
    return "admin";
  }
  return "member";
}

export function encodeAdminUsersCursor(record: Pick<AdminUserRecord, "createdAt" | "id">): string {
  return Buffer.from(
    JSON.stringify({ createdAt: record.createdAt, id: record.id }),
    "utf8",
  ).toString("base64url");
}

export function decodeAdminUsersCursor(cursor: string): AdminUsersCursor | null {
  try {
    const decoded: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    const parsed = z
      .object({
        createdAt: z.string().datetime({ offset: true }),
        id: uuidSchema,
      })
      .safeParse(decoded);
    if (!parsed.success) {
      return null;
    }
    return {
      createdAt: new Date(parsed.data.createdAt),
      id: parsed.data.id,
    };
  } catch {
    return null;
  }
}

function booleanQuerySchema(): z.ZodEffects<
  z.ZodOptional<z.ZodBoolean>,
  boolean | undefined,
  unknown
> {
  return z.preprocess((value) => {
    if (value === "true" || value === true) {
      return true;
    }
    if (value === "false" || value === false || value === undefined) {
      return false;
    }
    return value;
  }, z.boolean().optional());
}

function emptyStringToUndefined<T extends z.ZodTypeAny>(
  schema: T,
): z.ZodEffects<T, z.output<T>, unknown> {
  return z.preprocess((value) => (value === "" ? undefined : value), schema);
}

function permissionDeniedResponse(): {
  readonly error: string;
  readonly requiredScope: typeof adminUsersScope;
} {
  return {
    error: "Admin users permission denied.",
    requiredScope: adminUsersScope,
  };
}

function personDirectoryRecordFromUser(user: AdminUserRecord): PeopleDirectoryRecord {
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName.trim() || user.email || user.id,
  };
}

function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/gu, "\\$&");
}

interface AdminUserRow {
  readonly id: string;
  readonly org_id: string;
  readonly type: ActorType;
  readonly email: string | null;
  readonly display_name: string;
  readonly scopes: readonly string[];
  readonly disabled_at: Date | null;
  readonly created_at: Date;
  readonly updated_at: Date;
}

function mapAdminUserRow(row: AdminUserRow): AdminUserRecord {
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
