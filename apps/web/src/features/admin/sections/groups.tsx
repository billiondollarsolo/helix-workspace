/* Admin › Directory › Groups & org units. */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Copy as CopyIcon,
  Pencil as PencilIcon,
  Plus as PlusIcon,
  Trash2 as TrashIcon,
  Users as UsersIcon,
} from "lucide-react";
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { MenuSeparator } from "@/components/ui/menu";
import { SelectableList, SelectAllCheckbox } from "@/components/ui/selectable-list";
import { notify } from "@/components/ui/toast";
import { useAdminSectionSearch, useAdminSectionTab } from "@/features/admin/admin-section-search";
import { ConfirmDestructive } from "@/features/admin/console/confirm-destructive";
import { AdminInput, AdminToolbar } from "@/features/admin/console/controls";
import { formatCount, pluralize } from "@/features/admin/console/format";
import {
  LoadingState,
  MutationError,
  PageHeading,
  QueryFailureBanner,
  useQueryFailure,
} from "@/features/admin/console/primitives";
import { AdminTabs } from "@/features/admin/console/tabs";
import { RowMenu, RowMenuItem } from "@/features/admin/console/widgets";
import {
  deleteGroup,
  groupsAdminQueryKeys,
  groupsQueryOptions,
  type Group,
} from "@/features/admin/groups-api";
import { GroupSheet } from "./group-sheet";
import { OrgUnitsPanel } from "./org-units";

const GROUP_TABS = [
  { id: "groups", label: "Groups" },
  { id: "org-units", label: "Org units" },
] as const;
const GROUP_TAB_IDS = GROUP_TABS.map((tab) => tab.id);

const KIND_LABEL: Record<Group["kind"], string> = {
  mailing_list: "Email group",
  group: "Group",
  security: "Security group",
};

