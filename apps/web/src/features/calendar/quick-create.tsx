/* Quick create: the small form that opens on an empty time slot. */

import { X } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { formatLongDate, formatTimeRange, type TimeFormat } from "./date-math";
import type { EventDraft } from "./event-draft";
import { useTimeFormat } from "./preferences";

function quickCreateWhen(draft: EventDraft, format: TimeFormat): string {
  if (draft.allDay) return `${formatLongDate(draft.startDate)} · All day`;
  const end = draft.endDate > draft.startDate && draft.endTime === 0 ? 24 : draft.endTime;
  return `${formatLongDate(draft.startDate)} · ${formatTimeRange(draft.startTime, end, format)}`;
}

export function QuickCreate({
  draft,
  pending,
  onSave,
  onMoreOptions,
  onClose,
}: {
  readonly draft: EventDraft;
  readonly pending: boolean;
  readonly onSave: (draft: EventDraft) => void;
  readonly onMoreOptions: (draft: EventDraft) => void;
  readonly onClose: () => void;
}) {
  const [title, setTitle] = useState(draft.title);
  const format = useTimeFormat();
  const current = { ...draft, title };
  return (
    <form
      className="relative flex flex-col gap-3 p-4 pr-12"
      onSubmit={(event) => {
        event.preventDefault();
        if (!pending) onSave(current);
      }}
    >
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label="Close"
        className="absolute top-2 right-2"
        onClick={onClose}
      >
        <X aria-hidden="true" />
      </Button>
      <input
        autoFocus
        aria-label="Title"
        placeholder="Add title"
        className="cal-title-field type-h3"
        value={title}
        onChange={(event) => setTitle(event.target.value)}
      />
      <p className="m-0 type-body-sm">{quickCreateWhen(draft, format)}</p>
      <div className="-mr-8 flex items-center justify-end gap-2">
        <Button type="button" variant="ghost" onClick={() => onMoreOptions(current)}>
          More options
        </Button>
        <Button type="submit" disabled={pending}>
          {pending ? "Saving…" : "Save"}
        </Button>
      </div>
    </form>
  );
}
