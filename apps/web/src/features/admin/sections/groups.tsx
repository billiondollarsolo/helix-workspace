/* Admin › People › Groups & org units. */

import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Icons } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { ConfirmDestructive } from "@/features/admin/console/confirm-destructive";
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
  type GroupMember,
  type OrgUnit,
} from "@/features/admin/groups-api";
import {
  EmptyRow,
  EmptyState,
  INPUT_STYLE,
  PageHeading,
  PageScroll,
  QueryFailureBanner,
  StateBanner,
  useQueryFailure,
} from "@/features/admin/console/primitives";

/* ------------------------------------------------------------------ */
/* Groups & OUs                                                       */
/* ------------------------------------------------------------------ */

/** `.btn` has no disabled styling in styles.css, so a disabled create button
 *  would still look pressable. */
const DISABLED_CONTROL: React.CSSProperties = { opacity: 0.55, cursor: "not-allowed" };

interface GroupsRow {
  readonly key: string;
  readonly id: string | null;
  readonly name: string;
  readonly members: number;
  readonly children: number;
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
      children: unit.childCount,
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
    /* Groups do not nest — only org units carry children. */
    children: 0,
    type: "Group" as const,
    indent: 0,
  }));
}

/* ------------------------------------------------------------------ */
/* Deletion copy                                                      */
/* ------------------------------------------------------------------ */

/** What deleting this row actually costs, read off the row the operator
 *  clicked.
 *
 *  Deleting an org unit and deleting a group are different consequences, so
 *  they get different sentences: an org unit is the scope groups hang off, a
 *  group *is* the membership list. Every number here is the row's own reported
 *  count — never an estimate, and never a generic "this cannot be undone". */
function deletionCopy(row: GroupsRow): {
  readonly title: string;
  readonly confirmLabel: string;
  readonly body: string;
  readonly blastRadius: string | undefined;
} {
  const people = row.members === 1 ? "1 group member" : `${String(row.members)} group members`;

  if (row.type === "OU") {
    const scope =
      row.members === 0
        ? null
        : `${people} sit in groups scoped to this org unit; that scope disappears with the unit and has to be re-assigned group by group.`;
    /* The server refuses to delete an org unit that still has children, so a
       unit with any is the one case where the operator needs to know the click
       will be rejected before they make it. */
    const childNote =
      row.children === 0
        ? null
        : `It still has ${row.children === 1 ? "1 child org unit" : `${String(row.children)} child org units`} under it, and Helix refuses to delete a unit with children — re-parent or delete those first.`;
    const sentences = [scope, childNote].filter((part) => part !== null);
    return {
      title: "Delete org unit",
      confirmLabel: "Delete org unit",
      body: `Deleting the org unit ${row.name} removes the unit itself, not the groups or people under it. Anything scoped to this unit stops being scoped to anything.`,
      blastRadius: sentences.length === 0 ? undefined : sentences.join(" "),
    };
  }

  return {
    title: "Delete group",
    confirmLabel: "Delete group",
    body: `Deleting the group ${row.name} removes the group and its membership list.`,
    /* A group with no members hits nothing downstream, and the policy says to
       omit the blast radius rather than pad it with a generic warning. */
    blastRadius:
      row.members === 0
        ? undefined
        : `${people} lose this group. Rebuilding it means re-adding every one of them by actor UUID — this console has no other way to add a member.`,
  };
}

