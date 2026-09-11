import type { Actor, ActorType } from "@helix/sdk-types";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type postgres from "postgres";
import { z } from "zod";
import { actorHasScope } from "../../api/scopes.js";
import { canWriteAdminConsole } from "../admin/console-shared.js";
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

export interface AdminUsersStore {
  listUsers(input: ListAdminUsersInput): Promise<readonly AdminUserRecord[]>;
  resetMfa(input: {
    readonly orgId: string;
    readonly targetActorId: string;
    readonly performedByActorId: string;
  }): Promise<boolean>;
}

export interface RegisterAdminUsersRoutesOptions {
  readonly store: AdminUsersStore;
  readonly actorFromRequest: (request: FastifyRequest) => Promise<Actor> | Actor;
  readonly offboarding?: Pick<PostgresActorOffboardingStore, "preview" | "offboard">;
}

interface PeopleDirectoryRecord {
  readonly id: string;
  readonly email: string | null;
  readonly displayName: string;
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
