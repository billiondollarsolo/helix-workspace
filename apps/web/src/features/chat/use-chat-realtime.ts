/* useChatRealtime — owns the `/ws/chat` connection for the Chat surface.

   One socket per mounted ChatShell. Auto-reconnects with exponential backoff
   and re-subscribes rooms. Supports optimistic pending sends keyed by
   clientMessageId. */

import { Debouncer } from "@tanstack/pacer";
import { useDebouncedCallback, useDebouncer } from "@tanstack/react-pacer/debouncer";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  createChatRealtimeClient,
  issueChatWebSocketTicket,
  type ChatApiFetch,
  type ChatAttachmentRecord,
  type ChatMessageRecord,
  type ChatPresenceEntry,
  type ChatReadReceiptRecord,
  type ChatRealtimeClient,
  type ChatRealtimeEvent,
} from "./api";

type ChatConnectionState = "connecting" | "open" | "reconnecting" | "closed";

type PendingMessageStatus = "pending" | "failed";

interface PendingChatMessage {
  readonly clientMessageId: string;
  readonly roomId: string;
  readonly body: string;
  readonly bodyFormat: "plain" | "markdown";
  readonly attachmentObjectIds: readonly string[];
  readonly attachments: readonly ChatAttachmentRecord[];
  readonly status: PendingMessageStatus;
  readonly createdAt: string;
}

interface ChatRealtimeSendInput {
  readonly body: string;
  readonly bodyFormat: "plain" | "markdown";
  readonly attachmentObjectIds: readonly string[];
  readonly attachments?: readonly ChatAttachmentRecord[] | undefined;
}

export interface ChatRealtimeState {
  readonly connection: ChatConnectionState;
  readonly selfActorId: string | null;
  readonly liveMessages: readonly ChatMessageRecord[];
  readonly deletedMessageIds: ReadonlySet<string>;
  readonly pendingMessages: readonly PendingChatMessage[];
  readonly presence: readonly ChatPresenceEntry[];
  readonly typingActorIds: readonly string[];
  readonly receipts: readonly ChatReadReceiptRecord[];
  readonly sendMessage: (input: ChatRealtimeSendInput) => boolean;
  readonly retryPending: (clientMessageId: string) => boolean;
  readonly setTyping: (isTyping: boolean) => void;
  readonly markRead: (messageId: string) => void;
}

interface UseChatRealtimeOptions {
  readonly roomId: string | undefined;
  readonly fetchImpl?: ChatApiFetch;
  readonly WebSocketImpl?: typeof WebSocket;
  readonly url?: string;
  /** Inject clock for tests. */
  readonly now?: () => number;
  /** Base reconnect delay ms (default 500). */
  readonly reconnectBaseMs?: number;
  /** Cap reconnect delay ms (default 15_000). */
  readonly reconnectCapMs?: number;
  /** Pending send echo timeout ms (default 8_000). */
  readonly pendingTimeoutMs?: number;
}

const TYPING_TTL_MS = 5000;
const DEFAULT_RECONNECT_BASE_MS = 500;
const DEFAULT_RECONNECT_CAP_MS = 15_000;
const DEFAULT_PENDING_TIMEOUT_MS = 8_000;

/** Auth-fatal close codes — do not reconnect. */
const FATAL_CLOSE_CODES = new Set([4401, 1008]);

