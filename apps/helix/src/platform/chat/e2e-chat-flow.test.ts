import { describe, expect, it } from "vitest";
import type {
  AICallContext,
  AICapability,
  Actor,
  ChatRequest,
  ChatResponse,
  EventBus,
  EventEnvelope,
  JsonValue,
  SuggestionSlotProviderCapability,
  TraceContext,
  Unsubscribe,
} from "@helix/sdk-types";
import { EnrichmentWorker } from "../ai/enrichment/index.js";
import { SearchEventIndexer } from "../search/event-indexer.js";
import type { IndexDocument, SearchEngine, SearchRequest, SearchResponse } from "../search/types.js";
import { createChatSuggestionSlotProviders, registerChatEnrichments, registerChatIndexer } from "./index.js";
import type {
  ChatEnrichmentProjectionStore,
  ChatEnrichmentRecord,
  ChatEnrichmentWrite,
  ChatParticipant,
  ChatPresenceStatus,
  ChatSearchProjectionStore,
  ChatSearchRecord,
} from "./types.js";

describe("chat AI/search flow", () => {
  it("covers room lifecycle, message semantics, search, and AI with fakes", async () => {
    const ada: Actor = {
      id: "actor-ada",
      orgId: "org-1",
      type: "user",
      displayName: "Ada",
      email: "ada@example.com",
    };
    const bruno: Actor = {
      id: "actor-bruno",
      orgId: "org-1",
      type: "user",
      displayName: "Bruno",
      email: "bruno@example.com",
    };
    const events = new FakeEventBus();
    const engine = new FakeSearchEngine();
    const chat = new FakeChatService(events);
    const ai = new FakeAI();
    const enrichmentResults: string[] = [];

    const indexer = new SearchEventIndexer({ events, engine });
    registerChatIndexer(indexer, chat);
    const enrichmentWorker = new EnrichmentWorker({
      events,
      subject: "activity.>",
      onResult: (result) => {
        enrichmentResults.push(`${result.feature}:${result.status}`);
      },
    });
    registerChatEnrichments(enrichmentWorker, {
      store: chat,
      ai,
      actionItems: true,
    });

    await indexer.start();
    await enrichmentWorker.start();

    const room = await chat.createRoom({ actor: ada, name: "Launch room" });
    const invitedRoom = await chat.invite({ actor: ada, roomId: room.id, invitee: bruno });
    await chat.setPresence(bruno, "available");
    await chat.setTyping({ actor: bruno, roomId: room.id, typing: true });
    const first = await chat.send({
      actor: bruno,
      roomId: room.id,
      body: "Can you cover launch follow-up by Friday?",
    });
    await chat.setTyping({ actor: bruno, roomId: room.id, typing: false });
    await chat.markRead({ actor: ada, roomId: room.id, messageId: first.id });
    const second = await chat.send({
      actor: ada,
      roomId: room.id,
      body: "I will draft launch notes and assign action items.",
    });
    await chat.react({ actor: ada, messageId: first.id, emoji: "+1" });
    const edited = await chat.edit({
      actor: bruno,
      messageId: first.id,
      body: "Can you cover revised rollout follow-up by Friday?",
    });

    const search = await engine.search({
      query: "revised rollout Friday",
      types: ["chat"],
      filter: 'attributes.roomId = "room-1"',
    });

    const providers = createChatSuggestionSlotProviders({ ai });
    const summarize = requiredProvider(providers, "chat.summarize-room");
    const suggestReply = requiredProvider(providers, "chat.suggest-reply");
    const summary = await collectSuggestion(
      summarize.generate({
        actor: ada,
        feature: "chat.summarize-room",
        resource: { type: "chat.room", id: room.id, orgId: "org-1" },
        input: {
          roomName: room.name,
          participants: ["Ada", "Bruno"],
          messages: chat.visibleMessages(room.id).map((message) => ({
            author: message.author.displayName ?? message.author.id,
            body: message.body,
            createdAt: message.createdAt,
          })),
        },
      }),
    );
    const reply = await collectSuggestion(
      suggestReply.generate({
        actor: ada,
        feature: "chat.suggest-reply",
        resource: { type: "chat.room", id: room.id, orgId: "org-1" },
        input: {
          roomName: room.name,
          lastMessage: edited.body,
          draft: "Confirm ownership",
        },
      }),
    );

    await chat.delete({ actor: ada, messageId: edited.id });
    const deletedSearch = await engine.search({
      query: "revised rollout Friday",
      types: ["chat"],
      filter: 'attributes.roomId = "room-1"',
    });

    await enrichmentWorker.stop();
    await indexer.stop();

    expect(invitedRoom.members).toEqual(["actor-ada", "actor-bruno"]);
    expect(second.roomId).toBe(room.id);
    expect(chat.isTyping(room.id, bruno.id)).toBe(false);
    expect(chat.readReceipt(room.id, ada.id)).toBe(first.id);
    expect(chat.presence(bruno.id)).toBe("available");
    expect(chat.getReactions(first.id).map((reaction) => reaction.emoji)).toEqual(["+1"]);
    expect(search.hits.map((hit) => hit.id)).toContain(`chat:${first.id}`);
    expect(search.hits.every((hit) => hit.type === "chat")).toBe(true);
    expect(deletedSearch.hits.map((hit) => hit.id)).not.toContain(`chat:${first.id}`);
    expect(summary).toContain("Summary:");
    expect(reply).toContain("Reply:");
    expect(ai.calls.map((call) => call.feature)).toEqual(
      expect.arrayContaining(["chat.action-items", "chat.summarize-room", "chat.suggest-reply"]),
    );
    expect(enrichmentResults).toContain("chat.action-items:applied");
    expect(chat.enrichments.some((entry) => entry.feature === "chat.action-items" && entry.messageId === second.id)).toBe(
      true,
    );
  });
});

