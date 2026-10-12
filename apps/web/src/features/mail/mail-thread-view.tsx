/* An open conversation: toolbar, subject with label chips, then the
   messages. Read messages are collapsed to one line and the last one is
   open; with more than four, the middle folds into "N older messages".
   Reply, Reply all and Forward open the inline reply panel. */

import { Button } from "@/components/ui/button";
import { InlineError } from "@/components/ui/inline-error";
import { Skeleton } from "@/components/ui/skeleton";
import { useShortcuts } from "@/lib/shortcuts/use-shortcuts";
import { Forward, Reply, ReplyAll, X } from "lucide-react";
import { useState } from "react";
import type {
  MailFolderKey,
  MailLabelSummary,
  MailThreadDetail,
  MailThreadMessage,
  MailThreadRow,
} from "./api";
import type { MailAction } from "./mail-actions";
import { ConversationToolbar, type ConversationPosition } from "./mail-conversation-toolbar";
import type { MoveTarget } from "./mail-menus";
import { MailMessage, type MessageHandlers } from "./mail-message";
import { printMessages } from "./mail-print";
import { MailReplyPanel, type ReplyMode } from "./mail-reply-panel";
import { MailScheduledBanner } from "./mail-scheduled-banner";
import { MailSpamEvidence } from "./mail-spam-evidence";
import { labelChipStyle } from "./mail-view-helpers";

/** Collapsed head and tail around the "N older messages" fold. */
const FOLD_THRESHOLD = 4;

interface ThreadViewProps {
  readonly row: MailThreadRow;
  readonly detail: MailThreadDetail | null | undefined;
  readonly loading: boolean;
  readonly error: string | null;
  readonly retrying: boolean;
  readonly onRetry: () => void;
  readonly folder: MailFolderKey;
  readonly labels: readonly MailLabelSummary[];
  readonly labelsBySlug: ReadonlyMap<string, MailLabelSummary>;
  readonly position: ConversationPosition | null;
  readonly myAddress: string | null;
  /** Reply panel to open on arrival (Reply from the row menu). */
  readonly initialReply: ReplyMode | null;
  readonly onBack: () => void;
  readonly onAction: (action: MailAction) => void;
  readonly onMarkUnread: () => void;
  readonly onSnooze: (until: string) => void;
  readonly onMove: (target: MoveTarget) => void;
}

function previewMessage(row: MailThreadRow): MailThreadMessage {
  return {
    id: row.messageId,
    from: { address: row.fromEmail, name: row.from },
    to: [],
    cc: [],
    bcc: [],
    sentAt: row.time,
    body: row.preview,
    bodyFormat: "plain",
    hasAttachment: row.hasAttachment,
    attachments: [],
  };
}

type Entry =
  | { readonly kind: "message"; readonly message: MailThreadMessage }
  | { readonly kind: "fold"; readonly count: number };

/** Messages to draw, folding the middle of long conversations. */
export function foldMessages(
  messages: readonly MailThreadMessage[],
  showAll: boolean,
): readonly Entry[] {
  const entries = messages.map((message) => ({ kind: "message" as const, message }));
  if (showAll || messages.length <= FOLD_THRESHOLD) return entries;
  return [
    ...entries.slice(0, 1),
    { kind: "fold", count: messages.length - 3 },
    ...entries.slice(-2),
  ];
}

/** The conversation up to the message being answered, which the panel treats as the latest. */
function replyContext(
  messages: readonly MailThreadMessage[],
  target: MailThreadMessage | undefined,
): readonly MailThreadMessage[] {
  const index = target === undefined ? -1 : messages.indexOf(target);
  return index === -1 ? messages : messages.slice(0, index + 1);
}

