/* Snooze picker: Later today / Tomorrow / This weekend / Next week, or a
   date and time. The popover form is for toolbar and row buttons; menus
   offer the presets as items and open SnoozeDateDialog for a custom time. */

import { Button } from "@/components/ui/button";
import { DateTimePicker } from "@/components/ui/date-time-picker";
import { Dialog } from "@/components/ui/helix-dialog";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { CalendarClock } from "lucide-react";
import { useState, type ReactNode } from "react";
import { useAccountWorkingHours } from "./mail-preferences";
import { snoozeDefaultTimeMinutes, snoozePresets } from "./mail-snooze";

/** The presets for now, using the person's working hours. */
export function useSnoozePresets() {
  const workingHours = useAccountWorkingHours();
  return { presets: snoozePresets(new Date(), workingHours), workingHours };
}

function SnoozeCustomPicker({
  onSnooze,
  onCancel,
}: {
  readonly onSnooze: (until: string) => void;
  readonly onCancel: () => void;
}) {
  const { workingHours } = useSnoozePresets();
  const [value, setValue] = useState<Date | null>(null);
  const now = new Date();
  return (
    <div className="flex flex-col gap-3">
      <DateTimePicker
        value={value}
        onChange={setValue}
        min={now}
        weekStartsOn={1}
        defaultTimeMinutes={snoozeDefaultTimeMinutes(workingHours)}
        label="Snooze until"
      />
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          type="button"
          size="sm"
          disabled={value === null || value <= now}
          onClick={() => {
            if (value !== null) onSnooze(value.toISOString());
          }}
        >
          Snooze
        </Button>
      </div>
    </div>
  );
}

/** A popover from `children` (the trigger button) with the snooze choices. */
export function MailSnoozePopover({
  children,
  onSnooze,
  align = "start",
}: {
  readonly children: ReactNode;
  readonly onSnooze: (until: string) => void;
  readonly align?: "start" | "end";
}) {
  const [open, setOpen] = useState(false);
  const [custom, setCustom] = useState(false);
  const { presets } = useSnoozePresets();
  const choose = (until: string) => {
    setOpen(false);
    setCustom(false);
    onSnooze(until);
  };
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setCustom(false);
      }}
    >
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent
        aria-label="Snooze until"
        align={align}
        className={custom ? "w-auto" : "w-72 px-0 py-2"}
      >
        {custom ? (
          <SnoozeCustomPicker onSnooze={choose} onCancel={() => setCustom(false)} />
        ) : (
          <div role="group" aria-label="Snooze until" className="flex flex-col">
            <p className="m-0 px-4 pb-1 type-caption font-semibold text-muted-foreground">
              Snooze until…
            </p>
            {presets.map((preset) => (
              <button
                key={preset.id}
                type="button"
                className="mail-snooze-option focus-ring"
                onClick={() => choose(preset.until.toISOString())}
              >
                <span>{preset.label}</span>
                <span className="text-muted-foreground">{preset.detail}</span>
              </button>
            ))}
            <div className="my-1 h-px bg-border" />
            <button
              type="button"
              className="mail-snooze-option focus-ring"
              onClick={() => setCustom(true)}
            >
              <span className="inline-flex items-center gap-2">
                <CalendarClock aria-hidden="true" className="size-4" /> Pick date &amp; time
              </span>
            </button>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}

/** Modal date-and-time choice, for "Pick date & time" in menus. */
export function SnoozeDateDialog({
  onSnooze,
  onClose,
}: {
  readonly onSnooze: (until: string) => void;
  readonly onClose: () => void;
}) {
  return (
    <Dialog title="Pick date & time" onClose={onClose} width="min(560px, 100%)">
      <SnoozeCustomPicker
        onSnooze={(until) => {
          onClose();
          onSnooze(until);
        }}
        onCancel={onClose}
      />
    </Dialog>
  );
}