interface ChatRoom {
  readonly id: string;
  readonly orgId: string;
  readonly name: string;
  readonly members: readonly string[];
}

interface CreateRoomInput {
  readonly actor: Actor;
  readonly name: string;
}

interface InviteInput {
  readonly actor: Actor;
  readonly roomId: string;
  readonly invitee: Actor;
}

interface SendInput {
  readonly actor: Actor;
  readonly roomId: string;
  readonly body: string;
}

interface ReactInput {
  readonly actor: Actor;
  readonly messageId: string;
  readonly emoji: string;
}

interface EditInput {
  readonly actor: Actor;
  readonly messageId: string;
  readonly body: string;
}

interface DeleteInput {
  readonly actor: Actor;
  readonly messageId: string;
}

interface TypingInput {
  readonly actor: Actor;
  readonly roomId: string;
  readonly typing: boolean;
}

interface ReadInput {
  readonly actor: Actor;
  readonly roomId: string;
  readonly messageId: string;
}

class FakeChatService implements ChatSearchProjectionStore, ChatEnrichmentProjectionStore {
  readonly enrichments: ChatEnrichmentWrite[] = [];
  readonly #rooms = new Map<string, ChatRoom>();
  readonly #messages = new Map<string, ChatSearchRecord>();
  readonly #presence = new Map<string, ChatPresenceStatus>();
  readonly #typing = new Set<string>();
  readonly #readReceipts = new Map<string, string>();
  #nextRoom = 1;
  #nextMessage = 1;

  constructor(private readonly events: EventBus) {}

  async createRoom(input: CreateRoomInput): Promise<ChatRoom> {
    const room: ChatRoom = {
      id: `room-${String(this.#nextRoom)}`,
      orgId: input.actor.orgId,
      name: input.name,
      members: [input.actor.id],
    };
    this.#nextRoom += 1;
    this.#rooms.set(room.id, room);
    await this.events.publish("activity.chat.room.created", { roomId: room.id, actorId: input.actor.id });
    return room;
  }

  async invite(input: InviteInput): Promise<ChatRoom> {
    this.requireMember(input.roomId, input.actor.id);
    const room = this.requireRoom(input.roomId);
    const members = [...new Set([...room.members, input.invitee.id])];
    const updated = { ...room, members };
    this.#rooms.set(room.id, updated);
    await this.events.publish("activity.chat.room.invited", {
      roomId: room.id,
      actorId: input.actor.id,
      inviteeId: input.invitee.id,
    });
    return updated;
  }

  async send(input: SendInput): Promise<ChatSearchRecord> {
    this.requireMember(input.roomId, input.actor.id);
    const room = this.requireRoom(input.roomId);
    const id = `message-${String(this.#nextMessage)}`;
    this.#nextMessage += 1;
    const message: ChatSearchRecord = {
      id,
      orgId: room.orgId,
      roomId: room.id,
      roomName: room.name,
      roomKind: "chat_room",
      body: input.body,
      author: actorParticipant(input.actor),
      reactions: [],
      classification: input.body.toLowerCase().includes("restricted") ? "restricted" : "standard",
      createdAt: "2026-05-20T00:00:00.000Z",
    };
    this.#messages.set(id, message);
    await this.events.publish("activity.chat.message.created", { roomId: room.id, messageId: id });
    return message;
  }

  async react(input: ReactInput): Promise<ChatSearchRecord> {
    const existing = this.requireMessage(input.messageId);
    this.requireMember(existing.roomId, input.actor.id);
    const reactions = [
      ...(existing.reactions ?? []),
      { emoji: input.emoji, actorId: input.actor.id, createdAt: "2026-05-20T00:00:01.000Z" },
    ];
    const updated = { ...existing, reactions, updatedAt: "2026-05-20T00:00:01.000Z" };
    this.#messages.set(input.messageId, updated);
    await this.events.publish("activity.chat.message.updated", { roomId: existing.roomId, messageId: input.messageId });
    return updated;
  }

