/* A conversation's message log.

   It opens at the newest message (or at the "Unread" divider when there is
   unread history), follows new messages while the reader is at the bottom,
   and offers "Jump to newest" when they have scrolled up and something new
   arrives. Scrolling to the top loads older history and keeps the reader's
   place. Render it with `key={roomId}` so every conversation starts fresh.

   History loads in pages of 50 as the reader scrolls up, so the log renders
   plain rows rather than a virtual window: the browser keeps the layout
   exact, which is what bottom-anchoring and jump-to-message rely on. */

import { ArrowDown as ArrowDownIcon } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ChatMessageRow, type ChatMessageActions } from "./chat-message-row";
import { buildChatTimeline } from "./timeline";
import type { ChatMessageView } from "./view-model";

/** Within this many pixels of the end counts as "at the newest message". */
const BOTTOM_SLACK_PX = 64;
/** Start loading older history this close to the top. */
const LOAD_OLDER_PX = 160;
/** How many older pages to load while looking for a message to jump to. */
const MAX_FOCUS_PAGES = 6;

export interface ChatScrollRequest {
  readonly target: "newest" | "unread";
  readonly nonce: number;
}

interface ChatMessageListProps {
  readonly label: string;
  readonly messages: readonly ChatMessageView[];
  readonly actions: ChatMessageActions;
  readonly firstUnreadId?: string | null;
  readonly activeThreadId?: string | null;
  /** Scroll to and highlight this message, loading older pages to find it. */
  readonly focusMessageId?: string | null;
  readonly onFocusHandled?: () => void;
  readonly scrollRequest?: ChatScrollRequest | null;
  readonly hasOlder?: boolean;
  readonly loadingOlder?: boolean;
  readonly onLoadOlder?: () => void;
  readonly empty?: ReactNode;
}