export function useChatRealtime(options: UseChatRealtimeOptions): ChatRealtimeState {
  const { roomId } = options;
  const reconnectBaseMs = options.reconnectBaseMs ?? DEFAULT_RECONNECT_BASE_MS;
  const reconnectCapMs = options.reconnectCapMs ?? DEFAULT_RECONNECT_CAP_MS;
  const pendingTimeoutMs = options.pendingTimeoutMs ?? DEFAULT_PENDING_TIMEOUT_MS;
  const now = options.now ?? Date.now;

  const [connection, setConnection] = useState<ChatConnectionState>("connecting");
  const [selfActorId, setSelfActorId] = useState<string | null>(null);
  const [liveMessages, setLiveMessages] = useState<readonly ChatMessageRecord[]>([]);
  const [deletedMessageIds, setDeletedMessageIds] = useState<ReadonlySet<string>>(() => new Set());
  const [pendingMessages, setPendingMessages] = useState<readonly PendingChatMessage[]>([]);
  const [presence, setPresence] = useState<readonly ChatPresenceEntry[]>([]);
  const [receipts, setReceipts] = useState<readonly ChatReadReceiptRecord[]>([]);
  const [typingStamps, setTypingStamps] = useState<ReadonlyMap<string, number>>(() => new Map());

  const clientRef = useRef<ChatRealtimeClient | null>(null);
  const roomIdRef = useRef<string | undefined>(roomId);
  const selfActorIdRef = useRef<string | null>(null);
  const attemptRef = useRef(0);
  const connectionGenerationRef = useRef(0);
  const cursorRef = useRef(0);
  const cursorRoomRef = useRef(roomId);
  const connectRef = useRef<() => void>(() => undefined);
  const pendingSchedulersRef = useRef<Map<string, Debouncer<() => void>>>(new Map());

  roomIdRef.current = roomId;
  selfActorIdRef.current = selfActorId;
  if (cursorRoomRef.current !== roomId) {
    cursorRoomRef.current = roomId;
    cursorRef.current = 0;
  }

  const sweepTyping = useDebouncedCallback(
    () => {
      const cutoff = now() - TYPING_TTL_MS;
      setTypingStamps((prev) => {
        let changed = false;
        const next = new Map<string, number>();
        for (const [actorId, at] of prev) {
          if (at > cutoff) {
            next.set(actorId, at);
          } else {
            changed = true;
          }
        }
        return changed ? next : prev;
      });
    },
    { wait: TYPING_TTL_MS },
  );
  const reconnectScheduler = useDebouncer(
    () => {
      connectRef.current();
    },
    { wait: reconnectBaseMs },
  );
  const cancelReconnect = reconnectScheduler.cancel;
  const scheduleReconnectExecution = reconnectScheduler.maybeExecute;
  const setReconnectOptions = reconnectScheduler.setOptions;

  useEffect(() => {
    const generation = connectionGenerationRef.current + 1;
    connectionGenerationRef.current = generation;
    attemptRef.current = 0;
    const pendingSchedulers = pendingSchedulersRef.current;

    const connect = async (): Promise<void> => {
      if (connectionGenerationRef.current !== generation || roomId === undefined) {
        if (roomId === undefined) {
          setConnection("closed");
        }
        return;
      }
      setConnection(attemptRef.current === 0 ? "connecting" : "reconnecting");

      let ticket: string;
      try {
        ticket = await issueChatWebSocketTicket(roomId, options.fetchImpl);
      } catch {
        if (connectionGenerationRef.current === generation) {
          scheduleReconnect();
        }
        return;
      }
      if (connectionGenerationRef.current !== generation) {
        return;
      }

      const handlers: EventHandlers = {
        roomIdRef,
        selfActorIdRef,
        setSelfActorId,
        setLiveMessages,
        setDeletedMessageIds,
        setPresence,
        setReceipts,
        setTypingStamps,
        setPendingMessages,
        pendingSchedulersRef,
        scheduleSweep: () => {
          sweepTyping();
        },
      };

      const client = createChatRealtimeClient({
        ticket,
        ...(options.url === undefined ? {} : { url: options.url }),
        ...(options.WebSocketImpl === undefined ? {} : { WebSocketImpl: options.WebSocketImpl }),
        onOpen: () => {
          if (connectionGenerationRef.current !== generation) {
            client.close();
            return;
          }
          attemptRef.current = 0;
          setConnection("open");
          client.subscribe(roomId, cursorRef.current);
        },
        onClose: (event) => {
          clientRef.current = null;
          if (connectionGenerationRef.current !== generation) {
            return;
          }
          const code = event?.code;
          if (code !== undefined && FATAL_CLOSE_CODES.has(code)) {
            setConnection("closed");
            return;
          }
          scheduleReconnect();
        },
        onError: () => {
          // close handler drives reconnect
        },
        onEvent: (event) => {
          if (connectionGenerationRef.current !== generation) {
            return;
          }
          if (event.type === "resync.required") {
            cursorRef.current = 0;
            client.close();
            return;
          }
          const cursor = durableEventCursor(event);
          if (cursor !== undefined) {
            if (cursor <= cursorRef.current) {
              return;
            }
            if (cursor !== cursorRef.current + 1) {
              cursorRef.current = 0;
              client.close();
              return;
            }
            cursorRef.current = cursor;
          } else if (event.type === "subscribed") {
            cursorRef.current = Math.max(cursorRef.current, event.cursor);
          }
          handleEvent(event, handlers);
        },
      });
      clientRef.current = client;
    };
    connectRef.current = () => {
      void connect();
    };

    const scheduleReconnect = (): void => {
      if (connectionGenerationRef.current !== generation) {
        return;
      }
      setConnection("reconnecting");
      const attempt = attemptRef.current;
      attemptRef.current = attempt + 1;
      const exp = Math.min(reconnectCapMs, reconnectBaseMs * 2 ** attempt);
      const jitter = Math.floor(Math.random() * (exp * 0.2));
      const delay = exp + jitter;
      setReconnectOptions({ wait: delay });
      scheduleReconnectExecution();
    };

    void connect();

    return () => {
      connectionGenerationRef.current += 1;
      cancelReconnect();
      for (const scheduler of pendingSchedulers.values()) {
        scheduler.cancel();
      }
      pendingSchedulers.clear();
      clientRef.current?.close();
      clientRef.current = null;
    };
  }, [
    roomId,
    options.fetchImpl,
    options.url,
    options.WebSocketImpl,
    sweepTyping,
    reconnectBaseMs,
    reconnectCapMs,
    cancelReconnect,
    scheduleReconnectExecution,
    setReconnectOptions,
  ]);

  useEffect(() => {
    setLiveMessages([]);
    setDeletedMessageIds(new Set());
    setPresence([]);
    setReceipts([]);
    setTypingStamps(new Map());
    setPendingMessages((prev) => prev.filter((p) => p.roomId === roomId));
  }, [roomId]);

  const armPendingTimeout = useCallback(
    (clientMessageId: string) => {
      const existing = pendingSchedulersRef.current.get(clientMessageId);
      if (existing !== undefined) {
        existing.cancel();
      }
      const scheduler = new Debouncer(
        () => {
          pendingSchedulersRef.current.delete(clientMessageId);
          setPendingMessages((prev) =>
            prev.map((p) =>
              p.clientMessageId === clientMessageId && p.status === "pending"
                ? { ...p, status: "failed" }
                : p,
            ),
          );
        },
        { wait: pendingTimeoutMs },
      );
      pendingSchedulersRef.current.set(clientMessageId, scheduler);
      scheduler.maybeExecute();
    },
    [pendingTimeoutMs],
  );

  const sendMessage = useCallback(
    (input: ChatRealtimeSendInput): boolean => {
      const client = clientRef.current;
      const active = roomIdRef.current;
      if (active === undefined) {
        return false;
      }
      const clientMessageId =
        typeof crypto !== "undefined" && "randomUUID" in crypto
          ? crypto.randomUUID()
          : `c-${String(now())}-${Math.random().toString(36).slice(2)}`;
      const pending: PendingChatMessage = {
        clientMessageId,
        roomId: active,
        body: input.body,
        bodyFormat: input.bodyFormat,
        attachmentObjectIds: input.attachmentObjectIds,
        attachments: input.attachments ?? [],
        status: "pending",
        createdAt: new Date(now()).toISOString(),
      };
      setPendingMessages((prev) => [...prev, pending]);

      if (client === null || !client.isOpen()) {
        setPendingMessages((prev) =>
          prev.map((p) => (p.clientMessageId === clientMessageId ? { ...p, status: "failed" } : p)),
        );
        return false;
      }
      client.sendMessage({
        roomId: active,
        body: input.body,
        bodyFormat: input.bodyFormat,
        attachmentObjectIds: input.attachmentObjectIds,
        clientMessageId,
      });
      armPendingTimeout(clientMessageId);
      return true;
    },
    [armPendingTimeout, now],
  );

  const retryPending = useCallback(
    (clientMessageId: string): boolean => {
      const client = clientRef.current;
      const pending = pendingMessages.find((p) => p.clientMessageId === clientMessageId);
      if (pending === undefined || client === null || !client.isOpen()) {
        return false;
      }
      setPendingMessages((prev) =>
        prev.map((p) => (p.clientMessageId === clientMessageId ? { ...p, status: "pending" } : p)),
      );
      client.sendMessage({
        roomId: pending.roomId,
        body: pending.body,
        bodyFormat: pending.bodyFormat,
        attachmentObjectIds: pending.attachmentObjectIds,
        clientMessageId,
      });
      armPendingTimeout(clientMessageId);
      return true;
    },
    [armPendingTimeout, pendingMessages],
  );

  const setTyping = useCallback((isTyping: boolean): void => {
    const client = clientRef.current;
    const active = roomIdRef.current;
    if (client !== null && active !== undefined && client.isOpen()) {
      client.setTyping(active, isTyping);
    }
  }, []);

  const markRead = useCallback((messageId: string): void => {
    const client = clientRef.current;
    const active = roomIdRef.current;
    if (client !== null && active !== undefined && client.isOpen()) {
      client.markRead(active, messageId);
    }
  }, []);

  const typingActorIds = useMemo(() => [...typingStamps.keys()], [typingStamps]);

  return useMemo(
    () => ({
      connection,
      selfActorId,
      liveMessages,
      deletedMessageIds,
      pendingMessages,
      presence,
      typingActorIds,
      receipts,
      sendMessage,
      retryPending,
      setTyping,
      markRead,
    }),
    [
      connection,
      selfActorId,
      liveMessages,
      deletedMessageIds,
      pendingMessages,
      presence,
      typingActorIds,
      receipts,
      sendMessage,
      retryPending,
      setTyping,
      markRead,
    ],
  );
}

