/* The Assistant conversations list: New chat, pinned and date-grouped chats
   with a ⋮ menu each, and a Memory menu whose "Forget memory" asks first.
   Searching chats happens in the top bar. */

import { EmptyState } from "@/components/ui/empty-state";
import { Dialog } from "@/components/ui/helix-dialog";
import { InlineError } from "@/components/ui/inline-error";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "@/components/ui/menu";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  Archive as ArchiveIcon,
  Brain as MemoryIcon,
  ChevronUp as ChevronIcon,
  Pencil as EditPenIcon,
  EllipsisVertical as MoreVIcon,
  MessagesSquare as ChatsIcon,
  Pin as PinIcon,
  PinOff as UnpinIcon,
  Plus as PlusIcon,
  Trash2 as ForgetIcon,
} from "lucide-react";
import { useMemo, useRef, useState } from "react";
import type { AssistantThread } from "./assistant-data";
import { bucketThreadsByDate, type ThreadSidebarItem } from "./date-buckets";

export interface AssistantThreadListProps {
  readonly threadId: string | null;
  readonly threads: readonly AssistantThread[];
  readonly loading: boolean;
  readonly errored: boolean;
  readonly retrying: boolean;
  readonly onRetry: () => void;
  readonly search: string;
  readonly onSelect: (id: string) => void;
  readonly onNewChat: () => void;
  readonly onTogglePin: (thread: AssistantThread) => void;
  readonly onRename: (thread: AssistantThread) => void;
  readonly onDelete: (thread: AssistantThread) => void;
  readonly onForget: () => void;
  readonly forgetPending: boolean;
}

