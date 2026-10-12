import { MoreVertical, Plus } from "lucide-react";
import { useId, type CSSProperties } from "react";
import { Button } from "@/components/ui/button";
import { DateTimePicker } from "@/components/ui/date-time-picker";
import { InlineError } from "@/components/ui/inline-error";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "@/components/ui/menu";
import { Skeleton } from "@/components/ui/skeleton";
import { labelFill } from "./colors";
import { pickerWeekStart, type WeekStartDay } from "./date-math";
import type { CalendarManageAction } from "./calendar-manage-dialog";
import type { CalendarSource } from "./event-model";

function isoToLocalDate(iso: string): Date {
  return new Date(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10)));
}

function localDateToIso(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${String(date.getFullYear())}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Owners and managers may change who a calendar is shared with. */
function canManageCalendar(calendar: CalendarSource): boolean {
  return calendar.role === "owner" || calendar.role === "manager";
}

export function CalendarSidebar({
  anchor,
  weekStartsOn,
  calendars,
  loading,
  error,
  retrying,
  hidden,
  onCreate,
  onPickDate,
  onToggleCalendar,
  onShowOnly,
  onOpenSettings,
  onManage,
  onRetry,
}: {
  readonly anchor: string;
  readonly weekStartsOn: WeekStartDay;
  readonly calendars: readonly CalendarSource[];
  readonly loading: boolean;
  readonly error: boolean;
  readonly retrying: boolean;
  readonly hidden: ReadonlySet<string>;
  readonly onCreate: () => void;
  readonly onPickDate: (iso: string) => void;
  readonly onToggleCalendar: (id: string) => void;
  readonly onShowOnly: (id: string) => void;
  readonly onOpenSettings: (calendar: CalendarSource) => void;
  readonly onManage: (action: CalendarManageAction) => void;
  readonly onRetry: () => void;
}) {
  const mine = calendars.filter((calendar) => calendar.group === "mine");
  const other = calendars.filter((calendar) => calendar.group === "team");

  return (
    <aside aria-label="Calendar navigation" className="surf-sidebar cal-sidebar">
      {/* The shared sidebar primary action: it stays as an icon when navigation is collapsed. */}
      <button type="button" className="btn primary lg w-full" onClick={onCreate}>
        <Plus aria-hidden="true" size={18} />
        Create
      </button>

      <DateTimePicker
        key={anchor.slice(0, 7)}
        mode="date"
        label="Go to date"
        value={isoToLocalDate(anchor)}
        weekStartsOn={pickerWeekStart(weekStartsOn)}
        onChange={(date) => onPickDate(localDateToIso(date))}
      />

      {loading ? <Skeleton variant="text" count={3} label="Loading calendars" /> : null}
      {error && !loading ? (
        <InlineError
          variant="compact"
          title="Couldn't load your calendars"
          message="Events from every calendar still show; try again to filter them."
          onRetry={onRetry}
          retrying={retrying}
        />
      ) : null}
      {!loading && !error ? (
        <>
          <CalendarGroup
            title="My calendars"
            onAdd={() => onManage({ kind: "create" })}
            calendars={mine}
            hidden={hidden}
            onToggle={onToggleCalendar}
            onShowOnly={onShowOnly}
            onOpenSettings={onOpenSettings}
            onManage={onManage}
          />
          {other.length > 0 ? (
            <CalendarGroup
              title="Other calendars"
              calendars={other}
              hidden={hidden}
              onToggle={onToggleCalendar}
              onShowOnly={onShowOnly}
              onOpenSettings={onOpenSettings}
              onManage={onManage}
            />
          ) : null}
        </>
      ) : null}
    </aside>
  );
}

function CalendarGroup({
  title,
  onAdd,
  calendars,
  hidden,
  onToggle,
  onShowOnly,
  onOpenSettings,
  onManage,
}: {
  readonly title: string;
  readonly onAdd?: () => void;
  readonly calendars: readonly CalendarSource[];
  readonly hidden: ReadonlySet<string>;
  readonly onToggle: (id: string) => void;
  readonly onShowOnly: (id: string) => void;
  readonly onOpenSettings: (calendar: CalendarSource) => void;
  readonly onManage: (action: CalendarManageAction) => void;
}) {
  const headingId = useId();
  return (
    <section aria-labelledby={headingId}>
      <div className="flex items-center justify-between">
        <h2 id={headingId} className="section-label m-0 py-1">
          {title}
        </h2>
        {onAdd === undefined ? null : (
          <Button variant="ghost" size="icon-xs" aria-label="Create new calendar" onClick={onAdd}>
            <Plus aria-hidden="true" />
          </Button>
        )}
      </div>
      {calendars.length === 0 ? (
        <p className="type-caption text-muted-foreground m-0 px-1">No calendars yet.</p>
      ) : (
        <ul className="m-0 p-0 list-none">
          {calendars.map((calendar) => (
            <CalendarRow
              key={calendar.id}
              calendar={calendar}
              checked={!hidden.has(calendar.id)}
              onToggle={() => onToggle(calendar.id)}
              onShowOnly={() => onShowOnly(calendar.id)}
              onOpenSettings={() => onOpenSettings(calendar)}
              onManage={(kind) => onManage({ kind, calendar })}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function CalendarRow({
  calendar,
  checked,
  onToggle,
  onShowOnly,
  onOpenSettings,
  onManage,
}: {
  readonly calendar: CalendarSource;
  readonly checked: boolean;
  readonly onToggle: () => void;
  readonly onShowOnly: () => void;
  readonly onOpenSettings: () => void;
  readonly onManage: (kind: "rename" | "color" | "delete") => void;
}) {
  const id = useId();
  return (
    <li
      className="cal-calendar-row"
      style={{ "--swatch": labelFill(calendar.label) } as CSSProperties}
    >
      <input id={id} type="checkbox" checked={checked} onChange={onToggle} className="focus-ring" />
      <label htmlFor={id} className="flex-1 min-w-0 truncate type-body-sm cursor-pointer">
        {calendar.name}
      </label>
      <Menu>
        <MenuTrigger asChild>
          <Button variant="ghost" size="icon-xs" aria-label={`Options for ${calendar.name}`}>
            <MoreVertical aria-hidden="true" />
          </Button>
        </MenuTrigger>
        <MenuContent align="end">
          <MenuItem onSelect={onShowOnly}>Display this only</MenuItem>
          {canManageCalendar(calendar) ? (
            <>
              <MenuItem onSelect={() => onManage("rename")}>Rename</MenuItem>
              <MenuItem onSelect={() => onManage("color")}>Color</MenuItem>
              <MenuItem onSelect={onOpenSettings}>Settings and sharing</MenuItem>
            </>
          ) : null}
          {calendar.role === "owner" && !calendar.isDefault ? (
            <MenuItem onSelect={() => onManage("delete")}>Delete</MenuItem>
          ) : null}
        </MenuContent>
      </Menu>
    </li>
  );
}