export function ThreadView({
  row,
  detail,
  loading,
  error,
  retrying,
  onRetry,
  folder,
  labels,
  labelsBySlug,
  position,
  myAddress,
  initialReply,
  onBack,
  onAction,
  onMarkUnread,
  onSnooze,
  onMove,
}: ThreadViewProps) {
  const [reply, setReply] = useState<{
    readonly mode: ReplyMode;
    readonly message: MailThreadMessage | undefined;
  } | null>(initialReply === null ? null : { mode: initialReply, message: undefined });
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [showAll, setShowAll] = useState(false);
  useShortcuts("mail.thread", {
    "mail.thread.reply": () => setReply({ mode: "reply", message: undefined }),
    "mail.thread.reply-all": () => setReply({ mode: "replyAll", message: undefined }),
    "mail.thread.forward": () => setReply({ mode: "forward", message: undefined }),
  });

  const subject = detail?.subject ?? row.subject;
  const messages = detail?.messages ?? (loading ? [] : [previewMessage(row)]);
  const last = messages.at(-1);
  const chips = (detail?.labels ?? row.labels)
    .map((slug) => labelsBySlug.get(slug))
    .filter((label): label is MailLabelSummary => label !== undefined);
  const messageHandlers: MessageHandlers = {
    onReply: (mode, message) => setReply({ mode, message }),
    onMarkUnreadFromHere: onMarkUnread,
  };

  return (
    <section className="mail-conversation" aria-label="Conversation">
      <ConversationToolbar
        row={row}
        folder={folder}
        labels={labels}
        position={position}
        onBack={onBack}
        onAction={onAction}
        onMarkUnread={onMarkUnread}
        onSnooze={onSnooze}
        onMove={onMove}
        onPrint={() => printMessages(subject, messages)}
      />
      <div className="mail-conversation-body">
        <div className="mail-conversation-inner">
          <div className="mail-conversation-title">
            <h2 className="mail-conversation-subject">{subject || "(no subject)"}</h2>
            {chips.map((label) => (
              <span key={label.id} className="mail-subject-label" style={labelChipStyle(label)}>
                {label.name}
                <button
                  type="button"
                  className="mail-subject-label-remove focus-ring"
                  aria-label={`Remove label ${label.name}`}
                  onClick={() => onAction({ kind: "label", add: [], remove: [label.slug] })}
                >
                  <X aria-hidden="true" />
                </button>
              </span>
            ))}
          </div>
          {folder === "scheduled" ? <MailScheduledBanner threadId={row.threadId} /> : null}
          <MailSpamEvidence row={row} detail={detail} folder={folder} onAction={onAction} />
          {error === null ? null : (
            <InlineError
              variant="compact"
              className="mb-3"
              title="Couldn't load the whole conversation"
              message={`${error} Showing the preview from the list.`}
              onRetry={onRetry}
              retrying={retrying}
            />
          )}
          {loading && messages.length === 0 ? (
            <Skeleton variant="text" count={6} label="Loading conversation" />
          ) : null}
          <div className="mail-messages">
            {foldMessages(messages, showAll).map((entry) =>
              entry.kind === "fold" ? (
                <button
                  key="fold"
                  type="button"
                  className="mail-message-fold focus-ring"
                  onClick={() => setShowAll(true)}
                >
                  <span className="mail-message-fold-count">{entry.count}</span>
                  {entry.count === 1 ? "older message" : "older messages"}
                </button>
              ) : (
                <MailMessage
                  key={entry.message.id}
                  message={entry.message}
                  subject={subject}
                  expanded={entry.message === last || expanded.has(entry.message.id)}
                  onExpand={() => setExpanded((ids) => new Set(ids).add(entry.message.id))}
                  starred={row.starred}
                  onToggleStar={() => onAction({ kind: "star", starred: !row.starred })}
                  myAddress={myAddress}
                  {...messageHandlers}
                />
              ),
            )}
          </div>
          {reply === null ? (
            <div className="mail-reply-actions">
              <Button
                type="button"
                variant="outline"
                onClick={() => setReply({ mode: "reply", message: undefined })}
              >
                <Reply aria-hidden="true" /> Reply
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={() => setReply({ mode: "replyAll", message: undefined })}
              >
                <ReplyAll aria-hidden="true" /> Reply all
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={() => setReply({ mode: "forward", message: undefined })}
              >
                <Forward aria-hidden="true" /> Forward
              </Button>
            </div>
          ) : (
            <MailReplyPanel
              key={reply.message?.id ?? "last"}
              mode={reply.mode}
              onModeChange={(mode) => setReply({ mode, message: reply.message })}
              threadId={row.threadId}
              subject={subject}
              messages={replyContext(messages, reply.message)}
              onClose={() => setReply(null)}
            />
          )}
        </div>
      </div>
    </section>
  );
}
