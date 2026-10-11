/* MeetHub — the Meet landing page: "New meeting" (start now, a link for
   later, or schedule in Calendar), "Enter a code or link", today's meetings
   from Calendar plus rooms already running, and recent meetings. */

import { EmptyState } from "@/components/ui/empty-state";
import { Dialog } from "@/components/ui/helix-dialog";
import { InlineError } from "@/components/ui/inline-error";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "@/components/ui/menu";
import { Skeleton } from "@/components/ui/skeleton";
import { calendarQueryKeys } from "@/features/calendar/queries";
import { cn } from "@/lib/utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CalendarPlus as CalendarIcon,
  ChevronDown as ChevronIcon,
  Copy as CopyIcon,
  Keyboard as KeyboardIcon,
  Link as LinkIcon,
  Plus as PlusIcon,
  Video as VideoIcon,
} from "lucide-react";
import { useMemo, useState, type FormEvent } from "react";
import { createMeetRoom, type MeetMeetingRecord } from "./api";
import { parseMeetCode } from "./meet-code";
import { copyMeetingLink, meetJoinLink } from "./meet-join";
import { meetingToRecent, todayMeetings, type TodayMeeting } from "./meet-taxonomy";
import { meetMeetingsQueryOptions, meetQueryKeys, meetTodayEventsQueryOptions } from "./queries";
import { RecordingDrawer } from "./recording-drawer";

export interface MeetHubProps {
  readonly onStartInstant: () => void;
  /** Opens the pre-join screen for a meeting code. */
  readonly onOpenCode: (code: string) => void;
  readonly onScheduleInCalendar: () => void;
}

