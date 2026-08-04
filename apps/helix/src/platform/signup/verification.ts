import { hashPassword } from "@better-auth/utils/password";
import type postgres from "postgres";
import type { JsonObject } from "@helix/sdk-types";
import { randomBytes, sha256Hex } from "../crypto/index.js";

export const signupEmailVerificationTtlSeconds = 24 * 60 * 60;

export interface SignupEmailVerificationRecord {
  readonly orgId: string;
  readonly email: string;
  readonly passwordHash: string;
  readonly expiresAt: Date;
  readonly consumedAt: Date | null;
  readonly metadata: JsonObject;
}

export interface SignupEmailVerificationIssueResult extends SignupEmailVerificationRecord {
  readonly token: string;
}

export type SignupEmailVerificationReissueResult =
  | {
      readonly status: "issued";
      readonly verification: SignupEmailVerificationIssueResult;
    }
  | { readonly status: "not_found" }
  | { readonly status: "rate_limited"; readonly retryAfterSeconds: number };

export interface SignupEmailVerificationTokenStore {
  issue(input: {
    readonly orgId: string;
    readonly email: string;
    readonly password: string;
    readonly metadata?: JsonObject | undefined;
    readonly now?: Date | undefined;
  }): Promise<SignupEmailVerificationIssueResult>;
  findValid(input: {
    readonly token: string;
    readonly now?: Date | undefined;
  }): Promise<SignupEmailVerificationRecord | null>;
  consume(input: {
    readonly token: string;
    readonly now?: Date | undefined;
  }): Promise<SignupEmailVerificationRecord | null>;
  reissueFromToken?(input: {
    readonly token: string;
    readonly now?: Date | undefined;
    readonly limit?: number | undefined;
    readonly windowSeconds?: number | undefined;
  }): Promise<SignupEmailVerificationReissueResult>;
}

export interface SignupVerifiedIdentityRecord {
  readonly actorId: string;
  readonly betterAuthUserId: string;
}

export interface SignupVerifiedIdentityStore {
  createVerifiedCredentialUser(input: {
    readonly orgId: string;
    readonly email: string;
    readonly passwordHash: string;
  }): Promise<SignupVerifiedIdentityRecord | null>;
}

export interface SignupOwnerEmailRecord {
  readonly orgId: string;
  readonly email: string;
}

export interface SignupOwnerEmailLookup {
  findOwnerByEmail(email: string): Promise<SignupOwnerEmailRecord | null>;
}

interface SignupEmailVerificationRow {
  readonly org_id: string;
  readonly email: string;
  readonly password_hash: string;
  readonly expires_at: Date;
  readonly consumed_at: Date | null;
  readonly metadata: JsonObject;
}

interface SignupActorRow {
  readonly id: string;
  readonly display_name: string;
}

interface BetterAuthUserRow {
  readonly id: string;
  readonly actor_id: string | null;
}

interface SignupOwnerEmailRow {
  readonly org_id: string;
  readonly email: string;
}

export class PostgresSignupEmailVerificationTokenStore implements SignupEmailVerificationTokenStore {
  constructor(private readonly sql: postgres.Sql) {}

  async issue(input: {
    readonly orgId: string;
    readonly email: string;
    readonly password: string;
    readonly metadata?: JsonObject | undefined;
    readonly now?: Date | undefined;
  }): Promise<SignupEmailVerificationIssueResult> {
    const email = normalizeSignupEmail(input.email);
    const token = generateSignupEmailVerificationToken();
    const tokenHash = hashSignupEmailVerificationToken(token);
    const passwordHash = await hashPassword(input.password);
    const issuedAt = input.now ?? new Date();
    const expiresAt = new Date(issuedAt.getTime() + signupEmailVerificationTtlSeconds * 1000);
    const rows = (await this.sql`
      insert into signup_email_verifications (
        org_id,
        email,
        password_hash,
        token_hash,
        expires_at,
        consumed_at,
        metadata
      )
      values (
        ${input.orgId},
        ${email},
        ${passwordHash},
        ${tokenHash},
        ${expiresAt},
        null,
        ${this.sql.json(input.metadata ?? {})}
      )
      on conflict (org_id) do update
      set
        email = excluded.email,
        password_hash = excluded.password_hash,
        token_hash = excluded.token_hash,
        expires_at = excluded.expires_at,
        consumed_at = null,
        metadata = excluded.metadata,
        updated_at = now()
      returning org_id, email, password_hash, expires_at, consumed_at, metadata
    `) as unknown as readonly SignupEmailVerificationRow[];
    return { ...mapSignupEmailVerificationRow(rows[0]), token };
  }

