/* useChatRealtime — owns the `/ws/chat` connection for the Chat surface.

   One socket per mounted ChatShell. Auto-reconnects with exponential backoff
   and re-subscribes rooms. Supports optimistic pending sends keyed by
   clientMessageId. */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useDebouncedCallback } from "@tanstack/react-pacer/debouncer";
import {
  createChatRealtimeClient,
  type ChatMessageRecord,
  type ChatPresenceEntry,
  type ChatReadReceiptRecord,
  type ChatRealtimeClient,
  type ChatRealtimeEvent,
} from "./api";

export type ChatConnectionState = "connecting" | "open" | "reconnecting" | "closed";

export type PendingMessageStatus = "pending" | "failed";

export interface PendingChatMessage {
  readonly clientMessageId: string;
  readonly roomId: string;
  readonly body: string;
  readonly status: PendingMessageStatus;
  readonly createdAt: string;
}

export interface ChatRealtimeState {
  readonly connection: ChatConnectionState;
  readonly selfActorId: string | null;
  readonly liveMessages: readonly ChatMessageRecord[];
  readonly pendingMessages: readonly PendingChatMessage[];
  readonly presence: readonly ChatPresenceEntry[];
  readonly typingActorIds: readonly string[];
  readonly receipts: readonly ChatReadReceiptRecord[];
  readonly sendMessage: (body: string) => boolean;
  readonly retryPending: (clientMessageId: string) => boolean;
  readonly setTyping: (isTyping: boolean) => void;
  readonly markRead: (messageId: string) => void;
}

interface UseChatRealtimeOptions {
  readonly roomId: string | undefined;
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
  const [pendingMessages, setPendingMessages] = useState<readonly PendingChatMessage[]>([]);
  const [presence, setPresence] = useState<readonly ChatPresenceEntry[]>([]);
  const [receipts, setReceipts] = useState<readonly ChatReadReceiptRecord[]>([]);
  const [typingStamps, setTypingStamps] = useState<ReadonlyMap<string, number>>(
    () => new Map(),
  );

  const clientRef = useRef<ChatRealtimeClient | null>(null);
  const roomIdRef = useRef<string | undefined>(roomId);
  const selfActorIdRef = useRef<string | null>(null);
  const subscribedRoomsRef = useRef<Set<string>>(new Set());
  const attemptRef = useRef(0);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const disposedRef = useRef(false);
  const pendingTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  roomIdRef.current = roomId;
  selfActorIdRef.current = selfActorId;

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

