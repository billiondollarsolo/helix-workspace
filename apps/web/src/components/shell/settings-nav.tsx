/* Settings navigation: a search box over grouped section links. Typing
   filters to the matching sections and the individual settings inside them. */

import { Search } from "lucide-react";
import { useId, useState } from "react";
import { cn } from "@/lib/utils";
import type { SettingsSectionBaseId } from "./overlay-context";
import { SETTINGS_SECTIONS, searchSettings, type SettingsSectionEntry } from "./settings-sections";

const GROUPS = ["Account", "Preferences", "Apps"] as const;

export function SettingsNav({
  active,
  onSelect,
}: {
  /** The open section; null on the mobile list, where nothing is selected. */
  readonly active: SettingsSectionBaseId | null;
  readonly onSelect: (section: SettingsSectionBaseId) => void;
}) {
  const [query, setQuery] = useState("");
  const searchId = useId();
  const resultsId = useId();
  const results = searchSettings(query);
  const searching = query.trim().length > 0;

  return (
    <nav aria-label="Settings sections" className="flex flex-col gap-3">
      <div className="relative">
        <label htmlFor={searchId} className="sr-only">
          Search settings
        </label>
        <Search
          size={16}
          aria-hidden="true"
          className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground"
        />
        <input
          id={searchId}
          type="search"
          className="input w-full [padding-left:32px]"
          placeholder="Search settings"
          autoComplete="off"
          aria-controls={resultsId}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape" && query !== "") {
              event.preventDefault();
              event.stopPropagation();
              setQuery("");
            }
          }}
        />
      </div>
      <div id={resultsId}>
        {searching ? (
          <>
            <p
              role="status"
              className="m-0 mb-1 [padding:0_10px] type-caption text-muted-foreground"
            >
              {results.length === 0
                ? `No settings match “${query.trim()}”`
                : `${String(results.length)} ${results.length === 1 ? "section" : "sections"} found`}
            </p>
            <ul className="m-0 list-none p-0">
              {results.map(({ section, matches }) => (
                <li key={section.id}>
                  <SectionLink
                    entry={section}
                    selected={active === section.id}
                    detail={matches.join(" · ")}
                    onSelect={() => {
                      setQuery("");
                      onSelect(section.id);
                    }}
                  />
                </li>
              ))}
            </ul>
          </>
        ) : (
          GROUPS.map((group) => (
            <div key={group} className="mb-2">
              <h2 className="m-0 mb-0.5 [padding:6px_10px_2px] type-overline text-muted-foreground">
                {group}
              </h2>
              <ul className="m-0 list-none p-0">
                {SETTINGS_SECTIONS.filter((entry) => entry.group === group).map((entry) => (
                  <li key={entry.id}>
                    <SectionLink
                      entry={entry}
                      selected={active === entry.id}
                      onSelect={() => onSelect(entry.id)}
                    />
                  </li>
                ))}
              </ul>
            </div>
          ))
        )}
      </div>
    </nav>
  );
}

function SectionLink({
  entry,
  selected,
  detail,
  onSelect,
}: {
  readonly entry: SettingsSectionEntry;
  readonly selected: boolean;
  readonly detail?: string;
  readonly onSelect: () => void;
}) {
  const Icon = entry.icon;
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={selected ? "page" : undefined}
      className={cn(
        "focus-ring flex w-full items-center gap-3 rounded-full text-left min-h-9 [padding:6px_12px] type-body-sm",
        selected
          ? "[background:var(--accent-soft)] text-primary font-semibold"
          : "bg-transparent text-foreground hover:bg-muted",
      )}
    >
      <Icon size={18} aria-hidden="true" className="shrink-0" />
      <span className="min-w-0">
        <span className="block">{entry.label}</span>
        {detail ? (
          <span className="block type-caption font-normal text-muted-foreground">{detail}</span>
        ) : null}
      </span>
    </button>
  );
}
