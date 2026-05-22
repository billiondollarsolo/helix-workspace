import { betterAuth } from "better-auth";
import { fromNodeHeaders } from "better-auth/node";
import type postgres from "postgres";
import { Pool } from "pg";
import type { IncomingHttpHeaders } from "node:http";
import type { Actor, JsonObject } from "@helix/sdk";

export interface BetterAuthInstance {
  readonly api: {
    getSession(input: { readonly headers: Headers }): Promise<unknown>;
  };
  handler(request: Request): Promise<Response>;
}

export interface BetterAuthUser {
  readonly id: string;
  readonly email?: string | null;
  readonly name?: string | null;
  readonly image?: string | null;
  readonly emailVerified?: boolean;
  readonly createdAt?: Date | string;
  readonly updatedAt?: Date | string;
}

export interface ActorUserRecord {
  readonly id: string;
  readonly orgId: string;
  readonly type: "user";
  readonly email: string | null;
  readonly displayName: string;
  readonly scopes: readonly string[];
  readonly metadata: JsonObject;
}

export interface BetterAuthActorStore {
  findUserActorByBetterAuthId(authUserId: string): Promise<ActorUserRecord | null>;
  findUserActorByEmail(orgId: string, email: string): Promise<ActorUserRecord | null>;
  createUserActor(input: {
    readonly orgId: string;
    readonly email: string | null;
    readonly displayName: string;
    readonly metadata: JsonObject;
  }): Promise<ActorUserRecord>;
  linkBetterAuthUser(input: {
    readonly actorId: string;
    readonly authUserId: string;
    readonly metadata: JsonObject;
  }): Promise<ActorUserRecord>;
}

export interface BetterAuthUserLinkStore {
  linkUserToActor(input: {
    readonly authUserId: string;
    readonly actorId: string;
  }): Promise<void>;
}

export interface BetterAuthPlatformModuleOptions {
  readonly actorStore: BetterAuthActorStore;
  readonly userLinkStore?: BetterAuthUserLinkStore;
  readonly defaultOrgId: string;
}

export interface BetterAuthActorResolution {
  readonly actor: Actor;
  readonly user: BetterAuthUser;
}

export class BetterAuthPlatformModule {
  constructor(private readonly options: BetterAuthPlatformModuleOptions) {}

  async resolveUserActor(user: BetterAuthUser, orgId = this.options.defaultOrgId): Promise<BetterAuthActorResolution> {
    const linked = await this.options.actorStore.findUserActorByBetterAuthId(user.id);
    if (linked !== null) {
      await this.linkAuthUserToActor(user.id, linked.id);
      return { actor: toActor(linked), user };
    }

    const email = normalizeEmail(user.email);
    const existing = email === null ? null : await this.options.actorStore.findUserActorByEmail(orgId, email);
    const metadata = betterAuthMetadata(user);

    if (existing !== null) {
      const linkedActor = await this.options.actorStore.linkBetterAuthUser({
        actorId: existing.id,
        authUserId: user.id,
        metadata,
      });
      await this.linkAuthUserToActor(user.id, linkedActor.id);
      return { actor: toActor(linkedActor), user };
    }

    const created = await this.options.actorStore.createUserActor({
      orgId,
      email,
      displayName: displayNameForUser(user, email),
      metadata,
    });
    await this.linkAuthUserToActor(user.id, created.id);
    return { actor: toActor(created), user };
  }

  private async linkAuthUserToActor(authUserId: string, actorId: string): Promise<void> {
    await this.options.userLinkStore?.linkUserToActor({ authUserId, actorId });
  }
}

interface ActorUserRow {
  readonly id: string;
  readonly org_id: string;
  readonly type: "user";
  readonly email: string | null;
  readonly display_name: string;
  readonly scopes: readonly string[] | null;
  readonly metadata: JsonObject;
}

export class PostgresBetterAuthActorStore implements BetterAuthActorStore {
  constructor(private readonly sql: postgres.Sql) {}

