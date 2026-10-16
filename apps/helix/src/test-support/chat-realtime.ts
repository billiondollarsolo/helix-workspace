import type { Actor } from "@helix/sdk-types";
import type { FastifyRequest } from "fastify";
import { type InMemoryChatPresenceStore, InMemoryChatRoomBus } from "../platform/chat/realtime.js";
import type { ChatStore } from "../platform/chat/store.js";
import type {
  ChatMessageRecord,
  ChatPinRecord,
  ChatReactionMutationRecord,
  ChatReadReceiptRecord,
  ChatRoomRecord,
  ChatSearchHit,
} from "../platform/chat/types.js";
import {
  CHAT_WEBSOCKET_AUDIENCE,
  CHAT_WEBSOCKET_PATH,
  type ChatWebSocketTicketStore,
} from "../platform/chat/websocket-tickets.js";
const now = new Date("2026-05-20T12:00:00.000Z");
export const actor: Actor = {
  id: "11111111-1111-4111-8111-111111111111",
  orgId: "22222222-2222-4222-8222-222222222222",
  type: "user",
  scopes: ["chat.read", "chat.post"],
  displayName: "Ada",
};
export const otherActor: Actor = {
  id: "55555555-5555-4555-8555-555555555555",
  orgId: actor.orgId,
  type: "user",
  scopes: ["chat.read", "chat.post"],
  displayName: "Grace",
};
export const roomId = "33333333-3333-4333-8333-333333333333";
export const messageId = "44444444-4444-4444-8444-444444444444";
export const trustedOrigins = ["https://app.helix.test"];
export const emptyWebSocketRequest = ticketRequest("t");

export function ticketRequest(character: string): FastifyRequest {
  return {
    tenant: { orgId: actor.orgId },
    headers: {
      origin: trustedOrigins[0],
      "sec-websocket-protocol": `helix.chat.v1, helix.ticket.${character.repeat(43)}`,
    },
  } as unknown as FastifyRequest;
}

export class FakeSocket {
  bufferedAmount = 0;
  readonly messages: Record<string, unknown>[] = [];
  closed: { readonly code?: number; readonly reason?: string } | null = null;
  #messageHandlers: ((data: string) => void)[] = [];
  #closeHandlers: (() => void)[] = [];
  #errorHandlers: ((error: Error) => void)[] = [];

  send(data: string): void {
    this.messages.push(JSON.parse(data) as Record<string, unknown>);
  }

  close(code?: number, reason?: string): void {
    this.closed = {
      ...(code === undefined ? {} : { code }),
      ...(reason === undefined ? {} : { reason }),
    };
    for (const handler of this.#closeHandlers) {
      handler();
    }
  }

  on(event: "message", handler: (data: string) => void): void;
  on(event: "close", handler: () => void): void;
  on(event: "error", handler: (error: Error) => void): void;
  on(
    event: "message" | "close" | "error",
    handler: ((data: string) => void) | (() => void) | ((error: Error) => void),
  ): void {
    if (event === "message") {
      this.#messageHandlers.push(handler as (data: string) => void);
      return;
    }
    if (event === "close") {
      this.#closeHandlers.push(handler as () => void);
      return;
    }
    this.#errorHandlers.push(handler as (error: Error) => void);
  }

  receive(payload: unknown): void {
    for (const handler of this.#messageHandlers) {
      handler(JSON.stringify(payload));
    }
  }
}

export class FakeTicketStore implements ChatWebSocketTicketStore {
  readonly #consumed = new Set<string>();
  readonly issuedRooms: string[] = [];

  constructor(
    private readonly actor: Actor | null,
    private readonly boundRoomId: string = roomId,
  ) {}

  async issue(
    input: Parameters<ChatWebSocketTicketStore["issue"]>[0],
  ): Promise<{ readonly ticket: string; readonly expiresAt: Date }> {
    this.issuedRooms.push(input.roomId);
    return { ticket: "t".repeat(43), expiresAt: new Date(now.getTime() + 30_000) };
  }

  async consume(
    input: Parameters<ChatWebSocketTicketStore["consume"]>[0],
  ): Promise<{ readonly actor: Actor; readonly roomId: string } | null> {
    if (
      this.actor === null ||
      input.audience !== CHAT_WEBSOCKET_AUDIENCE ||
      input.path !== CHAT_WEBSOCKET_PATH ||
      this.#consumed.has(input.ticket)
    ) {
      return null;
    }
    this.#consumed.add(input.ticket);
    return { actor: this.actor, roomId: this.boundRoomId };
  }
}

export class FakeChatStore implements ChatStore {
  readonly sentBodies: string[] = [];
  readonly readMessageIds: string[] = [];
  readonly getRoomForActorCalls: {
    readonly orgId: string;
    readonly actorId: string;
    readonly roomId: string;
  }[] = [];
  readonly #inaccessibleRoomIds: Set<string>;
  readonly #shareReadReceipts: boolean;

  constructor(
    options: {
      readonly inaccessibleRoomIds?: readonly string[];
      readonly shareReadReceipts?: boolean;
    } = {},
  ) {
    this.#inaccessibleRoomIds = new Set(options.inaccessibleRoomIds ?? []);
    this.#shareReadReceipts = options.shareReadReceipts ?? true;
  }

  denyRoom(deniedRoomId: string): void {
    this.#inaccessibleRoomIds.add(deniedRoomId);
  }

  async createRoom(): Promise<ChatRoomRecord> {
    return roomRecord();
  }

  async invite(
    input: Parameters<ChatStore["invite"]>[0],
  ): Promise<{ readonly roomId: string; readonly invitedActorIds: readonly string[] }> {
    return { roomId: input.roomId, invitedActorIds: input.actorIds };
  }

