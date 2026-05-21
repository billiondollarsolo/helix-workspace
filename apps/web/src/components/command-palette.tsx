import { Command } from "cmdk";
import { CalendarDays, FileText, Folder, Inbox, MessageSquare, Search } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Dialog as DialogPrimitive } from "radix-ui";
import { usePlatformSnapshot, useWebPlatformHost } from "@helix/sdk-web";
import { useDebouncedValue } from "@tanstack/react-pacer/debouncer";
import { useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useVirtualizer } from "@tanstack/react-virtual";
import { navigationTargetForSearchHit } from "@/features/search/navigation";
import { globalSearchQueryOptions } from "@/features/search/queries";
import type { GlobalSearchHit, GlobalSearchType } from "@/features/search/api";

export { navigationTargetForSearchHit } from "@/features/search/navigation";

interface CommandPaletteProps {
  open: boolean;
  setOpen: (open: boolean) => void;
}

const searchResultEstimatedSize = 56;
const searchDebounceMs = 300;

export function CommandPalette({ open, setOpen }: CommandPaletteProps) {
  const host = useWebPlatformHost();
  const navigate = useNavigate();
  const searchResultsRef = useRef<HTMLDivElement | null>(null);
  const [search, setSearch] = useState("");
  const normalizedSearch = search.trim();
  const [debouncedNormalizedSearch] = useDebouncedValue(normalizedSearch, {
    wait: searchDebounceMs,
  });
  const items = usePlatformSnapshot((platformHost) => platformHost.getCommandPaletteItems());
  const searchQuery = useQuery({
    ...globalSearchQueryOptions({ query: debouncedNormalizedSearch, limit: 8 }),
    enabled: open && debouncedNormalizedSearch.length > 0,
  });
  const groupedItems = useMemo(() => {
    const groups = new Map<string, typeof items>();
    for (const item of items) {
      if (!commandMatchesSearch(item, normalizedSearch)) {
        continue;
      }
      const group = item.group ?? "Commands";
      groups.set(group, [...(groups.get(group) ?? []), item]);
    }
    return [...groups.entries()];
  }, [items, normalizedSearch]);

  const searchHits =
    normalizedSearch.length > 0 && debouncedNormalizedSearch.length > 0
      ? (searchQuery.data?.hits ?? [])
      : [];
  const searchResultVirtualizer = useVirtualizer({
    count: searchHits.length,
    getScrollElement: () => searchResultsRef.current,
    estimateSize: () => searchResultEstimatedSize,
    overscan: 4,
    initialRect: { height: 420, width: 640 },
  });
  const measuredVirtualSearchRows = searchResultVirtualizer.getVirtualItems();
  const virtualSearchRows =
    measuredVirtualSearchRows.length > 0 || searchHits.length === 0
      ? measuredVirtualSearchRows
      : searchHits.slice(0, 20).map((_, index) => ({
          end: (index + 1) * searchResultEstimatedSize,
          index,
          key: index,
          lane: 0,
          size: searchResultEstimatedSize,
          start: index * searchResultEstimatedSize,
        }));
  const showEmptyState =
    normalizedSearch.length > 0 &&
    !searchQuery.isLoading &&
    !searchQuery.isError &&
    searchHits.length === 0 &&
    groupedItems.length === 0;

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setOpen(!open);
      }
    };

    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open, setOpen]);

  return (
    <Command.Dialog
      className="command-dialog"
      label="Command palette"
      onOpenChange={setOpen}
      open={open}
      shouldFilter={false}
    >
      <DialogPrimitive.Title className="sr-only">Command palette</DialogPrimitive.Title>
      <DialogPrimitive.Description className="sr-only">
        Search workspace content and run Helix commands.
      </DialogPrimitive.Description>
      <div className="command-input-wrap">
        <Search aria-hidden="true" size={18} />
        <Command.Input
          autoFocus
          onValueChange={setSearch}
          placeholder="Search Helix or run a command..."
          value={search}
        />
      </div>
      <Command.List>
        {normalizedSearch.length > 0 ? (
          <Command.Group heading="Search">
            {searchQuery.isLoading ? (
              <Command.Loading>
                <div className="command-status">Searching Helix...</div>
              </Command.Loading>
            ) : null}
            {searchQuery.isError ? (
              <div className="command-status">Search is unavailable. Try again in a moment.</div>
            ) : null}
            {searchHits.length > 0 ? (
              <div
                data-testid="command-palette-search-virtualizer"
                ref={searchResultsRef}
                style={{
                  height: Math.min(
                    searchResultVirtualizer.getTotalSize(),
                    searchResultEstimatedSize * 8,
                  ),
                  overflowY: "auto",
                  position: "relative",
                }}
              >
                <div
                  style={{
                    height: searchResultVirtualizer.getTotalSize(),
                    position: "relative",
                    width: "100%",
                  }}
                >
                  {virtualSearchRows.map((virtualRow) => {
                    const hit = searchHits[virtualRow.index];
                    return hit === undefined ? null : (
                      <div
                        data-index={virtualRow.index}
                        key={virtualRow.key}
                        ref={searchResultVirtualizer.measureElement}
                        style={{
                          left: 0,
                          position: "absolute",
                          top: 0,
                          transform: `translateY(${String(virtualRow.start)}px)`,
                          width: "100%",
                        }}
                      >
                        <SearchHitCommandItem hit={hit} navigate={navigate} setOpen={setOpen} />
                      </div>
                    );
                  })}
                </div>
              </div>
            ) : null}
          </Command.Group>
        ) : null}
        {groupedItems.map(([group, groupItems]) => (
          <Command.Group heading={group} key={group}>
            {groupItems.map((item) => (
              <Command.Item
                key={item.id}
                keywords={[...(item.keywords ?? []), item.label, item.pluginId]}
                onSelect={() => {
                  setOpen(false);
                  void item.run();
                }}
                value={item.id}
              >
                <span>{item.label}</span>
                {item.shortcut ? <kbd>{item.shortcut}</kbd> : null}
              </Command.Item>
            ))}
          </Command.Group>
        ))}
        {showEmptyState ? <div className="command-status">No matching results.</div> : null}
      </Command.List>
      <span className="sr-only">{host.trpc.endpoint}</span>
    </Command.Dialog>
  );
}

