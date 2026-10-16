import {
  mailProductivityPreferencesSchema,
  type MailProductivityPreferences,
  type MailProductivityArtifact,
} from "@helix/contracts";
import type { Actor } from "@helix/sdk-types";
import type postgres from "postgres";
import { ConflictError } from "../../../api/api-error.js";
import { withTenantIoSagaPostgresContext } from "../../tenancy/postgres-roles.js";

export interface ArtifactRow {
  id: string;
  kind: MailProductivityArtifact["kind"];
  source_key: string;
  thread_id: string | null;
  message_id: string | null;
  event_id: string | null;
  status: MailProductivityArtifact["status"];
  body: string;
  object_id: string | null;
  error: string | null;
  created_at: Date;
  updated_at: Date;
  lease_token: string;
  lease_until?: Date;
  attempts?: number;
}
export function artifactView(row: ArtifactRow): MailProductivityArtifact {
  return {
    id: row.id,
    kind: row.kind,
    sourceKey: row.source_key,
    status: row.status,
    text: row.body,
    objectId: row.object_id,
    error: row.error,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}
export class MailProductivityStore {
  constructor(readonly sql: postgres.Sql) {}
  async preferences(actor: Actor): Promise<MailProductivityPreferences> {
    const [row] = await this.sql<
      { settings: unknown }[]
    >`select settings from mail_productivity_preferences
      where org_id=${actor.orgId} and actor_id=${actor.id}`;
    return mailProductivityPreferencesSchema.parse(row?.settings ?? {});
  }
  async savePreferences(
    actor: Actor,
    input: MailProductivityPreferences,
  ): Promise<MailProductivityPreferences> {
    const settings = mailProductivityPreferencesSchema.parse(input);
    await this.sql`insert into mail_productivity_preferences(org_id,actor_id,settings)
      values(${actor.orgId},${actor.id},${this.sql.json(settings)})
      on conflict(org_id,actor_id) do update set settings=excluded.settings,updated_at=now(),next_run_at=now()`;
    return settings;
  }
  async followUp(
    actor: Actor,
    input: { threadId: string; messageId: string; state: string },
  ): Promise<void> {
    const rows = await this.sql`update mail_thread_state s set follow_up_state=${input.state},
      follow_up_message_id=${input.messageId},updated_at=now()
      where s.org_id=${actor.orgId} and s.actor_id=${actor.id} and s.thread_id=${input.threadId}
        and s.deleted_at is null and s.spam_at is null
        and ${input.messageId}::uuid=(select m.id from messages m
          where m.org_id=s.org_id and m.thread_id=s.thread_id and m.kind='mail' and m.deleted_at is null
            and (m.actor_id=${actor.id} or exists(select 1 from mail_message_deliveries d
              where d.org_id=m.org_id and d.message_id=m.id and d.actor_id=${actor.id}))
            and not exists(select 1 from mail_outbound_messages o
              where o.org_id=m.org_id and o.message_id=m.id and o.status not in ('accepted','delivered'))
          order by m.sent_at desc,m.id desc limit 1)
      returning s.thread_id`;
    if (!rows.length)
      throw new ConflictError(
        "Conversation changed or is unavailable. Refresh it before changing follow-up status.",
      );
  }
  async find(
    actor: Actor,
    kind: ArtifactRow["kind"],
    sourceKey: string,
  ): Promise<ArtifactRow | null> {
    const [row] = await this.sql<ArtifactRow[]>`select * from mail_productivity_artifacts
      where org_id=${actor.orgId} and actor_id=${actor.id} and kind=${kind} and source_key=${sourceKey}
        and (kind='filing' or expires_at>now())`;
    return row ?? null;
  }
  async claim(
    actor: Actor,
    input: {
      kind: ArtifactRow["kind"];
      sourceKey: string;
      threadId?: string;
      messageId?: string;
      eventId?: string;
    },
  ): Promise<ArtifactRow | null> {
    return withTenantIoSagaPostgresContext(
      this.sql,
      { orgId: actor.orgId, actorId: actor.id },
      async (sql) => {
        // On-demand bot artifacts need the same retention cleanup as opted-in humans.
        await sql`insert into mail_productivity_preferences(org_id,actor_id) select ${actor.orgId},${actor.id} where not exists(select 1 from mail_productivity_preferences where org_id=${actor.orgId} and actor_id=${actor.id}) on conflict do nothing`;
        await sql`delete from mail_productivity_artifacts where org_id=${actor.orgId} and actor_id=${actor.id} and kind=${input.kind} and source_key=${input.sourceKey} and kind<>'filing' and expires_at<=now()`;
        const [row] = await sql<ArtifactRow[]>`insert into mail_productivity_artifacts
        (org_id,actor_id,kind,source_key,thread_id,message_id,event_id)
        values(${actor.orgId},${actor.id},${input.kind},${input.sourceKey},${input.threadId ?? null},${input.messageId ?? null},${input.eventId ?? null})
        on conflict(org_id,actor_id,kind,source_key) do update set status='working',error=null,
          lease_token=gen_random_uuid(),lease_until=now()+interval '5 minutes',attempts=mail_productivity_artifacts.attempts+1,
          updated_at=now()
        where mail_productivity_artifacts.status<>'ready' and mail_productivity_artifacts.lease_until<now()
          and mail_productivity_artifacts.attempts<3
        returning *`;
        return row ?? null;
      },
    );
  }
  async finish(actor: Actor, claim: ArtifactRow, text: string, objectId?: string): Promise<void> {
    await withTenantIoSagaPostgresContext(
      this.sql,
      { orgId: actor.orgId, actorId: actor.id },
      async (sql) => {
        await sql`update mail_productivity_artifacts set status='ready',body=${text.slice(0, 32000)},
        object_id=coalesce(${objectId ?? null}::uuid,object_id),error=null,updated_at=now()
        where org_id=${actor.orgId} and actor_id=${actor.id} and id=${claim.id} and lease_token=${claim.lease_token}`;
      },
    );
  }
  async setObject(actor: Actor, claim: ArtifactRow, objectId: string): Promise<void> {
    await withTenantIoSagaPostgresContext(
      this.sql,
      { orgId: actor.orgId, actorId: actor.id },
      async (sql) => {
        await sql`update mail_productivity_artifacts set object_id=${objectId},updated_at=now()
        where org_id=${actor.orgId} and actor_id=${actor.id} and id=${claim.id} and lease_token=${claim.lease_token}`;
      },
    );
  }
  async fail(actor: Actor, claim: ArtifactRow): Promise<void> {
    await withTenantIoSagaPostgresContext(
      this.sql,
      { orgId: actor.orgId, actorId: actor.id },
      async (sql) => {
        await sql`update mail_productivity_artifacts set status='failed',body='',
        error='Preparation failed. Check AI availability, source access and storage; automatic retries are limited to three.',
        lease_until=now()+interval '5 minutes',updated_at=now()
        where org_id=${actor.orgId} and actor_id=${actor.id} and id=${claim.id} and lease_token=${claim.lease_token}`;
      },
    );
  }
  async recent(actor: Actor): Promise<readonly ArtifactRow[]> {
    return this.sql<ArtifactRow[]>`select * from mail_productivity_artifacts
      where org_id=${actor.orgId} and actor_id=${actor.id} and expires_at>now()
      order by updated_at desc limit 50`;
  }
  async expire(actor: Pick<Actor, "id" | "orgId">): Promise<void> {
    await this
      .sql`delete from mail_productivity_artifacts a where org_id=${actor.orgId} and actor_id=${actor.id}
      and kind<>'filing' and (expires_at<=now() or (thread_id is not null and not exists(
        select 1 from mail_thread_state s where s.org_id=a.org_id and s.actor_id=a.actor_id
          and s.thread_id=a.thread_id and s.deleted_at is null and s.spam_at is null)))`;
  }
}
