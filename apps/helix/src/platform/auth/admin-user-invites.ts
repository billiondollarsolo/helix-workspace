/* Administrator invitations for single-tenant workspaces.

   An invitation creates the person as a pending user actor (their membership
   exists but no sign-in is linked to it yet) and emails a one-time link. Opening the link lets
   them choose a password: that creates their sign-in, activates their
   membership, and consumes the invitation in one transaction. Tokens are
   stored hashed in `signup_onboarding_invites` and resolve only inside the
   tenant that issued them. */

import { randomUUID } from "node:crypto";
import type { Actor } from "@helix/sdk-types";
import { hashPassword } from "better-auth/crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type postgres from "postgres";
import { z } from "zod";
import { ConflictError } from "../../api/api-error.js";
import { SIGNUP_BODY_LIMIT_BYTES } from "../../api/request-body.js";
import { canWriteAdminConsole } from "../admin/console-shared.js";
import type { OutboxStore } from "../outbox/outbox.js";
import { signupOnboardingInviteEmailSubject } from "../signup/email-delivery.js";
import {
  generateSignupOnboardingInviteToken,
  hashSignupOnboardingInviteToken,
  signupOnboardingInviteTtlSeconds,
} from "../signup/invites.js";
import { createCredentialUserForActor } from "../signup/verification.js";
import type { OrgStore } from "../tenancy/index.js";
import { withTenantPostgresContext } from "../tenancy/postgres-roles.js";
import { WORKSPACE_ADMIN_SCOPES, WORKSPACE_MEMBER_SCOPES } from "./member-scopes.js";

export type AdminInviteRole = "member" | "admin";

/** Better Auth's default password bounds, which sign-in and reset also apply. */
const PASSWORD_MIN_LENGTH = 8;
const PASSWORD_MAX_LENGTH = 128;

export interface IssuedAdminUserInvite {
  readonly actorId: string;
  readonly email: string;
  readonly displayName: string;
  readonly token: string;
  readonly expiresAt: Date;
}

export interface PendingAdminUserInvite {
  readonly email: string;
  readonly displayName: string;
  readonly expiresAt: Date;
}

export type AcceptAdminUserInviteResult =
  | { readonly status: "accepted"; readonly actorId: string; readonly email: string }
  | { readonly status: "invalid" }
  /** The address already has a sign-in; signing in with it joins the workspace. */
  | { readonly status: "existing_sign_in"; readonly email: string };

export interface AdminUserInviteStore {
  invite(
    actor: Actor,
    input: { readonly email: string; readonly displayName: string; readonly role: AdminInviteRole },
  ): Promise<IssuedAdminUserInvite>;
  /** Issue a fresh link for a person who has not joined yet; null if there is none. */
  resend(actor: Actor, targetActorId: string): Promise<IssuedAdminUserInvite | null>;
  /** Withdraw a pending invitation; false if the person has already joined or does not exist. */
  revoke(actor: Actor, targetActorId: string): Promise<boolean>;
  inspect(orgId: string, token: string): Promise<PendingAdminUserInvite | null>;
  accept(
    orgId: string,
    input: { readonly token: string; readonly passwordHash: string },
  ): Promise<AcceptAdminUserInviteResult>;
}

interface PendingActorRow {
  readonly id: string;
  readonly email: string;
  readonly display_name: string;
  readonly disabled_at: Date | null;
  /** True once any sign-in (password or SSO) is linked to the person. */
  readonly joined: boolean;
}

interface InviteRow {
  readonly id: string;
  readonly email: string;
  readonly expires_at: Date;
  readonly metadata: { readonly actorId?: unknown };
}

export class PostgresAdminUserInviteStore implements AdminUserInviteStore {
  constructor(private readonly sql: postgres.Sql) {}