  async findValid(input: {
    readonly token: string;
    readonly now?: Date | undefined;
  }): Promise<SignupEmailVerificationRecord | null> {
    const rows = (await this.sql`
      select org_id, email, password_hash, expires_at, consumed_at, metadata
      from signup_email_verifications
      where token_hash = ${hashSignupEmailVerificationToken(input.token)}
        and consumed_at is null
        and expires_at > ${input.now ?? new Date()}
      limit 1
    `) as unknown as readonly SignupEmailVerificationRow[];
    return rows[0] === undefined ? null : mapSignupEmailVerificationRow(rows[0]);
  }

  async consume(input: {
    readonly token: string;
    readonly now?: Date | undefined;
  }): Promise<SignupEmailVerificationRecord | null> {
    const now = input.now ?? new Date();
    const rows = (await this.sql`
      update signup_email_verifications
      set
        consumed_at = ${now},
        updated_at = now()
      where token_hash = ${hashSignupEmailVerificationToken(input.token)}
        and consumed_at is null
        and expires_at > ${now}
      returning org_id, email, password_hash, expires_at, consumed_at, metadata
    `) as unknown as readonly SignupEmailVerificationRow[];
    return rows[0] === undefined ? null : mapSignupEmailVerificationRow(rows[0]);
  }

  async reissueFromToken(input: {
    readonly token: string;
    readonly now?: Date | undefined;
    readonly limit?: number | undefined;
    readonly windowSeconds?: number | undefined;
  }): Promise<SignupEmailVerificationReissueResult> {
    const now = input.now ?? new Date();
    const limit = input.limit ?? 5;
    const windowSeconds = input.windowSeconds ?? 24 * 60 * 60;
    const existingRows = (await this.sql`
      select org_id, email, password_hash, expires_at, consumed_at, metadata
      from signup_email_verifications
      where token_hash = ${hashSignupEmailVerificationToken(input.token)}
        and consumed_at is null
      limit 1
    `) as unknown as readonly SignupEmailVerificationRow[];
    const existing = existingRows[0];
    if (existing === undefined) {
      return { status: "not_found" };
    }

    const resend = nextResendMetadata(existing.metadata, {
      now,
      limit,
      windowSeconds,
    });
    if (resend.status === "rate_limited") {
      return resend;
    }

    const token = generateSignupEmailVerificationToken();
    const expiresAt = new Date(now.getTime() + signupEmailVerificationTtlSeconds * 1000);
    const rows = (await this.sql`
      update signup_email_verifications
      set
        token_hash = ${hashSignupEmailVerificationToken(token)},
        expires_at = ${expiresAt},
        consumed_at = null,
        metadata = ${this.sql.json(resend.metadata)},
        updated_at = now()
      where org_id = ${existing.org_id}
        and consumed_at is null
      returning org_id, email, password_hash, expires_at, consumed_at, metadata
    `) as unknown as readonly SignupEmailVerificationRow[];
    const record = mapSignupEmailVerificationRow(rows[0]);
    return { status: "issued", verification: { ...record, token } };
  }
}

export class PostgresSignupVerifiedIdentityStore implements SignupVerifiedIdentityStore {
  constructor(private readonly sql: postgres.Sql) {}

  async createVerifiedCredentialUser(input: {
    readonly orgId: string;
    readonly email: string;
    readonly passwordHash: string;
  }): Promise<SignupVerifiedIdentityRecord | null> {
    const email = normalizeSignupEmail(input.email);
    const actorRows = (await this.sql`
      select id, display_name
      from actors
      where org_id = ${input.orgId}
        and type = 'user'
        and disabled_at is null
        and lower(email) = ${email}
      limit 1
    `) as unknown as readonly SignupActorRow[];
    const actor = actorRows[0];
    if (actor === undefined) {
      return null;
    }

    const existingRows = (await this.sql`
      select id, actor_id
      from "user"
      where lower(email) = ${email}
      limit 1
    `) as unknown as readonly BetterAuthUserRow[];
    const existingUser = existingRows[0];
    if (existingUser !== undefined && existingUser.actor_id !== actor.id) {
      return null;
    }

    const betterAuthUserId = existingUser?.id ?? `signup-${actor.id}`;
    await this.sql`
      insert into "user" (id, name, email, "emailVerified", actor_id, "createdAt", "updatedAt")
      values (${betterAuthUserId}, ${actor.display_name}, ${email}, true, ${actor.id}, now(), now())
      on conflict (id) do update
      set
        name = excluded.name,
        email = excluded.email,
        "emailVerified" = true,
        actor_id = excluded.actor_id,
        "updatedAt" = now()
    `;
    await this.sql`
      insert into account (
        id, "userId", "accountId", "providerId", password, "createdAt", "updatedAt"
      )
      values (
        ${`${betterAuthUserId}-credential`},
        ${betterAuthUserId},
        ${betterAuthUserId},
        'credential',
        ${input.passwordHash},
        now(),
        now()
      )
      on conflict ("providerId", "accountId") do update
      set
        "userId" = excluded."userId",
        password = excluded.password,
        "updatedAt" = now()
    `;
    await this.sql`
      update actors
      set
        metadata = metadata || ${this.sql.json({
          betterAuth: { userId: betterAuthUserId, emailVerified: true },
        })},
        updated_at = now()
      where id = ${actor.id}
    `;

    return { actorId: actor.id, betterAuthUserId };
  }
}

