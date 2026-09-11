import { MailSenderSelect, useMailSender } from "./mail-sender-select";
import { MailRecipientField } from "./mail-recipient-field";
import { Dialog } from "@/components/ui/helix-dialog";
import { trashDriveObject, uploadDriveFile } from "@/features/drive/api";
import { useUnsavedChangesWarning } from "@/lib/use-unsaved-changes-warning";
import { cn as cx } from "@/lib/utils";
import type { MailDraft } from "@helix/contracts";
import { useDebouncer } from "@tanstack/react-pacer/debouncer";
import { useMutation } from "@tanstack/react-query";
import {
  ChevronDown as ChevronDownIcon,
  Paperclip as PaperclipIcon,
  Send as SendIcon,
  Trash2 as TrashIcon,
  X as XIcon,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  cancelOutboundMail,
  discardMailDraft,
  listMailDrafts,
  saveMailDraft,
  sendMail,
  validateMailAttachmentSelection,
  type MailAttachment,
  type MailSendInput,
  type MailSendResult,
} from "./api";
import {
  clearMailComposeRecovery,
  hasMailComposeContent,
  invalidRecipientTokens,
  readMailComposeRecovery,
  recipientTokens,
  writeMailComposeRecovery,
} from "./mail-compose-recovery";
import {
  filterMailDraftRecords,
  pickLatestMailDraft,
  serverDraftToComposeFields,
} from "./mail-compose-server-draft";

interface ComposeProps {
  readonly onClose: () => void;
  readonly onSent: () => void;
}

export function parseRecipients(raw: string): MailSendInput["to"] {
  return recipientTokens(raw).map((address) => ({ address }));
}

function addressesText(addresses: readonly { readonly address: string }[] | undefined): string {
  return addresses?.map(({ address }) => address).join(", ") ?? "";
}

