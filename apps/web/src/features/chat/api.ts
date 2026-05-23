import { addAccessTokenSearchParam, authenticatedFetch } from "@/lib/auth";
import { callTool } from "@/lib/tool-call";

export interface ChatSearchHit {
  readonly roomId: string;
  readonly messageId: string;
  readonly actorId: string | null;
  readonly subject: string;
  readonly preview: string;
  readonly sentAt: string;
}

export interface ChatMessageRecord {
  readonly id: string;
  readonly orgId?: string;
  readonly roomId: string;
  readonly actorId: string | null;
  readonly body: string;
  readonly bodyFormat: string;
  readonly metadata?: Record<string, unknown>;
  readonly attachmentObjectIds: readonly string[];
  readonly sentAt: string;
  readonly editedAt: string | null;
  readonly deletedAt: string | null;
  readonly createdAt?: string;
  readonly updatedAt?: string;
}

export interface ChatRoomMemberRecord {
  readonly actorId: string;
  readonly role: string;
  readonly displayName: string | null;
  readonly email: string | null;
}

export interface ChatRoomRecord {
  readonly id: string;
  readonly orgId?: string;
  readonly kind: "chat_room" | "chat_dm";
  readonly subject: string | null;
  readonly createdByActorId: string | null;
  readonly metadata?: Record<string, unknown>;
  readonly members?: readonly ChatRoomMemberRecord[];
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
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ChatPresenceEntry {
  readonly actorId: string;
  readonly orgId: string;
  readonly displayName?: string;
  readonly email?: string;
  readonly status: "online";
  readonly seenAt: string;
}

export interface ChatReadReceiptRecord {
  readonly roomId: string;
  readonly actorId: string;
  readonly orgId: string;
  readonly lastReadMessageId: string | null;
  readonly lastReadAt: string;
  readonly updatedAt: string;
}

export interface ChatReactionRecord {
  readonly messageId: string;
  readonly actorId: string;
  readonly orgId?: string;
  readonly emoji: string;
  readonly createdAt: string;
}

export interface ChatSendInput {
  readonly roomId: string;
  readonly body: string;
  readonly bodyFormat?: "plain" | "markdown";
  readonly attachmentObjectIds?: readonly string[];
  readonly metadata?: Record<string, unknown>;
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
      readonly entry: ChatPresenceEntry;
      readonly roster?: readonly ChatPresenceEntry[];
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
      readonly actorId: string;
      readonly message: ChatMessageRecord;
    }
  | {
      readonly type: "read";
      readonly roomId: string;
      readonly actorId: string;
      readonly receipt: ChatReadReceiptRecord;
    }
  | { readonly type: "error"; readonly error: string };

export interface ChatRealtimeClient {
  subscribe(roomId: string): void;
  sendMessage(input: ChatSendInput): void;
  setTyping(roomId: string, isTyping: boolean): void;
  markRead(roomId: string, messageId?: string): void;
  requestPresence(roomId: string): void;
  isOpen(): boolean;
  close(): void;
}

interface ChatRealtimeClientOptions {
  readonly url?: string;
  readonly WebSocketImpl?: typeof WebSocket;
  readonly onEvent: (event: ChatRealtimeEvent) => void;
  readonly onOpen?: (() => void) | undefined;
  readonly onClose?: (() => void) | undefined;
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

export function chatRealtimeUrl(path = "/ws/chat"): string {
  if (typeof window === "undefined") {
    return path;
  }

  const url = new URL(path, window.location.href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return addAccessTokenSearchParam(url.toString());
}

export function createChatRealtimeClient(options: ChatRealtimeClientOptions): ChatRealtimeClient {
  const WebSocketImpl = options.WebSocketImpl ?? globalThis.WebSocket;
  const socket = new WebSocketImpl(options.url ?? chatRealtimeUrl());

  socket.addEventListener("open", () => options.onOpen?.());
  socket.addEventListener("close", () => options.onClose?.());
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
      }),
    setTyping: (roomId, isTyping) => send({ type: "typing", roomId, isTyping }),
    markRead: (roomId, messageId) => send({ type: "read", roomId, messageId }),
    requestPresence: (roomId) => send({ type: "presence", roomId }),
    isOpen: () => socket.readyState === WebSocketImpl.OPEN,
    close: () => socket.close(),
  };
}

async function callChatTool<Output>(
  toolId: string,
  input: unknown,
  fetchImpl: ChatApiFetch,
): Promise<Output> {
  // Routes through the shared callTool helper so confirmation-gated tools
  // (e.g. chat.message.delete) auto-approve their pending_confirmation
  // instead of silently no-op'ing.
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
