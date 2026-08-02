// Mail compose surface (extracted from mail-shell for UX.16 budget).
import { useCallback, useEffect, useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Icons } from "@/components/icons";
import { Dialog } from "@/components/ui/helix-dialog";
import { useUnsavedChangesWarning } from "@/lib/use-unsaved-changes-warning";
import { useDebouncer } from "@tanstack/react-pacer/debouncer";
import {
  cancelOutboundMail,
  getMailOutbound,
  listMailDrafts,
  saveMailDraft,
  sendMail,
  type MailAttachment,
  type MailSendInput,
  type MailSendResult,
} from "./api";
import {
  clearMailComposeRecovery,
  hasMailComposeContent,
  invalidRecipientTokens,
  readMailComposeRecovery,
  reconcileMailComposeDrafts,
  writeMailComposeRecovery,
  type MailComposeRecovery,
} from "./mail-compose-recovery";
import {
  filterMailDraftRecords,
  hydrationFromReconcile,
  pickLatestMailDraft,
  serverDraftToComposeFields,
} from "./mail-compose-server-draft";
import {
  mapMailSendUiStatus,
  shouldPollMailSendStatus,
  type MailSendStatusSource,
  type MailSendUiStatus,
} from "./mail-send-status";

function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

/* ------------------------------------------------------------------ compose */

interface ComposeProps {
  readonly onClose: () => void;
  readonly onSent: () => void;
}

/** Parses a comma/semicolon-separated recipient string into addresses. */
export function parseRecipients(raw: string): MailSendInput["to"] {
  return raw
    .split(/[,;]/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .map((address) => ({ address }));
}

/**
 * Reads a File into a base-64 string asynchronously.
 * Strips the "data:<type>;base64," prefix produced by FileReader so the
 * backend receives a plain base-64 payload.
 */
function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== "string") {
        reject(new Error("FileReader did not return a string"));
        return;
      }
      // "data:<mime>;base64,<data>" → keep only <data>
      const comma = result.indexOf(",");
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => {
      reject(reader.error ?? new Error("FileReader error"));
    };
    reader.readAsDataURL(file);
  });
}

