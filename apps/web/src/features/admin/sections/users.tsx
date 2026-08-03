/* Admin › People › Users — the workspace directory. */

import { useCallback, useEffect, useMemo, useState } from "react";
import { useDebouncedCallback } from "@tanstack/react-pacer";
import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import { Icons } from "@/components/icons";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
  adminUsersInfiniteQueryOptions,
  adminUsersQueryKeys,
  type AdminUser,
  type AdminUsersQueryInput,
} from "@/features/admin/admin-users";
import { useAdminSectionSearch } from "@/features/admin/admin-section-search";
import {
  EmptyRow,
  PageHeading,
  PageScroll,
  QueryFailureBanner,
  StateBanner,
  useQueryFailure,
} from "@/features/admin/console/primitives";
import {
  AdminBulkBar,
  AdminInput,
  AdminSelect,
  AdminToolbar,
} from "@/features/admin/console/controls";
import { AdminTable, type AdminColumn } from "@/features/admin/console/table";
import {
  adminScopesOf,
  roleForActor,
  USER_ROLES,
  type DirectoryUser,
  type UserRole,
  type UserStatus,
} from "@/features/admin/admin-console-data";

/* ------------------------------------------------------------------ */
/* Users                                                              */
/* ------------------------------------------------------------------ */

/* The route caps `limit` at 250, so this is one page — not the directory. The
   rest is reached through the endpoint's keyset cursor (`Load more` below),
   and the search box no longer stops at this boundary: `query` and `type` are
   answered by indexed SQL over the whole workspace. */
const DIRECTORY_PAGE_SIZE = 250;

/* Mirrors `actorTypeSchema` in apps/helix/src/platform/auth/admin-users.ts.
   `type` is now sent to the server, which answers 400 for anything outside the
   enum — so a hand-edited or stale `?actorType=` must be read as "all" rather
   than turned into a failed directory load. */
const ACTOR_TYPES = ["user", "agent", "service_account", "system"] as const;

type StatusFilter = "all" | UserStatus;
type RoleFilter = "all" | UserRole;

/** The server-side half of the filter set: text search, actor type, and the
 *  one status lever the API exposes. */
function directoryQueryInput(input: {
  readonly query: string;
  readonly actorType: string;
  readonly status: StatusFilter;
}): AdminUsersQueryInput {
  return {
    limit: DIRECTORY_PAGE_SIZE,
    query: input.query.trim(),
    type: input.actorType === "all" ? "" : input.actorType,
    /* `includeDisabled` is a superset switch, not a status filter: false hides
       suspended actors, true returns both. So "Active" is pushed to the server
       and is complete over the whole workspace with no client pass, while
       "Suspended" asks for both and keeps the disabled rows in the browser —
       the endpoint has no "only disabled" mode. That client pass sees only the
       pages loaded so far, which is what the banner states while `hasNextPage`
       is true, so the two cannot silently disagree. Role is client-side for the
       same reason: it is derived from scopes and the API has no scope filter. */
    includeDisabled: input.status !== "active",
  };
}

/* What the section asks for on first paint, with every filter at its default —
   the route loader has no URL search state to read, so warming anything else
   would populate a key the component never reads. */
const DIRECTORY_PREFETCH_INPUT = directoryQueryInput({
  query: "",
  actorType: "all",
  status: "all",
});

interface AdminDirectoryRouteQueryClient {
  ensureInfiniteQueryData(
    options: ReturnType<typeof adminUsersInfiniteQueryOptions>,
  ): Promise<unknown>;
}

/** Warm the directory's first page from the console route loader, so the chunk
 *  and its first request overlap instead of running back to back. Failures are
 *  swallowed: a prefetch is an optimisation, and the component's own query
 *  re-requests and reports properly on mount. */
