/* Helix Admin console — directory, roles, policies, OUs, billing, audit,
 * app permissions. Recreated as production TSX from the design handoff
 * (`app-admin.jsx`).
 *
 * Data: the **Users** section is wired to the real `adminUsersQueryOptions`
 * API via TanStack Query — live rows are projected onto the design's
 * user-table shape, enriched from `USERS_DATA` for fields the API does not
 * expose (department / MFA / last-active). Every other section renders typed
 * seed data from `admin-console-data.ts` until a backing endpoint exists.
 */

import { useMemo, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Icons } from "@/components/icons";
import { Avatar } from "@/components/ui/avatar";
import { SurfaceFrame } from "@/components/shell";
import {
  adminUsersQueryOptions,
  type AdminUser,
} from "@/features/admin/admin-users";
import { MailAdminSection } from "@/features/admin/mail-admin";
import { AdminServicesOverview } from "@/features/admin/admin-services";
import { AppPasswordsManagement } from "@/features/admin/app-passwords-management";
import { AgentCredentialsManagement } from "@/features/admin/agent-credentials-management";
import { AICostLimitsManagement } from "@/features/admin/ai-cost-limits-management";
import { AIObservabilityDashboard } from "@/features/admin/ai-observability";
import { CoreAppsManagement } from "@/features/admin/core-apps-management";
import { AuditLogList } from "@/features/admin/audit-log";
import { WebhookManagement } from "@/features/webhooks/webhook-management";
import {
  addGroupMember,
  createGroup,
  createOrgUnit,
  deleteGroup,
  deleteOrgUnit,
  groupMembersQueryOptions,
  groupsAdminQueryKeys,
  groupsQueryOptions,
  orgUnitsQueryOptions,
  removeGroupMember,
  type Group,
  type OrgUnit,
} from "@/features/admin/groups-api";
import {
  securityPoliciesQueryKeys,
  securityPoliciesQueryOptions,
  securityPolicyGroup,
  securityPolicyLabels,
  updateSecurityPolicy,
  type PolicyEnforcement,
  type SecurityPolicy,
  type SecurityPolicyType,
} from "@/features/admin/security-policies-api";
import {
  defaultOAuthAppsInput,
  oauthAppsQueryKeys,
  oauthAppsQueryOptions,
  revokeOAuthApp,
  setOAuthAppStatus,
  type OAuthApp,
  type OAuthAppRisk,
  type OAuthAppStatus,
  type OAuthAppsQueryInput,
} from "@/features/admin/oauth-apps-api";
import {
  billingAccountQueryOptions,
  formatBytes,
  formatMoney,
  invoicesQueryOptions,
} from "@/features/admin/billing-api";
import {
  createDomain,
  deleteDomain,
  domainsQueryKeys,
  domainsQueryOptions,
  setPrimaryDomain,
  upsertDnsRecord,
  verifyDnsRecord,
  type DnsRecordType,
  type DomainWithRecords,
} from "@/features/admin/domains-api";
import {
  ADMIN_NAV,
  type AdminSectionId,
  type DirectoryUser,
  type UserStatus,
} from "@/features/admin/admin-console-data";

/* ------------------------------------------------------------------ */
/* Shared state helpers (wired sections)                              */
/* ------------------------------------------------------------------ */

const INPUT_STYLE: React.CSSProperties = {
  height: 30,
  borderRadius: 6,
  border: "1px solid var(--border)",
  background: "var(--surface)",
  color: "var(--text)",
  padding: "0 8px",
  fontSize: "var(--text-meta)",
};

function StateBanner({
  kind,
  children,
}: {
  kind: "loading" | "error" | "info";
  children: ReactNode;
}) {
  return (
    <div
      role={kind === "error" ? "alert" : "status"}
      style={{
        padding: "10px 12px",
        borderRadius: 6,
        fontSize: "var(--text-meta)",
        marginBottom: 12,
        background:
          kind === "error" ? "var(--danger-soft, var(--surface-2))" : "var(--surface-2)",
        color: kind === "error" ? "var(--danger)" : "var(--text-2)",
        border: "1px solid var(--border)",
      }}
    >
      {children}
    </div>
  );
}

function EmptyRow({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        padding: 32,
        textAlign: "center",
        fontSize: "var(--text-body-sm)",
        color: "var(--text-3)",
      }}
    >
      {children}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Sidebar                                                            */
/* ------------------------------------------------------------------ */

interface AdminSidebarProps {
  readonly section: AdminSectionId;
  readonly onSection: (section: AdminSectionId) => void;
}

function AdminSidebar({ section, onSection }: AdminSidebarProps) {
  return (
    <aside
      style={{
        width: 220,
        flexShrink: 0,
        borderRight: "1px solid var(--border)",
        background: "var(--surface)",
        padding: 12,
        overflowY: "auto",
      }}
    >
      <div className="section-label" style={{ padding: "4px 8px 8px" }}>
        Administration
      </div>
      {ADMIN_NAV.map((nav) => {
        const Icon = Icons[nav.icon];
        const active = section === nav.id;
        return (
          <button
            key={nav.id}
            type="button"
            onClick={() => onSection(nav.id)}
            aria-current={active ? "page" : undefined}
            style={{
              width: "100%",
              display: "flex",
              alignItems: "center",
              gap: 10,
              height: "var(--rd-list-row-h)",
              padding: "0 10px",
              borderRadius: 6,
              fontSize: "var(--rd-row-fs)",
              background: active ? "var(--accent-soft)" : "transparent",
              color: active ? "var(--accent)" : "var(--text)",
              fontWeight: active ? 600 : 400,
            }}
          >
            <Icon />
            <span>{nav.label}</span>
          </button>
        );
      })}
    </aside>
  );
}

/* ------------------------------------------------------------------ */
/* Shared bits                                                        */
/* ------------------------------------------------------------------ */

function PageScroll({ children }: { children: ReactNode }) {
  return (
    <div style={{ padding: 24, overflowY: "auto", flex: 1 }}>{children}</div>
  );
}

function PageHeading({
  title,
  subtitle,
  actions,
  meta,
}: {
  title: string;
  subtitle?: string;
  actions?: ReactNode;
  meta?: ReactNode;
}) {
  return (
    <div style={{ marginBottom: subtitle ? 20 : 16 }}>
      <div style={{ display: "flex", alignItems: "center" }}>
        <h1 style={{ fontSize: "var(--text-h2)", fontWeight: 600, margin: 0 }}>{title}</h1>
        {meta}
        {actions ? (
          <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
            {actions}
          </div>
        ) : null}
      </div>
      {subtitle ? (
        <div
          style={{ fontSize: "var(--text-body-sm)", color: "var(--text-3)", marginTop: 4 }}
        >
          {subtitle}
        </div>
      ) : null}
    </div>
  );
}

const HEADER_CELL: React.CSSProperties = {
  fontSize: "var(--text-caption)",
  color: "var(--text-3)",
  fontWeight: 600,
  textTransform: "uppercase",
  letterSpacing: ".06em",
};

/* ------------------------------------------------------------------ */
/* Overview                                                           */
/* ------------------------------------------------------------------ */

