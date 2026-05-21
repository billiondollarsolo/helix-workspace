import type postgres from "postgres";
import type { AdminServiceStatus } from "./services.js";

export interface AdminServiceRuntimeCounter {
  readonly key: string;
  readonly label: string;
  readonly value: number;
  readonly unit?: string | undefined;
}

export interface AdminServiceRuntimeCheck {
  readonly key: string;
  readonly label: string;
  readonly status: AdminServiceStatus;
  readonly evidence: string;
}

export interface AdminServiceRuntimeStatus {
  readonly generatedAt: string;
  readonly serviceId: string;
  readonly status: AdminServiceStatus;
  readonly evidence: string;
  readonly counters: readonly AdminServiceRuntimeCounter[];
  readonly checks: readonly AdminServiceRuntimeCheck[];
  readonly lastActivityAt?: string | undefined;
}

export interface AdminServiceRuntimeStatusInput {
  readonly serviceId: string;
  readonly orgId: string;
}

export interface AdminServiceRuntimeStatusStore {
  get(input: AdminServiceRuntimeStatusInput): Promise<AdminServiceRuntimeStatus | null>;
}

export interface PostgresAdminServiceStatusStoreOptions {
  readonly env: NodeJS.ProcessEnv;
  readonly now?: (() => Date) | undefined;
}

type CountRow = { readonly count: string | number | bigint | null };
type TimestampRow = { readonly value: Date | string | null };

export class PostgresAdminServiceStatusStore implements AdminServiceRuntimeStatusStore {
  readonly #sql: postgres.Sql;
  readonly #env: NodeJS.ProcessEnv;
  readonly #now: () => Date;

  constructor(sql: postgres.Sql, options: PostgresAdminServiceStatusStoreOptions) {
    this.#sql = sql;
    this.#env = options.env;
    this.#now = options.now ?? (() => new Date());
  }

  async get(input: AdminServiceRuntimeStatusInput): Promise<AdminServiceRuntimeStatus | null> {
    switch (input.serviceId) {
      case "mail":
        return this.#mail(input.orgId);
      case "chat":
        return this.#chat(input.orgId);
      case "drive":
        return this.#drive(input.orgId);
      case "docs":
        return this.#docs(input.orgId);
      case "calendar":
        return this.#calendar(input.orgId);
      case "meet":
        return this.#meet(input.orgId);
      case "search":
        return this.#search(input.orgId);
      case "storage":
        return this.#storage(input.orgId);
      case "ai":
        return this.#ai(input.orgId);
      case "assistant":
        return this.#assistant(input.orgId);
      case "webhooks":
        return this.#webhooks(input.orgId);
      case "auth":
        return this.#auth(input.orgId);
      case "audit":
        return this.#audit(input.orgId);
      case "backups":
        return this.#backups(input.orgId);
      default:
        return null;
    }
  }

