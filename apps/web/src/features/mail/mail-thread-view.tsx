import { Avatar } from "@/components/ui/avatar";
import {
  Archive as ArchiveIcon,
  ArrowLeft as ArrowLeftIcon,
  Bell as BellIcon,
  FileText as DocIcon,
  Forward as ForwardIcon,
  Inbox as InboxIcon,
  Reply as ReplyIcon,
  Clock as SnoozeIcon,
  Tag as TagIcon,
  Trash2 as TrashIcon,
} from "lucide-react";
import { useState } from "react";
import type { MailLabelSummary, MailThreadDetail, MailThreadRow } from "./api";
import { MailHtmlBody } from "./mail-html-body";
import { MailReplyPanel, type ReplyMode } from "./mail-reply-panel";
import { formatThreadTime, isBetaSpamCatch } from "./mail-view-helpers";

/* --------------------------------------------------------------- thread view */

interface ThreadViewProps {
  readonly row: MailThreadRow;
  readonly detail: MailThreadDetail | null | undefined;
  readonly isLoading: boolean;
  readonly isError: boolean;
  readonly labelColors: ReadonlyMap<string, MailLabelSummary>;
  readonly onClose: () => void;
  readonly onArchive: () => void;
  readonly onDelete: () => void;
  readonly onSnooze: () => void;
  readonly restoreLabel: string | null;
  readonly onRestore: () => void;
  readonly onToggleLabel: () => void;
  readonly onReportSpam?: (() => void) | undefined;
  readonly onNotSpam?: (() => void) | undefined;
  /** Confirm AI beta catch was correct (writes feedback while staying in Spam). */
  readonly onConfirmAiSpam?: (() => void) | undefined;
  readonly actionBusy: boolean;
  readonly actionError: string | null;
}

