/* A searchable time-zone picker: an ARIA 1.2 combobox over every IANA zone
   the browser knows, labelled with its current GMT offset. */

import { useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { cn } from "@/lib/utils";

export interface TimeZoneOption {
  readonly id: string;
  readonly label: string;
}

function zoneOffsetMinutes(zone: string, now: Date): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    timeZoneName: "longOffset",
  }).formatToParts(now);
  const name = parts.find((part) => part.type === "timeZoneName")?.value ?? "GMT";
  const match = /GMT([+-])(\d{2}):?(\d{2})?/u.exec(name);
  if (match === null) return 0;
  const minutes = Number(match[2]) * 60 + Number(match[3] ?? 0);
  return match[1] === "-" ? -minutes : minutes;
}

function offsetLabel(minutes: number): string {
  const sign = minutes < 0 ? "-" : "+";
  const absolute = Math.abs(minutes);
  return `GMT${sign}${String(Math.floor(absolute / 60)).padStart(2, "0")}:${String(absolute % 60).padStart(2, "0")}`;
}

/** "(GMT-07:00) America/Los Angeles", sorted by offset then name. */
export function timeZoneOptions(now = new Date()): readonly TimeZoneOption[] {
  const zones = Intl.supportedValuesOf("timeZone");
  const withUtc = zones.includes("UTC") ? zones : ["UTC", ...zones];
  return withUtc
    .map((id) => ({ id, offset: zoneOffsetMinutes(id, now) }))
    .sort((left, right) => left.offset - right.offset || left.id.localeCompare(right.id))
    .map(({ id, offset }) => ({
      id,
      label: `(${offsetLabel(offset)}) ${id.replaceAll("_", " ")}`,
    }));
}

export function TimeZonePicker({
  id,
  value,
  onChange,
  describedBy,
}: {
  readonly id: string;
  readonly value: string;
  readonly onChange: (zone: string) => void;
  readonly describedBy?: string;
}) {
  const options = useMemo(() => timeZoneOptions(), []);
  const selected = options.find((option) => option.id === value);
  const listId = useId();
  const [query, setQuery] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLUListElement | null>(null);
  const open = query !== null;
  const filtered = useMemo(() => {
    const words = (query ?? "").toLowerCase().replaceAll("_", " ").split(/\s+/u).filter(Boolean);
    return options
      .filter((option) => words.every((word) => option.label.toLowerCase().includes(word)))
      .slice(0, 100);
  }, [options, query]);

  const commit = (option: TimeZoneOption | undefined) => {
    if (option !== undefined && option.id !== value) onChange(option.id);
    setQuery(null);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!open) {
        setQuery("");
        setActive(0);
        return;
      }
      const step = event.key === "ArrowDown" ? 1 : -1;
      const next = Math.min(filtered.length - 1, Math.max(0, active + step));
      setActive(next);
      listRef.current?.children[next]?.scrollIntoView({ block: "nearest" });
    } else if (event.key === "Enter" && open) {
      event.preventDefault();
      commit(filtered[active]);
    } else if (event.key === "Escape" && open) {
      event.preventDefault();
      setQuery(null);
    }
  };

  return (
    <div className="relative max-w-105">
      <input
        id={id}
        className="input w-full"
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-describedby={describedBy}
        aria-activedescendant={open && filtered[active] ? `${listId}-${String(active)}` : undefined}
        autoComplete="off"
        spellCheck={false}
        placeholder="Search for a city or zone"
        value={query ?? selected?.label ?? value}
        onFocus={(event) => event.currentTarget.select()}
        onChange={(event) => {
          setQuery(event.target.value);
          setActive(0);
        }}
        onKeyDown={onKeyDown}
        onBlur={() => setQuery(null)}
      />
      <ul
        ref={listRef}
        id={listId}
        role="listbox"
        aria-label="Time zones"
        hidden={!open}
        className="absolute left-0 right-0 top-full z-10 m-0 mt-1 max-h-64 list-none overflow-y-auto rounded-md border border-border bg-card p-1 [box-shadow:var(--shadow-md)]"
      >
        {filtered.length === 0 ? (
          <li
            role="option"
            aria-selected={false}
            aria-disabled="true"
            className="[padding:6px_8px] type-body-sm text-muted-foreground"
          >
            No matching time zones
          </li>
        ) : (
          filtered.map((option, index) => (
            <li
              key={option.id}
              id={`${listId}-${String(index)}`}
              role="option"
              aria-selected={option.id === value}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => commit(option)}
              className={cn(
                "cursor-pointer rounded [padding:6px_8px] type-body-sm",
                index === active ? "bg-muted" : "",
                option.id === value ? "font-semibold" : "",
              )}
            >
              {option.label}
            </li>
          ))
        )}
      </ul>
    </div>
  );
}
