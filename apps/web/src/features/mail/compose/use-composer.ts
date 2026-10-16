/* State and actions shared by the compose window and the inline reply:
   fields, sender, attachments, autosave to Drafts, validation, Send (now or
   scheduled) with the undo snackbar, Discard with undo, and Close. */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useCallback, useMemo, useRef, useState } from "react";
import { notify } from "@/components/ui/toast";
import { personRefAddress } from "@/features/people/person-ref";
import { discardMailDraft } from "../api";
import { useMailSender } from "../mail-sender-select";
import {
  hasComposeContent,
  recipientProblem,
  type ComposeFields,
  type RecipientField,
  type RecipientProblem,
} from "./compose-fields";
import { sendComposed, type ComposeTarget } from "./compose-send";
import { openCompose, type ComposeInit } from "./compose-store";
import { accountPreferencesQueryOptions } from "@/features/account/queries";
import { announceSent } from "./send-toast";
import {
  attachmentProblem,
  attachmentsForSend,
  trashUploads,
  useComposeAttachments,
} from "./use-compose-attachments";
import { useDraftAutosave, type DraftRef } from "./use-draft-autosave";
import { randomId } from "@/lib/random-id";

export interface ComposerOptions {
  readonly initial: ComposeFields;
  readonly initialFrom?: string;
  readonly initialDraft: DraftRef | null;
  readonly target: ComposeTarget;
  /** Forwards are not autosaved: a saved draft cannot carry the forwarded original. */
  readonly autosave: boolean;
  /** Called once the message left the composer (sent, discarded, or closed). */
  readonly onDone: () => void;
  /** Focus a recipient field after a validation problem. */
  readonly onProblem?: (field: RecipientField) => void;
}

function initFromFields(fields: ComposeFields, from: string, target: ComposeTarget): ComposeInit {
  const list = (refs: ComposeFields["to"]) => refs.map(personRefAddress);
  return {
    to: list(fields.to),
    cc: list(fields.cc),
    bcc: list(fields.bcc),
    subject: fields.subject,
    bodyHtml: fields.html,
    plainText: fields.plainText,
    attachments: fields.attachments,
    ...(from === "" ? {} : { from }),
    ...(target.kind === "reply"
      ? {
          replyTo: {
            threadId: target.threadId,
            ...(target.messageId === undefined ? {} : { messageId: target.messageId }),
          },
        }
      : {}),
    ...(target.kind === "forward"
      ? {
          forwardOf: {
            threadId: target.threadId,
            messageId: target.messageId,
            includeAttachments: target.includeAttachments,
          },
        }
      : {}),
  };
}

