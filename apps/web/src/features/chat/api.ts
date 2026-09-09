import type {
  ChatCreateRoomInput,
  ChatAttachment,
  ChatInviteInput,
  ChatMessage,
  ChatPresenceStatus,
  ChatReadReceipt,
  ChatRoom,
  ChatSearchHit,
} from "@helix/contracts";
import { authenticatedFetch } from "@/lib/auth";
import { callTool } from "@/lib/tool-call";

export type ChatMessageRecord = { readonly renderedBodyHtml?: string } & Omit<
  ChatMessage,
  "revision" | "reactions" | "replyCount" | "pin" | "attachmentObjectIds" | "attachments"
> &
  Partial<Pick<ChatMessage, "revision" | "reactions" | "replyCount" | "pin">> & {
    readonly attachmentObjectIds: readonly string[];
    readonly attachments?: readonly ChatAttachmentRecord[];
  };

export type ChatAttachmentRecord = ChatAttachment;

export type ChatRoomMemberRecord = {
  readonly actorId: string;
  readonly role: "owner" | "moderator" | "member";
  readonly displayName: string | null;
  readonly email: string | null;
};

export type ChatRoomRecord = ChatRoom & {
  readonly settings: {
    readonly threadId: string;
    readonly orgId?: string;
    readonly name: string | null;
    readonly topic: string | null;
    readonly privacy: "discoverable" | "restricted" | "private";
    readonly readReceiptsEnabled: boolean;
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
  readonly status: ChatPresenceStatus;
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
      readonly cursor: number;
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
      readonly cursor: number;
      readonly actorId?: string;
      readonly message: ChatMessageRecord;
    }
  | {
      readonly type: "message.updated";
      readonly roomId: string;
      readonly cursor: number;
      readonly message: ChatMessageRecord;
    }
  | {
      readonly type: "message.deleted";
      readonly roomId: string;
      readonly cursor: number;
      readonly messageId: string;
      readonly revision: number;
      readonly deletedAt: string;
    }
  | {
      readonly type: "read";
      readonly roomId: string;
      readonly actorId: string;
      readonly messageId: string;
      readonly cursor: number;
      readonly receipt: ChatReadReceiptRecord;
    }
  | {
      readonly type: "access.changed";
      readonly roomId: string;
      readonly actorId: string;
      readonly aclVersion: number;
      readonly cursor: number;
    }
  | { readonly type: "resync.required"; readonly roomId: string; readonly cursor: number }
  | { readonly type: "reconnect"; readonly reason: string }
  | {
      readonly type: "error";
      readonly code?: string;
      readonly message?: string;
      readonly error?: string;
    };

export interface ChatRealtimeClient {
  subscribe(roomId: string, cursor?: number): void;
  sendMessage(input: ChatSendInput): void;
  setTyping(roomId: string, isTyping: boolean): void;
  markRead(roomId: string, messageId: string): void;
  requestPresence(roomId: string): void;
  setPresence(status: ChatPresenceStatus): void;
  isOpen(): boolean;
  close(): void;
}

interface ChatRealtimeClientOptions {
  readonly ticket: string;
  readonly url?: string;
  readonly WebSocketImpl?: typeof WebSocket;
  readonly onEvent: (event: ChatRealtimeEvent) => void;
  readonly onOpen?: (() => void) | undefined;
  readonly onClose?: ((event?: CloseEvent) => void) | undefined;
  readonly onError?: ((error: Event) => void) | undefined;
}

const CHAT_REALTIME_PROTOCOL = "helix.chat.v1";
const CHAT_TICKET_PROTOCOL_PREFIX = "helix.ticket.";

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

export async function discoverChatRooms(
  input: { readonly query?: string; readonly limit?: number } = {},
  fetchImpl: ChatApiFetch = authenticatedFetch,
): Promise<readonly ChatRoomRecord[]> {
  const output = await callChatTool<{ readonly rooms?: readonly ChatRoomRecord[] }>(
    "chat.room.discover",
    { query: input.query, limit: input.limit ?? 50 },
    fetchImpl,
  );
  return output.rooms ?? [];
}

export function joinChatRoom(
  roomId: string,
  fetchImpl: ChatApiFetch = authenticatedFetch,
): Promise<ChatRoomRecord> {
  return callChatTool<ChatRoomRecord>("chat.room.join", { roomId }, fetchImpl);
}

export async function listChatMessages(
  input: {
    readonly roomId: string;
    readonly before?: ChatMessagePageCursor;
    readonly direction?: "older" | "newer";
    readonly limit?: number;
  },
  fetchImpl: ChatApiFetch = authenticatedFetch,
): Promise<readonly ChatMessageRecord[]> {
  const output = await callChatTool<{ readonly messages?: readonly ChatMessageRecord[] }>(
    "chat.message.list",
    {
      roomId: input.roomId,
      before: input.before,
      direction: input.direction,
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
  readonly privacy?: "discoverable" | "restricted" | "private";
  readonly readReceiptsEnabled?: boolean;
  readonly spaceType?: "conversation" | "announcement" | "project";
  readonly historyPolicy?: "full" | "since_join" | "off";
  readonly retentionDays?: number | null;
  readonly legalHold?: boolean;
  readonly notificationPolicy?: "all" | "mentions" | "none";
  readonly externalAccess?: "internal" | "guests" | "federated";
  readonly metadata?: Record<string, unknown>;
};

export type InviteToRoomRequest = {
  readonly roomId: string;
  readonly actorIds: readonly string[];
  readonly role?: "moderator" | "member";
};

export async function createChatRoom(
  input: CreateChatRoomRequest,
  fetchImpl: ChatApiFetch = authenticatedFetch,
): Promise<ChatRoomRecord> {
  const payload: ChatCreateRoomInput = {
    kind: input.kind ?? "chat_room",
    memberActorIds: [...(input.memberActorIds ?? [])],
    privacy: input.privacy ?? "restricted",
    readReceiptsEnabled: input.readReceiptsEnabled ?? true,
    spaceType: input.spaceType ?? "conversation",
    historyPolicy: input.historyPolicy ?? "full",
    retentionDays: input.retentionDays ?? null,
    legalHold: input.legalHold ?? false,
    notificationPolicy: input.notificationPolicy ?? "all",
    externalAccess: input.externalAccess ?? "guests",
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
    readonly before?: ChatMessagePageCursor;
    readonly direction?: "older" | "newer";
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

export interface ChatMessagePageCursor {
  readonly sentAt: string;
  readonly id: string;
}

export async function replyInThread(
  input: {
    readonly roomId: string;
    readonly parentMessageId: string;
    readonly body: string;
    readonly bodyFormat?: "plain" | "markdown";
    readonly attachmentObjectIds?: readonly string[];
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
      ...(input.clientMessageId === undefined ? {} : { clientMessageId: input.clientMessageId }),
      ...(input.parentMessageId === undefined ? {} : { parentMessageId: input.parentMessageId }),
    },
    fetchImpl,
  );
}

export async function uploadChatAttachment(
  roomId: string,
  file: File,
  fetchImpl: ChatApiFetch = authenticatedFetch,
): Promise<ChatAttachmentRecord> {
  const response = await fetchImpl(
    `/api/chat/rooms/${encodeURIComponent(roomId)}/attachments?filename=${encodeURIComponent(file.name || "pasted-image")}`,
    {
      method: "POST",
      headers: { "content-type": file.type || "application/octet-stream" },
      body: file,
    },
  );
  const output: unknown = await response.json().catch(() => null);
  if (!response.ok || !isChatAttachment(output)) {
    throw new Error(chatApiError(output, "Unable to upload this image."));
  }
  return output;
}

export async function saveChatAttachmentToDrive(
  objectId: string,
  fetchImpl: ChatApiFetch = authenticatedFetch,
): Promise<{ readonly objectId: string }> {
  const response = await fetchImpl(
    `/api/chat/attachments/${encodeURIComponent(objectId)}/save-to-drive`,
    { method: "POST" },
  );
  const output: unknown = await response.json().catch(() => null);
  if (!response.ok || !isRecord(output) || typeof output.objectId !== "string") {
    throw new Error(chatApiError(output, "Unable to save this image to Drive."));
  }
  return { objectId: output.objectId };
}

export function chatAttachmentContentUrl(objectId: string, download = false): string {
  return `/v1/api/chat/attachments/${encodeURIComponent(objectId)}/content${download ? "?download=1" : ""}`;
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
export function chatRealtimeUrl(path = "/v1/ws/chat"): string {
  if (typeof window === "undefined") {
    return path;
  }

  const url = new URL(path, window.location.href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

export async function issueChatWebSocketTicket(
  roomId: string,
  fetchImpl: ChatApiFetch = authenticatedFetch,
): Promise<string> {
  const response = await fetchImpl("/api/chat/ws-ticket", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ roomId }),
  });
  const output: unknown = await response.json().catch(() => null);
  if (!response.ok || !isRecord(output) || typeof output.ticket !== "string") {
    throw new Error("Unable to authorize Chat realtime.");
  }
  return output.ticket;
}

export function createChatRealtimeClient(options: ChatRealtimeClientOptions): ChatRealtimeClient {
  const WebSocketImpl = options.WebSocketImpl ?? globalThis.WebSocket;
  const socket = new WebSocketImpl(options.url ?? chatRealtimeUrl(), [
    CHAT_REALTIME_PROTOCOL,
    `${CHAT_TICKET_PROTOCOL_PREFIX}${options.ticket}`,
  ]);

  let heartbeat: ReturnType<typeof setInterval> | undefined;
  socket.addEventListener("open", () => {
    // eslint-disable-next-line helix/pacer-discipline -- Browser WebSocket liveness protocol.
    heartbeat = setInterval(() => {
      if (socket.readyState === WebSocketImpl.OPEN) socket.send('{"type":"heartbeat"}');
    }, 15_000);
    options.onOpen?.();
  });
  socket.addEventListener("close", (event) => {
    // eslint-disable-next-line helix/pacer-discipline -- Stops the WebSocket liveness protocol.
    if (heartbeat !== undefined) clearInterval(heartbeat);
    options.onClose?.(event);
  });
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
    subscribe: (roomId, cursor = 0) => {
      send({ type: "subscribe", roomId, cursor });
    },
    sendMessage: (input) => {
      send({
        type: "send",
        roomId: input.roomId,
        body: input.body,
        bodyFormat: input.bodyFormat ?? "plain",
        attachmentObjectIds: input.attachmentObjectIds ?? [],
        ...(input.clientMessageId === undefined ? {} : { clientMessageId: input.clientMessageId }),
        ...(input.parentMessageId === undefined ? {} : { parentMessageId: input.parentMessageId }),
      });
    },
    setTyping: (roomId, isTyping) => {
      send({ type: "typing", roomId, isTyping });
    },
    markRead: (roomId, messageId) => {
      send({ type: "read", roomId, messageId });
    },
    requestPresence: (roomId) => {
      send({ type: "presence", roomId });
    },
    setPresence: (status) => {
      send({ type: "presence.set", status });
    },
    isOpen: () => socket.readyState === WebSocketImpl.OPEN,
    close: () => {
      // eslint-disable-next-line helix/pacer-discipline -- Stops the WebSocket liveness protocol.
      if (heartbeat !== undefined) clearInterval(heartbeat);
      socket.close();
    },
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

function isChatAttachment(value: unknown): value is ChatAttachmentRecord {
  return (
    isRecord(value) &&
    typeof value.objectId === "string" &&
    value.source === "chat" &&
    typeof value.filename === "string" &&
    typeof value.mimeType === "string" &&
    typeof value.byteSize === "number"
  );
}

function chatApiError(value: unknown, fallback: string): string {
  if (!isRecord(value)) return fallback;
  if (typeof value.message === "string") return value.message;
  return isRecord(value.error) && typeof value.error.message === "string"
    ? value.error.message
    : fallback;
}
