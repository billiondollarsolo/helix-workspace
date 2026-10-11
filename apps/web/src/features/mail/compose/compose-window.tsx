/* One compose window: docked bottom-right, minimizable to its title bar,
   expandable to a full-size dialog, full screen on phones. Escape restores a
   full-size window, then closes (the draft stays in Drafts). */

import { useQuery } from "@tanstack/react-query";
import { Maximize2, Minimize2, Minus, Paperclip, X } from "lucide-react";
import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { MailSenderSelect } from "../mail-sender-select";
import {
  fieldsFromDraft,
  fieldsFromInit,
  type ComposeFields,
  type RecipientField,
} from "./compose-fields";
import type { ComposeTarget } from "./compose-send";
import { closeCompose, updateComposeWindow, type ComposeWindowState } from "./compose-store";
import { ComposerBody } from "./composer-body";
import { mailDraftQueryOptions } from "./queries";
import { RecipientFields, type RecipientFieldsHandle } from "./recipient-fields";
import { useComposeShortcuts } from "./use-compose-shortcuts";
import { useComposer } from "./use-composer";
import { usePhoneLayout } from "./use-phone-layout";
import type { DraftRef } from "./use-draft-autosave";

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), [contenteditable="true"], [tabindex]:not([tabindex="-1"])';

function targetOf(state: ComposeWindowState, draftThreadId: string | null): ComposeTarget {
  const { forwardOf, replyTo } = state.init;
  if (forwardOf !== undefined) return { kind: "forward", ...forwardOf };
  if (replyTo !== undefined) return { kind: "reply", ...replyTo };
  if (draftThreadId !== null) return { kind: "reply", threadId: draftThreadId };
  return { kind: "new" };
}

export function ComposeWindow({ state }: { readonly state: ComposeWindowState }) {
  const draftId = state.init.draftId;
  const draft = useQuery({
    ...mailDraftQueryOptions(draftId ?? ""),
    enabled: draftId !== undefined,
  });

  if (draftId === undefined) {
    return (
      <ComposeForm
        state={state}
        initial={fieldsFromInit(state.init)}
        initialDraft={null}
        target={targetOf(state, null)}
        {...(state.init.from === undefined ? {} : { initialFrom: state.init.from })}
      />
    );
  }
  if (draft.data != null) {
    return (
      <ComposeForm
        state={state}
        initial={fieldsFromDraft(draft.data)}
        initialDraft={{ id: draft.data.id, revision: draft.data.revision }}
        target={targetOf(state, draft.data.threadId)}
        {...(draft.data.from === undefined ? {} : { initialFrom: draft.data.from.address })}
      />
    );
  }
  return (
    <WindowFrame state={state} title="Draft" onClose={() => closeCompose(state.id)}>
      <p className="compose-loading" role={draft.isPending ? "status" : "alert"}>
        {draft.isPending
          ? "Opening draft…"
          : "This draft couldn't be opened. It may have been sent or discarded."}
      </p>
    </WindowFrame>
  );
}

function WindowFrame({
  state,
  title,
  onClose,
  onKeyDown,
  children,
  frameRef,
  dropProps,
}: {
  readonly state: ComposeWindowState;
  readonly title: string;
  readonly onClose: () => void;
  readonly onKeyDown?: (event: KeyboardEvent<HTMLElement>) => void;
  readonly children: React.ReactNode;
  readonly frameRef?: React.RefObject<HTMLElement | null>;
  readonly dropProps?: React.HTMLAttributes<HTMLElement>;
}) {
  const titleId = useId();
  const { minimized, maximized } = state;
  const phone = usePhoneLayout();
  return (
    <>
      {maximized ? (
        <div
          className="compose-backdrop"
          aria-hidden="true"
          onClick={() => {
            updateComposeWindow(state.id, { maximized: false });
          }}
        />
      ) : null}
      <section
        ref={frameRef}
        role="dialog"
        aria-modal={maximized || (phone && !minimized) ? "true" : "false"}
        aria-labelledby={titleId}
        className="compose-window"
        data-compose-window=""
        data-minimized={minimized ? "true" : undefined}
        data-maximized={maximized ? "true" : undefined}
        onKeyDown={onKeyDown}
        {...dropProps}
      >
        <div className="compose-titlebar">
          <h2 id={titleId} className="compose-title">
            <button
              type="button"
              className="compose-title-btn"
              aria-expanded={!minimized}
              onClick={() => {
                updateComposeWindow(state.id, { minimized: !minimized, maximized: false });
              }}
            >
              {title}
            </button>
          </h2>
          <button
            type="button"
            className="compose-chrome-btn"
            aria-label={minimized ? "Restore" : "Minimize"}
            title={minimized ? "Restore" : "Minimize"}
            onClick={() => {
              updateComposeWindow(state.id, { minimized: !minimized, maximized: false });
            }}
          >
            <Minus aria-hidden="true" size={16} />
          </button>
          <button
            type="button"
            className="compose-chrome-btn compose-maximize"
            aria-label={maximized ? "Exit full screen" : "Full screen"}
            title={maximized ? "Exit full screen" : "Full screen"}
            onClick={() => {
              updateComposeWindow(state.id, { maximized: !maximized, minimized: false });
            }}
          >
            {maximized ? (
              <Minimize2 aria-hidden="true" size={16} />
            ) : (
              <Maximize2 aria-hidden="true" size={16} />
            )}
          </button>
          <button
            type="button"
            className="compose-chrome-btn"
            aria-label="Save and close"
            title="Save and close"
            onClick={onClose}
          >
            <X aria-hidden="true" size={16} />
          </button>
        </div>
        <div className="compose-content" hidden={minimized}>
          {children}
        </div>
      </section>
    </>
  );
}

