/* Send ▾ — the primary Send action with "Schedule send" presets behind the
   arrow, and a date-and-time dialog for anything else. */

import { useQuery } from "@tanstack/react-query";
import { CalendarClock, Clock, Send } from "lucide-react";
import { useState } from "react";
import { createPortal } from "react-dom";
import { DateTimePicker } from "@/components/ui/date-time-picker";
import { Dialog } from "@/components/ui/helix-dialog";
import { MenuItem, MenuLabel, MenuSeparator } from "@/components/ui/menu";
import { SplitButton } from "@/components/ui/split-button";
import { accountPreferencesQueryOptions } from "@/features/account/queries";
import { formatScheduleTime, scheduleSendPresets } from "./schedule-send";

interface SendButtonProps {
  readonly onSend: (sendAt?: Date) => void;
  readonly sending: boolean;
  readonly disabled: boolean;
}

export function SendButton({ onSend, sending, disabled }: SendButtonProps) {
  const preferences = useQuery(accountPreferencesQueryOptions());
  const [picking, setPicking] = useState(false);
  const presets = scheduleSendPresets(new Date(), preferences.data);
  const timeZone = preferences.data?.timeZone ?? null;

  return (
    <>
      <SplitButton
        label={sending ? "Sending…" : "Send"}
        icon={<Send aria-hidden="true" />}
        onClick={() => {
          onSend();
        }}
        menuLabel="More send options"
        disabled={disabled}
        actionDisabled={sending}
        size="sm"
      >
        <MenuLabel>Schedule send</MenuLabel>
        {presets.map((preset) => (
          <MenuItem
            key={preset.id}
            icon={<Clock size={16} />}
            onSelect={() => {
              onSend(preset.at);
            }}
          >
            {preset.label}
            <span className="compose-menu-detail">{formatScheduleTime(preset.at, timeZone)}</span>
          </MenuItem>
        ))}
        <MenuSeparator />
        <MenuItem
          icon={<CalendarClock size={16} />}
          onSelect={() => {
            setPicking(true);
          }}
        >
          Pick date &amp; time
        </MenuItem>
      </SplitButton>
      {picking ? (
        <ScheduleDialog
          weekStart={preferences.data?.weekStart ?? null}
          onClose={() => {
            setPicking(false);
          }}
          onSchedule={(at) => {
            setPicking(false);
            onSend(at);
          }}
        />
      ) : null}
    </>
  );
}

function ScheduleDialog({
  weekStart,
  onClose,
  onSchedule,
}: {
  readonly weekStart: number | null;
  readonly onClose: () => void;
  readonly onSchedule: (at: Date) => void;
}) {
  const [now] = useState(() => new Date());
  const [value, setValue] = useState<Date | null>(null);
  const valid = value !== null && value.getTime() > Date.now();
  return createPortal(
    <Dialog
      title="Pick date & time"
      onClose={onClose}
      width={360}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn primary"
            disabled={!valid}
            onClick={() => {
              if (value !== null) onSchedule(value);
            }}
          >
            Schedule send
          </button>
        </>
      }
    >
      <DateTimePicker
        value={value}
        onChange={setValue}
        min={now}
        label="Send at"
        {...(weekStart === 0 || weekStart === 1 || weekStart === 6
          ? { weekStartsOn: weekStart }
          : {})}
      />
      <p className="compose-schedule-summary" aria-live="polite">
        {value === null ? "Choose a day and time." : `Sends ${formatScheduleTime(value)}`}
      </p>
    </Dialog>,
    document.body,
  );
}
