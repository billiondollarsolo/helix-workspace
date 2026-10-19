import type { Actor } from "@helix/sdk-types";
import type {
  BotAccountRequestInput,
  BotAccountRequest,
  BotAccountApproval,
} from "@helix/contracts";
import type postgres from "postgres";
import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  RateLimitedError,
} from "../../api/api-error.js";
import { actorHasScope } from "../../api/scopes.js";
import { canWriteAdminConsole, canReadAdminConsole } from "../admin/console-shared.js";
import { insertNotification } from "../notifications/index.js";
import { parseActorRoleBindings, actorHasPermission } from "../permissions/roles.js";
import { isKnownScope } from "../permissions/scope-catalog.js";
import type { PostgresAgentCredentialStore } from "../auth/postgres-store.js";
import { PostgresAgentMailStore } from "../mail/agent-mail/index.js";
import { withTenantPostgresContext } from "../tenancy/postgres-roles.js";
interface RequestRow {
  id: string;
  org_id: string;
  requester_actor_id: string;
  external_bot_id: string;
  display_name: string;
  purpose: string;
  requested_email: string | null;
  requested_scopes: string[];
  api_key_hash: string;
  status: BotAccountRequest["status"];
  bot_actor_id: string | null;
  credential_id: string | null;
  credential_expires_at: Date | null;
  owner_actor_id: string | null;
  approved_scopes: string[];
  approved_email: string | null;
  reason: string | null;
  created_at: Date;
  expires_at: Date;
}
const admin = (actor: Actor) =>
  actor.type === "user" && canWriteAdminConsole(actor, "admin.agents");
