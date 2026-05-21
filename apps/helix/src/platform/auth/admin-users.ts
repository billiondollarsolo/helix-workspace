import type postgres from "postgres";
import type { Actor, ActorType } from "@helix/sdk-types";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";

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
      return reply.code(400).send({ error: "Invalid admin users query.", issues: parsed.error.issues });
    }

    const cursor = parsed.data.cursor === undefined ? undefined : decodeAdminUsersCursor(parsed.data.cursor);
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
}

export function canReadAdminUsers(actor: Actor): boolean {
  const scopes = actor.scopes ?? [];
  return scopes.includes(adminUsersScope) || scopes.includes("admin.*");
}

export function encodeAdminUsersCursor(record: Pick<AdminUserRecord, "createdAt" | "id">): string {
  return Buffer.from(JSON.stringify({ createdAt: record.createdAt, id: record.id }), "utf8").toString(
    "base64url",
  );
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

function booleanQuerySchema(): z.ZodEffects<z.ZodOptional<z.ZodBoolean>, boolean | undefined, unknown> {
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

function emptyStringToUndefined<T extends z.ZodTypeAny>(schema: T): z.ZodEffects<T, z.output<T>, unknown> {
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
