/* The snackbar after Send: "Message sent · Undo · View message", or
   "Send scheduled for … · Undo · View scheduled". Undo is offered only while
   the server's undo window (`undoUntil`) is open; it cancels the queued
   message and reopens it for editing. */

import { notify } from "@/components/ui/toast";
import { cancelOutboundMail, cancelScheduledMail, type MailSendResult } from "../api";
import { formatScheduleTime } from "./schedule-send";

const MIN_TOAST_MS = 4_000;
const MAX_TOAST_MS = 60_000;

export interface SentToastInput {
  readonly result: MailSendResult;
  /** Set for scheduled sends. */
  readonly scheduledAt?: Date;
  readonly timeZone?: string | null;
  /** Reopen the cancelled message: its fields, or the draft the server restored. */
  readonly reopen: (restoredDraftId: string | null) => void;
  readonly viewMessage: (threadId: string) => void;
  readonly viewScheduled: () => void;
  readonly now?: number;
}

function outboundIdOf(result: MailSendResult): string | null {
  const id = result.id ?? result.outboundId;
  return typeof id === "string" && id !== "" ? id : null;
}

export function announceSent(input: SentToastInput): void {
  const now = input.now ?? Date.now();
  const outboundId = outboundIdOf(input.result);
  const undoUntil =
    input.result.undoUntil === undefined ? Number.NaN : Date.parse(input.result.undoUntil);
  const undoOpen =
    input.scheduledAt !== undefined || (Number.isFinite(undoUntil) && undoUntil > now);
  const threadId = input.result.threadId;

  const undo = async () => {
    if (outboundId === null) return;
    try {
      if (input.scheduledAt !== undefined) {
        const cancelled = await cancelScheduledMail(outboundId);
        if (!cancelled.cancelled) throw new Error("already-sent");
        notify({ message: "Scheduled send cancelled" });
        input.reopen(cancelled.draftId);
        return;
      }
      const cancelled = await cancelOutboundMail(outboundId);
      if (cancelled === null) throw new Error("already-sent");
      notify({ message: "Sending undone" });
      input.reopen(null);
    } catch (error) {
      notify({
        tone: "error",
        message:
          error instanceof Error && error.message === "already-sent"
            ? "Too late to undo. The message was already sent."
            : "Couldn't undo the send. Check Sent or Scheduled before trying again.",
      });
    }
  };

  const action =
    outboundId !== null && undoOpen ? { label: "Undo", onAction: () => void undo() } : undefined;

  if (input.scheduledAt !== undefined) {
    notify({
      message: `Send scheduled for ${formatScheduleTime(input.scheduledAt, input.timeZone)}`,
      ...(action === undefined ? {} : { action }),
      secondaryAction: { label: "View scheduled", onAction: input.viewScheduled },
      duration: 10_000,
    });
    return;
  }
  notify({
    message: "Message sent",
    ...(action === undefined ? {} : { action }),
    ...(threadId === undefined
      ? {}
      : {
          secondaryAction: { label: "View message", onAction: () => input.viewMessage(threadId) },
        }),
    duration: Math.min(
      MAX_TOAST_MS,
      Math.max(MIN_TOAST_MS, Number.isFinite(undoUntil) ? undoUntil - now : MIN_TOAST_MS),
    ),
  });
}