export function assertBotAdmin(actor: Actor): void {
  if (!admin(actor))
    throw new ForbiddenError(
      "A Workspace administrator must approve bot accounts and access grants.",
    );
}
export function requestView(row: RequestRow): BotAccountRequest {
  return {
    id: row.id,
    externalBotId: row.external_bot_id,
    displayName: row.display_name,
    purpose: row.purpose,
    requestedEmail: row.requested_email,
    requestedScopes: row.requested_scopes,
    status:
      row.status === "pending" && row.expires_at.getTime() <= Date.now() ? "expired" : row.status,
    actorId: row.bot_actor_id,
    credentialId: row.credential_id,
    credentialExpiresAt: row.credential_expires_at?.toISOString() ?? null,
    ownerActorId: row.owner_actor_id,
    approvedScopes: row.approved_scopes,
    approvedEmail: row.approved_email,
    reason: row.reason,
    createdAt: row.created_at.toISOString(),
    expiresAt: row.expires_at.toISOString(),
    reviewUrl: `/admin/agent-credentials?botRequest=${row.id}`,
  };
}
export class BotAccountStore {
  constructor(
    readonly sql: postgres.Sql,
    private readonly credentials: Pick<PostgresAgentCredentialStore, "issue">,
    private readonly appEnabled: (app: string) => boolean,
  ) {}
  async request(actor: Actor, input: BotAccountRequestInput): Promise<BotAccountRequest> {
    if (
      !["agent", "service_account"].includes(actor.type) ||
      !actorHasScope(actor, "agent.accounts.request")
    )
      throw new ForbiddenError(
        "A trusted installation credential with agent.accounts.request is required.",
      );
    return withTenantPostgresContext(
      this.sql,
      { orgId: actor.orgId, actorId: actor.id },
      async (tx) => {
        // Serialize the requester's quota and idempotency checks without locking unrelated tenants.
        await tx`select pg_advisory_xact_lock(hashtextextended(${`${actor.orgId}:${actor.id}:bot-requests`},0))`;
        const [prior] = await tx<
          RequestRow[]
        >`select * from bot_account_requests where org_id=${actor.orgId}
        and requester_actor_id=${actor.id} and external_bot_id=${input.externalBotId}`;
        if (prior) {
          if (
            prior.api_key_hash !== input.apiKeyHash ||
            prior.display_name !== input.displayName ||
            prior.purpose !== input.purpose ||
            prior.requested_email !== (input.email ?? null) ||
            [...prior.requested_scopes].sort().join() !== [...new Set(input.scopes)].sort().join()
          )
            throw new ConflictError(
              "That external bot ID already has a different request. Reuse the original manifest and key, or use a new identity for a different bot.",
            );
          return requestView(prior);
        }
        const [count] = await tx<
          { total: number }[]
        >`select count(*)::integer as total from bot_account_requests
        where org_id=${actor.orgId} and created_at>now()-interval '1 day'`;
        if ((count?.total ?? 0) >= 50)
          throw new RateLimitedError(
            "This workspace has reached its daily bot account request limit.",
          );
        const [row] = await tx<
          RequestRow[]
        >`insert into bot_account_requests(org_id,requester_actor_id,external_bot_id,
        display_name,purpose,requested_email,requested_scopes,api_key_hash)
        values(${actor.orgId},${actor.id},${input.externalBotId},${input.displayName},${input.purpose},${input.email ?? null},${tx.array([...new Set(input.scopes)])},${input.apiKeyHash}) returning *`;
        if (!row) throw new Error("Bot request was not saved.");
        const reviewers = await tx<{ id: string; scopes: string[]; role_bindings: unknown }[]>`
          select id,scopes,helix_actor_role_bindings(org_id,id) as role_bindings from actors
          where org_id=${actor.orgId} and type='user' and disabled_at is null`;
        for (const reviewer of reviewers) {
          if (
            !admin({
              id: reviewer.id,
              orgId: actor.orgId,
              type: "user",
              scopes: reviewer.scopes,
              roleBindings: parseActorRoleBindings(reviewer.role_bindings),
            })
          )
            continue;
          await insertNotification(tx, {
            orgId: actor.orgId,
            actorId: reviewer.id,
            verb: "bot.account.requested",
            objectType: "bot_account_request",
            objectId: row.id,
            summary: `Review bot account: ${input.displayName}`,
            body: input.purpose,
          });
        }
        return requestView(row);
      },
    );
  }
  async listRequests(actor: Actor): Promise<BotAccountRequest[]> {
    const all = actor.type === "user" && canReadAdminConsole(actor, "admin.agents");
    const rows = await this.sql<
      RequestRow[]
    >`select * from bot_account_requests where org_id=${actor.orgId}
      and (${all} or requester_actor_id=${actor.id}) order by created_at desc limit 100`;
    return rows.map(requestView);
  }
  async get(actor: Actor, id: string): Promise<BotAccountRequest> {
    const all = actor.type === "user" && canReadAdminConsole(actor, "admin.agents");
    const [row] = await this.sql<
      RequestRow[]
    >`select * from bot_account_requests where org_id=${actor.orgId} and id=${id}
      and (${all} or requester_actor_id=${actor.id})`;
    if (!row) throw new NotFoundError("Bot request is unavailable.");
    return requestView(row);
  }
  async approve(actor: Actor, input: BotAccountApproval): Promise<BotAccountRequest> {
    assertBotAdmin(actor);
    const lifetime = new Date(input.expiresAt).getTime() - Date.now();
    if (lifetime <= 0 || lifetime > 366 * 86400000)
      throw new BadRequestError("Credential expiry must be within 366 days.");
    for (const scope of input.scopes) {
      if (
        !isKnownScope(scope) ||
        !actorHasPermission(actor, scope, { type: "org", orgId: actor.orgId })
      )
        throw new ForbiddenError(`You cannot grant ${scope}.`);
      const app = scope.split(".")[0] ?? "";
      if (["mail", "chat", "drive", "calendar", "meet"].includes(app) && !this.appEnabled(app))
        throw new BadRequestError(
          `Enable ${app} before granting its scopes, or remove them from the approval.`,
        );
    }
    return withTenantPostgresContext(
      this.sql,
      { orgId: actor.orgId, actorId: actor.id },
      async (tx) => {
        const [row] = await tx<
          RequestRow[]
        >`select * from bot_account_requests where org_id=${actor.orgId} and id=${input.requestId} for update`;
        if (!row) throw new NotFoundError("Bot request is unavailable.");
        if (row.status === "approved") return requestView(row);
        const [requester] =
          await tx`select id from actors where org_id=${actor.orgId} and id=${row.requester_actor_id} and disabled_at is null for share`;
        if (!requester)
          throw new BadRequestError("The requesting installation is disabled or unavailable.");
        if (row.status !== "pending" || row.expires_at.getTime() <= Date.now())
          throw new ConflictError("This request is no longer pending.");
        if (input.scopes.some((scope) => !row.requested_scopes.includes(scope)))
          throw new BadRequestError("Approval may reduce requested scopes, not add new authority.");
        if (input.scopes.some((scope) => scope.startsWith("mail.")) && !input.email)
          throw new BadRequestError(
            "Choose an address on a verified mail-enabled domain for Mail access.",
          );
        const [owner] =
          await tx`select id from actors where org_id=${actor.orgId} and id=${input.ownerActorId} and type='user' and disabled_at is null`;
        if (!owner) throw new BadRequestError("Choose an active human owner in this workspace.");
        const [bot] = await tx<
          { id: string }[]
        >`insert into actors(org_id,type,display_name,parent_user_id,scopes,metadata)
        values(${actor.orgId},'agent',${row.display_name},${input.ownerActorId},${tx.array(input.scopes)},
          ${tx.json({ purpose: row.purpose, ownerActorId: input.ownerActorId, externalBotId: row.external_bot_id, hosting: "external" })}) returning id`;
        if (!bot) throw new Error("Bot identity was not created.");
        if (input.email)
          await new PostgresAgentMailStore(this.sql).save({
            orgId: actor.orgId,
            actorId: actor.id,
            agentId: bot.id,
            address: input.email,
            receiveMode: "anyone",
            allowedSenders: [],
          });
        const credential = await this.credentials.issue({
          orgId: actor.orgId,
          operatorActorId: actor.id,
          principalActorId: bot.id,
          credentialType: "api_key",
          label: row.display_name,
          purpose: row.purpose.slice(0, 500),
          scopes: input.scopes,
          expiresAt: new Date(input.expiresAt),
          apiKeyHash: row.api_key_hash,
        });
        await tx`update agent_credentials set approval_owner_actor_id=${input.ownerActorId} where org_id=${actor.orgId} and id=${credential.id}`;
        await tx`insert into bot_account_observers(org_id,bot_actor_id,observer_actor_id,granted_by_actor_id)
        values(${actor.orgId},${bot.id},${input.ownerActorId},${actor.id})`;
        const [approved] = await tx<
          RequestRow[]
        >`update bot_account_requests set status='approved',bot_actor_id=${bot.id},
        credential_id=${credential.id},owner_actor_id=${input.ownerActorId},approved_scopes=${tx.array(input.scopes)},
        approved_email=${input.email},credential_expires_at=${new Date(input.expiresAt)},decided_at=now(),decided_by_actor_id=${actor.id}
        where org_id=${actor.orgId} and id=${row.id} returning *`;
        if (!approved) throw new Error("Bot approval was not saved.");
        await insertNotification(tx, {
          orgId: actor.orgId,
          actorId: input.ownerActorId,
          verb: "bot.account.approved",
          objectType: "bot_account_request",
          objectId: row.id,
          summary: `Bot account approved: ${row.display_name}`,
        });
        return requestView(approved);
      },
    );
  }
  async reject(actor: Actor, id: string, reason: string): Promise<BotAccountRequest> {
    assertBotAdmin(actor);
    const rows = await this.sql`update bot_account_requests set status='rejected',reason=${reason},
      decided_at=now(),decided_by_actor_id=${actor.id} where org_id=${actor.orgId} and id=${id} and status='pending'`;
    if (!rows.count) throw new ConflictError("Request is no longer pending.");
    return this.get(actor, id);
  }
  async grant(actor: Actor, botId: string, observerId: string, enabled: boolean): Promise<void> {
    assertBotAdmin(actor);
    await this.assertVisible(actor, botId);
    const [person] = await this
      .sql`select id from actors where org_id=${actor.orgId} and id=${observerId} and type='user' and (${!enabled} or disabled_at is null)`;
    if (!person) throw new BadRequestError("Observer must be an active human in this workspace.");
    if (enabled)
      await this
        .sql`insert into bot_account_observers(org_id,bot_actor_id,observer_actor_id,granted_by_actor_id)
      values(${actor.orgId},${botId},${observerId},${actor.id}) on conflict do nothing`;
    else
      await this
        .sql`delete from bot_account_observers where org_id=${actor.orgId} and bot_actor_id=${botId} and observer_actor_id=${observerId}`;
  }
  async observers(actor: Actor, botId: string, offset: number) {
    assertBotAdmin(actor);
    await this.assertVisible(actor, botId);
    const page = await this.sql<
      {
        actorId: string;
        displayName: string;
        email: string | null;
        disabled: boolean;
        grantedAt: Date;
      }[]
    >`select a.id as "actorId",a.display_name as "displayName",a.email,
      (a.disabled_at is not null) as disabled,o.created_at as "grantedAt"
      from bot_account_observers o join actors a on a.org_id=o.org_id and a.id=o.observer_actor_id
      where o.org_id=${actor.orgId} and o.bot_actor_id=${botId}
      order by o.created_at,a.id limit 51 offset ${offset}`;
    return { observers: page.slice(0, 50), hasMore: page.length > 50 };
  }
  async visible(actor: Actor, input: { botActorId?: string | undefined; offset: number }) {
    if (actor.type !== "user")
      throw new ForbiddenError("Bot oversight is available to authorized humans.");
    const all = canReadAdminConsole(actor, "admin.agents");
    return this.sql<{ id: string; displayName: string; email: string | null; disabled: boolean }[]>`
      select a.id,a.display_name as "displayName",a.email,(a.disabled_at is not null) as disabled from actors a
      where a.org_id=${actor.orgId} and a.type in ('agent','service_account')
        and (${input.botActorId ?? null}::uuid is null or a.id=${input.botActorId ?? null}::uuid)
        and (${all} or exists(select 1 from bot_account_observers o
          where o.org_id=a.org_id and o.bot_actor_id=a.id and o.observer_actor_id=${actor.id}))
      order by a.display_name,a.id limit 101 offset ${input.offset}`;
  }
  async assertVisible(actor: Actor, botId: string): Promise<void> {
    if (actor.type !== "user")
      throw new ForbiddenError("Bot oversight is available to authorized humans.");
    const all = canReadAdminConsole(actor, "admin.agents");
    const [bot] = await this
      .sql`select a.id from actors a where a.org_id=${actor.orgId} and a.id=${botId}
      and a.type in ('agent','service_account') and (${all} or exists(select 1 from bot_account_observers o
        where o.org_id=a.org_id and o.bot_actor_id=a.id and o.observer_actor_id=${actor.id}))`;
    if (!bot) throw new NotFoundError("Bot workspace is unavailable or your access was revoked.");
  }
}
