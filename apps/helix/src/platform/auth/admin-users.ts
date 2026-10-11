import type { Actor, ActorType } from "@helix/sdk-types";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type postgres from "postgres";
import { z } from "zod";
import { ConflictError, ForbiddenError } from "../../api/api-error.js";
import { actorHasScope } from "../../api/scopes.js";
import { canWriteAdminConsole } from "../admin/console-shared.js";
import { withTenantPostgresContext } from "../tenancy/postgres-roles.js";
import type { PostgresActorOffboardingStore } from "./actor-offboarding.js";

const adminUsersScope = "admin.users";
const actorTypeSchema = z.enum(["user", "agent", "service_account", "system"]);
const uuidSchema = z.string().uuid();
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
export interface AdminUserRecord {
  readonly id: string;
  readonly orgId: string;
  readonly type: ActorType;
  readonly email: string | null;
  readonly displayName: string;
  readonly scopes: readonly string[];
  /** `suspended` can be restored; `removed` was offboarded or deprovisioned. */
  readonly status: AdminUserStatus;
  readonly disabledAt: string | null;
  /** When the person last signed in to this workspace; null if never. */
  readonly lastSignInAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

type AdminUserStatus = "active" | "suspended" | "removed";

export interface AdminUserLifecycleResult {
  readonly actorId: string;
  readonly status: "active" | "suspended";
  /** False when the account was already in the requested state. */
  readonly changed: boolean;
  /** Sessions signed out by a suspension. */
  readonly sessionsRevoked?: number;
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

export interface AdminUsersStore {
  listUsers(input: ListAdminUsersInput): Promise<readonly AdminUserRecord[]>;
  resetMfa(input: {
    readonly orgId: string;
    readonly targetActorId: string;
    readonly performedByActorId: string;
  }): Promise<boolean>;
  /** Suspend or restore a person; null when they are not in the workspace. */
  setSuspended(
    actor: Actor,
    targetActorId: string,
    suspended: boolean,
  ): Promise<AdminUserLifecycleResult | null>;
}

export interface RegisterAdminUsersRoutesOptions {
  readonly store: AdminUsersStore;
  readonly actorFromRequest: (request: FastifyRequest) => Promise<Actor> | Actor;
  readonly offboarding?: Pick<PostgresActorOffboardingStore, "preview" | "offboard">;
}

export class PostgresAdminUsersStore implements AdminUsersStore {
  constructor(private readonly sql: postgres.Sql) {}