  async edit(input: EditInput): Promise<ChatSearchRecord> {
    const existing = this.requireMessage(input.messageId);
    this.requireAuthor(existing, input.actor.id);
    const updated = {
      ...existing,
      body: input.body,
      editedAt: "2026-05-20T00:00:02.000Z",
      updatedAt: "2026-05-20T00:00:02.000Z",
    };
    this.#messages.set(input.messageId, updated);
    await this.events.publish("activity.chat.message.updated", { roomId: existing.roomId, messageId: input.messageId });
    return updated;
  }

  async delete(input: DeleteInput): Promise<void> {
    const existing = this.requireMessage(input.messageId);
    this.requireMember(existing.roomId, input.actor.id);
    this.#messages.set(input.messageId, {
      ...existing,
      deletedAt: "2026-05-20T00:00:03.000Z",
      updatedAt: "2026-05-20T00:00:03.000Z",
    });
    await this.events.publish("activity.chat.message.deleted", { roomId: existing.roomId, messageId: input.messageId });
  }

  async setTyping(input: TypingInput): Promise<void> {
    this.requireMember(input.roomId, input.actor.id);
    const key = roomActorKey(input.roomId, input.actor.id);
    if (input.typing) {
      this.#typing.add(key);
    } else {
      this.#typing.delete(key);
    }
    await this.events.publish(input.typing ? "activity.chat.typing.started" : "activity.chat.typing.stopped", {
      roomId: input.roomId,
      actorId: input.actor.id,
    });
  }

  async markRead(input: ReadInput): Promise<void> {
    this.requireMember(input.roomId, input.actor.id);
    this.#readReceipts.set(roomActorKey(input.roomId, input.actor.id), input.messageId);
    await this.events.publish("activity.chat.read.updated", {
      roomId: input.roomId,
      actorId: input.actor.id,
      messageId: input.messageId,
    });
  }

  async setPresence(actor: Actor, status: ChatPresenceStatus): Promise<void> {
    this.#presence.set(actor.id, status);
    await this.events.publish("activity.chat.presence.updated", { actorId: actor.id, status });
  }

  isTyping(roomId: string, actorId: string): boolean {
    return this.#typing.has(roomActorKey(roomId, actorId));
  }

  readReceipt(roomId: string, actorId: string): string | undefined {
    return this.#readReceipts.get(roomActorKey(roomId, actorId));
  }

  presence(actorId: string): ChatPresenceStatus | undefined {
    return this.#presence.get(actorId);
  }

  getReactions(messageId: string): readonly { readonly emoji: string }[] {
    return this.#messages.get(messageId)?.reactions ?? [];
  }

  visibleMessages(roomId: string): readonly ChatSearchRecord[] {
    return [...this.#messages.values()].filter((message) => message.roomId === roomId && message.deletedAt === undefined);
  }

  async getChatSearchRecord(messageId: string): Promise<ChatSearchRecord | null> {
    return this.#messages.get(messageId) ?? null;
  }

  async getChatEnrichmentRecord(messageId: string): Promise<ChatEnrichmentRecord | null> {
    return this.#messages.get(messageId) ?? null;
  }

  async recordChatEnrichment(input: ChatEnrichmentWrite): Promise<void> {
    this.enrichments.push(input);
  }

  private requireRoom(roomId: string): ChatRoom {
    const room = this.#rooms.get(roomId);
    if (room === undefined) {
      throw new Error(`unknown room ${roomId}`);
    }
    return room;
  }

  private requireMessage(messageId: string): ChatSearchRecord {
    const message = this.#messages.get(messageId);
    if (message === undefined) {
      throw new Error(`unknown message ${messageId}`);
    }
    return message;
  }

  private requireMember(roomId: string, actorId: string): void {
    const room = this.requireRoom(roomId);
    if (!room.members.includes(actorId)) {
      throw new Error(`actor ${actorId} is not a member of ${roomId}`);
    }
  }

  private requireAuthor(message: ChatSearchRecord, actorId: string): void {
    if (message.author.id !== actorId) {
      throw new Error(`actor ${actorId} cannot edit ${message.id}`);
    }
  }
}

function actorParticipant(actor: Actor): ChatParticipant {
  return {
    id: actor.id,
    ...(actor.displayName === undefined ? {} : { displayName: actor.displayName }),
    ...(actor.email === undefined ? {} : { email: actor.email }),
  };
}

function roomActorKey(roomId: string, actorId: string): string {
  return `${roomId}:${actorId}`;
}