  useEffect(() => {
    disposedRef.current = false;

    const connect = (): void => {
      if (disposedRef.current) {
        return;
      }
      setConnection(attemptRef.current === 0 ? "connecting" : "reconnecting");

      const handlers: EventHandlers = {
        roomIdRef,
        selfActorIdRef,
        setSelfActorId,
        setLiveMessages,
        setPresence,
        setReceipts,
        setTypingStamps,
        setPendingMessages,
        pendingTimersRef,
        scheduleSweep: () => {
          sweepTyping();
        },
      };

      const client = createChatRealtimeClient({
        ...(options.url === undefined ? {} : { url: options.url }),
        ...(options.WebSocketImpl === undefined
          ? {}
          : { WebSocketImpl: options.WebSocketImpl }),
        onOpen: () => {
          if (disposedRef.current) {
            client.close();
            return;
          }
          attemptRef.current = 0;
          setConnection("open");
          // Re-subscribe all rooms we care about (active + previously subscribed).
          const rooms = new Set(subscribedRoomsRef.current);
          if (roomIdRef.current !== undefined) {
            rooms.add(roomIdRef.current);
          }
          for (const id of rooms) {
            client.subscribe(id);
          }
        },
        onClose: (event) => {
          clientRef.current = null;
          if (disposedRef.current) {
            setConnection("closed");
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
          handleEvent(event, handlers);
        },
      });
      clientRef.current = client;
    };

    const scheduleReconnect = (): void => {
      if (disposedRef.current) {
        return;
      }
      setConnection("reconnecting");
      const attempt = attemptRef.current;
      attemptRef.current = attempt + 1;
      const exp = Math.min(reconnectCapMs, reconnectBaseMs * 2 ** attempt);
      const jitter = Math.floor(Math.random() * (exp * 0.2));
      const delay = exp + jitter;
      if (reconnectTimerRef.current !== null) {
        clearTimeout(reconnectTimerRef.current);
      }
      reconnectTimerRef.current = setTimeout(() => {
        reconnectTimerRef.current = null;
        connect();
      }, delay);
    };

    connect();

    return () => {
      disposedRef.current = true;
      if (reconnectTimerRef.current !== null) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      for (const timer of pendingTimersRef.current.values()) {
        clearTimeout(timer);
      }
      pendingTimersRef.current.clear();
      clientRef.current?.close();
      clientRef.current = null;
    };
  }, [
    options.url,
    options.WebSocketImpl,
    sweepTyping,
    reconnectBaseMs,
    reconnectCapMs,
  ]);

  useEffect(() => {
    setLiveMessages([]);
    setPresence([]);
    setReceipts([]);
    setTypingStamps(new Map());
    setPendingMessages((prev) => prev.filter((p) => p.roomId === roomId));

    if (roomId !== undefined) {
      subscribedRoomsRef.current.add(roomId);
    }

    const client = clientRef.current;
    if (client !== null && roomId !== undefined && client.isOpen()) {
      client.subscribe(roomId);
    }
  }, [roomId]);

  const armPendingTimeout = useCallback(
    (clientMessageId: string) => {
      const existing = pendingTimersRef.current.get(clientMessageId);
      if (existing !== undefined) {
        clearTimeout(existing);
      }
      const timer = setTimeout(() => {
        pendingTimersRef.current.delete(clientMessageId);
        setPendingMessages((prev) =>
          prev.map((p) =>
            p.clientMessageId === clientMessageId && p.status === "pending"
              ? { ...p, status: "failed" }
              : p,
          ),
        );
      }, pendingTimeoutMs);
      pendingTimersRef.current.set(clientMessageId, timer);
    },
    [pendingTimeoutMs],
  );

  const sendMessage = useCallback(
    (body: string): boolean => {
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
        body,
        status: "pending",
        createdAt: new Date(now()).toISOString(),
      };
      setPendingMessages((prev) => [...prev, pending]);

      if (client === null || !client.isOpen()) {
        setPendingMessages((prev) =>
          prev.map((p) =>
            p.clientMessageId === clientMessageId ? { ...p, status: "failed" } : p,
          ),
        );
        return false;
      }
      client.sendMessage({
        roomId: active,
        body,
        bodyFormat: "plain",
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
        prev.map((p) =>
          p.clientMessageId === clientMessageId ? { ...p, status: "pending" } : p,
        ),
      );
      client.sendMessage({
        roomId: pending.roomId,
        body: pending.body,
        bodyFormat: "plain",
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
  readonly pendingTimersRef: {
    current: Map<string, ReturnType<typeof setTimeout>>;
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
      const roster =
        event.type === "presence" ? event.presence : (event.roster ?? null);
      if (roster !== null) {
        h.setPresence(() => roster);
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
      if (
        event.roomId !== h.roomIdRef.current ||
        event.actorId === h.selfActorIdRef.current
      ) {
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
    case "message.created": {
      if (event.roomId !== h.roomIdRef.current) {
        return;
      }
      if (event.actorId !== undefined) {
        removeTyping(event.actorId, h);
      }
      const clientMessageId = event.message.clientMessageId;
      if (clientMessageId !== undefined) {
        const timer = h.pendingTimersRef.current.get(clientMessageId);
        if (timer !== undefined) {
          clearTimeout(timer);
          h.pendingTimersRef.current.delete(clientMessageId);
        }
        h.setPendingMessages((prev) =>
          prev.filter((p) => p.clientMessageId !== clientMessageId),
        );
      }
      h.setLiveMessages((prev) =>
        prev.some((m) => m.id === event.message.id)
          ? prev
          : [...prev, event.message],
      );
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
