/* "Settings and sharing" for a calendar the viewer owns or manages. Name and
   colour are changed from the calendar's options menu. */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Trash2 } from "lucide-react";
import { useState, type CSSProperties } from "react";
import { PeoplePicker } from "@/components/people/people-picker";
import { PersonAvatar } from "@/components/people/person-chip";
import { Button } from "@/components/ui/button";
import { InlineError } from "@/components/ui/inline-error";
import { SideSheet } from "@/components/ui/side-sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { notify } from "@/components/ui/toast";
import type { PersonRef } from "@/features/people/person-ref";
import {
  removeCalendarMembership,
  setCalendarMembership,
  type CalendarMembership,
  type CalendarShareRole,
} from "./api";
import { labelFill } from "./colors";
import type { CalendarSource } from "./event-model";
import { calendarMembershipsQueryOptions, calendarQueryKeys } from "./queries";

const ROLE_LABELS: Readonly<Record<CalendarShareRole, string>> = {
  reader: "See all event details",
  writer: "Make changes to events",
  manager: "Make changes and manage sharing",
};

const ROLES = Object.keys(ROLE_LABELS) as CalendarShareRole[];

function errorText(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim() !== "" ? error.message : fallback;
}

export function CalendarSettingsSheet({
  calendar,
  onClose,
}: {
  readonly calendar: CalendarSource;
  readonly onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const memberships = useQuery(calendarMembershipsQueryOptions(calendar.id));
  const [people, setPeople] = useState<PersonRef[]>([]);
  const [role, setRole] = useState<CalendarShareRole>("reader");
  const [error, setError] = useState<string | null>(null);
  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: calendarQueryKeys.memberships(calendar.id) });

  const share = useMutation({
    mutationFn: async (input: { actorIds: readonly string[]; role: CalendarShareRole }) => {
      for (const actorId of input.actorIds) {
        await setCalendarMembership({ calendarId: calendar.id, actorId, role: input.role });
      }
    },
    onMutate: () => setError(null),
    onError: (cause) => setError(errorText(cause, "Couldn't share the calendar. Try again.")),
    onSuccess: (_result, input) => {
      setPeople([]);
      notify({
        message: `Shared with ${String(input.actorIds.length)} ${input.actorIds.length === 1 ? "person" : "people"}`,
      });
    },
    onSettled: refresh,
  });

  const remove = useMutation({
    mutationFn: (member: CalendarMembership) =>
      removeCalendarMembership({ calendarId: calendar.id, actorId: member.actorId }),
    onMutate: () => setError(null),
    onError: (cause) => setError(errorText(cause, "Couldn't remove that person. Try again.")),
    onSettled: refresh,
  });

  const changeRole = useMutation({
    mutationFn: (input: { member: CalendarMembership; role: CalendarShareRole }) =>
      setCalendarMembership({
        calendarId: calendar.id,
        actorId: input.member.actorId,
        role: input.role,
      }),
    onMutate: () => setError(null),
    onError: (cause) => setError(errorText(cause, "Couldn't change that permission. Try again.")),
    onSettled: refresh,
  });

  const actorIds = people.flatMap((person) => (person.actorId === null ? [] : [person.actorId]));

  return (
    <SideSheet
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={`Settings for ${calendar.name}`}
      size="md"
    >
      <section aria-labelledby="cal-settings-details" className="mb-6">
        <h3 id="cal-settings-details" className="type-body font-semibold m-0 mb-2">
          Calendar details
        </h3>
        <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 type-body-sm">
          <dt className="text-muted-foreground">Name</dt>
          <dd className="m-0">{calendar.name}</dd>
          <dt className="text-muted-foreground">Colour</dt>
          <dd className="m-0 flex items-center gap-2">
            <span
              aria-hidden="true"
              className="cal-swatch"
              style={{ "--swatch": labelFill(calendar.label) } as CSSProperties}
            />
            <span className="capitalize">{calendar.label}</span>
          </dd>
          <dt className="text-muted-foreground">Time zone</dt>
          <dd className="m-0">{calendar.timezone}</dd>
        </dl>
      </section>

      <section aria-labelledby="cal-settings-share">
        <h3 id="cal-settings-share" className="type-body font-semibold m-0 mb-2">
          Share with specific people
        </h3>
        {error !== null ? <InlineError variant="compact" message={error} className="mb-3" /> : null}
        {memberships.isLoading ? <Skeleton variant="row" count={2} label="Loading people" /> : null}
        {memberships.isError ? (
          <InlineError
            variant="compact"
            title="Couldn't load who has access"
            message={errorText(memberships.error, "Try again in a moment.")}
            onRetry={() => void refresh()}
            retrying={memberships.isFetching}
          />
        ) : null}
        <ul className="m-0 p-0 list-none flex flex-col gap-1 mb-4">
          {(memberships.data ?? []).map((member) => {
            const name = member.displayName ?? member.email ?? "Member";
            return (
              <li key={member.actorId} className="flex items-center gap-2 py-1">
                <PersonAvatar person={{ displayName: name, avatarDataUrl: null }} size={28} />
                <span className="flex-1 min-w-0">
                  <span className="block truncate type-body-sm">{name}</span>
                  {member.email !== null && member.email !== name ? (
                    <span className="block truncate type-caption text-muted-foreground">
                      {member.email}
                    </span>
                  ) : null}
                </span>
                {member.role === "owner" ? (
                  <span className="type-caption text-muted-foreground">Owner</span>
                ) : (
                  <>
                    <select
                      aria-label={`Permission for ${name}`}
                      className="input type-body-sm"
                      value={member.role}
                      disabled={changeRole.isPending}
                      onChange={(event) => {
                        const next = ROLES.find((candidate) => candidate === event.target.value);
                        if (next !== undefined) changeRole.mutate({ member, role: next });
                      }}
                    >
                      {ROLES.map((option) => (
                        <option key={option} value={option}>
                          {ROLE_LABELS[option]}
                        </option>
                      ))}
                    </select>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`Remove ${name}`}
                      disabled={remove.isPending}
                      onClick={() => remove.mutate(member)}
                    >
                      <Trash2 aria-hidden="true" />
                    </Button>
                  </>
                )}
              </li>
            );
          })}
        </ul>
        <form
          className="flex flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (actorIds.length > 0) share.mutate({ actorIds, role });
          }}
        >
          <PeoplePicker label="Add people" value={people} onChange={setPeople} />
          <label className="flex flex-col gap-1 type-body-sm">
            Permission
            <select
              className="input type-body-sm"
              value={role}
              onChange={(event) => {
                const next = ROLES.find((candidate) => candidate === event.target.value);
                if (next !== undefined) setRole(next);
              }}
            >
              {ROLES.map((option) => (
                <option key={option} value={option}>
                  {ROLE_LABELS[option]}
                </option>
              ))}
            </select>
          </label>
          <Button
            type="submit"
            className="self-end"
            disabled={actorIds.length === 0 || share.isPending}
          >
            {share.isPending ? "Sharing…" : "Share"}
          </Button>
        </form>
      </section>
    </SideSheet>
  );
}