  async listUsers(input: ListAdminUsersInput): Promise<readonly AdminUserRecord[]> {
    const cursorCreatedAt = input.cursor?.createdAt ?? null;
    const cursorId = input.cursor?.id ?? null;
    const query = input.query?.trim().toLowerCase() ?? null;
    const queryPattern = query === null ? null : `%${escapeLikePattern(query)}%`;
    const type = input.type ?? null;
    const rows = await this.sql<AdminUserRow[]>`
      select
        actor.id,
        actor.org_id,
        actor.type,
        actor.email,
        actor.display_name,
        actor.scopes,
        actor.disabled_at,
        membership.status as membership_status,
        membership.last_sign_in_at,
        actor.created_at,
        actor.updated_at
      from actors actor
      left join organization_memberships membership
        on membership.org_id = actor.org_id and membership.actor_id = actor.id
      where actor.org_id = ${input.orgId}
        and (${type}::actor_type is null or actor.type = ${type}::actor_type)
        and (${input.includeDisabled}::boolean or actor.disabled_at is null)
        and (
          ${query}::text is null
          or lower(coalesce(actor.email, '')) like ${queryPattern}::text escape '\'
          or lower(actor.display_name) like ${queryPattern}::text escape '\'
          or actor.id::text like ${queryPattern}::text escape '\'
        )
        and (
          ${cursorCreatedAt}::timestamptz is null
          or (actor.created_at, actor.id) < (${cursorCreatedAt}::timestamptz, ${cursorId}::uuid)
        )
      order by actor.created_at desc, actor.id desc
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

  async setSuspended(
    actor: Actor,
    targetActorId: string,
    suspended: boolean,
  ): Promise<AdminUserLifecycleResult | null> {
    try {
      return await withTenantPostgresContext(
        this.sql,
        { orgId: actor.orgId, actorId: actor.id },
        async (tx) => {
          const [row] = suspended
            ? await tx<{ result: AdminUserLifecycleResult | null }[]>`
                select helix_suspend_user(${actor.orgId}, ${targetActorId}) as result
              `
            : await tx<{ result: AdminUserLifecycleResult | null }[]>`
                select helix_restore_user(${actor.orgId}, ${targetActorId}) as result
              `;
          return row?.result ?? null;
        },
      );
    } catch (error) {
      if (error instanceof Error && "code" in error) {
        if (error.code === "23514") throw new ConflictError(error.message);
        if (error.code === "42501") throw new ForbiddenError(error.message);
      }
      throw error;
    }
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
  for (const [path, suspended] of [
    ["/api/admin/users/:actorId/suspend", true],
    ["/api/admin/users/:actorId/restore", false],
  ] as const) {
    app.post<{ Params: { actorId: string } }>(path, async (request, reply) => {
      const actor = await options.actorFromRequest(request);
      if (!canWriteAdminConsole(actor, adminUsersScope))
        return reply.code(403).send(permissionDeniedResponse());
      const target = uuidSchema.safeParse(request.params.actorId);
      if (!target.success) return reply.code(400).send({ error: "Invalid actor id." });
      const result = await options.store.setSuspended(actor, target.data, suspended);
      if (result === null) {
        return reply.code(404).send({ error: "That person isn't in this workspace." });
      }
      return result;
    });
  }
  if (options.offboarding !== undefined) {
    const offboarding = options.offboarding;
    const handoffSchema = z
      .object({
        successorActorId: uuidSchema.optional(),
        preserveReceivingAddresses: z.boolean().default(false),
      })
      .strict();
    const executeSchema = handoffSchema.extend({
      confirmationToken: z.string().regex(/^[a-f0-9]{32}$/),
    });
    app.post<{ Params: { actorId: string } }>(
      "/api/admin/users/:actorId/offboard/preview",
      async (request, reply) => {
        const actor = await options.actorFromRequest(request);
        if (!canWriteAdminConsole(actor, "admin.users"))
          return reply.code(403).send(permissionDeniedResponse());
        const target = uuidSchema.safeParse(request.params.actorId);
        const input = handoffSchema.safeParse(request.body);
        if (!target.success || !input.success)
          return reply.code(400).send({ error: "Invalid handoff request." });
        return offboarding.preview(actor, { actorId: target.data, ...input.data });
      },
    );
    app.post<{ Params: { actorId: string } }>(
      "/api/admin/users/:actorId/offboard",
      async (request, reply) => {
        const actor = await options.actorFromRequest(request);
        if (!canWriteAdminConsole(actor, "admin.users"))
          return reply.code(403).send(permissionDeniedResponse());
        const target = uuidSchema.safeParse(request.params.actorId);
        const input = executeSchema.safeParse(request.body);
        if (!target.success || !input.success)
          return reply.code(400).send({ error: "Review the handoff before offboarding." });
        if (target.data === actor.id)
          return reply.code(400).send({ error: "Administrators cannot offboard themselves." });
        return {
          offboard: await offboarding.offboard(actor, { actorId: target.data, ...input.data }),
        };
      },
    );
  }
}

export function canReadAdminUsers(actor: Actor): boolean {
  return actorHasScope(actor, adminUsersScope);
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
  readonly membership_status: "active" | "suspended" | "deprovisioned" | null;
  readonly last_sign_in_at: Date | null;
  readonly created_at: Date;
  readonly updated_at: Date;
}

function adminUserStatus(row: AdminUserRow): AdminUserStatus {
  if (row.membership_status === "suspended") return "suspended";
  if (row.membership_status === "deprovisioned") return "removed";
  return row.disabled_at === null ? "active" : "removed";
}

function mapAdminUserRow(row: AdminUserRow): AdminUserRecord {
  return {
    id: row.id,
    orgId: row.org_id,
    type: row.type,
    email: row.email,
    displayName: row.display_name,
    scopes: row.scopes,
    status: adminUserStatus(row),
    disabledAt: row.disabled_at?.toISOString() ?? null,
    lastSignInAt: row.last_sign_in_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}
