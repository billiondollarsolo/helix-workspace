import { Avatar } from "@/components/ui/avatar";
import { useQuery } from "@tanstack/react-query";
import { sessionUserQueryOptions } from "@/lib/auth";
import { cn } from "@/lib/utils";
import {
  Pencil as EditPenIcon,
  Mail as MailIcon,
  Pin as PinIcon,
  Trash2 as TrashIcon,
  Video as VideoIcon,
  X as XIcon,
} from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { type CalendarApiResponseStatus } from "./api";
import { formatHour, type CalendarGridEvent } from "./data";

/* -------------------------------------------------------------------- popover */

const POPOVER_WIDTH = 340;

const POPOVER_HEIGHT = 320;

const RSVP_OPTIONS: readonly { status: CalendarApiResponseStatus; label: string }[] = [
  { status: "accepted", label: "Going" },
  { status: "tentative", label: "Maybe" },
  { status: "declined", label: "No" },
];

export function CalendarEventPopover({
  anchorRect,
  event,
  onClose,
  onEdit,
  onDelete,
  onRespond,
  respondPending,
  deletePending,
}: {
  readonly anchorRect: DOMRect | null;
  readonly event: CalendarGridEvent;
  readonly onClose: () => void;
  readonly onEdit?: (event: CalendarGridEvent) => void;
  readonly onDelete?: (eventId: string) => void;
  readonly onRespond?: (eventId: string, status: CalendarApiResponseStatus) => void;
  readonly respondPending: boolean;
  readonly deletePending: boolean;
}) {
  const popoverRef = useRef<HTMLDivElement>(null);
  const sessionUser = useQuery(sessionUserQueryOptions()).data;
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  useEffect(() => {
    const handleKeydown = (domEvent: KeyboardEvent) => {
      if (domEvent.key === "Escape") {
        onClose();
      }
    };
    const handlePointerDown = (domEvent: MouseEvent) => {
      const target = domEvent.target;
      if (target instanceof Node && popoverRef.current?.contains(target) === true) {
        return;
      }
      if (target instanceof HTMLElement && target.closest("[data-calendar-event]") !== null) {
        return;
      }
      onClose();
    };
    window.addEventListener("keydown", handleKeydown);
    // `mousedown` of the interaction that opened the popover has already fired
    // before this effect runs, so the listener can attach immediately without
    // racing the opening click.
    window.addEventListener("mousedown", handlePointerDown);
    return () => {
      window.removeEventListener("keydown", handleKeydown);
      window.removeEventListener("mousedown", handlePointerDown);
    };
  }, [onClose]);

  const [position, setPosition] = useState<{ readonly left: number; readonly top: number }>(() =>
    computePopoverPosition(anchorRect),
  );

  useLayoutEffect(() => {
    setPosition(computePopoverPosition(anchorRect));
  }, [anchorRect]);

  const apiAttendees = (event.apiEvent?.attendees ?? []).map((attendee) => {
    const isSelf = attendee.actorId
      ? attendee.actorId === sessionUser?.actorId
      : attendee.email.toLowerCase() === sessionUser?.email.toLowerCase();
    return isSelf && sessionUser?.name.trim()
      ? { ...attendee, displayName: sessionUser.name.trim() }
      : attendee;
  });
  const conferenceUrl = safeHttpUrl(event.location);
  const attendeeMailUrl = mailtoUrl(apiAttendees.map((attendee) => attendee.email));
  /** RSVP only makes sense for backend events the popover can act on. */
  const canRespond = onRespond !== undefined && event.apiEvent !== undefined;
  const canEdit = onEdit !== undefined;
  const canDelete = onDelete !== undefined;

  return (
    <div
      data-calendar-popover
      ref={popoverRef}
      role="dialog"
      aria-label={`Event: ${event.title}`}
      className="fixed w-85 bg-card [border:1px_solid_var(--border)] [border-radius:12px] [box-shadow:var(--shadow-lg)] [z-index:100] overflow-hidden"
      style={{ left: position.left, top: position.top }}
    >
      <div
        className="[padding:12px_14px] flex items-start gap-2.5"
        style={{ borderLeft: `4px solid ${event.color}` }}
      >
        <div className="flex-1 min-w-0">
          <div className="[font-size:var(--text-body-lg)] font-semibold mb-1 [line-height:1.3]">
            {event.title}
          </div>
          <div className="[font-size:var(--text-meta)] [color:var(--text-2)]">
            {formatEventDateLabel(event.date)} · {formatHour(event.start)} - {formatHour(event.end)}
          </div>
          {event.location !== undefined && (
            <div className="[font-size:var(--text-meta)] [color:var(--text-2)] mt-1 flex items-center gap-1.5">
              {conferenceUrl === null ? <PinIcon size={14} /> : <VideoIcon size={14} />}
              {event.location}
            </div>
          )}
        </div>
        <div className="flex gap-0.5">
          {canEdit && (
            <button
              aria-label="Edit event"
              className="icon-btn"
              type="button"
              onClick={() => {
                onEdit(event);
                onClose();
              }}
            >
              <EditPenIcon size={16} />
            </button>
          )}
          {canDelete && (
            <button
              aria-label="Delete event"
              className="icon-btn"
              type="button"
              disabled={deletePending}
              onClick={() => setConfirmingDelete(true)}
            >
              <TrashIcon size={16} />
            </button>
          )}
          <button aria-label="Close" className="icon-btn" onClick={onClose} type="button">
            <XIcon size={16} />
          </button>
        </div>
      </div>

      {confirmingDelete && canDelete && (
        <div className="[padding:8px_14px] bg-muted [border-top:1px_solid_var(--border)] flex items-center gap-2 [font-size:var(--text-meta)]">
          <span>Delete this event?</span>
          <div className="ml-auto flex gap-1.5">
            <button className="btn sm" type="button" onClick={() => setConfirmingDelete(false)}>
              Cancel
            </button>
            <button
              className="btn sm primary"
              type="button"
              disabled={deletePending}
              onClick={() => onDelete(event.id)}
            >
              {deletePending ? "Deleting..." : "Delete"}
            </button>
          </div>
        </div>
      )}

      <div className="[height:1px] [background:var(--border)]" />
      <div className="[padding:10px_14px]">
        <div className="section-label [padding:0_0_6px]">
          {event.apiEvent ? apiAttendees.length : event.attendees.length} attendees
        </div>
        {apiAttendees.length > 0
          ? apiAttendees.map((attendee) => (
              <div
                key={attendee.id ?? attendee.email}
                className="flex items-center gap-2 [padding:4px_0] [font-size:var(--text-meta)]"
              >
                <Avatar name={attendee.displayName ?? attendee.email} size={22} />
                <span>{attendee.displayName ?? attendee.email}</span>
                <span className={cn(`chip ${rsvpChipClass(attendee.responseStatus)}`, "ml-auto")}>
                  {rsvpLabel(attendee.responseStatus)}
                </span>
              </div>
            ))
          : event.attendees.map((name) => (
              <div
                key={name}
                className="flex items-center gap-2 [padding:4px_0] [font-size:var(--text-meta)]"
              >
                <Avatar name={name} size={22} />
                <span>{name}</span>
              </div>
            ))}
      </div>

      <div className="[height:1px] [background:var(--border)]" />
      {canRespond && (
        <div className="[padding:10px_14px]">
          <div className="section-label [padding:0_0_6px]">RSVP</div>
          <div className="flex gap-1.5">
            {RSVP_OPTIONS.map((option) => (
              <button
                key={option.status}
                className="btn sm flex-1"

                type="button"
                disabled={respondPending}
                onClick={() => onRespond(event.id, option.status)}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>
      )}
      {(conferenceUrl !== null || attendeeMailUrl !== null) && (
        <div className="[padding:10px_14px] flex gap-1.5">
          {conferenceUrl !== null && (
            <a
              className="btn primary sm flex-1"
              href={conferenceUrl}
              rel="noopener noreferrer"

              target="_blank"
            >
              <VideoIcon size={14} />
              Join
            </a>
          )}
          {attendeeMailUrl !== null && (
            <a aria-label="Email attendees" className="btn sm" href={attendeeMailUrl}>
              <MailIcon size={14} />
            </a>
          )}
        </div>
      )}
    </div>
  );
}

/** Place the popover beside the anchor, flipping/clamping to stay on screen. */
function computePopoverPosition(anchorRect: DOMRect | null): {
  readonly left: number;
  readonly top: number;
} {
  if (anchorRect === null) {
    return { left: 100, top: 100 };
  }
  let left = anchorRect.right + 8;
  let top = anchorRect.top;
  if (left + POPOVER_WIDTH > window.innerWidth - 16) {
    left = anchorRect.left - POPOVER_WIDTH - 8;
  }
  if (left < 16) {
    left = 16;
  }
  if (top + POPOVER_HEIGHT > window.innerHeight - 16) {
    top = window.innerHeight - POPOVER_HEIGHT - 16;
  }
  if (top < 60) {
    top = 60;
  }
  return { left, top };
}

function safeHttpUrl(value: string | undefined): string | null {
  if (value === undefined) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
  } catch {
    return null;
  }
}

function mailtoUrl(addresses: readonly string[]): string | null {
  const unique = [...new Set(addresses.map((address) => address.trim()).filter(Boolean))];
  return unique.length === 0
    ? null
    : `mailto:${unique.map((address) => encodeURIComponent(address)).join(",")}`;
}

/** Human date label for the popover, e.g. "2026-05-21" -> "Thu, May 21". */
function formatEventDateLabel(isoDate: string): string {
  const date = new Date(`${isoDate}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) {
    return isoDate;
  }
  return date.toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

function rsvpLabel(status: CalendarApiResponseStatus): string {
  switch (status) {
    case "accepted":
      return "Going";
    case "declined":
      return "No";
    case "tentative":
      return "Maybe";
    default:
      return "Invited";
  }
}

function rsvpChipClass(status: CalendarApiResponseStatus): string {
  switch (status) {
    case "accepted":
      return "success";
    case "declined":
      return "danger";
    case "tentative":
      return "warning";
    default:
      return "";
  }
}
