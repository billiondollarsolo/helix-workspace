import { authenticatedFetch } from "@/lib/auth";
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
import {
  EmptyRow,
  ADMIN_PAGE_TITLE_ID,
  PageHeading,
  QueryFailureBanner,
  StateBanner,
  useQueryFailure,
} from "@/features/admin/console/primitives";
import {
  adminUsersQueryKeys,
  adminUsersQueryOptions,
  type AdminUser,
  type AdminUsersQueryInput,
} from "@/features/admin/admin-users";
import { queryOptions, useQuery, useQueryClient } from "@tanstack/react-query";
import { flexRender, getCoreRowModel, useReactTable, type ColumnDef } from "@tanstack/react-table";
import { Filter, RotateCcw } from "lucide-react";
import { useMemo, useState } from "react";
import { ADMIN_QUERY_DEFAULTS } from "@/features/admin/console/request-budget";

export interface AuditLogRecord {
  readonly id: string;
  readonly orgId: string;
  readonly actorId: string | null;
  readonly verb: string;
  readonly objectType: string;
  readonly objectId: string | null;
  readonly traceId: string | null;
  readonly payload: Record<string, unknown>;
  readonly prevHash: string | null;
  readonly thisHash: string;
  readonly createdAt: string;
}

export interface AuditLogListResponse {
  readonly records: readonly AuditLogRecord[];
  readonly nextCursor: string | null;
}

export interface AuditLogQueryInput {
  readonly actorId?: string;
  readonly cursor?: string;
  readonly limit?: number;
  readonly objectId?: string;
  readonly objectType?: string;
  readonly verb?: string;
}

export const defaultAuditLogInput = {
  limit: 50,
} as const satisfies AuditLogQueryInput;

export const adminAuditLogQueryKeys = {
  list: (input: AuditLogQueryInput = defaultAuditLogInput) =>
    [
      "admin",
      "audit-log",
      input.limit ?? defaultAuditLogInput.limit,
      input.cursor ?? "",
      input.actorId?.trim() ?? "",
      input.objectId?.trim() ?? "",
      input.objectType?.trim() ?? "",
      input.verb?.trim() ?? "",
    ] as const,
};

export function adminAuditLogQueryOptions(input: AuditLogQueryInput = defaultAuditLogInput) {
  return queryOptions({
    ...ADMIN_QUERY_DEFAULTS,
    queryKey: adminAuditLogQueryKeys.list(input),
    queryFn: () => listAuditLog(input),
    /* The one surface where serving a cached page is a correctness problem
       rather than a freshness trade-off: this is the record of what happened,
       an operator opens it precisely to check whether something just did, and
       no admin mutation anywhere in the console invalidates it. `0` means
       returning to a filter you looked at a minute ago re-reads the log instead
       of replaying the answer from before the thing you are investigating. */
    staleTime: 0,
  });
}

interface AuditLogRouteQueryClient {
  ensureQueryData(options: ReturnType<typeof adminAuditLogQueryOptions>): Promise<unknown>;
}

export async function prefetchAdminAuditLogQuery(queryClient: AuditLogRouteQueryClient) {
  await queryClient.ensureQueryData(adminAuditLogQueryOptions()).catch(() => undefined);
}

/* The audit endpoint validates `actorId` as a UUID (platform/audit/routes.ts),
   so the actor filter has to emit directory ids rather than typed text — hence a
   select rather than the free-text inputs the other two filters use. The upside
   is that all three filters run server-side over the whole log, not over the
   loaded page. */
const EMPTY_FILTERS = { actorId: "", objectType: "", verb: "" } as const;

/* Disabled actors are exactly who an audit search is usually about, so the
   directory lookup must include them; the default directory input hides them.
   250 is the endpoint's ceiling — past that some actors resolve to their id, and
   `directoryTruncated` says so rather than letting the gap look like deletion. */
const DIRECTORY_LOOKUP_INPUT = {
  includeDisabled: true,
  limit: 250,
} as const satisfies AdminUsersQueryInput;

/* The Actor cell holds an expandable id, so it cannot inherit the single-line
   truncation the other cells use — an open disclosure would be clipped. */
const ACTOR_CELL_CLASS = "max-w-[280px] align-top";
const DEFAULT_CELL_CLASS = "max-w-[260px] truncate";

const FILTER_SELECT_CLASS =
  "h-9 w-64 rounded-md border border-outline bg-surface-container px-2 text-xs transition-colors outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/30 disabled:cursor-not-allowed disabled:opacity-50";