export function ChatMessageList({
  label,
  messages,
  actions,
  firstUnreadId = null,
  activeThreadId = null,
  focusMessageId = null,
  onFocusHandled,
  scrollRequest = null,
  hasOlder = false,
  loadingOlder = false,
  onLoadOlder,
  empty,
}: ChatMessageListProps) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const atBottomRef = useRef(true);
  const [atBottom, setAtBottom] = useState(true);
  const [unseen, setUnseen] = useState(0);
  const [highlightedId, setHighlightedId] = useState<string | null>(null);
  const initializedRef = useRef(false);
  const edgesRef = useRef<{ first?: string; last?: string }>({});
  const prependRef = useRef<{ height: number; top: number } | null>(null);
  const focusSearchRef = useRef<{ id: string | null; pages: number }>({ id: null, pages: 0 });
  const timeline = useMemo(
    () => buildChatTimeline(messages, { now: new Date(), firstUnreadId }),
    [messages, firstUnreadId],
  );

  const scrollToBottom = () => {
    const el = scrollRef.current;
    if (el === null) return;
    el.scrollTop = el.scrollHeight;
    atBottomRef.current = true;
    setAtBottom(true);
    setUnseen(0);
  };

  const scrollToElement = (selector: string, block: "start" | "center") => {
    const el = scrollRef.current;
    const target = el?.querySelector<HTMLElement>(selector);
    if (el === null || target === null || target === undefined) return false;
    const offset = block === "start" ? 16 : (el.clientHeight - target.offsetHeight) / 2;
    el.scrollTop = Math.max(0, target.offsetTop - offset);
    const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < BOTTOM_SLACK_PX;
    atBottomRef.current = bottom;
    setAtBottom(bottom);
    return true;
  };

  // Place the reader when the conversation opens, then keep their place as
  // history prepends and new messages append.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    const first = messages[0]?.id;
    const last = messages.at(-1);
    const previous = edgesRef.current;
    edgesRef.current = {
      ...(first === undefined ? {} : { first }),
      ...(last ? { last: last.id } : {}),
    };
    if (el === null || last === undefined) return;
    if (!initializedRef.current) {
      initializedRef.current = true;
      if (
        focusMessageId === null &&
        !(firstUnreadId !== null && scrollToElement('[data-divider="unread"]', "start"))
      ) {
        scrollToBottom();
      }
      return;
    }
    const pending = prependRef.current;
    if (pending !== null && first !== previous.first) {
      prependRef.current = null;
      el.scrollTop = pending.top + (el.scrollHeight - pending.height);
    }
    if (last.id !== previous.last) {
      if (atBottomRef.current || last.isMine) {
        scrollToBottom();
      } else {
        setUnseen((count) => count + 1);
      }
    }
  });

  // Keep the newest message in view while images load and the composer grows.
  useEffect(() => {
    const content = contentRef.current;
    const scroller = scrollRef.current;
    if (content === null || scroller === null || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (atBottomRef.current) scroller.scrollTop = scroller.scrollHeight;
    });
    observer.observe(content);
    observer.observe(scroller);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const el = scrollRef.current;
    if (el === null) return;
    const onScroll = () => {
      const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < BOTTOM_SLACK_PX;
      atBottomRef.current = bottom;
      setAtBottom(bottom);
      if (bottom) setUnseen(0);
      if (el.scrollTop < LOAD_OLDER_PX && hasOlder && !loadingOlder && onLoadOlder !== undefined) {
        prependRef.current = { height: el.scrollHeight, top: el.scrollTop };
        onLoadOlder();
      }
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [hasOlder, loadingOlder, onLoadOlder]);

  // Jump to a message (search result, link, mention), paging back to find it.
  useLayoutEffect(() => {
    if (focusMessageId === null) return;
    const search = focusSearchRef.current;
    if (search.id !== focusMessageId) focusSearchRef.current = { id: focusMessageId, pages: 0 };
    if (scrollToElement(`[data-message-id="${focusMessageId}"]`, "center")) {
      setHighlightedId(focusMessageId);
      onFocusHandled?.();
      return;
    }
    if (loadingOlder) return;
    // Thread replies are not in the main log; stop paging after a while.
    if (hasOlder && onLoadOlder !== undefined && focusSearchRef.current.pages < MAX_FOCUS_PAGES) {
      focusSearchRef.current.pages += 1;
      onLoadOlder();
    } else {
      onFocusHandled?.();
    }
  }, [focusMessageId, messages, hasOlder, loadingOlder, onLoadOlder, onFocusHandled]);

  useLayoutEffect(() => {
    if (scrollRequest === null) return;
    if (scrollRequest.target === "newest" || !scrollToElement('[data-divider="unread"]', "start")) {
      scrollToBottom();
    }
  }, [scrollRequest]);

  const showJump = !atBottom && unseen > 0;

  return (
    <div className="chat-log-wrap">
      <div
        ref={scrollRef}
        className="chat-messages"
        tabIndex={0}
        role="log"
        aria-label={label}
        aria-busy={loadingOlder}
      >
        <div ref={contentRef} className="chat-messages-content">
          {loadingOlder ? (
            <p className="chat-messages-older" role="status">
              Loading older messages…
            </p>
          ) : null}
          {messages.length === 0 ? empty : null}
          {timeline.map((item) => {
            if (item.kind === "day") {
              return (
                <div
                  key={item.key}
                  className="chat-divider"
                  role="separator"
                  aria-label={item.label}
                >
                  <span className="chat-divider-label">{item.label}</span>
                </div>
              );
            }
            if (item.kind === "unread") {
              return (
                <div
                  key={item.key}
                  className="chat-divider chat-divider-unread"
                  data-divider="unread"
                  role="separator"
                  aria-label="Unread messages"
                >
                  <span className="chat-divider-label">Unread</span>
                </div>
              );
            }
            return (
              <ChatMessageRow
                key={item.key}
                message={item.message}
                grouped={item.grouped}
                actions={actions}
                highlighted={item.message.id === highlightedId}
                isActiveThread={item.message.id === activeThreadId}
              />
            );
          })}
        </div>
      </div>
      {showJump ? (
        <button type="button" className="chat-jump-newest" onClick={scrollToBottom}>
          <ArrowDownIcon size={14} aria-hidden="true" />
          Jump to newest
          <span className="chat-jump-count">
            {unseen === 1 ? "1 new" : `${String(unseen)} new`}
          </span>
        </button>
      ) : null}
    </div>
  );
}
