/* Org units: the organization's structure, used to apply settings to part of
 * it. Shown as an indented tree with a row ⋮ menu. */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Building as BuildingIcon, Plus as PlusIcon, Trash2 as TrashIcon } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/helix-dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { notify } from "@/components/ui/toast";
import { ConfirmDestructive } from "@/features/admin/console/confirm-destructive";
import { AdminField, AdminInput, AdminSelect } from "@/features/admin/console/controls";
import { pluralize } from "@/features/admin/console/format";
import {
  ErrorNotice,
  LoadingState,
  MutationError,
  QueryFailureBanner,
  useQueryFailure,
} from "@/features/admin/console/primitives";
import { AdminTable, type AdminColumn } from "@/features/admin/console/table";
import { RowMenu, RowMenuItem } from "@/features/admin/console/widgets";
import {
  createOrgUnit,
  deleteOrgUnit,
  groupsAdminQueryKeys,
  orgUnitsQueryOptions,
  type OrgUnit,
} from "@/features/admin/groups-api";

const INDENT_CLASS = ["pl-0", "pl-5", "pl-10", "pl-14", "pl-18"] as const;

function depthOf(unit: OrgUnit): number {
  return Math.max(0, unit.path.split(" > ").length - 1);
}

function CreateOrgUnitDialog({
  units,
  onClose,
}: {
  readonly units: readonly OrgUnit[];
  readonly onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [parentId, setParentId] = useState("");
  const mutation = useMutation({
    mutationFn: () =>
      createOrgUnit({ name: name.trim(), ...(parentId === "" ? {} : { parentId }) }),
    onMutate: () => undefined,
    onError: () => undefined,
    onSuccess: (unit) => {
      notify({ message: `Created ${unit.name}` });
      void queryClient.invalidateQueries({ queryKey: groupsAdminQueryKeys.orgUnits() });
      onClose();
    },
  });
  return (
    <Dialog
      modal={false}
      title="Create org unit"
      onClose={onClose}
      footer={
        <>
          <Button type="button" variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="submit"
            form="create-org-unit-form"
            disabled={name.trim().length === 0 || mutation.isPending}
          >
            {mutation.isPending ? "Creating…" : "Create"}
          </Button>
        </>
      }
    >
      <form
        id="create-org-unit-form"
        className="grid gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (name.trim().length > 0) mutation.mutate();
        }}
      >
        <AdminField label="Name">
          <AdminInput
            required
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Engineering"
          />
        </AdminField>
        <AdminField label="Parent org unit">
          <AdminSelect value={parentId} onChange={(event) => setParentId(event.target.value)}>
            <option value="">None (top level)</option>
            {units.map((unit) => (
              <option key={unit.id} value={unit.id}>
                {unit.path}
              </option>
            ))}
          </AdminSelect>
        </AdminField>
        {mutation.error === null ? null : <ErrorNotice>{mutation.error.message}</ErrorNotice>}
      </form>
    </Dialog>
  );
}

export function OrgUnitsPanel({
  creating,
  onCreatingChange,
}: {
  readonly creating: boolean;
  readonly onCreatingChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const unitsQuery = useQuery(orgUnitsQueryOptions());
  const [deleting, setDeleting] = useState<OrgUnit | null>(null);
  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: groupsAdminQueryKeys.orgUnits() });
  };
  const failure = useQueryFailure(unitsQuery, invalidate);
  const deleteMutation = useMutation({
    mutationFn: (unit: OrgUnit) => deleteOrgUnit(unit.id),
    onMutate: () => undefined,
    onError: () => undefined,
    onSuccess: (_result, unit) => notify({ message: `Deleted ${unit.name}` }),
    onSettled: () => {
      setDeleting(null);
      invalidate();
    },
  });
  const units = [...(unitsQuery.data ?? [])].sort((a, b) => a.path.localeCompare(b.path));

  const columns: readonly AdminColumn<OrgUnit>[] = [
    {
      id: "name",
      header: "Name",
      sortValue: (unit) => unit.name,
      cell: (unit) => (
        <span
          className={`flex items-center gap-2 ${INDENT_CLASS[Math.min(depthOf(unit), INDENT_CLASS.length - 1)] ?? "pl-0"}`}
        >
          <BuildingIcon size={16} aria-hidden="true" />
          <span className="font-medium">{unit.name}</span>
        </span>
      ),
    },
    {
      id: "members",
      header: "Members",
      sortValue: (unit) => unit.memberCount,
      width: "140px",
      cell: (unit) => pluralize(unit.memberCount, "member"),
    },
    {
      id: "children",
      header: "Sub-units",
      sortValue: (unit) => unit.childCount,
      width: "140px",
      cell: (unit) => (unit.childCount === 0 ? "None" : pluralize(unit.childCount, "sub-unit")),
    },
    {
      id: "actions",
      header: "Actions",
      headerHidden: true,
      align: "right",
      width: "56px",
      cell: (unit) => (
        <RowMenu label={`Actions for ${unit.name}`}>
          <RowMenuItem
            icon={<TrashIcon size={16} />}
            destructive
            disabled={unit.childCount > 0}
            onSelect={() => setDeleting(unit)}
          >
            {unit.childCount > 0 ? "Delete (remove sub-units first)" : "Delete org unit"}
          </RowMenuItem>
        </RowMenu>
      ),
    },
  ];

  return (
    <>
      <MutationError error={deleteMutation.error} />
      {failure !== null ? (
        <QueryFailureBanner
          summary="Org units couldn't be loaded"
          subject="org units"
          error={failure.error}
          isRetrying={failure.isRetrying}
          onRetry={failure.retry}
        />
      ) : unitsQuery.isPending ? (
        <LoadingState label="Loading org units" variant="row" count={4} />
      ) : units.length === 0 ? (
        <EmptyState
          icon={<BuildingIcon />}
          title="No org units yet"
          body="Org units mirror your organization's structure, so settings can apply to one team."
          action={
            <Button type="button" variant="outline" onClick={() => onCreatingChange(true)}>
              <PlusIcon aria-hidden="true" /> Add org unit
            </Button>
          }
          headingLevel={2}
          size="inline"
        />
      ) : (
        <AdminTable
          label="Org units"
          columns={columns}
          rows={units}
          rowKey={(unit) => unit.id}
          searchText={(unit) => `${unit.name} ${unit.path}`}
        />
      )}
      {creating ? (
        <CreateOrgUnitDialog units={units} onClose={() => onCreatingChange(false)} />
      ) : null}
      {deleting === null ? null : (
        <ConfirmDestructive
          open
          onOpenChange={(open) => {
            if (!open) setDeleting(null);
          }}
          title={`Delete ${deleting.name}?`}
          blastRadius={
            deleting.memberCount === 0
              ? undefined
              : `Settings scoped to this org unit stop applying to its ${pluralize(deleting.memberCount, "member")}.`
          }
          confirmLabel="Delete"
          isPending={deleteMutation.isPending}
          onConfirm={() => deleteMutation.mutate(deleting)}
        >
          Deleting removes the org unit. Groups and people in it are not deleted.
        </ConfirmDestructive>
      )}
    </>
  );
}
