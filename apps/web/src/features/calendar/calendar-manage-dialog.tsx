/* Create, rename, recolour and delete a calendar. One dialog serves all four
   so the sidebar only tracks which calendar and which action is open. */

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useId, useState, type CSSProperties, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/helix-dialog";
import { InlineError } from "@/components/ui/inline-error";
import { Input } from "@/components/ui/input";
import { notify } from "@/components/ui/toast";
import { createCalendar, deleteCalendar, updateCalendar } from "./api";
import { CALENDAR_LABELS, DEFAULT_CALENDAR_LABEL, labelFill, type CalendarLabel } from "./colors";
import type { CalendarSource } from "./event-model";

export type CalendarManageAction =
  | { readonly kind: "create" }
  | { readonly kind: "rename" | "color" | "delete"; readonly calendar: CalendarSource };

const TITLES = {
  create: "Create new calendar",
  rename: "Rename calendar",
  color: "Calendar colour",
  delete: "Delete calendar",
} as const;

function errorText(error: unknown): string {
  return error instanceof Error && error.message.trim() !== ""
    ? error.message
    : "Something went wrong. Try again.";
}

export function CalendarManageDialog({
  action,
  onClose,
}: {
  readonly action: CalendarManageAction;
  readonly onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const calendar = action.kind === "create" ? null : action.calendar;
  const [name, setName] = useState(calendar?.name ?? "");
  const [color, setColor] = useState<CalendarLabel>(calendar?.label ?? DEFAULT_CALENDAR_LABEL);
  const nameId = useId();
  const formId = useId();

  const [error, setError] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: async () => {
      const trimmed = name.trim();
      if (action.kind === "create") await createCalendar({ name: trimmed, color });
      else if (action.kind === "rename") {
        await updateCalendar({ calendarId: action.calendar.id, name: trimmed });
      } else if (action.kind === "color") {
        await updateCalendar({ calendarId: action.calendar.id, color });
      } else await deleteCalendar(action.calendar.id);
    },
    onMutate: () => setError(null),
    onError: (cause) => setError(errorText(cause)),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["calendar"] });
      notify({
        message:
          action.kind === "create"
            ? `Created ${name.trim()}`
            : action.kind === "delete"
              ? `Deleted ${action.calendar.name}`
              : "Calendar updated",
      });
      onClose();
    },
  });

  const needsName = action.kind === "create" || action.kind === "rename";
  const needsColor = action.kind === "create" || action.kind === "color";
  const invalid = needsName && name.trim() === "";
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!invalid && !save.isPending) save.mutate();
  };

  return (
    <Dialog
      title={TITLES[action.kind]}
      onClose={onClose}
      width={420}
      footer={
        <>
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="submit"
            form={formId}
            variant={action.kind === "delete" ? "destructive" : "default"}
            disabled={invalid || save.isPending}
          >
            {action.kind === "create" ? "Create" : action.kind === "delete" ? "Delete" : "Save"}
          </Button>
        </>
      }
    >
      <form id={formId} onSubmit={submit} className="flex flex-col gap-4">
        {action.kind === "delete" ? (
          <p className="m-0 type-body-sm">
            Delete <strong>{action.calendar.name}</strong> and all of its events? This cannot be
            undone, and people it is shared with lose access.
          </p>
        ) : null}
        {needsName ? (
          <div className="flex flex-col gap-1.5">
            <label htmlFor={nameId} className="type-body-sm font-medium">
              Name
            </label>
            <Input
              id={nameId}
              value={name}
              maxLength={120}
              required
              autoComplete="off"
              onChange={(event) => setName(event.target.value)}
            />
          </div>
        ) : null}
        {needsColor ? (
          <fieldset className="m-0 border-0 p-0">
            <legend className="type-body-sm font-medium mb-1.5 p-0">Colour</legend>
            <div className="cal-color-grid">
              {CALENDAR_LABELS.map((label) => (
                <label
                  key={label}
                  className="cal-color-option"
                  style={{ "--swatch": labelFill(label) } as CSSProperties}
                >
                  <input
                    type="radio"
                    name="calendar-color"
                    value={label}
                    checked={color === label}
                    onChange={() => setColor(label)}
                    className="sr-only"
                  />
                  <span className="sr-only">{label}</span>
                </label>
              ))}
            </div>
          </fieldset>
        ) : null}
        {error === null ? null : (
          <InlineError variant="compact" title="Couldn't save" message={error} />
        )}
      </form>
    </Dialog>
  );
}