  async #mail(orgId: string): Promise<AdminServiceRuntimeStatus> {
    const [
      threadRows,
      messageRows,
      queuedRows,
      sentRows,
      failedRows,
      filterRows,
      aliasRows,
      lastActivityRows,
    ] = await Promise.all([
      this.#sql<CountRow[]>`
        select count(distinct thread_id)::bigint as count
        from mail_thread_state
        where org_id = ${orgId} and deleted_at is null
      `,
      this.#sql<CountRow[]>`
        select count(distinct m.id)::bigint as count
        from messages m
        join threads t on t.id = m.thread_id
        where t.org_id = ${orgId}
          and t.kind = 'mail'
          and m.kind = 'mail'
          and m.deleted_at is null
      `,
      this.#sql<CountRow[]>`
        select count(*)::bigint as count
        from mail_outbound_messages
        where org_id = ${orgId} and status in ('queued', 'sending')
      `,
      this.#sql<CountRow[]>`
        select count(*)::bigint as count
        from mail_outbound_messages
        where org_id = ${orgId} and status = 'sent'
      `,
      this.#sql<CountRow[]>`
        select count(*)::bigint as count
        from mail_outbound_messages
        where org_id = ${orgId} and status = 'failed'
      `,
      this.#sql<CountRow[]>`
        select count(*)::bigint as count
        from mail_filters
        where org_id = ${orgId} and enabled = true and deleted_at is null
      `,
      this.#sql<CountRow[]>`
        select count(*)::bigint as count
        from mail_aliases
        where org_id = ${orgId} and enabled = true and disabled_at is null
      `,
      this.#sql<TimestampRow[]>`
        select greatest(
          coalesce((select max(sent_at) from messages where org_id = ${orgId} and kind = 'mail'), 'epoch'::timestamptz),
          coalesce((select max(updated_at) from mail_outbound_messages where org_id = ${orgId}), 'epoch'::timestamptz),
          coalesce((select max(updated_at) from mail_thread_state where org_id = ${orgId}), 'epoch'::timestamptz)
        ) as value
      `,
    ]);

    return runtimeStatus({
      now: this.#now,
      serviceId: "mail",
      evidence: "Mail tables are reachable and org-scoped mailbox state was counted.",
      counters: [
        counter("threads", "Mailbox threads", countValue(threadRows[0])),
        counter("messages", "Mail messages", countValue(messageRows[0])),
        counter("outboundQueued", "Outbound queued", countValue(queuedRows[0])),
        counter("outboundSent", "Outbound sent", countValue(sentRows[0])),
        counter("outboundFailed", "Outbound failed", countValue(failedRows[0])),
        counter("filters", "Enabled filters", countValue(filterRows[0])),
        counter("aliases", "Enabled aliases", countValue(aliasRows[0])),
      ],
      checks: [envCheck("smtp", "SMTP relay", this.#env, ["MAIL_SMTP_HOST"], false)],
      lastActivityAt: timestampValue(lastActivityRows[0]),
    });
  }

  async #chat(orgId: string): Promise<AdminServiceRuntimeStatus> {
    const [roomRows, dmRows, messageRows, reactionRows, pinRows, lastActivityRows] =
      await Promise.all([
        this.#sql<CountRow[]>`
          select count(*)::bigint as count
          from threads
          where org_id = ${orgId} and kind = 'chat_room' and archived_at is null
        `,
        this.#sql<CountRow[]>`
          select count(*)::bigint as count
          from threads
          where org_id = ${orgId} and kind = 'chat_dm' and archived_at is null
        `,
        this.#sql<CountRow[]>`
          select count(*)::bigint as count
          from messages
          where org_id = ${orgId} and kind = 'chat' and deleted_at is null
        `,
        this.#sql<CountRow[]>`
          select count(*)::bigint as count
          from chat_reactions
          where org_id = ${orgId}
        `,
        this.#sql<CountRow[]>`
          select count(*)::bigint as count
          from chat_pins
          where org_id = ${orgId}
        `,
        this.#sql<TimestampRow[]>`
          select greatest(
            coalesce((select max(sent_at) from messages where org_id = ${orgId} and kind = 'chat'), 'epoch'::timestamptz),
            coalesce((select max(updated_at) from chat_room_settings where org_id = ${orgId}), 'epoch'::timestamptz)
          ) as value
        `,
      ]);

    return runtimeStatus({
      now: this.#now,
      serviceId: "chat",
      evidence: "Chat rooms, DMs, messages, reactions, and pins were counted from Postgres.",
      counters: [
        counter("rooms", "Rooms", countValue(roomRows[0])),
        counter("directMessages", "DM threads", countValue(dmRows[0])),
        counter("messages", "Messages", countValue(messageRows[0])),
        counter("reactions", "Reactions", countValue(reactionRows[0])),
        counter("pins", "Pinned messages", countValue(pinRows[0])),
      ],
      checks: [
        envCheck("redis", "Redis presence", this.#env, ["REDIS_URL"], false),
        envCheck("nats", "Realtime event bus", this.#env, ["NATS_URL"], false),
      ],
      lastActivityAt: timestampValue(lastActivityRows[0]),
    });
  }

  async #drive(orgId: string): Promise<AdminServiceRuntimeStatus> {
    const [fileRows, folderRows, versionRows, byteRows, trashedRows, lastActivityRows] =
      await Promise.all([
        this.#sql<CountRow[]>`
          select count(*)::bigint as count
          from objects
          where org_id = ${orgId} and kind in ('file', 'document') and deleted_at is null
        `,
        this.#sql<CountRow[]>`
          select count(*)::bigint as count
          from drive_folders
          where org_id = ${orgId} and deleted_at is null
        `,
        this.#sql<CountRow[]>`
          select count(*)::bigint as count
          from drive_versions
          where org_id = ${orgId}
        `,
        this.#sql<CountRow[]>`
          select coalesce(sum(byte_size), 0)::bigint as count
          from objects
          where org_id = ${orgId} and deleted_at is null
        `,
        this.#sql<CountRow[]>`
          select count(*)::bigint as count
          from objects
          where org_id = ${orgId} and deleted_at is not null
        `,
        this.#sql<TimestampRow[]>`
          select greatest(
            coalesce((select max(updated_at) from objects where org_id = ${orgId}), 'epoch'::timestamptz),
            coalesce((select max(updated_at) from drive_folders where org_id = ${orgId}), 'epoch'::timestamptz),
            coalesce((select max(created_at) from drive_versions where org_id = ${orgId}), 'epoch'::timestamptz)
          ) as value
        `,
      ]);

    return runtimeStatus({
      now: this.#now,
      serviceId: "drive",
      evidence: "Drive object, folder, version, and storage totals were counted from Postgres.",
      counters: [
        counter("files", "Files", countValue(fileRows[0])),
        counter("folders", "Folders", countValue(folderRows[0])),
        counter("versions", "Versions", countValue(versionRows[0])),
        counter("bytes", "Stored bytes", countValue(byteRows[0]), "bytes"),
        counter("trashed", "Trashed files", countValue(trashedRows[0])),
      ],
      checks: [
        envCheck(
          "objectStorage",
          "Object storage",
          this.#env,
          ["RUSTFS_ENDPOINT", "S3_ENDPOINT"],
          true,
        ),
      ],
      lastActivityAt: timestampValue(lastActivityRows[0]),
    });
  }

  async #docs(orgId: string): Promise<AdminServiceRuntimeStatus> {
    const [docRows, updateRows, commentRows, openCommentRows, lastActivityRows] = await Promise.all(
      [
        this.#sql<CountRow[]>`
        select count(*)::bigint as count
        from docs_documents
        where org_id = ${orgId} and deleted_at is null
      `,
        this.#sql<CountRow[]>`
        select count(*)::bigint as count
        from docs_updates
        where org_id = ${orgId}
      `,
        this.#sql<CountRow[]>`
        select count(*)::bigint as count
        from docs_comments
        where org_id = ${orgId}
      `,
        this.#sql<CountRow[]>`
        select count(*)::bigint as count
        from docs_comments
        where org_id = ${orgId} and status = 'open' and resolved_at is null
      `,
        this.#sql<TimestampRow[]>`
        select greatest(
          coalesce((select max(updated_at) from docs_documents where org_id = ${orgId}), 'epoch'::timestamptz),
          coalesce((select max(created_at) from docs_updates where org_id = ${orgId}), 'epoch'::timestamptz),
          coalesce((select max(updated_at) from docs_comments where org_id = ${orgId}), 'epoch'::timestamptz)
        ) as value
      `,
      ],
    );

    return runtimeStatus({
      now: this.#now,
      serviceId: "docs",
      evidence: "Docs documents, CRDT updates, and comments were counted from Postgres.",
      counters: [
        counter("documents", "Documents", countValue(docRows[0])),
        counter("updates", "Yjs updates", countValue(updateRows[0])),
        counter("comments", "Comments", countValue(commentRows[0])),
        counter("openComments", "Open comments", countValue(openCommentRows[0])),
      ],
      checks: [envCheck("eventBus", "Document sync event bus", this.#env, ["NATS_URL"], false)],
      lastActivityAt: timestampValue(lastActivityRows[0]),
    });
  }

  async #calendar(orgId: string): Promise<AdminServiceRuntimeStatus> {
    const [calendarRows, upcomingRows, pastRows, attendeeRows, needsActionRows, lastActivityRows] =
      await Promise.all([
        this.#sql<CountRow[]>`
          select count(*)::bigint as count
          from cal_calendars
          where org_id = ${orgId} and deleted_at is null
        `,
        this.#sql<CountRow[]>`
          select count(*)::bigint as count
          from cal_events
          where org_id = ${orgId} and deleted_at is null and starts_at >= now()
        `,
        this.#sql<CountRow[]>`
          select count(*)::bigint as count
          from cal_events
          where org_id = ${orgId} and deleted_at is null and starts_at < now()
        `,
        this.#sql<CountRow[]>`
          select count(*)::bigint as count
          from cal_attendees
          where org_id = ${orgId}
        `,
        this.#sql<CountRow[]>`
          select count(*)::bigint as count
          from cal_attendees
          where org_id = ${orgId} and response_status = 'needs_action'
        `,
        this.#sql<TimestampRow[]>`
          select greatest(
            coalesce((select max(updated_at) from cal_calendars where org_id = ${orgId}), 'epoch'::timestamptz),
            coalesce((select max(updated_at) from cal_events where org_id = ${orgId}), 'epoch'::timestamptz),
            coalesce((select max(updated_at) from cal_attendees where org_id = ${orgId}), 'epoch'::timestamptz)
          ) as value
        `,
      ]);

    return runtimeStatus({
      now: this.#now,
      serviceId: "calendar",
      evidence: "Calendars, events, attendees, and pending RSVP state were counted from Postgres.",
      counters: [
        counter("calendars", "Calendars", countValue(calendarRows[0])),
        counter("upcomingEvents", "Upcoming events", countValue(upcomingRows[0])),
        counter("pastEvents", "Past events", countValue(pastRows[0])),
        counter("attendees", "Attendees", countValue(attendeeRows[0])),
        counter("needsAction", "Pending RSVPs", countValue(needsActionRows[0])),
      ],
      checks: [
        envCheck("mailInvites", "Mail invitation sender", this.#env, ["MAIL_SMTP_HOST"], false),
      ],
      lastActivityAt: timestampValue(lastActivityRows[0]),
    });
  }

  async #meet(orgId: string): Promise<AdminServiceRuntimeStatus> {
    const [activeRows, endedRows, totalRows, lastActivityRows] = await Promise.all([
      this.#sql<CountRow[]>`
        select count(*)::bigint as count
        from meet_rooms
        where org_id = ${orgId} and status = 'active'
      `,
      this.#sql<CountRow[]>`
        select count(*)::bigint as count
        from meet_rooms
        where org_id = ${orgId} and status = 'ended'
      `,
      this.#sql<CountRow[]>`
        select count(*)::bigint as count
        from meet_rooms
        where org_id = ${orgId}
      `,
      this.#sql<TimestampRow[]>`
        select greatest(
          coalesce((select max(started_at) from meet_rooms where org_id = ${orgId}), 'epoch'::timestamptz),
          coalesce((select max(updated_at) from meet_rooms where org_id = ${orgId}), 'epoch'::timestamptz)
        ) as value
      `,
    ]);

    return runtimeStatus({
      now: this.#now,
      serviceId: "meet",
      evidence: "Meet room lifecycle state was counted from Postgres.",
      counters: [
        counter("rooms", "Total rooms", countValue(totalRows[0])),
        counter("activeRooms", "Active rooms", countValue(activeRows[0])),
        counter("endedRooms", "Ended rooms", countValue(endedRows[0])),
      ],
      checks: [
        envCheck("jitsiDomain", "Jitsi domain", this.#env, ["MEET_JITSI_DOMAIN"], false),
        envCheck("jitsiJwt", "Jitsi JWT secret", this.#env, ["MEET_JITSI_JWT_SECRET"], false),
      ],
      lastActivityAt: timestampValue(lastActivityRows[0]),
    });
  }

  async #search(orgId: string): Promise<AdminServiceRuntimeStatus> {
    const [mailRows, chatRows, driveRows, docsRows, calendarRows] = await Promise.all([
      this.#sql<CountRow[]>`
        select count(distinct thread_id)::bigint as count
        from mail_thread_state
        where org_id = ${orgId} and deleted_at is null
      `,
      this.#sql<CountRow[]>`
        select count(*)::bigint as count
        from messages
        where org_id = ${orgId} and kind = 'chat' and deleted_at is null
      `,
      this.#sql<CountRow[]>`
        select count(*)::bigint as count
        from objects
        where org_id = ${orgId} and kind in ('file', 'document') and deleted_at is null
      `,
      this.#sql<CountRow[]>`
        select count(*)::bigint as count
        from docs_documents
        where org_id = ${orgId} and deleted_at is null
      `,
      this.#sql<CountRow[]>`
        select count(*)::bigint as count
        from cal_events
        where org_id = ${orgId} and deleted_at is null
      `,
    ]);

    return runtimeStatus({
      now: this.#now,
      serviceId: "search",
      evidence:
        "Searchable source rows were counted; index health is represented by configured search dependencies.",
      counters: [
        counter("mailDocuments", "Mail records", countValue(mailRows[0])),
        counter("chatDocuments", "Chat records", countValue(chatRows[0])),
        counter("driveDocuments", "Drive records", countValue(driveRows[0])),
        counter("docsDocuments", "Docs records", countValue(docsRows[0])),
        counter("calendarDocuments", "Calendar records", countValue(calendarRows[0])),
      ],
      checks: [
        envCheck("meilisearch", "Meilisearch", this.#env, ["MEILI_URL"], false),
        envCheck(
          "vectorStore",
          "Vector search",
          this.#env,
          ["PGVECTOR_DATABASE_URL", "DATABASE_URL"],
          false,
        ),
      ],
    });
  }

  async #storage(orgId: string): Promise<AdminServiceRuntimeStatus> {
    const [objectRows, byteRows, versionRows, attachmentRows, lastActivityRows] = await Promise.all(
      [
        this.#sql<CountRow[]>`
        select count(*)::bigint as count
        from objects
        where org_id = ${orgId} and deleted_at is null
      `,
        this.#sql<CountRow[]>`
        select coalesce(sum(byte_size), 0)::bigint as count
        from objects
        where org_id = ${orgId} and deleted_at is null
      `,
        this.#sql<CountRow[]>`
        select count(*)::bigint as count
        from drive_versions
        where org_id = ${orgId}
      `,
        this.#sql<CountRow[]>`
        select count(*)::bigint as count
        from message_attachments ma
        join messages m on m.id = ma.message_id
        where m.org_id = ${orgId}
      `,
        this.#sql<TimestampRow[]>`
        select greatest(
          coalesce((select max(updated_at) from objects where org_id = ${orgId}), 'epoch'::timestamptz),
          coalesce((select max(created_at) from drive_versions where org_id = ${orgId}), 'epoch'::timestamptz)
        ) as value
      `,
      ],
    );

    return runtimeStatus({
      now: this.#now,
      serviceId: "storage",
      evidence:
        "Object metadata, versions, attachments, and stored byte totals were counted from Postgres.",
      counters: [
        counter("objects", "Objects", countValue(objectRows[0])),
        counter("bytes", "Stored bytes", countValue(byteRows[0]), "bytes"),
        counter("versions", "Versions", countValue(versionRows[0])),
        counter("attachments", "Message attachments", countValue(attachmentRows[0])),
      ],
      checks: [
        envCheck(
          "objectStorage",
          "Object storage",
          this.#env,
          ["RUSTFS_ENDPOINT", "S3_ENDPOINT"],
          true,
        ),
      ],
      lastActivityAt: timestampValue(lastActivityRows[0]),
    });
  }

  async #ai(orgId: string): Promise<AdminServiceRuntimeStatus> {
    const [artifactRows, memoryRows, pendingRows, lastActivityRows] = await Promise.all([
      this.#sql<CountRow[]>`
        select count(*)::bigint as count
        from ai_artifacts
        where org_id = ${orgId}
      `,
      this.#sql<CountRow[]>`
        select count(*)::bigint as count
        from memory_items
        where org_id = ${orgId}
      `,
      this.#sql<CountRow[]>`
        select count(*)::bigint as count
        from pending_actions
        where org_id = ${orgId} and status = 'pending_confirmation'
      `,
      this.#sql<TimestampRow[]>`
        select greatest(
          coalesce((select max(created_at) from ai_artifacts where org_id = ${orgId}), 'epoch'::timestamptz),
          coalesce((select max(created_at) from memory_items where org_id = ${orgId}), 'epoch'::timestamptz),
          coalesce((select max(created_at) from pending_actions where org_id = ${orgId}), 'epoch'::timestamptz)
        ) as value
      `,
    ]);

    return runtimeStatus({
      now: this.#now,
      serviceId: "ai",
      evidence: "AI artifact, memory, and confirmation queue rows were counted from Postgres.",
      counters: [
        counter("artifacts", "AI artifacts", countValue(artifactRows[0])),
        counter("memories", "Memory items", countValue(memoryRows[0])),
        counter("pendingActions", "Pending confirmations", countValue(pendingRows[0])),
      ],
      checks: [
        envCheck(
          "openai",
          "OpenAI-compatible provider",
          this.#env,
          ["OPENAI_API_KEY", "OPENAI_BASE_URL"],
          false,
        ),
        envCheck("ollama", "Ollama provider", this.#env, ["OLLAMA_BASE_URL"], false),
      ],
      lastActivityAt: timestampValue(lastActivityRows[0]),
    });
  }

  async #assistant(orgId: string): Promise<AdminServiceRuntimeStatus> {
    const [conversationRows, messageRows, memoryPreferenceRows, lastActivityRows] =
      await Promise.all([
        this.#sql<CountRow[]>`
        select count(*)::bigint as count
        from assistant_conversations
        where org_id = ${orgId} and archived_at is null
      `,
        this.#sql<CountRow[]>`
        select count(*)::bigint as count
        from assistant_messages
        where org_id = ${orgId}
      `,
        this.#sql<CountRow[]>`
        select count(*)::bigint as count
        from assistant_memory_preferences
        where org_id = ${orgId} and enabled = true
      `,
        this.#sql<TimestampRow[]>`
        select greatest(
          coalesce((select max(updated_at) from assistant_conversations where org_id = ${orgId}), 'epoch'::timestamptz),
          coalesce((select max(created_at) from assistant_messages where org_id = ${orgId}), 'epoch'::timestamptz),
          coalesce((select max(updated_at) from assistant_memory_preferences where org_id = ${orgId}), 'epoch'::timestamptz)
        ) as value
      `,
      ]);

    return runtimeStatus({
      now: this.#now,
      serviceId: "assistant",
      evidence:
        "Assistant conversations, messages, and memory preference rows were counted from Postgres.",
      counters: [
        counter("conversations", "Conversations", countValue(conversationRows[0])),
        counter("messages", "Messages", countValue(messageRows[0])),
        counter("memoryOptIns", "Memory opt-ins", countValue(memoryPreferenceRows[0])),
      ],
      checks: [
        envCheck("aiRouter", "AI router", this.#env, ["OPENAI_API_KEY", "OLLAMA_BASE_URL"], false),
      ],
      lastActivityAt: timestampValue(lastActivityRows[0]),
    });
  }

  async #webhooks(orgId: string): Promise<AdminServiceRuntimeStatus> {
    const [outboundRows, inboundRows, pendingRows, failedRows, deliveredRows, lastActivityRows] =
      await Promise.all([
        this.#sql<CountRow[]>`
          select count(*)::bigint as count
          from outbound_webhooks
          where org_id = ${orgId} and enabled = true and deleted_at is null
        `,
        this.#sql<CountRow[]>`
          select count(*)::bigint as count
          from inbound_webhooks
          where org_id = ${orgId} and enabled = true and disabled_at is null
        `,
        this.#sql<CountRow[]>`
          select count(*)::bigint as count
          from webhook_deliveries
          where org_id = ${orgId} and status in ('pending', 'in_progress')
        `,
        this.#sql<CountRow[]>`
          select count(*)::bigint as count
          from webhook_deliveries
          where org_id = ${orgId} and status in ('failed', 'abandoned')
        `,
        this.#sql<CountRow[]>`
          select count(*)::bigint as count
          from webhook_deliveries
          where org_id = ${orgId} and status = 'delivered'
        `,
        this.#sql<TimestampRow[]>`
          select greatest(
            coalesce((select max(updated_at) from outbound_webhooks where org_id = ${orgId}), 'epoch'::timestamptz),
            coalesce((select max(updated_at) from inbound_webhooks where org_id = ${orgId}), 'epoch'::timestamptz),
            coalesce((select max(updated_at) from webhook_deliveries where org_id = ${orgId}), 'epoch'::timestamptz)
          ) as value
        `,
      ]);

    return runtimeStatus({
      now: this.#now,
      serviceId: "webhooks",
      evidence: "Webhook endpoint and delivery queue rows were counted from Postgres.",
      counters: [
        counter("outbound", "Outbound webhooks", countValue(outboundRows[0])),
        counter("inbound", "Inbound webhooks", countValue(inboundRows[0])),
        counter("pendingDeliveries", "Pending deliveries", countValue(pendingRows[0])),
        counter("failedDeliveries", "Failed deliveries", countValue(failedRows[0])),
        counter("delivered", "Delivered deliveries", countValue(deliveredRows[0])),
      ],
      checks: [envCheck("eventBus", "Webhook worker event bus", this.#env, ["NATS_URL"], false)],
      lastActivityAt: timestampValue(lastActivityRows[0]),
    });
  }

  async #auth(orgId: string): Promise<AdminServiceRuntimeStatus> {
    const [userRows, agentRows, disabledRows, passwordRows, credentialRows, lastActivityRows] =
      await Promise.all([
        this.#sql<CountRow[]>`
          select count(*)::bigint as count
          from actors
          where org_id = ${orgId} and type = 'user' and disabled_at is null
        `,
        this.#sql<CountRow[]>`
          select count(*)::bigint as count
          from actors
          where org_id = ${orgId} and type = 'agent' and disabled_at is null
        `,
        this.#sql<CountRow[]>`
          select count(*)::bigint as count
          from actors
          where org_id = ${orgId} and disabled_at is not null
        `,
        this.#sql<CountRow[]>`
          select count(*)::bigint as count
          from app_passwords p
          join actors a on a.id = p.actor_id
          where a.org_id = ${orgId} and p.revoked_at is null
        `,
        this.#sql<CountRow[]>`
        select count(*)::bigint as count
        from agent_credentials c
        join actors a on a.id = c.actor_id
        where a.org_id = ${orgId} and c.revoked_at is null
      `,
        this.#sql<TimestampRow[]>`
          select greatest(
            coalesce((select max(updated_at) from actors where org_id = ${orgId}), 'epoch'::timestamptz),
            coalesce((select max(p.created_at) from app_passwords p join actors a on a.id = p.actor_id where a.org_id = ${orgId}), 'epoch'::timestamptz),
            coalesce((select max(c.created_at) from agent_credentials c join actors a on a.id = c.actor_id where a.org_id = ${orgId}), 'epoch'::timestamptz)
          ) as value
        `,
      ]);

    return runtimeStatus({
      now: this.#now,
      serviceId: "auth",
      evidence: "Actors, app passwords, and agent credentials were counted from Postgres.",
      counters: [
        counter("users", "Users", countValue(userRows[0])),
        counter("agents", "Agents", countValue(agentRows[0])),
        counter("disabledActors", "Disabled actors", countValue(disabledRows[0])),
        counter("appPasswords", "Active app passwords", countValue(passwordRows[0])),
        counter("agentCredentials", "Active agent credentials", countValue(credentialRows[0])),
      ],
      checks: [
        envCheck("betterAuthSecret", "Better Auth secret", this.#env, ["BETTER_AUTH_SECRET"], true),
      ],
      lastActivityAt: timestampValue(lastActivityRows[0]),
    });
  }

  async #audit(orgId: string): Promise<AdminServiceRuntimeStatus> {
    const [activityRows, hashedRows, outboxRows, lastActivityRows] = await Promise.all([
      this.#sql<CountRow[]>`
        select count(*)::bigint as count
        from activity
        where org_id = ${orgId}
      `,
      this.#sql<CountRow[]>`
        select count(*)::bigint as count
        from activity
        where org_id = ${orgId} and prev_hash is not null
      `,
      this.#sql<CountRow[]>`
        select count(*)::bigint as count
        from outbox
        where delivered_at is null
      `,
      this.#sql<TimestampRow[]>`
        select max(created_at) as value
        from activity
        where org_id = ${orgId}
      `,
    ]);

    return runtimeStatus({
      now: this.#now,
      serviceId: "audit",
      evidence: "Audit activity and pending outbox rows were counted from Postgres.",
      counters: [
        counter("activity", "Activity records", countValue(activityRows[0])),
        counter("hashedRecords", "Hash-linked records", countValue(hashedRows[0])),
        counter("pendingOutbox", "Pending outbox items", countValue(outboxRows[0])),
      ],
      checks: [
        envCheck(
          "immutableBucket",
          "Immutable audit storage",
          this.#env,
          ["AUDIT_S3_BUCKET"],
          false,
        ),
      ],
      lastActivityAt: timestampValue(lastActivityRows[0]),
    });
  }

  async #backups(orgId: string): Promise<AdminServiceRuntimeStatus> {
    const [operationRows, lastActivityRows] = await Promise.all([
      this.#sql<CountRow[]>`
        select count(*)::bigint as count
        from activity
        where org_id = ${orgId}
          and (
            object_type in ('backup', 'restore')
            or verb like 'backup.%'
            or verb like 'restore.%'
          )
      `,
      this.#sql<TimestampRow[]>`
        select max(created_at) as value
        from activity
        where org_id = ${orgId}
          and (
            object_type in ('backup', 'restore')
            or verb like 'backup.%'
            or verb like 'restore.%'
          )
      `,
    ]);

    return runtimeStatus({
      now: this.#now,
      serviceId: "backups",
      evidence:
        "Backup and restore configuration was inspected and matching audit activity was counted.",
      counters: [
        counter("operations", "Backup and restore activity", countValue(operationRows[0])),
      ],
      checks: [
        envCheck("backupScript", "Backup script", this.#env, ["HELIX_BACKUP_SCRIPT"], false),
        envCheck("restoreScript", "Restore script", this.#env, ["HELIX_RESTORE_SCRIPT"], false),
        envCheck("backupDirectory", "Backup directory", this.#env, ["HELIX_BACKUP_DIR"], false),
        envCheck(
          "executionSwitch",
          "Execution switch",
          this.#env,
          ["HELIX_ADMIN_BACKUP_EXECUTE"],
          false,
        ),
      ],
      lastActivityAt: timestampValue(lastActivityRows[0]),
    });
  }
}

function runtimeStatus(input: {
  readonly now: () => Date;
  readonly serviceId: string;
  readonly evidence: string;
  readonly counters: readonly AdminServiceRuntimeCounter[];
  readonly checks: readonly AdminServiceRuntimeCheck[];
  readonly lastActivityAt?: string | undefined;
}): AdminServiceRuntimeStatus {
  const degradedCheck = input.checks.find((check) => check.status === "degraded");
  const missingRequiredCheck = input.checks.find((check) => check.status === "missing");
  return {
    generatedAt: input.now().toISOString(),
    serviceId: input.serviceId,
    status:
      missingRequiredCheck === undefined && degradedCheck === undefined ? "ready" : "degraded",
    evidence: input.evidence,
    counters: input.counters,
    checks: input.checks,
    lastActivityAt: input.lastActivityAt,
  };
}

function counter(
  key: string,
  label: string,
  value: number,
  unit?: string,
): AdminServiceRuntimeCounter {
  return { key, label, value, unit };
}

function envCheck(
  key: string,
  label: string,
  env: NodeJS.ProcessEnv,
  anyOf: readonly string[],
  required: boolean,
): AdminServiceRuntimeCheck {
  const configuredKeys = anyOf.filter((envKey) => hasEnvValue(env, envKey));
  const configured = configuredKeys.length > 0;
  return {
    key,
    label,
    status: configured ? "ready" : required ? "missing" : "configured",
    evidence: configured
      ? `Configured via ${configuredKeys.join(" or ")}.`
      : required
        ? `Missing ${anyOf.join(" or ")}.`
        : `Optional ${anyOf.join(" or ")} is not configured.`,
  };
}

function hasEnvValue(env: NodeJS.ProcessEnv, key: string): boolean {
  const value = env[key];
  return value !== undefined && value.trim().length > 0;
}

function countValue(row: CountRow | undefined): number {
  const value = row?.count ?? 0;
  if (typeof value === "bigint") {
    return Number(value);
  }
  if (typeof value === "number") {
    return value;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

function timestampValue(row: TimestampRow | undefined): string | undefined {
  const value = row?.value;
  if (value === null || value === undefined) {
    return undefined;
  }
  const date = typeof value === "string" ? new Date(value) : value;
  if (!Number.isFinite(date.valueOf()) || date.valueOf() <= 0) {
    return undefined;
  }
  return date.toISOString();
}
