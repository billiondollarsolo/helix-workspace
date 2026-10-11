/* The Chat composer: one line that grows as you type. Enter sends,
   Shift+Enter starts a new line. Typing @ suggests conversation members and
   inserts a mention the server resolves. The bar holds attach, formatting,
   emoji, start-a-meeting and send. */

import { Menu, MenuContent, MenuItem, MenuTrigger } from "@/components/ui/menu";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useDebouncedCallback } from "@tanstack/react-pacer/debouncer";
import {
  Bold as BoldIcon,
  Code as CodeIcon,
  HardDrive as DriveIcon,
  Image as ImageIcon,
  Italic as ItalicIcon,
  Link as LinkIcon,
  List as ListIcon,
  Plus as PlusIcon,
  SendHorizontal as SendIcon,
  Smile as SmileIcon,
  Strikethrough as StrikeIcon,
  Type as FormatIcon,
  Video as VideoIcon,
  X as XIcon,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type DragEvent,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { chatAttachmentContentUrl, type ChatAttachmentRecord } from "./api";
import {
  activeMentionQuery,
  applyFormat,
  chatBodyFormat,
  insertMention,
  insertText,
  mentionHandle,
  mentionSuggestions,
  type ChatFormat,
  type TextEdit,
} from "./composer-text";
import { EmojiPicker } from "./emoji-picker";
import { CHAT_IMAGE_ACCEPT, useComposerAttachments } from "./use-composer-attachments";
import type { ChatMemberView } from "./view-model";

/** Tallest the input grows before it scrolls. */
const MAX_INPUT_HEIGHT_PX = 200;

/** Unsent text per conversation (and thread), kept while switching rooms. */
const drafts = new Map<string, string>();

export interface ChatComposerSubmission {
  readonly body: string;
  readonly bodyFormat: "plain" | "markdown";
  readonly attachmentObjectIds: readonly string[];
  readonly attachments: readonly ChatAttachmentRecord[];
}

const FORMATS: readonly {
  readonly id: ChatFormat;
  readonly label: string;
  readonly icon: ReactNode;
}[] = [
  { id: "bold", label: "Bold", icon: <BoldIcon size={16} aria-hidden="true" /> },
  { id: "italic", label: "Italic", icon: <ItalicIcon size={16} aria-hidden="true" /> },
  {
    id: "strikethrough",
    label: "Strikethrough",
    icon: <StrikeIcon size={16} aria-hidden="true" />,
  },
  { id: "code", label: "Code", icon: <CodeIcon size={16} aria-hidden="true" /> },
  { id: "link", label: "Link", icon: <LinkIcon size={16} aria-hidden="true" /> },
  { id: "list", label: "Bulleted list", icon: <ListIcon size={16} aria-hidden="true" /> },
];

interface ChatComposerProps {
  readonly roomId: string | undefined;
  /** Keys the unsent draft; defaults to the room. */
  readonly draftKey?: string;
  /** Accessible name and placeholder, e.g. "Message Platform team". */
  readonly label: string;
  readonly disabled: boolean;
  readonly members: readonly ChatMemberView[];
  readonly selfActorId: string | null;
  readonly onSend: (submission: ChatComposerSubmission) => void;
  readonly onTyping: (isTyping: boolean) => void;
  /** Creates a meeting and posts its link; omitted where meetings don't fit. */
  readonly onStartMeeting?: (() => Promise<void>) | undefined;
}

export function ChatComposer({
  roomId,
  draftKey = roomId ?? "",
  label,
  disabled,
  members,
  selfActorId,
  onSend,
  onTyping,
  onStartMeeting,
}: ChatComposerProps) {
  const [draft, setDraft] = useState(() => drafts.get(draftKey) ?? "");
  const [formatting, setFormatting] = useState(false);
  const [caret, setCaret] = useState(0);
  const [activeSuggestion, setActiveSuggestion] = useState(0);
  const [mentionDismissed, setMentionDismissed] = useState(false);
  const [meeting, setMeeting] = useState<"idle" | "starting">("idle");
  const [meetingError, setMeetingError] = useState<string | null>(null);
  const files = useComposerAttachments(roomId, disabled);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const typingRef = useRef(false);
  const pendingSelection = useRef<TextEdit | null>(null);
  const listboxId = useId();

  const stopTyping = useCallback(() => {
    if (typingRef.current) {
      typingRef.current = false;
      onTyping(false);
    }
  }, [onTyping]);
  const scheduleStopTyping = useDebouncedCallback(stopTyping, { wait: 3000 });
  useEffect(() => stopTyping, [stopTyping]);

  // Swap drafts when the conversation changes.
  const draftKeyRef = useRef(draftKey);
  useEffect(() => {
    if (draftKeyRef.current === draftKey) return;
    draftKeyRef.current = draftKey;
    setDraft(drafts.get(draftKey) ?? "");
    setMeetingError(null);
  }, [draftKey]);

  // Grow with the text, and restore the selection after programmatic edits.
  useLayoutEffect(() => {
    const input = inputRef.current;
    if (input === null) return;
    // Empty: one line, however long the placeholder is.
    input.style.height = "auto";
    if (draft.length > 0) {
      input.style.height = `${String(Math.min(input.scrollHeight, MAX_INPUT_HEIGHT_PX))}px`;
    }
    const selection = pendingSelection.current;
    if (selection !== null) {
      pendingSelection.current = null;
      input.focus();
      input.setSelectionRange(selection.selectionStart, selection.selectionEnd);
      setCaret(selection.selectionEnd);
    }
  }, [draft]);

  const mention = mentionDismissed ? null : activeMentionQuery(draft, caret);
  const suggestions =
    mention === null ? [] : mentionSuggestions(members, mention.query, selfActorId);
  const suggesting = suggestions.length > 0;
  const highlighted = Math.min(activeSuggestion, suggestions.length - 1);

  const updateDraft = (value: string) => {
    setDraft(value);
    drafts.set(draftKey, value);
    setMentionDismissed(false);
    setActiveSuggestion(0);
    if (value.trim().length === 0) {
      stopTyping();
      return;
    }
    if (!typingRef.current) {
      typingRef.current = true;
      onTyping(true);
    }
    scheduleStopTyping();
  };

  const applyEdit = (edit: TextEdit) => {
    pendingSelection.current = edit;
    updateDraft(edit.text);
  };

  const currentSelection = (): TextEdit => ({
    text: draft,
    selectionStart: inputRef.current?.selectionStart ?? draft.length,
    selectionEnd: inputRef.current?.selectionEnd ?? draft.length,
  });

  const chooseSuggestion = (member: ChatMemberView) => {
    const handle = mentionHandle(member);
    if (mention === null || handle === null) return;
    applyEdit(insertMention(draft, mention.start, caret, handle));
  };

  const canSend =
    !disabled && files.uploading === 0 && (draft.trim().length > 0 || files.attachments.length > 0);

  const submit = () => {
    const body = draft.trim();
    if (!canSend) return;
    onSend({
      body,
      bodyFormat: chatBodyFormat(body),
      attachmentObjectIds: files.attachments.map(({ objectId }) => objectId),
      attachments: files.attachments,
    });
    setDraft("");
    drafts.delete(draftKey);
    files.clear();
    stopTyping();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (suggesting) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const step = event.key === "ArrowDown" ? 1 : -1;
        setActiveSuggestion((highlighted + step + suggestions.length) % suggestions.length);
        return;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault();
        const member = suggestions[highlighted];
        if (member !== undefined) chooseSuggestion(member);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        setMentionDismissed(true);
        return;
      }
    }
    if ((event.ctrlKey || event.metaKey) && !event.altKey) {
      const format = { b: "bold", i: "italic" }[event.key.toLowerCase()] as ChatFormat | undefined;
      if (format !== undefined) {
        event.preventDefault();
        applyEdit(applyFormat(currentSelection(), format));
        return;
      }
    }
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      submit();
    }
  };

  const startMeeting = () => {
    if (onStartMeeting === undefined) return;
    setMeeting("starting");
    setMeetingError(null);
    void onStartMeeting()
      .catch((error: unknown) => {
        setMeetingError(
          error instanceof Error && error.message.length > 0
            ? `Couldn’t start a meeting: ${error.message}`
            : "Couldn’t start a meeting. Try again.",
        );
      })
      .finally(() => setMeeting("idle"));
  };

  const error = files.error ?? meetingError;

  return (
    <div
      className="chat-composer"
      data-disabled={disabled}
      onDragOver={(event) => {
        if (hasFiles(event)) event.preventDefault();
      }}
      onDrop={(event) => {
        if (!hasFiles(event)) return;
        event.preventDefault();
        void files.upload([...event.dataTransfer.files]);
      }}
    >
      {suggesting ? (
        <ul
          id={listboxId}
          className="chat-mention-list"
          role="listbox"
          aria-label="Mention someone"
        >
          {suggestions.map((member, index) => (
            <li
              key={member.actorId}
              id={`${listboxId}-${String(index)}`}
              role="option"
              aria-selected={index === highlighted}
              className="chat-mention-option"
              onMouseDown={(event) => {
                event.preventDefault();
                chooseSuggestion(member);
              }}
            >
              <span className="chat-mention-name">{member.name}</span>
              <span className="chat-mention-handle">@{mentionHandle(member)}</span>
            </li>
          ))}
        </ul>
      ) : null}

      {files.attachments.length > 0 ? (
        <div className="chat-composer-attachments" role="group" aria-label="Attachments to send">
          {files.attachments.map((attachment) => (
            <div key={attachment.objectId} className="chat-composer-attachment">
              {attachment.source === "chat" ? (
                <img src={chatAttachmentContentUrl(attachment.objectId)} alt="" />
              ) : (
                <DriveIcon size={16} aria-hidden="true" />
              )}
              <span>{attachment.filename}</span>
              <button
                type="button"
                aria-label={`Remove ${attachment.filename}`}
                onClick={() => files.remove(attachment.objectId)}
              >
                <XIcon size={12} aria-hidden="true" />
              </button>
            </div>
          ))}
        </div>
      ) : null}

      {files.driveOpen ? (
        <div className="chat-drive-picker" role="group" aria-label="Attach from Drive">
          {files.driveLoading ? <span>Loading Drive…</span> : null}
          {!files.driveLoading && files.driveFiles.length === 0 ? (
            <span>No Drive files found.</span>
          ) : null}
          {files.driveFiles.map((file) => (
            <button key={file.id} type="button" onClick={() => files.attachDriveFile(file)}>
              <DriveIcon size={15} aria-hidden="true" />
              <span>{file.name}</span>
            </button>
          ))}
        </div>
      ) : null}

      {formatting ? (
        <div className="chat-format-bar" role="toolbar" aria-label="Formatting">
          {FORMATS.map((format) => (
            <ComposerButton
              key={format.id}
              label={format.label}
              disabled={disabled}
              onClick={() => applyEdit(applyFormat(currentSelection(), format.id))}
            >
              {format.icon}
            </ComposerButton>
          ))}
        </div>
      ) : null}

      <div className="chat-composer-row">
        <input
          ref={fileInputRef}
          className="chat-composer-file-input"
          type="file"
          accept={CHAT_IMAGE_ACCEPT}
          multiple
          tabIndex={-1}
          aria-hidden="true"
          onChange={(event) => {
            void files.upload([...(event.target.files ?? [])]);
            event.target.value = "";
          }}
        />
        <Menu modal={false}>
          <MenuTrigger asChild>
            <button
              type="button"
              className="icon-btn"
              aria-label="Attach"
              title="Attach"
              disabled={disabled}
            >
              <PlusIcon size={18} aria-hidden="true" />
            </button>
          </MenuTrigger>
          <MenuContent align="start" side="top">
            <MenuItem icon={<ImageIcon />} onSelect={() => fileInputRef.current?.click()}>
              Upload image
            </MenuItem>
            <MenuItem icon={<DriveIcon />} onSelect={files.toggleDrive}>
              Choose from Drive
            </MenuItem>
          </MenuContent>
        </Menu>
        <textarea
          ref={inputRef}
          className="chat-composer-input"
          rows={1}
          placeholder={label}
          aria-label={label}
          aria-autocomplete="list"
          aria-controls={suggesting ? listboxId : undefined}
          aria-activedescendant={suggesting ? `${listboxId}-${String(highlighted)}` : undefined}
          value={draft}
          disabled={disabled}
          onChange={(event) => {
            setCaret(event.target.selectionStart);
            updateDraft(event.target.value);
          }}
          onSelect={(event) => setCaret(event.currentTarget.selectionStart)}
          onBlur={() => setMentionDismissed(true)}
          onFocus={() => setMentionDismissed(false)}
          onPaste={(event) => {
            const images = [...event.clipboardData.files].filter((file) =>
              file.type.startsWith("image/"),
            );
            if (images.length > 0) {
              event.preventDefault();
              void files.upload(images);
            }
          }}
          onKeyDown={onKeyDown}
        />
        {files.uploading > 0 ? (
          <span className="chat-composer-status" role="status">
            Scanning…
          </span>
        ) : null}
        <ComposerButton
          label={formatting ? "Hide formatting" : "Show formatting"}
          pressed={formatting}
          disabled={disabled}
          onClick={() => setFormatting((open) => !open)}
        >
          <FormatIcon size={18} aria-hidden="true" />
        </ComposerButton>
        <Popover>
          <PopoverTrigger asChild>
            <button
              type="button"
              className="icon-btn"
              aria-label="Insert emoji"
              title="Insert emoji"
              disabled={disabled}
            >
              <SmileIcon size={18} aria-hidden="true" />
            </button>
          </PopoverTrigger>
          <PopoverContent
            aria-label="Insert emoji"
            side="top"
            align="end"
            className="chat-emoji-popover"
          >
            <EmojiPicker onSelect={(emoji) => applyEdit(insertText(currentSelection(), emoji))} />
          </PopoverContent>
        </Popover>
        {onStartMeeting === undefined ? null : (
          <ComposerButton
            label={meeting === "starting" ? "Starting a meeting…" : "Start a meeting"}
            disabled={disabled || meeting === "starting"}
            onClick={startMeeting}
          >
            <VideoIcon size={18} aria-hidden="true" />
          </ComposerButton>
        )}
        <ComposerButton label="Send message" disabled={!canSend} onClick={submit} primary>
          <SendIcon size={18} aria-hidden="true" />
        </ComposerButton>
      </div>
      {error === null ? null : (
        <p className="chat-composer-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

function ComposerButton({
  label,
  disabled = false,
  pressed,
  primary = false,
  onClick,
  children,
}: {
  readonly label: string;
  readonly disabled?: boolean;
  readonly pressed?: boolean;
  readonly primary?: boolean;
  readonly onClick: () => void;
  readonly children: ReactNode;
}) {
  return (
    <button
      type="button"
      className={primary ? "icon-btn chat-send" : "icon-btn"}
      aria-label={label}
      title={label}
      aria-pressed={pressed}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function hasFiles(event: DragEvent<HTMLElement>): boolean {
  return event.dataTransfer.types.includes("Files");
}