async function collectSuggestion(chunks: AsyncIterable<{ readonly text: string }>): Promise<string> {
  const text: string[] = [];
  for await (const chunk of chunks) {
    text.push(chunk.text);
  }
  return text.join("");
}

function requiredProvider(
  providers: readonly SuggestionSlotProviderCapability[],
  slotId: string,
): SuggestionSlotProviderCapability {
  const provider = providers.find((candidate) => candidate.slotId === slotId);
  if (provider === undefined) {
    throw new Error(`${slotId} provider missing`);
  }
  return provider;
}

class FakeSearchEngine implements SearchEngine {
  readonly id = "fake-search";
  readonly docs = new Map<string, IndexDocument>();

  async index(document: IndexDocument): Promise<void> {
    this.docs.set(document.id, document);
  }

  async upsert(documents: readonly IndexDocument[]): Promise<void> {
    for (const document of documents) {
      this.docs.set(document.id, document);
    }
  }

  async delete(ids: readonly string[]): Promise<void> {
    for (const id of ids) {
      this.docs.delete(id);
    }
  }

  async search(request: SearchRequest): Promise<SearchResponse> {
    const terms = request.query.toLowerCase().split(/\s+/u).filter(Boolean);
    const hits = [...this.docs.values()].filter((document) => {
      const haystack = `${document.title ?? ""}\n${document.body ?? ""}`.toLowerCase();
      const matchesQuery = terms.every((term) => haystack.includes(term));
      const matchesType = request.types === undefined || request.types.includes(document.type);
      const matchesFilter = matchesRoomFilter(document, request.filter);
      return matchesQuery && matchesType && matchesFilter;
    });
    return { hits, query: request.query, estimatedTotalHits: hits.length };
  }
}

class FakeAI implements AICapability {
  readonly calls: ChatRequest[] = [];

  async chat(request: ChatRequest, _ctx?: Partial<AICallContext>): Promise<ChatResponse> {
    void _ctx;
    this.calls.push(request);
    if (request.feature === "chat.action-items") {
      return {
        message: JSON.stringify({ actionItems: ["cover rollout follow-up"], owners: ["Bruno"], dueDates: ["Friday"] }),
        model: "fake-model",
        providerId: "fake-ai",
      };
    }
    if (request.feature === "chat.summarize-room") {
      return {
        message: "Summary: Launch follow-up is assigned, with rollout coverage due Friday.",
        model: "fake-model",
        providerId: "fake-ai",
      };
    }
    return {
      message: "Reply: I can cover the rollout follow-up by Friday.",
      model: "fake-model",
      providerId: "fake-ai",
    };
  }
}

class FakeEventBus implements EventBus {
  readonly subscriptions: string[] = [];
  readonly #subscribers: {
    readonly subject: string;
    readonly handler: (event: EventEnvelope) => Promise<void>;
  }[] = [];

  async publish(subject: string, payload: JsonValue, trace?: TraceContext): Promise<void> {
    const event: EventEnvelope = {
      subject,
      payload,
      occurredAt: "2026-05-20T00:00:00.000Z",
      ...(trace === undefined ? {} : { trace }),
    };
    for (const subscriber of this.#subscribers) {
      if (subjectMatches(subscriber.subject, subject)) {
        await subscriber.handler(event);
      }
    }
  }

  async subscribe<Payload extends JsonValue>(
    subject: string,
    handler: (event: EventEnvelope<Payload>) => Promise<void>,
  ): Promise<Unsubscribe> {
    this.subscriptions.push(subject);
    const subscriber = {
      subject,
      handler: handler as (event: EventEnvelope) => Promise<void>,
    };
    this.#subscribers.push(subscriber);
    return () => {
      const index = this.#subscribers.indexOf(subscriber);
      if (index >= 0) {
        this.#subscribers.splice(index, 1);
      }
    };
  }
}

function matchesRoomFilter(document: IndexDocument, filter: SearchRequest["filter"]): boolean {
  const filters = typeof filter === "string" ? [filter] : (filter ?? []);
  const roomId = document.attributes?.roomId;
  return filters.every((candidate) => {
    const match = /attributes\.roomId\s*=\s*"([^"]+)"/u.exec(candidate);
    return match === null ? true : roomId === match[1];
  });
}

function subjectMatches(pattern: string, subject: string): boolean {
  const patternParts = pattern.split(".");
  const subjectParts = subject.split(".");

  for (let index = 0; index < patternParts.length; index += 1) {
    const patternPart = patternParts[index];
    if (patternPart === ">") {
      return index === patternParts.length - 1;
    }
    if (subjectParts[index] === undefined) {
      return false;
    }
    if (patternPart !== "*" && patternPart !== subjectParts[index]) {
      return false;
    }
  }

  return patternParts.length === subjectParts.length;
}
