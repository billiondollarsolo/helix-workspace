import { randomUUID } from "node:crypto";
import type postgres from "postgres";
import type { Actor, JsonObject } from "@helix/sdk-types";
import type {
  AssistantAppendMessageInput,
  AssistantConversation,
  AssistantCreateConversationInput,
  AssistantMemoryPreference,
  AssistantMessage,
  AssistantStore,
} from "./types.js";

interface AssistantConversationRow {
  readonly id: string;
  readonly org_id: string;
  readonly actor_id: string;
  readonly title: string | null;
  readonly memory_opt_in: boolean;
  readonly metadata: JsonObject;
  readonly archived_at: Date | null;
  readonly created_at: Date;
  readonly updated_at: Date;
}

interface AssistantMessageRow {
  readonly id: string;
  readonly org_id: string;
  readonly conversation_id: string;
  readonly actor_id: string | null;
  readonly role: AssistantMessage["role"];
  readonly content: string;
  readonly tool_call_id: string | null;
  readonly metadata: JsonObject;
  readonly created_at: Date;
}

interface AssistantMemoryPreferenceRow {
  readonly org_id: string;
  readonly actor_id: string;
  readonly enabled: boolean;
  readonly metadata: JsonObject;
  readonly updated_at: Date;
}

export class InMemoryAssistantStore implements AssistantStore {
  readonly #conversations = new Map<string, AssistantConversation>();
  readonly #messages = new Map<string, AssistantMessage[]>();
  readonly #memoryPreferences = new Map<string, AssistantMemoryPreference>();

  async createConversation(input: AssistantCreateConversationInput): Promise<AssistantConversation> {
    const now = new Date().toISOString();
    const preference = await this.getMemoryPreference(input.actor);
    const conversation: AssistantConversation = {
      id: randomUUID(),
      orgId: input.actor.orgId,
      actorId: input.actor.id,
      title: input.title ?? null,
      memoryOptIn: input.memoryOptIn ?? preference?.enabled ?? false,
      metadata: input.metadata ?? {},
      archivedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    this.#conversations.set(conversation.id, conversation);
    this.#messages.set(conversation.id, []);
    return conversation;
  }

  async getConversation(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly conversationId: string;
  }): Promise<AssistantConversation | null> {
    const conversation = this.#conversations.get(input.conversationId);
    if (
      conversation === undefined ||
      conversation.orgId !== input.orgId ||
      conversation.actorId !== input.actorId
    ) {
      return null;
    }
    return conversation;
  }

  async listMessages(input: {
    readonly orgId: string;
    readonly conversationId: string;
    readonly limit?: number;
  }): Promise<readonly AssistantMessage[]> {
    const messages = this.#messages.get(input.conversationId) ?? [];
    const filtered = messages.filter((message) => message.orgId === input.orgId);
    return input.limit === undefined ? filtered : filtered.slice(Math.max(0, filtered.length - input.limit));
  }

  async appendMessage(input: AssistantAppendMessageInput): Promise<AssistantMessage> {
    const createdAt = input.createdAt ?? new Date();
    const message: AssistantMessage = {
      id: randomUUID(),
      orgId: input.orgId,
      conversationId: input.conversationId,
      actorId: input.actorId ?? null,
      role: input.role,
      content: input.content,
      toolCallId: input.toolCallId ?? null,
      metadata: input.metadata ?? {},
      createdAt: createdAt.toISOString(),
    };
    const messages = this.#messages.get(input.conversationId) ?? [];
    messages.push(message);
    this.#messages.set(input.conversationId, messages);
    this.touchConversation(input.conversationId);
    return message;
  }

