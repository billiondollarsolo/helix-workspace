/* Admin › People › Users — the workspace directory. */

import { useCallback, useMemo, useState } from "react";
import { useDebouncedCallback } from "@tanstack/react-pacer";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Icons } from "@/components/icons";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
  adminUsersQueryKeys,
  adminUsersQueryOptions,
  type AdminUser,
} from "@/features/admin/admin-users";
import {
  EmptyRow,
  HEADER_CELL,
  INPUT_STYLE,
  PageHeading,
  PageScroll,
  QueryFailureBanner,
  StateBanner,
  useQueryFailure,
} from "@/features/admin/console/primitives";
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

const USERS_GRID = "28px 1fr 130px 110px 90px 32px";

/* The API caps a page at 250 and the table has no cursor pagination, so this
   is the most it can honestly show at once. Anything beyond it is reported
   rather than silently dropped — see `truncated` below. */
const DIRECTORY_PAGE_SIZE = 250;

const DIRECTORY_QUERY_INPUT = {
  includeDisabled: true,
  limit: DIRECTORY_PAGE_SIZE,
} as const;

/* Every write path this page could offer is absent from the backend:
   `registerAdminUsersRoutes` exposes GET /api/admin/users and nothing else,
   and the only invite route in the tree (POST /api/signup/onboarding-invites)
   is a SaaS signup-funnel endpoint that answers 501 in this build. So the
   controls stay, disabled, naming the reason — rather than looking live and
   doing nothing when clicked. */
const READ_ONLY_REASON =
  "The admin users API is read-only in this build — it serves the directory but has no endpoint to create, invite, or modify an account.";

type StatusFilter = "all" | UserStatus;
type RoleFilter = "all" | UserRole;

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