  invite(
    actor: Actor,
    input: { readonly email: string; readonly displayName: string; readonly role: AdminInviteRole },
  ): Promise<IssuedAdminUserInvite> {
    const email = input.email.trim().toLowerCase();
    const scopes = [
      ...WORKSPACE_MEMBER_SCOPES,
      ...(input.role === "admin" ? WORKSPACE_ADMIN_SCOPES : []),
    ];
    return withTenantPostgresContext(
      this.sql,
      { orgId: actor.orgId, actorId: actor.id },
      async (tx) => {
        const [existing] = await tx<(PendingActorRow & { identity_provider_managed: boolean })[]>`
          select actor.id, actor.email, actor.display_name, actor.disabled_at,
                 actor.scim_external_id is not null as identity_provider_managed,
                 ${joinedSql(tx)} as joined
          from actors actor
          where actor.org_id = ${actor.orgId} and lower(actor.email) = ${email}
          limit 1
          for update of actor
        `;
        let actorId: string;
        if (existing === undefined) {
          const [created] = await tx<{ readonly id: string }[]>`
            insert into actors (org_id, type, email, display_name, scopes, metadata)
            values (
              ${actor.orgId}, 'user', ${email}, ${input.displayName},
              ${tx.array(scopes, 1009)},
              ${tx.json({ invitation: { invitedByActorId: actor.id, role: input.role } })}
            )
            returning id
          `;
          if (created === undefined) throw new Error("Invited person was not created.");
          actorId = created.id;
        } else if (existing.identity_provider_managed) {
          throw new ConflictError(
            `${email} is provisioned by your identity provider and signs in through it.`,
          );
        } else if (existing.joined) {
          throw new ConflictError(`${email} is already in this workspace.`);
        } else if (existing.disabled_at === null) {
          throw new ConflictError(
            `${email} already has a pending invitation. Resend it from their row in Users.`,
          );
        } else {
          // A withdrawn invitation: reuse the never-activated person.
          await tx`
            update actors
            set disabled_at = null,
                display_name = ${input.displayName},
                scopes = ${tx.array(scopes, 1009)},
                metadata = metadata || ${tx.json({
                  invitation: { invitedByActorId: actor.id, role: input.role },
                })},
                updated_at = now()
            where org_id = ${actor.orgId} and id = ${existing.id}
          `;
          actorId = existing.id;
        }
        const issued = await issueToken(tx, actor, { actorId, email });
        await recordActivity(tx, actor.orgId, actor.id, "identity.user.invited", actorId, {
          email,
          role: input.role,
        });
        return { actorId, email, displayName: input.displayName, ...issued };
      },
    );
  }

  resend(actor: Actor, targetActorId: string): Promise<IssuedAdminUserInvite | null> {
    return withTenantPostgresContext(
      this.sql,
      { orgId: actor.orgId, actorId: actor.id },
      async (tx) => {
        const pending = await findPendingActor(tx, actor.orgId, targetActorId);
        if (pending === undefined) return null;
        const issued = await issueToken(tx, actor, {
          actorId: pending.id,
          email: pending.email,
        });
        await recordActivity(tx, actor.orgId, actor.id, "identity.user.invite_resent", pending.id, {
          email: pending.email,
        });
        return {
          actorId: pending.id,
          email: pending.email,
          displayName: pending.display_name,
          ...issued,
        };
      },
    );
  }

  revoke(actor: Actor, targetActorId: string): Promise<boolean> {
    return withTenantPostgresContext(
      this.sql,
      { orgId: actor.orgId, actorId: actor.id },
      async (tx) => {
        const pending = await findPendingActor(tx, actor.orgId, targetActorId);
        if (pending === undefined) return false;
        await expireOpenInvites(tx, actor.orgId, pending.email);
        await tx`
          update actors set disabled_at = now(), updated_at = now()
          where org_id = ${actor.orgId} and id = ${pending.id}
        `;
        await recordActivity(
          tx,
          actor.orgId,
          actor.id,
          "identity.user.invite_revoked",
          pending.id,
          {
            email: pending.email,
          },
        );
        return true;
      },
    );
  }

  inspect(orgId: string, token: string): Promise<PendingAdminUserInvite | null> {
    return withTenantPostgresContext(this.sql, { orgId }, async (tx) => {
      const invite = await findOpenInvite(tx, orgId, token, false);
      if (invite === undefined) return null;
      const pending = await findPendingActor(tx, orgId, inviteActorId(invite));
      if (pending === undefined) return null;
      return {
        email: pending.email,
        displayName: pending.display_name,
        expiresAt: invite.expires_at,
      };
    });
  }