export function MeetHub({ onStartInstant, onOpenCode, onScheduleInCalendar }: MeetHubProps) {
  const queryClient = useQueryClient();
  const [codeInput, setCodeInput] = useState("");
  const [codeError, setCodeError] = useState<string | null>(null);
  const [laterCode, setLaterCode] = useState<string | null>(null);
  const [recordingsFor, setRecordingsFor] = useState<MeetMeetingRecord | null>(null);

  const meetingsQuery = useQuery(meetMeetingsQueryOptions());
  const eventsQuery = useQuery(meetTodayEventsQueryOptions());

  const laterMutation = useMutation({
    mutationFn: () => createMeetRoom({ subject: "Meeting" }),
    onMutate: () => undefined,
    onSuccess: (room) => {
      void queryClient.invalidateQueries({ queryKey: meetQueryKeys.all });
      setLaterCode(room.joinCode);
    },
    onError: () => undefined,
  });

  const today = useMemo(
    () => todayMeetings(eventsQuery.data ?? [], meetingsQuery.data?.meetings ?? []),
    [eventsQuery.data, meetingsQuery.data],
  );
  const recentRecords = meetingsQuery.data?.recent ?? [];

  const todayLoading = meetingsQuery.isPending || eventsQuery.isPending;
  const todayFailed = meetingsQuery.isError || eventsQuery.isError;

  function joinWithCode(event: FormEvent) {
    event.preventDefault();
    const code = parseMeetCode(codeInput);
    if (code === null) {
      setCodeError("Enter a meeting code like abcd-efgh-ijkl, or paste a meeting link.");
      return;
    }
    setCodeError(null);
    onOpenCode(code);
  }

  return (
    <div className="flex-1 overflow-y-auto bg-background">
      <div className="mx-auto max-w-240 px-4 pt-8 pb-12 md:px-8">
        <section aria-labelledby="meet-hero-title" className="mb-10">
          <h1 id="meet-hero-title" className="m-0 type-display font-semibold">
            Meet face to face, wherever you are
          </h1>
          <p className="m-0 mt-2 mb-6 type-body-lg text-[var(--text-2)]">
            Start a call now, share a link for later, or join with a code.
          </p>
          <div className="flex flex-wrap items-start gap-3">
            <Menu>
              <MenuTrigger asChild>
                <button className="btn primary lg" type="button" disabled={laterMutation.isPending}>
                  <VideoIcon size={16} aria-hidden="true" /> New meeting
                  <ChevronIcon size={16} aria-hidden="true" />
                </button>
              </MenuTrigger>
              <MenuContent aria-label="New meeting">
                <MenuItem icon={<PlusIcon size={16} />} onSelect={onStartInstant}>
                  Start an instant meeting
                </MenuItem>
                <MenuItem
                  icon={<LinkIcon size={16} />}
                  onSelect={() => {
                    laterMutation.mutate();
                  }}
                >
                  Create a meeting for later
                </MenuItem>
                <MenuItem icon={<CalendarIcon size={16} />} onSelect={onScheduleInCalendar}>
                  Schedule in Calendar
                </MenuItem>
              </MenuContent>
            </Menu>
            <form
              className="flex min-w-0 flex-1 flex-wrap gap-2"
              onSubmit={joinWithCode}
              noValidate
            >
              <label className="search h-10 min-w-56 flex-1 sm:max-w-80">
                <KeyboardIcon size={16} aria-hidden="true" />
                <span className="sr-only">Meeting code or link</span>
                <input
                  placeholder="Enter a code or link"
                  value={codeInput}
                  aria-invalid={codeError !== null}
                  aria-describedby={codeError === null ? undefined : "meet-code-error"}
                  onChange={(event) => {
                    setCodeInput(event.target.value);
                    setCodeError(null);
                  }}
                />
              </label>
              <button className="btn lg" type="submit" disabled={codeInput.trim().length === 0}>
                Join
              </button>
            </form>
          </div>
          {codeError !== null ? (
            <p id="meet-code-error" role="alert" className="m-0 mt-2 type-meta text-destructive">
              {codeError}
            </p>
          ) : null}
          {laterMutation.isError ? (
            <InlineError
              className="mt-3"
              variant="compact"
              title="Couldn't create the meeting"
              message={
                laterMutation.error instanceof Error ? laterMutation.error.message : "Try again."
              }
              onRetry={() => {
                laterMutation.mutate();
              }}
            />
          ) : null}
        </section>

        <section aria-labelledby="meet-today-title" className="mb-8">
          <div className="mb-2 flex items-baseline gap-2">
            <h2 id="meet-today-title" className="m-0 type-h3 font-semibold">
              Today
            </h2>
            {!todayLoading && !todayFailed ? (
              <span className="type-meta text-muted-foreground">
                {today.length === 1 ? "1 meeting" : `${String(today.length)} meetings`}
              </span>
            ) : null}
          </div>
          {todayLoading ? (
            <Skeleton variant="row" count={3} label="Loading today's meetings" />
          ) : todayFailed ? (
            <InlineError
              title="Meetings unavailable"
              message="Today's meetings couldn't be loaded."
              retrying={meetingsQuery.isFetching || eventsQuery.isFetching}
              onRetry={() => {
                void queryClient.invalidateQueries({ queryKey: meetQueryKeys.all });
                void queryClient.invalidateQueries({ queryKey: calendarQueryKeys.eventsRoot });
              }}
            />
          ) : today.length === 0 ? (
            <EmptyState
              size="inline"
              headingLevel={3}
              icon={<CalendarIcon />}
              title="No video meetings today"
              body="Events you add video conferencing to in Calendar show up here."
              action={
                <button className="btn" type="button" onClick={onScheduleInCalendar}>
                  Schedule in Calendar
                </button>
              }
            />
          ) : (
            <ul className="m-0 list-none divide-y divide-border rounded-lg border border-border bg-card p-0">
              {today.map((meeting) => (
                <TodayRow key={meeting.id} meeting={meeting} onJoin={onOpenCode} />
              ))}
            </ul>
          )}
        </section>

        {!meetingsQuery.isError ? (
          <section aria-labelledby="meet-recent-title">
            <h2 id="meet-recent-title" className="m-0 mb-2 type-h3 font-semibold">
              Recent
            </h2>
            {meetingsQuery.isPending ? (
              <Skeleton variant="row" count={2} label="Loading recent meetings" />
            ) : recentRecords.length === 0 ? (
              <EmptyState
                size="inline"
                headingLevel={3}
                icon={<VideoIcon />}
                title="No recent meetings"
                body="Meetings you've joined show up here."
              />
            ) : (
              <ul className="m-0 list-none divide-y divide-border rounded-lg border border-border bg-card p-0">
                {recentRecords.map((record) => {
                  const meeting = meetingToRecent(record);
                  return (
                    <li
                      key={meeting.id}
                      className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3"
                    >
                      <span className="min-w-0 flex-1 truncate type-body-sm font-medium">
                        {meeting.title}
                      </span>
                      <span className="type-meta text-[var(--text-2)]">{meeting.date}</span>
                      <span className="type-meta text-[var(--text-2)]">{meeting.duration}</span>
                      <span className="type-meta text-[var(--text-2)]">
                        {meeting.attendees === 1
                          ? "1 person"
                          : `${String(meeting.attendees)} people`}
                      </span>
                      {meeting.recorded ? (
                        <button
                          className="btn sm"
                          type="button"
                          onClick={() => {
                            setRecordingsFor(record);
                          }}
                        >
                          <VideoIcon size={16} aria-hidden="true" /> Recording
                        </button>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        ) : null}
      </div>

      {laterCode !== null ? (
        <MeetingLinkDialog
          code={laterCode}
          onClose={() => {
            setLaterCode(null);
          }}
        />
      ) : null}

      {recordingsFor !== null ? (
        <RecordingDrawer
          meeting={recordingsFor}
          onClose={() => {
            setRecordingsFor(null);
          }}
        />
      ) : null}
    </div>
  );
}

function TodayRow({
  meeting,
  onJoin,
}: {
  readonly meeting: TodayMeeting;
  readonly onJoin: (code: string) => void;
}) {
  return (
    <li className="flex items-center gap-4 px-4 py-3">
      <div className="w-18 shrink-0">
        <div className="type-body-sm font-semibold tabular-nums">{meeting.time}</div>
        <div className="type-caption text-muted-foreground">{meeting.duration}</div>
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="truncate type-body-sm font-medium">{meeting.title}</span>
          {meeting.inProgress ? (
            <span className="chip danger">
              <span className="chip-dot" />
              In progress
            </span>
          ) : meeting.soon ? (
            <span className="chip warning">
              <span className="chip-dot" />
              Starting soon
            </span>
          ) : null}
        </div>
        <div className="mono type-caption text-muted-foreground">{meeting.code}</div>
      </div>
      <button
        className={cn("btn sm", meeting.inProgress && "primary")}
        type="button"
        aria-label={`Join ${meeting.title}`}
        onClick={() => {
          onJoin(meeting.code);
        }}
      >
        Join
      </button>
    </li>
  );
}

function MeetingLinkDialog({
  code,
  onClose,
}: {
  readonly code: string;
  readonly onClose: () => void;
}) {
  const link = meetJoinLink(code);
  return (
    <Dialog
      title="Your meeting is ready"
      onClose={onClose}
      footer={
        <button className="btn" type="button" onClick={onClose}>
          Done
        </button>
      }
    >
      <p className="m-0 mb-3 type-body-sm text-[var(--text-2)]">
        Share this link with the people you want to meet with. Save it so you can join later.
      </p>
      <div className="flex items-center gap-2 rounded-md bg-muted px-3 py-2">
        <code className="mono min-w-0 flex-1 truncate type-meta">{link}</code>
        <button
          className="icon-btn"
          type="button"
          aria-label="Copy meeting link"
          onClick={() => {
            void copyMeetingLink(link);
          }}
        >
          <CopyIcon size={16} />
        </button>
      </div>
    </Dialog>
  );
}