export function AuditLogList() {
  const queryClient = useQueryClient();
  const [draftFilters, setDraftFilters] = useState<AuditFilters>(EMPTY_FILTERS);
  const [appliedFilters, setAppliedFilters] = useState<AuditFilters>(EMPTY_FILTERS);
  const [cursor, setCursor] = useState<string | undefined>();
  const queryInput = useMemo<AuditLogQueryInput>(
    () => ({
      limit: defaultAuditLogInput.limit,
      ...(cursor === undefined ? {} : { cursor }),
      ...(appliedFilters.actorId.trim().length === 0
        ? {}
        : { actorId: appliedFilters.actorId.trim() }),
      ...(appliedFilters.objectType.trim().length === 0
        ? {}
        : { objectType: appliedFilters.objectType.trim() }),
      ...(appliedFilters.verb.trim().length === 0 ? {} : { verb: appliedFilters.verb.trim() }),
    }),
    [appliedFilters.actorId, appliedFilters.objectType, appliedFilters.verb, cursor],
  );
  const auditLogQuery = useQuery(adminAuditLogQueryOptions(queryInput));
  const records = useMemo(() => [...(auditLogQuery.data?.records ?? [])], [auditLogQuery.data]);

  /* The directory is a second, independent request. It resolves ids to names and
     it can fail on its own — when it does the log still has to render, because a
     log that hides itself over a cosmetic lookup is worse than one showing ids. */
  const directoryQuery = useQuery(adminUsersQueryOptions(DIRECTORY_LOOKUP_INPUT));
  const directoryFailure = useQueryFailure(directoryQuery, () => {
    void queryClient.invalidateQueries({
      queryKey: adminUsersQueryKeys.list(DIRECTORY_LOOKUP_INPUT),
    });
  });
  const directory = useMemo(() => {
    const byId = new Map<string, AdminUser>();
    for (const user of directoryQuery.data?.users ?? []) {
      byId.set(user.id, user);
    }
    return byId;
  }, [directoryQuery.data]);
  const directoryLoaded = directoryQuery.isSuccess;
  const directoryTruncated =
    directoryQuery.data !== undefined && directoryQuery.data.nextCursor !== null;

  const actorOptions = useMemo(
    () => buildActorOptions(directoryQuery.data?.users, records, draftFilters.actorId),
    [directoryQuery.data, records, draftFilters.actorId],
  );

  const hasAppliedFilters =
    appliedFilters.verb.trim().length > 0 ||
    appliedFilters.objectType.trim().length > 0 ||
    appliedFilters.actorId.trim().length > 0;
  const columns = useMemo<ColumnDef<AuditLogRecord>[]>(
    () => [
      {
        header: "Time",
        accessorKey: "createdAt",
        cell: ({ row }) => formatAuditTimestamp(row.original.createdAt),
      },
      {
        header: "Actor",
        accessorKey: "actorId",
        cell: ({ row }) => (
          <ActorCell
            actorId={row.original.actorId}
            directory={directory}
            directoryLoaded={directoryLoaded}
          />
        ),
      },
      {
        header: "Event",
        accessorKey: "verb",
        cell: ({ row }) => <span className="font-medium">{row.original.verb}</span>,
      },
      {
        header: "Object",
        accessorKey: "objectType",
        cell: ({ row }) => objectLabel(row.original),
      },
      {
        header: "Trace",
        accessorKey: "traceId",
        cell: ({ row }) => shortId(row.original.traceId),
      },
      {
        header: "Hash",
        accessorKey: "thisHash",
        cell: ({ row }) => shortHash(row.original.thisHash),
      },
      {
        header: "Payload",
        accessorKey: "payload",
        cell: ({ row }) => formatPayloadSummary(row.original.payload),
      },
    ],
    [directory, directoryLoaded],
  );
  const table = useReactTable({
    data: records,
    columns,
    getCoreRowModel: getCoreRowModel(),
  });

  const applyFilters = () => {
    setCursor(undefined);
    setAppliedFilters(draftFilters);
  };

  const resetFilters = () => {
    setCursor(undefined);
    setDraftFilters(EMPTY_FILTERS);
    setAppliedFilters(EMPTY_FILTERS);
  };

  return (
    // No PageScroll: `audit` is registered through `withPageScroll` in
    // admin-console.tsx, so the scroll container and 24px page padding are
    // already applied one level up.
    //
    // `min-w-0` down the whole chain to the table, and it is load-bearing:
    // a grid item's automatic minimum size is its *min-content* width, so the
    // seven-column table sized the track, the track outgrew `.admin-page`, and
    // the page — h1, subtitle and filters included — scrolled sideways with it
    // (333px of overflow at 1280×800). With the minimum pinned to 0 the track
    // is the container's width and the overflow lands where `<Table>`'s own
    // `overflow-x-auto` wrapper can take it.
    /* A named landmark, so assistive tech and the e2e suite can both address
       "the Audit log region" rather than an anonymous <section>. Named from the
       page heading itself so the two cannot drift apart. */
    <section className="grid min-w-0 gap-4" aria-labelledby={ADMIN_PAGE_TITLE_ID}>
      <PageHeading
        title="Audit log"
        subtitle="Immutable, hash-chained record of privileged activity in this organization, newest first. Filter by actor, event verb, or object type to trace a single action. All three filters run on the server across the whole log, not just the page loaded below."
      />

      <div aria-label="Audit log filters" className="flex flex-wrap items-end gap-2" role="group">
        <label className="grid gap-1 text-xs font-medium text-muted-foreground">
          Actor
          <select
            aria-label="Audit actor filter"
            className={FILTER_SELECT_CLASS}
            disabled={actorOptions.length === 0}
            onChange={(event) => {
              const { value } = event.target;
              setDraftFilters((filters) => ({ ...filters, actorId: value }));
            }}
            value={draftFilters.actorId}
          >
            <option value="">All actors</option>
            {actorOptions.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </select>
          {/* Never a dead control: with nothing to choose from, the select is
              disabled next to the reason it is. */}
          {actorOptions.length === 0 ? (
            <span className="admin-unavailable-reason">
              {directoryFailure === null
                ? "No actors available to filter by yet."
                : "The user directory could not be loaded."}
            </span>
          ) : null}
        </label>
        <label className="grid gap-1 text-xs font-medium text-muted-foreground">
          Verb
          <Input
            aria-label="Audit verb filter"
            className="h-9 w-56 text-xs"
            onChange={(event) =>
              setDraftFilters((filters) => ({ ...filters, verb: event.target.value }))
            }
            placeholder="tool.invoked"
            value={draftFilters.verb}
          />
        </label>
        <label className="grid gap-1 text-xs font-medium text-muted-foreground">
          Object type
          <Input
            aria-label="Audit object type filter"
            className="h-9 w-44 text-xs"
            onChange={(event) =>
              setDraftFilters((filters) => ({ ...filters, objectType: event.target.value }))
            }
            placeholder="tool"
            value={draftFilters.objectType}
          />
        </label>
        <Button onClick={applyFilters} size="sm" type="button">
          <Filter aria-hidden="true" size={15} />
          Apply
        </Button>
        <Button onClick={resetFilters} size="icon-sm" type="button" variant="ghost">
          <RotateCcw aria-hidden="true" size={15} />
          <span className="sr-only">Reset audit log filters</span>
        </Button>
      </div>

      {directoryTruncated ? (
        <StateBanner kind="info">
          The directory returned its first {DIRECTORY_LOOKUP_INPUT.limit} actors. Actors beyond that
          show as their id and are not listed in the actor filter.
        </StateBanner>
      ) : null}

      {auditLogQuery.isLoading ? (
        <StateBanner kind="loading">Loading audit records…</StateBanner>
      ) : null}
      {auditLogQuery.isError ? (
        <StateBanner kind="error">
          Audit log is unavailable or missing admin audit scope.
        </StateBanner>
      ) : null}

      {/* Rendered after the audit banners: the directory is the secondary
          lookup, and its failure must never outrank the log's own state. */}
      {directoryFailure === null ? null : (
        <QueryFailureBanner
          error={directoryFailure.error}
          isRetrying={directoryFailure.isRetrying}
          onRetry={directoryFailure.retry}
          retryVariant="outline"
          subject="the user directory"
          summary="Actor names are unavailable, so the log shows raw actor ids."
        >
          The audit records below are complete and unaffected — only the name lookup failed. The
          actor filter is limited to actors appearing in the loaded rows until it recovers.
        </QueryFailureBanner>
      )}

      <section className="grid min-w-0 gap-2" aria-labelledby="audit-records-heading">
        <div className="flex items-baseline justify-between gap-3">
          <h2 className="text-sm font-semibold" id="audit-records-heading">
            Recent activity
          </h2>
          <span className="text-xs text-muted-foreground">
            {records.length} record{records.length === 1 ? "" : "s"} loaded
          </span>
        </div>

        {/* `overflow-hidden` keeps the scrolled table inside the rounded frame;
            without it the first and last columns paint over the corners. */}
        <div className="min-w-0 overflow-hidden rounded-lg border bg-card">
          <Table aria-label="Audit log" role="table">
            <TableHeader>
              {table.getHeaderGroups().map((headerGroup) => (
                <TableRow key={headerGroup.id}>
                  {headerGroup.headers.map((header) => (
                    <TableHead key={header.id} role="columnheader">
                      {header.isPlaceholder
                        ? null
                        : flexRender(header.column.columnDef.header, header.getContext())}
                    </TableHead>
                  ))}
                </TableRow>
              ))}
            </TableHeader>
            <TableBody>
              {table.getRowModel().rows.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={columns.length}>
                    <EmptyRow>{emptyRecordsMessage(auditLogQuery, hasAppliedFilters)}</EmptyRow>
                  </TableCell>
                </TableRow>
              ) : (
                table.getRowModel().rows.map((row) => (
                  <TableRow key={row.id}>
                    {row.getVisibleCells().map((cell) => (
                      <TableCell
                        className={
                          cell.column.id === "actorId" ? ACTOR_CELL_CLASS : DEFAULT_CELL_CLASS
                        }
                        key={cell.id}
                      >
                        {flexRender(cell.column.columnDef.cell, cell.getContext())}
                      </TableCell>
                    ))}
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>

        {/* Cursor paging, not a primary action: the filter Apply button owns the
            page's single filled button. */}
        <div className="flex justify-end gap-2">
          <Button
            disabled={cursor === undefined}
            onClick={() => setCursor(undefined)}
            size="sm"
            type="button"
            variant="outline"
          >
            Newest
          </Button>
          <Button
            disabled={auditLogQuery.data?.nextCursor === null || auditLogQuery.data === undefined}
            onClick={() => setCursor(auditLogQuery.data?.nextCursor ?? undefined)}
            size="sm"
            type="button"
            variant="outline"
          >
            Next page
          </Button>
        </div>
      </section>
    </section>
  );
}

interface AuditFilters {
  readonly actorId: string;
  readonly objectType: string;
  readonly verb: string;
}

interface ActorOption {
  readonly id: string;
  readonly label: string;
}

/** Who the row is about, with the id kept one level in.
 *
 *  The name answers "what did this person do?"; the raw uuid is what an auditor
 *  correlates against traces and exports, so it is disclosed rather than
 *  dropped. An id the directory does not hold renders as the id — deleted
 *  actors keep their rows in an audit log, and naming one we cannot look up
 *  would falsify the record. */
function ActorCell({
  actorId,
  directory,
  directoryLoaded,
}: {
  readonly actorId: string | null;
  readonly directory: ReadonlyMap<string, AdminUser>;
  readonly directoryLoaded: boolean;
}) {
  if (actorId === null || actorId.length === 0) {
    /* The API reported no actor. Calling it "System" would name one it never
       sent — the honest reading is that the field is absent. */
    return <span className="text-muted-foreground">No actor recorded</span>;
  }

  const user = directory.get(actorId);
  return (
    <details className="admin-disclosure">
      <summary title={`Actor id ${actorId}`}>
        {user === undefined ? (
          <span className="mono text-foreground">{shortId(actorId)}</span>
        ) : (
          <span className="font-medium text-foreground">{actorLabel(user)}</span>
        )}
      </summary>
      <div className="grid gap-1 pt-1">
        <span className="mono text-xs break-all text-muted-foreground">{actorId}</span>
        {/* Only claim absence when the directory actually answered. After a
            failed lookup every row would otherwise accuse a live user of not
            existing; the page banner explains that case instead. */}
        {user === undefined && directoryLoaded ? (
          <span className="text-xs text-muted-foreground">Not in the current user directory.</span>
        ) : null}
      </div>
    </details>
  );
}

/** "Display Name (email)", or just the name when the directory holds no address
 *  — an empty "()" reads as a missing value rather than an absent one. */
export function actorLabel(user: AdminUser): string {
  return user.email === null || user.email.length === 0
    ? user.displayName
    : `${user.displayName} (${user.email})`;
}

/** Choices for the actor filter, all of them real ids the API will accept.
 *
 *  Directory entries come first, then any actor id present in the loaded rows
 *  that the directory does not hold — without those, a deleted actor could be
 *  seen in the table but never filtered to, which is the one search an audit
 *  log exists for. The current draft selection is always retained so a filter
 *  that returns nothing does not erase its own control. */
export function buildActorOptions(
  users: readonly AdminUser[] | undefined,
  records: readonly AuditLogRecord[],
  draftActorId: string,
): readonly ActorOption[] {
  const named = new Map<string, string>();
  for (const user of users ?? []) {
    named.set(user.id, actorLabel(user));
  }
  const unnamed = new Set<string>();
  for (const record of records) {
    if (record.actorId !== null && record.actorId.length > 0 && !named.has(record.actorId)) {
      unnamed.add(record.actorId);
    }
  }
  if (draftActorId.length > 0 && !named.has(draftActorId)) {
    unnamed.add(draftActorId);
  }

  /* Named actors lead. Sorting the combined list by label would float every raw
     uuid above the people — digits sort before letters — so the control would
     open on a wall of ids, which is the exception, not the answer. */
  const namedOptions = [...named]
    .map(([id, label]) => ({ id, label }))
    .sort((left, right) => left.label.localeCompare(right.label));
  const unnamedOptions = [...unnamed].sort().map((id) => ({ id, label: id }));
  return [...namedOptions, ...unnamedOptions];
}

function emptyRecordsMessage(
  query: { readonly isError: boolean; readonly isLoading: boolean },
  filtered: boolean,
): string {
  if (query.isLoading) {
    return "Loading audit records…";
  }
  if (query.isError) {
    return "Audit records could not be loaded.";
  }
  if (filtered) {
    return "No audit records match these filters.";
  }
  return "No audit records have been written for this organization yet.";
}

export async function listAuditLog(
  input: AuditLogQueryInput = defaultAuditLogInput,
): Promise<AuditLogListResponse> {
  const params = new URLSearchParams();
  params.set("limit", String(input.limit ?? defaultAuditLogInput.limit));
  appendParam(params, "actorId", input.actorId);
  appendParam(params, "cursor", input.cursor);
  appendParam(params, "objectId", input.objectId);
  appendParam(params, "objectType", input.objectType);
  appendParam(params, "verb", input.verb);

  const response = await authenticatedFetch(`/api/admin/audit-log?${params.toString()}`);
  const output: unknown = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(errorMessageFromOutput(output) ?? `Audit log failed with ${response.status}`);
  }
  if (!isAuditLogListResponse(output)) {
    throw new Error("Audit log response was missing required fields.");
  }
  return output;
}

export function formatPayloadSummary(payload: Record<string, unknown>): string {
  const entries = Object.entries(payload).filter(([, value]) => value !== undefined);
  if (entries.length === 0) {
    return "{}";
  }
  return entries
    .slice(0, 3)
    .map(([key, value]) => `${key}: ${formatPayloadValue(value)}`)
    .join(", ");
}

function formatPayloadValue(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (value === null) {
    return "null";
  }
  if (Array.isArray(value)) {
    return `[${value.length} items]`;
  }
  if (typeof value === "object") {
    return "{...}";
  }
  if (typeof value === "undefined") {
    return "undefined";
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  return typeof value === "symbol" ? "symbol" : "function";
}

function formatAuditTimestamp(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "medium",
  }).format(date);
}

function objectLabel(record: AuditLogRecord): string {
  return record.objectId === null
    ? record.objectType
    : `${record.objectType}:${shortId(record.objectId)}`;
}

function shortId(value: string | null): string {
  if (value === null || value.length === 0) {
    return "-";
  }
  return value.length <= 12 ? value : `${value.slice(0, 8)}...${value.slice(-4)}`;
}

function shortHash(value: string): string {
  return value.length <= 16 ? value : `${value.slice(0, 10)}...`;
}

function appendParam(params: URLSearchParams, key: string, value: string | undefined): void {
  const trimmed = value?.trim();
  if (trimmed !== undefined && trimmed.length > 0) {
    params.set(key, trimmed);
  }
}

function isAuditLogListResponse(value: unknown): value is AuditLogListResponse {
  if (!isRecord(value) || !Array.isArray(value.records)) {
    return false;
  }
  return (
    value.records.every(isAuditLogRecord) &&
    (typeof value.nextCursor === "string" || value.nextCursor === null)
  );
}

function isAuditLogRecord(value: unknown): value is AuditLogRecord {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.orgId === "string" &&
    (typeof value.actorId === "string" || value.actorId === null) &&
    typeof value.verb === "string" &&
    typeof value.objectType === "string" &&
    (typeof value.objectId === "string" || value.objectId === null) &&
    (typeof value.traceId === "string" || value.traceId === null) &&
    isRecord(value.payload) &&
    (typeof value.prevHash === "string" || value.prevHash === null) &&
    typeof value.thisHash === "string" &&
    typeof value.createdAt === "string"
  );
}

function errorMessageFromOutput(output: unknown): string | undefined {
  return isRecord(output) && typeof output.error === "string" ? output.error : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