export async function prefetchAdminDirectoryQuery(queryClient: AdminDirectoryRouteQueryClient) {
  await queryClient
    .ensureInfiniteQueryData(adminUsersInfiniteQueryOptions(DIRECTORY_PREFETCH_INPUT))
    .catch(() => undefined);
}

/* Every write path this page could offer is absent from the backend:
   `registerAdminUsersRoutes` exposes GET /api/admin/users and nothing else,
   and the only invite route in the tree (POST /api/signup/onboarding-invites)
   is a SaaS signup-funnel endpoint that answers 501 in this build. So the
   controls stay, disabled, naming the reason — rather than looking live and
   doing nothing when clicked. */
const READ_ONLY_REASON =
  "The admin users API is read-only in this build — it serves the directory but has no endpoint to create, invite, or modify an account.";

const ROLE_FILTERS = ["all", ...USER_ROLES] as const satisfies readonly RoleFilter[];
const STATUS_FILTERS = ["all", "active", "suspended"] as const satisfies readonly StatusFilter[];

function roleFilterFromSearch(value: string | undefined): RoleFilter {
  return ROLE_FILTERS.includes(value as RoleFilter) ? (value as RoleFilter) : "all";
}

function statusFilterFromSearch(value: string | undefined): StatusFilter {
  return STATUS_FILTERS.includes(value as StatusFilter) ? (value as StatusFilter) : "all";
}

function actorTypeFromSearch(value: string | undefined): string {
  return ACTOR_TYPES.includes(value as (typeof ACTOR_TYPES)[number]) ? (value as string) : "all";
}

/** Project the real admin user API shape onto the directory row. */
function projectAdminUser(user: AdminUser): DirectoryUser {
  return {
    id: user.id,
    name: user.displayName || user.email || "Unknown user",
    email: user.email,
    role: roleForActor(user),
    adminScopes: adminScopesOf(user.scopes),
    actorType: user.type,
    status: user.disabledAt ? "suspended" : "active",
    createdAt: user.createdAt,
    disabledAt: user.disabledAt,
  };
}

/** `agent`, `service_account` → `Agent`, `Service account`. */
function actorTypeLabel(type: string): string {
  if (type.length === 0) {
    return "—";
  }
  const spaced = type.replace(/_/gu, " ");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(date);
}

function StatusChip({ status }: { status: UserStatus }) {
  return (
    <span className={`chip ${status === "active" ? "success" : "danger"}`}>
      <span className="chip-dot" />
      {status}
    </span>
  );
}

/** Copy-to-clipboard with a short "Copied" acknowledgement.
 *
 *  The clipboard API is absent outside a secure context, so the failure is
 *  reported instead of swallowed — a copy button that silently does nothing is
 *  the same defect as a button with no handler. */
function useCopy() {
  const [state, setState] = useState<{ key: string; ok: boolean } | null>(null);
  // House rule (helix/pacer-discipline): scheduled work goes through Pacer, not
  // bare setTimeout — it owns cleanup, so the ack cannot fire after unmount.
  const clearAck = useDebouncedCallback(() => setState(null), { wait: 2500 });

  const copy = useCallback(
    (key: string, value: string) => {
      const settle = (ok: boolean) => {
        setState({ key, ok });
        clearAck();
      };
      void (async () => {
        try {
          await navigator.clipboard.writeText(value);
          settle(true);
        } catch {
          settle(false);
        }
      })();
    },
    [clearAck],
  );

  return { copy, state };
}

function CopyButton({
  label,
  value,
  copyKey,
  copy,
  state,
}: {
  label: string;
  value: string;
  copyKey: string;
  copy: (key: string, value: string) => void;
  state: { key: string; ok: boolean } | null;
}) {
  const active = state?.key === copyKey ? state : null;
  return (
    <Button type="button" size="xs" variant="outline" onClick={() => copy(copyKey, value)}>
      <Icons.Copy /> {active === null ? label : active.ok ? "Copied" : "Copy failed"}
    </Button>
  );
}