function AdminOverview() {
  return (
    <PageScroll>
      <PageHeading title="Workspace overview" />
      <div
        className="panel"
        style={{
          padding: 32,
          textAlign: "center",
          color: "var(--text-3)",
          fontSize: "var(--text-body-sm)",
          lineHeight: 1.6,
        }}
      >
        <div style={{ fontSize: "var(--text-body)", fontWeight: 600, color: "var(--text-2)", marginBottom: 6 }}>
          Telemetry not yet wired
        </div>
        <div>
          Sign-in activity, recent admin events, and security recommendations
          will appear here once the workspace-overview telemetry endpoints are
          implemented. Use the sidebar to manage users, groups, security
          policies, services, and other live admin surfaces.
        </div>
      </div>
    </PageScroll>
  );
}

/* ------------------------------------------------------------------ */
/* Users                                                              */
/* ------------------------------------------------------------------ */

const USERS_GRID = "28px 1fr 100px 130px 90px 60px 110px 32px";

type StatusFilter = "all" | UserStatus;
type RoleFilter = "all" | "Admin" | "Member";

/** Project the real admin user API shape onto the directory row.
 *  Fields the API doesn't expose (dept enrichment, MFA, last-active) render
 *  as "—" rather than fabricated values. */
function projectAdminUser(user: AdminUser): DirectoryUser {
  return {
    name: user.displayName || user.email || "Unknown user",
    email: user.email ?? "—",
    role: user.scopes.includes("admin") ? "Admin" : "Member",
    dept: user.type,
    status: user.disabledAt ? "suspended" : "active",
    mfa: false,
    lastActive: "—",
  };
}

function StatusChip({ status }: { status: UserStatus }) {
  const variant =
    status === "active"
      ? "success"
      : status === "invited"
        ? "warning"
        : "danger";
  return (
    <span className={`chip ${variant}`}>
      <span className="chip-dot" />
      {status}
    </span>
  );
}

function AdminUsers() {
  const [query, setQuery] = useState("");
  const [roleFilter, setRoleFilter] = useState<RoleFilter>("all");
  const [deptFilter, setDeptFilter] = useState<string>("all");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());

  const usersQuery = useQuery(adminUsersQueryOptions({ includeDisabled: true }));

  const directory = useMemo<readonly DirectoryUser[]>(
    () => (usersQuery.data?.users ?? []).map(projectAdminUser),
    [usersQuery.data],
  );

  const departments = useMemo(
    () => [...new Set(directory.map((user) => user.dept))].sort(),
    [directory],
  );

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return directory.filter((user) => {
      if (
        needle &&
        !user.name.toLowerCase().includes(needle) &&
        !user.email.toLowerCase().includes(needle)
      ) {
        return false;
      }
      if (roleFilter !== "all" && user.role !== roleFilter) {
        return false;
      }
      if (deptFilter !== "all" && user.dept !== deptFilter) {
        return false;
      }
      if (statusFilter !== "all" && user.status !== statusFilter) {
        return false;
      }
      return true;
    });
  }, [directory, query, roleFilter, deptFilter, statusFilter]);

  const allSelected = filtered.length > 0 && selected.size === filtered.length;

  const toggleAll = () => {
    setSelected(
      allSelected ? new Set() : new Set(filtered.map((user) => user.email)),
    );
  };

  const toggleOne = (email: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(email)) {
        next.delete(email);
      } else {
        next.add(email);
      }
      return next;
    });
  };

  const selectStyle: React.CSSProperties = {
    height: 30,
    borderRadius: 6,
    border: "1px solid var(--border)",
    background: "var(--surface)",
    color: "var(--text)",
    padding: "0 8px",
    fontSize: "var(--text-meta)",
  };

  return (
    <PageScroll>
      <PageHeading
        title="Users"
        meta={
          <span
            style={{ marginLeft: 8, fontSize: "var(--text-meta)", color: "var(--text-3)" }}
          >
            {filtered.length} user{filtered.length === 1 ? "" : "s"}
          </span>
        }
        actions={
          <>
            <button type="button" className="btn">
              <Icons.Upload /> Import CSV
            </button>
            <button type="button" className="btn primary">
              <Icons.Plus /> Invite users
            </button>
          </>
        }
      />

      <div
        style={{
          display: "flex",
          gap: 8,
          marginBottom: 12,
          alignItems: "center",
        }}
      >
        <div className="search" style={{ maxWidth: 300, height: 30 }}>
          <Icons.Search />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Filter users…"
            aria-label="Filter users"
          />
        </div>
        <select
          aria-label="Filter by role"
          value={roleFilter}
          onChange={(event) =>
            setRoleFilter(event.target.value as RoleFilter)
          }
          style={selectStyle}
        >
          <option value="all">All roles</option>
          <option value="Admin">Admin</option>
          <option value="Member">Member</option>
        </select>
        <select
          aria-label="Filter by department"
          value={deptFilter}
          onChange={(event) => setDeptFilter(event.target.value)}
          style={selectStyle}
        >
          <option value="all">All departments</option>
          {departments.map((dept) => (
            <option key={dept} value={dept}>
              {dept}
            </option>
          ))}
        </select>
        <select
          aria-label="Filter by status"
          value={statusFilter}
          onChange={(event) =>
            setStatusFilter(event.target.value as StatusFilter)
          }
          style={selectStyle}
        >
          <option value="all">All statuses</option>
          <option value="active">Active</option>
          <option value="invited">Invited</option>
          <option value="suspended">Suspended</option>
        </select>
        {selected.size > 0 ? (
          <div
            style={{
              marginLeft: "auto",
              display: "flex",
              gap: 6,
              alignItems: "center",
            }}
          >
            <span style={{ fontSize: "var(--text-meta)" }}>{selected.size} selected</span>
            <button type="button" className="btn sm">
              Change role
            </button>
            <button type="button" className="btn sm">
              Suspend
            </button>
          </div>
        ) : null}
      </div>

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
            onChange={toggleAll}
            style={{ accentColor: "var(--accent)" }}
          />
          <span>User</span>
          <span>Role</span>
          <span>Department</span>
          <span>Status</span>
          <span>MFA</span>
          <span>Last active</span>
          <span />
        </div>

        {filtered.length === 0 ? (
          <div
            style={{
              padding: 32,
              textAlign: "center",
              fontSize: "var(--text-body-sm)",
              color: "var(--text-3)",
            }}
          >
            No users match the current filters.
          </div>
        ) : (
          filtered.map((user) => {
            const isSelected = selected.has(user.email);
            return (
              <div
                key={user.email}
                style={{
                  display: "grid",
                  gridTemplateColumns: USERS_GRID,
                  padding: "0 12px",
                  height: "var(--rd-list-row-h)",
                  alignItems: "center",
                  fontSize: "var(--rd-row-fs)",
                  borderBottom: "1px solid var(--border)",
                  background: isSelected ? "var(--accent-soft)" : undefined,
                }}
              >
                <input
                  type="checkbox"
                  aria-label={`Select ${user.name}`}
                  checked={isSelected}
                  onChange={() => toggleOne(user.email)}
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
                      {user.email}
                    </div>
                  </div>
                </div>
                <span>
                  {user.role === "Admin" ? (
                    <span className="chip accent">{user.role}</span>
                  ) : (
                    user.role
                  )}
                </span>
                <span style={{ color: "var(--text-2)" }}>{user.dept}</span>
                <span>
                  <StatusChip status={user.status} />
                </span>
                <span>
                  {user.mfa ? (
                    <span style={{ color: "var(--success)" }}>
                      <Icons.Check />
                    </span>
                  ) : (
                    <span style={{ color: "var(--danger)" }}>
                      <Icons.X />
                    </span>
                  )}
                </span>
                <span style={{ color: "var(--text-2)" }}>
                  {user.lastActive}
                </span>
                <button
                  type="button"
                  className="icon-btn"
                  aria-label={`Actions for ${user.name}`}
                >
                  <Icons.MoreV />
                </button>
              </div>
            );
          })
        )}
      </div>
    </PageScroll>
  );
}