export function Compose({ onClose, onSent }: ComposeProps) {
  const [recoveredDraft] = useState(readMailComposeRecovery);
  const sender = useMailSender(recoveredDraft?.from?.address);
  const { from, setFrom } = sender;
  const [to, setTo] = useState(addressesText(recoveredDraft?.to));
  const [cc, setCc] = useState(addressesText(recoveredDraft?.cc));
  const [bcc, setBcc] = useState(addressesText(recoveredDraft?.bcc));
  const [showCc, setShowCc] = useState((recoveredDraft?.cc.length ?? 0) > 0);
  const [showBcc, setShowBcc] = useState((recoveredDraft?.bcc.length ?? 0) > 0);
  const [subject, setSubject] = useState(recoveredDraft?.subject ?? "");
  const [body, setBody] = useState(recoveredDraft?.bodyText ?? "");
  const [sendAt, setSendAt] = useState("");
  const [showRecoveryNotice, setShowRecoveryNotice] = useState(recoveredDraft !== null);
  const [minimized, setMinimized] = useState(false);
  const [confirmDiscardOpen, setConfirmDiscardOpen] = useState(false);
  const [recipientError, setRecipientError] = useState<string | null>(null);
  const [sendFailed, setSendFailed] = useState(false);
  const [attachments, setAttachments] = useState<readonly MailAttachment[]>(
    recoveredDraft?.attachments ?? [],
  );
  const [attaching, setAttaching] = useState(false);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const draftRef = useRef<{ readonly id: string; readonly revision: number } | null>(
    recoveredDraft?.id === undefined || recoveredDraft.expectedRevision === undefined
      ? null
      : { id: recoveredDraft.id, revision: recoveredDraft.expectedRevision },
  );
  const [serverDraftChoice, setServerDraftChoice] = useState<MailDraft | null>(null);
  const [serverDraftError, setServerDraftError] = useState<string | null>(null);
  const saveQueueRef = useRef(Promise.resolve());
  const pendingDraftSaveRef = useRef<Parameters<typeof saveMailDraft>[0] | null>(null);
  const sendingRef = useRef(false);
  const sendAttemptRef = useRef<{ payload: string; key: string } | null>(null);
  const [undo, setUndo] = useState<{
    readonly outboundId: string;
    readonly untilMs: number;
    readonly scheduledAt?: string;
  } | null>(null);
  /** Drag-enter depth counter — incremented on dragenter, decremented on
   *  dragleave.  The overlay shows while > 0, which prevents flickering when
   *  the cursor moves over child elements (each child fires its own enter/leave
   *  pair without the counter ever reaching zero). */
  const dragDepth = useRef(0);
  const [isDragOver, setIsDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const newAttachmentIds = useRef(new Set<string>());
  const attachmentUploadRef = useRef<AbortController | null>(null);
  const toInputRef = useRef<HTMLInputElement>(null);
  const ccInputRef = useRef<HTMLInputElement>(null);
  const bccInputRef = useRef<HTMLInputElement>(null);
  const skipRecoveryFlushRef = useRef(false);
  const canonicalDraft = {
    ...(from ? { from: { address: from } } : {}),
    to: parseRecipients(to),
    cc: parseRecipients(cc),
    bcc: parseRecipients(bcc),
    subject,
    bodyText: body,
    attachments,
  };
  const hasDraft = hasMailComposeContent(canonicalDraft);
  const currentDraftRef = useRef(canonicalDraft);
  currentDraftRef.current = canonicalDraft;
  const applyServerDraft = useCallback(
    (draft: MailDraft) => {
      setFrom(draft.from?.address ?? null);
      setTo(addressesText(draft.to));
      setCc(addressesText(draft.cc));
      setBcc(addressesText(draft.bcc));
      setShowCc(draft.cc.length > 0);
      setShowBcc(draft.bcc.length > 0);
      setSubject(draft.subject);
      setBody(draft.bodyText);
      setAttachments(draft.attachments);
      draftRef.current = { id: draft.id, revision: draft.revision };
      pendingDraftSaveRef.current = null;
      setServerDraftChoice(null);
      setShowRecoveryNotice(false);
    },
    [setFrom],
  );
  useEffect(() => {
    let cancelled = false;
    void listMailDrafts()
      .then((records) => {
        if (cancelled) return;
        const drafts = filterMailDraftRecords(records);
        const draft =
          recoveredDraft?.id === undefined
            ? pickLatestMailDraft(drafts)
            : (drafts.find((candidate) => candidate.id === recoveredDraft.id) ?? null);
        if (draft === null) return;
        const fields = serverDraftToComposeFields(draft);
        if (!hasMailComposeContent(currentDraftRef.current)) applyServerDraft(draft);
        else if (
          JSON.stringify(fields) ===
          JSON.stringify({ ...currentDraftRef.current, updatedAt: draft.updatedAt })
        ) {
          draftRef.current = { id: draft.id, revision: draft.revision };
        } else setServerDraftChoice(draft);
      })
      .catch(() => {
        if (!cancelled)
          setServerDraftError(
            "Server drafts could not be checked. Your message is kept on this device.",
          );
      });
    return () => {
      cancelled = true;
    };
  }, [applyServerDraft, recoveredDraft]);
  const recoveryDebouncer = useDebouncer(
    (draft: typeof canonicalDraft) => {
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
      const current = draftRef.current;
      recoveryDebouncer.maybeExecute({
        ...canonicalDraft,
        ...(current === null ? {} : { id: current.id, expectedRevision: current.revision }),
      });
    } else {
      recoveryDebouncer.cancel();
      clearMailComposeRecovery();
    }
  }, [attachments, bcc, body, cc, from, hasDraft, recoveryDebouncer, subject, to]);

  useEffect(() => () => attachmentUploadRef.current?.abort(), []);

  const persistDraft = useCallback(async (input: Parameters<typeof saveMailDraft>[0]) => {
    pendingDraftSaveRef.current = input;
    const saved = await saveMailDraft(input);
    pendingDraftSaveRef.current = null;
    draftRef.current = { id: saved.id, revision: saved.revision };
    return saved;
  }, []);

  const sendMutation = useMutation({
    mutationFn: async (input: MailSendInput) => {
      await saveQueueRef.current;
      if (pendingDraftSaveRef.current !== null) await persistDraft(pendingDraftSaveRef.current);
      const payload = JSON.stringify(input);
      if (sendAttemptRef.current?.payload !== payload)
        sendAttemptRef.current = { payload, key: crypto.randomUUID() };
      const draft = draftRef.current;
      return sendMail({
        ...input,
        idempotencyKey: sendAttemptRef.current.key,
        ...(draft === null ? {} : { draft }),
      });
    },
    onMutate: () => {
      setSendFailed(false);
      sendingRef.current = true;
    },
    onError: () => {
      setSendFailed(true);
      sendingRef.current = false;
    },
    onSuccess: (result: MailSendResult, input: MailSendInput) => {
      draftRef.current = null;
      skipRecoveryFlushRef.current = true;
      recoveryDebouncer.cancel();
      clearMailComposeRecovery();
      onSent();
      const undoUntil = result.undoUntil;
      const outboundId = result.id ?? result.outboundId;
      if (
        typeof undoUntil === "string" &&
        typeof outboundId === "string" &&
        outboundId.length > 0
      ) {
        const untilMs = Date.parse(undoUntil);
        if (Number.isFinite(untilMs) && untilMs > Date.now()) {
          setUndo({
            outboundId,
            untilMs,
            ...(input.sendAt === undefined ? {} : { scheduledAt: input.sendAt }),
          });
          return;
        }
      }
      onClose();
    },
  });

  const cancelMutation = useMutation({
    onMutate: () => {
      setAttachmentError(null);
    },
    onError: (error: unknown) => {
      setAttachmentError(error instanceof Error ? error.message : "Could not undo send.");
    },
    mutationFn: (outboundId: string) => cancelOutboundMail(outboundId),
    onSuccess: () => {
      setUndo(null);
      sendingRef.current = false;
      sendAttemptRef.current = null;
      skipRecoveryFlushRef.current = false;
      writeMailComposeRecovery(currentDraftRef.current);
      onSent();
    },
  });

  const saveDraft = useCallback(() => {
    if (!hasDraft || serverDraftChoice !== null || sendingRef.current) return;
    const snapshot = canonicalDraft;
    saveQueueRef.current = saveQueueRef.current
      .then(async () => {
        // Retry the exact request after an ambiguous response before creating another revision.
        if (pendingDraftSaveRef.current !== null) await persistDraft(pendingDraftSaveRef.current);
        const current = draftRef.current;
        const saved = await persistDraft({
          ...snapshot,
          to: [...snapshot.to],
          cc: [...snapshot.cc],
          bcc: [...snapshot.bcc],
          attachments: [...snapshot.attachments],
          idempotencyKey: crypto.randomUUID(),
          ...(current === null ? {} : { id: current.id, expectedRevision: current.revision }),
        });
        writeMailComposeRecovery({ ...snapshot, id: saved.id, expectedRevision: saved.revision });
        setAttachmentError(null);
      })
      .catch(async (error: unknown) => {
        setAttachmentError(error instanceof Error ? error.message : "Draft save failed.");
        const current = draftRef.current;
        if (current === null) return;
        const drafts = await listMailDrafts().catch(() => []);
        const latest = filterMailDraftRecords(drafts).find((draft) => draft.id === current.id);
        if (latest !== undefined && latest.revision !== current.revision) {
          pendingDraftSaveRef.current = null;
          setServerDraftChoice(latest);
        }
      });
  }, [attachments, bcc, body, cc, from, hasDraft, persistDraft, serverDraftChoice, subject, to]);

  const recipients = parseRecipients(to);
  const canSend = !sendMutation.isPending && !attaching && sender.authorized;

  const handleSend = useCallback(() => {
    if (!sender.authorized) return;
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
      from: { address: from },
      to: recipients,
      cc: parseRecipients(cc),
      bcc: parseRecipients(bcc),
      subject,
      bodyText: body,
      ...(sendAt === "" ? {} : { sendAt: new Date(sendAt).toISOString() }),
      attachments: attachments.length > 0 ? attachments : undefined,
    });
  }, [
    attachments,
    bcc,
    body,
    cc,
    from,
    recipients,
    sendAt,
    sendMutation,
    sender.authorized,
    subject,
    to,
  ]);

  const requestClose = useCallback(() => {
    if (hasDraft) {
      setConfirmDiscardOpen(true);
      return;
    }
    onClose();
  }, [hasDraft, onClose]);

  const discardMutation = useMutation({
    onMutate: () => {
      sendingRef.current = true;
      attachmentUploadRef.current?.abort();
      setAttachmentError(null);
    },
    mutationFn: async () => {
      await saveQueueRef.current;
      if (pendingDraftSaveRef.current !== null) await persistDraft(pendingDraftSaveRef.current);
      const draft = draftRef.current;
      if (
        draft !== null &&
        !(await discardMailDraft({ id: draft.id, expectedRevision: draft.revision }))
      ) {
        // A previous discard may have committed even if its response was lost.
        const drafts = await listMailDrafts();
        if (drafts.some((candidate) => candidate.id === draft.id)) {
          throw new Error(
            "This draft changed elsewhere. Keep editing and review the server copy before discarding.",
          );
        }
      }
    },
    onError: (error: unknown) => {
      sendingRef.current = false;
      setAttachmentError(error instanceof Error ? error.message : "Draft could not be discarded.");
      setConfirmDiscardOpen(false);
    },
    onSuccess: () => {
      for (const attachment of attachments) {
        if (newAttachmentIds.current.has(attachment.objectId))
          void trashDriveObject(attachment.objectId).catch(() => undefined);
      }
      skipRecoveryFlushRef.current = true;
      recoveryDebouncer.cancel();
      clearMailComposeRecovery();
      setConfirmDiscardOpen(false);
      onClose();
    },
  });

  /** Convert a FileList (from picker or drop) into MailAttachment records and
   *  append them to the current attachment list. */
  const attachFiles = useCallback(
    async (files: FileList | File[]) => {
      const selected = Array.from(files);
      const policyError = validateMailAttachmentSelection(attachments, selected);
      if (policyError !== null) {
        setAttachmentError(policyError);
        return;
      }
      attachmentUploadRef.current?.abort();
      const controller = new AbortController();
      attachmentUploadRef.current = controller;
      setAttaching(true);
      setAttachmentError(null);
      try {
        for (const file of selected) {
          const uploaded = await uploadDriveFile({
            file,
            folderId: null,
            signal: controller.signal,
          });
          newAttachmentIds.current.add(uploaded.objectId);
          setAttachments((prev) => [
            ...prev,
            {
              filename: file.name,
              contentType: file.type !== "" ? file.type : "application/octet-stream",
              objectId: uploaded.objectId,
              byteSize: file.size,
            },
          ]);
        }
      } catch (error) {
        setAttachmentError(
          controller.signal.aborted
            ? "Attachment upload cancelled; selecting the same file will resume it."
            : error instanceof Error
              ? error.message
              : "Attachment upload failed.",
        );
      } finally {
        if (attachmentUploadRef.current === controller) {
          attachmentUploadRef.current = null;
          setAttaching(false);
        }
      }
    },
    [attachments],
  );

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
    setAttachments((prev) => {
      const removed = prev[index];
      if (removed !== undefined) {
        void trashDriveObject(removed.objectId).catch((error: unknown) => {
          setAttachmentError(error instanceof Error ? error.message : "Attachment cleanup failed.");
        });
      }
      return prev.filter((_, idx) => idx !== index);
    });
  }, []);

  return (
    <div
      className={cx("compose compose-drop-root", minimized && "compose-minimized")}
      role="dialog"
      aria-modal="false"
      aria-labelledby="mail-compose-title"
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {isDragOver && (
        <div className="compose-drop-overlay" aria-label="Drop files to attach">
          <PaperclipIcon size={16} />
          Drop files to attach
        </div>
      )}
      {/* Hidden file input — triggered by the Attach toolbar button */}
      <input
        ref={fileInputRef}
        type="file"
        multiple
        aria-label="Attach files"
        className="hidden"
        onChange={handleFileInputChange}
      />
      <div className="compose-header">
        <span id="mail-compose-title" className="truncate">
          {subject.trim().length > 0 ? subject : "New message"}
        </span>
        <div className="flex gap-0.5">
          <button
            type="button"
            className="icon-btn"
            aria-label={minimized ? "Expand compose" : "Minimize compose"}
            aria-expanded={!minimized}
            onClick={() => setMinimized((value) => !value)}
          >
            <ChevronDownIcon
              size={16}
              className={cx(minimized ? "[transform:rotate(180deg)]" : "")}
            />
          </button>
          <button
            type="button"
            className="icon-btn"
            aria-label="Close compose"
            onClick={requestClose}
          >
            <XIcon size={16} />
          </button>
        </div>
      </div>
      {minimized ? null : (
        <>
          {serverDraftError === null ? null : (
            <div className="compose-recovery" role="status">
              {serverDraftError}
            </div>
          )}
          {serverDraftChoice === null ? null : (
            <div className="compose-recovery" role="status">
              <span>
                A different server draft exists: {serverDraftChoice.subject || "Untitled"}. Choose
                which draft to keep editing.
              </span>
              <button
                type="button"
                className="btn sm"
                onClick={() => applyServerDraft(serverDraftChoice)}
              >
                Use server draft
              </button>
              <button
                type="button"
                className="btn sm"
                onClick={() => {
                  draftRef.current = null;
                  pendingDraftSaveRef.current = null;
                  setServerDraftChoice(null);
                }}
              >
                Keep this as a separate draft
              </button>
            </div>
          )}
          {showRecoveryNotice ? (
            <div className="compose-recovery" role="status" aria-live="polite">
              <span>Recovered your unsent message from this device.</span>
              <button
                type="button"
                className="icon-btn"
                aria-label="Dismiss recovery notice"
                onClick={() => setShowRecoveryNotice(false)}
              >
                <XIcon size={16} />
              </button>
            </div>
          ) : null}
          <div className="[padding:8px_14px] [border-bottom:1px_solid_var(--border)]">
            <MailSenderSelect
              sender={sender}
              disabled={sendMutation.isPending}
              onBlur={saveDraft}
            />
            <div className="flex items-center [padding:4px_0] [border-bottom:1px_solid_var(--border)]">
              <span className="[font-size:var(--text-meta)] text-muted-foreground w-12.5">To</span>
              <input
                ref={toInputRef}
                name="mail-compose-to"
                autoComplete="email"
                inputMode="email"
                spellCheck={false}
                value={to}
                onChange={(event) => {
                  setTo(event.target.value);
                  setRecipientError(null);
                }}
                aria-label="To"
                aria-invalid={recipientError !== null}
                aria-describedby={
                  recipientError === null ? undefined : "mail-compose-recipient-error"
                }
                className="flex-1 [border:none] outline-none bg-transparent [font-size:var(--text-body-sm)]"
              />
              <button
                type="button"
                aria-pressed={showCc}
                onClick={() => {
                  setShowCc((value) => !value);
                }}
                className="min-h-6 min-w-6 [font-size:var(--text-caption)] text-muted-foreground"
              >
                Cc
              </button>
              <span className="[margin:0_6px] text-muted-foreground">·</span>
              <button
                type="button"
                aria-pressed={showBcc}
                onClick={() => {
                  setShowBcc((value) => !value);
                }}
                className="min-h-6 min-w-6 [font-size:var(--text-caption)] text-muted-foreground"
              >
                Bcc
              </button>
            </div>
            {showCc ? (
              <MailRecipientField
                label="Cc"
                value={cc}
                inputRef={ccInputRef}
                error={recipientError}
                onChange={(value) => {
                  setCc(value);
                  setRecipientError(null);
                }}
              />
            ) : null}
            {showBcc ? (
              <MailRecipientField
                label="Bcc"
                value={bcc}
                inputRef={bccInputRef}
                error={recipientError}
                onChange={(value) => {
                  setBcc(value);
                  setRecipientError(null);
                }}
              />
            ) : null}
            <div className="[padding:4px_0]">
              <input
                name="mail-compose-subject"
                autoComplete="off"
                value={subject}
                onChange={(event) => {
                  setSubject(event.target.value);
                }}
                onBlur={saveDraft}
                placeholder="Subject"
                aria-label="Subject"
                className="w-full [border:none] outline-none bg-transparent [font-size:var(--text-body-sm)] font-medium"
              />
            </div>
            <label className="flex items-center gap-2 [padding:4px_0]">
              <span className="[font-size:var(--text-meta)] text-muted-foreground w-18">
                Send later
              </span>
              <input
                type="datetime-local"
                aria-label="Send later"
                value={sendAt}
                onChange={(event) => setSendAt(event.target.value)}
              />
            </label>
          </div>
          <textarea
            name="mail-compose-body"
            autoComplete="off"
            value={body}
            onChange={(event) => {
              setBody(event.target.value);
            }}
            onBlur={saveDraft}
            placeholder="Write your message…"
            aria-label="Message body"
            className="w-full min-h-50 p-3.5 [border:none] outline-none bg-transparent [font-size:var(--text-body-sm)] [line-height:1.55] [resize:none] [font-family:inherit]"
          />
          {recipientError === null ? null : (
            <p id="mail-compose-recipient-error" className="compose-inline-error" role="alert">
              {recipientError}
            </p>
          )}
          {attachmentError === null ? null : (
            <p className="compose-inline-error" role="alert">
              {attachmentError}
            </p>
          )}
          {attaching ? (
            <button
              type="button"
              className="btn secondary"
              onClick={() => attachmentUploadRef.current?.abort()}
            >
              Cancel attachment upload
            </button>
          ) : null}
          {attachments.length > 0 && (
            <div className="compose-attachments" aria-label="Attached files">
              {attachments.map((attachment, index) => (
                <div
                  key={`${attachment.filename}-${String(index)}`}
                  className="compose-attachment-chip"
                >
                  <PaperclipIcon size={16} />
                  <span title={attachment.filename}>{attachment.filename}</span>
                  <button
                    type="button"
                    aria-label={`Remove attachment ${attachment.filename}`}
                    onClick={() => {
                      removeAttachment(index);
                    }}
                  >
                    <XIcon size={10} />
                  </button>
                </div>
              ))}
            </div>
          )}
          {undo !== null && Date.now() < undo.untilMs && (
            <div
              role="status"
              className="flex items-center justify-between gap-3 [margin:0_14px_8px] [padding:8px_12px] rounded-lg bg-muted [font-size:var(--text-body-sm)]"
            >
              <span>
                {undo.scheduledAt === undefined
                  ? "Message queued — you can undo send for a few seconds."
                  : `Message scheduled for ${new Date(undo.scheduledAt).toLocaleString()}.`}
              </span>
              <button
                type="button"
                onClick={() => {
                  cancelMutation.mutate(undo.outboundId);
                }}
                disabled={cancelMutation.isPending}
              >
                Undo
              </button>
            </div>
          )}
          {sendFailed && (
            <div className="[margin:0_14px_8px] [font-size:var(--text-caption)] text-destructive">
              Could not send message. Try again.
            </div>
          )}
          <div className="flex items-center gap-1 [padding:8px_12px] [border-top:1px_solid_var(--border)]">
            <div className="flex">
              <button
                type="button"
                className="btn primary"
                disabled={!canSend}
                onClick={handleSend}
              >
                <SendIcon size={16} />{" "}
                {sendMutation.isPending ? "Sending…" : sendAt === "" ? "Send" : "Schedule"}
              </button>
            </div>
            <button
              type="button"
              className="icon-btn"
              aria-label="Attach"
              disabled={attaching}
              onClick={() => {
                fileInputRef.current?.click();
              }}
            >
              <PaperclipIcon size={16} />
            </button>
            <button
              type="button"
              className="icon-btn ml-auto"
              aria-label="Discard draft"

              onClick={requestClose}
            >
              <TrashIcon size={16} />
            </button>
          </div>
        </>
      )}
      {unsavedChangesWarning}
      {confirmDiscardOpen ? (
        <Dialog
          title="Discard this draft?"
          onClose={() => setConfirmDiscardOpen(false)}
          footer={
            <>
              <button type="button" className="btn" onClick={() => setConfirmDiscardOpen(false)}>
                Keep editing
              </button>
              <button
                type="button"
                className="btn danger"
                disabled={discardMutation.isPending}
                onClick={() => discardMutation.mutate()}
              >
                Discard draft
              </button>
            </>
          }
        >
          <p>This permanently removes this saved draft and its recovered copy from this device.</p>
        </Dialog>
      ) : null}
    </div>
  );
}
