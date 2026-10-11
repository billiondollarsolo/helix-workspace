import { useMutation } from "@tanstack/react-query";
import {
  Forward as ForwardIcon,
  Reply as ReplyIcon,
  Send as SendIcon,
  X as XIcon,
} from "lucide-react";
import { useState } from "react";
import { forwardMail, replyToMail, type MailThreadMessage } from "./api";
import { parseRecipients } from "./mail-compose";
import { MailSenderSelect, useMailSender } from "./mail-sender-select";

export type ReplyMode = "reply" | "replyAll" | "forward";

/** `Fwd:` once, never `Fwd: Fwd:`. Mirrors the server's subject rule. */
export function forwardSubject(subject: string): string {
  const trimmed = subject.trim();
  return /^(?:fwd?|fw):/iu.test(trimmed) ? trimmed : `Fwd: ${trimmed}`.trim();
}

function mailboxText(mailbox: { readonly address: string; readonly name?: string } | undefined) {
  if (mailbox === undefined) return "";
  return mailbox.name === undefined ? mailbox.address : `${mailbox.name} <${mailbox.address}>`;
}

function plainText(message: MailThreadMessage): string {
  if (message.bodyFormat === "plain") return message.body;
  if (message.plainBody !== undefined) return message.plainBody;
  return new DOMParser().parseFromString(message.body, "text/html").body.textContent ?? "";
}

interface MailReplyPanelProps {
  readonly mode: ReplyMode;
  readonly threadId: string;
  readonly subject: string;
  readonly senderName: string;
  /** Message a forward quotes; replies let the server choose the parent. */
  readonly original: MailThreadMessage | undefined;
  readonly onClose: () => void;
}

/**
 * Inline reply / reply all / forward composer. Reply recipients, threading
 * headers, and the forwarded quote are built server-side by `mail.reply` and
 * `mail.forward`, so the preview here shows exactly what the server appends.
 */
export function MailReplyPanel({
  mode,
  threadId,
  subject,
  senderName,
  original,
  onClose,
}: MailReplyPanelProps) {
  const sender = useMailSender(undefined, true);
  const [body, setBody] = useState("");
  const [to, setTo] = useState("");
  const [forwardTitle, setForwardTitle] = useState(() => forwardSubject(subject));
  const [failed, setFailed] = useState(false);
  const recipients = parseRecipients(to);
  const mutation = useMutation({
    mutationFn: () => {
      const from = { address: sender.from };
      if (mode === "forward") {
        if (original === undefined) throw new Error("Nothing to forward.");
        return forwardMail({
          threadId,
          messageId: original.id,
          from,
          to: recipients,
          subject: forwardTitle,
          bodyText: body,
        });
      }
      return replyToMail({ threadId, from, replyAll: mode === "replyAll", bodyText: body });
    },
    onMutate: () => {
      setFailed(false);
    },
    onError: () => {
      setFailed(true);
    },
    onSuccess: onClose,
  });
  const canSend =
    sender.authorized &&
    !mutation.isPending &&
    (mode === "forward" ? recipients.length > 0 && original !== undefined : body.trim() !== "");

  return (
    <section
      aria-label={mode === "forward" ? "Forward message" : "Reply"}
      className="mt-4 bg-card [border:1px_solid_var(--accent-soft-border)] rounded-lg p-0 [box-shadow:0_0_0_3px_var(--accent-soft)]"
    >
      <div className="[padding:8px_14px] [border-bottom:1px_solid_var(--border)] flex items-center gap-2 type-meta">
        {mode === "forward" ? <ForwardIcon size={16} /> : <ReplyIcon size={16} />}
        <span className="font-semibold">
          {mode === "reply" && `Replying to ${senderName}`}
          {mode === "replyAll" && "Replying all"}
          {mode === "forward" && `Forwarding "${subject}"`}
        </span>
        <button
          type="button"
          className="icon-btn ml-auto"
          onClick={onClose}
          aria-label="Close reply"
        >
          <XIcon size={16} />
        </button>
      </div>
      <div className="px-3.5">
        <MailSenderSelect sender={sender} disabled={mutation.isPending} />
      </div>
      {mode === "forward" && (
        <>
          <label className="[padding:8px_14px] [border-bottom:1px_solid_var(--border)] flex items-center gap-2">
            <span className="type-meta text-muted-foreground w-12.5">To</span>
            <input
              className="input flex-1 [border:none] h-6.5"
              aria-label="Forward recipients"
              placeholder="Add recipients"
              value={to}
              onChange={(event) => {
                setTo(event.target.value);
              }}
            />
          </label>
          <label className="[padding:8px_14px] [border-bottom:1px_solid_var(--border)] flex items-center gap-2">
            <span className="type-meta text-muted-foreground w-12.5">Subject</span>
            <input
              className="input flex-1 [border:none] h-6.5"
              aria-label="Forward subject"
              value={forwardTitle}
              onChange={(event) => {
                setForwardTitle(event.target.value);
              }}
            />
          </label>
        </>
      )}
      <textarea
        value={body}
        onChange={(event) => {
          setBody(event.target.value);
        }}
        placeholder={mode === "forward" ? "Add a message (optional)" : "Write your reply…"}
        aria-label="Reply body"
        className="w-full min-h-30 p-3.5 [border:none] outline-none bg-transparent type-body-sm [line-height:1.55] [resize:vertical] [font-family:inherit]"
      />
      {mode === "forward" && original !== undefined && (
        <blockquote
          aria-label="Forwarded message"
          className="[margin:0_14px_12px] [padding:8px_12px] [border-left:3px_solid_var(--border)] type-body-sm text-muted-foreground whitespace-pre-wrap"
        >
          {[
            "---------- Forwarded message ---------",
            `From: ${mailboxText(original.from)}`,
            `Date: ${new Date(original.sentAt).toUTCString()}`,
            `Subject: ${original.subject ?? subject}`,
            `To: ${original.to.map(mailboxText).join(", ")}`,
            "",
            plainText(original),
          ].join("\n")}
          {original.hasAttachment && (
            <p className="mt-2 not-italic">Attachments are forwarded with the message.</p>
          )}
        </blockquote>
      )}
      {failed && (
        <div role="alert" className="[margin:0_14px_8px] type-caption text-destructive">
          {mode === "forward"
            ? "Could not forward. Try again."
            : "Could not send reply. Try again."}
        </div>
      )}
      <div className="flex items-center gap-1 [padding:8px_12px] [border-top:1px_solid_var(--border)]">
        <button
          type="button"
          className="btn primary"
          disabled={!canSend}
          onClick={() => {
            mutation.mutate();
          }}
        >
          <SendIcon size={16} /> {mutation.isPending ? "Sending…" : "Send"}
        </button>
        <button type="button" className="btn ghost ml-auto" onClick={onClose}>
          Discard
        </button>
      </div>
    </section>
  );
}
