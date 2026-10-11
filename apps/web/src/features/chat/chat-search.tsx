/* Chat search results: the top search box runs `chat.search` on Enter and
   the hits open here, across all conversations or just the open one.
   Choosing a hit opens its conversation at that message. */

import { EmptyState } from "@/components/ui/empty-state";
import { InlineError } from "@/components/ui/inline-error";
import { Skeleton } from "@/components/ui/skeleton";
import type { ChatSearchHit } from "@helix/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { SearchX as NoResultsIcon, X as XIcon } from "lucide-react";
import { useId } from "react";
import { chatQueryKeys, chatSearchQueryOptions } from "./queries";
import { formatChatWhen } from "./view-model";

interface ChatSearchPanelProps {
  readonly query: string;
  /** The open conversation, when there is one to narrow to. */
  readonly room: { readonly id: string; readonly name: string } | null;
  readonly scope: "all" | "room";
  readonly onScopeChange: (scope: "all" | "room") => void;
  readonly roomName: (roomId: string) => string;
  readonly actorName: (actorId: string | null) => string;
  readonly onOpenHit: (hit: ChatSearchHit) => void;
  readonly onClose: () => void;
}

export function ChatSearchPanel({
  query,
  room,
  scope,
  onScopeChange,
  roomName,
  actorName,
  onOpenHit,
  onClose,
}: ChatSearchPanelProps) {
  const titleId = useId();
  const roomId = scope === "room" && room !== null ? room.id : undefined;
  const results = useQuery(chatSearchQueryOptions(query, roomId));
  const queryClient = useQueryClient();

  return (
    <aside className="chat-side-panel chat-search-panel" aria-labelledby={titleId}>
      <header className="chat-side-header">
        <div className="chat-side-titles">
          <h2 id={titleId} className="chat-side-title">
            Search results
          </h2>
          <span className="chat-side-sub">“{query}”</span>
        </div>
        <button type="button" className="icon-btn" aria-label="Close search" onClick={onClose}>
          <XIcon size={18} aria-hidden="true" />
        </button>
      </header>
      {room === null ? null : (
        <div className="chat-search-scope" role="radiogroup" aria-label="Search in">
          <ScopeChip checked={scope === "all"} onSelect={() => onScopeChange("all")}>
            All conversations
          </ScopeChip>
          <ScopeChip checked={scope === "room"} onSelect={() => onScopeChange("room")}>
            {room.name}
          </ScopeChip>
        </div>
      )}
      <div className="chat-side-body">
        {results.isPending ? (
          <Skeleton variant="row" count={5} label="Searching messages" />
        ) : results.isError ? (
          <InlineError
            variant="compact"
            title="Search didn’t finish"
            message="Check your connection and try again."
            onRetry={() =>
              void queryClient.invalidateQueries({ queryKey: chatQueryKeys.search(query, roomId) })
            }
            retrying={results.isFetching}
          />
        ) : results.data.length === 0 ? (
          <EmptyState
            size="inline"
            headingLevel={3}
            icon={<NoResultsIcon />}
            title="No messages found"
            body="Try different words, or search all conversations."
          />
        ) : (
          <ul className="chat-search-results" aria-label="Matching messages">
            {results.data.map((hit) => (
              <li key={hit.messageId}>
                <button type="button" className="chat-search-hit" onClick={() => onOpenHit(hit)}>
                  <span className="chat-search-hit-head">
                    <span className="chat-search-hit-room">{roomName(hit.roomId)}</span>
                    <time dateTime={hit.sentAt}>{formatChatWhen(hit.sentAt)}</time>
                  </span>
                  <span className="chat-search-hit-author">{actorName(hit.actorId)}</span>
                  <span className="chat-search-hit-preview">{hit.preview}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </aside>
  );
}

function ScopeChip({
  checked,
  onSelect,
  children,
}: {
  readonly checked: boolean;
  readonly onSelect: () => void;
  readonly children: string;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={checked}
      className="chat-scope-chip"
      title={children}
      onClick={onSelect}
    >
      <span className="truncate">{children}</span>
    </button>
  );
}
