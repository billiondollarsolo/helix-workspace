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
import { queryOptions, useQuery } from "@tanstack/react-query";
import { flexRender, getCoreRowModel, useReactTable, type ColumnDef } from "@tanstack/react-table";
import { RotateCcw, ShieldCheck } from "lucide-react";
import { useMemo, useState } from "react";

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
    queryKey: adminAuditLogQueryKeys.list(input),
    queryFn: () => listAuditLog(input),
    throwOnError: false,
  });
}

interface AuditLogRouteQueryClient {
  ensureQueryData(options: ReturnType<typeof adminAuditLogQueryOptions>): Promise<unknown>;
}

export async function prefetchAdminAuditLogQuery(queryClient: AuditLogRouteQueryClient) {
  await queryClient.ensureQueryData(adminAuditLogQueryOptions()).catch(() => undefined);
}

export function AuditLogList() {
  const [draftFilters, setDraftFilters] = useState({ verb: "", objectType: "" });
  const [appliedFilters, setAppliedFilters] = useState({ verb: "", objectType: "" });
  const [cursor, setCursor] = useState<string | undefined>();
  const queryInput = useMemo<AuditLogQueryInput>(
    () => ({
      limit: defaultAuditLogInput.limit,
      ...(cursor === undefined ? {} : { cursor }),
      ...(appliedFilters.objectType.trim().length === 0
        ? {}
        : { objectType: appliedFilters.objectType.trim() }),
      ...(appliedFilters.verb.trim().length === 0 ? {} : { verb: appliedFilters.verb.trim() }),
    }),
    [appliedFilters.objectType, appliedFilters.verb, cursor],
  );
  const auditLogQuery = useQuery(adminAuditLogQueryOptions(queryInput));
  const records = useMemo(() => [...(auditLogQuery.data?.records ?? [])], [auditLogQuery.data]);
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
        cell: ({ row }) => shortId(row.original.actorId),
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
    [],
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
    const emptyFilters = { verb: "", objectType: "" };
    setCursor(undefined);
    setDraftFilters(emptyFilters);
    setAppliedFilters(emptyFilters);
  };

  return (
    <section className="px-5 py-5" aria-label="Audit log">
      <div className="mb-4 flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
        <p className="max-w-3xl text-sm text-muted-foreground">
          Recent immutable activity records for this organization, ordered newest first.
        </p>
        <div className="flex flex-wrap items-end gap-2" aria-label="Audit log filters">
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
            <ShieldCheck aria-hidden="true" size={15} />
            Apply
          </Button>
          <Button onClick={resetFilters} size="icon-sm" type="button" variant="ghost">
            <RotateCcw aria-hidden="true" size={15} />
            <span className="sr-only">Reset audit log filters</span>
          </Button>
        </div>
      </div>

      <div className="rounded-lg border bg-card">
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
            {auditLogQuery.isError ? (
              <TableRow>
                <TableCell colSpan={columns.length} role="alert">
                  Audit log is unavailable or missing admin audit scope.
                </TableCell>
              </TableRow>
            ) : table.getRowModel().rows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={columns.length}>
                  {auditLogQuery.isLoading ? "Loading audit records..." : "No audit records found."}
                </TableCell>
              </TableRow>
            ) : (
              table.getRowModel().rows.map((row) => (
                <TableRow key={row.id}>
                  {row.getVisibleCells().map((cell) => (
                    <TableCell className="max-w-[260px] truncate" key={cell.id}>
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </TableCell>
                  ))}
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      <div className="mt-3 flex items-center justify-between gap-3 text-xs text-muted-foreground">
        <span>
          {records.length} record{records.length === 1 ? "" : "s"} loaded
        </span>
        <div className="flex gap-2">
          <Button
            disabled={cursor === undefined}
            onClick={() => setCursor(undefined)}
            size="sm"
            type="button"
            variant="ghost"
          >
            Newest
          </Button>
          <Button
            disabled={auditLogQuery.data?.nextCursor === null || auditLogQuery.data === undefined}
            onClick={() => setCursor(auditLogQuery.data?.nextCursor ?? undefined)}
            size="sm"
            type="button"
            variant="secondary"
          >
            Next page
          </Button>
        </div>
      </div>
    </section>
  );
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
  return record.objectId === null ? record.objectType : `${record.objectType}:${shortId(record.objectId)}`;
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
