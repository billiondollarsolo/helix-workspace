/* Admin search: one box for settings, users and groups (WAI-ARIA combobox
 * with a listbox popup). Settings come from a static index of pages and the
 * settings on them; users come from the directory API and groups from the
 * groups API, so results cover the whole organization. */

import { useQuery } from "@tanstack/react-query";
import { useDebouncedValue } from "@tanstack/react-pacer/debouncer";
import { useNavigate } from "@tanstack/react-router";
import { Search as SearchIcon, Settings as SettingsIcon, Users as UsersIcon } from "lucide-react";
import { useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Avatar } from "@/components/ui/avatar";
import type { AdminSectionId } from "@/features/admin/admin-console-data";
import { adminUsersQueryOptions } from "@/features/admin/admin-users";
import { groupsQueryOptions } from "@/features/admin/groups-api";
import { searchAdminSettings } from "./search-index";

const PEOPLE_LIMIT = 5;
const GROUP_LIMIT = 5;

type ResultKind = "setting" | "user" | "group";

interface SearchResult {
  readonly key: string;
  readonly kind: ResultKind;
  readonly title: string;
  readonly detail: string;
  readonly section: AdminSectionId;
  readonly search: Record<string, string>;
}

const KIND_HEADING: Record<ResultKind, string> = {
  setting: "Settings",
  user: "Users",
  group: "Groups",
};

export function AdminSearch() {
  const id = useId();
  const listboxId = `${id}-listbox`;
  const navigate = useNavigate();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [text, setText] = useState("");
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const trimmed = text.trim();
  const [debounced] = useDebouncedValue(trimmed, { wait: 200 });

  const usersQuery = useQuery({
    ...adminUsersQueryOptions({ query: debounced, limit: PEOPLE_LIMIT, includeDisabled: true }),
    enabled: debounced.length > 0,
  });
  const groupsQuery = useQuery({ ...groupsQueryOptions(), enabled: debounced.length > 0 });

  const results = useMemo<readonly SearchResult[]>(() => {
    if (trimmed.length === 0) {
      return [];
    }
    const settings = searchAdminSettings(trimmed).map((entry): SearchResult => ({
      key: `setting:${entry.section}:${entry.tab ?? ""}:${entry.title}`,
      kind: "setting",
      title: entry.title,
      detail: entry.location,
      section: entry.section,
      search: entry.tab === undefined ? {} : { tab: entry.tab },
    }));
    const needle = debounced.toLowerCase();
    const users =
      debounced.length === 0
        ? []
        : (usersQuery.data?.users ?? []).map((user): SearchResult => ({
            key: `user:${user.id}`,
            kind: "user",
            title: user.displayName || user.email || "Unnamed account",
            detail: user.email ?? "No email address",
            section: "users",
            search: { user: user.id },
          }));
    const groups =
      debounced.length === 0
        ? []
        : (groupsQuery.data ?? [])
            .filter(
              (group) =>
                group.name.toLowerCase().includes(needle) ||
                (group.email ?? "").toLowerCase().includes(needle),
            )
            .slice(0, GROUP_LIMIT)
            .map((group): SearchResult => ({
              key: `group:${group.id}`,
              kind: "group",
              title: group.name,
              detail: group.email ?? `${String(group.memberCount)} members`,
              section: "groups",
              search: { group: group.id },
            }));
    return [...settings, ...users, ...groups];
  }, [trimmed, debounced, usersQuery.data, groupsQuery.data]);

  const searching = debounced !== trimmed || usersQuery.isFetching || groupsQuery.isFetching;
  const expanded = open && trimmed.length > 0;
  const listOpen = expanded && results.length > 0;
  const active = results.length === 0 ? -1 : Math.min(activeIndex, results.length - 1);
  const optionId = (index: number) => `${listboxId}-${String(index)}`;

  const choose = (result: SearchResult) => {
    setOpen(false);
    setText("");
    inputRef.current?.blur();
    void navigate({
      to: "/admin/$section",
      params: { section: result.section },
      search: result.search,
    });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setOpen(true);
      if (results.length > 0) {
        const step = event.key === "ArrowDown" ? 1 : -1;
        setActiveIndex((Math.max(active, 0) + step + results.length) % results.length);
      }
      return;
    }
    if (event.key === "Enter") {
      const result = results[active];
      if (listOpen && result !== undefined) {
        event.preventDefault();
        choose(result);
      }
      return;
    }
    if (event.key === "Escape") {
      if (expanded) {
        event.preventDefault();
        setOpen(false);
      } else if (text.length > 0) {
        event.preventDefault();
        setText("");
      }
    }
  };

  return (
    <div className="admin-search">
      <SearchIcon className="admin-search-icon" size={16} aria-hidden="true" />
      <input
        ref={inputRef}
        type="search"
        role="combobox"
        aria-label="Search admin settings, users, and groups"
        aria-expanded={listOpen}
        aria-controls={listboxId}
        aria-autocomplete="list"
        aria-activedescendant={listOpen && active >= 0 ? optionId(active) : undefined}
        placeholder="Search for users, groups, or settings"
        autoComplete="off"
        value={text}
        onChange={(event) => {
          setText(event.target.value);
          setActiveIndex(0);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={onKeyDown}
      />
      <div
        id={listboxId}
        role="listbox"
        aria-label="Search results"
        className="admin-search-results"
        hidden={!listOpen}
      >
        {(["setting", "user", "group"] as const).map((kind) => {
          const entries = results
            .map((result, index) => ({ result, index }))
            .filter((entry) => entry.result.kind === kind);
          return entries.length === 0 ? null : (
            <div key={kind} role="group" aria-label={KIND_HEADING[kind]}>
              <div className="admin-search-heading" aria-hidden="true">
                {KIND_HEADING[kind]}
              </div>
              {entries.map(({ result, index }) => (
                <div
                  key={result.key}
                  id={optionId(index)}
                  role="option"
                  aria-selected={index === active}
                  className="admin-search-option"
                  /* mousedown, not click: the input's blur would close the list first. */
                  onMouseDown={(event) => {
                    event.preventDefault();
                    choose(result);
                  }}
                  onMouseMove={() => setActiveIndex(index)}
                >
                  <span className="admin-search-option-icon" aria-hidden="true">
                    {kind === "user" ? (
                      <Avatar name={result.title} size={24} />
                    ) : kind === "group" ? (
                      <UsersIcon size={16} />
                    ) : (
                      <SettingsIcon size={16} />
                    )}
                  </span>
                  <span className="admin-search-option-text">
                    <span className="admin-search-option-title">{result.title}</span>
                    <span className="admin-search-option-detail">{result.detail}</span>
                  </span>
                </div>
              ))}
            </div>
          );
        })}
      </div>
      {expanded && results.length === 0 ? (
        <div className="admin-search-results admin-search-empty">
          {searching ? "Searching…" : `No results for “${trimmed}”`}
        </div>
      ) : null}
      <span className="sr-only" role="status" aria-live="polite">
        {expanded && !searching
          ? `${String(results.length)} result${results.length === 1 ? "" : "s"}`
          : ""}
      </span>
    </div>
  );
}
