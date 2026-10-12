/* Admin › Directory › Users. */

import {
  Copy as CopyIcon,
  Download as DownloadIcon,
  UserPlus as UserPlusIcon,
  Users as UsersIcon,
} from "lucide-react";
import { useDebouncedCallback } from "@tanstack/react-pacer";
import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { SelectableList, SelectAllCheckbox } from "@/components/ui/selectable-list";
import { notify } from "@/components/ui/toast";
import {
  adminScopesOf,
  roleForActor,
  USER_ROLES,
  type DirectoryUser,
  type UserRole,
  type UserStatus,
} from "@/features/admin/admin-console-data";
import {
  resolveClosedSearchParam,
  useAdminSectionSearch,
} from "@/features/admin/admin-section-search";
import {
  adminUsersInfiniteQueryOptions,
  adminUsersQueryKeys,
  type AdminUser,
  type AdminUsersQueryInput,
} from "@/features/admin/admin-users";
import { AdminInput, AdminSelect, AdminToolbar } from "@/features/admin/console/controls";
import { formatCount } from "@/features/admin/console/format";
import {
  LoadingState,
  PageHeading,
  QueryFailureBanner,
  useQueryFailure,
} from "@/features/admin/console/primitives";
import { RelativeTime, RowMenu } from "@/features/admin/console/widgets";
import { UserActionDialog, UserActionMenuItems, type UserAction } from "./user-actions";
import { UserInviteDialog } from "./user-invite-dialog";
import { actorTypeLabel, UserDetailsSheet } from "./user-details-sheet";
import { UserStatusChip } from "./user-suspension-dialog";

/* The route caps `limit` at 250; the rest is reached through the keyset
   cursor with Load more. Search and type filters run on the server. */
const DIRECTORY_PAGE_SIZE = 250;

/* Mirrors `actorTypeSchema` in apps/helix/src/platform/auth/admin-users.ts;
   anything else in `?actorType=` reads as "all". */
const ACTOR_TYPES = ["user", "agent", "service_account", "system"] as const;

type StatusFilter = "all" | UserStatus;
type RoleFilter = "all" | UserRole;

/** The server-side half of the filters. `includeDisabled` is a superset switch,
 *  so "Suspended" asks for everyone and narrows in the browser. Role is derived
 *  from scopes and filtered in the browser too. */
function directoryQueryInput(input: {
  readonly query: string;
  readonly actorType: string;
  readonly status: StatusFilter;
}): AdminUsersQueryInput {
  return {
    limit: DIRECTORY_PAGE_SIZE,
    query: input.query.trim(),
    type: input.actorType === "all" ? "" : input.actorType,
    includeDisabled: input.status !== "active",
  };
}

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

/** Warms the directory's first page from the console route loader. */
export async function prefetchAdminDirectoryQuery(queryClient: AdminDirectoryRouteQueryClient) {
  await queryClient
    .ensureInfiniteQueryData(adminUsersInfiniteQueryOptions(DIRECTORY_PREFETCH_INPUT))
    .catch(() => undefined);
}

const ROLE_FILTERS = ["all", ...USER_ROLES] as const satisfies readonly RoleFilter[];
const STATUS_FILTERS = [
  "all",
  "active",
  "invited",
  "suspended",
  "removed",
] as const satisfies readonly StatusFilter[];

function projectAdminUser(user: AdminUser): DirectoryUser {
  return {
    id: user.id,
    name: user.displayName || user.email || "Unknown user",
    email: user.email,
    role: roleForActor(user),
    adminScopes: adminScopesOf(user.scopes),
    actorType: user.type,
    status: user.status,
    createdAt: user.createdAt,
    disabledAt: user.disabledAt,
    lastSignInAt: user.lastSignInAt,
  };
}