/* The expander opens a second row rather than a floating panel, so the detail
   stays inside the table it belongs to. `AdminTable` renders one `TableRow` per
   entry in `rows`, so the disclosure is modelled as its own row here. It has no
   `colSpan` escape in the shared column model, so the detail is rendered in the
   widest column — which lands it under the account it describes, where the old
   grid indented it to. The other cells stay empty rather than repeating the row
   above them. */
type DirectoryRow =
  | { readonly kind: "user"; readonly user: DirectoryUser }
  | { readonly kind: "detail"; readonly user: DirectoryUser };

function detailRowId(userId: string): string {
  return `user-detail-${userId}`;
}

function UserDetail({
  user,
  copy,
  copyState,
}: {
  readonly user: DirectoryUser;
  readonly copy: (key: string, value: string) => void;
  readonly copyState: { key: string; ok: boolean } | null;
}) {
  return (
    <div
      id={detailRowId(user.id)}
      className="grid gap-2 py-2 pl-7 whitespace-normal [font-size:var(--text-meta)]"
    >
      <div className="row flex-wrap items-center gap-2">
        <span className="text-[var(--text-3)]">Actor ID</span>
        <code className="mono">{user.id}</code>
        <CopyButton
          label="Copy ID"
          value={user.id}
          copyKey={`id-${user.id}`}
          copy={copy}
          state={copyState}
        />
        {user.email === null ? null : (
          <CopyButton
            label="Copy email"
            value={user.email}
            copyKey={`email-${user.id}`}
            copy={copy}
            state={copyState}
          />
        )}
      </div>
      <div>
        <span className="text-[var(--text-3)]">Admin scopes </span>
        {user.adminScopes.length === 0 ? (
          <span className="text-[var(--text-2)]">
            None — this account reaches no admin surface.
          </span>
        ) : (
          <span className="row mt-1 flex-wrap gap-1">
            {user.adminScopes.map((scope) => (
              <span key={scope} className="chip mono">
                {scope}
              </span>
            ))}
          </span>
        )}
      </div>
      <div className="text-[var(--text-2)]">
        Added {formatDate(user.createdAt)}
        {user.disabledAt === null ? "" : ` · Suspended ${formatDate(user.disabledAt)}`}
      </div>
    </div>
  );
}

/** CSV of what is on screen. Pure client-side over rows already fetched — the
 *  one export this page can honestly offer, and the counterpart to the Import
 *  CSV control that has no endpoint behind it. */
