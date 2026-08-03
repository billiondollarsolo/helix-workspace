import type postgres from "postgres";
import type { Actor, ActorType } from "@helix/sdk-types";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod3";

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
}

export interface RegisterAdminUsersRoutesOptions {
  readonly store: AdminUsersStore;
  readonly actorFromRequest: (request: FastifyRequest) => Promise<Actor> | Actor;
  /**
   * When set, exposes `POST /api/admin/users/:actorId/offboard` (E7.2 cascade:
   * disable actor, revoke sessions, app passwords, agent credentials).
   */
  readonly offboardStores?: OffboardUserStores;
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
  const rows = (await sql`
    update actors
    set disabled_at = ${input.disabledAt}, updated_at = ${input.disabledAt}
    where id = ${input.actorId}
      and org_id = ${input.orgId}
      and disabled_at is null
    returning id
  `) as unknown as readonly { readonly id: string }[];
  return rows.length > 0;
}

/**
 * Postgres helper: true when the actor row exists in the given organization.
 */
export async function actorExistsInOrg(
  sql: postgres.Sql,
  input: { readonly orgId: string; readonly actorId: string },
): Promise<boolean> {
  const rows = (await sql`
    select id
    from actors
    where id = ${input.actorId}
      and org_id = ${input.orgId}
    limit 1
  `) as unknown as readonly { readonly id: string }[];
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

  async listUsers(input: ListAdminUsersInput): Promise<readonly AdminUserRecord[]> {
    const cursorCreatedAt = input.cursor?.createdAt ?? null;
    const cursorId = input.cursor?.id ?? null;
    const query = input.query?.trim().toLowerCase() ?? null;
    const queryPattern = query === null ? null : `%${escapeLikePattern(query)}%`;
    const type = input.type ?? null;
    const rows = (await this.sql`
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
    `) as unknown as readonly AdminUserRow[];
    return rows.map(mapAdminUserRow);
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
  const scopes = actor.scopes ?? [];
  return scopes.includes(adminUsersScope) || scopes.includes("admin.*");
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
