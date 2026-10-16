import type { Actor } from "@helix/sdk-types";
import { withTenantPostgresContext } from "../../tenancy/postgres-roles.js";
import type { RuntimeToolRegistry } from "../../tool-registry.js";
import { actorHasPermission } from "../../permissions/roles.js";
import { sourceHash, messageMatches, type MailProductivityService } from "./service.js";

export class MailProductivityWorker {
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<void> | undefined;
  constructor(
    private readonly service: MailProductivityService,
    private readonly tools: RuntimeToolRegistry,
    private readonly resolve: (orgId: string, actorId: string) => Promise<Actor | null>,
    private readonly onError: (error: unknown) => void,
  ) {}
  async start(): Promise<void> {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.runOnce().catch(this.onError);
    }, 30000);
    this.timer.unref();
    await this.runOnce();
  }
  async stop(): Promise<void> {
    clearInterval(this.timer);
    this.timer = undefined;
    await this.running;
  }
  async runOnce(): Promise<void> {
    if (this.running) return this.running;
    this.running = this.run().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }
  private async run(): Promise<void> {
    const { sql } = this.service.options.store;
    const due = await sql<
      { org_id: string; actor_id: string }[]
    >`select * from helix_mail_productivity_work(20)`;
    for (const item of due) {
      try {
        // Commit cleanup before tools claim their work on independent connections.
        await withTenantPostgresContext(
          sql,
          { orgId: item.org_id, actorId: item.actor_id },
          async () => {
            await sql`update mail_productivity_preferences set next_run_at=now()+interval '5 minutes' where org_id=${item.org_id} and actor_id=${item.actor_id}`;
            await this.service.options.store.expire({ orgId: item.org_id, id: item.actor_id });
          },
        );
        await withTenantPostgresContext(
          sql,
          { orgId: item.org_id, actorId: item.actor_id },
          async () => {
            const actor = await this.resolve(item.org_id, item.actor_id);
            if (
              !actor ||
              actor.type !== "user" ||
              !actorHasPermission(actor, "mail.read", { type: "mail", orgId: actor.orgId })
            )
              return;
            const prefs = await this.service.options.store.preferences(actor);
            const invoke = async (id: string, input: unknown) => {
              const result = await this.tools.invoke(id, input, { actor });
              if (!result.ok)
                throw new Error(
                  `Mail productivity operation failed: ${id} (${String(result.statusCode)}).`,
                );
              return result;
            };
            if (prefs.preparedReplies && (await this.service.options.enabled(actor.orgId))) {
              const candidates = await this.service.options.mail.listThreads({
                orgId: actor.orgId,
                actorId: actor.id,
                folder: "all",
                query: "is:needs-reply newer_than:7d",
                limit: 50,
              });
              let prepared = 0;
              for (const thread of candidates.threads) {
                const currentPrefs = await this.service.options.store.preferences(actor);
                if (!currentPrefs.preparedReplies || prepared >= 5) break;
                const sourceKey = `${thread.threadId}:${thread.messageId}:${sourceHash(currentPrefs.writingInstructions).slice(0, 16)}`;
                const prior = await this.service.options.store.find(actor, "reply", sourceKey);
                if (
                  prior?.status === "ready" ||
                  (prior?.attempts ?? 0) >= 3 ||
                  (prior?.lease_until && prior.lease_until.getTime() > Date.now())
                )
                  continue;
                prepared++;
                try {
                  await invoke("mail.reply.prepare", { threadId: thread.threadId });
                } catch (error) {
                  this.onError(error);
                }
              }
            }
            if (
              prefs.meetingBriefs &&
              (await this.service.options.enabled(actor.orgId)) &&
              actorHasPermission(actor, "calendar.read", { type: "calendar", orgId: actor.orgId })
            ) {
              const now = new Date();
              const events =
                (await this.service.options.calendar?.listCalendarEventsForActor({
                  orgId: actor.orgId,
                  actorId: actor.id,
                  startsAt: now,
                  endsAt: new Date(now.getTime() + 3600000),
                  limit: 5,
                })) ?? [];
              for (const event of events.filter((event) => event.status !== "cancelled")) {
                try {
                  await invoke("mail.meeting.brief", { eventId: event.id, threadIds: [] });
                } catch (error) {
                  this.onError(error);
                }
              }
            }
            if (prefs.dailyDigest && new Date().getUTCHours() >= prefs.digestHourUtc) {
              const sourceKey = new Date().toISOString().slice(0, 10);
              const claim = await this.service.options.store.claim(actor, {
                kind: "digest",
                sourceKey,
              });
              if (claim) {
                try {
                  const result = await invoke("mail.action.digest", {});
                  if (result.status !== "pending_confirmation")
                    await this.service.options.store.finish(
                      actor,
                      claim,
                      JSON.stringify(result.output),
                    );
                  else await this.service.options.store.fail(actor, claim);
                } catch (error) {
                  await this.service.options.store.fail(actor, claim);
                  this.onError(error);
                }
              }
            }
            if (prefs.filingRules.some((rule) => rule.enabled))
              await this.fileIncoming(actor, invoke);
          },
        );
      } catch (error) {
        this.onError(error);
      }
    }
  }
  private async fileIncoming(
    actor: Actor,
    invoke: (id: string, input: unknown) => Promise<unknown>,
  ): Promise<void> {
    const { sql } = this.service.options.store;
    const rows = await sql<{ id: string; thread_id: string; created_at: Date }[]>`
      select m.id,m.thread_id,m.created_at from messages m
      join mail_message_deliveries d on d.org_id=m.org_id and d.message_id=m.id and d.actor_id=${actor.id}
      join mail_thread_state s on s.org_id=m.org_id and s.thread_id=m.thread_id and s.actor_id=${actor.id}
      join mail_productivity_preferences p on p.org_id=m.org_id and p.actor_id=${actor.id}
      where m.org_id=${actor.orgId} and m.kind='mail' and m.deleted_at is null
        and s.deleted_at is null and s.spam_at is null and d.received_at is not null
        and (m.created_at,m.id)>(coalesce(p.filing_cursor_at,p.updated_at),coalesce(p.filing_cursor_id,'00000000-0000-0000-0000-000000000000'::uuid))
      order by m.created_at,m.id limit 25`;
    for (const row of rows) {
      const prefs = await this.service.options.store.preferences(actor);
      const thread = await this.service.thread(actor, row.thread_id);
      const message = thread.messages.find((message) => message.id === row.id);
      if (message) {
        for (const rule of prefs.filingRules.filter((rule) => rule.enabled)) {
          if (!messageMatches(thread.subject, message, rule.criteria)) continue;
          for (const attachment of message.attachments.filter(
            (attachment) => attachment.disposition !== "inline",
          )) {
            await invoke("mail.attachment.file", {
              threadId: row.thread_id,
              messageId: row.id,
              objectId: attachment.objectId,
              folderId: rule.folderId,
            });
          }
        }
      }
      await sql`update mail_productivity_preferences set filing_cursor_at=${row.created_at},filing_cursor_id=${row.id}
        where org_id=${actor.orgId} and actor_id=${actor.id}`;
    }
  }
}
