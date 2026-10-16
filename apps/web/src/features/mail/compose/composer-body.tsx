import { PreparedReply } from "../productivity/thread-controls";
/* The body and bottom bar shared by the compose window and the inline reply:
   editor, signature, attachments, errors, the formatting toolbar, and
   Send ▾ · Formatting · Attach · Link · Emoji · More · Discard. */

import { MailAiAssistance } from "../mail-ai-assistance";
import { useQuery } from "@tanstack/react-query";
import {
  EllipsisVertical,
  Link as LinkIcon,
  Paperclip,
  Printer,
  Trash2,
  Baseline,
} from "lucide-react";
import { useRef, useState, type ReactNode, type RefObject } from "react";
import { Menu, MenuCheckboxItem, MenuContent, MenuItem, MenuTrigger } from "@/components/ui/menu";
import { mailUserSettingsQueryOptions } from "../queries";
import { composeHtmlToText, textToComposeHtml } from "./compose-html";
import { ComposeAttachments } from "./compose-attachments";
import { ComposeEditor } from "./compose-editor";
import { EmojiButton, InsertLinkDialog } from "./compose-insert";
import { printComposedMessage } from "./compose-print";
import { ComposeToolbar } from "./compose-toolbar";
import { insertLink, insertText, saveSelection } from "./editor-commands";
import { SendButton } from "./send-button";
import type { Composer } from "./use-composer";

interface ComposerBodyProps {
  readonly composer: Composer;
  readonly editorRef: RefObject<HTMLDivElement | null>;
  readonly placeholder: string;
  readonly isReply: boolean;
  /** Extra content under the body, e.g. the quoted forward. */
  readonly children?: ReactNode;
  readonly errorId: string;
}

function SaveStatus({ status }: { readonly status: Composer["autosaveStatus"] }) {
  const text =
    status.kind === "saving"
      ? "Saving…"
      : status.kind === "saved"
        ? "Draft saved"
        : status.kind === "error"
          ? status.message
          : "";
  return (
    <span
      className="compose-save-status"
      data-tone={status.kind === "error" ? "error" : undefined}
      role="status"
    >
      {text}
    </span>
  );
}

