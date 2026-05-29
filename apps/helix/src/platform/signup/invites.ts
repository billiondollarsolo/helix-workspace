import type postgres from "postgres";
import type { Actor, JsonObject } from "@helix/sdk-types";
import { randomBytes, sha256Hex } from "../crypto/index.js";

export const signupOnboardingInviteTtlSeconds = 7 * 24 * 60 * 60;

export interface SignupOnboardingInviteRecord {
  readonly orgId: string;
  readonly invitedByActorId: string;
  readonly email: string;
  readonly expiresAt: Date;
  readonly acceptedAt: Date | null;
  readonly acceptedByActorId: string | null;
  readonly metadata: JsonObject;
}

export interface SignupOnboardingInviteIssueResult extends SignupOnboardingInviteRecord {
  readonly token: string;
}

export type SignupOnboardingInviteAcceptResult =
  | {
      readonly status: "accepted";
      readonly invite: SignupOnboardingInviteRecord;
    }
  | { readonly status: "not_found" }
  | { readonly status: "email_mismatch" };

export interface SignupOnboardingInviteTokenStore {
  issue(input: {
    readonly orgId: string;
    readonly invitedByActorId: string;
    readonly email: string;
    readonly metadata?: JsonObject | undefined;
    readonly now?: Date | undefined;
  }): Promise<SignupOnboardingInviteIssueResult>;
  accept(input: {
    readonly token: string;
    readonly actor: Pick<Actor, "id" | "orgId" | "email">;
    readonly now?: Date | undefined;
  }): Promise<SignupOnboardingInviteAcceptResult>;
}

interface SignupOnboardingInviteRow {
  readonly org_id: string;
  readonly invited_by_actor_id: string;
  readonly email: string;
  readonly expires_at: Date;
  readonly accepted_at: Date | null;
  readonly accepted_by_actor_id: string | null;
  readonly metadata: JsonObject;
}

export class PostgresSignupOnboardingInviteTokenStore implements SignupOnboardingInviteTokenStore {
  constructor(private readonly sql: postgres.Sql) {}

  async issue(input: {
    readonly orgId: string;
    readonly invitedByActorId: string;
    readonly email: string;
    readonly metadata?: JsonObject | undefined;
    readonly now?: Date | undefined;
  }): Promise<SignupOnboardingInviteIssueResult> {
    const email = normalizeSignupInviteEmail(input.email);
    const token = generateSignupOnboardingInviteToken();
    const issuedAt = input.now ?? new Date();
    const expiresAt = new Date(issuedAt.getTime() + signupOnboardingInviteTtlSeconds * 1000);
    const rows = (await this.sql`
      insert into signup_onboarding_invites (
        org_id,
        invited_by_actor_id,
        email,
        token_hash,
        expires_at,
        accepted_at,
        accepted_by_actor_id,
        metadata
      )
      values (
        ${input.orgId},
        ${input.invitedByActorId},
        ${email},
        ${hashSignupOnboardingInviteToken(token)},
        ${expiresAt},
        null,
        null,
        ${this.sql.json(input.metadata ?? {})}
      )
      returning org_id, invited_by_actor_id, email, expires_at, accepted_at, accepted_by_actor_id, metadata
    `) as unknown as readonly SignupOnboardingInviteRow[];
    return { ...mapSignupOnboardingInviteRow(rows[0]), token };
  }

  async accept(input: {
    readonly token: string;
    readonly actor: Pick<Actor, "id" | "orgId" | "email">;
    readonly now?: Date | undefined;
  }): Promise<SignupOnboardingInviteAcceptResult> {
    const now = input.now ?? new Date();
    const rows = (await this.sql`
      select org_id, invited_by_actor_id, email, expires_at, accepted_at, accepted_by_actor_id, metadata
      from signup_onboarding_invites
      where token_hash = ${hashSignupOnboardingInviteToken(input.token)}
        and accepted_at is null
        and expires_at > ${now}
      limit 1
    `) as unknown as readonly SignupOnboardingInviteRow[];
    const invite = rows[0];
    if (invite === undefined) {
      return { status: "not_found" };
    }

    const actorEmail = normalizeOptionalSignupInviteEmail(input.actor.email);
    if (invite.org_id !== input.actor.orgId || actorEmail === null || actorEmail !== invite.email) {
      return { status: "email_mismatch" };
    }

    const acceptedRows = (await this.sql`
      update signup_onboarding_invites
      set
        accepted_at = ${now},
        accepted_by_actor_id = ${input.actor.id},
        metadata = metadata || ${this.sql.json({
          acceptedBy: {
            actorId: input.actor.id,
            source: "signup",
          },
        })},
        updated_at = now()
      where token_hash = ${hashSignupOnboardingInviteToken(input.token)}
        and accepted_at is null
        and expires_at > ${now}
      returning org_id, invited_by_actor_id, email, expires_at, accepted_at, accepted_by_actor_id, metadata
    `) as unknown as readonly SignupOnboardingInviteRow[];
    const accepted = acceptedRows[0];
    if (accepted === undefined) {
      return { status: "not_found" };
    }
    await this.sql`
      insert into permissions (
        org_id,
        actor_id,
        resource_type,
        resource_id,
        role,
        granted_by_actor_id
      )
      select
        ${accepted.org_id},
        ${input.actor.id},
        'org',
        ${accepted.org_id},
        'member',
        ${accepted.invited_by_actor_id}
      where not exists (
        select 1
        from permissions
        where org_id = ${accepted.org_id}
          and actor_id = ${input.actor.id}
          and resource_type = 'org'
          and resource_id = ${accepted.org_id}
          and role = 'member'
      )
    `;
    return { status: "accepted", invite: mapSignupOnboardingInviteRow(accepted) };
  }
}

export function generateSignupOnboardingInviteToken(): string {
  return `helix_invite_${randomBytes(32).toString("base64url")}`;
}

export function hashSignupOnboardingInviteToken(token: string): string {
  return sha256Hex(token);
}

function normalizeSignupInviteEmail(email: string): string {
  const normalized = normalizeOptionalSignupInviteEmail(email);
  if (normalized === null) {
    throw new Error("signup onboarding invite email is required");
  }
  return normalized;
}

function normalizeOptionalSignupInviteEmail(email: string | undefined): string | null {
  if (email === undefined) {
    return null;
  }
  const normalized = email.trim().toLowerCase();
  return normalized.length === 0 ? null : normalized;
}

function mapSignupOnboardingInviteRow(
  row: SignupOnboardingInviteRow | undefined,
): SignupOnboardingInviteRecord {
  if (row === undefined) {
    throw new Error("signup onboarding invite query returned no rows");
  }
  return {
    orgId: row.org_id,
    invitedByActorId: row.invited_by_actor_id,
    email: row.email,
    expiresAt: row.expires_at,
    acceptedAt: row.accepted_at,
    acceptedByActorId: row.accepted_by_actor_id,
    metadata: row.metadata,
  };
}