function ComposeForm({
  state,
  initial,
  initialDraft,
  initialFrom,
  target,
}: {
  readonly state: ComposeWindowState;
  readonly initial: ComposeFields;
  readonly initialDraft: DraftRef | null;
  readonly initialFrom?: string;
  readonly target: ComposeTarget;
}) {
  const frameRef = useRef<HTMLElement | null>(null);
  const editorRef = useRef<HTMLDivElement | null>(null);
  const recipientsRef = useRef<RecipientFieldsHandle | null>(null);
  const errorId = useId();
  const [showCc, setShowCc] = useState(initial.cc.length > 0);
  const [showBcc, setShowBcc] = useState(initial.bcc.length > 0);
  const [dragDepth, setDragDepth] = useState(0);
  const composer = useComposer({
    initial,
    ...(initialFrom === undefined ? {} : { initialFrom }),
    initialDraft,
    target,
    autosave: target.kind !== "forward",
    onDone: () => {
      closeCompose(state.id);
    },
    onProblem: (field) => {
      recipientsRef.current?.focus(field);
    },
  });
  const { fields, update, sender } = composer;

  const reveal = (field: "cc" | "bcc") => {
    if (field === "cc") setShowCc(true);
    else setShowBcc(true);
  };
  useComposeShortcuts(frameRef, {
    send: () => {
      composer.send();
    },
    cc: () => recipientsRef.current?.focus("cc"),
    bcc: () => recipientsRef.current?.focus("bcc"),
  });

  // Focus the first empty field when the window opens; return focus to the opener when it closes.
  useLayoutEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (initial.to.length === 0) recipientsRef.current?.focus("to");
    else editorRef.current?.focus();
    const frame = frameRef.current;
    return () => {
      if (frame?.contains(document.activeElement) !== false && opener?.isConnected === true) {
        opener.focus();
      }
    };
  }, []);

  // A full-size window (or any open window on a phone) is modal and keeps focus inside it.
  const phone = usePhoneLayout();
  const modal = state.maximized || (phone && !state.minimized);
  useEffect(() => {
    if (!modal) return;
    const first = frameRef.current?.querySelector<HTMLElement>(FOCUSABLE);
    if (frameRef.current?.contains(document.activeElement) !== true) first?.focus();
  }, [modal]);

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (!(event.target instanceof Node) || !event.currentTarget.contains(event.target)) return;
    if (event.key === "Escape" && !event.defaultPrevented) {
      event.preventDefault();
      if (state.maximized) updateComposeWindow(state.id, { maximized: false });
      else void composer.close();
      return;
    }
    if (event.key === "Tab" && modal) {
      const focusable = Array.from(event.currentTarget.querySelectorAll<HTMLElement>(FOCUSABLE));
      const first = focusable[0];
      const last = focusable.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    }
  };

  const showFrom =
    sender.available.length > 1 || (!sender.authorized && !sender.addresses.isPending);
  const title = fields.subject.trim() === "" ? "New message" : fields.subject;

  return (
    <WindowFrame
      state={state}
      title={title}
      frameRef={frameRef}
      onClose={() => {
        void composer.close();
      }}
      onKeyDown={onKeyDown}
      dropProps={{
        onDragEnter: (event) => {
          if (!event.dataTransfer.types.includes("Files")) return;
          event.preventDefault();
          setDragDepth((depth) => depth + 1);
        },
        onDragOver: (event) => {
          if (!event.dataTransfer.types.includes("Files")) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = "copy";
        },
        onDragLeave: () => {
          setDragDepth((depth) => Math.max(0, depth - 1));
        },
        onDrop: (event) => {
          if (event.dataTransfer.files.length === 0) return;
          event.preventDefault();
          setDragDepth(0);
          composer.attachments.add(event.dataTransfer.files);
        },
      }}
    >
      {dragDepth > 0 ? (
        <div className="compose-drop-overlay" aria-hidden="true">
          <Paperclip size={18} />
          Drop files to attach
        </div>
      ) : null}
      <div className="compose-fields">
        {showFrom ? (
          <div className="compose-row">
            <MailSenderSelect sender={sender} disabled={composer.sending} />
          </div>
        ) : null}
        <RecipientFields
          handleRef={recipientsRef}
          fields={fields}
          onChange={(field: RecipientField, refs) => {
            update({ [field]: refs });
          }}
          showCc={showCc}
          showBcc={showBcc}
          onReveal={reveal}
          problem={composer.problem}
          errorId={errorId}
        />
        <div className="compose-row">
          <input
            className="compose-subject"
            aria-label="Subject"
            placeholder="Subject"
            autoComplete="off"
            value={fields.subject}
            onChange={(event) => {
              update({ subject: event.target.value });
            }}
          />
        </div>
      </div>
      <ComposerBody
        composer={composer}
        editorRef={editorRef}
        placeholder=""
        isReply={target.kind === "reply"}
        errorId={errorId}
      >
        {target.kind === "forward" ? (
          <p className="compose-forward-note">
            The original message
            {target.includeAttachments ? " and its attachments are" : " is"} included when sent.
          </p>
        ) : null}
      </ComposerBody>
    </WindowFrame>
  );
}