/* ------------------------------------------------------------------ */
/* Groups & OUs                                                       */
/* ------------------------------------------------------------------ */

interface GroupsRow {
  readonly key: string;
  readonly id: string | null;
  readonly name: string;
  readonly members: number;
  readonly type: "OU" | "Group";
  readonly indent: number;
}

/** Order OU records depth-first by their materialized `path` so children
 *  render under their parent with a tree indent. */
function projectOrgUnitRows(units: readonly OrgUnit[]): readonly GroupsRow[] {
  return [...units]
    .sort((a, b) => a.path.localeCompare(b.path))
    .map((unit) => ({
      key: `ou:${unit.id}`,
      id: unit.id,
      name: unit.name,
      members: unit.memberCount,
      type: "OU" as const,
      indent: Math.max(0, unit.path.split(" > ").length - 1),
    }));
}

function projectGroupRows(groups: readonly Group[]): readonly GroupsRow[] {
  return groups.map((group) => ({
    key: `g:${group.id}`,
    id: group.id,
    name: group.email ?? group.name,
    members: group.memberCount,
    type: "Group" as const,
    indent: 0,
  }));
}

/** Membership panel for a selected group — list + add + remove members. */
function GroupMembershipPanel({ group }: { group: Group }) {
  const queryClient = useQueryClient();
  const membersQuery = useQuery(groupMembersQueryOptions(group.id));
  const [actorId, setActorId] = useState("");

  const invalidate = () => {
    void queryClient.invalidateQueries({
      queryKey: groupsAdminQueryKeys.groupMembers(group.id),
    });
    void queryClient.invalidateQueries({ queryKey: groupsAdminQueryKeys.groups() });
  };

  const addMutation = useMutation({
    mutationFn: (id: string) => addGroupMember(group.id, { actorId: id }),
    onMutate: () => undefined,
    onError: () => undefined,
    onSuccess: () => {
      setActorId("");
      invalidate();
    },
  });
  const removeMutation = useMutation({
    mutationFn: (id: string) => removeGroupMember(group.id, id),
    onMutate: () => undefined,
    onError: () => undefined,
    onSuccess: () => invalidate(),
  });

  const members = membersQuery.data ?? [];

  return (
    <div className="panel" style={{ padding: 16, marginBottom: 12 }}>
      <div style={{ fontWeight: 600, fontSize: "var(--text-body-sm)", marginBottom: 8 }}>
        Members of {group.name}
      </div>
      {membersQuery.isError ? (
        <StateBanner kind="error">Unable to load group members.</StateBanner>
      ) : null}
      {addMutation.isError ? (
        <StateBanner kind="error">{addMutation.error.message}</StateBanner>
      ) : null}
      {removeMutation.isError ? (
        <StateBanner kind="error">{removeMutation.error.message}</StateBanner>
      ) : null}
      <form
        style={{ display: "flex", gap: 8, marginBottom: 8 }}
        onSubmit={(event) => {
          event.preventDefault();
          if (actorId.trim().length === 0) {
            return;
          }
          addMutation.mutate(actorId.trim());
        }}
      >
        <input
          aria-label="Member actor id"
          value={actorId}
          onChange={(event) => setActorId(event.target.value)}
          placeholder="Actor UUID"
          style={{ ...INPUT_STYLE, flex: 1 }}
        />
        <button type="submit" className="btn sm primary" disabled={addMutation.isPending}>
          <Icons.Plus /> Add member
        </button>
      </form>
      {members.length === 0 ? (
        <div style={{ fontSize: "var(--text-meta)", color: "var(--text-3)", padding: "4px 0" }}>
          {membersQuery.isPending ? "Loading members…" : "No members in this group."}
        </div>
      ) : (
        members.map((member) => (
          <div
            key={member.id}
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 90px 90px",
              alignItems: "center",
              height: 32,
              fontSize: "var(--text-meta)",
              borderTop: "1px solid var(--border)",
            }}
          >
            <span className="mono truncate" style={{ fontSize: "var(--text-caption)" }}>
              {member.actorId}
            </span>
            <span>
              <span className="chip">{member.role}</span>
            </span>
            <button
              type="button"
              className="btn sm"
              style={{ justifySelf: "flex-end" }}
              aria-label={`Remove member ${member.actorId}`}
              disabled={removeMutation.isPending}
              onClick={() => removeMutation.mutate(member.actorId)}
            >
              <Icons.Trash />
            </button>
          </div>
        ))
      )}
    </div>
  );
}

