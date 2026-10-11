/* The full event editor, shown in place of the calendar grid. */

import { Bell, CalendarDays, MapPin, Text as TextIcon, Trash2, Video, X } from "lucide-react";
import { useId, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";
import { PeoplePicker } from "@/components/people/people-picker";
import { Button } from "@/components/ui/button";
import { InlineError } from "@/components/ui/inline-error";
import { labelFill } from "./colors";
import type { WeekStartDay } from "./date-math";
import { draftProblem, type EventDraft } from "./event-draft";
import type { CalendarSource } from "./event-model";
import { EventTimeFields, withStart } from "./event-time-fields";
import { FindTimePanel } from "./find-time-panel";
import type { WorkingHours } from "./preferences";
import {
  DEFAULT_REMINDER,
  MAX_REMINDER_MINUTES,
  REMINDER_UNITS,
  type ReminderUnit,
} from "./reminders";

type EditorTab = "details" | "find";

function FieldRow({ icon, children }: { readonly icon: ReactNode; readonly children: ReactNode }) {
  return (
    <div className="grid grid-cols-[20px_minmax(0,1fr)] gap-x-3 items-start">
      <span aria-hidden="true" className="mt-2 text-muted-foreground [&_svg]:size-5">
        {icon}
      </span>
      <div className="min-w-0 flex flex-wrap items-center gap-2">{children}</div>
    </div>
  );
}

export function EventEditor({
  initial,
  calendars,
  weekStartsOn,
  workingHours,
  viewerTimeZone,
  selfActorId,
  pending,
  error,
  onSave,
  onClose,
}: {
  readonly initial: EventDraft;
  readonly calendars: readonly CalendarSource[];
  readonly weekStartsOn: WeekStartDay;
  readonly workingHours: WorkingHours;
  readonly viewerTimeZone: string;
  readonly selfActorId: string | null;
  readonly pending: boolean;
  readonly error: string | null;
  readonly onSave: (draft: EventDraft) => void;
  readonly onClose: () => void;
}) {
  const ids = useId();
  const [draft, setDraft] = useState(initial);
  const [tab, setTab] = useState<EditorTab>("details");
  const problem = draftProblem(draft);
  const writable = calendars.filter((calendar) => calendar.writable);
  const selectedCalendar = writable.find((calendar) => calendar.id === draft.calendarId);
  const hasConference = draft.conference !== null || draft.addConference;
  const heading = draft.mode === "create" ? "New event" : "Edit event";

  const onTabKey = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
      event.preventDefault();
      const next: EditorTab = tab === "details" ? "find" : "details";
      setTab(next);
      document.getElementById(`${ids}-tab-${next}`)?.focus();
    }
  };

  return (
    <section className="cal-editor" aria-labelledby={`${ids}-heading`} data-calendar-editor>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (problem === null && !pending) onSave(draft);
        }}
      >
        <div className="sticky top-0 z-10 flex items-center gap-3 border-b border-border bg-[var(--surface)] px-4 py-2">
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="Close editor"
            title="Close (Esc)"
            onClick={onClose}
          >
            <X aria-hidden="true" />
          </Button>
          <h2 id={`${ids}-heading`} className="sr-only">
            {heading}
          </h2>
          <input
            autoFocus
            aria-label="Title"
            placeholder="Add title"
            className="cal-title-field type-h2 flex-1 min-w-0"
            value={draft.title}
            onChange={(event) => setDraft({ ...draft, title: event.target.value })}
          />
          <Button type="submit" disabled={problem !== null || pending}>
            {pending ? "Saving…" : "Save"}
          </Button>
        </div>

        <div className="cal-editor-grid">
          <div className="flex flex-col gap-4 min-w-0">
            {error !== null ? (
              <InlineError variant="compact" title="Couldn't save the event" message={error} />
            ) : null}
            {problem !== null ? (
              <p role="alert" className="m-0 type-body-sm text-destructive">
                {problem}
              </p>
            ) : null}
            <EventTimeFields draft={draft} weekStartsOn={weekStartsOn} onChange={setDraft} />

            <div
              role="tablist"
              aria-label="Event sections"
              className="flex gap-1 border-b border-border"
            >
              {(
                [
                  ["details", "Event details"],
                  ["find", "Find a time"],
                ] as const
              ).map(([value, label]) => (
                <button
                  key={value}
                  id={`${ids}-tab-${value}`}
                  type="button"
                  role="tab"
                  aria-selected={tab === value}
                  aria-controls={`${ids}-panel-${value}`}
                  tabIndex={tab === value ? 0 : -1}
                  className="px-3 py-2 type-body-sm font-medium border-b-2 border-transparent aria-selected:border-[var(--accent)] aria-selected:text-[var(--accent)] focus-ring"
                  onClick={() => setTab(value)}
                  onKeyDown={onTabKey}
                >
                  {label}
                </button>
              ))}
            </div>

            <div
              role="tabpanel"
              id={`${ids}-panel-${tab}`}
              aria-labelledby={`${ids}-tab-${tab}`}
              className="flex flex-col gap-4"
            >
              {tab === "find" ? (
                <FindTimePanel
                  draft={draft}
                  selfActorId={selfActorId}
                  timeZone={viewerTimeZone}
                  workingHours={workingHours}
                  onPick={(day, start) =>
                    setDraft(withStart({ ...draft, allDay: false }, day, start))
                  }
                />
              ) : (
                <>
                  <FieldRow icon={<Video />}>
                    {hasConference ? (
                      <>
                        <span className="type-body-sm">
                          {draft.conference !== null
                            ? `Video call: ${draft.conference.joinUrl}`
                            : "A video call link will be added when you save"}
                        </span>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-sm"
                          aria-label="Remove video conferencing"
                          onClick={() =>
                            setDraft({ ...draft, conference: null, addConference: false })
                          }
                        >
                          <X aria-hidden="true" />
                        </Button>
                      </>
                    ) : (
                      <Button
                        type="button"
                        variant="outline"
                        onClick={() => setDraft({ ...draft, addConference: true })}
                      >
                        Add video conferencing
                      </Button>
                    )}
                  </FieldRow>

                  <FieldRow icon={<MapPin />}>
                    <input
                      aria-label="Location"
                      placeholder="Add location"
                      className="cal-field type-body-sm flex-1 min-w-0"
                      value={draft.location}
                      onChange={(event) => setDraft({ ...draft, location: event.target.value })}
                    />
                  </FieldRow>

                  <FieldRow icon={<Bell />}>
                    {draft.reminder === null ? (
                      <Button
                        type="button"
                        variant="link"
                        size="sm"
                        onClick={() => setDraft({ ...draft, reminder: DEFAULT_REMINDER })}
                      >
                        Add notification
                      </Button>
                    ) : (
                      <>
                        <input
                          aria-label="Notify this long before"
                          type="number"
                          min={0}
                          max={MAX_REMINDER_MINUTES}
                          className="cal-field type-body-sm w-20"
                          value={String(draft.reminder.amount)}
                          onChange={(event) =>
                            setDraft({
                              ...draft,
                              reminder: {
                                unit: draft.reminder?.unit ?? "minutes",
                                amount: Math.max(0, Math.floor(Number(event.target.value) || 0)),
                              },
                            })
                          }
                        />
                        <select
                          aria-label="Notification unit"
                          className="cal-field type-body-sm"
                          value={draft.reminder.unit}
                          onChange={(event) => {
                            const unit = REMINDER_UNITS.find(
                              (candidate) => candidate === event.target.value,
                            );
                            if (unit !== undefined && draft.reminder !== null) {
                              setDraft({
                                ...draft,
                                reminder: { amount: draft.reminder.amount, unit },
                              });
                            }
                          }}
                        >
                          {REMINDER_UNITS.map((unit: ReminderUnit) => (
                            <option key={unit} value={unit}>
                              {unit}
                            </option>
                          ))}
                        </select>
                        <span className="type-body-sm">before</span>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-sm"
                          aria-label="Remove notification"
                          onClick={() => setDraft({ ...draft, reminder: null })}
                        >
                          <Trash2 aria-hidden="true" />
                        </Button>
                      </>
                    )}
                  </FieldRow>

                  <FieldRow icon={<CalendarDays />}>
                    {writable.length > 0 ? (
                      <label className="flex items-center gap-2 type-body-sm">
                        <span
                          aria-hidden="true"
                          className="cal-swatch"
                          style={
                            {
                              "--swatch": labelFill(selectedCalendar?.label ?? "blue"),
                            } as CSSProperties
                          }
                        />
                        <span className="sr-only">Calendar</span>
                        <select
                          className="cal-field type-body-sm"
                          value={draft.calendarId ?? ""}
                          disabled={draft.mode === "edit"}
                          onChange={(event) =>
                            setDraft({ ...draft, calendarId: event.target.value || null })
                          }
                        >
                          {writable.map((calendar) => (
                            <option key={calendar.id} value={calendar.id}>
                              {calendar.name}
                            </option>
                          ))}
                        </select>
                      </label>
                    ) : null}
                    <label className="flex items-center gap-2 type-body-sm">
                      <span className="sr-only">Show as</span>
                      <select
                        className="cal-field type-body-sm"
                        value={draft.busy ? "busy" : "free"}
                        onChange={(event) =>
                          setDraft({ ...draft, busy: event.target.value === "busy" })
                        }
                      >
                        <option value="busy">Busy</option>
                        <option value="free">Free</option>
                      </select>
                    </label>
                  </FieldRow>

                  <FieldRow icon={<TextIcon />}>
                    <textarea
                      aria-label="Description"
                      placeholder="Add description"
                      rows={5}
                      className="cal-field type-body-sm w-full resize-y"
                      value={draft.description}
                      onChange={(event) => setDraft({ ...draft, description: event.target.value })}
                    />
                  </FieldRow>
                </>
              )}
            </div>
          </div>

          <aside aria-labelledby={`${ids}-guests`} className="flex flex-col gap-2 min-w-0">
            <h3 id={`${ids}-guests`} className="type-body font-semibold m-0">
              Guests
            </h3>
            <PeoplePicker
              label="Add guests"
              allowExternal
              placeholder="Add guests"
              value={[...draft.guests]}
              onChange={(guests) => setDraft({ ...draft, guests })}
            />
            {draft.guests.length > 0 ? (
              <p className="m-0 type-caption text-muted-foreground">
                Guests get an invitation by email when you save.
              </p>
            ) : null}
          </aside>
        </div>
      </form>
    </section>
  );
}