  accept(
    orgId: string,
    input: { readonly token: string; readonly passwordHash: string },
  ): Promise<AcceptAdminUserInviteResult> {
    return withTenantPostgresContext(this.sql, { orgId }, async (tx) => {
      const invite = await findOpenInvite(tx, orgId, input.token, true);
      if (invite === undefined) return { status: "invalid" };
      const pending = await findPendingActor(tx, orgId, inviteActorId(invite));
      if (pending === undefined || pending.email !== invite.email) return { status: "invalid" };
      const [existingSignIn] = await tx`
        select 1 from "user" where lower(email) = ${invite.email} limit 1
      `;
      if (existingSignIn !== undefined) {
        return { status: "existing_sign_in", email: invite.email };
      }
      const created = await createCredentialUserForActor(tx, {
        orgId,
        email: invite.email,
        passwordHash: input.passwordHash,
      });
      if (created?.actorId !== pending.id) return { status: "invalid" };
      await tx`
        update signup_onboarding_invites
        set accepted_at = now(),
            accepted_by_actor_id = ${pending.id},
            updated_at = now()
        where org_id = ${orgId} and id = ${invite.id}
      `;
      await recordActivity(tx, orgId, pending.id, "identity.user.invite_accepted", pending.id, {
        email: invite.email,
      });
      return { status: "accepted", actorId: pending.id, email: invite.email };
    });
  }
}

/** A user actor in the workspace who has never joined (no membership) and is not withdrawn. */
async function findPendingActor(
  tx: postgres.TransactionSql,
  orgId: string,
  actorId: string | null,
): Promise<PendingActorRow | undefined> {
  if (actorId === null) return undefined;
  const [row] = await tx<PendingActorRow[]>`
    select actor.id, lower(actor.email) as email, actor.display_name, actor.disabled_at,
           false as joined
    from actors actor
    where actor.org_id = ${orgId}
      and actor.id = ${actorId}
      and actor.type = 'user'
      and actor.email is not null
      and actor.disabled_at is null
      -- People provisioned by the identity provider sign in through it, not a password link.
      and actor.scim_external_id is null
      and not ${joinedSql(tx)}
    limit 1
    for update of actor
  `;
  return row;
}

/** Whether a sign-in is linked to the `actor` row's membership (a person who has joined). */
function joinedSql(tx: postgres.TransactionSql) {
  return tx`exists (
    select 1
    from organization_memberships membership
    join identity_provider_subjects provider on provider.subject_id = membership.subject_id
    where membership.org_id = actor.org_id and membership.actor_id = actor.id
  )`;
}

async function findOpenInvite(
  tx: postgres.TransactionSql,
  orgId: string,
  token: string,
  lock: boolean,
): Promise<InviteRow | undefined> {
  const tokenHash = hashSignupOnboardingInviteToken(token);
  const rows = lock
    ? await tx<InviteRow[]>`
        select id, email, expires_at, metadata
        from signup_onboarding_invites
        where org_id = ${orgId} and token_hash = ${tokenHash}
          and accepted_at is null and expires_at > now()
          and metadata ->> 'source' = 'admin'
        limit 1
        for update
      `
    : await tx<InviteRow[]>`
        select id, email, expires_at, metadata
        from signup_onboarding_invites
        where org_id = ${orgId} and token_hash = ${tokenHash}
          and accepted_at is null and expires_at > now()
          and metadata ->> 'source' = 'admin'
        limit 1
      `;
  return rows[0];
}

function inviteActorId(invite: InviteRow): string | null {
  const actorId = invite.metadata.actorId;
  return typeof actorId === "string" && z.string().uuid().safeParse(actorId).success
    ? actorId
    : null;
}

async function expireOpenInvites(
  tx: postgres.TransactionSql,
  orgId: string,
  email: string,
): Promise<void> {
  await tx`
    update signup_onboarding_invites
    set expires_at = now(), updated_at = now()
    where org_id = ${orgId} and lower(email) = ${email}
      and accepted_at is null and expires_at > now()
  `;
}