  async findUserActorByBetterAuthId(authUserId: string): Promise<ActorUserRecord | null> {
    const selectedRows = await this.sql`
      select id, org_id, type, email, display_name, scopes, metadata
      from actors
      where type = 'user'
        and disabled_at is null
        and metadata -> 'betterAuth' ->> 'userId' = ${authUserId}
      limit 1
    `;
    const rows = selectedRows as unknown as readonly ActorUserRow[];
    return rowToActorUser(rows[0]);
  }

  async findUserActorByEmail(orgId: string, email: string): Promise<ActorUserRecord | null> {
    const selectedRows = await this.sql`
      select id, org_id, type, email, display_name, scopes, metadata
      from actors
      where org_id = ${orgId}
        and type = 'user'
        and disabled_at is null
        and lower(email) = ${email.toLowerCase()}
      limit 1
    `;
    const rows = selectedRows as unknown as readonly ActorUserRow[];
    return rowToActorUser(rows[0]);
  }

  async createUserActor(input: {
    readonly orgId: string;
    readonly email: string | null;
    readonly displayName: string;
    readonly metadata: JsonObject;
  }): Promise<ActorUserRecord> {
    const insertedRows = await this.sql`
      insert into actors (
        org_id,
        type,
        email,
        display_name,
        metadata
      )
      values (
        ${input.orgId},
        ${"user"},
        ${input.email},
        ${input.displayName},
        ${this.sql.json(input.metadata)}
      )
      returning id, org_id, type, email, display_name, scopes, metadata
    `;
    const rows = insertedRows as unknown as readonly ActorUserRow[];
    const actor = rowToActorUser(rows[0]);
    if (actor === null) {
      throw new Error("Failed to create BetterAuth user actor.");
    }
    return actor;
  }

  async linkBetterAuthUser(input: {
    readonly actorId: string;
    readonly authUserId: string;
    readonly metadata: JsonObject;
  }): Promise<ActorUserRecord> {
    const updatedRows = await this.sql`
      update actors
      set metadata = metadata || ${this.sql.json(input.metadata)},
          updated_at = now()
      where id = ${input.actorId}
        and type = 'user'
        and disabled_at is null
      returning id, org_id, type, email, display_name, scopes, metadata
    `;
    const rows = updatedRows as unknown as readonly ActorUserRow[];
    const actor = rowToActorUser(rows[0]);
    if (actor === null) {
      throw new Error(`Failed to link BetterAuth user ${input.authUserId} to actor ${input.actorId}.`);
    }
    return actor;
  }
}

export class PostgresBetterAuthUserLinkStore implements BetterAuthUserLinkStore {
  constructor(private readonly sql: postgres.Sql) {}

  async linkUserToActor(input: {
    readonly authUserId: string;
    readonly actorId: string;
  }): Promise<void> {
    await this.sql`
      update "user"
      set actor_id = ${input.actorId},
          "updatedAt" = now()
      where id = ${input.authUserId}
        and (actor_id is null or actor_id = ${input.actorId})
    `;
  }
}

export interface BetterAuthSessionVerifier {
  getSessionUser(request: { readonly headers: IncomingHttpHeaders }): Promise<BetterAuthUser | null>;
}

export class BetterAuthApiSessionVerifier implements BetterAuthSessionVerifier {
  constructor(private readonly auth: Pick<BetterAuthInstance, "api">) {}

  async getSessionUser(request: { readonly headers: IncomingHttpHeaders }): Promise<BetterAuthUser | null> {
    const session = await this.auth.api.getSession({
      headers: fromNodeHeaders(request.headers),
    });
    return betterAuthUserFromSession(session);
  }
}

export interface BetterAuthRuntimeConfig {
  readonly databaseUrl: string;
  readonly secret: string;
  readonly baseUrl: string;
  readonly trustedOrigins?: readonly string[];
}

export interface BetterAuthRuntime {
  readonly auth: BetterAuthInstance;
  readonly pool: Pool;
  readonly sessionVerifier: BetterAuthSessionVerifier;
}