function AdminGroups() {
  const queryClient = useQueryClient();
  const orgUnitsQuery = useQuery(orgUnitsQueryOptions());
  const groupsQuery = useQuery(groupsQueryOptions());
  const [showOuForm, setShowOuForm] = useState(false);
  const [showGroupForm, setShowGroupForm] = useState(false);
  const [ouName, setOuName] = useState("");
  const [groupName, setGroupName] = useState("");
  const [managedGroupId, setManagedGroupId] = useState<string | null>(null);

  const invalidateOrgUnits = () =>
    void queryClient.invalidateQueries({ queryKey: groupsAdminQueryKeys.orgUnits() });
  const invalidateGroups = () =>
    void queryClient.invalidateQueries({ queryKey: groupsAdminQueryKeys.groups() });

  const createOuMutation = useMutation({
    mutationFn: (name: string) => createOrgUnit({ name }),
    onMutate: () => undefined,
    onError: () => undefined,
    onSuccess: () => {
      setOuName("");
      setShowOuForm(false);
      invalidateOrgUnits();
    },
  });
  const deleteOuMutation = useMutation({
    mutationFn: (id: string) => deleteOrgUnit(id),
    onMutate: () => undefined,
    onError: () => undefined,
    onSuccess: () => invalidateOrgUnits(),
  });
  const createGroupMutation = useMutation({
    mutationFn: (name: string) => createGroup({ name }),
    onMutate: () => undefined,
    onError: () => undefined,
    onSuccess: () => {
      setGroupName("");
      setShowGroupForm(false);
      invalidateGroups();
    },
  });
  const deleteGroupMutation = useMutation({
    mutationFn: (id: string) => deleteGroup(id),
    onMutate: () => undefined,
    onError: () => undefined,
    onSuccess: () => invalidateGroups(),
  });

  const apiUnits = orgUnitsQuery.data ?? [];
  const apiGroups = groupsQuery.data ?? [];

  const rows = useMemo<readonly GroupsRow[]>(
    () => [...projectOrgUnitRows(apiUnits), ...projectGroupRows(apiGroups)],
    [apiUnits, apiGroups],
  );

  const managedGroup = apiGroups.find((group) => group.id === managedGroupId) ?? null;

  return (
    <PageScroll>
      <PageHeading
        title="Groups & Organizational Units"
        actions={
          <>
            <button
              type="button"
              className="btn"
              onClick={() => setShowGroupForm((open) => !open)}
            >
              <Icons.Plus /> New group
            </button>
            <button
              type="button"
              className="btn primary"
              onClick={() => setShowOuForm((open) => !open)}
            >
              <Icons.Plus /> New OU
            </button>
          </>
        }
      />

      {orgUnitsQuery.isPending || groupsQuery.isPending ? (
        <StateBanner kind="loading">Loading groups & organizational units…</StateBanner>
      ) : null}
      {orgUnitsQuery.isError || groupsQuery.isError ? (
        <StateBanner kind="error">
          Groups & organizational units unavailable — try again later.
        </StateBanner>
      ) : null}
      {createOuMutation.isError ? (
        <StateBanner kind="error">{createOuMutation.error.message}</StateBanner>
      ) : null}
      {createGroupMutation.isError ? (
        <StateBanner kind="error">{createGroupMutation.error.message}</StateBanner>
      ) : null}
      {deleteOuMutation.isError ? (
        <StateBanner kind="error">{deleteOuMutation.error.message}</StateBanner>
      ) : null}
      {deleteGroupMutation.isError ? (
        <StateBanner kind="error">{deleteGroupMutation.error.message}</StateBanner>
      ) : null}

      {showOuForm ? (
        <form
          className="panel"
          style={{ padding: 12, marginBottom: 12, display: "flex", gap: 8 }}
          onSubmit={(event) => {
            event.preventDefault();
            if (ouName.trim().length === 0) {
              return;
            }
            createOuMutation.mutate(ouName.trim());
          }}
        >
          <input
            aria-label="New org unit name"
            value={ouName}
            onChange={(event) => setOuName(event.target.value)}
            placeholder="Engineering"
            style={{ ...INPUT_STYLE, flex: 1 }}
          />
          <button type="submit" className="btn primary" disabled={createOuMutation.isPending}>
            {createOuMutation.isPending ? "Creating…" : "Create OU"}
          </button>
        </form>
      ) : null}
      {showGroupForm ? (
        <form
          className="panel"
          style={{ padding: 12, marginBottom: 12, display: "flex", gap: 8 }}
          onSubmit={(event) => {
            event.preventDefault();
            if (groupName.trim().length === 0) {
              return;
            }
            createGroupMutation.mutate(groupName.trim());
          }}
        >
          <input
            aria-label="New group name"
            value={groupName}
            onChange={(event) => setGroupName(event.target.value)}
            placeholder="leads"
            style={{ ...INPUT_STYLE, flex: 1 }}
          />
          <button
            type="submit"
            className="btn primary"
            disabled={createGroupMutation.isPending}
          >
            {createGroupMutation.isPending ? "Creating…" : "Create group"}
          </button>
        </form>
      ) : null}

      {managedGroup !== null ? <GroupMembershipPanel group={managedGroup} /> : null}

      <div className="panel">
        {rows.length === 0 ? (
          <EmptyRow>No organizational units or groups yet.</EmptyRow>
        ) : (
          rows.map((row, index) => (
            <div
              key={row.key}
              style={{
                display: "grid",
                gridTemplateColumns: "1fr 100px 100px 140px",
                padding: "0 16px",
                height: 38,
                alignItems: "center",
                fontSize: "var(--text-meta)",
                borderBottom:
                  index < rows.length - 1 ? "1px solid var(--border)" : "none",
              }}
            >
              <div className="row gap-2" style={{ paddingLeft: row.indent * 20 }}>
                {row.type === "OU" ? <Icons.Building /> : <Icons.Users />}
                <span style={{ fontWeight: 500 }}>{row.name}</span>
              </div>
              <span className="chip" style={{ width: "fit-content" }}>
                {row.type}
              </span>
              <span style={{ color: "var(--text-2)" }}>{row.members} members</span>
              <div style={{ display: "flex", gap: 6, justifySelf: "flex-end" }}>
                {row.type === "Group" && row.id !== null ? (
                  <button
                    type="button"
                    className="btn sm"
                    aria-label={`Manage ${row.name}`}
                    onClick={() =>
                      setManagedGroupId((current) =>
                        current === row.id ? null : row.id,
                      )
                    }
                  >
                    Manage
                  </button>
                ) : null}
                {row.id !== null ? (
                  <button
                    type="button"
                    className="btn sm"
                    aria-label={`Delete ${row.name}`}
                    disabled={deleteOuMutation.isPending || deleteGroupMutation.isPending}
                    onClick={() => {
                      if (row.type === "OU") {
                        deleteOuMutation.mutate(row.id ?? "");
                      } else {
                        deleteGroupMutation.mutate(row.id ?? "");
                      }
                    }}
                  >
                    <Icons.Trash />
                  </button>
                ) : null}
              </div>
            </div>
          ))
        )}
      </div>
    </PageScroll>
  );
}

/* ------------------------------------------------------------------ */
/* Security                                                           */
/* ------------------------------------------------------------------ */

/** Map a policy's enforcement to the design's level-chip text + on/off color. */
function policyLevel(policy: SecurityPolicy): { text: string; on: boolean } {
  if (!policy.enabled) {
    return { text: "Off", on: false };
  }
  if (policy.enforcement === "required") {
    return { text: "Required", on: true };
  }
  if (policy.enforcement === "optional") {
    return { text: "Active", on: true };
  }
  return { text: "Limited", on: false };
}

/** Render a policy's settings blob as a compact descriptive line. */
function policySettingsSummary(policy: SecurityPolicy): string {
  const settings = policy.settings;
  const get = (key: string): unknown => settings[key];
  switch (policy.policyType) {
    case "mfa": {
      const methods = get("allowedMethods");
      return Array.isArray(methods) ? `Methods: ${methods.join(", ")}` : "";
    }
    case "sso": {
      const provider = get("provider");
      return typeof provider === "string" ? `Provider: ${provider}` : "";
    }
    case "session": {
      const days = get("inactivityTimeoutDays");
      return typeof days === "number" ? `${String(days)}-day inactivity timeout` : "";
    }
    case "external_sharing": {
      const mode = get("mode");
      return typeof mode === "string" ? `Sharing mode: ${mode}` : "";
    }
    case "dlp": {
      const detectors = get("detectors");
      return Array.isArray(detectors) ? `Detectors: ${detectors.join(", ")}` : "";
    }
    case "device_trust": {
      const apps = get("protectedApps");
      return Array.isArray(apps) && apps.length > 0
        ? `Protected: ${apps.join(", ")}`
        : "No protected apps";
    }
    default:
      return "";
  }
}

interface PolicyEditFormProps {
  readonly policy: SecurityPolicy;
  readonly pending: boolean;
  readonly onCancel: () => void;
  readonly onSubmit: (input: {
    enabled: boolean;
    enforcement: PolicyEnforcement;
  }) => void;
}

