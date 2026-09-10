import { useVirtualizer } from "@tanstack/react-virtual";
import { useEffect, useRef } from "react";
import { ChatMessageRow } from "./chat-message-row";
import { type ChatMessageView } from "./view-model";

/* ----------------------------------------------------------------
   Message list — loading / empty / error / data states
   ---------------------------------------------------------------- */

interface ChatMessageListProps {
  readonly loading: boolean;
  readonly error: unknown;
  readonly offline: boolean;
  readonly messages: readonly ChatMessageView[];
  readonly threadId: string | null;
  readonly hasOlder?: boolean;
  readonly loadingOlder?: boolean;
  readonly onLoadOlder?: () => void;
  readonly onRetry: () => void;
  readonly onOpenThread: (id: string) => void;
  readonly onReact: (messageId: string, emoji: string) => void;
  readonly onEdit: (messageId: string, body: string) => void;
  readonly onDelete: (messageId: string) => void;
  readonly onPin?: (messageId: string) => void;
  readonly onRetryPending?: (clientMessageId: string) => void;
}

export function ChatMessageList({
  loading,
  error,
  offline,
  messages,
  threadId,
  hasOlder,
  loadingOlder,
  onLoadOlder,
  onRetry,
  onOpenThread,
  onReact,
  onEdit,
  onDelete,
  onPin,
  onRetryPending,
}: ChatMessageListProps) {
  if (loading) {
    return (
      <div className="chat-messages" tabIndex={0} role="log" aria-label="Messages">
        <p className="chat-messages-state">Loading messages…</p>
      </div>
    );
  }

  if (error !== null && error !== undefined && !offline) {
    return (
      <div className="chat-messages" tabIndex={0} role="log" aria-label="Messages">
        <div className="chat-messages-state chat-messages-error">
          <p>Couldn’t load messages.</p>
          <button type="button" className="btn sm" onClick={onRetry}>
            Retry
          </button>
        </div>
      </div>
    );
  }

  if (messages.length === 0) {
    return (
      <div className="chat-messages" tabIndex={0} role="log" aria-label="Messages">
        <p className="chat-messages-state">
          {offline ? "Offline — no messages available." : "No messages yet. Say hello!"}
        </p>
      </div>
    );
  }

  return (
    <VirtualizedChatMessages
      messages={messages}
      threadId={threadId}
      hasOlder={hasOlder === true}
      loadingOlder={loadingOlder === true}
      onLoadOlder={onLoadOlder}
      onOpenThread={onOpenThread}
      onReact={onReact}
      onEdit={onEdit}
      onDelete={onDelete}
      onPin={onPin}
      onRetryPending={onRetryPending}
    />
  );
}

interface VirtualizedChatMessagesProps {
  readonly messages: readonly ChatMessageView[];
  readonly threadId: string | null;
  readonly hasOlder: boolean;
  readonly loadingOlder: boolean;
  readonly onLoadOlder?: (() => void) | undefined;
  readonly onOpenThread: (messageId: string) => void;
  readonly onReact: ChatMessageListProps["onReact"];
  readonly onEdit: ChatMessageListProps["onEdit"];
  readonly onDelete: ChatMessageListProps["onDelete"];
  readonly onPin?: ((messageId: string) => void) | undefined;
  readonly onRetryPending?: ((clientMessageId: string) => void) | undefined;
}

/**
 * Windowed render of a chat channel's message log via `@tanstack/react-virtual`.
 *
 * Channels routinely hold thousands of messages. The non-virtualized
 * implementation pushed a DOM node per row, which stalls the renderer well
 * before the first scroll. `useVirtualizer` keeps only the visible slice
 * mounted (~20 rows on a 1080p monitor) and uses `measureElement` for
 * variable-height rows.
 *
 * On every message-list change the bottom row is scrolled into view so live
 * messages appear at the bottom, matching Slack/Discord behaviour. Users who
 * have scrolled up are still pinned to "follow" until they manually scroll
 * back; this is the simplest correct behaviour and is what we ship for now —
 * a "jump to latest" affordance is a worthwhile follow-up.
 */
function VirtualizedChatMessages({
  messages,
  threadId,
  hasOlder,
  loadingOlder,
  onLoadOlder,
  onOpenThread,
  onReact,
  onEdit,
  onDelete,
  onPin,
  onRetryPending,
}: VirtualizedChatMessagesProps) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  // count = 1 header ("Today") + N messages
  const rowCount = messages.length + 1;
  const prevLenRef = useRef(messages.length);

  const virtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => scrollRef.current,
    estimateSize: (index) => (index === 0 ? 36 : 96),
    overscan: 6,
    getItemKey: (index) =>
      index === 0 ? "day-today" : (messages[index - 1]?.id ?? `m:${String(index)}`),
  });

  useEffect(() => {
    if (rowCount === 0) return;
    // Only auto-scroll when messages are appended (not when older pages prepend).
    if (messages.length >= prevLenRef.current) {
      const grewAtEnd = messages.length > prevLenRef.current;
      if (grewAtEnd || prevLenRef.current === 0) {
        virtualizer.scrollToIndex(rowCount - 1, { align: "end" });
      }
    }
    prevLenRef.current = messages.length;
  }, [virtualizer, rowCount, messages]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el === null || onLoadOlder === undefined) {
      return;
    }
    const onScroll = () => {
      if (el.scrollTop < 80 && hasOlder && !loadingOlder) {
        const before = el.scrollHeight;
        onLoadOlder();
        // Preserve approximate scroll position after prepend (next paint).
        requestAnimationFrame(() => {
          const after = el.scrollHeight;
          el.scrollTop = Math.max(0, el.scrollTop + (after - before));
        });
      }
    };
    el.addEventListener("scroll", onScroll);
    return () => {
      el.removeEventListener("scroll", onScroll);
    };
  }, [hasOlder, loadingOlder, onLoadOlder]);

  return (
    <div ref={scrollRef} className="chat-messages" tabIndex={0} role="log" aria-label="Messages">
      <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
        {virtualizer.getVirtualItems().map((virtual) => {
          if (virtual.index === 0) {
            return (
              <div
                key={virtual.key}
                ref={virtualizer.measureElement}
                data-index={virtual.index}
                className="absolute top-0 left-0 w-full"
                style={{ transform: `translateY(${String(virtual.start)}px)` }}
              >
                <div className="chat-day-divider">
                  <span className="chat-day-rule" />
                  <span className="chat-day-label">Today</span>
                  <span className="chat-day-rule" />
                </div>
              </div>
            );
          }
          const message = messages[virtual.index - 1];
          if (message === undefined) return null;
          return (
            <div
              key={virtual.key}
              ref={virtualizer.measureElement}
              data-index={virtual.index}
              className="absolute top-0 left-0 w-full"
              style={{ transform: `translateY(${String(virtual.start)}px)` }}
            >
              <ChatMessageRow
                message={message}
                isActiveThread={threadId === message.id}
                onOpenThread={() => {
                  onOpenThread(message.id);
                }}
                onReact={onReact}
                onEdit={onEdit}
                onDelete={onDelete}
                onPin={onPin}
                onRetryPending={onRetryPending}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}
