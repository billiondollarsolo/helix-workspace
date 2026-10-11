/* The inline reply at the bottom of a conversation. The header shows who the
   reply goes to ("To: Samara") with a menu to switch between Reply, Reply
   all, and Forward or to edit the subject; clicking the recipients opens the
   full To/Cc/Bcc fields. Replies autosave to Drafts; Send shows the undo
   snackbar like the compose window. */

import { ChevronDown, Forward, Pencil, Reply, ReplyAll } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from "@/components/ui/menu";
import type { MailThreadMessage } from "./api";
import {
  EMPTY_COMPOSE_FIELDS,
  recipientSummary,
  type ComposeFields,
} from "./compose/compose-fields";
import { ComposeAttachments } from "./compose/compose-attachments";
import type { ComposeTarget } from "./compose/compose-send";
import { ComposerBody } from "./compose/composer-body";
import { RecipientFields, type RecipientFieldsHandle } from "./compose/recipient-fields";
import {
  canReplyAll,
  forwardSubject,
  replyParent,
  replyRecipients,
  replySubject,
  type ReplyMode,
} from "./compose/reply-recipients";
import { useComposeShortcuts } from "./compose/use-compose-shortcuts";
import { useComposer } from "./compose/use-composer";
import { useOwnAddresses } from "./compose/use-own-addresses";

export type { ReplyMode };

interface MailReplyPanelProps {
  readonly mode: ReplyMode;
  readonly onModeChange: (mode: ReplyMode) => void;
  readonly threadId: string;
  readonly subject: string;
  readonly messages: readonly MailThreadMessage[];
  readonly onClose: () => void;
}

const MODE_ICON = { reply: Reply, replyAll: ReplyAll, forward: Forward } as const;
const MODE_LABEL = { reply: "Reply", replyAll: "Reply all", forward: "Forward" } as const;

function mailboxText(mailbox: { readonly address: string; readonly name?: string } | undefined) {
  if (mailbox === undefined) return "";
  return mailbox.name === undefined ? mailbox.address : `${mailbox.name} <${mailbox.address}>`;
}

function plainText(message: MailThreadMessage): string {
  if (message.bodyFormat === "plain") return message.body;
  if (message.plainBody !== undefined) return message.plainBody;
  return new DOMParser().parseFromString(message.body, "text/html").body.textContent ?? "";
}

function fieldsFor(
  mode: ReplyMode,
  parent: MailThreadMessage | undefined,
  own: ReadonlySet<string>,
  subject: string,
): Pick<ComposeFields, "to" | "cc" | "bcc" | "subject"> {
  if (mode === "forward" || parent === undefined) {
    return { to: [], cc: [], bcc: [], subject: forwardSubject(subject) };
  }
  const recipients = replyRecipients(parent, own, mode === "replyAll");
  return { ...recipients, bcc: [], subject: replySubject(parent.subject ?? subject) };
}

export function MailReplyPanel(props: MailReplyPanelProps) {
  const { own, ready } = useOwnAddresses();
  if (!ready) {
    return (
      <section aria-label="Reply" className="reply-panel">
        <p className="compose-loading" role="status">
          Preparing reply…
        </p>
      </section>
    );
  }
  return <ReplyComposer {...props} own={own} />;
}