  async setConversationMemoryOptIn(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly conversationId: string;
    readonly enabled: boolean;
  }): Promise<AssistantConversation | null> {
    const conversation = await this.getConversation(input);
    if (conversation === null) {
      return null;
    }
    const updated = {
      ...conversation,
      memoryOptIn: input.enabled,
      updatedAt: new Date().toISOString(),
    };
    this.#conversations.set(updated.id, updated);
    return updated;
  }

  async getMemoryPreference(actor: Actor): Promise<AssistantMemoryPreference | null> {
    return this.#memoryPreferences.get(memoryPreferenceKey(actor.orgId, actor.id)) ?? null;
  }

  async setMemoryPreference(input: {
    readonly actor: Actor;
    readonly enabled: boolean;
    readonly metadata?: JsonObject;
  }): Promise<AssistantMemoryPreference> {
    const preference: AssistantMemoryPreference = {
      orgId: input.actor.orgId,
      actorId: input.actor.id,
      enabled: input.enabled,
      metadata: input.metadata ?? {},
      updatedAt: new Date().toISOString(),
    };
    this.#memoryPreferences.set(memoryPreferenceKey(input.actor.orgId, input.actor.id), preference);
    return preference;
  }

  private touchConversation(conversationId: string): void {
    const conversation = this.#conversations.get(conversationId);
    if (conversation !== undefined) {
      this.#conversations.set(conversationId, {
        ...conversation,
        updatedAt: new Date().toISOString(),
      });
    }
  }
}

export class PostgresAssistantStore implements AssistantStore {
  constructor(private readonly sql: postgres.Sql) {}

  async createConversation(input: AssistantCreateConversationInput): Promise<AssistantConversation> {
    const preference = await this.getMemoryPreference(input.actor);
    const rows = await this.sql`
      insert into assistant_conversations (
        org_id,
        actor_id,
        title,
        memory_opt_in,
        metadata
      )
      values (
        ${input.actor.orgId},
        ${input.actor.id},
        ${input.title ?? null},
        ${input.memoryOptIn ?? preference?.enabled ?? false},
        ${this.sql.json(toSqlJson(input.metadata ?? {}))}
      )
      returning id, org_id, actor_id, title, memory_opt_in, metadata, archived_at, created_at, updated_at
    `;
    return requiredConversation(rows);
  }

