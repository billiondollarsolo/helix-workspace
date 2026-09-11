import { useEffect, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Copy, RotateCcw, Pencil as EditPenIcon, Sparkles as SparklesIcon } from "lucide-react";
import { Avatar } from "@/components/ui/avatar";
import { iconMap as Icons } from "@/components/icon-map";
import { apiPath } from "@/lib/auth";
import { AssistantSourceList, AssistantToolActivityList } from "./assistant-tool-results";
import { AssistantMarkdown } from "./assistant-markdown";
import type { AssistantBlock, AssistantChatMessage } from "./assistant-data";
/* ---------------------------------------------------------- conversation -- */
interface AssistantConversationProps {
  readonly userName: string;
  readonly conversation: readonly AssistantChatMessage[];
  readonly pending: boolean;
  readonly onNavigate: (target: string) => void;
  readonly onEdit: (message: AssistantChatMessage) => void;
  readonly onResend: (message: AssistantChatMessage) => void;
}
export function AssistantConversation({
  conversation,
  pending,
  onNavigate,
  userName,
  onEdit,
  onResend,
}: AssistantConversationProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const streamingText = conversation
    .filter((message) => message.streaming === true)
    .map((message) => message.text)
    .join("");
  const totalRows = conversation.length;
  const virtualizer = useVirtualizer({
    useFlushSync: false,
    count: totalRows,
    getScrollElement: () => scrollRef.current,
    // ChatGPT-ish: bot replies are usually 200-400px tall, user prompts ~80px.
    // measureElement refines after first paint; estimate is just for layout.
    estimateSize: () => 240,
    overscan: 4,
    getItemKey: (index) => conversation[index]?.id ?? `m:${String(index)}`,
  });
  // Streaming: keep the bottom row in view while the assistant types. We use
  // the virtualizer's scrollToIndex (not raw scrollTop) so the windowed list
  // measures + renders the target row before we land on it.
  useEffect(() => {
    if (totalRows === 0) return;
    virtualizer.scrollToIndex(totalRows - 1, { align: "end" });
    // We intentionally depend on length + streaming text + pending so every
    // delta nudges us back to the bottom even mid-stream.
  }, [virtualizer, totalRows, pending, streamingText]);
  return (
    <div
      aria-label="Assistant conversation"
      ref={scrollRef}
      className="flex-1 overflow-y-auto min-h-0 px-3 py-6 sm:px-8"
      data-testid="assistant-conversation"
    >
      <h1 className="sr-only">Helix AI conversation</h1>
      <div
        className="relative max-w-200 [margin:0_auto] w-full"
        style={{ height: virtualizer.getTotalSize() }}
      >
        {virtualizer.getVirtualItems().map((virtual) => {
          const message = conversation[virtual.index];
          if (message === undefined) return null;
          return (
            <div
              key={virtual.key}
              ref={virtualizer.measureElement}
              data-index={virtual.index}
              className="absolute top-0 left-0 w-full"
              style={{ transform: `translateY(${String(virtual.start)}px)` }}
            >
              <ChatMessage
                message={message}
                onNavigate={onNavigate}
                userName={userName}
                pending={pending}
                onEdit={onEdit}
                onResend={onResend}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}
interface ChatMessageProps {
  readonly userName: string;
  readonly message: AssistantChatMessage;
  readonly pending: boolean;
  readonly onNavigate: (target: string) => void;
  readonly onEdit: (message: AssistantChatMessage) => void;
  readonly onResend: (message: AssistantChatMessage) => void;
}
function ChatMessage({
  message,
  onNavigate,
  userName,
  pending,
  onEdit,
  onResend,
}: ChatMessageProps) {
  const [copyStatus, setCopyStatus] = useState<string | null>(null);
  const actions = (
    <div className="mt-2 flex items-center gap-1">
      <button
        type="button"
        className="icon-btn"
        aria-label={message.role === "user" ? "Copy message" : "Copy response"}
        disabled={message.text.length === 0}
        onClick={() => {
          void (
            navigator.clipboard?.writeText(message.text) ??
            Promise.reject(new Error("Clipboard unavailable"))
          )
            .then(() => setCopyStatus("Message copied."))
            .catch(() => setCopyStatus("Could not copy. Select the message and copy it manually."));
        }}
      >
        <Copy size={16} />
      </button>
      {message.role === "user" ? (
        <>
          <button
            type="button"
            className="icon-btn"
            aria-label="Edit message"
            disabled={pending}
            onClick={() => onEdit(message)}
          >
            <EditPenIcon size={16} />
          </button>
          <button
            type="button"
            className="icon-btn"
            aria-label="Resend message"
            disabled={pending}
            onClick={() => onResend(message)}
          >
            <RotateCcw size={16} />
          </button>
        </>
      ) : null}
      {copyStatus ? (
        <span role="status" className="text-sm">
          {copyStatus}
        </span>
      ) : null}
    </div>
  );
  if (message.role === "user") {
    return (
      <div className="flex gap-3 mb-5 justify-end">
        <div className="min-w-0 max-w-130">
          <div className="[background:var(--accent-soft)] text-foreground [padding:10px_14px] [border-radius:12px] max-w-130 [font-size:var(--text-body-sm)] [line-height:1.55] [border:1px_solid_var(--accent-soft-border)] whitespace-pre-wrap">
            {message.text}
            {message.attachments?.length ? (
              <ul aria-label="Message attachments" className="mt-2 space-y-1">
                {message.attachments.map((attachment) => (
                  <li key={attachment.objectId}>
                    <a
                      className="underline"
                      href={apiPath(
                        `/api/drive/objects/${encodeURIComponent(attachment.objectId)}/content?download=1`,
                      )}
                      download={attachment.name}
                    >
                      {attachment.name}
                    </a>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
          {actions}
        </div>
        <Avatar name={userName} size={28} />
      </div>
    );
  }
  const isPending = message.streaming === true && message.text.length === 0;
  return (
    <div className="flex gap-3 mb-6">
      <div className="w-7 h-7 rounded-lg shrink-0 [background:linear-gradient(135deg,_var(--accent),_var(--accent-2))] [color:white] grid [place-items:center]">
        <SparklesIcon size={14} />
      </div>
      <div className="flex-1 min-w-0">
        <AssistantToolActivityList
          activity={message.toolActivity ?? []}
          streaming={message.streaming === true}
        />
        {isPending ? (
          <PendingDots />
        ) : (
          <>
            {message.text.length > 0 && <AssistantMarkdown text={message.text} />}
            {message.error ? (
              <p role="alert" className="my-2 text-sm">
                {message.error}
              </p>
            ) : null}
            {message.blocks?.map((block, index) => (
              <MessageBlock
                key={`${message.id}-block-${String(index)}`}
                block={block}
                onNavigate={onNavigate}
              />
            ))}
            <AssistantSourceList sources={message.sources ?? []} />
            {message.text.length > 0 ? actions : null}
          </>
        )}
      </div>
    </div>
  );
}
function PendingDots() {
  return (
    <div
      className="inline-flex gap-1 items-center [padding:10px_0]"
      role="status"
      aria-label="Helix AI is thinking"
    >
      {[0, 1, 2].map((index) => (
        <span
          key={index}
          className="w-1.5 h-1.5 [border-radius:999px] [background:var(--text-3)]"
          style={{ animation: `helix-pending 1.2s ${String(index * 0.15)}s infinite` }}
        />
      ))}
    </div>
  );
}
/* ----------------------------------------------------------------- block -- */
interface MessageBlockProps {
  readonly block: AssistantBlock;
  readonly onNavigate: (target: string) => void;
}
function MessageBlock({ block, onNavigate }: MessageBlockProps) {
  if (block.kind === "list") {
    return (
      <div className="bg-card [border:1px_solid_var(--border)] rounded-lg [padding:12px_14px] mb-2">
        <div className="font-semibold [font-size:var(--text-body-sm)] mb-2">{block.title}</div>
        <ul className="m-0 pl-4.5 [font-size:var(--text-meta)] [line-height:1.6]">
          {block.items.map((item, index) => (
            <li key={index} className="mb-1">
              {item}
            </li>
          ))}
        </ul>
      </div>
    );
  }
  if (block.kind === "draft") {
    return (
      <div className="bg-card [border:1px_solid_var(--border)] rounded-lg mb-2 overflow-hidden">
        <div className="bg-muted [padding:8px_14px] [border-bottom:1px_solid_var(--border)] flex items-center gap-1.5 [font-size:var(--text-meta)]">
          <EditPenIcon size={16} />
          <span className="font-semibold">{block.title}</span>
          <span className="chip accent ml-auto">Draft</span>
        </div>
        <div className="[padding:12px_14px] whitespace-pre-wrap [font-size:var(--text-meta)] [line-height:1.6]">
          {block.body}
        </div>
      </div>
    );
  }
  return (
    <div className="flex gap-1.5 flex-wrap">
      {block.items.map((action, index) => {
        const ActionIcon = Icons[action.icon];
        return (
          <button
            key={`${action.label}-${String(index)}`}
            type="button"
            className="btn sm"
            onClick={() => {
              if (action.target !== undefined) {
                onNavigate(action.target);
              }
            }}
          >
            <ActionIcon size={16} /> {action.label}
          </button>
        );
      })}
    </div>
  );
}