/** CSV of the given rows, downloaded in the browser. */
function downloadCsv(rows: readonly DirectoryUser[]): void {
  const escape = (value: string) => `"${value.replace(/"/gu, '""')}"`;
  const header = [
    "Name",
    "Email",
    "Role",
    "Admin scopes",
    "Type",
    "Status",
    "Last sign-in",
    "Added",
  ];
  const body = rows.map((user) =>
    [
      user.name,
      user.email ?? "",
      user.role,
      user.adminScopes.join(" "),
      user.actorType,
      user.status,
      user.lastSignInAt ?? "",
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
  link.download = "users.csv";
  link.click();
  URL.revokeObjectURL(url);
}

function countLabel(shown: number, hasMore: boolean): string {
  const users = `${formatCount(shown)} ${shown === 1 ? "user" : "users"}`;
  return hasMore ? `${users} loaded` : users;
}

export function AdminUsers() {
  const { search, patchSearch } = useAdminSectionSearch("users");
  const query = search.q ?? "";
  const roleFilter = resolveClosedSearchParam(search.role, ROLE_FILTERS, "all");
  const actorTypeFilter: string = resolveClosedSearchParam(search.actorType, ACTOR_TYPES, "all");
  const statusFilter = resolveClosedSearchParam(search.status, STATUS_FILTERS, "all");
  const openUserId = search.user ?? null;
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [inviting, setInviting] = useState(false);
  const [pendingAction, setPendingAction] = useState<{
    readonly user: DirectoryUser;
    readonly action: UserAction;
  } | null>(null);

  /* The URL is the source of truth for `?q=`; the draft is what has been typed
     since the last (debounced) commit. */
  const [queryDraft, setQueryDraft] = useState(query);
  const commitQuery = useDebouncedCallback(
    (value: string) => {
      patchSearch({ q: value.trim().length === 0 ? undefined : value });
    },
    { wait: 300 },
  );
  useEffect(() => {
    setQueryDraft(query);
  }, [query]);

  const queryClient = useQueryClient();
  const queryInput = useMemo(
    () => directoryQueryInput({ query, actorType: actorTypeFilter, status: statusFilter }),
    [query, actorTypeFilter, statusFilter],
  );
  const usersQuery = useInfiniteQuery(adminUsersInfiniteQueryOptions(queryInput));
  const failure = useQueryFailure(usersQuery, () => {
    void queryClient.invalidateQueries({ queryKey: adminUsersQueryKeys.infinite(queryInput) });
  });

  const directory = useMemo<readonly DirectoryUser[]>(
    () => (usersQuery.data?.pages ?? []).flatMap((page) => page.users.map(projectAdminUser)),
    [usersQuery.data],
  );
  const hasMorePages = usersQuery.hasNextPage;

  const filtered = useMemo(
    () =>
      directory.filter(
        (user) =>
          (roleFilter === "all" || user.role === roleFilter) &&
          (statusFilter === "all" || user.status === statusFilter),
      ),
    [directory, roleFilter, statusFilter],
  );

  /* Selection only ever names rows on screen. */
  const visibleIds = useMemo(() => new Set(filtered.map((user) => user.id)), [filtered]);
  useEffect(() => {
    setSelected((current) => {
      const next = new Set([...current].filter((id) => visibleIds.has(id)));
      return next.size === current.size ? current : next;
    });
  }, [visibleIds]);
  const selectedUsers = filtered.filter((user) => selected.has(user.id));

  const openUser = directory.find((user) => user.id === openUserId) ?? null;
  const setOpenUser = useCallback(
    (user: DirectoryUser | null) => patchSearch({ user: user?.id }),
    [patchSearch],
  );
  const startAction = (user: DirectoryUser, action: UserAction) => {
    setPendingAction({ user, action });
  };

  const isFiltered =
    query.trim() !== "" ||
    roleFilter !== "all" ||
    actorTypeFilter !== "all" ||
    statusFilter !== "all";

  const copyEmails = () => {
    const emails = selectedUsers
      .map((user) => user.email)
      .filter((email): email is string => email !== null);
    void navigator.clipboard
      .writeText(emails.join(", "))
      .then(() => notify({ message: `Copied ${formatCount(emails.length)} email addresses` }))
      .catch(() => notify({ message: "Couldn't copy email addresses", tone: "error" }));
  };

  return (
    <>
      <PageHeading
        title="Users"
        subtitle="People, agents, and service accounts in your organization."
        meta={
          usersQuery.data === undefined ? undefined : (
            <span className="text-[var(--text-2)] type-meta">
              {countLabel(filtered.length, hasMorePages)}
            </span>
          )
        }
        actions={
          <>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => downloadCsv(filtered)}
              disabled={filtered.length === 0}
            >
              <DownloadIcon aria-hidden="true" /> Download
            </Button>
            <Button type="button" size="sm" onClick={() => setInviting(true)}>
              <UserPlusIcon aria-hidden="true" /> Invite people
            </Button>
          </>
        }
      />

      {selectedUsers.length > 0 ? (
        <div className="admin-list-toolbar" role="toolbar" aria-label="Selected users">
          <SelectAllCheckbox
            total={filtered.length}
            selectedCount={selectedUsers.length}
            onToggle={(all) => setSelected(all ? new Set(visibleIds) : new Set())}
            label="Select all users"
          />
          <span className="type-body-sm font-medium" role="status">
            {formatCount(selectedUsers.length)} selected
          </span>
          <Button type="button" size="sm" variant="ghost" onClick={copyEmails}>
            <CopyIcon aria-hidden="true" /> Copy email addresses
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => downloadCsv(selectedUsers)}
          >
            <DownloadIcon aria-hidden="true" /> Download selected
          </Button>
        </div>
      ) : (
        <AdminToolbar label="User filters">
          <SelectAllCheckbox
            total={filtered.length}
            selectedCount={0}
            onToggle={(all) => setSelected(all ? new Set(visibleIds) : new Set())}
            label="Select all users"
          />
          <AdminInput
            type="search"
            className="w-full max-w-[320px]"
            value={queryDraft}
            onChange={(event) => {
              setQueryDraft(event.target.value);
              commitQuery(event.target.value);
            }}
            placeholder="Search by name or email"
            aria-label="Search users"
          />
          <AdminSelect
            aria-label="Role"
            value={roleFilter}
            onChange={(event) =>
              patchSearch({ role: event.target.value === "all" ? undefined : event.target.value })
            }
          >
            <option value="all">All roles</option>
            {USER_ROLES.map((role) => (
              <option key={role} value={role}>
                {role}
              </option>
            ))}
          </AdminSelect>
          <AdminSelect
            aria-label="Account type"
            value={actorTypeFilter}
            onChange={(event) =>
              patchSearch({
                actorType: event.target.value === "all" ? undefined : event.target.value,
              })
            }
          >
            <option value="all">All account types</option>
            {ACTOR_TYPES.map((actorType) => (
              <option key={actorType} value={actorType}>
                {actorTypeLabel(actorType)}
              </option>
            ))}
          </AdminSelect>
          <AdminSelect
            aria-label="Status"
            value={statusFilter}
            onChange={(event) =>
              patchSearch({ status: event.target.value === "all" ? undefined : event.target.value })
            }
          >
            <option value="all">All statuses</option>
            <option value="active">Active</option>
            <option value="invited">Invited</option>
            <option value="suspended">Suspended</option>
            <option value="removed">Removed</option>
          </AdminSelect>
          {isFiltered ? (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => {
                setQueryDraft("");
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
      )}

      {failure !== null ? (
        <QueryFailureBanner
          summary="Users couldn't be loaded"
          subject="the directory"
          error={failure.error}
          isRetrying={failure.isRetrying}
          onRetry={failure.retry}
        />
      ) : usersQuery.isPending ? (
        <LoadingState label="Loading users" variant="row" count={8} />
      ) : filtered.length === 0 ? (
        <EmptyState
          icon={<UsersIcon />}
          title={isFiltered ? "No users match these filters" : "No users yet"}
          body={
            isFiltered
              ? hasMorePages
                ? "More users haven't loaded yet. Load more to search them too."
                : "Try a different search or clear the filters."
              : "People appear here when they join your organization."
          }
          headingLevel={2}
          size="inline"
        />
      ) : (
        <div className="admin-list">
          <div className="admin-list-header admin-user-row" aria-hidden="true">
            <span>Name</span>
            <span>Role</span>
            <span>Status</span>
            <span>Last sign-in</span>
            <span />
          </div>
          <SelectableList
            items={filtered}
            getKey={(user) => user.id}
            getItemLabel={(user) => user.name}
            label="Users"
            selectedKeys={selected}
            onSelectedKeysChange={setSelected}
            onOpen={(user) => setOpenUser(user)}
            renderItem={(user, state) => (
              <div className="admin-user-row">
                <span className="admin-user-name">
                  <Avatar name={user.name} size={32} />
                  <span className="min-w-0">
                    <span className="admin-row-title">{user.name}</span>
                    <span className="admin-row-detail">{user.email ?? "No email address"}</span>
                  </span>
                </span>
                <span className="admin-row-cell">
                  <span
                    className={user.role === "Admin" ? "chip accent" : "chip"}
                    title={
                      user.adminScopes.length === 0
                        ? undefined
                        : `Admin access: ${user.adminScopes.join(", ")}`
                    }
                  >
                    {user.role}
                  </span>
                  {user.actorType === "user" ? null : (
                    <span className="admin-row-detail">{actorTypeLabel(user.actorType)}</span>
                  )}
                </span>
                <span className="admin-row-cell">
                  <UserStatusChip status={user.status} />
                </span>
                <span className="admin-row-cell admin-row-detail">
                  <RelativeTime value={user.lastSignInAt} fallback="Never" />
                </span>
                <span className="admin-row-actions">
                  <RowMenu label={`Actions for ${user.name}`} tabIndex={state.tabIndex}>
                    <UserActionMenuItems
                      user={user}
                      onAction={(action) => startAction(user, action)}
                    />
                  </RowMenu>
                </span>
              </div>
            )}
          />
          {hasMorePages ? (
            <div className="admin-list-footer">
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
            </div>
          ) : null}
        </div>
      )}

      {openUser === null ? null : (
        <UserDetailsSheet
          user={openUser}
          onClose={() => setOpenUser(null)}
          onAction={(action) => startAction(openUser, action)}
        />
      )}
      {pendingAction === null ? null : (
        <UserActionDialog
          key={`${pendingAction.user.id}:${pendingAction.action}`}
          user={pendingAction.user}
          action={pendingAction.action}
          onClose={() => setPendingAction(null)}
        />
      )}
      {inviting ? <UserInviteDialog onClose={() => setInviting(false)} /> : null}
    </>
  );
}