export function AssistantThreadList({
  onNewChat,
  onForget,
  forgetPending,
  ...listProps
}: AssistantThreadListProps) {
  const [confirmForget, setConfirmForget] = useState(false);
  return (
    <aside
      aria-label="Chats"
      className="assistant-thread-sidebar w-64 shrink-0 [border-right:1px_solid_var(--border)] bg-card flex flex-col"
    >
      <div className="[padding:12px_12px_8px]">
        <button type="button" className="btn primary lg w-full" onClick={onNewChat}>
          <PlusIcon size={16} aria-hidden="true" /> New chat
        </button>
      </div>
      <ThreadRows {...listProps} />
      <div className="[padding:8px_12px] [border-top:1px_solid_var(--border)]">
        <Menu>
          <MenuTrigger asChild>
            <button type="button" className="btn ghost sm w-full justify-start">
              <MemoryIcon size={16} aria-hidden="true" /> Memory
              <ChevronIcon size={16} aria-hidden="true" className="ml-auto" />
            </button>
          </MenuTrigger>
          <MenuContent side="top" aria-label="Memory">
            <MenuItem
              destructive
              icon={<ForgetIcon size={16} />}
              disabled={forgetPending}
              onSelect={() => {
                setConfirmForget(true);
              }}
            >
              {forgetPending ? "Forgetting…" : "Forget memory…"}
            </MenuItem>
          </MenuContent>
        </Menu>
      </div>
      {confirmForget ? (
        <Dialog
          title="Forget memory?"
          onClose={() => {
            setConfirmForget(false);
          }}
          footer={
            <>
              <button
                type="button"
                className="btn"
                onClick={() => {
                  setConfirmForget(false);
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                className="btn danger"
                onClick={() => {
                  setConfirmForget(false);
                  onForget();
                }}
              >
                Forget memory
              </button>
            </>
          }
        >
          <p className="m-0 type-body-sm">
            Helix AI will forget what it saved about you and stop saving new memories. Your chats
            stay in the list. This can&apos;t be undone.
          </p>
        </Dialog>
      ) : null}
    </aside>
  );
}

type ThreadRowsProps = Omit<AssistantThreadListProps, "onNewChat" | "onForget" | "forgetPending">;

/** Pinned chats render first; the rest share a measured virtual list with
 * their date headers so long histories stay bounded. */
function ThreadRows({
  threadId,
  threads,
  loading,
  errored,
  retrying,
  onRetry,
  search,
  onSelect,
  onTogglePin,
  onRename,
  onDelete,
}: ThreadRowsProps) {
  const pinned = threads.filter((thread) => thread.pinned === true);
  const sidebarItems = useMemo<readonly ThreadSidebarItem[]>(
    () => bucketThreadsByDate(threads.filter((thread) => thread.pinned !== true)),
    [threads],
  );
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const virtualizer = useVirtualizer({
    useFlushSync: false,
    count: sidebarItems.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (index) => (sidebarItems[index]?.kind === "header" ? 30 : 36),
    overscan: 8,
    getItemKey: (index) => {
      const item = sidebarItems[index];
      if (item === undefined) return index;
      return item.kind === "header" ? `h:${item.id}` : `t:${item.thread.id}`;
    },
  });
  const rowProps = { onSelect, onTogglePin, onRename, onDelete };

  let body: React.ReactNode = null;
  if (threads.length === 0) {
    body = loading ? (
      <Skeleton variant="text" count={6} label="Loading chats" className="p-3" />
    ) : errored ? (
      <InlineError
        variant="compact"
        title="Couldn't load chats"
        message="Check your connection and try again."
        onRetry={onRetry}
        retrying={retrying}
      />
    ) : (
      <EmptyState
        size="inline"
        headingLevel={2}
        icon={<ChatsIcon />}
        title={search.trim().length > 0 ? "No matching chats" : "No chats yet"}
        body={
          search.trim().length > 0
            ? `Nothing matches “${search.trim()}”.`
            : "Your conversations with Helix AI show up here."
        }
      />
    );
  }

  return (
    <div
      ref={scrollRef}
      className="flex-1 overflow-y-auto [padding:4px_8px]"
      data-testid="assistant-thread-list"
    >
      {body}
      {pinned.length > 0 ? (
        <section aria-label="Pinned chats">
          <h2 className="section-label [padding:8px_8px_4px]">Pinned</h2>
          {pinned.map((thread) => (
            <ThreadItem
              key={thread.id}
              thread={thread}
              active={threadId === thread.id}
              {...rowProps}
            />
          ))}
        </section>
      ) : null}
      {sidebarItems.length > 0 ? (
        <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
          {virtualizer.getVirtualItems().map((virtual) => {
            const item = sidebarItems[virtual.index];
            if (item === undefined) return null;
            return (
              <div
                key={virtual.key}
                ref={virtualizer.measureElement}
                data-index={virtual.index}
                className="absolute top-0 left-0 w-full"
                style={{ transform: `translateY(${String(virtual.start)}px)` }}
              >
                {item.kind === "header" ? (
                  <h2 className="section-label [padding:10px_8px_4px]">{item.label}</h2>
                ) : (
                  <ThreadItem
                    thread={item.thread}
                    active={threadId === item.thread.id}
                    {...rowProps}
                  />
                )}
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

interface ThreadItemProps {
  readonly thread: AssistantThread;
  readonly active: boolean;
  readonly onSelect: (id: string) => void;
  readonly onTogglePin: (thread: AssistantThread) => void;
  readonly onRename: (thread: AssistantThread) => void;
  readonly onDelete: (thread: AssistantThread) => void;
}

function ThreadItem({
  thread,
  active,
  onSelect,
  onTogglePin,
  onRename,
  onDelete,
}: ThreadItemProps) {
  return (
    <div
      className={cn(
        "group relative flex h-9 items-center rounded-full",
        active ? "bg-[var(--accent-soft)] text-primary" : "text-foreground hover:bg-[var(--hover)]",
      )}
    >
      <button
        type="button"
        onClick={() => {
          onSelect(thread.id);
        }}
        aria-current={active ? "page" : undefined}
        className="focus-ring flex h-full min-w-0 flex-1 items-center gap-2 rounded-full pr-9 pl-3 text-left"
      >
        {thread.pinned === true ? (
          <PinIcon size={14} aria-label="Pinned" className="shrink-0 text-muted-foreground" />
        ) : null}
        <span className={cn("truncate type-body-sm", active ? "font-semibold" : "font-normal")}>
          {thread.title}
        </span>
      </button>
      <Menu>
        <MenuTrigger asChild>
          <button
            type="button"
            className="icon-btn absolute right-1 size-7 pointer-fine:opacity-0 pointer-fine:group-hover:opacity-100 pointer-fine:group-focus-within:opacity-100 aria-expanded:opacity-100"
            aria-label={`Chat options for ${thread.title}`}
          >
            <MoreVIcon size={16} />
          </button>
        </MenuTrigger>
        <MenuContent align="end" aria-label={`Chat options for ${thread.title}`}>
          <MenuItem
            icon={thread.pinned === true ? <UnpinIcon size={16} /> : <PinIcon size={16} />}
            onSelect={() => {
              onTogglePin(thread);
            }}
          >
            {thread.pinned === true ? "Unpin" : "Pin"}
          </MenuItem>
          <MenuItem
            icon={<EditPenIcon size={16} />}
            onSelect={() => {
              onRename(thread);
            }}
          >
            Rename
          </MenuItem>
          <MenuItem
            destructive
            icon={<ArchiveIcon size={16} />}
            onSelect={() => {
              onDelete(thread);
            }}
          >
            Archive
          </MenuItem>
        </MenuContent>
      </Menu>
    </div>
  );
}