/** `human`, `agent` → `Human`, `Agent`. */
function actorTypeLabel(type: string): string {
  return type.length === 0 ? "—" : type.charAt(0).toUpperCase() + type.slice(1);
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
  const [query, setQuery] = useState("");
  const [roleFilter, setRoleFilter] = useState<RoleFilter>("all");
  const [actorTypeFilter, setActorTypeFilter] = useState<string>("all");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [expanded, setExpanded] = useState<string | null>(null);
  const { copy, state: copyState } = useCopy();

  const queryClient = useQueryClient();
  const usersQuery = useQuery(adminUsersQueryOptions(DIRECTORY_QUERY_INPUT));
  const failure = useQueryFailure(usersQuery, () => {
    void queryClient.invalidateQueries({
      queryKey: adminUsersQueryKeys.list(DIRECTORY_QUERY_INPUT),
    });
  });

  const directory = useMemo<readonly DirectoryUser[]>(
    () => (usersQuery.data?.users ?? []).map(projectAdminUser),
    [usersQuery.data],
  );

  /* The `?? []` above keeps the table rendering while the request is out, but
     the length of that fallback is not a measurement of anything. Until the
     directory answers there is no count, and printing one made a refused
     request read as an empty workspace — the same zero Overview would then
     repeat for its Directory figure. */
  const counted = usersQuery.data !== undefined;

  /* The table holds one page and filters it in the browser, so a non-null
     cursor means there are people it is neither showing nor searching. */
  const truncated = (usersQuery.data?.nextCursor ?? null) !== null;

  const actorTypes = useMemo(
    () => [...new Set(directory.map((user) => user.actorType))].sort(),
    [directory],
  );

  /* The type select only renders while more than one type is present, so a
     stale selection from a wider result set would keep hiding rows with no
     control on screen to clear it. A filter the operator cannot see must not
     be a filter that still applies. */
  const effectiveActorTypeFilter = actorTypes.length > 1 ? actorTypeFilter : "all";

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return directory.filter((user) => {
      if (
        needle &&
        !user.name.toLowerCase().includes(needle) &&
        !(user.email ?? "").toLowerCase().includes(needle) &&
        !user.id.toLowerCase().includes(needle)
      ) {
        return false;
      }
      if (roleFilter !== "all" && user.role !== roleFilter) {
        return false;
      }
      if (effectiveActorTypeFilter !== "all" && user.actorType !== effectiveActorTypeFilter) {
        return false;
      }
      if (statusFilter !== "all" && user.status !== statusFilter) {
        return false;
      }
      return true;
    });
  }, [directory, query, roleFilter, effectiveActorTypeFilter, statusFilter]);

  /* Selection is keyed by actor id and survives filtering, so the count can
     name rows that are currently hidden. Acting on what is not on screen is
     how bulk operations go wrong; the bar reports both numbers. */
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
    query.trim() !== "" ||
    roleFilter !== "all" ||
    effectiveActorTypeFilter !== "all" ||
    statusFilter !== "all";

  return (
    <PageScroll>
      <PageHeading
        title="Users"
        subtitle="Every actor in this workspace — people, agents, and service identities."
        meta={
          <span style={{ marginLeft: 8, fontSize: "var(--text-meta)", color: "var(--text-3)" }}>
            {!counted
              ? failure !== null
                ? "count unavailable"
                : "counting…"
              : isFiltered
                ? `${String(filtered.length)} of ${String(directory.length)} shown`
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
      ) : truncated ? (
        <StateBanner kind="info">
          Showing the first {DIRECTORY_PAGE_SIZE} accounts — this workspace has more. Search and
          filters below apply only to these rows.
        </StateBanner>
      ) : null}

      <div
        style={{
          display: "flex",
          gap: 8,
          marginBottom: 12,
          alignItems: "center",
          flexWrap: "wrap",
        }}
      >
        <div className="search" style={{ maxWidth: 300, height: 30 }}>
          <Icons.Search />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Filter by name, email, or ID…"
            aria-label="Filter users"
          />
        </div>
        <select
          aria-label="Filter by role"
          value={roleFilter}
          onChange={(event) => setRoleFilter(event.target.value as RoleFilter)}
          style={INPUT_STYLE}
        >
          <option value="all">All roles</option>
          {USER_ROLES.map((role) => (
            <option key={role} value={role}>
              {role}
            </option>
          ))}
        </select>
        {/* A filter with one option filters nothing. Workspaces that only ever
            hold `user` actors got a control that could not change the result. */}
        {actorTypes.length > 1 ? (
          <select
            aria-label="Filter by actor type"
            value={actorTypeFilter}
            onChange={(event) => setActorTypeFilter(event.target.value)}
            style={INPUT_STYLE}
          >
            <option value="all">All types</option>
            {actorTypes.map((actorType) => (
              <option key={actorType} value={actorType}>
                {actorTypeLabel(actorType)}
              </option>
            ))}
          </select>
        ) : null}
        <select
          aria-label="Filter by status"
          value={statusFilter}
          onChange={(event) => setStatusFilter(event.target.value as StatusFilter)}
          style={INPUT_STYLE}
        >
          <option value="all">All statuses</option>
          <option value="active">Active</option>
          <option value="suspended">Suspended</option>
        </select>
        {isFiltered ? (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => {
              setQuery("");
              setRoleFilter("all");
              setActorTypeFilter("all");
              setStatusFilter("all");
            }}
          >
            Clear filters
          </Button>
        ) : null}
      </div>

      {selectedVisible.length > 0 ? (
        <div
          className="panel"
          style={{
            display: "flex",
            gap: 8,
            alignItems: "center",
            flexWrap: "wrap",
            padding: "8px 12px",
            marginBottom: 12,
          }}
          role="group"
          aria-label="Bulk actions for selected users"
        >
          <span style={{ fontSize: "var(--text-meta)", fontWeight: 500 }}>
            {selectedVisible.length} selected
            {selected.size > selectedVisible.length
              ? ` (${String(selected.size - selectedVisible.length)} more hidden by filters)`
              : ""}
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
          <details style={{ marginLeft: "auto" }}>
            <summary
              style={{ fontSize: "var(--text-meta)", color: "var(--text-3)", cursor: "pointer" }}
            >
              Change role, suspend…
            </summary>
            <div
              className="row gap-2"
              style={{ marginTop: 8, alignItems: "center", flexWrap: "wrap" }}
            >
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
                style={{ fontSize: "var(--text-caption)", color: "var(--text-3)" }}
              >
                {READ_ONLY_REASON}
              </span>
            </div>
          </details>
        </div>
      ) : null}

      <div className="panel" style={{ overflow: "hidden" }}>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: USERS_GRID,
            padding: "0 12px",
            height: 32,
            alignItems: "center",
            borderBottom: "1px solid var(--border)",
            background: "var(--surface-2)",
            ...HEADER_CELL,
          }}
        >
          <input
            type="checkbox"
            aria-label="Select all users"
            checked={allSelected}
            /* `indeterminate` is DOM-only — a partial selection otherwise
               renders as an empty box, which reads as "nothing selected". */
            ref={(node) => {
              if (node !== null) {
                node.indeterminate = !allSelected && selectedVisible.length > 0;
              }
            }}
            onChange={toggleAll}
            style={{ accentColor: "var(--accent)" }}
          />
          <span>User</span>
          <span>Role</span>
          <span>Type</span>
          <span>Status</span>
          <span />
        </div>

        {filtered.length === 0 ? (
          <EmptyRow>
            {failure !== null
              ? "Could not load the directory."
              : usersQuery.isPending
                ? "Loading users…"
                : "No users match the current filters."}
          </EmptyRow>
        ) : (
          filtered.map((user) => {
            const isSelected = selected.has(user.id);
            const isExpanded = expanded === user.id;
            const detailId = `user-detail-${user.id}`;
            return (
              <div key={user.id} style={{ borderBottom: "1px solid var(--border)" }}>
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: USERS_GRID,
                    padding: "0 12px",
                    height: "var(--rd-list-row-h)",
                    alignItems: "center",
                    fontSize: "var(--rd-row-fs)",
                    background: isSelected ? "var(--accent-soft)" : undefined,
                  }}
                >
                  <input
                    type="checkbox"
                    aria-label={`Select ${user.name}`}
                    checked={isSelected}
                    onChange={() => toggleOne(user.id)}
                    style={{ accentColor: "var(--accent)" }}
                  />
                  <div className="row gap-2" style={{ minWidth: 0 }}>
                    <Avatar name={user.name} size={22} />
                    <div style={{ minWidth: 0 }}>
                      <div className="truncate" style={{ fontWeight: 500 }}>
                        {user.name}
                      </div>
                      <div
                        className="truncate"
                        style={{ fontSize: "var(--text-caption)", color: "var(--text-3)" }}
                      >
                        {/* Agent and service actors have no address. An em dash
                            reads as unknown; "—" must never be a value that
                            search or selection can match. */}
                        {user.email ?? "No email address"}
                      </div>
                    </div>
                  </div>
                  <span>
                    {/* Both roles get a chip. Previously Admin was a chip and
                        Member was bare text, so one column had two shapes. */}
                    <span
                      className={user.role === "Admin" ? "chip accent" : "chip"}
                      title={
                        user.adminScopes.length === 0
                          ? "No admin scopes."
                          : `Admin scopes: ${user.adminScopes.join(", ")}`
                      }
                    >
                      {user.role}
                      {user.role === "Scoped admin" ? ` · ${String(user.adminScopes.length)}` : ""}
                    </span>
                  </span>
                  <span style={{ color: "var(--text-2)" }}>{actorTypeLabel(user.actorType)}</span>
                  <span>
                    <StatusChip status={user.status} />
                  </span>
                  {/* Was a dead kebab. It now discloses the row's detail: the
                      scopes behind the role, the actor id, and the copy
                      actions — the rare half of the row, one level in. */}
                  <button
                    type="button"
                    className="icon-btn"
                    aria-label={`Details for ${user.name}`}
                    aria-expanded={isExpanded}
                    aria-controls={detailId}
                    onClick={() => setExpanded(isExpanded ? null : user.id)}
                  >
                    {isExpanded ? <Icons.ChevronDown /> : <Icons.ChevronRight />}
                  </button>
                </div>

                {isExpanded ? (
                  <div
                    id={detailId}
                    style={{
                      padding: "10px 12px 12px 40px",
                      background: "var(--surface-2)",
                      display: "grid",
                      gap: 8,
                      fontSize: "var(--text-meta)",
                    }}
                  >
                    <div className="row gap-2" style={{ alignItems: "center", flexWrap: "wrap" }}>
                      <span style={{ color: "var(--text-3)" }}>Actor ID</span>
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
                      <span style={{ color: "var(--text-3)" }}>Admin scopes </span>
                      {user.adminScopes.length === 0 ? (
                        <span style={{ color: "var(--text-2)" }}>
                          None — this account reaches no admin surface.
                        </span>
                      ) : (
                        <span className="row gap-1" style={{ flexWrap: "wrap", marginTop: 4 }}>
                          {user.adminScopes.map((scope) => (
                            <span key={scope} className="chip mono">
                              {scope}
                            </span>
                          ))}
                        </span>
                      )}
                    </div>
                    <div style={{ color: "var(--text-2)" }}>
                      Added {formatDate(user.createdAt)}
                      {user.disabledAt === null
                        ? ""
                        : ` · Suspended ${formatDate(user.disabledAt)}`}
                    </div>
                  </div>
                ) : null}
              </div>
            );
          })
        )}
      </div>

      {/* Account creation is not a rare action — it is simply absent from this
          build. Keeping it visible but disabled, with the reason beside it, is
          the honest reading; a live-looking "Invite users" button that did
          nothing was not. */}
      <details style={{ marginTop: 12 }}>
        <summary style={{ fontSize: "var(--text-meta)", cursor: "pointer" }}>
          Adding accounts (unavailable in this build)
        </summary>
        <div className="row gap-2" style={{ marginTop: 8, alignItems: "center", flexWrap: "wrap" }}>
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
            style={{ fontSize: "var(--text-caption)", color: "var(--text-3)" }}
          >
            {READ_ONLY_REASON}
          </span>
        </div>
      </details>
    </PageScroll>
  );
}
