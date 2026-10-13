/* Admin › Directory › Limits. How much one person may store and send: the
 * organization's defaults, and the people and agents who have values of their
 * own. A person's limits can also be opened from their row under Users. */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { formatBytes, formatCount } from "@/features/admin/console/format";
import {
  EmptyRow,
  LoadingState,
  Notice,
  PageHeading,
  PanelHeading,
  QueryFailureBanner,
  useQueryFailure,
} from "@/features/admin/console/primitives";
import {
  personLimitsQueryKey,
  personLimitsQueryOptions,
  saveDefaultLimits,
  type PersonLimits,
  type PersonLimitValues,
} from "@/features/admin/person-limits-api";
import { PersonLimitsDialog, usageOf } from "@/features/admin/person-limits-dialog";
import { PersonLimitsForm } from "@/features/admin/person-limits-form";
import { tenantConfigQueryKeys } from "@/features/admin/tenant-config-api";

function summary(person: PersonLimits): string {
  const { usage, effective } = person;
  return [
    `Storage ${usageOf(
      formatBytes(usage.storageBytes),
      effective.storageBytes === null ? null : formatBytes(effective.storageBytes),
    )}.`,
    `Sent today ${usageOf(
      formatCount(usage.mailSentLastDay),
      effective.mailSendPerDay === null ? null : formatCount(effective.mailSendPerDay),
    )}.`,
  ].join(" ");
}

export function PersonLimitsManagement() {
  const queryClient = useQueryClient();
  const query = useQuery(personLimitsQueryOptions());
  const [editing, setEditing] = useState<PersonLimits | null>(null);
  const [saved, setSaved] = useState(0);
  const reload = () => {
    void queryClient.invalidateQueries({ queryKey: personLimitsQueryKey });
    void queryClient.invalidateQueries({ queryKey: tenantConfigQueryKeys.detail() });
  };
  const failure = useQueryFailure(query, reload);
  const saveDefaults = useMutation({
    mutationFn: (defaults: PersonLimitValues) => saveDefaultLimits(defaults),
    // The failure is shown in the form; nothing is changed optimistically.
    onMutate: () => undefined,
    onError: () => undefined,
    onSuccess: () => {
      setSaved((count) => count + 1);
      reload();
    },
  });
  const people = query.data?.people ?? [];

  return (
    <>
      <PageHeading
        title="Limits"
        subtitle="How much each person may store and send, and who has limits of their own."
      />
      <div className="admin-stack">
        {failure !== null ? (
          <QueryFailureBanner
            summary="Limits couldn't be loaded"
            subject="limits"
            error={failure.error}
            isRetrying={failure.isRetrying}
            onRetry={failure.retry}
          />
        ) : query.data === undefined ? (
          <LoadingState label="Loading limits" count={2} />
        ) : (
          <>
            <section className="admin-card" aria-labelledby="person-limits-defaults-heading">
              <PanelHeading
                id="person-limits-defaults-heading"
                title="For everyone"
                subtitle="These apply to each person and agent unless they have limits of their own."
              />
              <PersonLimitsForm
                initial={query.data.defaults}
                emptyMeans="Leave a field empty for no limit."
                saveLabel="Save defaults"
                isPending={saveDefaults.isPending}
                error={saveDefaults.error}
                onSave={(values) => saveDefaults.mutate(values)}
              />
              {saved > 0 && !saveDefaults.isPending && saveDefaults.error === null ? (
                <Notice>Defaults saved.</Notice>
              ) : null}
            </section>

            <section className="admin-card" aria-labelledby="person-limits-people-heading">
              <PanelHeading
                id="person-limits-people-heading"
                title="People with their own limits"
                subtitle="To give someone their own limits, open their row under Users and choose Limits."
              />
              {people.length === 0 ? (
                <EmptyRow>Everyone uses the defaults.</EmptyRow>
              ) : (
                <ul
                  className="m-0 grid list-none gap-2 p-0"
                  aria-label="People with their own limits"
                >
                  {people.map((person) => (
                    <li
                      key={person.actorId}
                      className="grid gap-2 rounded-md border border-[var(--border)] p-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start"
                    >
                      <div className="grid min-w-0 gap-1">
                        <span className="font-medium">{person.displayName}</span>
                        <p className="admin-muted m-0 type-caption">{summary(person)}</p>
                      </div>
                      <Button
                        onClick={() => setEditing(person)}
                        size="sm"
                        type="button"
                        variant="outline"
                      >
                        Edit<span className="sr-only"> limits for {person.displayName}</span>
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </>
        )}
      </div>
      {editing === null ? null : (
        <PersonLimitsDialog
          actorId={editing.actorId}
          name={editing.displayName}
          onClose={() => setEditing(null)}
        />
      )}
    </>
  );
}
