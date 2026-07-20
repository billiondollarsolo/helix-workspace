import type {
  ChatCreateRoomInput,
  ChatInviteInput,
  ChatMessage,
  ChatPresenceStatus,
  ChatReadReceipt,
  ChatRoom,
  ChatSearchHit,
} from "@helix/contracts";
import { authenticatedFetch, getStoredAccessToken } from "@/lib/auth";
import { callTool } from "@/lib/tool-call";

/** @deprecated Prefer ChatSearchHit from @helix/contracts */
export type { ChatSearchHit };

export type ChatMessageRecord = ChatMessage & {
  readonly attachmentObjectIds: readonly string[];
};

export type ChatRoomMemberRecord = {
  readonly actorId: string;
  readonly role: string;
  readonly displayName: string | null;
  readonly email: string | null;
};

export type ChatRoomRecord = ChatRoom & {
  readonly settings: {
    readonly threadId: string;
    readonly orgId?: string;
    readonly name: string | null;
    readonly topic: string | null;
    readonly isPrivate: boolean;
    readonly metadata?: Record<string, unknown>;
    readonly createdAt?: string;
    readonly updatedAt?: string;
  } | null;
};

export interface ChatPresenceEntry {
  readonly actorId: string;
  readonly orgId: string;
  readonly displayName?: string;
  readonly email?: string;
  readonly status: ChatPresenceStatus | "online";
  readonly seenAt: string;
}

export type ChatReadReceiptRecord = ChatReadReceipt;

export interface ChatReactionRecord {
  readonly messageId: string;
  readonly actorId: string;
  readonly orgId?: string;
  readonly emoji: string;
  readonly createdAt: string;
}

export interface ChatPinRecord {
  readonly roomId: string;
  readonly messageId: string;
  readonly orgId: string;
  readonly pinnedByActorId: string | null;
  readonly createdAt: string;
}

export interface ChatSendInput {
  readonly roomId: string;
  readonly body: string;
  readonly bodyFormat?: "plain" | "markdown";
  readonly attachmentObjectIds?: readonly string[];
  readonly metadata?: Record<string, unknown>;
  readonly clientMessageId?: string;
  readonly parentMessageId?: string;
}

export interface ChatReactInput {
  readonly messageId: string;
  readonly emoji: string;
  readonly op?: "add" | "remove";
}

export interface ChatEditInput {
  readonly messageId: string;
  readonly body: string;
}

export type ChatApiFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export type ChatRealtimeEvent =
  | { readonly type: "ready"; readonly actorId: string }
  | {
      readonly type: "subscribed";
      readonly roomId: string;
      readonly presence: readonly ChatPresenceEntry[];
      readonly receipts?: readonly ChatReadReceiptRecord[];
    }
  | {
      readonly type: "presence.joined";
      readonly roomId: string;
      readonly actorId: string;
      readonly entry?: ChatPresenceEntry;
      readonly roster?: readonly ChatPresenceEntry[];
      readonly status?: ChatPresenceStatus;
    }
  | { readonly type: "presence.left"; readonly roomId: string; readonly actorId: string }
  | {
      readonly type: "presence";
      readonly roomId: string;
      readonly presence: readonly ChatPresenceEntry[];
    }
  | {
      readonly type: "typing";
      readonly roomId: string;
      readonly actorId: string;
      readonly isTyping: boolean;
    }
  | {
      readonly type: "message.created";
      readonly roomId: string;
      readonly actorId?: string;
      readonly message: ChatMessageRecord;
    }
  | {
      readonly type: "read";
      readonly roomId: string;
      readonly actorId: string;
      readonly messageId?: string;
      readonly receipt: ChatReadReceiptRecord;
    }
  | { readonly type: "reconnect"; readonly reason: string }
  | { readonly type: "error"; readonly code?: string; readonly message?: string; readonly error?: string };

export interface ChatRealtimeClient {
  subscribe(roomId: string): void;
  sendMessage(input: ChatSendInput): void;
  setTyping(roomId: string, isTyping: boolean): void;
  markRead(roomId: string, messageId?: string): void;
  requestPresence(roomId: string): void;
  setPresence(status: ChatPresenceStatus): void;
  isOpen(): boolean;
  close(): void;
}

interface ChatRealtimeClientOptions {
  readonly url?: string;
  readonly WebSocketImpl?: typeof WebSocket;
  readonly protocols?: string | string[];
  readonly onEvent: (event: ChatRealtimeEvent) => void;
  readonly onOpen?: (() => void) | undefined;
  readonly onClose?: ((event?: CloseEvent) => void) | undefined;
  readonly onError?: ((error: Event) => void) | undefined;
}