function PolicyEditForm({ policy, pending, onCancel, onSubmit }: PolicyEditFormProps) {
  const [enabled, setEnabled] = useState(policy.enabled);
  const [enforcement, setEnforcement] = useState<PolicyEnforcement>(policy.enforcement);

  return (
    <form
      style={{ marginTop: 12, display: "grid", gap: 10 }}
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit({ enabled, enforcement });
      }}
    >
      <label
        className="row gap-2"
        style={{ fontSize: "var(--text-meta)", color: "var(--text-2)" }}
      >
        <input
          type="checkbox"
          aria-label={`Enable ${securityPolicyLabels[policy.policyType]}`}
          checked={enabled}
          onChange={(event) => setEnabled(event.target.checked)}
          style={{ accentColor: "var(--accent)" }}
        />
        Policy enabled
      </label>
      <label style={{ fontSize: "var(--text-caption)", color: "var(--text-3)" }}>
        Enforcement
        <select
          aria-label={`Enforcement for ${securityPolicyLabels[policy.policyType]}`}
          value={enforcement}
          onChange={(event) =>
            setEnforcement(event.target.value as PolicyEnforcement)
          }
          style={{ ...INPUT_STYLE, width: "100%", marginTop: 4 }}
        >
          <option value="disabled">Disabled</option>
          <option value="optional">Optional</option>
          <option value="required">Required</option>
        </select>
      </label>
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
        <button type="button" className="btn sm" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className="btn sm primary" disabled={pending}>
          {pending ? "Saving…" : "Save policy"}
        </button>
      </div>
    </form>
  );
}

