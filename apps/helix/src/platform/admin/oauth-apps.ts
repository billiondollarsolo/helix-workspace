import type postgres from "postgres";
import type { Actor } from "@helix/sdk-types";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  adminConsoleReadScope,
  adminConsoleWriteScope,
  auditAdminAction,
  booleanQuery,
  canReadAdminConsole,
  canWriteAdminConsole,
  cursorQuerySchema,
  decodeCursor,
  emptyStringToUndefined,
  invalidCursor,
  invalidRequest,
  limitQuerySchema,
  notFound,
  paginate,
  sendForbidden,
  type AdminConsoleAuditSink,
  type KeysetCursor,
} from "./console-shared.js";

/**
 * Admin Console — OAuth apps.
 *
 * Third-party OAuth app registrations the org has encountered. The Apps
 * section of the Admin Console lists them with scope, user count, risk, and
 * status chips and supports approve / block / revoke from the row.
 *
 * `clientId` optionally ties a row to a first-party-issued OAuth client (the
 * `agent_credentials` / oauth model); revoking such a row is recorded here and
 * the lead can drive the credential revocation from the registered hook.
 */

export type OAuthAppRisk = "low" | "medium" | "high";
export type OAuthAppStatus = "approved" | "pending" | "blocked" | "revoked";

export interface OAuthAppRecord {
  readonly id: string;
  readonly orgId: string;
  readonly name: string;
  readonly clientId: string | null;
  readonly publisher: string;
  readonly scopes: readonly string[];
  readonly scopeSummary: string;
  readonly risk: OAuthAppRisk;
  readonly status: OAuthAppStatus;
  readonly userCount: number;
  readonly firstAuthorizedAt: string | null;
  readonly lastAuthorizedAt: string | null;
  readonly reviewedBy: string | null;
  readonly reviewedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

// --------------------------------------------------------------------------
// Store
// --------------------------------------------------------------------------

export interface ListOAuthAppsInput {
  readonly orgId: string;
  readonly cursor?: KeysetCursor | undefined;
  readonly limit: number;
  readonly status?: OAuthAppStatus | undefined;
  readonly risk?: OAuthAppRisk | undefined;
  readonly query?: string | undefined;
}

export interface CreateOAuthAppInput {
  readonly orgId: string;
  readonly name: string;
  readonly clientId: string | null;
  readonly publisher: string;
  readonly scopes: readonly string[];
  readonly scopeSummary: string;
  readonly risk: OAuthAppRisk;
  readonly status: OAuthAppStatus;
  readonly userCount: number;
}

export interface SetOAuthAppStatusInput {
  readonly orgId: string;
  readonly id: string;
  readonly status: OAuthAppStatus;
  readonly reviewedBy: string;
}

export interface OAuthAppsStore {
  /** Returns up to `limit + 1` rows so the caller can detect a next page. */
  list(input: ListOAuthAppsInput): Promise<readonly OAuthAppRecord[]>;
  get(orgId: string, id: string): Promise<OAuthAppRecord | null>;
  create(input: CreateOAuthAppInput): Promise<OAuthAppRecord>;
  setStatus(input: SetOAuthAppStatusInput): Promise<OAuthAppRecord | null>;
}

// --------------------------------------------------------------------------
// Validation
// --------------------------------------------------------------------------

const riskSchema = z.enum(["low", "medium", "high"]);
const statusSchema = z.enum(["approved", "pending", "blocked", "revoked"]);
const scopeSchema = z.string().trim().min(1).max(200);

const listQuery = z.object({
  cursor: cursorQuerySchema,
  limit: limitQuerySchema,
  status: emptyStringToUndefined(statusSchema.optional()),
  risk: emptyStringToUndefined(riskSchema.optional()),
  query: z
    .string()
    .trim()
    .max(200)
    .transform((value) => (value.length === 0 ? undefined : value))
    .optional(),
  // Accepted for forward compatibility with the UI's "show revoked" toggle.
  includeRevoked: booleanQuery().default(false),
});

const createBody = z
  .object({
    name: z.string().trim().min(1).max(200),
    clientId: z.string().trim().min(1).max(200).nullable().default(null),
    publisher: z.string().trim().max(200).default(""),
    scopes: z.array(scopeSchema).max(100).default([]),
    scopeSummary: z.string().trim().max(500).default(""),
    risk: riskSchema.default("low"),
    status: statusSchema.default("pending"),
    userCount: z.number().int().min(0).max(1_000_000).default(0),
  })
  .strict();

const statusBody = z
  .object({
    status: z.enum(["approved", "pending", "blocked"]),
  })
  .strict();

const idParams = z.object({ id: z.string().uuid() });

// --------------------------------------------------------------------------
// Routes
// --------------------------------------------------------------------------

export interface RegisterAdminOAuthAppsRoutesOptions {
  readonly store: OAuthAppsStore;
  readonly actorFromRequest: (request: FastifyRequest) => Promise<Actor> | Actor;
  readonly auditSink?: AdminConsoleAuditSink | undefined;
  /**
   * Optional hook invoked after a row is revoked, carrying the row's
   * `clientId` (if any) so the lead can revoke the matching OAuth credential.
   */
  readonly onRevoke?: (input: {
    readonly orgId: string;
    readonly app: OAuthAppRecord;
  }) => Promise<void> | void;
}

/**
 * Register the OAuth apps admin routes:
 *
 *   GET    /api/admin/oauth-apps                 — paginated list (filters)
 *   GET    /api/admin/oauth-apps/:id             — one app
 *   POST   /api/admin/oauth-apps                 — register an app
 *   PATCH  /api/admin/oauth-apps/:id/status      — approve / block / pending
 *   POST   /api/admin/oauth-apps/:id/revoke      — revoke (terminal)
 */
export async function registerAdminOAuthAppsRoutes(
  app: FastifyInstance,
  options: RegisterAdminOAuthAppsRoutesOptions,
): Promise<void> {
  const { store, actorFromRequest, auditSink, onRevoke } = options;

  app.get("/api/admin/oauth-apps", async (request, reply) => {
    const actor = await actorFromRequest(request);
    if (!canReadAdminConsole(actor)) {
      return sendForbidden(reply, adminConsoleReadScope);
    }
    const parsed = listQuery.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send(invalidRequest("Invalid OAuth apps query.", parsed.error.issues));
    }
    const cursor = parsed.data.cursor === undefined ? undefined : decodeCursor(parsed.data.cursor);
    if (cursor === null) {
      return reply.code(400).send(invalidCursor());
    }
    const rows = await store.list({
      orgId: actor.orgId,
      limit: parsed.data.limit + 1,
      ...(cursor === undefined ? {} : { cursor }),
      ...(parsed.data.status === undefined ? {} : { status: parsed.data.status }),
      ...(parsed.data.risk === undefined ? {} : { risk: parsed.data.risk }),
      ...(parsed.data.query === undefined ? {} : { query: parsed.data.query }),
    });
    const page = paginate(rows, parsed.data.limit);
    return { apps: page.items, nextCursor: page.nextCursor };
  });

