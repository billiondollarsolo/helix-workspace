import { useDebouncer } from "@tanstack/react-pacer/debouncer";
import { useNavigate } from "@tanstack/react-router";
import {
  Calendar as CalendarIcon,
  Copy as CopyIcon,
  Mail as MailIcon,
  MessageSquare as ChatIcon,
} from "lucide-react";
import {
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type FocusEvent,
  type KeyboardEvent,
  type ReactNode,
  type RefCallback,
} from "react";
import type { PersonRef } from "@/features/people/person-ref";
import { PersonAvatar } from "./person-chip";
import "./people.css";

/** Spread these onto the element that should open the card. */
interface PersonHovercardTriggerProps {
  readonly ref: RefCallback<HTMLElement>;
  readonly "aria-haspopup": "dialog";
  readonly "aria-expanded": boolean;
  readonly "aria-controls": string | undefined;
  readonly onPointerEnter: () => void;
  readonly onPointerLeave: () => void;
  readonly onFocus: () => void;
  readonly onBlur: (event: FocusEvent<HTMLElement>) => void;
  readonly onClick: () => void;
  readonly onKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
}

export interface PersonHovercardProps {
  readonly person: PersonRef;
  readonly children: (trigger: PersonHovercardTriggerProps) => ReactNode;
  readonly openDelayMs?: number;
  readonly closeDelayMs?: number;
}

const CARD_GAP = 6;
const VIEWPORT_MARGIN = 8;

/**
 * Contact card that opens after a short delay on hover or keyboard focus, or at
 * once on click/tap. Its actions hand off to Mail, Chat and Calendar with
 * prefilled search params (see `@/features/people/handoff`).
 */
export function PersonHovercard({
  person,
  children,
  openDelayMs = 450,
  closeDelayMs = 250,
}: PersonHovercardProps) {
  const cardId = useId();
  const navigate = useNavigate();
  const triggerRef = useRef<HTMLElement | null>(null);
  const cardRef = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ top: 0, left: 0 });
  const [copied, setCopied] = useState<"copied" | "failed" | null>(null);
  const opener = useDebouncer(
    () => {
      setOpen(true);
    },
    { wait: openDelayMs },
  );
  const closer = useDebouncer(
    () => {
      setOpen(false);
      setCopied(null);
    },
    { wait: closeDelayMs },
  );

  useLayoutEffect(() => {
    const trigger = triggerRef.current;
    const card = cardRef.current;
    if (!open || trigger === null || card === null) return;
    const anchor = trigger.getBoundingClientRect();
    const height = card.offsetHeight;
    const width = card.offsetWidth;
    const below = anchor.bottom + CARD_GAP;
    const top =
      below + height > window.innerHeight - VIEWPORT_MARGIN
        ? Math.max(VIEWPORT_MARGIN, anchor.top - CARD_GAP - height)
        : below;
    const left = Math.min(
      Math.max(VIEWPORT_MARGIN, anchor.left),
      Math.max(VIEWPORT_MARGIN, window.innerWidth - width - VIEWPORT_MARGIN),
    );
    setPosition({ top, left });
  }, [open]);

  function cancelPending() {
    opener.cancel();
    closer.cancel();
  }

  function scheduleOpen() {
    closer.cancel();
    opener.maybeExecute();
  }

  function scheduleClose() {
    opener.cancel();
    closer.maybeExecute();
  }

  function close(returnFocus: boolean) {
    cancelPending();
    setOpen(false);
    setCopied(null);
    if (returnFocus) triggerRef.current?.focus();
  }

  function focusLeaves(event: FocusEvent<HTMLElement>): boolean {
    const next = event.relatedTarget;
    return !(
      next instanceof Node &&
      (triggerRef.current?.contains(next) === true || cardRef.current?.contains(next) === true)
    );
  }

  function onKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (event.key === "Escape" && open) {
      event.preventDefault();
      event.stopPropagation();
      close(true);
    }
  }

  const trigger: PersonHovercardTriggerProps = {
    ref: (element) => {
      triggerRef.current = element;
    },
    "aria-haspopup": "dialog",
    "aria-expanded": open,
    "aria-controls": open ? cardId : undefined,
    onPointerEnter: scheduleOpen,
    onPointerLeave: scheduleClose,
    onFocus: scheduleOpen,
    onBlur: (event) => {
      if (focusLeaves(event)) scheduleClose();
    },
    onClick: () => {
      cancelPending();
      setOpen((value) => !value);
    },
    onKeyDown,
  };

  const email = person.email;
  const go = (action: () => Promise<void>) => {
    close(false);
    void action();
  };

  return (
    <>
      {children(trigger)}
      {open ? (
        <div
          ref={cardRef}
          id={cardId}
          role="dialog"
          aria-label={`${person.displayName} contact card`}
          className="person-hovercard"
          style={{ top: position.top, left: position.left }}
          onPointerEnter={cancelPending}
          onPointerLeave={scheduleClose}
          onFocus={cancelPending}
          onBlur={(event) => {
            if (focusLeaves(event)) scheduleClose();
          }}
          onKeyDown={onKeyDown}
        >
          <div className="person-hovercard-head">
            <PersonAvatar person={person} size={56} />
            <div className="person-hovercard-identity">
              <p className="person-hovercard-name">{person.displayName}</p>
              {email === null ? null : <span className="person-hovercard-detail">{email}</span>}
              {person.title === null ? null : (
                <span className="person-hovercard-detail">{person.title}</span>
              )}
              {person.kind === "group" ? (
                <span className="person-hovercard-detail">Group</span>
              ) : null}
            </div>
          </div>
          <div className="person-hovercard-actions">
            {email === null ? null : (
              <button
                type="button"
                className="btn sm"
                onClick={() => {
                  go(() => navigate({ to: "/mail", search: { compose: "new", to: email } }));
                }}
              >
                <MailIcon size={14} aria-hidden="true" /> Send email
              </button>
            )}
            {person.actorId === null ? null : (
              <button
                type="button"
                className="btn sm"
                onClick={() => {
                  const actorId = person.actorId;
                  if (actorId !== null)
                    go(() => navigate({ to: "/chat", search: { dm: actorId } }));
                }}
              >
                <ChatIcon size={14} aria-hidden="true" /> Chat
              </button>
            )}
            {email === null ? null : (
              <button
                type="button"
                className="btn sm"
                onClick={() => {
                  go(() =>
                    navigate({ to: "/calendar", search: { create: "event", attendees: email } }),
                  );
                }}
              >
                <CalendarIcon size={14} aria-hidden="true" /> Schedule a meeting
              </button>
            )}
            {email === null ? null : (
              <button
                type="button"
                className="btn sm"
                onClick={() => {
                  Promise.resolve()
                    .then(() => navigator.clipboard.writeText(email))
                    .then(
                      () => {
                        setCopied("copied");
                      },
                      () => {
                        setCopied("failed");
                      },
                    );
                }}
              >
                <CopyIcon size={14} aria-hidden="true" /> Copy email
              </button>
            )}
          </div>
          <div className="person-hovercard-status" role="status">
            {copied === "copied"
              ? "Email address copied."
              : copied === "failed"
                ? "Copy failed. Select the address above and copy it manually."
                : null}
          </div>
        </div>
      ) : null}
    </>
  );
}