type CommandPaletteItem = ReturnType<
  ReturnType<typeof useWebPlatformHost>["getCommandPaletteItems"]
>[number];

type Navigate = ReturnType<typeof useNavigate>;

interface SearchHitCommandItemProps {
  readonly hit: GlobalSearchHit;
  readonly navigate: Navigate;
  readonly setOpen: (open: boolean) => void;
}

function commandMatchesSearch(item: CommandPaletteItem, query: string): boolean {
  if (query.length === 0) {
    return true;
  }

  const normalizedQuery = query.toLowerCase();
  return [item.label, item.pluginId, item.group, item.shortcut, ...(item.keywords ?? [])]
    .filter((value): value is string => typeof value === "string")
    .some((value) => value.toLowerCase().includes(normalizedQuery));
}

function SearchHitCommandItem({ hit, navigate, setOpen }: SearchHitCommandItemProps) {
  const Icon = iconForSearchType(hit.type);
  return (
    <Command.Item
      onSelect={() => {
        setOpen(false);
        openSearchHit(hit, navigate);
      }}
      value={`search:${hit.id}`}
    >
      <Icon aria-hidden="true" className="command-result-icon" size={16} />
      <span className="command-result-copy">
        <strong>{hit.title ?? labelForSearchType(hit.type)}</strong>
        {hit.body ? <small>{hit.body}</small> : null}
      </span>
      <span className="command-result-type">{labelForSearchType(hit.type)}</span>
    </Command.Item>
  );
}

function openSearchHit(hit: GlobalSearchHit, navigate: Navigate): void {
  const target = navigationTargetForSearchHit(hit);
  switch (target.route) {
    case "/mail":
      void navigate({
        to: "/mail",
        search: { thread: target.thread, message: target.message },
      });
      return;
    case "/chat":
      void navigate({
        to: "/chat",
        search: { room: target.room, message: target.message },
      });
      return;
    case "/drive":
      void navigate({
        to: "/drive",
        search: { file: target.file },
      });
      return;
    case "/calendar":
      void navigate({
        to: "/calendar",
        search: { event: target.event },
      });
      return;
  }
}

function iconForSearchType(type: GlobalSearchType) {
  switch (type) {
    case "mail":
      return Inbox;
    case "chat":
      return MessageSquare;
    case "docs":
      return FileText;
    case "drive":
      return Folder;
    case "calendar":
      return CalendarDays;
  }
}

function labelForSearchType(type: GlobalSearchType): string {
  switch (type) {
    case "mail":
      return "Mail";
    case "chat":
      return "Chat";
    case "docs":
      return "Docs";
    case "drive":
      return "Drive";
    case "calendar":
      return "Calendar";
  }
}