  app.get("/api/admin/oauth-apps/:id", async (request, reply) => {
    const actor = await actorFromRequest(request);
    if (!canReadAdminConsole(actor)) {
      return sendForbidden(reply, adminConsoleReadScope);
    }
    const params = idParams.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send(invalidRequest("Invalid OAuth app id."));
    }
    const oauthApp = await store.get(actor.orgId, params.data.id);
    if (oauthApp === null) {
      return reply.code(404).send(notFound("OAuth app not found."));
    }
    return { app: oauthApp };
  });

  app.post("/api/admin/oauth-apps", async (request, reply) => {
    const actor = await actorFromRequest(request);
    if (!canWriteAdminConsole(actor)) {
      return sendForbidden(reply, adminConsoleWriteScope);
    }
    const body = createBody.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send(invalidRequest("Invalid OAuth app.", body.error.issues));
    }
    const oauthApp = await store.create({
      orgId: actor.orgId,
      name: body.data.name,
      clientId: body.data.clientId,
      publisher: body.data.publisher,
      scopes: body.data.scopes,
      scopeSummary: body.data.scopeSummary,
      risk: body.data.risk,
      status: body.data.status,
      userCount: body.data.userCount,
    });
    await auditAdminAction(auditSink, {
      orgId: actor.orgId,
      actorId: actor.id,
      verb: "admin.oauth_app.created",
      objectType: "admin_oauth_app",
      objectId: oauthApp.id,
      metadata: { name: oauthApp.name, risk: oauthApp.risk, status: oauthApp.status },
    });
    return reply.code(201).send({ app: oauthApp });
  });

  app.patch("/api/admin/oauth-apps/:id/status", async (request, reply) => {
    const actor = await actorFromRequest(request);
    if (!canWriteAdminConsole(actor)) {
      return sendForbidden(reply, adminConsoleWriteScope);
    }
    const params = idParams.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send(invalidRequest("Invalid OAuth app id."));
    }
    const body = statusBody.safeParse(request.body);
    if (!body.success) {
      return reply
        .code(400)
        .send(invalidRequest("Invalid OAuth app status.", body.error.issues));
    }
    const oauthApp = await store.setStatus({
      orgId: actor.orgId,
      id: params.data.id,
      status: body.data.status,
      reviewedBy: actor.id,
    });
    if (oauthApp === null) {
      return reply.code(404).send(notFound("OAuth app not found."));
    }
    await auditAdminAction(auditSink, {
      orgId: actor.orgId,
      actorId: actor.id,
      verb: "admin.oauth_app.status_changed",
      objectType: "admin_oauth_app",
      objectId: oauthApp.id,
      metadata: { status: oauthApp.status },
    });
    return { app: oauthApp };
  });

  app.post("/api/admin/oauth-apps/:id/revoke", async (request, reply) => {
    const actor = await actorFromRequest(request);
    if (!canWriteAdminConsole(actor)) {
      return sendForbidden(reply, adminConsoleWriteScope);
    }
    const params = idParams.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send(invalidRequest("Invalid OAuth app id."));
    }
    const oauthApp = await store.setStatus({
      orgId: actor.orgId,
      id: params.data.id,
      status: "revoked",
      reviewedBy: actor.id,
    });
    if (oauthApp === null) {
      return reply.code(404).send(notFound("OAuth app not found."));
    }
    if (onRevoke !== undefined) {
      await onRevoke({ orgId: actor.orgId, app: oauthApp });
    }
    await auditAdminAction(auditSink, {
      orgId: actor.orgId,
      actorId: actor.id,
      verb: "admin.oauth_app.revoked",
      objectType: "admin_oauth_app",
      objectId: oauthApp.id,
      metadata: { name: oauthApp.name, clientId: oauthApp.clientId },
    });
    return { app: oauthApp };
  });
}