export class PostgresSignupOwnerEmailLookup implements SignupOwnerEmailLookup {
  constructor(private readonly sql: postgres.Sql) {}

  async findOwnerByEmail(email: string): Promise<SignupOwnerEmailRecord | null> {
    const normalized = normalizeSignupEmail(email);
    const rows = (await this.sql`
      select org_id, email
      from (
        select
          tenant_provisioning_state.org_id,
          tenant_provisioning_state.requested_owner_email as email
        from tenant_provisioning_state
        join orgs on orgs.id = tenant_provisioning_state.org_id
        where lower(tenant_provisioning_state.requested_owner_email) = ${normalized}
          and orgs.status <> 'soft_deleted'
        union all
        select
          actors.org_id,
          actors.email
        from actors
        join orgs on orgs.id = actors.org_id
        where lower(actors.email) = ${normalized}
          and actors.type = 'user'
          and actors.disabled_at is null
          and orgs.status <> 'soft_deleted'
          and actors.metadata -> 'tenantProvisioning' ->> 'role' = 'owner'
      ) owner_emails
      limit 1
    `) as unknown as readonly SignupOwnerEmailRow[];
    const row = rows[0];
    return row === undefined ? null : { orgId: row.org_id, email: row.email };
  }
}

export function generateSignupEmailVerificationToken(): string {
  return `helix_signup_${randomBytes(32).toString("base64url")}`;
}

export function hashSignupEmailVerificationToken(token: string): string {
  return sha256Hex(token);
}

function normalizeSignupEmail(email: string): string {
  const normalized = email.trim().toLowerCase();
  if (normalized.length === 0) {
    throw new Error("signup email verification email is required");
  }
  return normalized;
}

function mapSignupEmailVerificationRow(
  row: SignupEmailVerificationRow | undefined,
): SignupEmailVerificationRecord {
  if (row === undefined) {
    throw new Error("signup email verification query returned no rows");
  }
  return {
    orgId: row.org_id,
    email: row.email,
    passwordHash: row.password_hash,
    expiresAt: row.expires_at,
    consumedAt: row.consumed_at,
    metadata: row.metadata,
  };
}

function nextResendMetadata(
  metadata: JsonObject,
  input: {
    readonly now: Date;
    readonly limit: number;
    readonly windowSeconds: number;
  },
):
  | { readonly status: "issued"; readonly metadata: JsonObject }
  | { readonly status: "rate_limited"; readonly retryAfterSeconds: number } {
  const resend = isJsonObject(metadata.resend) ? metadata.resend : {};
  const rawWindowStartedAt =
    typeof resend.windowStartedAt === "string" ? Date.parse(resend.windowStartedAt) : Number.NaN;
  const currentWindowStartedAt = Number.isFinite(rawWindowStartedAt)
    ? new Date(rawWindowStartedAt)
    : input.now;
  const windowAgeMs = input.now.getTime() - currentWindowStartedAt.getTime();
  const windowMs = input.windowSeconds * 1000;
  const inCurrentWindow = windowAgeMs >= 0 && windowAgeMs < windowMs;
  const count =
    inCurrentWindow && typeof resend.count === "number" && Number.isFinite(resend.count)
      ? resend.count
      : 0;
  if (count >= input.limit) {
    return {
      status: "rate_limited",
      retryAfterSeconds: Math.max(1, Math.ceil((windowMs - windowAgeMs) / 1000)),
    };
  }

  const windowStartedAt = inCurrentWindow ? currentWindowStartedAt : input.now;
  return {
    status: "issued",
    metadata: {
      ...metadata,
      resend: {
        windowStartedAt: windowStartedAt.toISOString(),
        count: count + 1,
        lastSentAt: input.now.toISOString(),
      },
    },
  };
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
