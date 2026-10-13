/* One person's (or agent's) own limits: what they are using, and values that
 * replace the organization's defaults for them alone. */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Dialog } from "@/components/ui/helix-dialog";
import { notify } from "@/components/ui/toast";
import { formatBytes, formatCount } from "@/features/admin/console/format";
import { ErrorNotice, LoadingState } from "@/features/admin/console/primitives";
import {
  personLimitQueryOptions,
  personLimitsQueryKey,
  savePersonLimits,
  type PersonLimits,
  type PersonLimitValues,
} from "@/features/admin/person-limits-api";
import { PersonLimitsForm } from "@/features/admin/person-limits-form";

/** "1.2 GB of 5 GB", or "1.2 GB, no limit". */
export function usageOf(used: string, limit: string | null): string {
  return limit === null ? `${used}, no limit` : `${used} of ${limit}`;
}

function Usage({ person }: { readonly person: PersonLimits }) {
  const { usage, effective } = person;
  const rows = [
    [
      "Storage",
      usageOf(
        formatBytes(usage.storageBytes),
        effective.storageBytes === null ? null : formatBytes(effective.storageBytes),
      ),
    ],
    [
      "Sent in the last hour",
      usageOf(
        formatCount(usage.mailSentLastHour),
        effective.mailSendPerHour === null ? null : formatCount(effective.mailSendPerHour),
      ),
    ],
    [
      "Sent in the last day",
      usageOf(
        formatCount(usage.mailSentLastDay),
        effective.mailSendPerDay === null ? null : formatCount(effective.mailSendPerDay),
      ),
    ],
  ] as const;
  return (
    <dl className="m-0 grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 type-meta">
      {rows.map(([label, value]) => (
        <div key={label} className="contents">
          <dt className="admin-muted">{label}</dt>
          <dd className="m-0">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function PersonLimitsDialog({
  actorId,
  name,
  onClose,
}: {
  readonly actorId: string;
  readonly name: string;
  readonly onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const query = useQuery(personLimitQueryOptions(actorId));
  const save = useMutation({
    mutationFn: (overrides: PersonLimitValues) => savePersonLimits(actorId, overrides),
    // The failure is shown in the form; nothing is changed optimistically.
    onMutate: () => undefined,
    onError: () => undefined,
    onSuccess: () => {
      notify({ message: `Limits saved for ${name}` });
      void queryClient.invalidateQueries({ queryKey: personLimitsQueryKey });
      onClose();
    },
  });
  const person = query.data;

  return (
    <Dialog
      title={<h2 className="type-h3 m-0 truncate">Limits for {name}</h2>}
      onClose={onClose}
      width="min(640px, calc(100vw - 32px))"
    >
      {query.isPending ? (
        <LoadingState label="Loading limits" count={2} />
      ) : person === undefined ? (
        <ErrorNotice>
          {query.error instanceof Error ? query.error.message : "The limits couldn’t be loaded."}
        </ErrorNotice>
      ) : (
        <div className="grid gap-4">
          <Usage person={person} />
          <PersonLimitsForm
            initial={person.overrides}
            placeholders={{
              storageBytes:
                person.overrides.storageBytes === null ? person.effective.storageBytes : null,
              mailSendPerHour:
                person.overrides.mailSendPerHour === null ? person.effective.mailSendPerHour : null,
              mailSendPerDay:
                person.overrides.mailSendPerDay === null ? person.effective.mailSendPerDay : null,
            }}
            emptyMeans="Leave a field empty to use your organization’s default for it."
            saveLabel="Save limits"
            isPending={save.isPending}
            error={save.error}
            onSave={(values) => save.mutate(values)}
            onCancel={onClose}
          />
        </div>
      )}
    </Dialog>
  );
}
