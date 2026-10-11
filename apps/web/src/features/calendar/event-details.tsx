/* Event details shown in the popover when an event is opened. */

import {
  Bell,
  CalendarDays,
  Mail,
  MapPin,
  Pencil,
  Repeat,
  Text as TextIcon,
  Trash2,
  Users,
  Video,
  X,
  type LucideIcon,
} from "lucide-react";
import type { CSSProperties, MouseEvent, ReactNode } from "react";
import { PersonAvatar } from "@/components/people/person-chip";
import { Button } from "@/components/ui/button";
import type { CalendarApiAttendee, CalendarApiResponseStatus } from "./api";
import { labelFill } from "./colors";
import { draftFromEvent, draftRecurrenceText } from "./event-draft";
import { occurrenceDateText, occurrenceTimeText } from "./event-chip";
import {
  eventJoinLink,
  httpUrl,
  selfAttendee,
  type CalendarOccurrence,
  type ViewerIdentity,
} from "./event-model";
import { useTimeFormat } from "./preferences";
import { describeReminder, reminderFromMetadata } from "./reminders";

const RSVP_CHOICES: readonly {
  readonly status: Exclude<CalendarApiResponseStatus, "needs_action">;
  readonly label: string;
}[] = [
  { status: "accepted", label: "Yes" },
  { status: "declined", label: "No" },
  { status: "tentative", label: "Maybe" },
];

const STATUS_LABELS: Readonly<Record<CalendarApiResponseStatus, string>> = {
  accepted: "Going",
  declined: "Not going",
  tentative: "Maybe",
  needs_action: "Awaiting",
};

function Row({
  icon: Icon,
  label,
  children,
}: {
  readonly icon: LucideIcon;
  readonly label: string;
  readonly children: ReactNode;
}) {
  return (
    <div className="grid grid-cols-[20px_minmax(0,1fr)] gap-x-4 items-start">
      <Icon aria-hidden="true" className="size-5 text-muted-foreground mt-0.5" />
      <div className="min-w-0 type-body-sm">
        <span className="sr-only">{label}: </span>
        {children}
      </div>
    </div>
  );
}

function guestSummary(attendees: readonly CalendarApiAttendee[]): string {
  const yes = attendees.filter((attendee) => attendee.responseStatus === "accepted").length;
  const no = attendees.filter((attendee) => attendee.responseStatus === "declined").length;
  const maybe = attendees.filter((attendee) => attendee.responseStatus === "tentative").length;
  const waiting = attendees.length - yes - no - maybe;
  return [
    yes > 0 ? `${String(yes)} yes` : null,
    no > 0 ? `${String(no)} no` : null,
    maybe > 0 ? `${String(maybe)} maybe` : null,
    waiting > 0 ? `${String(waiting)} awaiting` : null,
  ]
    .filter((part) => part !== null)
    .join(", ");
}

export interface EventDetailsProps {
  readonly occurrence: CalendarOccurrence;
  readonly calendarName: string | null;
  readonly viewer: ViewerIdentity;
  /** The viewer's current profile name, shown on their own guest row. */
  readonly selfName: string | null;
  readonly canEdit: boolean;
  readonly canRespond: boolean;
  readonly respondPending: boolean;
  readonly onEdit: () => void;
  readonly onDelete: () => void;
  readonly onRespond: (status: Exclude<CalendarApiResponseStatus, "needs_action">) => void;
  readonly onEmailGuests?: (emails: readonly string[]) => void;
  readonly onOpenLink?: (url: string, event: MouseEvent<HTMLAnchorElement>) => void;
  readonly onClose: () => void;
}