  async getConversation(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly conversationId: string;
  }): Promise<AssistantConversation | null> {
    const rows = await this.sql`
      select id, org_id, actor_id, title, memory_opt_in, metadata, archived_at, created_at, updated_at
      from assistant_conversations
      where org_id = ${input.orgId}
        and actor_id = ${input.actorId}
        and id = ${input.conversationId}
        and archived_at is null
      limit 1
    `;
    const row = (rows as unknown as readonly AssistantConversationRow[])[0];
    return row === undefined ? null : rowToConversation(row);
  }

  async listMessages(input: {
    readonly orgId: string;
    readonly conversationId: string;
    readonly limit?: number;
  }): Promise<readonly AssistantMessage[]> {
    const limit = input.limit ?? 100;
    const rows = await this.sql`
      select id, org_id, conversation_id, actor_id, role, content, tool_call_id, metadata, created_at
      from (
        select id, org_id, conversation_id, actor_id, role, content, tool_call_id, metadata, created_at
        from assistant_messages
        where org_id = ${input.orgId}
          and conversation_id = ${input.conversationId}
        order by created_at desc, id desc
        limit ${limit}
      ) recent
      order by created_at asc, id asc
    `;
    return (rows as unknown as readonly AssistantMessageRow[]).map(rowToMessage);
  }

  async appendMessage(input: AssistantAppendMessageInput): Promise<AssistantMessage> {
    const rows = await this.sql`
      insert into assistant_messages (
        org_id,
        conversation_id,
        actor_id,
        role,
        content,
        tool_call_id,
        metadata,
        created_at
      )
      values (
        ${input.orgId},
        ${input.conversationId},
        ${input.actorId ?? null},
        ${input.role},
        ${input.content},
        ${input.toolCallId ?? null},
        ${this.sql.json(toSqlJson(input.metadata ?? {}))},
        ${input.createdAt ?? new Date()}
      )
      returning id, org_id, conversation_id, actor_id, role, content, tool_call_id, metadata, created_at
    `;
    await this.sql`
      update assistant_conversations
      set updated_at = now()
      where org_id = ${input.orgId}
        and id = ${input.conversationId}
    `;
    const row = (rows as unknown as readonly AssistantMessageRow[])[0];
    if (row === undefined) {
      throw new Error("Failed to append assistant message.");
    }
    return rowToMessage(row);
  }

  async setConversationMemoryOptIn(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly conversationId: string;
    readonly enabled: boolean;
  }): Promise<AssistantConversation | null> {
    const rows = await this.sql`
      update assistant_conversations
      set memory_opt_in = ${input.enabled}, updated_at = now()
      where org_id = ${input.orgId}
        and actor_id = ${input.actorId}
        and id = ${input.conversationId}
        and archived_at is null
      returning id, org_id, actor_id, title, memory_opt_in, metadata, archived_at, created_at, updated_at
    `;
    const row = (rows as unknown as readonly AssistantConversationRow[])[0];
    return row === undefined ? null : rowToConversation(row);
  }

  async getMemoryPreference(actor: Actor): Promise<AssistantMemoryPreference | null> {
    const rows = await this.sql`
      select org_id, actor_id, enabled, metadata, updated_at
      from assistant_memory_preferences
      where org_id = ${actor.orgId}
        and actor_id = ${actor.id}
      limit 1
    `;
    const row = (rows as unknown as readonly AssistantMemoryPreferenceRow[])[0];
    return row === undefined ? null : rowToMemoryPreference(row);
  }

  async setMemoryPreference(input: {
    readonly actor: Actor;
    readonly enabled: boolean;
    readonly metadata?: JsonObject;
  }): Promise<AssistantMemoryPreference> {
    const rows = await this.sql`
      insert into assistant_memory_preferences (
        org_id,
        actor_id,
        enabled,
        metadata,
        updated_at
      )
      values (
        ${input.actor.orgId},
        ${input.actor.id},
        ${input.enabled},
        ${this.sql.json(toSqlJson(input.metadata ?? {}))},
        now()
      )
      on conflict (org_id, actor_id)
      do update set
        enabled = excluded.enabled,
        metadata = excluded.metadata,
        updated_at = now()
      returning org_id, actor_id, enabled, metadata, updated_at
    `;
    const row = (rows as unknown as readonly AssistantMemoryPreferenceRow[])[0];
    if (row === undefined) {
      throw new Error("Failed to persist assistant memory preference.");
    }
    return rowToMemoryPreference(row);
  }
}

function requiredConversation(rows: unknown): AssistantConversation {
  const row = (rows as readonly AssistantConversationRow[])[0];
  if (row === undefined) {
    throw new Error("Failed to persist assistant conversation.");
  }
  return rowToConversation(row);
}

function rowToConversation(row: AssistantConversationRow): AssistantConversation {
  return {
    id: row.id,
    orgId: row.org_id,
    actorId: row.actor_id,
    title: row.title,
    memoryOptIn: row.memory_opt_in,
    metadata: row.metadata,
    archivedAt: row.archived_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function rowToMessage(row: AssistantMessageRow): AssistantMessage {
  return {
    id: row.id,
    orgId: row.org_id,
    conversationId: row.conversation_id,
    actorId: row.actor_id,
    role: row.role,
    content: row.content,
    toolCallId: row.tool_call_id,
    metadata: row.metadata,
    createdAt: row.created_at.toISOString(),
  };
}

function rowToMemoryPreference(row: AssistantMemoryPreferenceRow): AssistantMemoryPreference {
  return {
    orgId: row.org_id,
    actorId: row.actor_id,
    enabled: row.enabled,
    metadata: row.metadata,
    updatedAt: row.updated_at.toISOString(),
  };
}

function memoryPreferenceKey(orgId: string, actorId: string): string {
  return `${orgId}:${actorId}`;
}

function toSqlJson(value: unknown): postgres.JSONValue {
  return JSON.parse(JSON.stringify(value)) as postgres.JSONValue;
}