  async listRooms(): Promise<readonly ChatRoomRecord[]> {
    return [roomRecord()];
  }

  async discoverRooms(): Promise<readonly ChatRoomRecord[]> {
    return this.listRooms();
  }

  async joinRoom(): Promise<ChatRoomRecord> {
    return roomRecord();
  }

  async sendMessage(input: Parameters<ChatStore["sendMessage"]>[0]): Promise<ChatMessageRecord> {
    this.sentBodies.push(input.body);
    return messageRecord(input.body);
  }

  async react(): Promise<ChatReactionMutationRecord> {
    return { reaction: null, message: messageRecord("reaction") };
  }

  async editMessage(
    input: Parameters<ChatStore["editMessage"]>[0],
  ): Promise<ChatMessageRecord | null> {
    return messageRecord(input.body);
  }

  async deleteMessage(): Promise<ChatMessageRecord | null> {
    return messageRecord("deleted");
  }

  async markRead(input: Parameters<ChatStore["markRead"]>[0]): Promise<ChatReadReceiptRecord> {
    this.readMessageIds.push(input.messageId);
    const receipt: ChatReadReceiptRecord = {
      roomId: input.roomId,
      actorId: input.actorId,
      orgId: input.orgId,
      lastReadMessageId: input.messageId,
      lastReadAt: now,
      updatedAt: now,
      isShared: this.#shareReadReceipts,
    };
    this.readReceipts.set(input.actorId, receipt);
    return receipt;
  }

  readonly readReceipts = new Map<string, ChatReadReceiptRecord>();

  async listReadReceipts(
    input: Parameters<NonNullable<ChatStore["listReadReceipts"]>>[0],
  ): Promise<readonly ChatReadReceiptRecord[]> {
    return [...this.readReceipts.values()].filter(
      (receipt) =>
        receipt.roomId === input.roomId &&
        (this.#shareReadReceipts || receipt.actorId === input.actorId),
    );
  }

  async listMessages(): Promise<readonly ChatMessageRecord[]> {
    return [messageRecord("hello")];
  }

  async search(): Promise<readonly ChatSearchHit[]> {
    return [];
  }

  async getRoomForActor(
    input: Parameters<ChatStore["getRoomForActor"]>[0],
  ): Promise<ChatRoomRecord | null> {
    this.getRoomForActorCalls.push(input);
    if (this.#inaccessibleRoomIds.has(input.roomId)) {
      return null;
    }
    return roomRecord();
  }

  async listThreadReplies(): Promise<readonly ChatMessageRecord[]> {
    return [];
  }

  async pinMessage(input: {
    readonly roomId: string;
    readonly messageId: string;
    readonly orgId: string;
    readonly actorId: string;
  }): Promise<ChatPinRecord> {
    return {
      roomId: input.roomId,
      messageId: input.messageId,
      orgId: input.orgId,
      pinnedByActorId: input.actorId,
      createdAt: now,
    };
  }

  async unpinMessage(): Promise<{ readonly ok: true }> {
    return { ok: true };
  }

  async listPins(): Promise<readonly ChatPinRecord[]> {
    return [];
  }
}

export class BlockingChatStore extends FakeChatStore {
  readonly startedBodies: string[] = [];
  maxInFlight = 0;
  #inFlight = 0;
  readonly #releases: (() => void)[] = [];

  override async sendMessage(
    input: Parameters<ChatStore["sendMessage"]>[0],
  ): Promise<ChatMessageRecord> {
    this.startedBodies.push(input.body);
    this.#inFlight += 1;
    this.maxInFlight = Math.max(this.maxInFlight, this.#inFlight);
    await new Promise<void>((resolve) => {
      this.#releases.push(resolve);
    });
    this.#inFlight -= 1;
    this.sentBodies.push(input.body);
    return messageRecord(input.body);
  }

  releaseNext(): void {
    this.#releases.shift()?.();
  }
}

export class PresencePrivacyChatStore extends FakeChatStore {
  constructor(private readonly hiddenActorId: string) {
    super();
  }

  async listPresenceBlockedActorIds(): Promise<readonly string[]> {
    return [this.hiddenActorId];
  }
}

export class PresenceRecordingRoomBus extends InMemoryChatRoomBus {
  readonly readRostersAtPublish: { readonly actorId: string }[][] = [];

  constructor(private readonly presence: InMemoryChatPresenceStore) {
    super();
  }

  override async publish(
    orgId: string,
    roomId: string,
    event: Parameters<InMemoryChatRoomBus["publish"]>[2],
  ): Promise<void> {
    if (event.type === "read") {
      this.readRostersAtPublish.push([...(await this.presence.list(roomId))]);
    }
    await super.publish(orgId, roomId, event);
  }
}

function roomRecord(): ChatRoomRecord {
  return {
    id: roomId,
    orgId: actor.orgId,
    kind: "chat_room",
    subject: "General",
    createdByActorId: actor.id,
    metadata: {},
    members: [
      { actorId: actor.id, role: "owner", displayName: "Maya Chen", email: "maya@example.com" },
    ],
    settings: null,
    createdAt: now,
    updatedAt: now,
  };
}

function messageRecord(body: string): ChatMessageRecord {
  return {
    id: messageId,
    orgId: actor.orgId,
    roomId,
    actorId: actor.id,
    body,
    bodyFormat: "plain",
    metadata: {},
    attachmentObjectIds: [],
    sentAt: now,
    editedAt: null,
    deletedAt: null,
    createdAt: now,
    updatedAt: now,
  };
}
