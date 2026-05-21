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
import { RotateCcw, Search, Users } from "lucide-react";
import { useMemo, useState } from "react";

export interface AdminUser {
  readonly id: string;
  readonly orgId: string;
  readonly type: string;
  readonly email: string | null;
  readonly displayName: string;
  readonly scopes: readonly string[];
  readonly disabledAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface AdminUsersListResponse {
  readonly users: readonly AdminUser[];
  readonly nextCursor: string | null;
}

export interface AdminUsersQueryInput {
  readonly cursor?: string;
  readonly includeDisabled?: boolean;
  readonly limit?: number;
  readonly query?: string;
  readonly type?: string;
}

interface AdminUserFilters {
  readonly includeDisabled: boolean;
  readonly query: string;
  readonly type: string;
}

export const defaultAdminUsersInput = {
  includeDisabled: false,
  limit: 50,
  query: "",
  type: "",
} as const satisfies AdminUsersQueryInput;

export const adminUsersQueryKeys = {
  list: (input: AdminUsersQueryInput = defaultAdminUsersInput) =>
    [
      "admin",
      "users",
      input.limit ?? defaultAdminUsersInput.limit,
      input.cursor ?? "",
      input.query?.trim() ?? "",
      input.type?.trim() ?? "",
      input.includeDisabled ?? defaultAdminUsersInput.includeDisabled,
    ] as const,
};

export function adminUsersQueryOptions(input: AdminUsersQueryInput = defaultAdminUsersInput) {
  return queryOptions({
    queryKey: adminUsersQueryKeys.list(input),
    queryFn: () => listAdminUsers(input),
    retry: false,
    staleTime: 30_000,
    throwOnError: false,
  });
}

interface AdminUsersRouteQueryClient {
  ensureQueryData(options: ReturnType<typeof adminUsersQueryOptions>): Promise<unknown>;
}

export async function prefetchAdminUsersQuery(queryClient: AdminUsersRouteQueryClient) {
  await queryClient.ensureQueryData(adminUsersQueryOptions()).catch(() => undefined);
}

export function AdminUsersList() {
  const [draftFilters, setDraftFilters] = useState<AdminUserFilters>({
    query: defaultAdminUsersInput.query,
    type: defaultAdminUsersInput.type,
    includeDisabled: defaultAdminUsersInput.includeDisabled,
  });
  const [appliedFilters, setAppliedFilters] = useState(draftFilters);
  const [cursor, setCursor] = useState<string | undefined>();
  const [limit, setLimit] = useState<number>(defaultAdminUsersInput.limit);

  const queryInput = useMemo<AdminUsersQueryInput>(
    () => ({
      limit,
      includeDisabled: appliedFilters.includeDisabled,
      ...(cursor === undefined ? {} : { cursor }),
      ...(appliedFilters.query.trim().length === 0 ? {} : { query: appliedFilters.query.trim() }),
      ...(appliedFilters.type.trim().length === 0 ? {} : { type: appliedFilters.type.trim() }),
    }),
    [appliedFilters.includeDisabled, appliedFilters.query, appliedFilters.type, cursor, limit],
  );
  const usersQuery = useQuery(adminUsersQueryOptions(queryInput));
  const users = useMemo(() => [...(usersQuery.data?.users ?? [])], [usersQuery.data]);
  const columns = useMemo<ColumnDef<AdminUser>[]>(
    () => [
      {
        header: "User",
        accessorKey: "email",
        cell: ({ row }) => (
          <div className="grid min-w-48 gap-0.5">
            <span className="font-medium">{displayNameForUser(row.original)}</span>
            <span className="text-muted-foreground">{row.original.email ?? "No email"}</span>
          </div>
        ),
      },
      {
        header: "Type",
        accessorKey: "type",
        cell: ({ row }) => (
          <span className="rounded border border-border bg-background px-1.5 py-0.5 text-[0.6875rem]">
            {row.original.type}
          </span>
        ),
      },
      {
        header: "Scopes",
        accessorKey: "scopes",
        cell: ({ row }) => (
          <div className="flex max-w-md flex-wrap gap-1">
            {row.original.scopes.length === 0 ? (
              <span className="text-muted-foreground">None</span>
            ) : (
              row.original.scopes.map((scope) => (
                <span
                  className="rounded border border-border bg-background px-1.5 py-0.5 text-[0.6875rem]"
                  key={scope}
                >
                  {scope}
                </span>
              ))
            )}
          </div>
        ),
      },
      {
        header: "Status",
        accessorKey: "disabledAt",
        cell: ({ row }) =>
          row.original.disabledAt === null ? (
            <span className="text-emerald-700">Active</span>
          ) : (
            <span className="text-muted-foreground">
              Disabled {formatDateTime(row.original.disabledAt)}
            </span>
          ),
      },
      {
        header: "Created",
        accessorKey: "createdAt",
        cell: ({ row }) => formatDateTime(row.original.createdAt),
      },
      {
        header: "Updated",
        accessorKey: "updatedAt",
        cell: ({ row }) => formatDateTime(row.original.updatedAt),
      },
      {
        header: "ID",
        accessorKey: "id",
        cell: ({ row }) => <code className="text-[0.6875rem]">{shortId(row.original.id)}</code>,
      },
    ],
    [],
  );
  const table = useReactTable({
    data: users,
    columns,
    getCoreRowModel: getCoreRowModel(),
  });

  const applyFilters = () => {
    setCursor(undefined);
    setAppliedFilters(draftFilters);
  };

  const resetFilters = () => {
    const emptyFilters = {
      query: defaultAdminUsersInput.query,
      type: defaultAdminUsersInput.type,
      includeDisabled: defaultAdminUsersInput.includeDisabled,
    };
    setCursor(undefined);
    setDraftFilters(emptyFilters);
    setAppliedFilters(emptyFilters);
    setLimit(defaultAdminUsersInput.limit);
  };

  return (
    <section
      aria-labelledby="admin-users-title"
      className="mx-auto grid w-full max-w-7xl gap-4 px-4 py-4 sm:px-6 lg:px-8"
    >
      <header className="flex flex-col gap-3 rounded-lg border border-border bg-card p-4 text-card-foreground lg:flex-row lg:items-end lg:justify-between">
        <div className="space-y-1">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Admin users
          </p>
          <h2 className="text-xl font-semibold tracking-normal" id="admin-users-title">
            User directory
          </h2>
          <p className="max-w-3xl text-sm text-muted-foreground">
            Review user identities, account state, assigned scopes, and recent lifecycle timestamps.
          </p>
        </div>
        <div
          aria-label="Admin user filters"
          className="grid gap-2 sm:grid-cols-[minmax(12rem,1fr)_minmax(9rem,0.6fr)_auto_auto_auto] sm:items-end"
        >
          <label className="grid gap-1 text-xs font-medium text-muted-foreground">
            Search
            <Input
              aria-label="User search query"
              className="h-9 text-xs"
              onChange={(event) =>
                setDraftFilters((filters) => ({ ...filters, query: event.target.value }))
              }
              placeholder="name or email"
              value={draftFilters.query}
            />
          </label>
          <label className="grid gap-1 text-xs font-medium text-muted-foreground">
            Type
            <select
              aria-label="User type filter"
              className="h-9 rounded-md border border-input bg-background px-2 text-xs"
              onChange={(event) =>
                setDraftFilters((filters) => ({ ...filters, type: event.target.value }))
              }
              value={draftFilters.type}
            >
              <option value="">All types</option>
              <option value="user">User</option>
              <option value="agent">Agent</option>
              <option value="service_account">Service account</option>
              <option value="system">System</option>
            </select>
          </label>
          <label className="inline-flex h-9 items-center gap-2 text-xs text-muted-foreground">
            <input
              aria-label="Include disabled users"
              checked={draftFilters.includeDisabled}
              className="size-3.5"
              onChange={(event) =>
                setDraftFilters((filters) => ({
                  ...filters,
                  includeDisabled: event.target.checked,
                }))
              }
              type="checkbox"
            />
            Include disabled
          </label>
          <Button onClick={applyFilters} size="sm" type="button">
            <Search aria-hidden="true" size={15} />
            Apply
          </Button>
          <Button onClick={resetFilters} size="icon-sm" type="button" variant="ghost">
            <RotateCcw aria-hidden="true" size={15} />
            <span className="sr-only">Reset admin user filters</span>
          </Button>
        </div>
      </header>

      <div className="rounded-lg border border-border bg-card">
        <Table aria-label="Admin users" role="table">
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
            {usersQuery.isError ? (
              <TableRow>
                <TableCell colSpan={columns.length} role="alert">
                  {errorMessage(usersQuery.error, "Admin users are unavailable.")}
                </TableCell>
              </TableRow>
            ) : table.getRowModel().rows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={columns.length}>
                  {usersQuery.isLoading ? "Loading admin users..." : "No admin users found."}
                </TableCell>
              </TableRow>
            ) : (
              table.getRowModel().rows.map((row) => (
                <TableRow key={row.id}>
                  {row.getVisibleCells().map((cell) => (
                    <TableCell className="max-w-[280px] truncate" key={cell.id}>
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </TableCell>
                  ))}
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      <div className="flex flex-col gap-3 text-xs text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2">
          <Users aria-hidden="true" size={15} />
          <span>
            {users.length} user{users.length === 1 ? "" : "s"} loaded
          </span>
          {usersQuery.isFetching ? <span>Refreshing</span> : null}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <label className="inline-flex items-center gap-2">
            Rows
            <select
              aria-label="Admin user page size"
              className="h-10 rounded-full border border-outline bg-surface-container px-3 text-sm"
              onChange={(event) => {
                setCursor(undefined);
                setLimit(Number(event.target.value));
              }}
              value={limit}
            >
              <option value={25}>25</option>
              <option value={50}>50</option>
              <option value={100}>100</option>
            </select>
          </label>
          <Button
            disabled={cursor === undefined}
            onClick={() => setCursor(undefined)}
            size="sm"
            type="button"
            variant="ghost"
          >
            First page
          </Button>
          <Button
            disabled={usersQuery.data === undefined || usersQuery.data.nextCursor === null}
            onClick={() => setCursor(usersQuery.data?.nextCursor ?? undefined)}
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

export async function listAdminUsers(
  input: AdminUsersQueryInput = defaultAdminUsersInput,
): Promise<AdminUsersListResponse> {
  const params = new URLSearchParams();
  appendParam(params, "query", input.query);
  appendParam(params, "type", input.type);
  params.set(
    "includeDisabled",
    String(input.includeDisabled ?? defaultAdminUsersInput.includeDisabled),
  );
  params.set("limit", String(input.limit ?? defaultAdminUsersInput.limit));
  appendParam(params, "cursor", input.cursor);

  const response = await authenticatedFetch(`/api/admin/users?${params.toString()}`);
  const output: unknown = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(errorMessageFromOutput(output) ?? `Admin users failed with ${response.status}`);
  }
  if (!isAdminUsersListResponse(output)) {
    throw new Error("Admin users response was missing required fields.");
  }
  return output;
}

function displayNameForUser(user: AdminUser): string {
  const displayName = user.displayName.trim();
  if (displayName.length > 0) {
    return displayName;
  }
  return user.email ?? user.id;
}

function formatDateTime(value: string | null): string {
  if (value === null) {
    return "-";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function shortId(value: string): string {
  return value.length <= 12 ? value : `${value.slice(0, 8)}...${value.slice(-4)}`;
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.length > 0 ? error.message : fallback;
}

function errorMessageFromOutput(output: unknown): string | undefined {
  return isRecord(output) && typeof output.error === "string" ? output.error : undefined;
}

function appendParam(params: URLSearchParams, key: string, value: string | undefined): void {
  const trimmed = value?.trim();
  if (trimmed !== undefined && trimmed.length > 0) {
    params.set(key, trimmed);
  }
}

function isAdminUsersListResponse(value: unknown): value is AdminUsersListResponse {
  if (!isRecord(value) || !Array.isArray(value.users)) {
    return false;
  }
  return (
    value.users.every(isAdminUser) &&
    (typeof value.nextCursor === "string" || value.nextCursor === null)
  );
}

function isAdminUser(value: unknown): value is AdminUser {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.orgId === "string" &&
    typeof value.type === "string" &&
    (typeof value.email === "string" || value.email === null) &&
    typeof value.displayName === "string" &&
    Array.isArray(value.scopes) &&
    value.scopes.every((scope) => typeof scope === "string") &&
    (typeof value.disabledAt === "string" || value.disabledAt === null) &&
    typeof value.createdAt === "string" &&
    typeof value.updatedAt === "string"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