/** Replace any open link for this person with a new one. */
async function issueToken(
  tx: postgres.TransactionSql,
  actor: Actor,
  input: { readonly actorId: string; readonly email: string },
): Promise<{ readonly token: string; readonly expiresAt: Date }> {
  await expireOpenInvites(tx, actor.orgId, input.email);
  const token = generateSignupOnboardingInviteToken();
  const expiresAt = new Date(Date.now() + signupOnboardingInviteTtlSeconds * 1000);
  await tx`
    insert into signup_onboarding_invites (
      org_id, invited_by_actor_id, email, token_hash, expires_at, metadata
    )
    values (
      ${actor.orgId}, ${actor.id}, ${input.email}, ${hashSignupOnboardingInviteToken(token)},
      ${expiresAt}, ${tx.json({ source: "admin", actorId: input.actorId })}
    )
  `;
  return { token, expiresAt };
}

async function recordActivity(
  tx: postgres.TransactionSql,
  orgId: string,
  actorId: string,
  verb: string,
  targetActorId: string,
  payload: Record<string, string>,
): Promise<void> {
  await tx`
    insert into activity (org_id, actor_id, verb, object_type, object_id, payload, prev_hash, this_hash)
    values (${orgId}, ${actorId}, ${verb}, 'actor', ${targetActorId}, ${tx.json(payload)}, null, '')
  `;
}

export interface RegisterAdminUserInviteRoutesOptions {
  readonly store: AdminUserInviteStore;
  readonly orgs: Pick<OrgStore, "findById">;
  readonly outbox: Pick<OutboxStore, "insert">;
  /** Origin of the web app; invitation links open `/signup/invite` there. */
  readonly publicBaseUrl: string;
  readonly actorFromRequest: (request: FastifyRequest) => Promise<Actor> | Actor;
  readonly hashPassword?: (password: string) => Promise<string>;
}

const inviteBodySchema = z
  .object({
    email: z.string().trim().toLowerCase().email().max(320),
    displayName: z.string().trim().max(200).optional(),
    role: z.enum(["member", "admin"]).default("member"),
  })
  .strict();
const tokenSchema = z.string().min(1).max(4096);
const inspectBodySchema = z.object({ token: tokenSchema }).strict();
const acceptBodySchema = z
  .object({
    token: tokenSchema,
    password: z.string().min(PASSWORD_MIN_LENGTH).max(PASSWORD_MAX_LENGTH),
  })
  .strict();
const actorIdSchema = z.string().uuid();