export function createBetterAuthRuntime(config: BetterAuthRuntimeConfig): BetterAuthRuntime {
  const pool = new Pool({ connectionString: config.databaseUrl });
  const auth = betterAuth({
    database: pool,
    secret: config.secret,
    baseURL: config.baseUrl,
    ...(config.trustedOrigins === undefined ? {} : { trustedOrigins: [...config.trustedOrigins] }),
    emailAndPassword: {
      enabled: true,
    },
    user: {
      additionalFields: {
        actorId: {
          type: "string",
          required: false,
          input: false,
          fieldName: "actor_id",
        },
      },
    },
    advanced: {
      cookiePrefix: "helix",
      cookies: {
        session_token: {
          name: "helix_session",
        },
      },
    },
  }) as unknown as BetterAuthInstance;
  return {
    auth,
    pool,
    sessionVerifier: new BetterAuthApiSessionVerifier(auth),
  };
}

export function createBetterAuthSessionActorResolver(
  module: BetterAuthPlatformModule,
  verifier: BetterAuthSessionVerifier,
): (request: { readonly headers: IncomingHttpHeaders }) => Promise<Actor | null> {
  return async (request) => {
    const user = await verifier.getSessionUser(request);
    if (user === null) {
      return null;
    }
    const resolved = await module.resolveUserActor(user);
    return resolved.actor;
  };
}

export function createBetterAuthPlatformModule(
  options: BetterAuthPlatformModuleOptions,
): BetterAuthPlatformModule {
  return new BetterAuthPlatformModule(options);
}

function rowToActorUser(row: ActorUserRow | undefined): ActorUserRecord | null {
  if (row === undefined) {
    return null;
  }
  return {
    id: row.id,
    orgId: row.org_id,
    type: row.type,
    email: row.email,
    displayName: row.display_name,
    scopes: row.scopes ?? [],
    metadata: row.metadata,
  };
}

function toActor(record: ActorUserRecord): Actor {
  return {
    id: record.id,
    orgId: record.orgId,
    type: "user",
    displayName: record.displayName,
    // Carry the actor's scopes so session-authenticated requests are
    // authorized identically to bearer-token (OAuth) requests.
    scopes: record.scopes,
    ...(record.email === null ? {} : { email: record.email }),
  };
}

function normalizeEmail(email: string | null | undefined): string | null {
  if (email === null || email === undefined) {
    return null;
  }
  const normalized = email.trim().toLowerCase();
  return normalized.length === 0 ? null : normalized;
}

function displayNameForUser(user: BetterAuthUser, email: string | null): string {
  const name = user.name?.trim();
  if (name !== undefined && name.length > 0) {
    return name;
  }
  if (email !== null) {
    return email;
  }
  return `User ${user.id}`;
}

function betterAuthMetadata(user: BetterAuthUser): JsonObject {
  return {
    betterAuth: {
      userId: user.id,
      ...(user.image === null || user.image === undefined ? {} : { image: user.image }),
      ...(user.emailVerified === undefined ? {} : { emailVerified: user.emailVerified }),
    },
  };
}

function betterAuthUserFromSession(session: unknown): BetterAuthUser | null {
  if (!isRecord(session) || !isRecord(session.user) || typeof session.user.id !== "string") {
    return null;
  }
  return {
    id: session.user.id,
    ...(typeof session.user.email === "string" ? { email: session.user.email } : {}),
    ...(typeof session.user.name === "string" ? { name: session.user.name } : {}),
    ...(typeof session.user.image === "string" ? { image: session.user.image } : {}),
    ...(typeof session.user.emailVerified === "boolean"
      ? { emailVerified: session.user.emailVerified }
      : {}),
    ...(session.user.createdAt instanceof Date || typeof session.user.createdAt === "string"
      ? { createdAt: session.user.createdAt }
      : {}),
    ...(session.user.updatedAt instanceof Date || typeof session.user.updatedAt === "string"
      ? { updatedAt: session.user.updatedAt }
      : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