interface EventHandlers {
  readonly roomIdRef: { current: string | undefined };
  readonly selfActorIdRef: { current: string | null };
  readonly setSelfActorId: (id: string) => void;
  readonly setLiveMessages: (
    update: (prev: readonly ChatMessageRecord[]) => readonly ChatMessageRecord[],
  ) => void;
  readonly setDeletedMessageIds: (
    update: (prev: ReadonlySet<string>) => ReadonlySet<string>,
  ) => void;
  readonly setPresence: (
    update: (prev: readonly ChatPresenceEntry[]) => readonly ChatPresenceEntry[],
  ) => void;
  readonly setReceipts: (
    update: (prev: readonly ChatReadReceiptRecord[]) => readonly ChatReadReceiptRecord[],
  ) => void;
  readonly setTypingStamps: (
    update: (prev: ReadonlyMap<string, number>) => ReadonlyMap<string, number>,
  ) => void;
  readonly setPendingMessages: (
    update: (prev: readonly PendingChatMessage[]) => readonly PendingChatMessage[],
  ) => void;
  readonly pendingSchedulersRef: {
    current: Map<string, Debouncer<() => void>>;
  };
  readonly scheduleSweep: () => void;
}

function handleEvent(event: ChatRealtimeEvent, h: EventHandlers): void {
  switch (event.type) {
    case "ready": {
      h.setSelfActorId(event.actorId);
      return;
    }
    case "subscribed": {
      if (event.roomId !== h.roomIdRef.current) {
        return;
      }
      h.setPresence(() => event.presence);
      h.setReceipts(() => event.receipts ?? []);
      return;
    }
    case "presence":
    case "presence.joined": {
      if (event.roomId !== h.roomIdRef.current) {
        return;
      }
      const roster = event.type === "presence" ? event.presence : (event.roster ?? null);
      if (roster !== null) {
        h.setPresence(() => roster);
      } else if (event.type === "presence.joined" && event.entry !== undefined) {
        const joined = event.entry;
        h.setPresence((previous) => [
          ...previous.filter((entry) => entry.actorId !== event.actorId),
          joined,
        ]);
      }
      return;
    }
    case "presence.left": {
      if (event.roomId !== h.roomIdRef.current) {
        return;
      }
      h.setPresence((prev) => prev.filter((p) => p.actorId !== event.actorId));
      removeTyping(event.actorId, h);
      return;
    }
    case "typing": {
      if (event.roomId !== h.roomIdRef.current || event.actorId === h.selfActorIdRef.current) {
        return;
      }
      if (event.isTyping) {
        h.setTypingStamps((prev) => {
          const next = new Map(prev);
          next.set(event.actorId, Date.now());
          return next;
        });
        h.scheduleSweep();
      } else {
        removeTyping(event.actorId, h);
      }
      return;
    }
    case "message.created":
    case "message.updated": {
      if (event.roomId !== h.roomIdRef.current) {
        return;
      }
      if (event.message.actorId !== null) {
        removeTyping(event.message.actorId, h);
      }
      const clientMessageId =
        event.type === "message.created" ? event.message.clientMessageId : undefined;
      if (clientMessageId !== undefined) {
        const scheduler = h.pendingSchedulersRef.current.get(clientMessageId);
        if (scheduler !== undefined) {
          scheduler.cancel();
          h.pendingSchedulersRef.current.delete(clientMessageId);
        }
        h.setPendingMessages((prev) => prev.filter((p) => p.clientMessageId !== clientMessageId));
      }
      h.setLiveMessages((prev) => [
        ...prev.filter((message) => message.id !== event.message.id),
        event.message,
      ]);
      return;
    }
    case "message.deleted": {
      if (event.roomId !== h.roomIdRef.current) {
        return;
      }
      h.setLiveMessages((prev) => prev.filter((message) => message.id !== event.messageId));
      h.setDeletedMessageIds((prev) => new Set(prev).add(event.messageId));
      return;
    }
    case "read": {
      if (event.roomId !== h.roomIdRef.current) {
        return;
      }
      h.setReceipts((prev) => [
        ...prev.filter((r) => r.actorId !== event.receipt.actorId),
        event.receipt,
      ]);
      return;
    }
    default:
      return;
  }
}

function durableEventCursor(event: ChatRealtimeEvent): number | undefined {
  return event.type === "message.created" ||
    event.type === "message.updated" ||
    event.type === "message.deleted" ||
    event.type === "read" ||
    event.type === "access.changed"
    ? event.cursor
    : undefined;
}

function removeTyping(actorId: string, h: EventHandlers): void {
  h.setTypingStamps((prev) => {
    if (!prev.has(actorId)) {
      return prev;
    }
    const next = new Map(prev);
    next.delete(actorId);
    return next;
  });
}