export function Compose({ onClose, onSent }: ComposeProps) {
  // Local-only hydrate first; server draft reconcile runs after listMailDrafts (UX.10).
  const [to, setTo] = useState("");
  const [cc, setCc] = useState("");
  const [bcc, setBcc] = useState("");
  const [showCc, setShowCc] = useState(false);
  const [showBcc, setShowBcc] = useState(false);
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [showRecoveryNotice, setShowRecoveryNotice] = useState(false);
  const [composeConflict, setComposeConflict] = useState<{
    readonly local: MailComposeRecovery;
    readonly server: {
      readonly to: string;
      readonly cc: string;
      readonly bcc: string;
      readonly subject: string;
      readonly body: string;
      readonly updatedAt?: string;
    };
    readonly serverDraftId: string;
    readonly serverVersion: number;
  } | null>(null);
  const [serverReconcileDone, setServerReconcileDone] = useState(false);
  const [minimized, setMinimized] = useState(false);
  const [confirmDiscardOpen, setConfirmDiscardOpen] = useState(false);
  const [recipientError, setRecipientError] = useState<string | null>(null);
  /** Last real send/outbound fields; UI phase is derived via mapMailSendUiStatus. */
  const [sendSource, setSendSource] = useState<MailSendStatusSource | null>(null);
  const [statusClockMs, setStatusClockMs] = useState(() => Date.now());
  const [cancelError, setCancelError] = useState<string | null>(null);
  const [attachments, setAttachments] = useState<readonly MailAttachment[]>([]);
  const [draftId, setDraftId] = useState<string | null>(null);
  const [draftVersion, setDraftVersion] = useState<number | null>(null);
  const [draftSaveError, setDraftSaveError] = useState<string | null>(null);
  const sendStatus: MailSendUiStatus | null =
    sendSource === null ? null : mapMailSendUiStatus(sendSource, statusClockMs);
  /** Drag-enter depth counter — incremented on dragenter, decremented on
   *  dragleave.  The overlay shows while > 0, which prevents flickering when
   *  the cursor moves over child elements (each child fires its own enter/leave
   *  pair without the counter ever reaching zero). */
  const dragDepth = useRef(0);
  const [isDragOver, setIsDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const toInputRef = useRef<HTMLInputElement>(null);
  const ccInputRef = useRef<HTMLInputElement>(null);
  const bccInputRef = useRef<HTMLInputElement>(null);
  const skipRecoveryFlushRef = useRef(false);
  const hasDraft = hasMailComposeContent({ to, cc, bcc, subject, body }) || attachments.length > 0;
  const recoveryDebouncer = useDebouncer(
    (draft: { to: string; cc: string; bcc: string; subject: string; body: string }) => {
      writeMailComposeRecovery(draft);
    },
    {
      wait: 400,
      onUnmount: (debouncer) => {
        if (skipRecoveryFlushRef.current) {
          debouncer.cancel();
        } else {
          debouncer.flush();
        }
      },
    },
  );
  const unsavedChangesWarning = useUnsavedChangesWarning(hasDraft, "unsent message", {
    message:
      "This message is saved on this device. You can leave now and recover it the next time you open Compose.",
    leaveLabel: "Leave and keep draft",
  });

  useEffect(() => {
    if (hasDraft) {
      recoveryDebouncer.maybeExecute({ to, cc, bcc, subject, body });
    } else {
      recoveryDebouncer.cancel();
      clearMailComposeRecovery();
    }
  }, [bcc, body, cc, hasDraft, recoveryDebouncer, subject, to]);

  // UX.10 — load latest server draft and reconcile with local crash recovery.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const local = readMailComposeRecovery();
      let serverDraft = null as ReturnType<typeof pickLatestMailDraft>;
      try {
        const listed = await listMailDrafts();
        serverDraft = pickLatestMailDraft(filterMailDraftRecords(listed));
      } catch {
        serverDraft = null;
      }
      if (cancelled) {
        return;
      }
      const decision = reconcileMailComposeDrafts({
        local,
        server: serverDraft === null ? null : serverDraftToComposeFields(serverDraft),
      });
      const hydration = hydrationFromReconcile({ decision, serverDraft });
      if (hydration.kind === "empty") {
        setServerReconcileDone(true);
        return;
      }
      if (hydration.kind === "conflict") {
        setComposeConflict({
          local: hydration.local,
          server: hydration.server,
          serverDraftId: hydration.serverDraftId,
          serverVersion: hydration.serverVersion,
        });
        setServerReconcileDone(true);
        return;
      }
      if (hydration.clearLocal) {
        clearMailComposeRecovery();
      }
      setTo(hydration.fields.to);
      setCc(hydration.fields.cc);
      setBcc(hydration.fields.bcc);
      setShowCc(hydration.fields.cc.length > 0);
      setShowBcc(hydration.fields.bcc.length > 0);
      setSubject(hydration.fields.subject);
      setBody(hydration.fields.body);
      setShowRecoveryNotice(hydration.recoveryNotice);
      if (hydration.serverDraftId !== undefined) {
        setDraftId(hydration.serverDraftId);
      }
      if (hydration.serverVersion !== undefined) {
        setDraftVersion(hydration.serverVersion);
      }
      setServerReconcileDone(true);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const applyComposeFields = (fields: {
    readonly to: string;
    readonly cc: string;
    readonly bcc: string;
    readonly subject: string;
    readonly body: string;
  }) => {
    setTo(fields.to);
    setCc(fields.cc);
    setBcc(fields.bcc);
    setShowCc(fields.cc.length > 0);
    setShowBcc(fields.bcc.length > 0);
    setSubject(fields.subject);
    setBody(fields.body);
  };

  const sendMutation = useMutation({
    mutationFn: (input: MailSendInput) => sendMail(input),
    onMutate: () => {
      setCancelError(null);
      setSendSource({ clientPhase: "submitting" });
      setStatusClockMs(Date.now());
    },
    onError: (error: unknown) => {
      const message = error instanceof Error ? error.message : null;
      setSendSource({
        clientPhase: "error",
        ...(message === null ? {} : { lastError: message }),
      });
      setStatusClockMs(Date.now());
    },
    onSuccess: (result: MailSendResult) => {
      skipRecoveryFlushRef.current = true;
      recoveryDebouncer.cancel();
      clearMailComposeRecovery();
      onSent();
      setSendSource(result);
      setStatusClockMs(Date.now());
      const ui = mapMailSendUiStatus(result);
      // No durable outbound / already terminal sent: close immediately.
      if (ui.phase === "sent" || (ui.phase === "idle" && ui.outboundId === null)) {
        onClose();
      }
    },
  });

  const cancelMutation = useMutation({
    mutationFn: (outboundId: string) => cancelOutboundMail(outboundId),
    onMutate: () => {
      setCancelError(null);
    },
    onError: (error: unknown) => {
      const message =
        error instanceof Error && error.message.trim().length > 0
          ? error.message
          : "Could not undo send. The message may already be leaving the queue.";
      setCancelError(message);
    },
    onSuccess: (outbound) => {
      if (outbound === null) {
        setCancelError("Undo is no longer available for this message.");
        return;
      }
      setSendSource(outbound);
      setStatusClockMs(Date.now());
      onSent();
    },
  });

  // Advance the clock so undoAvailable flips when undoUntil elapses.
  useEffect(() => {
    if (sendStatus === null) return;
    if (!sendStatus.undoAvailable && !shouldPollMailSendStatus(sendStatus.phase)) return;
    const id = window.setInterval(() => {
      setStatusClockMs(Date.now());
    }, 400);
    return () => {
      window.clearInterval(id);
    };
  }, [sendStatus?.phase, sendStatus?.undoAvailable]);

  // Poll outbound delivery while queued/sending/delayed so the UI tracks real status.
  useEffect(() => {
    if (sendStatus === null) return;
    if (!shouldPollMailSendStatus(sendStatus.phase)) return;
    const outboundId = sendStatus.outboundId;
    if (outboundId === null) return;

    let cancelled = false;
    const tick = async () => {
      try {
        const outbound = await getMailOutbound(outboundId);
        if (cancelled || outbound === null) return;
        setSendSource(outbound);
        setStatusClockMs(Date.now());
      } catch {
        // Keep last honest status; next poll may recover. Do not invent "sent".
      }
    };

    void tick();
    const intervalId = window.setInterval(() => {
      void tick();
    }, 1_500);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [sendStatus?.outboundId, sendStatus?.phase]);

  // Auto-close after terminal success / cancel so status is briefly visible.
  useEffect(() => {
    if (sendStatus === null) return;
    if (sendStatus.phase !== "sent" && sendStatus.phase !== "cancelled") return;
    const timeoutId = window.setTimeout(() => {
      onClose();
    }, 1_200);
    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [onClose, sendStatus?.phase]);

  const saveDraft = useCallback(() => {
    if (to.trim().length === 0 && subject.trim().length === 0 && body.trim().length === 0) {
      return;
    }
    void saveMailDraft({
      ...(draftId === null ? {} : { id: draftId }),
      ...(draftVersion === null ? {} : { expectedVersion: draftVersion }),
      to: parseRecipients(to),
      cc: parseRecipients(cc),
      bcc: parseRecipients(bcc),
      subject,
      bodyText: body,
      attachments,
    })
      .then((saved) => {
        setDraftId(saved.id);
        setDraftVersion(saved.version);
        setDraftSaveError(null);
        // Server draft is authority for matching content — drop local crash copy.
        clearMailComposeRecovery();
      })
      .catch(() => {
        setDraftSaveError(
          "Draft was not saved. It may have changed on another device; reload before retrying.",
        );
      });
  }, [attachments, bcc, body, cc, draftId, draftVersion, subject, to]);

  const recipients = parseRecipients(to);
  const canSend =
    recipients.length > 0 &&
    !sendMutation.isPending &&
    (sendStatus === null || sendStatus.phase === "failed" || sendStatus.phase === "idle");

  const handleSend = useCallback(() => {
    if (recipients.length === 0) {
      setRecipientError("Enter at least one recipient email address.");
      toInputRef.current?.focus();
      return;
    }
    const invalidGroups = [
      { label: "To", invalid: invalidRecipientTokens(to), ref: toInputRef },
      { label: "Cc", invalid: invalidRecipientTokens(cc), ref: ccInputRef },
      { label: "Bcc", invalid: invalidRecipientTokens(bcc), ref: bccInputRef },
    ].filter((group) => group.invalid.length > 0);
    const firstInvalid = invalidGroups[0];
    if (firstInvalid !== undefined) {
      setRecipientError(
        `${firstInvalid.label} contains invalid email ${firstInvalid.invalid.length === 1 ? "address" : "addresses"}: ${firstInvalid.invalid.join(", ")}.`,
      );
      if (firstInvalid.label === "Cc") setShowCc(true);
      if (firstInvalid.label === "Bcc") setShowBcc(true);
      queueMicrotask(() => firstInvalid.ref.current?.focus());
      return;
    }
    setRecipientError(null);
    sendMutation.mutate({
      to: recipients,
      cc: parseRecipients(cc),
      bcc: parseRecipients(bcc),
      subject,
      bodyText: body,
      attachments: attachments.length > 0 ? attachments : undefined,
    });
  }, [attachments, bcc, body, cc, recipients, sendMutation, subject, to]);

  const requestClose = useCallback(() => {
    if (hasDraft) {
      setConfirmDiscardOpen(true);
      return;
    }
    onClose();
  }, [hasDraft, onClose]);

  const discardDraft = useCallback(() => {
    skipRecoveryFlushRef.current = true;
    recoveryDebouncer.cancel();
    clearMailComposeRecovery();
    setConfirmDiscardOpen(false);
    onClose();
  }, [onClose, recoveryDebouncer]);

  /** Convert a FileList (from picker or drop) into MailAttachment records and
   *  append them to the current attachment list. */
  const attachFiles = useCallback(async (files: FileList | File[]) => {
    const fileArray = Array.from(files);
    const resolved = await Promise.all(
      fileArray.map(async (file) => {
        const content = await fileToBase64(file);
        const attachment: MailAttachment = {
          filename: file.name,
          contentType: file.type !== "" ? file.type : "application/octet-stream",
          content,
        };
        return attachment;
      }),
    );
    setAttachments((prev) => [...prev, ...resolved]);
  }, []);

  const handleDragEnter = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    dragDepth.current += 1;
    if (dragDepth.current === 1) {
      setIsDragOver(true);
    }
  }, []);

  const handleDragOver = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    // Setting dropEffect signals to the browser that a drop is accepted.
    event.dataTransfer.dropEffect = "copy";
  }, []);

  const handleDragLeave = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    dragDepth.current -= 1;
    if (dragDepth.current <= 0) {
      dragDepth.current = 0;
      setIsDragOver(false);
    }
  }, []);

  const handleDrop = useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      event.preventDefault();
      dragDepth.current = 0;
      setIsDragOver(false);
      const { files } = event.dataTransfer;
      if (files.length > 0) {
        void attachFiles(files);
      }
    },
    [attachFiles],
  );

  const handleFileInputChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const { files } = event.target;
      if (files !== null && files.length > 0) {
        void attachFiles(files);
      }
      // Reset the input so the same file can be re-selected if removed.
      event.target.value = "";
    },
    [attachFiles],
  );

  const removeAttachment = useCallback((index: number) => {
    setAttachments((prev) => prev.filter((_, idx) => idx !== index));
  }, []);

  return (
    <div
      className={cx("compose", "compose-drop-root", minimized && "compose-minimized")}
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {isDragOver && (
        <div className="compose-drop-overlay" aria-label="Drop files to attach">
          <Icons.Paperclip />
          Drop files to attach
        </div>
      )}
      {/* Hidden file input — triggered by the Attach toolbar button */}
      <input
        ref={fileInputRef}
        type="file"
        multiple
        aria-label="Attach files"
        style={{ display: "none" }}
        onChange={handleFileInputChange}
      />
      <div className="compose-header">
        <span>New message</span>
        <div style={{ display: "flex", gap: 2 }}>
          <button
            type="button"
            className="icon-btn"
            aria-label={minimized ? "Expand compose" : "Minimize"}
            aria-pressed={minimized}
            onClick={() => setMinimized((value) => !value)}
          >
            <Icons.ChevronDown />
          </button>
          <button type="button" className="icon-btn" aria-label="Close" onClick={requestClose}>
            <Icons.X />
          </button>
        </div>
      </div>
      {showRecoveryNotice ? (
        <div className="compose-recovery" role="status" aria-live="polite">
          <span>Restored unsent message from this device. Attachments were not recovered.</span>
          <button
            type="button"
            className="icon-btn"
            aria-label="Dismiss recovery notice"
            onClick={() => setShowRecoveryNotice(false)}
          >
            <Icons.X />
          </button>
        </div>
      ) : null}
      {recipientError !== null ? (
        <p className="compose-inline-error" role="alert">
          {recipientError}
        </p>
      ) : null}
      {!minimized ? (
        <>
          <div style={{ padding: "8px 14px", borderBottom: "1px solid var(--border)" }}>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                padding: "4px 0",
                borderBottom: "1px solid var(--border)",
              }}
            >
              <span style={{ fontSize: "var(--text-meta)", color: "var(--text-3)", width: 50 }}>
                To
              </span>
              <input
                ref={toInputRef}
                value={to}
                onChange={(event) => {
                  setTo(event.target.value);
                  setRecipientError(null);
                }}
                onBlur={saveDraft}
                aria-label="To"
                aria-invalid={recipientError !== null ? true : undefined}
                style={{
                  flex: 1,
                  border: "none",
                  outline: "none",
                  background: "transparent",
                  fontSize: "var(--text-body-sm)",
                }}
              />
              <button
                type="button"
                aria-pressed={showCc}
                onClick={() => {
                  setShowCc((value) => !value);
                }}
                style={{ fontSize: "var(--text-caption)", color: "var(--text-3)" }}
              >
                Cc
              </button>
              <span style={{ margin: "0 6px", color: "var(--text-3)" }}>·</span>
              <button
                type="button"
                aria-pressed={showBcc}
                onClick={() => {
                  setShowBcc((value) => !value);
                }}
                style={{ fontSize: "var(--text-caption)", color: "var(--text-3)" }}
              >
                Bcc
              </button>
            </div>
            {showCc && (
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  padding: "4px 0",
                  borderBottom: "1px solid var(--border)",
                }}
              >
                <span style={{ fontSize: "var(--text-meta)", color: "var(--text-3)", width: 50 }}>
                  Cc
                </span>
                <input
                  ref={ccInputRef}
                  value={cc}
                  onChange={(event) => {
                    setCc(event.target.value);
                    setRecipientError(null);
                  }}
                  onBlur={saveDraft}
                  aria-label="Cc"
                  style={{
                    flex: 1,
                    border: "none",
                    outline: "none",
                    background: "transparent",
                    fontSize: "var(--text-body-sm)",
                  }}
                />
              </div>
            )}
            {showBcc && (
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  padding: "4px 0",
                  borderBottom: "1px solid var(--border)",
                }}
              >
                <span style={{ fontSize: "var(--text-meta)", color: "var(--text-3)", width: 50 }}>
                  Bcc
                </span>
                <input
                  ref={bccInputRef}
                  value={bcc}
                  onChange={(event) => {
                    setBcc(event.target.value);
                    setRecipientError(null);
                  }}
                  onBlur={saveDraft}
                  aria-label="Bcc"
                  style={{
                    flex: 1,
                    border: "none",
                    outline: "none",
                    background: "transparent",
                    fontSize: "var(--text-body-sm)",
                  }}
                />
              </div>
            )}
            <div style={{ padding: "4px 0" }}>
              <input
                value={subject}
                onChange={(event) => {
                  setSubject(event.target.value);
                }}
                onBlur={saveDraft}
                placeholder="Subject"
                aria-label="Subject"
                style={{
                  width: "100%",
                  border: "none",
                  outline: "none",
                  background: "transparent",
                  fontSize: "var(--text-body-sm)",
                  fontWeight: 500,
                }}
              />
            </div>
          </div>
          <textarea
            value={body}
            onChange={(event) => {
              setBody(event.target.value);
            }}
            onBlur={saveDraft}
            placeholder="Write your message…"
            aria-label="Message body"
            style={{
              width: "100%",
              minHeight: 200,
              padding: 14,
              border: "none",
              outline: "none",
              background: "transparent",
              fontSize: "var(--text-body-sm)",
              lineHeight: 1.55,
              resize: "none",
              fontFamily: "inherit",
            }}
          />
          {attachments.length > 0 && (
            <div className="compose-attachments" aria-label="Attached files">
              {attachments.map((attachment, index) => (
                <div
                  key={`${attachment.filename ?? "attachment"}-${String(index)}`}
                  className="compose-attachment-chip"
                >
                  <Icons.Paperclip />
                  <span title={attachment.filename}>{attachment.filename}</span>
                  <button
                    type="button"
                    aria-label={`Remove attachment ${attachment.filename ?? "attachment"}`}
                    onClick={() => {
                      removeAttachment(index);
                    }}
                  >
                    <Icons.X size={10} />
                  </button>
                </div>
              ))}
            </div>
          )}
          {sendStatus !== null && sendStatus.phase !== "idle" ? (
            <div
              className="compose-send-status"
              role="status"
              aria-live="polite"
              data-send-phase={sendStatus.phase}
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 12,
                margin: "0 14px 8px",
                padding: "8px 12px",
                borderRadius: 8,
                background: "var(--surface-2)",
                fontSize: "var(--text-body-sm)",
                color:
                  sendStatus.phase === "failed"
                    ? "var(--danger)"
                    : sendStatus.phase === "sent" || sendStatus.phase === "cancelled"
                      ? "var(--text-2)"
                      : "var(--text-1)",
              }}
            >
              <span>{sendStatus.label}</span>
              {sendStatus.undoAvailable && sendStatus.outboundId !== null ? (
                <button
                  type="button"
                  onClick={() => {
                    const outboundId = sendStatus.outboundId;
                    if (outboundId === null) return;
                    cancelMutation.mutate(outboundId);
                  }}
                  disabled={cancelMutation.isPending}
                >
                  {cancelMutation.isPending ? "Undoing…" : "Undo"}
                </button>
              ) : null}
            </div>
          ) : null}
          {cancelError !== null ? (
            <div
              role="alert"
              style={{
                margin: "0 14px 8px",
                fontSize: "var(--text-caption)",
                color: "var(--danger)",
              }}
            >
              {cancelError}
            </div>
          ) : null}
          {draftSaveError !== null && (
            <div
              role="alert"
              style={{
                margin: "0 14px 8px",
                fontSize: "var(--text-caption)",
                color: "var(--danger)",
              }}
            >
              {draftSaveError}
            </div>
          )}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 4,
              padding: "8px 12px",
              borderTop: "1px solid var(--border)",
            }}
          >
            <div style={{ display: "flex" }}>
              <button
                type="button"
                className="btn primary"
                disabled={!canSend}
                onClick={handleSend}
              >
                <Icons.Send />{" "}
                {sendStatus?.phase === "submitting" || sendMutation.isPending
                  ? "Sending…"
                  : "Send"}
              </button>
              <button
                type="button"
                className="btn primary icon"
                aria-label="Schedule send"
                disabled
                title="Scheduled send is not available yet"
                style={{
                  borderLeft: "1px solid rgba(255,255,255,0.2)",
                  marginLeft: 1,
                  borderRadius: "0 6px 6px 0",
                }}
              >
                <Icons.ChevronDown />
              </button>
            </div>
            <button
              type="button"
              className="icon-btn"
              aria-label="Attach"
              onClick={() => {
                fileInputRef.current?.click();
              }}
            >
              <Icons.Paperclip />
            </button>
            <button
              type="button"
              className="icon-btn"
              aria-label="Insert link"
              disabled
              title="Link insertion is not available yet"
            >
              <Icons.Link />
            </button>
            <button
              type="button"
              className="icon-btn"
              aria-label="Emoji"
              disabled
              title="Emoji insertion is not available yet"
            >
              <Icons.Smile />
            </button>
            <button
              type="button"
              className="icon-btn"
              aria-label="Insert image"
              disabled
              title="Inline image insertion is not available yet"
            >
              <Icons.Image />
            </button>
            <button
              type="button"
              className="icon-btn"
              aria-label="AI assist"
              disabled
              title="AI assist is not available yet"
            >
              <Icons.Sparkles />
            </button>
            <button
              type="button"
              className="icon-btn"
              aria-label="Discard draft"
              style={{ marginLeft: "auto" }}
              onClick={() => setConfirmDiscardOpen(true)}
            >
              <Icons.Trash />
            </button>
          </div>
        </>
      ) : null}
      {unsavedChangesWarning}
      {composeConflict !== null ? (
        <Dialog
          title="Draft conflict"
          onClose={() => {
            // Prefer server on dismiss so we never silent-overwrite server content.
            applyComposeFields(composeConflict.server);
            setDraftId(composeConflict.serverDraftId || null);
            setDraftVersion(composeConflict.serverVersion);
            clearMailComposeRecovery();
            setShowRecoveryNotice(false);
            setComposeConflict(null);
          }}
          footer={
            <>
              <button
                type="button"
                className="btn"
                onClick={() => {
                  applyComposeFields(composeConflict.server);
                  setDraftId(composeConflict.serverDraftId || null);
                  setDraftVersion(composeConflict.serverVersion);
                  clearMailComposeRecovery();
                  setShowRecoveryNotice(false);
                  setComposeConflict(null);
                }}
              >
                Keep server draft
              </button>
              <button
                type="button"
                className="btn primary"
                onClick={() => {
                  applyComposeFields(composeConflict.local);
                  setShowRecoveryNotice(true);
                  setComposeConflict(null);
                }}
              >
                Restore local recovery
              </button>
            </>
          }
        >
          <p>
            This device has a recovered draft that differs from the server draft. Choose which copy
            to keep. Local recovery never overwrites the server draft without your choice.
          </p>
          <p style={{ fontSize: "var(--text-meta)", color: "var(--text-secondary)" }}>
            Server subject: {composeConflict.server.subject || "(empty)"} · Local subject:{" "}
            {composeConflict.local.subject || "(empty)"}
          </p>
        </Dialog>
      ) : null}
      {confirmDiscardOpen ? (
        <Dialog
          title="Discard this draft?"
          onClose={() => setConfirmDiscardOpen(false)}
          footer={
            <>
              <button type="button" className="btn" onClick={() => setConfirmDiscardOpen(false)}>
                Keep editing
              </button>
              <button type="button" className="btn danger" onClick={discardDraft}>
                Discard draft
              </button>
            </>
          }
        >
          <p>
            This removes the local recovery copy on this device. Server drafts are unchanged until
            you delete them separately.
          </p>
        </Dialog>
      ) : null}
      {!serverReconcileDone ? (
        <span className="sr-only" role="status">
          Checking server drafts for conflicts
        </span>
      ) : null}
    </div>
  );
}