function GroupsPanel({ onCreate }: { readonly onCreate: () => void }) {
  const queryClient = useQueryClient();
  const { search, patchSearch } = useAdminSectionSearch("groups");
  const groupsQuery = useQuery(groupsQueryOptions());
  const [filter, setFilter] = useState("");
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [deleting, setDeleting] = useState<readonly Group[] | null>(null);
  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: groupsAdminQueryKeys.groups() });
  };
  const failure = useQueryFailure(groupsQuery, invalidate);

  const deleteMutation = useMutation({
    mutationFn: async (groups: readonly Group[]) => {
      for (const group of groups) {
        await deleteGroup(group.id);
      }
    },
    onMutate: () => undefined,
    onError: () => undefined,
    onSuccess: (_result, groups) => {
      setSelected(new Set());
      notify({
        message:
          groups.length === 1
            ? `Deleted ${groups[0]?.name ?? "group"}`
            : `Deleted ${pluralize(groups.length, "group")}`,
      });
    },
    onSettled: () => {
      setDeleting(null);
      invalidate();
    },
  });

  const groups = groupsQuery.data ?? [];
  const needle = filter.trim().toLowerCase();
  const filtered = useMemo(
    () =>
      groups.filter(
        (group) =>
          needle.length === 0 ||
          group.name.toLowerCase().includes(needle) ||
          (group.email ?? "").toLowerCase().includes(needle),
      ),
    [groups, needle],
  );
  const selectedGroups = filtered.filter((group) => selected.has(group.id));
  const openGroup = groups.find((group) => group.id === search.group) ?? null;
  const setOpenGroup = (group: Group | null) => patchSearch({ group: group?.id });
  const memberTotal = (list: readonly Group[]) =>
    list.reduce((total, group) => total + group.memberCount, 0);

  return (
    <>
      {selectedGroups.length > 0 ? (
        <div className="admin-list-toolbar" role="toolbar" aria-label="Selected groups">
          <SelectAllCheckbox
            total={filtered.length}
            selectedCount={selectedGroups.length}
            onToggle={(all) =>
              setSelected(all ? new Set(filtered.map((group) => group.id)) : new Set())
            }
            label="Select all groups"
          />
          <span className="type-body-sm font-medium" role="status">
            {formatCount(selectedGroups.length)} selected
          </span>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => setDeleting(selectedGroups)}
          >
            <TrashIcon aria-hidden="true" /> Delete
          </Button>
        </div>
      ) : (
        <AdminToolbar label="Group filters">
          <SelectAllCheckbox
            total={filtered.length}
            selectedCount={0}
            onToggle={(all) =>
              setSelected(all ? new Set(filtered.map((group) => group.id)) : new Set())
            }
            label="Select all groups"
          />
          <AdminInput
            type="search"
            className="w-full max-w-[320px]"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            placeholder="Search by name or email"
            aria-label="Search groups"
          />
        </AdminToolbar>
      )}
      <MutationError error={deleteMutation.error} />

      {failure !== null ? (
        <QueryFailureBanner
          summary="Groups couldn't be loaded"
          subject="groups"
          error={failure.error}
          isRetrying={failure.isRetrying}
          onRetry={failure.retry}
        />
      ) : groupsQuery.isPending ? (
        <LoadingState label="Loading groups" variant="row" count={4} />
      ) : filtered.length === 0 ? (
        <EmptyState
          icon={<UsersIcon />}
          title={needle.length > 0 ? "No groups match your search" : "No groups yet"}
          body={
            needle.length > 0
              ? "Try a different name or email address."
              : "Groups share an email address and give access to many people at once."
          }
          action={
            needle.length > 0 ? undefined : (
              <Button type="button" variant="outline" onClick={onCreate}>
                <PlusIcon aria-hidden="true" /> Add group
              </Button>
            )
          }
          headingLevel={2}
          size="inline"
        />
      ) : (
        <div className="admin-list">
          <div className="admin-list-header admin-group-row" aria-hidden="true">
            <span>Name</span>
            <span>Type</span>
            <span>Members</span>
            <span />
          </div>
          <SelectableList
            items={filtered}
            getKey={(group) => group.id}
            getItemLabel={(group) => group.name}
            label="Groups"
            selectedKeys={selected}
            onSelectedKeysChange={setSelected}
            onOpen={(group) => setOpenGroup(group)}
            renderItem={(group, state) => (
              <div className="admin-group-row">
                <span className="min-w-0">
                  <span className="admin-row-title">{group.name}</span>
                  <span className="admin-row-detail">{group.email ?? "No email address"}</span>
                </span>
                <span className="admin-row-cell admin-row-detail">{KIND_LABEL[group.kind]}</span>
                <span className="admin-row-cell admin-row-detail">
                  {pluralize(group.memberCount, "member")}
                </span>
                <span className="admin-row-actions">
                  <RowMenu label={`Actions for ${group.name}`} tabIndex={state.tabIndex}>
                    <RowMenuItem
                      icon={<PencilIcon size={16} />}
                      onSelect={() => setOpenGroup(group)}
                    >
                      Edit group and members
                    </RowMenuItem>
                    {group.email === null ? null : (
                      <RowMenuItem
                        icon={<CopyIcon size={16} />}
                        onSelect={() => {
                          const email = group.email ?? "";
                          void navigator.clipboard
                            .writeText(email)
                            .then(() => notify({ message: "Email address copied" }))
                            .catch(() =>
                              notify({ message: "Couldn't copy the address", tone: "error" }),
                            );
                        }}
                      >
                        Copy email address
                      </RowMenuItem>
                    )}
                    <MenuSeparator />
                    <RowMenuItem
                      icon={<TrashIcon size={16} />}
                      destructive
                      onSelect={() => setDeleting([group])}
                    >
                      Delete group
                    </RowMenuItem>
                  </RowMenu>
                </span>
              </div>
            )}
          />
        </div>
      )}

      {openGroup === null ? null : (
        <GroupSheet group={openGroup} onClose={() => setOpenGroup(null)} />
      )}
      {deleting === null ? null : (
        <ConfirmDestructive
          open
          onOpenChange={(open) => {
            if (!open) setDeleting(null);
          }}
          title={
            deleting.length === 1
              ? `Delete ${deleting[0]?.name ?? "group"}?`
              : `Delete ${pluralize(deleting.length, "group")}?`
          }
          blastRadius={
            memberTotal(deleting) === 0
              ? undefined
              : `${pluralize(memberTotal(deleting), "membership")} will be removed, and mail to the group address stops being delivered.`
          }
          confirmLabel="Delete"
          isPending={deleteMutation.isPending}
          onConfirm={() => deleteMutation.mutate(deleting)}
        >
          Deleting removes the group and its member list. People in it keep their accounts.
        </ConfirmDestructive>
      )}
    </>
  );
}

export function AdminGroups() {
  const [tab, selectTab] = useAdminSectionTab(GROUP_TAB_IDS, "groups", "groups");
  const [creating, setCreating] = useState<"group" | "org-unit" | null>(null);
  return (
    <>
      <PageHeading
        title="Groups & org units"
        subtitle="Groups for mail and shared access, and org units for applying settings to part of your organization."
        actions={
          tab === "groups" ? (
            <Button type="button" size="sm" onClick={() => setCreating("group")}>
              <PlusIcon aria-hidden="true" /> Add group
            </Button>
          ) : (
            <Button type="button" size="sm" onClick={() => setCreating("org-unit")}>
              <PlusIcon aria-hidden="true" /> Add org unit
            </Button>
          )
        }
      />
      <AdminTabs
        label="Groups and org units"
        idPrefix="groups"
        tabs={GROUP_TABS}
        selected={tab}
        onSelect={selectTab}
      >
        {tab === "groups" ? (
          <GroupsPanel onCreate={() => setCreating("group")} />
        ) : (
          <OrgUnitsPanel
            creating={creating === "org-unit"}
            onCreatingChange={(open) => setCreating(open ? "org-unit" : null)}
          />
        )}
      </AdminTabs>
      {creating === "group" ? <GroupSheet group={null} onClose={() => setCreating(null)} /> : null}
    </>
  );
}
