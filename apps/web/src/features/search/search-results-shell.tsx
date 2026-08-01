import {
  CalendarDays,
  FileText,
  Folder,
  Inbox,
  MessageSquare,
  Search,
  type LucideIcon,
} from "lucide-react";
import {
  flexRender,
  getCoreRowModel,
  useReactTable,
  type ColumnDef,
  type Row,
} from "@tanstack/react-table";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useDebouncedValue } from "@tanstack/react-pacer/debouncer";
import { useVirtualizer, type VirtualItem } from "@tanstack/react-virtual";
import { type CSSProperties, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { globalSearchQueryOptions, invalidateGlobalSearch } from "./queries";
import type { GlobalSearchHit, GlobalSearchType } from "./api";

export interface SearchRouteSearchState {
  readonly q?: string;
  readonly types?: readonly GlobalSearchType[];
}

interface SearchResultsShellProps {
  readonly initialQuery?: string;
  readonly initialTypes?: readonly GlobalSearchType[];
  readonly onOpenSearchHit?: (hit: GlobalSearchHit) => void;
  readonly onSearchStateChange?: (state: SearchRouteSearchState) => void;
}

interface SearchResultRow {
  readonly hit: GlobalSearchHit;
  readonly title: string;
  readonly body: string;
  readonly typeLabel: string;
  readonly updatedAtLabel: string;
  readonly updatedAtIso?: string;
  readonly scoreLabel: string;
}

const searchDebounceMs = 300;
const searchResultEstimate = 64;
const searchResultTypes = ["mail", "chat", "docs", "drive", "calendar"] as const;
const emptySearchTypes: readonly GlobalSearchType[] = [];

export function SearchResultsShell({
  initialQuery = "",
  initialTypes = emptySearchTypes,
  onOpenSearchHit,
  onSearchStateChange,
}: SearchResultsShellProps) {
  const [draftQuery, setDraftQuery] = useState(initialQuery);
  const [selectedTypes, setSelectedTypes] = useState<readonly GlobalSearchType[]>(initialTypes);
  const [debouncedQuery] = useDebouncedValue(draftQuery.trim(), { wait: searchDebounceMs });
  const resultScrollRef = useRef<HTMLDivElement | null>(null);
  const normalizedQuery = debouncedQuery.trim();
  const queryTypes = selectedTypes.length > 0 ? selectedTypes : undefined;
  const queryClient = useQueryClient();
  const searchInput = { query: normalizedQuery, types: queryTypes, limit: 100 };
  const searchQuery = useQuery({
    ...globalSearchQueryOptions(searchInput),
    enabled: normalizedQuery.length > 0,
  });
  const hits = normalizedQuery.length > 0 ? (searchQuery.data?.hits ?? []) : [];
  const rows = useMemo(() => hits.map(searchResultRowFromHit), [hits]);
  const columns = useMemo<ColumnDef<SearchResultRow>[]>(
    () => [
      {
        accessorKey: "title",
        header: "Result",
        cell: ({ row }) => {
          const Icon = iconForSearchType(row.original.hit.type);
          return (
            <button
              aria-label={`Open ${row.original.title}`}
              className="search-result-open"
              onClick={() => onOpenSearchHit?.(row.original.hit)}
              type="button"
            >
              <Icon aria-hidden="true" size={16} />
              <span>
                <strong>{row.original.title}</strong>
                {row.original.body.length > 0 ? <small>{row.original.body}</small> : null}
              </span>
            </button>
          );
        },
      },
      {
        accessorKey: "typeLabel",
        header: "Type",
      },
      {
        accessorKey: "updatedAtLabel",
        header: "Updated",
        cell: ({ row }) =>
          row.original.updatedAtIso === undefined ? (
            row.original.updatedAtLabel
          ) : (
            <time
              dateTime={row.original.updatedAtIso}
              title={formatAbsoluteTimestamp(row.original.updatedAtIso)}
            >
              {row.original.updatedAtLabel}
            </time>
          ),
      },
      {
        accessorKey: "scoreLabel",
        header: "Score",
      },
    ],
    [onOpenSearchHit],
  );
  const table = useReactTable({
    columns,
    data: rows,
    getCoreRowModel: getCoreRowModel(),
    getRowId: (row) => row.hit.id,
  });
  const tableRows = table.getRowModel().rows;
  const virtualizer = useVirtualizer({
    count: tableRows.length,
    getScrollElement: () => resultScrollRef.current,
    estimateSize: () => searchResultEstimate,
    overscan: 8,
    initialRect: { height: 520, width: 960 },
  });
  const measuredVirtualItems = virtualizer.getVirtualItems();
  const virtualItems =
    measuredVirtualItems.length > 0
      ? measuredVirtualItems
      : fallbackVirtualItems(tableRows.length, searchResultEstimate);
  const totalSize = Math.max(virtualizer.getTotalSize(), tableRows.length * searchResultEstimate);
  const selectedTypeSet = useMemo(() => new Set(selectedTypes), [selectedTypes]);

  useEffect(() => {
    setDraftQuery(initialQuery);
  }, [initialQuery]);

  useEffect(() => {
    setSelectedTypes(initialTypes);
  }, [initialTypes]);

  useEffect(() => {
    onSearchStateChange?.(routeSearchStateFromValues(normalizedQuery, selectedTypes));
  }, [normalizedQuery, onSearchStateChange, selectedTypes]);

  return (
    <section className="search-page" aria-labelledby="search-title" role="main">
      <header className="search-page-header">
        <div>
          <h1 id="search-title">Search</h1>
          <p>Find mail, chat messages, docs, Drive files, and calendar events.</p>
        </div>
      </header>

      <div className="search-controls" aria-label="Search controls">
        <label className="search-query-field">
          <span className="sr-only">Search query</span>
          <Search aria-hidden="true" size={17} />
          <Input
            type="search"
            name="workspace-search"
            autoComplete="off"
            enterKeyHint="search"
            spellCheck={false}
            onChange={(event) => setDraftQuery(event.target.value)}
            placeholder="Search workspace content…"
            value={draftQuery}
          />
        </label>
        <div className="search-type-filters" aria-label="Result types">
          {searchResultTypes.map((type) => (
            <Button
              aria-pressed={selectedTypeSet.has(type)}
              key={type}
              onClick={() => setSelectedTypes(toggleSearchType(selectedTypes, type))}
              type="button"
              variant={selectedTypeSet.has(type) ? "default" : "outline"}
            >
              {labelForSearchType(type)}
            </Button>
          ))}
          {selectedTypes.length > 0 ? (
            <Button
              onClick={() => setSelectedTypes(emptySearchTypes)}
              type="button"
              variant="ghost"
            >
              Clear filters
            </Button>
          ) : null}
        </div>
      </div>

      <div className="search-results-meta" aria-live="polite">
        {resultStatusText({
          error: searchQuery.isError,
          estimatedTotalHits: searchQuery.data?.estimatedTotalHits,
          fetching: searchQuery.isFetching,
          hits: hits.length,
          query: normalizedQuery,
        })}
      </div>

      <div
        className="search-results-scroll"
        data-testid="search-results-virtualizer"
        ref={resultScrollRef}
      >
        <Table
          aria-label="Search results"
          aria-rowcount={rows.length + 1}
          className="search-results-table"
          style={{ minHeight: `${String(totalSize)}px` }}
        >
          <TableHeader>
            {table.getHeaderGroups().map((headerGroup) => (
              <TableRow className="search-results-table-row" key={headerGroup.id}>
                {headerGroup.headers.map((header) => (
                  <TableHead key={header.id}>
                    {header.isPlaceholder
                      ? null
                      : flexRender(header.column.columnDef.header, header.getContext())}
                  </TableHead>
                ))}
              </TableRow>
            ))}
          </TableHeader>
          <TableBody className="search-results-body" style={{ height: totalSize }}>
            {renderSearchResultsBody({
              columns,
              isError: searchQuery.isError,
              isLoading: searchQuery.isLoading || (searchQuery.isFetching && rows.length === 0),
              normalizedQuery,
              onRetry: () => {
                void invalidateGlobalSearch(queryClient, searchInput);
              },
              rows: tableRows,
              virtualItems,
            })}
          </TableBody>
        </Table>
      </div>
    </section>
  );
}

function renderSearchResultsBody({
  columns,
  isError,
  isLoading,
  normalizedQuery,
  onRetry,
  rows,
  virtualItems,
}: {
  readonly columns: readonly ColumnDef<SearchResultRow>[];
  readonly isError: boolean;
  readonly isLoading: boolean;
  readonly normalizedQuery: string;
  readonly onRetry: () => void;
  readonly rows: readonly Row<SearchResultRow>[];
  readonly virtualItems: readonly VirtualItem[];
}) {
  if (normalizedQuery.length === 0) {
    return (
      <SearchResultsStateRow colSpan={columns.length}>
        Enter a query to search.
      </SearchResultsStateRow>
    );
  }

  if (isLoading) {
    return Array.from({ length: 6 }, (_, index) => (
      <TableRow
        className="search-results-table-row search-result-skeleton-row"
        key={`loading-${String(index)}`}
        style={virtualItemStyle({
          end: (index + 1) * searchResultEstimate,
          index,
          key: index,
          lane: 0,
          size: searchResultEstimate,
          start: index * searchResultEstimate,
        })}
      >
        <TableCell colSpan={columns.length}>
          <span className="search-result-skeleton">
            <span aria-hidden="true" />
            <span aria-hidden="true" />
            <span aria-hidden="true" />
            <span className="sr-only">Searching</span>
          </span>
        </TableCell>
      </TableRow>
    ));
  }

  if (isError) {
    return (
      <SearchResultsStateRow colSpan={columns.length}>
        <SearchErrorState onRetry={onRetry} />
      </SearchResultsStateRow>
    );
  }

  if (rows.length === 0) {
    return (
      <SearchResultsStateRow colSpan={columns.length}>No matching results.</SearchResultsStateRow>
    );
  }

  return virtualItems.map((virtualItem) => {
    const row = rows[virtualItem.index];
    if (row === undefined) {
      return null;
    }
    return (
      <TableRow
        aria-rowindex={virtualItem.index + 2}
        className="search-results-table-row"
        data-index={virtualItem.index}
        key={row.id}
        style={virtualItemStyle(virtualItem)}
      >
        {row.getVisibleCells().map((cell) => (
          <TableCell key={cell.id}>
            {flexRender(cell.column.columnDef.cell, cell.getContext())}
          </TableCell>
        ))}
      </TableRow>
    );
  });
}

export function SearchErrorState({ onRetry }: { readonly onRetry: () => void }) {
  return (
    <div className="search-results-error" role="alert">
      <span>Search is unavailable. Check your connection, then try again.</span>
      <Button onClick={onRetry} size="sm" type="button" variant="outline">
        Retry search
      </Button>
    </div>
  );
}

function SearchResultsStateRow({
  children,
  colSpan,
}: {
  readonly children: ReactNode;
  readonly colSpan: number;
}) {
  return (
    <TableRow className="search-results-table-row search-results-state-row">
      <TableCell colSpan={colSpan}>{children}</TableCell>
    </TableRow>
  );
}

function fallbackVirtualItems(count: number, itemEstimate: number): readonly VirtualItem[] {
  return Array.from({ length: Math.min(count, 20) }, (_, index) => ({
    end: (index + 1) * itemEstimate,
    index,
    key: index,
    lane: 0,
    size: itemEstimate,
    start: index * itemEstimate,
  }));
}

function virtualItemStyle(virtualItem: VirtualItem): CSSProperties {
  return {
    left: 0,
    position: "absolute",
    top: 0,
    transform: `translateY(${String(virtualItem.start)}px)`,
    width: "100%",
  };
}

function routeSearchStateFromValues(
  query: string,
  types: readonly GlobalSearchType[],
): SearchRouteSearchState {
  return {
    ...(query.length > 0 ? { q: query } : {}),
    ...(types.length > 0 ? { types } : {}),
  };
}

function toggleSearchType(
  selectedTypes: readonly GlobalSearchType[],
  type: GlobalSearchType,
): readonly GlobalSearchType[] {
  return selectedTypes.includes(type)
    ? selectedTypes.filter((selectedType) => selectedType !== type)
    : [...selectedTypes, type];
}

function searchResultRowFromHit(hit: GlobalSearchHit): SearchResultRow {
  return {
    hit,
    title: hit.title ?? labelForSearchType(hit.type),
    body: hit.body ?? "",
    typeLabel: labelForSearchType(hit.type),
    updatedAtLabel: formatUpdatedAt(hit.updatedAt),
    ...(hit.updatedAt === undefined ? {} : { updatedAtIso: hit.updatedAt }),
    scoreLabel: formatScore(hit.score),
  };
}

function resultStatusText({
  error,
  estimatedTotalHits,
  fetching,
  hits,
  query,
}: {
  readonly error: boolean;
  readonly estimatedTotalHits?: number;
  readonly fetching: boolean;
  readonly hits: number;
  readonly query: string;
}): string {
  if (query.length === 0) {
    return "Search across your workspace.";
  }
  if (error) {
    return "Search could not load.";
  }
  if (fetching && hits === 0) {
    return "Searching…";
  }
  const total = estimatedTotalHits ?? hits;
  return `${new Intl.NumberFormat().format(total)} ${total === 1 ? "result" : "results"}`;
}

function formatUpdatedAt(updatedAt: string | undefined): string {
  if (updatedAt === undefined) {
    return "Unknown";
  }
  const parsed = new Date(updatedAt);
  if (Number.isNaN(parsed.getTime())) {
    return "Unknown";
  }
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(parsed);
}

function formatScore(score: number | undefined): string {
  if (score === undefined) {
    return "Relevant";
  }
  if (score >= 0 && score <= 1) {
    return new Intl.NumberFormat(undefined, {
      style: "percent",
      maximumFractionDigits: 0,
    }).format(score);
  }
  return new Intl.NumberFormat(undefined, {
    maximumFractionDigits: 2,
    minimumFractionDigits: 2,
  }).format(score);
}

function formatAbsoluteTimestamp(iso: string): string {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return "Unknown";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "full",
    timeStyle: "long",
  }).format(parsed);
}

function iconForSearchType(type: GlobalSearchType): LucideIcon {
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