export async function searchChat(
  input: {
    readonly query?: string;
    readonly roomId?: string;
    readonly limit?: number;
  },
  fetchImpl: ChatApiFetch = authenticatedFetch,
): Promise<readonly ChatSearchHit[]> {
  const output = await callChatTool<{ readonly hits?: readonly ChatSearchHit[] }>(
    "chat.search",
    {
      query: input.query,
      roomId: input.roomId,
      limit: input.limit ?? 50,
    },
    fetchImpl,
  );

  return output.hits ?? [];
}

export async function listChatRooms(
  input: {
    readonly query?: string;
    readonly limit?: number;
  } = {},
  fetchImpl: ChatApiFetch = authenticatedFetch,
): Promise<readonly ChatRoomRecord[]> {
  const output = await callChatTool<{ readonly rooms?: readonly ChatRoomRecord[] }>(
    "chat.room.list",
    {
      query: input.query,
      limit: input.limit ?? 50,
    },
    fetchImpl,
  );

  return output.rooms ?? [];
}

export async function listChatMessages(
  input: {
    readonly roomId: string;
    readonly before?: string;
    readonly limit?: number;
  },
  fetchImpl: ChatApiFetch = authenticatedFetch,
): Promise<readonly ChatMessageRecord[]> {
  const output = await callChatTool<{ readonly messages?: readonly ChatMessageRecord[] }>(
    "chat.message.list",
    {
      roomId: input.roomId,
      before: input.before,
      limit: input.limit ?? 50,
    },
    fetchImpl,
  );

  return output.messages ?? [];
}

/** Caller-facing create input — defaults applied by the server schema. */
export type CreateChatRoomRequest = {
  readonly subject?: string;
  readonly kind?: "chat_room" | "chat_dm";
  readonly memberActorIds?: readonly string[];
  readonly topic?: string;
  readonly isPrivate?: boolean;
  readonly metadata?: Record<string, unknown>;
};

export type InviteToRoomRequest = {
  readonly roomId: string;
  readonly actorIds: readonly string[];
  readonly role?: string;
};

export async function createChatRoom(
  input: CreateChatRoomRequest,
  fetchImpl: ChatApiFetch = authenticatedFetch,
): Promise<ChatRoomRecord> {
  const payload: ChatCreateRoomInput = {
    kind: input.kind ?? "chat_room",
    memberActorIds: [...(input.memberActorIds ?? [])],
    isPrivate: input.isPrivate ?? false,
    metadata: input.metadata ?? {},
    ...(input.subject === undefined ? {} : { subject: input.subject }),
    ...(input.topic === undefined ? {} : { topic: input.topic }),
  };
  return callChatTool<ChatRoomRecord>("chat.create_room", payload, fetchImpl);
}

export async function inviteToRoom(
  input: InviteToRoomRequest,
  fetchImpl: ChatApiFetch = authenticatedFetch,
): Promise<{ readonly roomId: string; readonly invitedActorIds: readonly string[] }> {
  const payload: ChatInviteInput = {
    roomId: input.roomId,
    actorIds: [...input.actorIds],
    role: input.role ?? "member",
  };
  return callChatTool("chat.invite", payload, fetchImpl);
}

export async function listThreadReplies(
  input: {
    readonly roomId: string;
    readonly parentMessageId: string;
    readonly before?: string;
    readonly limit?: number;
  },
  fetchImpl: ChatApiFetch = authenticatedFetch,
): Promise<readonly ChatMessageRecord[]> {
  const output = await callChatTool<{ readonly messages?: readonly ChatMessageRecord[] }>(
    "chat.thread.list",
    input,
    fetchImpl,
  );
  return output.messages ?? [];
}

export async function replyInThread(
  input: {
    readonly roomId: string;
    readonly parentMessageId: string;
    readonly body: string;
    readonly bodyFormat?: "plain" | "markdown";
    readonly clientMessageId?: string;
  },
  fetchImpl: ChatApiFetch = authenticatedFetch,
): Promise<ChatMessageRecord> {
  return callChatTool("chat.reply_in_thread", input, fetchImpl);
}

export async function pinChatMessage(
  input: { readonly roomId: string; readonly messageId: string },
  fetchImpl: ChatApiFetch = authenticatedFetch,
): Promise<ChatPinRecord> {
  return callChatTool("chat.pin", input, fetchImpl);
}

export async function unpinChatMessage(
  input: { readonly roomId: string; readonly messageId: string },
  fetchImpl: ChatApiFetch = authenticatedFetch,
): Promise<{ readonly ok: true }> {
  return callChatTool("chat.unpin", input, fetchImpl);
}

export async function listChatPins(
  input: { readonly roomId: string },
  fetchImpl: ChatApiFetch = authenticatedFetch,
): Promise<readonly ChatPinRecord[]> {
  const output = await callChatTool<{ readonly pins?: readonly ChatPinRecord[] }>(
    "chat.pins.list",
    input,
    fetchImpl,
  );
  return output.pins ?? [];
}

