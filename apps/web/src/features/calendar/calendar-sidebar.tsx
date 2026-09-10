import { Plus as PlusIcon, Search as SearchIcon } from "lucide-react";
import { type CalendarSidebarEntry } from "./data";

/* ------------------------------------------------------------------ sidebar */

export function CalendarSidebar({
  query,
  onSearchChange,
  calendars,
  calendarsLoading,
  calendarsError,
  visibility,
  onToggleCalendar,
  onCreate,
}: {
  readonly query: string;
  readonly onSearchChange: (value: string) => void;
  readonly calendars: readonly CalendarSidebarEntry[];
  readonly calendarsLoading: boolean;
  readonly calendarsError: boolean;
  readonly visibility: Readonly<Record<string, boolean>>;
  readonly onToggleCalendar: (id: string) => void;
  readonly onCreate: () => void;
}) {
  const mineSources = calendars.filter((source) => source.group === "mine");
  const teamSources = calendars.filter((source) => source.group === "team");

  const renderGroup = (
    label: string,
    entries: readonly CalendarSidebarEntry[],
    className: string,
  ) => (
    <>
      <div className={`section-label ${className}`}>{label}</div>
      {entries.map((source) => (
        <CalendarCheck
          key={source.id}
          checked={visibility[source.id] ?? source.visible}
          color={source.color}
          name={source.name}
          onToggle={() => onToggleCalendar(source.id)}
        />
      ))}
      {entries.length === 0 && (
        <div className="[font-size:var(--text-caption)] text-muted-foreground [padding:4px_0]">
          No calendars
        </div>
      )}
    </>
  );

  return (
    <aside aria-label="Calendar navigation" className="surf-sidebar">
      <button
        className="btn primary lg w-full mb-4"

        type="button"
        onClick={onCreate}
      >
        <PlusIcon size={16} />
        Create
      </button>

      <label className="row gap-2 mb-4 [padding:0_8px] h-7.5 rounded-md [border:1px_solid_var(--border)] bg-muted">
        <SearchIcon size={14} />
        <span className="sr-only">Search events</span>
        <input
          onChange={(event) => onSearchChange(event.target.value)}
          placeholder="Search events"
          className="[border:none] bg-transparent outline-none [font-size:var(--text-body)] w-full text-foreground"
          type="search"
          value={query}
        />
      </label>

      {calendarsLoading && (
        <div className="[font-size:var(--text-meta)] text-muted-foreground [padding:8px_0]">
          Loading calendars…
        </div>
      )}

      {calendarsError && !calendarsLoading && (
        <div
          role="alert"
          className="[font-size:var(--text-caption)] text-destructive [padding:4px_0_8px]"
        >
          Calendars unavailable — try again later.
        </div>
      )}

      {!calendarsLoading && !calendarsError && (
        <>
          {renderGroup("My calendars", mineSources, "[padding:8px_0_4px]")}
          {renderGroup("Team", teamSources, "[padding:12px_0_4px]")}
        </>
      )}
    </aside>
  );
}

function CalendarCheck({
  checked,
  color,
  name,
  onToggle,
}: {
  readonly checked: boolean;
  readonly color: string;
  readonly name: string;
  readonly onToggle: () => void;
}) {
  return (
    <label className="flex items-center gap-2 [padding:4px_0] [font-size:var(--text-body)] cursor-pointer">
      <input checked={checked} onChange={onToggle} style={{ accentColor: color }} type="checkbox" />
      <span>{name}</span>
    </label>
  );
}