function downloadCsv(rows: readonly DirectoryUser[]): void {
  const escape = (value: string) => `"${value.replace(/"/gu, '""')}"`;
  const header = ["Name", "Email", "Role", "Admin scopes", "Type", "Status", "Created"];
  const body = rows.map((user) =>
    [
      user.name,
      user.email ?? "",
      user.role,
      user.adminScopes.join(" "),
      user.actorType,
      user.status,
      user.createdAt,
    ]
      .map(escape)
      .join(","),
  );
  const blob = new Blob([[header.map(escape).join(","), ...body].join("\r\n")], {
    type: "text/csv;charset=utf-8",
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "workspace-users.csv";
  link.click();
  URL.revokeObjectURL(url);
}

export function AdminUsers() {
  const { search, patchSearch } = useAdminSectionSearch("users");
  const query = search.q ?? "";
  const roleFilter = roleFilterFromSearch(search.role);
  const actorTypeFilter = actorTypeFromSearch(search.actorType);
  const statusFilter = statusFilterFromSearch(search.status);
  const expanded = search.user ?? null;
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const { copy, state: copyState } = useCopy();

  /* The text box is now a server request, so every keystroke would be a round
     trip and a new cache entry. The URL stays the source of truth (`?q=` is
     still deep-linkable and still what the query reads); the draft below is
     only what the operator has typed since the last commit. House rule
     (helix/pacer-discipline): the delay is Pacer's, never a bare setTimeout. */
  const [queryDraft, setQueryDraft] = useState(query);
  const commitQuery = useDebouncedCallback(
    (value: string) => {
      patchSearch({ q: value.trim().length === 0 ? undefined : value });
    },
    { wait: 300 },
  );

  /* Anything that changes `?q=` without going through the box — a deep link, a
     back navigation, Clear filters — has to reach the input, or the box would
     keep showing a filter that is no longer applied. */
  useEffect(() => {
    setQueryDraft(query);
  }, [query]);

  const setQuery = (value: string) => {
    setQueryDraft(value);
    commitQuery(value);
  };
  const setRoleFilter = (value: RoleFilter) => {
    patchSearch({ role: value === "all" ? undefined : value });
  };
  const setActorTypeFilter = (value: string) => {
    patchSearch({ actorType: value === "all" ? undefined : value });
  };
  const setStatusFilter = (value: StatusFilter) => {
    patchSearch({ status: value === "all" ? undefined : value });
  };
  const setExpanded = (userId: string | null) => {
    patchSearch({ user: userId ?? undefined });
  };

  const queryClient = useQueryClient();
  const queryInput = useMemo(
    () => directoryQueryInput({ query, actorType: actorTypeFilter, status: statusFilter }),
    [query, actorTypeFilter, statusFilter],
  );
  const usersQuery = useInfiniteQuery(adminUsersInfiniteQueryOptions(queryInput));
  const failure = useQueryFailure(usersQuery, () => {
    void queryClient.invalidateQueries({
      queryKey: adminUsersQueryKeys.infinite(queryInput),
    });
  });

  const directory = useMemo<readonly DirectoryUser[]>(
    () => (usersQuery.data?.pages ?? []).flatMap((page) => page.users.map(projectAdminUser)),
    [usersQuery.data],
  );

  /* The `?? []` above keeps the table rendering while the request is out, but
     the length of that fallback is not a measurement of anything. Until the
     directory answers there is no count, and printing one made a refused
     request read as an empty workspace — the same zero Overview would then
     repeat for its Directory figure. */
  const counted = usersQuery.data !== undefined;

  /* The server answered with a cursor, so this is a prefix of the matching
     accounts and not the answer. Everything derived from the loaded rows — the
     count, the client-side filters, the export, the selection — has to be
     described as such while this is true. */
  const hasMorePages = usersQuery.hasNextPage;

  const actorTypes = useMemo(
    () => [...new Set(directory.map((user) => user.actorType))].sort(),
    [directory],
  );

  /* A filter with one option filters nothing, so the select stays hidden in a
     single-type workspace — but it must also be on screen whenever it is
     applied, because the type filter now narrows the *server* result set: the
     loaded rows would then all be one type and a select that hid itself on that
     basis would leave an invisible filter running with no way to clear it. */
  const showActorTypeFilter = actorTypeFilter !== "all" || actorTypes.length > 1;

  /* Text search and actor type are answered by the endpoint (see
     `directoryQueryInput`); what is left here is what the API cannot express. */
  const filtered = useMemo(
    () =>
      directory.filter((user) => {
        if (roleFilter !== "all" && user.role !== roleFilter) {
          return false;
        }
        if (statusFilter !== "all" && user.status !== statusFilter) {
          return false;
        }
        return true;
      }),
    [directory, roleFilter, statusFilter],
  );

  const visibleIds = useMemo(() => new Set(filtered.map((user) => user.id)), [filtered]);

  /* Selection is pruned to the rows on screen instead of surviving a filter or
     a new search. A set that outlived its rows let the bulk bar count — and act
     on — accounts the operator could not see, and paging makes that worse: the
     bar would name people from a page that is no longer loaded. What the
     counter says is now exactly what the buttons will touch. */
  useEffect(() => {
    setSelected((current) => {
      const next = new Set([...current].filter((id) => visibleIds.has(id)));
      return next.size === current.size ? current : next;
    });
  }, [visibleIds]);

  const selectedVisible = useMemo(
    () => filtered.filter((user) => selected.has(user.id)),
    [filtered, selected],
  );
  const allSelected = filtered.length > 0 && selectedVisible.length === filtered.length;

  const toggleAll = () => {
    setSelected((current) => {
      const next = new Set(current);
      for (const user of filtered) {
        if (allSelected) {
          next.delete(user.id);
        } else {
          next.add(user.id);
        }
      }
      return next;
    });
  };

  const toggleOne = (id: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const selectedEmails = selectedVisible
    .map((user) => user.email)
    .filter((email): email is string => email !== null);

  const isFiltered =
    queryDraft.trim() !== "" ||
    query.trim() !== "" ||
    roleFilter !== "all" ||
    actorTypeFilter !== "all" ||
    statusFilter !== "all";

  /* Only the filters this page applies itself can make the two numbers differ;
     the server-side ones are already reflected in what it returned. */
  const narrowedInBrowser = roleFilter !== "all" || statusFilter !== "all";

  /* A count under an active search is a count of matches, never of the
     workspace — the unfiltered wording would misreport it as the total. */
  const narrowedByServer = query.trim() !== "" || actorTypeFilter !== "all";

  /* One entry per rendered `<tr>`: the account, then its detail row while the
     expander is open. Only one row can be expanded — `?user=` holds a single
     id — so at most one detail row exists at a time. */
  const rows = useMemo<readonly DirectoryRow[]>(
    () =>
      filtered.flatMap((user) =>
        expanded === user.id
          ? [{ kind: "user", user } as const, { kind: "detail", user } as const]
          : [{ kind: "user", user } as const],
      ),
    [filtered, expanded],
  );

  const columns: readonly AdminColumn<DirectoryRow>[] = [
    {
      id: "select",
      width: "32px",
      header: (
        <input
          type="checkbox"
          aria-label="Select all users"
          /* Names what it does: the listed rows, not the workspace. There is
             no bulk endpoint that could act on an unloaded account anyway. */
          title={
            hasMorePages
              ? "Selects the rows loaded below. Accounts not yet loaded are not selected."
              : "Selects every row listed below."
          }
          checked={allSelected}
          /* `indeterminate` is DOM-only — a partial selection otherwise
             renders as an empty box, which reads as "nothing selected". */
          ref={(node) => {
            if (node !== null) {
              node.indeterminate = !allSelected && selectedVisible.length > 0;
            }
          }}
          onChange={toggleAll}
          className="accent-[var(--accent)]"
        />
      ),
      cell: (row) =>
        row.kind === "detail" ? null : (
          <input
            type="checkbox"
            aria-label={`Select ${row.user.name}`}
            checked={selected.has(row.user.id)}
            onChange={() => toggleOne(row.user.id)}
            className="accent-[var(--accent)]"
          />
        ),
    },
    {
      id: "user",
      header: "User",
      /* Both a row and its expanded detail row return the *same* value, and
         `Array.prototype.sort` is stable — so a detail row stays immediately
         under the row it belongs to instead of being flung to the other end of
         a name sort. Same reasoning for every sortable column below. */
      sortValue: (row) => row.user.name,
      cell: (row) =>
        row.kind === "detail" ? (
          <UserDetail user={row.user} copy={copy} copyState={copyState} />
        ) : (
          <div className="row min-w-0 gap-2">
            <Avatar name={row.user.name} size={22} />
            <div className="min-w-0">
              <div className="truncate font-medium">{row.user.name}</div>
              <div className="truncate text-[var(--text-3)] [font-size:var(--text-caption)]">
                {/* Agent and service actors have no address. An em dash
                    reads as unknown; "—" must never be a value that
                    search or selection can match. */}
                {row.user.email ?? "No email address"}
              </div>
            </div>
          </div>
        ),
    },
    {
      id: "role",
      header: "Role",
      width: "130px",
      /* Sorts by privilege, not alphabetically: `USER_ROLES` is ordered
         most-privileged first, which is the order an operator auditing access
         actually wants. Alphabetical would interleave Admin and Member around
         "Scoped admin" and mean nothing. */
      sortValue: (row) => USER_ROLES.indexOf(row.user.role),
      cell: (row) =>
        row.kind === "detail" ? null : (
          /* Both roles get a chip. Previously Admin was a chip and Member was
             bare text, so one column had two shapes. */
          <span
            className={row.user.role === "Admin" ? "chip accent" : "chip"}
            title={
              row.user.adminScopes.length === 0
                ? "No admin scopes."
                : `Admin scopes: ${row.user.adminScopes.join(", ")}`
            }
          >
            {row.user.role}
            {row.user.role === "Scoped admin" ? ` · ${String(row.user.adminScopes.length)}` : ""}
          </span>
        ),
    },
    {
      id: "type",
      header: "Type",
      width: "110px",
      sortValue: (row) => actorTypeLabel(row.user.actorType),
      cell: (row) =>
        row.kind === "detail" ? null : (
          <span className="text-[var(--text-2)]">{actorTypeLabel(row.user.actorType)}</span>
        ),
    },
    {
      id: "status",
      header: "Status",
      width: "90px",
      sortValue: (row) => row.user.status,
      cell: (row) => (row.kind === "detail" ? null : <StatusChip status={row.user.status} />),
    },
    {
      id: "expander",
      header: "Details",
      headerHidden: true,
      width: "40px",
      cell: (row) => {
        if (row.kind === "detail") {
          return null;
        }
        const isExpanded = expanded === row.user.id;
        return (
          /* Was a dead kebab. It now discloses the row's detail: the scopes
             behind the role, the actor id, and the copy actions — the rare
             half of the row, one level in. */
          <button
            type="button"
            className="icon-btn"
            aria-label={`Details for ${row.user.name}`}
            aria-expanded={isExpanded}
            aria-controls={detailRowId(row.user.id)}
            onClick={() => setExpanded(isExpanded ? null : row.user.id)}
          >
            {isExpanded ? <Icons.ChevronDown /> : <Icons.ChevronRight />}
          </button>
        );
      },
    },
  ];

  return (
    <PageScroll>
      <PageHeading
        title="Users"
        subtitle="Every actor in this workspace — people, agents, and service identities."
        meta={
          <span className="ml-2 text-[var(--text-3)] [font-size:var(--text-meta)]">
            {/* A row count is only a workspace total when the server said there
                is nothing after it. While a cursor remains, the number is what
                has been loaded, and it is labelled that way.

                "Loaded" names `directory`, never `filtered`: the client-side
                role/status pass runs after the fetch, so counting it made the
                header read "3 loaded" while the banner one line below said 250
                accounts were loaded. When that pass is narrowing, both numbers
                are printed and only the second is called loaded. */}
            {!counted
              ? failure !== null
                ? "count unavailable"
                : "counting…"
              : hasMorePages
                ? narrowedInBrowser
                  ? `${String(filtered.length)} shown of ${String(directory.length)} loaded — more not yet loaded`
                  : `${String(directory.length)} loaded — more not yet loaded`
                : narrowedInBrowser
                  ? `${String(filtered.length)} of ${String(directory.length)} shown`
                  : narrowedByServer
                    ? `${String(directory.length)} matching`
                    : `${String(directory.length)} user${directory.length === 1 ? "" : "s"}`}
          </span>
        }
        actions={
          <Button
            type="button"
            size="sm"
            onClick={() => downloadCsv(filtered)}
            disabled={filtered.length === 0}
            title={
              filtered.length === 0
                ? "No rows to export."
                : hasMorePages
                  ? "Download the loaded rows as a CSV file. Accounts on later pages are not included."
                  : "Download the rows below as a CSV file."
            }
          >
            <Icons.Download /> Export CSV
          </Button>
        }
      />

      {failure !== null ? (
        <QueryFailureBanner
          summary="The directory is unavailable"
          subject="the directory"
          error={failure.error}
          isRetrying={failure.isRetrying}
          onRetry={failure.retry}
          /* The user list is everything this page renders, so the retry is the
             only action left on screen. */
          retryVariant="default"
        >
          Search, filters, and export all read the loaded rows, so they stay empty until this loads.
        </QueryFailureBanner>
      ) : usersQuery.isPending ? (
        <StateBanner kind="loading">Loading users…</StateBanner>
      ) : hasMorePages ? (
        /* The old banner said search covered only the loaded rows. That is no
           longer true — but "search covers everything" would be a claim about
           rows nobody has fetched, so this states exactly what is known: the
           search ran on the server, the rest did not, and more pages remain. */
        <StateBanner kind="info">
          Search and the type filter run across the whole workspace. {directory.length} accounts are
          loaded and the server has more — the role and status filters, the count above, and the CSV
          export cover only what is loaded. Load more to widen them.
        </StateBanner>
      ) : null}

      <AdminToolbar label="User filters">
        <AdminInput
          className="w-full max-w-[300px]"
          value={queryDraft}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search name, email, or ID…"
          aria-label="Filter users"
        />
        <AdminSelect
          aria-label="Filter by role"
          value={roleFilter}
          onChange={(event) => setRoleFilter(event.target.value as RoleFilter)}
        >
          <option value="all">All roles</option>
          {USER_ROLES.map((role) => (
            <option key={role} value={role}>
              {role}
            </option>
          ))}
        </AdminSelect>
        {/* Options are the platform's actor types rather than the ones present
            in the loaded rows: the filter is answered by the server, so the
            reachable set is not what this page happens to hold. */}
        {showActorTypeFilter ? (
          <AdminSelect
            aria-label="Filter by actor type"
            value={actorTypeFilter}
            onChange={(event) => setActorTypeFilter(event.target.value)}
          >
            <option value="all">All types</option>
            {ACTOR_TYPES.map((actorType) => (
              <option key={actorType} value={actorType}>
                {actorTypeLabel(actorType)}
              </option>
            ))}
          </AdminSelect>
        ) : null}
        <AdminSelect
          aria-label="Filter by status"
          value={statusFilter}
          onChange={(event) => setStatusFilter(event.target.value as StatusFilter)}
        >
          <option value="all">All statuses</option>
          <option value="active">Active</option>
          <option value="suspended">Suspended</option>
        </AdminSelect>
        {isFiltered ? (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => {
              setQueryDraft("");
              /* A keystroke may still be waiting on the debounce; re-committing
                 the empty value collapses it into this clear instead of letting
                 it restore the search a moment later. */
              commitQuery("");
              patchSearch({
                q: undefined,
                role: undefined,
                actorType: undefined,
                status: undefined,
              });
            }}
          >
            Clear filters
          </Button>
        ) : null}
      </AdminToolbar>

      {selectedVisible.length > 0 ? (
        <AdminBulkBar label="Bulk actions for selected users">
          {/* Every id in the set is a row on screen (see the pruning effect), so
              this number is the whole of what an action here would affect. */}
          <span className="font-medium [font-size:var(--text-meta)]">
            {selectedVisible.length} selected
            {hasMorePages ? " — from the loaded rows only" : ""}
          </span>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => copy("bulk-emails", selectedEmails.join(", "))}
            disabled={selectedEmails.length === 0}
            title={
              selectedEmails.length === 0
                ? "None of the selected actors has an email address."
                : "Copy the selected email addresses to the clipboard."
            }
          >
            <Icons.Copy />{" "}
            {copyState?.key === "bulk-emails"
              ? copyState.ok
                ? "Copied"
                : "Copy failed"
              : `Copy ${String(selectedEmails.length)} email${selectedEmails.length === 1 ? "" : "s"}`}
          </Button>
          <Button type="button" size="sm" variant="ghost" onClick={() => setSelected(new Set())}>
            Clear selection
          </Button>
          {/* Destructive and role-changing actions sit one level in, and are
              disabled with the reason rather than pretending to be live. */}
          <details className="ml-auto">
            <summary className="cursor-pointer text-[var(--text-3)] [font-size:var(--text-meta)]">
              Change role, suspend…
            </summary>
            <div className="row mt-2 flex-wrap items-center gap-2">
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled
                title={READ_ONLY_REASON}
                aria-describedby="users-read-only-reason"
              >
                Change role
              </Button>
              <Button
                type="button"
                size="sm"
                variant="destructive"
                disabled
                title={READ_ONLY_REASON}
                aria-describedby="users-read-only-reason"
              >
                Suspend
              </Button>
              <span
                id="users-read-only-reason"
                className="text-[var(--text-3)] [font-size:var(--text-caption)]"
              >
                {READ_ONLY_REASON}
              </span>
            </div>
          </details>
        </AdminBulkBar>
      ) : null}

      <div className="panel overflow-hidden">
        <AdminTable
          label="User directory"
          columns={columns}
          rows={rows}
          rowKey={(row) => `${row.kind}:${row.user.id}`}
          /* Sorting reorders what is loaded, not what exists. With a page still
             outstanding, "sorted by name" would otherwise read as a claim about
             the whole workspace — the same lie the client-side search told
             before search moved server-side. */
          {...(hasMorePages
            ? { partialNote: `Sorted within the ${String(directory.length)} rows loaded so far.` }
            : {})}
          empty={
            <EmptyRow>
              {failure !== null
                ? "Could not load the directory."
                : usersQuery.isPending
                  ? "Loading users…"
                  : hasMorePages
                    ? "No users match the current filters. The server has more pages — load them to widen the role and status filters."
                    : "No users match the current filters."}
            </EmptyRow>
          }
        />

        {/* An explicit control rather than a scroll sentinel: the table is not
            virtualized, so auto-loading on scroll would keep growing the DOM
            without the operator ever asking, and in a 10k-actor workspace that
            is a hang. Paging is the operator's decision, and the label says how
            many rows one press adds. */}
        {hasMorePages ? (
          <div className="row flex-wrap items-center gap-2 px-3 py-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => {
                void usersQuery.fetchNextPage();
              }}
              disabled={usersQuery.isFetchingNextPage}
            >
              {usersQuery.isFetchingNextPage ? "Loading…" : "Load more"}
            </Button>
            <span className="text-[var(--text-3)] [font-size:var(--text-caption)]">
              {directory.length} loaded — up to {DIRECTORY_PAGE_SIZE} more per press. The server has
              not said how many remain.
            </span>
          </div>
        ) : null}
      </div>

      {/* Account creation is not a rare action — it is simply absent from this
          build. Keeping it visible but disabled, with the reason beside it, is
          the honest reading; a live-looking "Invite users" button that did
          nothing was not. */}
      <details className="mt-3">
        <summary className="cursor-pointer [font-size:var(--text-meta)]">
          Adding accounts (unavailable in this build)
        </summary>
        <div className="row mt-2 flex-wrap items-center gap-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled
            title={READ_ONLY_REASON}
            aria-describedby="users-add-reason"
          >
            <Icons.Upload /> Import CSV
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled
            title={READ_ONLY_REASON}
            aria-describedby="users-add-reason"
          >
            <Icons.Plus /> Invite users
          </Button>
          <span
            id="users-add-reason"
            className="text-[var(--text-3)] [font-size:var(--text-caption)]"
          >
            {READ_ONLY_REASON}
          </span>
        </div>
      </details>
    </PageScroll>
  );
}