// --------------------------------------------------------------------------
// Postgres store
// --------------------------------------------------------------------------

interface OAuthAppRow {
  readonly id: string;
  readonly org_id: string;
  readonly name: string;
  readonly client_id: string | null;
  readonly publisher: string;
  readonly scopes: readonly string[];
  readonly scope_summary: string;
  readonly risk: OAuthAppRisk;
  readonly status: OAuthAppStatus;
  readonly user_count: string | number;
  readonly first_authorized_at: Date | null;
  readonly last_authorized_at: Date | null;
  readonly reviewed_by: string | null;
  readonly reviewed_at: Date | null;
  readonly created_at: Date;
  readonly updated_at: Date;
}

export class PostgresOAuthAppsStore implements OAuthAppsStore {
  constructor(private readonly sql: postgres.Sql) {}

  async list(input: ListOAuthAppsInput): Promise<readonly OAuthAppRecord[]> {
    const cursorCreatedAt = input.cursor?.createdAt ?? null;
    const cursorId = input.cursor?.id ?? null;
    const status = input.status ?? null;
    const risk = input.risk ?? null;
    const query = input.query?.trim().toLowerCase() ?? null;
    const queryPattern = query === null ? null : `%${escapeLike(query)}%`;
    const rows = (await this.sql`
      select id, org_id, name, client_id, publisher, scopes, scope_summary,
             risk, status, user_count, first_authorized_at, last_authorized_at,
             reviewed_by, reviewed_at, created_at, updated_at
      from admin_oauth_apps
      where org_id = ${input.orgId}
        and (${status}::text is null or status = ${status}::text)
        and (${risk}::text is null or risk = ${risk}::text)
        and (
          ${query}::text is null
          or lower(name) like ${queryPattern}::text escape '\'
          or lower(publisher) like ${queryPattern}::text escape '\'
        )
        and (
          ${cursorCreatedAt}::timestamptz is null
          or (created_at, id) < (${cursorCreatedAt}::timestamptz, ${cursorId}::uuid)
        )
      order by created_at desc, id desc
      limit ${input.limit}
    `) as unknown as readonly OAuthAppRow[];
    return rows.map(mapOAuthAppRow);
  }

  async get(orgId: string, id: string): Promise<OAuthAppRecord | null> {
    const rows = (await this.sql`
      select id, org_id, name, client_id, publisher, scopes, scope_summary,
             risk, status, user_count, first_authorized_at, last_authorized_at,
             reviewed_by, reviewed_at, created_at, updated_at
      from admin_oauth_apps
      where org_id = ${orgId} and id = ${id}
    `) as unknown as readonly OAuthAppRow[];
    const row = rows[0];
    return row === undefined ? null : mapOAuthAppRow(row);
  }

  async create(input: CreateOAuthAppInput): Promise<OAuthAppRecord> {
    const rows = (await this.sql`
      insert into admin_oauth_apps
        (org_id, name, client_id, publisher, scopes, scope_summary, risk, status, user_count)
      values
        (${input.orgId}, ${input.name}, ${input.clientId}, ${input.publisher},
         ${this.sql.array(input.scopes as string[])}, ${input.scopeSummary},
         ${input.risk}, ${input.status}, ${input.userCount})
      returning id, org_id, name, client_id, publisher, scopes, scope_summary,
                risk, status, user_count, first_authorized_at, last_authorized_at,
                reviewed_by, reviewed_at, created_at, updated_at
    `) as unknown as readonly OAuthAppRow[];
    const row = rows[0];
    if (row === undefined) {
      throw new Error("Failed to create OAuth app.");
    }
    return mapOAuthAppRow(row);
  }