export async function sendChatMessage(
  input: ChatSendInput,
  fetchImpl: ChatApiFetch = authenticatedFetch,
): Promise<ChatMessageRecord> {
  return callChatTool<ChatMessageRecord>(
    "chat.send",
    {
      roomId: input.roomId,
      body: input.body,
      bodyFormat: input.bodyFormat ?? "plain",
      attachmentObjectIds: input.attachmentObjectIds ?? [],
      metadata: input.metadata ?? {},
      ...(input.clientMessageId === undefined
        ? {}
        : { clientMessageId: input.clientMessageId }),
      ...(input.parentMessageId === undefined
        ? {}
        : { parentMessageId: input.parentMessageId }),
    },
    fetchImpl,
  );
}

export async function reactToChatMessage(
  input: ChatReactInput,
  fetchImpl: ChatApiFetch = authenticatedFetch,
): Promise<ChatReactionRecord | null> {
  const output = await callChatTool<{ readonly reaction?: ChatReactionRecord | null }>(
    "chat.react",
    {
      messageId: input.messageId,
      emoji: input.emoji,
      op: input.op ?? "add",
    },
    fetchImpl,
  );
  return output.reaction ?? null;
}

export async function editChatMessage(
  input: ChatEditInput,
  fetchImpl: ChatApiFetch = authenticatedFetch,
): Promise<ChatMessageRecord> {
  return callChatTool<ChatMessageRecord>("chat.edit", input, fetchImpl);
}

export async function deleteChatMessage(
  messageId: string,
  fetchImpl: ChatApiFetch = authenticatedFetch,
): Promise<ChatMessageRecord> {
  return callChatTool<ChatMessageRecord>("chat.delete", { messageId }, fetchImpl);
}

/** Chat WS URL without embedding the access token in the query string (G6). */
export function chatRealtimeUrl(path = "/ws/chat"): string {
  if (typeof window === "undefined") {
    return path;
  }

  const url = new URL(path, window.location.href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

/** Subprotocol list: `helix-bearer` + token when a stored bearer exists. */
export function chatRealtimeProtocols(): string[] | undefined {
  const token = getStoredAccessToken();
  if (token === null) {
    return undefined;
  }
  return ["helix-bearer", token];
}

export function createChatRealtimeClient(options: ChatRealtimeClientOptions): ChatRealtimeClient {
  const WebSocketImpl = options.WebSocketImpl ?? globalThis.WebSocket;
  const protocols =
    options.protocols ?? chatRealtimeProtocols();
  const socket =
    protocols === undefined
      ? new WebSocketImpl(options.url ?? chatRealtimeUrl())
      : new WebSocketImpl(options.url ?? chatRealtimeUrl(), protocols);

  socket.addEventListener("open", () => options.onOpen?.());
  socket.addEventListener("close", (event) => options.onClose?.(event));
  socket.addEventListener("error", (event) => options.onError?.(event));
  socket.addEventListener("message", (event) => {
    const parsed = parseChatRealtimeEvent(event.data);
    if (parsed !== null) {
      options.onEvent(parsed);
    }
  });

  const send = (payload: Record<string, unknown>) => {
    socket.send(JSON.stringify(payload));
  };

  return {
    subscribe: (roomId) => send({ type: "subscribe", roomId }),
    sendMessage: (input) =>
      send({
        type: "send",
        roomId: input.roomId,
        body: input.body,
        bodyFormat: input.bodyFormat ?? "plain",
        attachmentObjectIds: input.attachmentObjectIds ?? [],
        ...(input.clientMessageId === undefined
          ? {}
          : { clientMessageId: input.clientMessageId }),
        ...(input.parentMessageId === undefined
          ? {}
          : { parentMessageId: input.parentMessageId }),
      }),
    setTyping: (roomId, isTyping) => send({ type: "typing", roomId, isTyping }),
    markRead: (roomId, messageId) => send({ type: "read", roomId, messageId }),
    requestPresence: (roomId) => send({ type: "presence", roomId }),
    setPresence: (status) => send({ type: "presence.set", status }),
    isOpen: () => socket.readyState === WebSocketImpl.OPEN,
    close: () => socket.close(),
  };
}

async function callChatTool<Output>(
  toolId: string,
  input: unknown,
  fetchImpl: ChatApiFetch,
): Promise<Output> {
  return callTool<Output>(toolId, input, { fetchImpl });
}

function parseChatRealtimeEvent(data: unknown): ChatRealtimeEvent | null {
  if (typeof data !== "string") {
    return null;
  }

  try {
    const parsed = JSON.parse(data) as unknown;
    return isRecord(parsed) && typeof parsed.type === "string"
      ? (parsed as ChatRealtimeEvent)
      : null;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
