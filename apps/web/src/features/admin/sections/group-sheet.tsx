/* One group in a side sheet: its settings and its members. Members are added
 * with the people picker and removed with an Undo snackbar. */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { X as XIcon } from "lucide-react";
import { useMemo, useState } from "react";
import { PeoplePicker } from "@/components/people/people-picker";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { SideSheet } from "@/components/ui/side-sheet";
import { notify } from "@/components/ui/toast";
import type { PersonRef } from "@/features/people/person-ref";
import { adminUsersQueryOptions } from "@/features/admin/admin-users";
import {
  addGroupMember,
  createGroup,
  groupMembersQueryOptions,
  groupsAdminQueryKeys,
  removeGroupMember,
  updateGroup,
  type Group,
  type GroupMember,
} from "@/features/admin/groups-api";
import {
  LoadingState,
  MutationError,
  QueryFailureBanner,
  useQueryFailure,
} from "@/features/admin/console/primitives";
import { GroupMailForm } from "./group-mail-form";

/* Members carry only an actor id; names come from the directory. 250 is the
   endpoint's page ceiling. */
const DIRECTORY_LOOKUP = { includeDisabled: true, limit: 250 } as const;

const ROLE_LABEL: Record<GroupMember["role"], string> = {
  member: "Member",
  manager: "Manager",
  owner: "Owner",
};

function GroupMembers({ group }: { readonly group: Group }) {
  const queryClient = useQueryClient();
  const membersQuery = useQuery(groupMembersQueryOptions(group.id));
  const directoryQuery = useQuery(adminUsersQueryOptions(DIRECTORY_LOOKUP));
  const [picked, setPicked] = useState<PersonRef[]>([]);
  const names = useMemo(
    () => new Map((directoryQuery.data?.users ?? []).map((user) => [user.id, user])),
    [directoryQuery.data],
  );

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: groupsAdminQueryKeys.groupMembers(group.id) });
    void queryClient.invalidateQueries({ queryKey: groupsAdminQueryKeys.groups() });
  };
  const failure = useQueryFailure(membersQuery, invalidate);

  const addMutation = useMutation({
    mutationFn: async (people: readonly PersonRef[]) => {
      for (const person of people) {
        if (person.actorId !== null) {
          await addGroupMember(group.id, { actorId: person.actorId });
        }
      }
    },
    onError: () => undefined,
    onMutate: () => undefined,
    onSuccess: (_result, people) => {
      setPicked([]);
      notify({
        message:
          people.length === 1
            ? `Added ${people[0]?.displayName ?? "1 person"}`
            : `Added ${String(people.length)} people`,
      });
    },
    onSettled: invalidate,
  });
  const removeMutation = useMutation({
    mutationFn: (member: GroupMember) => removeGroupMember(group.id, member.actorId),
    onError: () => undefined,
    onMutate: () => undefined,
    onSuccess: (_result, member) => {
      const name = names.get(member.actorId)?.displayName ?? "Member";
      notify({
        message: `Removed ${name}`,
        action: {
          label: "Undo",
          onAction: () => {
            void addGroupMember(group.id, { actorId: member.actorId, role: member.role }).then(
              invalidate,
            );
          },
        },
      });
    },
    onSettled: invalidate,
  });

  const members = membersQuery.data ?? [];

  return (
    <section aria-labelledby="group-members-heading" className="grid gap-3">
      <h3 id="group-members-heading" className="m-0 type-body-sm font-semibold">
        Members
      </h3>
      <form
        className="grid gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (picked.length > 0) addMutation.mutate(picked);
        }}
      >
        <PeoplePicker
          label="Add members"
          value={picked}
          onChange={setPicked}
          placeholder="Name or email"
        />
        <div>
          <Button
            type="submit"
            size="sm"
            variant="outline"
            disabled={picked.length === 0 || addMutation.isPending}
          >
            {addMutation.isPending ? "Adding…" : "Add"}
          </Button>
        </div>
      </form>
      <MutationError error={addMutation.error} />
      <MutationError error={removeMutation.error} />
      {failure !== null ? (
        <QueryFailureBanner
          summary="Members couldn't be loaded"
          subject="group members"
          error={failure.error}
          isRetrying={failure.isRetrying}
          onRetry={failure.retry}
        />
      ) : membersQuery.isPending ? (
        <LoadingState label="Loading members" variant="row" count={3} />
      ) : members.length === 0 ? (
        <p className="admin-muted">No members yet.</p>
      ) : (
        <ul className="admin-member-list" aria-label={`Members of ${group.name}`}>
          {members.map((member) => {
            const user = names.get(member.actorId);
            const name = user?.displayName ?? "Unknown account";
            return (
              <li key={member.id} className="admin-member">
                <Avatar name={name} size={28} />
                <span className="min-w-0 flex-1">
                  <span className="admin-row-title">{name}</span>
                  <span className="admin-row-detail">
                    {user?.email ?? member.actorId} · {ROLE_LABEL[member.role]}
                  </span>
                </span>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  aria-label={`Remove ${name}`}
                  disabled={removeMutation.isPending}
                  onClick={() => removeMutation.mutate(member)}
                >
                  <XIcon aria-hidden="true" />
                </Button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

/** Edit an existing group, or create one when `group` is null. */
export function GroupSheet({
  group,
  onClose,
}: {
  readonly group: Group | null;
  readonly onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const invalidateGroups = () => {
    void queryClient.invalidateQueries({ queryKey: groupsAdminQueryKeys.groups() });
  };
  return (
    <SideSheet
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={group === null ? "Create group" : group.name}
      {...(group === null
        ? { description: "Groups share an email address and give access to many people at once." }
        : group.email === null
          ? {}
          : { description: group.email })}
      size="lg"
    >
      <div className="admin-stack">
        {group === null ? (
          <GroupMailForm
            onSave={createGroup}
            onSaved={() => {
              invalidateGroups();
              onClose();
            }}
          />
        ) : (
          <>
            <GroupMailForm
              key={group.id}
              group={group}
              onSave={(input) => updateGroup(group.id, input)}
              onSaved={invalidateGroups}
            />
            <GroupMembers group={group} />
          </>
        )}
      </div>
    </SideSheet>
  );
}
