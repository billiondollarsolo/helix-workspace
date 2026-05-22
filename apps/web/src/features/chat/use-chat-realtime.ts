/* useChatRealtime — owns the `/ws/chat` connection for the Chat surface.

   One socket per mounted ChatShell. The hook subscribes to the active room,
   surfaces live `message.created` events, typing indicators, presence rosters
   and read receipts, and exposes imperative actions (send / typing / read).
   The TanStack Query message list is the history; this hook layers live
   deltas on top so the channel pane stays current without polling.

   Typing indicators auto-expire: each `typing:true` event stamps the actor
   with a wall-clock time; a Pacer-debounced sweep drops actors whose stamp
   has gone stale (a safety net for missed `typing:false` frames). */

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

export type ChatConnectionState = "connecting" | "open" | "closed";

export interface ChatRealtimeState {
  /** Connection lifecycle — drives the offline-fallback banner. */
  readonly connection: ChatConnectionState;
  /** The current actor id reported by the server `ready` frame. */
  readonly selfActorId: string | null;
  /** Live messages received for the active room since subscription. */
  readonly liveMessages: readonly ChatMessageRecord[];
  /** Online presence roster for the active room. */
  readonly presence: readonly ChatPresenceEntry[];
  /** Actor ids currently typing in the active room (excludes self). */
  readonly typingActorIds: readonly string[];
  /** Read receipts for the active room (excludes self). */
  readonly receipts: readonly ChatReadReceiptRecord[];
  /** Send a message over the socket. Returns false when the socket is closed. */
  readonly sendMessage: (body: string) => boolean;
  /** Announce typing state for the active room. */
  readonly setTyping: (isTyping: boolean) => void;
  /** Mark the active room read up to a message. */
  readonly markRead: (messageId: string) => void;
}

interface UseChatRealtimeOptions {
  readonly roomId: string | undefined;
  /** Injectable socket for tests. */
  readonly WebSocketImpl?: typeof WebSocket;
  /** Explicit URL override for tests. */
  readonly url?: string;
}

/** A typing stamp goes stale after this long without a refresh. */
const TYPING_TTL_MS = 5000;

export function useChatRealtime(options: UseChatRealtimeOptions): ChatRealtimeState {
  const { roomId } = options;

  const [connection, setConnection] = useState<ChatConnectionState>("connecting");
  const [selfActorId, setSelfActorId] = useState<string | null>(null);
  const [liveMessages, setLiveMessages] = useState<readonly ChatMessageRecord[]>([]);
  const [presence, setPresence] = useState<readonly ChatPresenceEntry[]>([]);
  const [receipts, setReceipts] = useState<readonly ChatReadReceiptRecord[]>([]);
  // Typing actors stamped with the wall-clock time of their last `typing:true`.
  const [typingStamps, setTypingStamps] = useState<ReadonlyMap<string, number>>(
    () => new Map(),
  );

  const clientRef = useRef<ChatRealtimeClient | null>(null);
  const roomIdRef = useRef<string | undefined>(roomId);
  const selfActorIdRef = useRef<string | null>(null);

  roomIdRef.current = roomId;
  selfActorIdRef.current = selfActorId;

  // Drop stale typing stamps. Debounced so a burst of keystrokes schedules a
  // single sweep instead of one per event (replaces a native timeout).
  const sweepTyping = useDebouncedCallback(
    () => {
      const cutoff = Date.now() - TYPING_TTL_MS;
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

  // Single socket for the lifetime of the mounted shell. Room changes
  // re-`subscribe` over the same connection rather than reconnecting.
  useEffect(() => {
    const handlers: EventHandlers = {
      roomIdRef,
      selfActorIdRef,
      setSelfActorId,
      setLiveMessages,
      setPresence,
      setReceipts,
      setTypingStamps,
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
        setConnection("open");
        const active = roomIdRef.current;
        if (active !== undefined) {
          client.subscribe(active);
        }
      },
      onClose: () => {
        setConnection("closed");
      },
      onError: () => {
        setConnection("closed");
      },
      onEvent: (event) => {
        handleEvent(event, handlers);
      },
    });
    clientRef.current = client;

    return () => {
      client.close();
      clientRef.current = null;
    };
    // The socket is created once; `url`/`WebSocketImpl`/`sweepTyping` are stable.
  }, [options.url, options.WebSocketImpl, sweepTyping]);

  // Re-subscribe and reset per-room state whenever the active room changes.
  useEffect(() => {
    setLiveMessages([]);
    setPresence([]);
    setReceipts([]);
    setTypingStamps(new Map());

    const client = clientRef.current;
    if (client !== null && roomId !== undefined && client.isOpen()) {
      client.subscribe(roomId);
    }
  }, [roomId]);

  const sendMessage = useCallback((body: string): boolean => {
    const client = clientRef.current;
    const active = roomIdRef.current;
    if (client === null || active === undefined || !client.isOpen()) {
      return false;
    }
    client.sendMessage({ roomId: active, body, bodyFormat: "plain" });
    return true;
  }, []);

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

  const typingActorIds = useMemo(
    () => [...typingStamps.keys()],
    [typingStamps],
  );

  return useMemo(
    () => ({
      connection,
      selfActorId,
      liveMessages,
      presence,
      typingActorIds,
      receipts,
      sendMessage,
      setTyping,
      markRead,
    }),
    [
      connection,
      selfActorId,
      liveMessages,
      presence,
      typingActorIds,
      receipts,
      sendMessage,
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
      // `presence.left` carries no roster — drop just that actor locally.
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
      removeTyping(event.actorId, h);
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