function AdminSecurity() {
  const queryClient = useQueryClient();
  const policiesQuery = useQuery(securityPoliciesQueryOptions());
  const [editing, setEditing] = useState<SecurityPolicyType | null>(null);

  const updateMutation = useMutation({
    mutationFn: (input: {
      policyType: SecurityPolicyType;
      enabled: boolean;
      enforcement: PolicyEnforcement;
    }) =>
      updateSecurityPolicy(input.policyType, {
        enabled: input.enabled,
        enforcement: input.enforcement,
      }),
    onMutate: () => undefined,
    onError: () => undefined,
    onSuccess: () => {
      setEditing(null);
      void queryClient.invalidateQueries({
        queryKey: securityPoliciesQueryKeys.list(),
      });
    },
  });

  const policies = policiesQuery.data ?? [];

  const grouped = useMemo(() => {
    const sections: Record<"Authentication" | "Access & data", SecurityPolicy[]> = {
      Authentication: [],
      "Access & data": [],
    };
    for (const policy of policies) {
      sections[securityPolicyGroup[policy.policyType]].push(policy);
    }
    return sections;
  }, [policies]);

  return (
    <PageScroll>
      <PageHeading
        title="Security policies"
        subtitle="Authentication, access, and data protection across the workspace"
      />

      {policiesQuery.isPending ? (
        <StateBanner kind="loading">Loading security policies…</StateBanner>
      ) : null}
      {policiesQuery.isError ? (
        <StateBanner kind="error">
          Security policies unavailable — try again later.
        </StateBanner>
      ) : null}
      {updateMutation.isError ? (
        <StateBanner kind="error">{updateMutation.error.message}</StateBanner>
      ) : null}

      {policiesQuery.isError ? null : (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
          {(["Authentication", "Access & data"] as const).map((label) => (
            <div key={label}>
              <div className="section-label" style={{ padding: "0 0 8px" }}>
                {label}
              </div>
              {grouped[label].map((policy) => {
                const level = policyLevel(policy);
                const isEditing = editing === policy.policyType;
                return (
                  <div
                    key={policy.policyType}
                    className="panel"
                    style={{ padding: 16, marginBottom: 12 }}
                  >
                    <div
                      style={{
                        display: "flex",
                        alignItems: "flex-start",
                        gap: 12,
                      }}
                    >
                      <div style={{ flex: 1 }}>
                        <div
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: 8,
                            marginBottom: 4,
                          }}
                        >
                          <span style={{ fontSize: "var(--text-body)", fontWeight: 600 }}>
                            {securityPolicyLabels[policy.policyType]}
                          </span>
                          <span
                            className={`chip ${level.on ? "success" : "warning"}`}
                          >
                            <span className="chip-dot" />
                            {level.text}
                          </span>
                        </div>
                        <div
                          className="row gap-2"
                          style={{ fontSize: "var(--text-meta)", color: "var(--text-2)" }}
                        >
                          <Icons.Key /> {policySettingsSummary(policy)}
                        </div>
                      </div>
                      <button
                        type="button"
                        className="btn sm"
                        aria-label={`Edit ${securityPolicyLabels[policy.policyType]}`}
                        onClick={() =>
                          setEditing((current) =>
                            current === policy.policyType ? null : policy.policyType,
                          )
                        }
                      >
                        {isEditing ? "Close" : "Edit"}
                      </button>
                    </div>
                    {isEditing ? (
                      <PolicyEditForm
                        policy={policy}
                        pending={updateMutation.isPending}
                        onCancel={() => setEditing(null)}
                        onSubmit={(input) =>
                          updateMutation.mutate({
                            policyType: policy.policyType,
                            ...input,
                          })
                        }
                      />
                    ) : null}
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      )}
    </PageScroll>
  );
}

/* ------------------------------------------------------------------ */
/* Apps                                                               */
/* ------------------------------------------------------------------ */

const APPS_GRID = "1fr 1.4fr 70px 90px 100px 180px";

function riskVariant(risk: OAuthAppRisk): string {
  return risk === "high" ? "danger" : risk === "medium" ? "warning" : "success";
}

function statusVariant(status: OAuthAppStatus): string {
  if (status === "approved") {
    return "success";
  }
  if (status === "blocked" || status === "revoked") {
    return "danger";
  }
  return "warning";
}

interface AppsRow {
  readonly id: string | null;
  readonly name: string;
  readonly scope: string;
  readonly users: number;
  readonly risk: OAuthAppRisk;
  readonly status: OAuthAppStatus;
}

function AdminApps() {
  const queryClient = useQueryClient();
  const [statusFilter, setStatusFilter] = useState<"all" | OAuthAppStatus>("all");
  const [riskFilter, setRiskFilter] = useState<"all" | OAuthAppRisk>("all");
  const [query, setQuery] = useState("");

  const queryInput = useMemo<OAuthAppsQueryInput>(
    () => ({
      limit: defaultOAuthAppsInput.limit,
      ...(statusFilter === "all" ? {} : { status: statusFilter }),
      ...(riskFilter === "all" ? {} : { risk: riskFilter }),
      ...(query.trim().length === 0 ? {} : { query: query.trim() }),
    }),
    [statusFilter, riskFilter, query],
  );
  const appsQuery = useQuery(oauthAppsQueryOptions(queryInput));

  const invalidate = () =>
    void queryClient.invalidateQueries({ queryKey: oauthAppsQueryKeys.all() });

  const statusMutation = useMutation({
    mutationFn: (input: { id: string; status: "approved" | "pending" | "blocked" }) =>
      setOAuthAppStatus(input.id, input.status),
    onMutate: () => undefined,
    onError: () => undefined,
    onSuccess: () => invalidate(),
  });
  const revokeMutation = useMutation({
    mutationFn: (id: string) => revokeOAuthApp(id),
    onMutate: () => undefined,
    onError: () => undefined,
    onSuccess: () => invalidate(),
  });

  const rows = useMemo<readonly AppsRow[]>(
    () =>
      (appsQuery.data?.apps ?? []).map((app: OAuthApp) => ({
        id: app.id,
        name: app.name,
        scope: app.scopeSummary || app.scopes.join(", ") || "—",
        users: app.userCount,
        risk: app.risk,
        status: app.status,
      })),
    [appsQuery.data],
  );

  const mutating = statusMutation.isPending || revokeMutation.isPending;

  return (
    <PageScroll>
      <PageHeading
        title="App permissions"
        subtitle="Third-party apps that have OAuth access to Helix Workspace data"
      />

      <div style={{ display: "flex", gap: 8, marginBottom: 12, alignItems: "center" }}>
        <div className="search" style={{ maxWidth: 280, height: 30 }}>
          <Icons.Search />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Filter apps…"
            aria-label="Filter apps"
          />
        </div>
        <select
          aria-label="Filter by status"
          value={statusFilter}
          onChange={(event) =>
            setStatusFilter(event.target.value as "all" | OAuthAppStatus)
          }
          style={INPUT_STYLE}
        >
          <option value="all">All statuses</option>
          <option value="approved">Approved</option>
          <option value="pending">Pending</option>
          <option value="blocked">Blocked</option>
          <option value="revoked">Revoked</option>
        </select>
        <select
          aria-label="Filter by risk"
          value={riskFilter}
          onChange={(event) =>
            setRiskFilter(event.target.value as "all" | OAuthAppRisk)
          }
          style={INPUT_STYLE}
        >
          <option value="all">All risk levels</option>
          <option value="low">Low</option>
          <option value="medium">Medium</option>
          <option value="high">High</option>
        </select>
      </div>

      {appsQuery.isPending ? (
        <StateBanner kind="loading">Loading OAuth apps…</StateBanner>
      ) : null}
      {appsQuery.isError ? (
        <StateBanner kind="error">OAuth apps unavailable — try again later.</StateBanner>
      ) : null}
      {statusMutation.isError ? (
        <StateBanner kind="error">{statusMutation.error.message}</StateBanner>
      ) : null}
      {revokeMutation.isError ? (
        <StateBanner kind="error">{revokeMutation.error.message}</StateBanner>
      ) : null}

      <div className="panel">
        <div
          style={{
            display: "grid",
            gridTemplateColumns: APPS_GRID,
            padding: "0 16px",
            height: 32,
            alignItems: "center",
            borderBottom: "1px solid var(--border)",
            background: "var(--surface-2)",
            ...HEADER_CELL,
          }}
        >
          <span>App</span>
          <span>Requested scope</span>
          <span>Users</span>
          <span>Risk</span>
          <span>Status</span>
          <span />
        </div>
        {rows.length === 0 ? (
          <EmptyRow>
            {appsQuery.isPending ? "Loading apps…" : "No OAuth apps match the filters."}
          </EmptyRow>
        ) : (
          rows.map((app, index) => (
            <div
              key={app.id ?? app.name}
              style={{
                display: "grid",
                gridTemplateColumns: APPS_GRID,
                padding: "0 16px",
                height: 40,
                alignItems: "center",
                fontSize: "var(--text-meta)",
                borderBottom:
                  index < rows.length - 1 ? "1px solid var(--border)" : "none",
              }}
            >
              <div className="row gap-2">
                <div
                  style={{
                    width: 24,
                    height: 24,
                    borderRadius: 5,
                    background: "var(--surface-2)",
                    border: "1px solid var(--border)",
                    display: "grid",
                    placeItems: "center",
                    fontSize: "var(--text-caption)",
                    fontWeight: 600,
                  }}
                >
                  {app.name[0]}
                </div>
                <span style={{ fontWeight: 500 }}>{app.name}</span>
              </div>
              <span className="truncate" style={{ color: "var(--text-2)" }}>
                {app.scope}
              </span>
              <span>{app.users}</span>
              <span>
                <span className={`chip ${riskVariant(app.risk)}`}>
                  <span className="chip-dot" />
                  {app.risk}
                </span>
              </span>
              <span>
                <span className={`chip ${statusVariant(app.status)}`}>{app.status}</span>
              </span>
              <div style={{ display: "flex", gap: 6, justifySelf: "flex-end" }}>
                {app.id !== null && app.status !== "revoked" ? (
                  <>
                    {app.status !== "approved" ? (
                      <button
                        type="button"
                        className="btn sm"
                        aria-label={`Approve ${app.name}`}
                        disabled={mutating}
                        onClick={() =>
                          statusMutation.mutate({ id: app.id ?? "", status: "approved" })
                        }
                      >
                        Approve
                      </button>
                    ) : null}
                    {app.status !== "blocked" ? (
                      <button
                        type="button"
                        className="btn sm"
                        aria-label={`Block ${app.name}`}
                        disabled={mutating}
                        onClick={() =>
                          statusMutation.mutate({ id: app.id ?? "", status: "blocked" })
                        }
                      >
                        Block
                      </button>
                    ) : null}
                    <button
                      type="button"
                      className="btn sm"
                      aria-label={`Revoke ${app.name}`}
                      disabled={mutating}
                      onClick={() => revokeMutation.mutate(app.id ?? "")}
                    >
                      Revoke
                    </button>
                  </>
                ) : null}
              </div>
            </div>
          ))
        )}
      </div>
    </PageScroll>
  );
}

/* ------------------------------------------------------------------ */
/* Billing                                                            */
/* ------------------------------------------------------------------ */

const INVOICE_GRID = "160px 1fr 140px 90px 70px";

const METER_LABEL: Record<"licenses" | "storage" | "ai_credits", string> = {
  licenses: "Licenses used",
  storage: "Storage",
  ai_credits: "AI credits",
};

function formatDateLabel(value: string | null): string {
  if (value === null) {
    return "—";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return new Intl.DateTimeFormat("en-US", { dateStyle: "medium" }).format(date);
}

function AdminBilling() {
  const accountQuery = useQuery(billingAccountQueryOptions());
  const invoicesQuery = useQuery(invoicesQueryOptions());

  const view = accountQuery.data;
  const invoices = invoicesQuery.data?.invoices ?? [];

  return (
    <PageScroll>
      <PageHeading title="Billing & licenses" subtitle="" />

      {accountQuery.isPending ? (
        <StateBanner kind="loading">Loading billing account…</StateBanner>
      ) : null}
      {accountQuery.isError ? (
        <StateBanner kind="error">
          Billing account unavailable — try again later.
        </StateBanner>
      ) : null}

      {view ? (
        <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr", gap: 16 }}>
          <div className="panel" style={{ padding: 20 }}>
            <div style={{ display: "flex", alignItems: "center", marginBottom: 12 }}>
              <span className="chip accent">Current plan</span>
            </div>
            <div style={{ fontSize: "var(--text-h1)", fontWeight: 700, letterSpacing: "-0.02em" }}>
              {view.account.planName}
            </div>
            <div style={{ fontSize: "var(--text-body-sm)", color: "var(--text-2)", marginBottom: 16 }}>
              {`${formatMoney(view.account.pricePerSeatCents, view.account.currency)} per user / month · billed ${view.account.billingCycle}`}
            </div>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(3, 1fr)",
                gap: 12,
              }}
            >
              {view.meters.map((meter) => {
                const valueText =
                  meter.id === "storage"
                    ? `${formatBytes(meter.used)} / ${formatBytes(meter.limit)}`
                    : `${new Intl.NumberFormat("en-US").format(meter.used)} / ${new Intl.NumberFormat("en-US").format(meter.limit)}`;
                return (
                  <div key={meter.id}>
                    <div style={{ fontSize: "var(--text-caption)", color: "var(--text-3)" }}>
                      {METER_LABEL[meter.id]}
                    </div>
                    <div style={{ fontWeight: 600, marginTop: 2 }}>{valueText}</div>
                    <div
                      style={{
                        height: 4,
                        background: "var(--surface-2)",
                        borderRadius: 2,
                        marginTop: 6,
                      }}
                    >
                      <div
                        style={{
                          height: "100%",
                          width: `${String(meter.fraction * 100)}%`,
                          background: "var(--accent)",
                          borderRadius: 2,
                        }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          <div className="panel" style={{ padding: 20 }}>
            <div style={{ ...HEADER_CELL, marginBottom: 4 }}>Next invoice</div>
            <div style={{ fontSize: "var(--text-h1)", fontWeight: 700 }}>
              {formatMoney(view.account.nextInvoiceCents, view.account.currency)}
            </div>
            <div style={{ fontSize: "var(--text-meta)", color: "var(--text-2)", marginBottom: 16 }}>
              {formatDateLabel(view.account.nextInvoiceAt)}
            </div>
            <button
              type="button"
              className="btn"
              style={{ width: "100%", marginBottom: 8 }}
            >
              <Icons.Credit /> Update payment method
            </button>
            <button type="button" className="btn" style={{ width: "100%" }}>
              <Icons.Download /> Download invoices
            </button>
          </div>
        </div>
      ) : null}

      <div className="panel" style={{ padding: 16, marginTop: 16 }}>
        <div style={{ display: "flex", alignItems: "center", marginBottom: 12 }}>
          <span style={{ fontWeight: 600, fontSize: "var(--text-body-sm)" }}>Recent invoices</span>
        </div>
        {invoicesQuery.isError ? (
          <StateBanner kind="error">
            Invoices unavailable — try again later.
          </StateBanner>
        ) : invoicesQuery.isPending ? (
          <EmptyRow>Loading invoices…</EmptyRow>
        ) : invoices.length === 0 ? (
          <EmptyRow>No invoices yet.</EmptyRow>
        ) : (
          invoices.map((invoice, index) => (
            <div
              key={invoice.id}
              style={{
                display: "grid",
                gridTemplateColumns: INVOICE_GRID,
                alignItems: "center",
                height: 32,
                fontSize: "var(--text-meta)",
                borderTop: index ? "1px solid var(--border)" : "none",
              }}
            >
              <span className="mono">{invoice.invoiceNumber}</span>
              <span style={{ color: "var(--text-2)" }}>
                {formatDateLabel(invoice.issuedAt)}
              </span>
              <span>{formatMoney(invoice.amountCents, invoice.currency)}</span>
              <span>
                <span
                  className={`chip ${invoice.status === "paid" ? "success" : "warning"}`}
                >
                  <span className="chip-dot" />
                  {invoice.status}
                </span>
              </span>
              <button
                type="button"
                className="btn sm"
                style={{ justifySelf: "flex-end" }}
              >
                PDF
              </button>
            </div>
          ))
        )}
      </div>
    </PageScroll>
  );
}

/* ------------------------------------------------------------------ */
/* Audit log                                                          */
/* ------------------------------------------------------------------ */


/* ------------------------------------------------------------------ */
/* Domain                                                             */
/* ------------------------------------------------------------------ */

const DOMAIN_GRID = "70px 180px 1fr 100px 90px";
const DNS_RECORD_TYPES_UI: readonly DnsRecordType[] = [
  "MX",
  "SPF",
  "DKIM",
  "DMARC",
  "TXT",
  "CNAME",
  "A",
];

function verificationVariant(status: "verified" | "pending" | "failed"): string {
  return status === "verified" ? "success" : status === "pending" ? "warning" : "danger";
}

/** DNS records table + add-record form + per-record verify for one domain. */
function DomainDnsPanel({ entry }: { entry: DomainWithRecords }) {
  const queryClient = useQueryClient();
  const [recordType, setRecordType] = useState<DnsRecordType>("MX");
  const [host, setHost] = useState("");
  const [expectedValue, setExpectedValue] = useState("");

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: domainsQueryKeys.domains() });
    void queryClient.invalidateQueries({
      queryKey: domainsQueryKeys.dnsRecords(entry.domain.id),
    });
  };

  const upsertMutation = useMutation({
    mutationFn: (input: { recordType: DnsRecordType; host: string; expectedValue: string }) =>
      upsertDnsRecord(entry.domain.id, input),
    onMutate: () => undefined,
    onError: () => undefined,
    onSuccess: () => {
      setHost("");
      setExpectedValue("");
      invalidate();
    },
  });
  const verifyMutation = useMutation({
    mutationFn: (recordId: string) => verifyDnsRecord(entry.domain.id, recordId),
    onMutate: () => undefined,
    onError: () => undefined,
    onSuccess: () => invalidate(),
  });

  return (
    <div className="panel" style={{ overflow: "hidden", marginBottom: 16 }}>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: DOMAIN_GRID,
          padding: "0 16px",
          height: 32,
          alignItems: "center",
          borderBottom: "1px solid var(--border)",
          background: "var(--surface-2)",
          ...HEADER_CELL,
        }}
      >
        <span>Type</span>
        <span>Host</span>
        <span>Value</span>
        <span>Status</span>
        <span />
      </div>

      {upsertMutation.isError ? (
        <div style={{ padding: "8px 16px" }}>
          <StateBanner kind="error">{upsertMutation.error.message}</StateBanner>
        </div>
      ) : null}
      {verifyMutation.isError ? (
        <div style={{ padding: "8px 16px" }}>
          <StateBanner kind="error">{verifyMutation.error.message}</StateBanner>
        </div>
      ) : null}

      {entry.dnsRecords.length === 0 ? (
        <EmptyRow>No DNS records for this domain yet.</EmptyRow>
      ) : (
        entry.dnsRecords.map((record) => (
          <div
            key={record.id}
            style={{
              display: "grid",
              gridTemplateColumns: DOMAIN_GRID,
              padding: "0 16px",
              height: 38,
              alignItems: "center",
              fontSize: "var(--text-meta)",
              borderBottom: "1px solid var(--border)",
            }}
          >
            <span style={{ fontWeight: 600 }}>{record.recordType}</span>
            <span className="mono" style={{ fontSize: "var(--text-caption)" }}>
              {record.host}
            </span>
            <span
              className="mono truncate"
              style={{ fontSize: "var(--text-caption)", color: "var(--text-2)" }}
            >
              {record.expectedValue}
            </span>
            <span>
              <span className={`chip ${verificationVariant(record.status)}`}>
                <span className="chip-dot" />
                {record.status}
              </span>
            </span>
            <button
              type="button"
              className="btn sm"
              style={{ justifySelf: "flex-end" }}
              aria-label={`Verify ${record.recordType} ${record.host}`}
              disabled={verifyMutation.isPending}
              onClick={() => verifyMutation.mutate(record.id)}
            >
              Verify
            </button>
          </div>
        ))
      )}

      <form
        style={{
          display: "grid",
          gridTemplateColumns: "70px 180px 1fr 90px",
          gap: 8,
          padding: "10px 16px",
          alignItems: "center",
        }}
        onSubmit={(event) => {
          event.preventDefault();
          if (host.trim().length === 0 || expectedValue.trim().length === 0) {
            return;
          }
          upsertMutation.mutate({
            recordType,
            host: host.trim(),
            expectedValue: expectedValue.trim(),
          });
        }}
      >
        <select
          aria-label="DNS record type"
          value={recordType}
          onChange={(event) => setRecordType(event.target.value as DnsRecordType)}
          style={INPUT_STYLE}
        >
          {DNS_RECORD_TYPES_UI.map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </select>
        <input
          aria-label="DNS record host"
          value={host}
          onChange={(event) => setHost(event.target.value)}
          placeholder="helix.io"
          style={INPUT_STYLE}
        />
        <input
          aria-label="DNS record value"
          value={expectedValue}
          onChange={(event) => setExpectedValue(event.target.value)}
          placeholder="10 mx1.helix.io"
          style={INPUT_STYLE}
        />
        <button type="submit" className="btn sm primary" disabled={upsertMutation.isPending}>
          <Icons.Plus /> Record
        </button>
      </form>
    </div>
  );
}

function AdminDomain() {
  const queryClient = useQueryClient();
  const domainsQuery = useQuery(domainsQueryOptions());
  const [newDomain, setNewDomain] = useState("");

  const invalidate = () =>
    void queryClient.invalidateQueries({ queryKey: domainsQueryKeys.domains() });

  const addMutation = useMutation({
    mutationFn: (domain: string) => createDomain({ domain }),
    onMutate: () => undefined,
    onError: () => undefined,
    onSuccess: () => {
      setNewDomain("");
      invalidate();
    },
  });
  const primaryMutation = useMutation({
    mutationFn: (id: string) => setPrimaryDomain(id),
    onMutate: () => undefined,
    onError: () => undefined,
    onSuccess: () => invalidate(),
  });
  const deleteMutation = useMutation({
    mutationFn: (id: string) => deleteDomain(id),
    onMutate: () => undefined,
    onError: () => undefined,
    onSuccess: () => invalidate(),
  });

  const domains = domainsQuery.data ?? [];

  return (
    <PageScroll>
      <PageHeading title="Domain" subtitle="Domains and DNS records for the workspace" />

      {domainsQuery.isPending ? (
        <StateBanner kind="loading">Loading domains…</StateBanner>
      ) : null}
      {domainsQuery.isError ? (
        <StateBanner kind="error">Domains unavailable — try again later.</StateBanner>
      ) : null}
      {addMutation.isError ? (
        <StateBanner kind="error">{addMutation.error.message}</StateBanner>
      ) : null}
      {primaryMutation.isError ? (
        <StateBanner kind="error">{primaryMutation.error.message}</StateBanner>
      ) : null}
      {deleteMutation.isError ? (
        <StateBanner kind="error">{deleteMutation.error.message}</StateBanner>
      ) : null}

      {domainsQuery.isError ? null : (
        <>
          <form
            className="panel"
            style={{ padding: 12, marginBottom: 16, display: "flex", gap: 8 }}
            onSubmit={(event) => {
              event.preventDefault();
              if (newDomain.trim().length === 0) {
                return;
              }
              addMutation.mutate(newDomain.trim());
            }}
          >
            <input
              aria-label="New domain"
              value={newDomain}
              onChange={(event) => setNewDomain(event.target.value)}
              placeholder="helix.io"
              style={{ ...INPUT_STYLE, flex: 1 }}
            />
            <button type="submit" className="btn primary" disabled={addMutation.isPending}>
              <Icons.Plus /> Add domain
            </button>
          </form>

          {domains.length === 0 ? (
            <div className="panel">
              <EmptyRow>
                {domainsQuery.isPending
                  ? "Loading domains…"
                  : "No domains registered yet."}
              </EmptyRow>
            </div>
          ) : (
            domains.map((entry) => (
              <div key={entry.domain.id}>
                <div
                  className="panel"
                  style={{
                    padding: 16,
                    marginBottom: 12,
                    display: "flex",
                    alignItems: "center",
                    gap: 12,
                  }}
                >
                  <span style={{ color: "var(--text-3)" }}>
                    <Icons.Globe />
                  </span>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: "var(--text-body)", fontWeight: 600 }}>
                      {entry.domain.domain}
                    </div>
                    <div style={{ fontSize: "var(--text-meta)", color: "var(--text-2)" }}>
                      {entry.domain.isPrimary ? "Primary domain" : "Secondary domain"}
                    </div>
                  </div>
                  <span
                    className={`chip ${verificationVariant(entry.domain.verificationStatus)}`}
                  >
                    <span className="chip-dot" />
                    {entry.domain.verificationStatus}
                  </span>
                  {!entry.domain.isPrimary ? (
                    <button
                      type="button"
                      className="btn sm"
                      aria-label={`Make ${entry.domain.domain} primary`}
                      disabled={primaryMutation.isPending}
                      onClick={() => primaryMutation.mutate(entry.domain.id)}
                    >
                      Make primary
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className="btn sm"
                    aria-label={`Remove ${entry.domain.domain}`}
                    disabled={deleteMutation.isPending}
                    onClick={() => deleteMutation.mutate(entry.domain.id)}
                  >
                    <Icons.Trash />
                  </button>
                </div>
                <DomainDnsPanel entry={entry} />
              </div>
            ))
          )}
        </>
      )}
    </PageScroll>
  );
}

/* ------------------------------------------------------------------ */
/* Console                                                            */
/* ------------------------------------------------------------------ */

/** Wrap a section component in the standard PageScroll container so it picks
 * up the admin console's flex sizing and scroll behavior. Used for orphan
 * live components that render their own internal padding but no outer scroll. */
function withPageScroll(Component: () => ReactNode): () => ReactNode {
  return function ScrolledSection() {
    return <PageScroll>{Component()}</PageScroll>;
  };
}

const SECTION_CONTENT: Record<AdminSectionId, () => ReactNode> = {
  overview: AdminOverview,
  users: AdminUsers,
  groups: AdminGroups,
  security: AdminSecurity,
  apps: AdminApps,
  "core-apps": withPageScroll(CoreAppsManagement),
  services: withPageScroll(AdminServicesOverview),
  "app-passwords": withPageScroll(AppPasswordsManagement),
  agents: withPageScroll(AgentCredentialsManagement),
  "ai-costs": withPageScroll(AICostLimitsManagement),
  "ai-observability": withPageScroll(AIObservabilityDashboard),
  billing: AdminBilling,
  audit: withPageScroll(AuditLogList),
  domain: AdminDomain,
  mail: MailAdminSection,
  webhooks: withPageScroll(WebhookManagement),
};

export function AdminConsole() {
  const [section, setSection] = useState<AdminSectionId>("overview");
  const Section = SECTION_CONTENT[section];

  return (
    <SurfaceFrame
      title="Admin"
      icon={<Icons.Shield />}
      searchPlaceholder="Search users, policies, audit log"
    >
      <AdminSidebar section={section} onSection={setSection} />
      <Section />
    </SurfaceFrame>
  );
}