/** Membership panel for a selected group — list + add + remove members. */
function GroupMembershipPanel({ group }: { group: Group }) {
  const queryClient = useQueryClient();
  const membersQuery = useQuery(groupMembersQueryOptions(group.id));
  const [actorId, setActorId] = useState("");
  /* Snapshot of the row under the cursor: the member list refetches on its own
     and the dialog has to keep describing the member the operator picked. */
  const [removeTarget, setRemoveTarget] = useState<GroupMember | null>(null);

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

  const membersFailure = useQueryFailure(membersQuery, () => {
    void queryClient.invalidateQueries({
      queryKey: groupsAdminQueryKeys.groupMembers(group.id),
    });
  });

  return (
    <div className="panel" style={{ padding: 16, marginBottom: 12 }}>
      <div style={{ fontWeight: 600, fontSize: "var(--text-body-sm)", marginBottom: 8 }}>
        Members of {group.name}
      </div>
      {membersFailure !== null ? (
        /* Panel-level: the directory table below is still live, so this retry
           must not outrank it. */
        <QueryFailureBanner
          summary="Group members are unavailable"
          subject="group members"
          error={membersFailure.error}
          isRetrying={membersFailure.isRetrying}
          onRetry={membersFailure.retry}
        >
          Removing a member needs the list, so only adding one is possible until this loads.
        </QueryFailureBanner>
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
        membersFailure !== null ? null : (
          <EmptyRow>
            {membersQuery.isPending
              ? "Loading members…"
              : "No members in this group yet — add one by actor ID above."}
          </EmptyRow>
        )
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
            {/* Was a grey icon button that fired the DELETE on the first click,
                sitting a few pixels from the row above it. */}
            <Button
              type="button"
              size="icon-xs"
              variant="destructive"
              className="justify-self-end"
              title={`Remove member ${member.actorId}`}
              aria-label={`Remove member ${member.actorId}`}
              disabled={removeMutation.isPending}
              onClick={() => setRemoveTarget(member)}
            >
              <Icons.Trash />
            </Button>
          </div>
        ))
      )}

      {/* Nominally reversible, actually not: re-adding a member means typing
          their raw actor UUID, and the removed row is the only place this
          console ever shows it. So it clears the policy's confirm tier — one
          object, named, with the identifier still on screen to copy.

          No blast radius: it touches one membership, and this console does not
          know what the group grants, so any "they lose access" line would be
          the generic warning the policy rules out. */}
      {removeTarget === null ? null : (
        <ConfirmDestructive
          open
          onOpenChange={(next) => {
            if (!next) {
              setRemoveTarget(null);
            }
          }}
          title="Remove group member"
          confirmLabel="Remove member"
          isPending={removeMutation.isPending}
          onConfirm={() =>
            removeMutation.mutate(removeTarget.actorId, {
              /* Settle, not success: a failure is reported by the banner behind
                 this overlay, and holding the dialog open would cover it. */
              onSettled: () => setRemoveTarget(null),
            })
          }
        >
          Removing actor <code>{removeTarget.actorId}</code> from {group.name} takes their{" "}
          {removeTarget.role} role with it. Adding them back means typing that actor ID again — copy
          it now, because this console shows it nowhere else once the row is gone.
        </ConfirmDestructive>
      )}
    </div>
  );
}