  async setStatus(input: SetOAuthAppStatusInput): Promise<OAuthAppRecord | null> {
    const rows = (await this.sql`
      update admin_oauth_apps
      set status = ${input.status}, reviewed_by = ${input.reviewedBy},
          reviewed_at = now(), updated_at = now()
      where org_id = ${input.orgId} and id = ${input.id}
      returning id, org_id, name, client_id, publisher, scopes, scope_summary,
                risk, status, user_count, first_authorized_at, last_authorized_at,
                reviewed_by, reviewed_at, created_at, updated_at
    `) as unknown as readonly OAuthAppRow[];
    const row = rows[0];
    return row === undefined ? null : mapOAuthAppRow(row);
  }
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/gu, "\\$&");
}

function mapOAuthAppRow(row: OAuthAppRow): OAuthAppRecord {
  return {
    id: row.id,
    orgId: row.org_id,
    name: row.name,
    clientId: row.client_id,
    publisher: row.publisher,
    scopes: row.scopes,
    scopeSummary: row.scope_summary,
    risk: row.risk,
    status: row.status,
    userCount: Number(row.user_count),
    firstAuthorizedAt: row.first_authorized_at?.toISOString() ?? null,
    lastAuthorizedAt: row.last_authorized_at?.toISOString() ?? null,
    reviewedBy: row.reviewed_by,
    reviewedAt: row.reviewed_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

// --------------------------------------------------------------------------
// In-memory store (tests / offline)
// --------------------------------------------------------------------------

/** Deterministic in-memory {@link OAuthAppsStore}. */
export class InMemoryOAuthAppsStore implements OAuthAppsStore {
  readonly #apps: OAuthAppRecord[] = [];
  #seq = 0;

  constructor(private readonly options: { readonly now?: () => Date } = {}) {}

  #now(): Date {
    return (this.options.now ?? (() => new Date("2026-05-21T00:00:00.000Z")))();
  }

  #id(): string {
    this.#seq += 1;
    return `00000000-0000-4000-a000-${this.#seq.toString(16).padStart(12, "0")}`;
  }

  async list(input: ListOAuthAppsInput): Promise<readonly OAuthAppRecord[]> {
    const query = input.query?.trim().toLowerCase();
    return this.#apps
      .filter((oauthApp) => oauthApp.orgId === input.orgId)
      .filter((oauthApp) => input.status === undefined || oauthApp.status === input.status)
      .filter((oauthApp) => input.risk === undefined || oauthApp.risk === input.risk)
      .filter(
        (oauthApp) =>
          query === undefined ||
          oauthApp.name.toLowerCase().includes(query) ||
          oauthApp.publisher.toLowerCase().includes(query),
      )
      .sort((a, b) =>
        a.createdAt === b.createdAt
          ? b.id.localeCompare(a.id)
          : b.createdAt.localeCompare(a.createdAt),
      )
      .filter((oauthApp) => {
        if (input.cursor === undefined) {
          return true;
        }
        const cursorKey = `${input.cursor.createdAt.toISOString()}:${input.cursor.id}`;
        return `${oauthApp.createdAt}:${oauthApp.id}` < cursorKey;
      })
      .slice(0, input.limit);
  }

  async get(orgId: string, id: string): Promise<OAuthAppRecord | null> {
    return this.#apps.find((oauthApp) => oauthApp.orgId === orgId && oauthApp.id === id) ?? null;
  }

  async create(input: CreateOAuthAppInput): Promise<OAuthAppRecord> {
    const now = this.#now().toISOString();
    const record: OAuthAppRecord = {
      id: this.#id(),
      orgId: input.orgId,
      name: input.name,
      clientId: input.clientId,
      publisher: input.publisher,
      scopes: input.scopes,
      scopeSummary: input.scopeSummary,
      risk: input.risk,
      status: input.status,
      userCount: input.userCount,
      firstAuthorizedAt: null,
      lastAuthorizedAt: null,
      reviewedBy: null,
      reviewedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    this.#apps.push(record);
    return record;
  }

  async setStatus(input: SetOAuthAppStatusInput): Promise<OAuthAppRecord | null> {
    const index = this.#apps.findIndex(
      (oauthApp) => oauthApp.orgId === input.orgId && oauthApp.id === input.id,
    );
    if (index === -1) {
      return null;
    }
    const existing = this.#apps[index];
    if (existing === undefined) {
      return null;
    }
    const now = this.#now().toISOString();
    const updated: OAuthAppRecord = {
      ...existing,
      status: input.status,
      reviewedBy: input.reviewedBy,
      reviewedAt: now,
      updatedAt: now,
    };
    this.#apps[index] = updated;
    return updated;
  }
}