export async function registerAdminUserInviteRoutes(
  app: FastifyInstance,
  options: RegisterAdminUserInviteRoutesOptions,
): Promise<void> {
  const hash = options.hashPassword ?? hashPassword;

  const sendInvite = async (
    request: FastifyRequest,
    actor: Actor,
    invite: IssuedAdminUserInvite,
  ) => {
    const org = await options.orgs.findById(actor.orgId);
    const url = new URL("/signup/invite", options.publicBaseUrl);
    url.searchParams.set("token", invite.token);
    await options.outbox.insert({
      subject: signupOnboardingInviteEmailSubject,
      payload: {
        orgId: actor.orgId,
        orgSlug: org?.slug ?? "workspace",
        ...(org === null ? {} : { workspaceName: org.displayName }),
        actorId: actor.id,
        email: invite.email,
        inviteUrl: url.toString(),
        source: "admin",
        deliveryKey: randomUUID(),
      },
    });
    request.log.info({ invitedActorId: invite.actorId }, "Admin invitation queued");
    return {
      actorId: invite.actorId,
      email: invite.email,
      displayName: invite.displayName,
      status: "invited" as const,
      expiresAt: invite.expiresAt.toISOString(),
    };
  };

  app.post("/api/admin/users/invite", async (request, reply) => {
    const actor = await options.actorFromRequest(request);
    if (!canWriteAdminConsole(actor, "admin.users")) {
      return reply.code(403).send(permissionDenied());
    }
    const parsed = inviteBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Enter a valid email address to invite." });
    }
    if (parsed.data.role === "admin" && !holdsFullAdmin(actor)) {
      return reply.code(403).send({
        error: "Only a full administrator (admin.*) can invite another administrator.",
        requiredScope: "admin.*",
      });
    }
    const displayName =
      parsed.data.displayName === undefined || parsed.data.displayName.length === 0
        ? parsed.data.email.split("@")[0] || parsed.data.email
        : parsed.data.displayName;
    const invite = await options.store.invite(actor, {
      email: parsed.data.email,
      displayName,
      role: parsed.data.role,
    });
    return reply.code(201).send(await sendInvite(request, actor, invite));
  });

  app.post<{ Params: { actorId: string } }>(
    "/api/admin/users/:actorId/invite/resend",
    async (request, reply) => {
      const actor = await options.actorFromRequest(request);
      if (!canWriteAdminConsole(actor, "admin.users")) {
        return reply.code(403).send(permissionDenied());
      }
      const target = actorIdSchema.safeParse(request.params.actorId);
      if (!target.success) return reply.code(400).send({ error: "Invalid actor id." });
      const invite = await options.store.resend(actor, target.data);
      if (invite === null) {
        return reply.code(404).send({ error: "That person has no pending invitation." });
      }
      return sendInvite(request, actor, invite);
    },
  );

  app.post<{ Params: { actorId: string } }>(
    "/api/admin/users/:actorId/invite/revoke",
    async (request, reply) => {
      const actor = await options.actorFromRequest(request);
      if (!canWriteAdminConsole(actor, "admin.users")) {
        return reply.code(403).send(permissionDenied());
      }
      const target = actorIdSchema.safeParse(request.params.actorId);
      if (!target.success) return reply.code(400).send({ error: "Invalid actor id." });
      if (!(await options.store.revoke(actor, target.data))) {
        return reply.code(404).send({ error: "That person has no pending invitation." });
      }
      return reply.code(204).send();
    },
  );

  // The invitee is not signed in: the token is the credential, and the request's
  // resolved tenant scopes which invitations it can match.
  app.post(
    "/api/invites/inspect",
    { bodyLimit: SIGNUP_BODY_LIMIT_BYTES },
    async (request, reply) => {
      const orgId = request.tenant?.orgId;
      const parsed = inspectBodySchema.safeParse(request.body);
      if (orgId === undefined || !parsed.success) return reply.code(404).send(invalidInvite());
      const invite = await options.store.inspect(orgId, parsed.data.token);
      if (invite === null) return reply.code(404).send(invalidInvite());
      const org = await options.orgs.findById(orgId);
      return {
        email: invite.email,
        displayName: invite.displayName,
        workspaceName: org?.displayName ?? "your workspace",
        expiresAt: invite.expiresAt.toISOString(),
        passwordMinLength: PASSWORD_MIN_LENGTH,
      };
    },
  );

  app.post(
    "/api/invites/accept",
    { bodyLimit: SIGNUP_BODY_LIMIT_BYTES },
    async (request, reply) => {
      const orgId = request.tenant?.orgId;
      const parsed = acceptBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({
          error: `Choose a password between ${String(PASSWORD_MIN_LENGTH)} and ${String(PASSWORD_MAX_LENGTH)} characters.`,
        });
      }
      if (orgId === undefined) return reply.code(404).send(invalidInvite());
      const result = await options.store.accept(orgId, {
        token: parsed.data.token,
        passwordHash: await hash(parsed.data.password),
      });
      if (result.status === "invalid") return reply.code(404).send(invalidInvite());
      if (result.status === "existing_sign_in") {
        return reply.code(409).send({
          code: "existing_sign_in",
          error: `${result.email} already has a Helix sign-in. Sign in with your existing password to join.`,
        });
      }
      return { status: "accepted", actorId: result.actorId, email: result.email };
    },
  );
}

/** `admin.*` passes every scope check, so only a holder may grant it. */
function holdsFullAdmin(actor: Actor): boolean {
  return (actor.scopes ?? []).some((scope) => scope === "*" || scope === "admin.*");
}

function permissionDenied() {
  return { error: "Admin users permission denied.", requiredScope: "admin.users" };
}

function invalidInvite() {
  return {
    code: "invite_invalid",
    error:
      "This invitation link is invalid, expired, or already used. Ask your administrator to send a new one.",
  };
}
