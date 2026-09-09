import { useCallback, useEffect, useRef, useState, type DragEvent, type ReactNode } from "react";
import { useDebouncedCallback } from "@tanstack/react-pacer/debouncer";
import { Icons } from "@/components/icons";
import { Tooltip } from "@/components/ui/tooltip";
import { listDrive, type DriveApiEntry } from "@/features/drive/api";
import { chatAttachmentContentUrl, uploadChatAttachment, type ChatAttachmentRecord } from "./api";
import { applyCodeMarkup } from "./message-content";

const MAX_ATTACHMENTS = 10;
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

export interface ChatComposerSubmission {
  readonly body: string;
  readonly bodyFormat: "plain" | "markdown";
  readonly attachmentObjectIds: readonly string[];
  readonly attachments: readonly ChatAttachmentRecord[];
}

export function ChatComposer({
  roomId,
  placeholder,
  disabled,
  compact = false,
  onSend,
  onTyping,
}: {
  readonly roomId: string | undefined;
  readonly placeholder: string;
  readonly disabled: boolean;
  readonly compact?: boolean;
  readonly onSend: (submission: ChatComposerSubmission) => void;
  readonly onTyping: (isTyping: boolean) => void;
}) {
  const [draft, setDraft] = useState("");
  const [attachments, setAttachments] = useState<readonly ChatAttachmentRecord[]>([]);
  const [uploading, setUploading] = useState(0);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [driveOpen, setDriveOpen] = useState(false);
  const [driveFiles, setDriveFiles] = useState<readonly DriveApiEntry[]>([]);
  const [driveLoading, setDriveLoading] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const typingRef = useRef(false);

  const stopTyping = useCallback(() => {
    if (typingRef.current) {
      typingRef.current = false;
      onTyping(false);
    }
  }, [onTyping]);
  const scheduleStopTyping = useDebouncedCallback(stopTyping, { wait: 3000 });

  useEffect(() => stopTyping, [stopTyping]);
  useEffect(() => {
    setAttachments([]);
    setUploadError(null);
    setDriveOpen(false);
  }, [roomId]);

  const handleChange = (value: string) => {
    setDraft(value);
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

  const addUploads = async (files: readonly File[]) => {
    if (roomId === undefined || disabled) return;
    const available = MAX_ATTACHMENTS - attachments.length;
    if (available <= 0) {
      setUploadError(`A message can contain at most ${String(MAX_ATTACHMENTS)} attachments.`);
      return;
    }
    const selected = files.slice(0, available);
    const invalid = selected.find(
      (file) => !IMAGE_TYPES.has(file.type) || file.size < 1 || file.size > MAX_UPLOAD_BYTES,
    );
    if (invalid !== undefined) {
      setUploadError("Upload a PNG, JPEG, GIF, or WebP image no larger than 10 MiB.");
      return;
    }
    setUploadError(null);
    setUploading((count) => count + selected.length);
    const results = await Promise.allSettled(
      selected.map((file) => uploadChatAttachment(roomId, file)),
    );
    setUploading((count) => count - selected.length);
    const uploaded = results.flatMap((result) =>
      result.status === "fulfilled" ? [result.value] : [],
    );
    if (uploaded.length > 0) {
      setAttachments((current) => uniqueAttachments([...current, ...uploaded]));
    }
    if (uploaded.length !== selected.length) {
      setUploadError("One or more images could not be uploaded.");
    }
  };

  const toggleDrive = () => {
    const opening = !driveOpen;
    setDriveOpen(opening);
    if (!opening || driveFiles.length > 0) return;
    setDriveLoading(true);
    setUploadError(null);
    void listDrive({ acrossFolders: true, limit: 30 })
      .then((page) => {
        setDriveFiles(page.entries);
      })
      .catch(() => {
        setUploadError("Drive files could not be loaded.");
      })
      .finally(() => {
        setDriveLoading(false);
      });
  };

  const attachDriveFile = (file: DriveApiEntry) => {
    if (attachments.length >= MAX_ATTACHMENTS) {
      setUploadError(`A message can contain at most ${String(MAX_ATTACHMENTS)} attachments.`);
      return;
    }
    setAttachments((current) =>
      uniqueAttachments([
        ...current,
        {
          objectId: file.id,
          source: "drive",
          filename: file.name,
          mimeType: file.mimeType ?? "application/octet-stream",
          byteSize: Math.max(1, file.byteSize ?? 1),
        },
      ]),
    );
    setDriveOpen(false);
  };

  const wrapSelection = (kind: "inline" | "fenced") => {
    const textarea = textareaRef.current;
    if (textarea === null) return;
    const result = applyCodeMarkup(draft, textarea.selectionStart, textarea.selectionEnd, kind);
    handleChange(result.value);
    requestAnimationFrame(() => {
      textarea.focus();
      textarea.setSelectionRange(result.selectionStart, result.selectionEnd);
    });
  };

  const submit = () => {
    const body = draft.trim();
    if ((body.length === 0 && attachments.length === 0) || uploading > 0) return;
    onSend({
      body,
      bodyFormat: body.includes("`") ? "markdown" : "plain",
      attachmentObjectIds: attachments.map(({ objectId }) => objectId),
      attachments,
    });
    setDraft("");
    setAttachments([]);
    setUploadError(null);
    stopTyping();
  };

  return (
    <div
      className={`chat-composer-wrap${compact ? " chat-composer-wrap-compact" : ""}`}
      onDragOver={(event) => {
        if (hasFiles(event)) event.preventDefault();
      }}
      onDrop={(event) => {
        if (!hasFiles(event)) return;
        event.preventDefault();
        void addUploads([...event.dataTransfer.files]);
      }}
    >
      <div className="chat-composer">
        <div className="chat-composer-toolbar chat-composer-toolbar-top">
          <ToolbarButton
            label="Inline code"
            disabled={disabled}
            onClick={() => {
              wrapSelection("inline");
            }}
          >
            <Icons.Code size={16} />
          </ToolbarButton>
          <ToolbarButton
            label="Code block"
            disabled={disabled}
            onClick={() => {
              wrapSelection("fenced");
            }}
          >
            <span aria-hidden="true">```</span>
          </ToolbarButton>
          <span className="chat-composer-hint">Markdown code supported</span>
        </div>
        {attachments.length > 0 ? (
          <div className="chat-composer-attachments" aria-label="Pending attachments">
            {attachments.map((attachment) => (
              <div key={attachment.objectId} className="chat-composer-attachment">
                {attachment.source === "chat" ? (
                  <img src={chatAttachmentContentUrl(attachment.objectId)} alt="" />
                ) : (
                  <Icons.Drive size={18} aria-hidden="true" />
                )}
                <span>{attachment.filename}</span>
                <button
                  type="button"
                  aria-label={`Remove ${attachment.filename}`}
                  onClick={() => {
                    setAttachments((current) =>
                      current.filter(({ objectId }) => objectId !== attachment.objectId),
                    );
                  }}
                >
                  <Icons.X size={12} />
                </button>
              </div>
            ))}
          </div>
        ) : null}
        <textarea
          ref={textareaRef}
          className="chat-composer-input"
          rows={compact ? 2 : 4}
          placeholder={placeholder}
          aria-label={placeholder}
          value={draft}
          disabled={disabled}
          onChange={(event) => {
            handleChange(event.target.value);
          }}
          onPaste={(event) => {
            const images = [...event.clipboardData.files].filter((file) =>
              file.type.startsWith("image/"),
            );
            if (images.length > 0) {
              event.preventDefault();
              void addUploads(images);
            }
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              submit();
            }
          }}
        />
        {uploadError === null ? null : (
          <div className="chat-composer-error" role="alert">
            {uploadError}
          </div>
        )}
        {driveOpen ? (
          <div className="chat-drive-picker" role="dialog" aria-label="Attach from Drive">
            {driveLoading ? <span>Loading Drive…</span> : null}
            {!driveLoading && driveFiles.length === 0 ? <span>No Drive files found.</span> : null}
            {driveFiles.map((file) => (
              <button
                key={file.id}
                type="button"
                onClick={() => {
                  attachDriveFile(file);
                }}
              >
                <Icons.Drive size={15} />
                <span>{file.name}</span>
              </button>
            ))}
          </div>
        ) : null}
        <div className="chat-composer-toolbar">
          <input
            ref={fileInputRef}
            className="chat-composer-file-input"
            type="file"
            accept="image/png,image/jpeg,image/gif,image/webp"
            multiple
            onChange={(event) => {
              void addUploads([...(event.target.files ?? [])]);
              event.target.value = "";
            }}
          />
          <ToolbarButton
            label="Upload image"
            disabled={disabled || uploading > 0}
            onClick={() => fileInputRef.current?.click()}
          >
            <Icons.Image size={16} />
          </ToolbarButton>
          <ToolbarButton label="Attach from Drive" disabled={disabled} onClick={toggleDrive}>
            <Icons.Drive size={16} />
          </ToolbarButton>
          {uploading > 0 ? <span className="chat-composer-status">Scanning…</span> : null}
          <div className="chat-composer-spacer" />
          <button
            type="button"
            className="btn primary sm"
            disabled={
              disabled || uploading > 0 || (draft.trim().length === 0 && attachments.length === 0)
            }
            onClick={submit}
          >
            <Icons.Send size={14} />
            Send
          </button>
        </div>
      </div>
    </div>
  );
}

function ToolbarButton({
  label,
  disabled = false,
  onClick,
  children,
}: {
  readonly label: string;
  readonly disabled?: boolean;
  readonly onClick: () => void;
  readonly children: ReactNode;
}) {
  return (
    <Tooltip label={label} side="bottom">
      <button
        type="button"
        className="icon-btn"
        aria-label={label}
        disabled={disabled}
        onClick={onClick}
      >
        {children}
      </button>
    </Tooltip>
  );
}

function uniqueAttachments(
  attachments: readonly ChatAttachmentRecord[],
): readonly ChatAttachmentRecord[] {
  return [...new Map(attachments.map((attachment) => [attachment.objectId, attachment])).values()];
}

function hasFiles(event: DragEvent<HTMLElement>): boolean {
  return event.dataTransfer.types.includes("Files");
}