export function ThreadView({
  row,
  detail,
  isLoading,
  isError,
  labelColors,
  onClose,
  onArchive,
  onDelete,
  onSnooze,
  restoreLabel,
  onRestore,
  onToggleLabel,
  onReportSpam,
  onNotSpam,
  onConfirmAiSpam,
  actionBusy,
  actionError,
}: ThreadViewProps) {
  const [replyMode, setReplyMode] = useState<ReplyMode | null>(null);
  const senderName = row.from.split(",")[0] ?? row.from;
  const subject = detail?.subject ?? row.subject;
  const labels = (detail?.labels ?? row.labels)
    .map((slug) => labelColors.get(slug))
    .filter((label): label is MailLabelSummary => label != null);
  const messages = detail?.messages ?? [];

  return (
    <div className="flex-1 flex flex-col bg-card">
      <div className="h-11 flex items-center [padding:0_12px] gap-1 [border-bottom:1px_solid_var(--border)] shrink-0">
        <button type="button" className="icon-btn" aria-label="Back" onClick={onClose}>
          <ArrowLeftIcon size={16} />
        </button>
        <button
          type="button"
          className="icon-btn"
          aria-label="Archive"
          disabled={actionBusy}
          onClick={onArchive}
        >
          <ArchiveIcon size={16} />
        </button>
        <button
          type="button"
          className="icon-btn"
          aria-label="Delete"
          disabled={actionBusy}
          onClick={onDelete}
        >
          <TrashIcon size={16} />
        </button>
        <button
          type="button"
          className="icon-btn"
          aria-label="Snooze"
          disabled={actionBusy}
          onClick={onSnooze}
        >
          <SnoozeIcon size={16} />
        </button>
        {restoreLabel !== null && (
          <button
            type="button"
            className="icon-btn"
            aria-label={restoreLabel}
            title={restoreLabel}
            disabled={actionBusy}
            onClick={onRestore}
          >
            <InboxIcon size={16} />
          </button>
        )}
        {onNotSpam !== undefined ? (
          <button
            type="button"
            className="btn sm ml-1"
            aria-label="Not spam"
            disabled={actionBusy}
            onClick={onNotSpam}
          >
            <InboxIcon size={16} /> Not spam
          </button>
        ) : null}
        {onConfirmAiSpam !== undefined ? (
          <button
            type="button"
            className="btn sm ml-1"
            aria-label="Yes, this is spam"
            disabled={actionBusy}
            onClick={onConfirmAiSpam}
          >
            Yes, spam
          </button>
        ) : null}
        {onReportSpam !== undefined ? (
          <button
            type="button"
            className="icon-btn"
            aria-label="Report spam"
            title="Report spam"
            disabled={actionBusy}
            onClick={onReportSpam}
          >
            <BellIcon size={16} />
          </button>
        ) : null}
        <div className="v-divider h-4.5 [margin:0_4px]" />
        <button
          type="button"
          className="icon-btn"
          aria-label="Label"
          disabled={actionBusy}
          onClick={onToggleLabel}
        >
          <TagIcon size={16} />
        </button>
        <span className="ml-auto [font-size:var(--text-caption)] text-muted-foreground">
          {messages.length > 0 ? `${String(messages.length)} messages` : ""}
        </span>
      </div>
      <div className="flex-1 overflow-y-auto min-w-0">
        <div className="max-w-220 [margin:0_auto] [padding:20px_32px]">
          {isBetaSpamCatch(row) ? (
            <div
              role="status"
              className="mb-4 [padding:10px_12px] rounded-lg [border:1px_solid_var(--border)] bg-muted [font-size:var(--text-meta)] flex flex-wrap gap-2 items-center"
            >
              <span>
                {row.spamCatcher === "ai"
                  ? "Caught by Helix AI spam (beta)."
                  : "Caught by Helix spam rules (beta)."}{" "}
                Was this correct?
              </span>
              {onConfirmAiSpam !== undefined ? (
                <button
                  type="button"
                  className="btn sm primary"
                  disabled={actionBusy}
                  onClick={onConfirmAiSpam}
                >
                  Yes, spam
                </button>
              ) : null}
              {onNotSpam !== undefined ? (
                <button type="button" className="btn sm" disabled={actionBusy} onClick={onNotSpam}>
                  No, not spam
                </button>
              ) : null}
            </div>
          ) : null}
          <div className="mb-4">
            <h1 className="[margin:0_0_8px] [font-size:var(--text-h2)] font-semibold [line-height:1.35]">
              {subject}
            </h1>
            <div className="flex gap-1.5 flex-wrap">
              {labels.map((label) => (
                <span
                  key={label.id}
                  className="[font-size:var(--text-caption)] [padding:2px_6px] rounded font-medium"
                  style={{ background: `${label.color}20`, color: label.color }}
                >
                  {label.name}
                </span>
              ))}
            </div>
          </div>

          {isError && (
            <div className="mb-3 [font-size:var(--text-caption)] text-destructive">
              Could not load the full conversation — showing the list preview.
            </div>
          )}
          {actionError != null && (
            <div className="mb-3 [font-size:var(--text-caption)] text-destructive">
              {actionError}
            </div>
          )}

          {isLoading && messages.length === 0 && (
            <div className="bg-card [border:1px_solid_var(--border)] rounded-lg p-4 mb-3 [font-size:var(--text-body-sm)] text-muted-foreground">
              Loading conversation…
            </div>
          )}

          {(messages.length > 0
            ? messages
            : [
                {
                  id: row.messageId,
                  from: { address: row.fromEmail, name: senderName },
                  to: [],
                  cc: [],
                  bcc: [],
                  sentAt: row.time,
                  body: row.preview,
                  bodyFormat: "plain" as const,
                  hasAttachment: row.hasAttachment,
                },
              ]
          ).map((message) => {
            const msgSender = message.from?.name ?? message.from?.address ?? senderName;
            return (
              <div
                key={message.id}
                className="bg-card [border:1px_solid_var(--border)] rounded-lg p-4 mb-3"
              >
                <div className="flex items-start gap-3">
                  <Avatar name={msgSender} size={32} />
                  <div className="flex-1 min-w-0">
                    <div className="flex [align-items:baseline] gap-1.5 flex-wrap">
                      <span className="font-semibold [font-size:var(--text-body-sm)]">
                        {msgSender}
                      </span>
                      <span className="[font-size:var(--text-caption)] text-muted-foreground">
                        {message.from?.address ?? row.fromEmail}
                      </span>
                      <span className="ml-auto [font-size:var(--text-caption)] text-muted-foreground whitespace-nowrap">
                        {formatThreadTime(message.sentAt)}
                      </span>
                    </div>
                    <div className="[font-size:var(--text-caption)] text-muted-foreground mb-3">
                      to{" "}
                      {message.to.length > 0
                        ? message.to.map((addr) => addr.name ?? addr.address).join(", ")
                        : "me"}
                    </div>
                    {message.bodyFormat === "html" && message.source !== undefined ? (
                      <MailHtmlBody
                        html={message.body}
                        source={message.source}
                        plainBody={message.plainBody}
                        remoteContentBlocked={message.remoteContentBlocked ?? false}
                      />
                    ) : (
                      <div className="whitespace-pre-wrap [font-size:var(--text-body-sm)] [line-height:1.6]">
                        {message.body}
                      </div>
                    )}
                    {message.hasAttachment && (
                      <div className="mt-4 flex gap-2">
                        <div className="[border:1px_solid_var(--border)] rounded-md [padding:8px_10px] flex items-center gap-2 [font-size:var(--text-meta)]">
                          <DocIcon size={16} />
                          <div>
                            <div className="font-medium">Attachment</div>
                            <div className="[font-size:var(--text-chip)] text-muted-foreground">
                              View in conversation
                            </div>
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            );
          })}

          <div className="flex gap-2 mt-4">
            <button
              type="button"
              className="btn"
              onClick={() => {
                setReplyMode("reply");
              }}
            >
              <ReplyIcon size={16} /> Reply
            </button>
            <button
              type="button"
              className="btn"
              onClick={() => {
                setReplyMode("replyAll");
              }}
            >
              <ReplyIcon size={16} /> Reply all
            </button>
            <button
              type="button"
              className="btn"
              onClick={() => {
                setReplyMode("forward");
              }}
            >
              <ForwardIcon size={16} /> Forward
            </button>
          </div>

          {replyMode != null && (
            <MailReplyPanel
              key={replyMode}
              mode={replyMode}
              threadId={row.threadId}
              subject={subject}
              senderName={senderName}
              original={messages.at(-1)}
              onClose={() => {
                setReplyMode(null);
              }}
            />
          )}
        </div>
      </div>
    </div>
  );
}