export function useComposer(options: ComposerOptions) {
  const { target, onDone } = options;
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const preferences = useQuery(accountPreferencesQueryOptions());
  const sender = useMailSender(options.initialFrom);
  const attachments = useComposeAttachments(options.initial.attachments);
  const [state, setState] = useState<ComposeFields>(options.initial);
  const [problem, setProblem] = useState<RecipientProblem | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  const [finished, setFinished] = useState(false);
  const attemptRef = useRef<{ readonly payload: string; readonly key: string } | null>(null);

  const fields = useMemo<ComposeFields>(
    () => ({ ...state, attachments: attachmentsForSend(attachments.items) }),
    [attachments.items, state],
  );
  const threadId = target.kind === "reply" ? target.threadId : undefined;
  const autosave = useDraftAutosave({
    fields,
    from: sender.from,
    ...(threadId === undefined ? {} : { threadId }),
    initialDraft: options.initialDraft,
    enabled: options.autosave && !finished,
  });

  const update = useCallback((patch: Partial<ComposeFields>) => {
    setState((current) => ({ ...current, ...patch }));
    setSendError(null);
    if (patch.to !== undefined || patch.cc !== undefined || patch.bcc !== undefined) {
      setProblem(null);
    }
  }, []);

  const finish = useCallback(() => {
    autosave.stop();
    setFinished(true);
    onDone();
  }, [autosave, onDone]);

  const reopen = useCallback(
    (snapshot: ComposeFields, from: string) => (restoredDraftId: string | null) => {
      openCompose(
        restoredDraftId === null
          ? initFromFields(snapshot, from, target)
          : { draftId: restoredDraftId },
      );
    },
    [target],
  );

  const sendMutation = useMutation({
    onMutate: () => {
      setSendError(null);
    },
    mutationFn: async (sendAt: Date | undefined) => {
      const snapshot = fields;
      let draft: DraftRef | null = null;
      if (options.autosave) {
        draft = await autosave.flush().catch(() => autosave.settle());
      }
      autosave.stop();
      const payload = JSON.stringify({ snapshot, sendAt, from: sender.from, target });
      if (attemptRef.current?.payload !== payload) {
        attemptRef.current = { payload, key: randomId() };
      }
      const result = await sendComposed({
        target,
        fields: snapshot,
        from: sender.from,
        draft,
        ...(sendAt === undefined ? {} : { sendAt }),
        idempotencyKey: attemptRef.current.key,
      });
      return { result, snapshot, sendAt, from: sender.from };
    },
    onError: (error: unknown) => {
      setSendError(
        `Couldn't send. ${error instanceof Error ? error.message : "Check your connection and try again."}`,
      );
    },
    onSuccess: ({ result, snapshot, sendAt, from }) => {
      void queryClient.invalidateQueries({ queryKey: ["mail"] });
      finish();
      announceSent({
        result,
        ...(sendAt === undefined ? {} : { scheduledAt: sendAt }),
        timeZone: preferences.data?.timeZone ?? null,
        reopen: reopen(snapshot, from),
        viewMessage: (thread) => {
          void navigate({ to: "/mail", search: { thread } });
        },
        viewScheduled: () => {
          void navigate({ to: "/mail", search: { folder: "scheduled" } });
        },
      });
    },
  });

  const send = useCallback(
    (sendAt?: Date) => {
      if (sendMutation.isPending || finished) return;
      const found = recipientProblem(fields);
      if (found !== null) {
        setProblem(found);
        options.onProblem?.(found.field);
        return;
      }
      const blocked = attachmentProblem(attachments.items);
      if (blocked !== null) {
        setSendError(blocked);
        return;
      }
      if (!sender.authorized) {
        setSendError("Choose an available From address before sending.");
        return;
      }
      sendMutation.mutate(sendAt);
    },
    [attachments.items, fields, finished, options, sendMutation, sender.authorized],
  );

  /** Close and keep the message in Drafts (an empty message leaves nothing behind). */
  const close = useCallback(async () => {
    const snapshot = fields;
    const from = sender.from;
    finish();
    if (!options.autosave) return;
    try {
      if (hasComposeContent(snapshot)) {
        await autosave.flush();
        return;
      }
      const draft = await autosave.settle();
      if (draft !== null)
        await discardMailDraft({ id: draft.id, expectedRevision: draft.revision });
    } catch {
      notify({
        tone: "error",
        message: "Couldn't save your draft",
        action: {
          label: "Reopen",
          onAction: () => {
            reopen(snapshot, from)(null);
          },
        },
      });
    }
  }, [autosave, fields, finish, options.autosave, reopen, sender.from]);

  /** Discard right away, with Undo in the snackbar. */
  const discard = useCallback(async () => {
    const snapshot = fields;
    const from = sender.from;
    const uploads = attachments.freshObjectIds();
    finish();
    const draft = await autosave.settle();
    const discarded =
      draft === null
        ? true
        : await discardMailDraft({ id: draft.id, expectedRevision: draft.revision }).catch(
            () => false,
          );
    void queryClient.invalidateQueries({ queryKey: ["mail"] });
    if (!discarded) {
      notify({ tone: "error", message: "Couldn't discard the draft. It's still in Drafts." });
      return;
    }
    if (!hasComposeContent(snapshot)) return;
    notify({
      message: "Draft discarded",
      action: {
        label: "Undo",
        onAction: () => {
          reopen(snapshot, from)(null);
        },
      },
      onClose: (reason) => {
        if (reason !== "action") trashUploads(uploads);
      },
    });
  }, [attachments, autosave, fields, finish, queryClient, reopen, sender.from]);

  return {
    threadId,
    fields,
    update,
    sender,
    attachments,
    autosaveStatus: autosave.status,
    problem,
    sendError,
    send,
    sending: sendMutation.isPending,
    close,
    discard,
    timeZone: preferences.data?.timeZone ?? null,
  };
}

export type Composer = ReturnType<typeof useComposer>;