export function AdminGroups() {
  const queryClient = useQueryClient();
  const orgUnitsQuery = useQuery(orgUnitsQueryOptions());
  const groupsQuery = useQuery(groupsQueryOptions());
  const [showOuForm, setShowOuForm] = useState(false);
  const [showGroupForm, setShowGroupForm] = useState(false);
  const [ouName, setOuName] = useState("");
  const [groupName, setGroupName] = useState("");
  const [managedGroupId, setManagedGroupId] = useState<string | null>(null);
  /* Snapshot of the row under the cursor, not just its id: the directory
     refetches on its own and the dialog has to keep describing what was
     picked, counts included. */
  const [deleteTarget, setDeleteTarget] = useState<{
    readonly row: GroupsRow;
    readonly id: string;
  } | null>(null);

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
  const deleteCopy = deleteTarget === null ? null : deletionCopy(deleteTarget.row);

  const orgUnitsFailure = useQueryFailure(orgUnitsQuery, invalidateOrgUnits);
  const groupsFailure = useQueryFailure(groupsQuery, invalidateGroups);

  /* Both halves of the directory come from one service, so they usually fail
     together. Two copies of the same banner read as two incidents; one
     page-level state says it once. The org-unit error stands in for both —
     one service explains them. */
  const directoryFailure =
    orgUnitsFailure !== null && groupsFailure !== null ? orgUnitsFailure : null;
  const retryDirectory = () => {
    orgUnitsFailure?.retry();
    groupsFailure?.retry();
  };

  /* Creating into a list you cannot see gives no feedback that it worked, so
     the create controls follow the query that would show the result. */
  const createOuDisabled = orgUnitsFailure !== null;
  const createGroupDisabled = groupsFailure !== null;

  return (
    <PageScroll>
      <PageHeading
        title="Groups & Organizational Units"
        actions={
          <>
            <button
              type="button"
              className="btn"
              disabled={createGroupDisabled}
              style={createGroupDisabled ? DISABLED_CONTROL : undefined}
              onClick={() => setShowGroupForm((open) => !open)}
            >
              <Icons.Plus /> New group
            </button>
            <button
              type="button"
              className="btn primary"
              disabled={createOuDisabled}
              style={createOuDisabled ? DISABLED_CONTROL : undefined}
              onClick={() => setShowOuForm((open) => !open)}
            >
              <Icons.Plus /> New OU
            </button>
          </>
        }
      />

      {directoryFailure !== null ? (
        <QueryFailureBanner
          summary="Groups and organizational units are unavailable"
          subject="groups and org units"
          error={directoryFailure.error}
          isRetrying={orgUnitsQuery.isFetching || groupsQuery.isFetching}
          onRetry={retryDirectory}
          /* Nothing else is on the page when both halves are gone. */
          retryVariant="default"
        >
          New group and New OU are disabled until the directory loads — creating into a list this
          console cannot read would give you no way to confirm it worked.
        </QueryFailureBanner>
      ) : (
        <>
          {orgUnitsFailure !== null ? (
            <QueryFailureBanner
              summary="Organizational units are unavailable"
              subject="org units"
              error={orgUnitsFailure.error}
              isRetrying={orgUnitsFailure.isRetrying}
              onRetry={orgUnitsFailure.retry}
            >
              Groups below are current; only org units are missing, and New OU stays disabled until
              they load.
            </QueryFailureBanner>
          ) : null}
          {groupsFailure !== null ? (
            <QueryFailureBanner
              summary="Groups are unavailable"
              subject="groups"
              error={groupsFailure.error}
              isRetrying={groupsFailure.isRetrying}
              onRetry={groupsFailure.retry}
            >
              Organizational units below are current; only groups are missing, and New group stays
              disabled until they load.
            </QueryFailureBanner>
          ) : null}
          {orgUnitsFailure === null &&
          groupsFailure === null &&
          (orgUnitsQuery.isPending || groupsQuery.isPending) ? (
            <StateBanner kind="loading">Loading groups & organizational units…</StateBanner>
          ) : null}
        </>
      )}
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

      {showOuForm && !createOuDisabled ? (
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
      {showGroupForm && !createGroupDisabled ? (
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
          <button type="submit" className="btn primary" disabled={createGroupMutation.isPending}>
            {createGroupMutation.isPending ? "Creating…" : "Create group"}
          </button>
        </form>
      ) : null}

      {managedGroup !== null ? <GroupMembershipPanel group={managedGroup} /> : null}

      {rows.length === 0 ? (
        /* "None yet" is only true once both halves actually loaded — claiming
           it while a query is failing or in flight invents an empty directory. */
        orgUnitsQuery.isSuccess && groupsQuery.isSuccess ? (
          <EmptyState icon={<Icons.Building />} title="No org units or groups yet">
            Org units mirror your reporting structure and scope policies to a slice of the
            directory. Groups are membership lists you can grant access with. Create either to start
            assigning them.
          </EmptyState>
        ) : null
      ) : (
        <div className="panel">
          {rows.map((row, index) => {
            /* Narrowed outside the callbacks below: `row.id` is nullable and
               TypeScript drops property narrowing inside a closure. */
            const rowId = row.id;
            return (
              <div
                key={row.key}
                style={{
                  display: "grid",
                  /* 170px, not 140px: "Delete" now says what it does instead
                     of being a bare glyph, and the two controls no longer
                     fit in the old track. */
                  gridTemplateColumns: "1fr 100px 100px 170px",
                  padding: "0 16px",
                  height: 38,
                  alignItems: "center",
                  fontSize: "var(--text-meta)",
                  borderBottom: index < rows.length - 1 ? "1px solid var(--border)" : "none",
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
                  {row.type === "Group" && rowId !== null ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      aria-label={`Manage ${row.name}`}
                      onClick={() =>
                        setManagedGroupId((current) => (current === rowId ? null : rowId))
                      }
                    >
                      Manage
                    </Button>
                  ) : null}
                  {rowId !== null ? (
                    /* Was a bare trash glyph in the same grey as "Manage",
                       one click from an irreversible DELETE. */
                    <Button
                      type="button"
                      size="sm"
                      variant="destructive"
                      aria-label={`Delete ${row.name}`}
                      disabled={deleteOuMutation.isPending || deleteGroupMutation.isPending}
                      onClick={() => setDeleteTarget({ row, id: rowId })}
                    >
                      <Icons.Trash /> Delete
                    </Button>
                  ) : null}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Irreversible and it takes other things with it, so it is the policy's
          blast-radius tier — but not the typed-phrase tier: recreating an org
          unit or a group is a form on this page, not a support ticket. */}
      {deleteTarget === null || deleteCopy === null ? null : (
        <ConfirmDestructive
          open
          onOpenChange={(next) => {
            if (!next) {
              setDeleteTarget(null);
            }
          }}
          title={deleteCopy.title}
          blastRadius={deleteCopy.blastRadius}
          confirmLabel={deleteCopy.confirmLabel}
          isPending={deleteOuMutation.isPending || deleteGroupMutation.isPending}
          onConfirm={() => {
            /* Settle, not success: the failure banners live on the page behind
               this overlay, so the dialog must get out of their way either
               way. */
            const settle = { onSettled: () => setDeleteTarget(null) };
            if (deleteTarget.row.type === "OU") {
              deleteOuMutation.mutate(deleteTarget.id, settle);
            } else {
              deleteGroupMutation.mutate(deleteTarget.id, settle);
            }
          }}
        >
          {deleteCopy.body}
        </ConfirmDestructive>
      )}
    </PageScroll>
  );
}