function ReplyComposer({
  mode,
  onModeChange,
  threadId,
  subject,
  messages,
  onClose,
  own,
}: MailReplyPanelProps & { readonly own: ReadonlySet<string> }) {
  const rootRef = useRef<HTMLElement | null>(null);
  const editorRef = useRef<HTMLDivElement | null>(null);
  const recipientsRef = useRef<RecipientFieldsHandle | null>(null);
  const errorId = useId();
  const parent = replyParent(messages, own);
  const forwarded = messages.at(-1);
  const [includeAttachments, setIncludeAttachments] = useState(true);
  const [editingRecipients, setEditingRecipients] = useState(mode === "forward");
  const [editingSubject, setEditingSubject] = useState(mode === "forward");
  const [showCc, setShowCc] = useState(false);
  const [showBcc, setShowBcc] = useState(false);

  const target: ComposeTarget =
    mode === "forward"
      ? {
          kind: "forward",
          threadId,
          messageId: forwarded?.id ?? "",
          includeAttachments,
        }
      : { kind: "reply", threadId, ...(parent === undefined ? {} : { messageId: parent.id }) };

  const composer = useComposer({
    initial: { ...EMPTY_COMPOSE_FIELDS, ...fieldsFor(mode, parent, own, subject) },
    initialDraft: null,
    target,
    autosave: mode !== "forward",
    onDone: onClose,
    onProblem: (field) => {
      setEditingRecipients(true);
      requestAnimationFrame(() => recipientsRef.current?.focus(field));
    },
  });
  const { fields, update } = composer;

  // Switching Reply / Reply all / Forward resets who it goes to, and keeps the text.
  const appliedMode = useRef(mode);
  useEffect(() => {
    if (appliedMode.current === mode) return;
    appliedMode.current = mode;
    update(fieldsFor(mode, parent, own, subject));
    setShowCc(false);
    setShowBcc(false);
    setEditingRecipients(mode === "forward");
    setEditingSubject(mode === "forward");
  }, [mode, own, parent, subject, update]);

  useEffect(() => {
    if (mode === "forward") recipientsRef.current?.focus("to");
    else editorRef.current?.focus();
  }, [mode]);

  useComposeShortcuts(rootRef, {
    send: () => {
      composer.send();
    },
    cc: () => {
      setEditingRecipients(true);
      requestAnimationFrame(() => recipientsRef.current?.focus("cc"));
    },
    bcc: () => {
      setEditingRecipients(true);
      requestAnimationFrame(() => recipientsRef.current?.focus("bcc"));
    },
  });

  const ModeIcon = MODE_ICON[mode];
  const summary = recipientSummary(fields.to);
  const ccSummary = recipientSummary([...fields.cc, ...fields.bcc]);
  const originalAttachments =
    mode === "forward" && forwarded !== undefined
      ? forwarded.attachments.filter((attachment) => !attachment.inline)
      : [];

  return (
    <section ref={rootRef} aria-label={MODE_LABEL[mode]} className="reply-panel">
      <div className="reply-header">
        <Menu>
          <MenuTrigger
            className="reply-mode-btn"
            aria-label={`${MODE_LABEL[mode]}: change response type`}
          >
            <ModeIcon aria-hidden="true" size={18} />
            <ChevronDown aria-hidden="true" size={14} />
          </MenuTrigger>
          <MenuContent align="start">
            <MenuItem icon={<Reply size={16} />} onSelect={() => onModeChange("reply")}>
              Reply
            </MenuItem>
            {mode === "replyAll" || canReplyAll(parent, own) ? (
              <MenuItem icon={<ReplyAll size={16} />} onSelect={() => onModeChange("replyAll")}>
                Reply all
              </MenuItem>
            ) : null}
            <MenuItem icon={<Forward size={16} />} onSelect={() => onModeChange("forward")}>
              Forward
            </MenuItem>
            <MenuSeparator />
            <MenuItem
              icon={<Pencil size={16} />}
              onSelect={() => {
                setEditingSubject(true);
              }}
            >
              Edit subject
            </MenuItem>
          </MenuContent>
        </Menu>
        {editingRecipients ? null : (
          <button
            type="button"
            className="reply-recipients-summary"
            aria-label={`Edit recipients. To: ${summary || "nobody yet"}${ccSummary === "" ? "" : `. Also: ${ccSummary}`}`}
            onClick={() => {
              setEditingRecipients(true);
              requestAnimationFrame(() => recipientsRef.current?.focus("to"));
            }}
          >
            <span className="reply-recipients-label">To:</span>{" "}
            <span className="reply-recipients-names">
              {summary === "" ? "Add recipients" : summary}
            </span>
            {ccSummary === "" ? null : <span className="reply-recipients-cc">, {ccSummary}</span>}
          </button>
        )}
      </div>
      {editingRecipients || editingSubject ? (
        <div className="compose-fields reply-fields">
          {editingRecipients ? (
            <RecipientFields
              handleRef={recipientsRef}
              fields={fields}
              onChange={(field, refs) => {
                update({ [field]: refs });
              }}
              showCc={showCc || fields.cc.length > 0}
              showBcc={showBcc || fields.bcc.length > 0}
              onReveal={(field) => {
                if (field === "cc") setShowCc(true);
                else setShowBcc(true);
              }}
              problem={composer.problem}
              errorId={errorId}
            />
          ) : null}
          {editingSubject ? (
            <div className="compose-row">
              <input
                className="compose-subject"
                aria-label="Subject"
                placeholder="Subject"
                value={fields.subject}
                onChange={(event) => {
                  update({ subject: event.target.value });
                }}
              />
            </div>
          ) : null}
        </div>
      ) : null}
      <ComposerBody
        composer={composer}
        editorRef={editorRef}
        placeholder={mode === "forward" ? "Add a message (optional)" : ""}
        isReply
        errorId={errorId}
      >
        {mode === "forward" && forwarded !== undefined ? (
          <>
            <blockquote aria-label="Forwarded message" className="reply-forwarded">
              {[
                "---------- Forwarded message ---------",
                `From: ${mailboxText(forwarded.from)}`,
                `Date: ${new Date(forwarded.sentAt).toLocaleString()}`,
                `Subject: ${forwarded.subject ?? subject}`,
                `To: ${forwarded.to.map(mailboxText).join(", ")}`,
                "",
                plainText(forwarded),
              ].join("\n")}
            </blockquote>
            {originalAttachments.length > 0 ? (
              <div className="reply-forward-attachments">
                <ComposeAttachments
                  label="Forwarded attachments"
                  items={
                    includeAttachments
                      ? originalAttachments.map((attachment) => ({
                          key: attachment.objectId,
                          filename: attachment.filename ?? "Attachment",
                          contentType: attachment.mimeType,
                          byteSize: attachment.byteSize,
                          objectId: attachment.objectId,
                          state: "ready",
                          detail: "",
                          progress: null,
                        }))
                      : []
                  }
                />
                <label className="reply-include-attachments">
                  <input
                    type="checkbox"
                    checked={includeAttachments}
                    onChange={(event) => {
                      setIncludeAttachments(event.target.checked);
                    }}
                  />
                  Include the original{" "}
                  {originalAttachments.length === 1 ? "attachment" : "attachments"}
                </label>
              </div>
            ) : null}
          </>
        ) : null}
      </ComposerBody>
    </section>
  );
}
