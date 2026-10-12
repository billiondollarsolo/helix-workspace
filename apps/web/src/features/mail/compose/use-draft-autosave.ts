/* Autosave to Drafts. Edits are saved a moment after typing stops, saves run
   one at a time, and a save whose response was lost is retried with the same
   idempotency key before newer text is written, so one compose window never
   creates two drafts. */

import { useDebouncer } from "@tanstack/react-pacer/debouncer";
import { useCallback, useEffect, useRef, useState } from "react";
import { saveMailDraft, type MailDraftSaveInput } from "../api";
import {
  hasComposeContent,
  mailAddressesFromRefs,
  wireBody,
  type ComposeFields,
} from "./compose-fields";
import { randomId } from "@/lib/random-id";

export interface DraftRef {
  readonly id: string;
  readonly revision: number;
}

export type DraftSaveStatus =
  | { readonly kind: "idle" }
  | { readonly kind: "saving" }
  | { readonly kind: "saved" }
  | { readonly kind: "error"; readonly message: string };

const AUTOSAVE_DELAY_MS = 1_500;

function draftInput(
  fields: ComposeFields,
  from: string,
  threadId: string | undefined,
): Omit<MailDraftSaveInput, "idempotencyKey"> {
  return {
    ...(from === "" ? {} : { from: { address: from } }),
    ...(threadId === undefined ? {} : { threadId }),
    to: mailAddressesFromRefs(fields.to),
    cc: mailAddressesFromRefs(fields.cc),
    bcc: mailAddressesFromRefs(fields.bcc),
    subject: fields.subject,
    ...wireBody(fields),
    attachments: fields.attachments.map(({ objectId, filename, contentType }) => ({
      objectId,
      ...(filename === undefined ? {} : { filename }),
      ...(contentType === undefined ? {} : { contentType }),
    })),
  };
}

function isConflict(error: unknown): boolean {
  return (error as { readonly status?: unknown } | null)?.status === 409;
}

export function useDraftAutosave(input: {
  readonly fields: ComposeFields;
  readonly from: string;
  readonly threadId?: string;
  readonly initialDraft: DraftRef | null;
  /** False while the draft is still loading or after it was sent or discarded. */
  readonly enabled: boolean;
}) {
  const { fields, from, threadId, enabled } = input;
  const draftRef = useRef<DraftRef | null>(input.initialDraft);
  const queueRef = useRef<Promise<unknown>>(Promise.resolve());
  const pendingRef = useRef<MailDraftSaveInput | null>(null);
  // A resumed draft starts out saved: nothing to write until it is edited.
  const savedPayloadRef = useRef<string | null>(
    input.initialDraft === null ? null : JSON.stringify(draftInput(fields, from, threadId)),
  );
  const latestRef = useRef({ fields, from, threadId });
  latestRef.current = { fields, from, threadId };
  const [status, setStatus] = useState<DraftSaveStatus>({ kind: "idle" });

  const write = useCallback(async (request: MailDraftSaveInput) => {
    pendingRef.current = request;
    const saved = await saveMailDraft(request);
    pendingRef.current = null;
    draftRef.current = { id: saved.id, revision: saved.revision };
  }, []);

  /** Queue a save of the latest fields; resolves to the saved draft (or null if nothing to save). */
  const save = useCallback((): Promise<DraftRef | null> => {
    const run = queueRef.current.then(async () => {
      const latest = latestRef.current;
      if (!hasComposeContent(latest.fields)) return draftRef.current;
      const body = draftInput(latest.fields, latest.from, latest.threadId);
      const payload = JSON.stringify(body);
      if (payload === savedPayloadRef.current && pendingRef.current === null) {
        return draftRef.current;
      }
      setStatus({ kind: "saving" });
      try {
        // Settle an ambiguous earlier save first, with its original key.
        if (pendingRef.current !== null) await write(pendingRef.current);
        const current = draftRef.current;
        await write({
          ...body,
          idempotencyKey: randomId(),
          ...(current === null ? {} : { id: current.id, expectedRevision: current.revision }),
        });
        savedPayloadRef.current = payload;
        setStatus({ kind: "saved" });
        return draftRef.current;
      } catch (error) {
        if (isConflict(error)) {
          // Changed in another window: keep both by saving this one as a new draft.
          draftRef.current = null;
          pendingRef.current = null;
          savedPayloadRef.current = null;
          setStatus({
            kind: "error",
            message: "This draft changed in another window. It will be saved as a separate draft.",
          });
        } else {
          setStatus({
            kind: "error",
            message: error instanceof Error ? error.message : "Couldn't save the draft.",
          });
        }
        throw error;
      }
    });
    queueRef.current = run.catch(() => undefined);
    return run;
  }, [write]);

  const payload = enabled ? JSON.stringify(draftInput(fields, from, threadId)) : null;
  const debouncer = useDebouncer(
    () => {
      void save().catch(() => undefined);
    },
    { wait: AUTOSAVE_DELAY_MS, onUnmount: (instance) => instance.cancel() },
  );
  useEffect(() => {
    if (payload === null || payload === savedPayloadRef.current) return;
    if (!hasComposeContent(latestRef.current.fields)) return;
    debouncer.maybeExecute();
  }, [payload, debouncer]);

  /** Saves pending edits now and resolves to the draft (for Close, Send, and Discard). */
  const flush = useCallback(async (): Promise<DraftRef | null> => {
    debouncer.cancel();
    return save();
  }, [debouncer, save]);

  /** Waits for in-flight saves without writing new edits; resolves to the saved draft. */
  const settle = useCallback(async (): Promise<DraftRef | null> => {
    debouncer.cancel();
    await queueRef.current;
    return draftRef.current;
  }, [debouncer]);

  /** Stops autosaving (after Send or Discard). */
  const stop = useCallback(() => {
    debouncer.cancel();
  }, [debouncer]);

  return { status, flush, settle, stop };
}