export function EventDetails({
  occurrence,
  calendarName,
  viewer,
  selfName,
  canEdit,
  canRespond,
  respondPending,
  onEdit,
  onDelete,
  onRespond,
  onEmailGuests,
  onOpenLink,
  onClose,
}: EventDetailsProps) {
  const { event } = occurrence;
  const format = useTimeFormat();
  const join = eventJoinLink(event);
  const recurrence = event.recurrenceRule ? draftRecurrenceText(draftFromEvent(event)) : null;
  const reminder = reminderFromMetadata(event.metadata);
  const guests = event.attendees;
  const organizer = guests.find((attendee) => attendee.isOrganizer === true) ?? null;
  const guestEmails = guests.map((attendee) => attendee.email);
  const locationIsLink = httpUrl(event.location) !== null;
  const selfStatus = occurrence.selfStatus;
  const self = selfAttendee(event, viewer);

  return (
    <div data-calendar-popover>
      <div className="flex items-center justify-end gap-0.5 px-2 pt-2">
        {canEdit ? (
          <>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Edit event"
              title="Edit event (E)"
              onClick={onEdit}
            >
              <Pencil aria-hidden="true" />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Delete event"
              title="Delete event (Delete)"
              onClick={onDelete}
            >
              <Trash2 aria-hidden="true" />
            </Button>
          </>
        ) : null}
        {onEmailGuests !== undefined && guestEmails.length > 0 ? (
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Email guests"
            title="Email guests"
            onClick={() => onEmailGuests(guestEmails)}
          >
            <Mail aria-hidden="true" />
          </Button>
        ) : null}
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Close"
          title="Close (Esc)"
          onClick={onClose}
        >
          <X aria-hidden="true" />
        </Button>
      </div>

      <div className="flex flex-col gap-3 px-4 pb-4">
        <div className="grid grid-cols-[20px_minmax(0,1fr)] gap-x-4 items-start">
          <span
            aria-hidden="true"
            className="cal-swatch mt-1.5"
            style={{ "--swatch": labelFill(occurrence.label) } as CSSProperties}
          />
          <div className="min-w-0">
            <h2 className="type-h3 m-0 break-words">{event.title || "(No title)"}</h2>
            <p className="m-0 type-body-sm">
              {occurrenceDateText(occurrence)} · {occurrenceTimeText(occurrence, format)}
            </p>
            {recurrence !== null ? (
              <p className="m-0 type-body-sm text-muted-foreground flex items-center gap-1">
                <Repeat aria-hidden="true" className="size-3.5" />
                {recurrence}
              </p>
            ) : null}
          </div>
        </div>

        {join?.kind === "meet" ? (
          <Row icon={Video} label="Video call">
            <a
              className="inline-flex items-center gap-2 rounded-[var(--radius)] bg-primary px-4 py-1.5 text-primary-foreground font-medium focus-ring"
              href={join.url}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(clickEvent) => onOpenLink?.(join.url, clickEvent)}
            >
              Join with Helix Meet
            </a>
            <span className="block mt-1 type-caption text-muted-foreground break-all">
              {join.url}
            </span>
          </Row>
        ) : join?.kind === "external" ? (
          <Row icon={Video} label="Video call">
            {/* Another system's meeting: a plain link that leaves the app. */}
            <a
              className="break-all text-primary underline focus-ring"
              href={join.url}
              target="_blank"
              rel="noopener noreferrer"
            >
              {join.url}
            </a>
          </Row>
        ) : null}

        {event.location && !locationIsLink ? (
          <Row icon={MapPin} label="Location">
            {event.location}
          </Row>
        ) : null}

        {guests.length > 0 ? (
          <Row icon={Users} label="Guests">
            <p className="m-0">
              {guests.length} {guests.length === 1 ? "guest" : "guests"}
            </p>
            <p className="m-0 type-caption text-muted-foreground">{guestSummary(guests)}</p>
            <ul className="m-0 mt-1.5 p-0 list-none flex flex-col gap-1.5">
              {guests.map((attendee) => {
                const name =
                  (attendee === self ? selfName : null) ?? attendee.displayName ?? attendee.email;
                return (
                  <li key={attendee.id ?? attendee.email} className="flex items-center gap-2">
                    <PersonAvatar person={{ displayName: name, avatarDataUrl: null }} size={24} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate">{name}</span>
                      {attendee === organizer ? (
                        <span className="block type-caption text-muted-foreground">Organizer</span>
                      ) : null}
                    </span>
                    <span className="type-caption text-muted-foreground">
                      {STATUS_LABELS[attendee.responseStatus]}
                    </span>
                  </li>
                );
              })}
            </ul>
          </Row>
        ) : null}

        {reminder !== null ? (
          <Row icon={Bell} label="Notification">
            {describeReminder(reminder)}
          </Row>
        ) : null}

        {event.description ? (
          <Row icon={TextIcon} label="Description">
            <p className="m-0 whitespace-pre-wrap break-words max-h-40 overflow-y-auto">
              {event.description}
            </p>
          </Row>
        ) : null}

        {calendarName !== null ? (
          <Row icon={CalendarDays} label="Calendar">
            {calendarName}
          </Row>
        ) : null}
      </div>

      {canRespond ? (
        <div
          role="group"
          aria-labelledby="cal-rsvp-label"
          className="flex items-center gap-2 border-t border-border px-4 py-3"
        >
          <span id="cal-rsvp-label" className="type-body-sm font-medium mr-auto">
            Going?
          </span>
          {RSVP_CHOICES.map((choice) => (
            <Button
              key={choice.status}
              size="sm"
              variant={selfStatus === choice.status ? "default" : "outline"}
              aria-pressed={selfStatus === choice.status}
              disabled={respondPending}
              onClick={() => onRespond(choice.status)}
            >
              {choice.label}
            </Button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