export function ComposerBody({
  composer,
  editorRef,
  placeholder,
  isReply,
  children,
  errorId,
}: ComposerBodyProps) {
  const { fields, update } = composer;
  const selectionRef = useRef<Range | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [aiRevision, setAiRevision] = useState(0);
  const [showFormatting, setShowFormatting] = useState(false);
  const [linkText, setLinkText] = useState<string | null>(null);
  const settings = useQuery(mailUserSettingsQueryOptions());
  // Settings from an older server may lack the signature; compose must still open.
  const signatureText = settings.data?.signatureText?.trim() ?? "";
  const signature =
    signatureText !== "" && (!isReply || settings.data?.includeSignatureOnReplies !== false)
      ? signatureText
      : null;

  const openLinkDialog = () => {
    const range = saveSelection(editorRef.current) ?? selectionRef.current;
    selectionRef.current = range;
    setLinkText(range?.toString() ?? "");
  };

  const errors = [composer.problem?.message, composer.sendError, composer.attachments.error].filter(
    (message): message is string => typeof message === "string" && message !== "",
  );

  return (
    <>
      <ComposeEditor
        resetKey={String(aiRevision)}
        html={fields.html}
        plainText={fields.plainText}
        onChange={(html) => {
          update({ html });
        }}
        editorRef={editorRef}
        selectionRef={selectionRef}
        label="Message body"
        placeholder={placeholder}
      />
      {signature === null ? null : (
        <div className="compose-signature" aria-label="Signature, added when sent">
          <span className="compose-signature-dash" aria-hidden="true">
            --
          </span>
          {signature}
        </div>
      )}
      {children}
      <ComposeAttachments
        items={composer.attachments.items}
        onRemove={composer.attachments.remove}
      />
      {errors.length === 0 ? null : (
        <div id={errorId} className="compose-errors" role="alert">
          {errors.map((message) => (
            <p key={message}>{message}</p>
          ))}
        </div>
      )}
      {showFormatting && !fields.plainText ? (
        <ComposeToolbar
          editorRef={editorRef}
          selectionRef={selectionRef}
          onInsertLink={openLinkDialog}
        />
      ) : null}
      {isReply && composer.threadId ? (
        <PreparedReply
          threadId={composer.threadId}
          body={composeHtmlToText(fields.html)}
          onApply={(text) => {
            update({ html: textToComposeHtml(text) });
            setAiRevision((value) => value + 1);
          }}
        />
      ) : null}
      <MailAiAssistance
        threadId={composer.threadId}
        subject={fields.subject}
        body={composeHtmlToText(fields.html)}
        onApply={(text) => {
          update({ html: textToComposeHtml(text) });
          setAiRevision((value) => value + 1);
        }}
      />
      <div className="compose-bottom-bar">
        <SendButton
          onSend={composer.send}
          sending={composer.sending}
          disabled={!composer.sender.authorized && !composer.sender.addresses.isPending}
        />
        <div className="compose-bottom-tools" role="group" aria-label="Message options">
          <button
            type="button"
            className="compose-icon-btn"
            aria-label="Formatting options"
            title="Formatting options"
            aria-pressed={showFormatting}
            disabled={fields.plainText}
            onClick={() => {
              setShowFormatting((value) => !value);
            }}
          >
            <Baseline aria-hidden="true" size={18} />
          </button>
          <button
            type="button"
            className="compose-icon-btn"
            aria-label="Attach files"
            title="Attach files"
            onClick={() => fileInputRef.current?.click()}
          >
            <Paperclip aria-hidden="true" size={18} />
          </button>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            hidden
            tabIndex={-1}
            aria-hidden="true"
            onChange={(event) => {
              const { files } = event.target;
              if (files !== null) composer.attachments.add(files);
              event.target.value = "";
            }}
          />
          <button
            type="button"
            className="compose-icon-btn"
            aria-label="Insert link"
            title="Insert link"
            disabled={fields.plainText}
            onMouseDown={(event) => {
              event.preventDefault();
            }}
            onClick={openLinkDialog}
          >
            <LinkIcon aria-hidden="true" size={18} />
          </button>
          <EmojiButton
            onOpen={() => {
              selectionRef.current = saveSelection(editorRef.current) ?? selectionRef.current;
            }}
            onPick={(emoji) => {
              if (fields.plainText) {
                update({ html: textToComposeHtml(`${composeHtmlToText(fields.html)}${emoji}`) });
                return;
              }
              insertText(editorRef.current, emoji, selectionRef.current);
            }}
          />
          <Menu>
            <MenuTrigger
              className="compose-icon-btn"
              aria-label="More options"
              title="More options"
            >
              <EllipsisVertical aria-hidden="true" size={18} />
            </MenuTrigger>
            <MenuContent align="start" side="top">
              <MenuCheckboxItem
                checked={fields.plainText}
                onCheckedChange={(checked) => {
                  update({
                    plainText: checked,
                    html: checked ? textToComposeHtml(composeHtmlToText(fields.html)) : fields.html,
                  });
                  if (checked) setShowFormatting(false);
                }}
              >
                Plain text mode
              </MenuCheckboxItem>
              <MenuItem
                icon={<Printer size={16} />}
                onSelect={() => {
                  printComposedMessage(fields, composer.sender.from);
                }}
              >
                Print
              </MenuItem>
            </MenuContent>
          </Menu>
        </div>
        <SaveStatus status={composer.autosaveStatus} />
        <button
          type="button"
          className="compose-icon-btn compose-discard"
          aria-label="Discard draft"
          title="Discard draft"
          onClick={() => {
            void composer.discard();
          }}
        >
          <Trash2 aria-hidden="true" size={18} />
        </button>
      </div>
      {linkText === null ? null : (
        <InsertLinkDialog
          initialText={linkText}
          onClose={() => {
            setLinkText(null);
          }}
          onInsert={(link) => {
            setLinkText(null);
            insertLink(editorRef.current, link, selectionRef.current);
          }}
        />
      )}
    </>
  );
}
