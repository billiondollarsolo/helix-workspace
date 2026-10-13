/* The three limits, as a form. Used for the organization's defaults and for one
 * person's own values; only the wording around an empty field differs. */

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { AdminField, AdminInput } from "@/features/admin/console/controls";
import { ErrorNotice } from "@/features/admin/console/primitives";
import {
  bytesToGigabytes,
  countFromText,
  gigabytesToBytes,
  type PersonLimitValues,
} from "@/features/admin/person-limits-api";

export function PersonLimitsForm({
  initial,
  emptyMeans,
  placeholders,
  saveLabel,
  isPending,
  error,
  onSave,
  onCancel,
}: {
  readonly initial: PersonLimitValues;
  /** What leaving a field empty does, shown under the fields. */
  readonly emptyMeans: string;
  /** Shown in an empty field: the value that applies when nothing is entered. */
  readonly placeholders?: PersonLimitValues;
  readonly saveLabel: string;
  readonly isPending: boolean;
  readonly error: Error | null;
  readonly onSave: (values: PersonLimitValues) => void;
  readonly onCancel?: () => void;
}) {
  const [storage, setStorage] = useState(bytesToGigabytes(initial.storageBytes));
  const [perHour, setPerHour] = useState(initial.mailSendPerHour?.toString() ?? "");
  const [perDay, setPerDay] = useState(initial.mailSendPerDay?.toString() ?? "");
  const [invalid, setInvalid] = useState<string | null>(null);
  const hint = (value: number | null | undefined, format: (set: number) => string) =>
    placeholders === undefined ? "No limit" : value == null ? "No limit" : format(value);

  return (
    <form
      className="grid gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        const values = {
          storageBytes: gigabytesToBytes(storage),
          mailSendPerHour: countFromText(perHour),
          mailSendPerDay: countFromText(perDay),
        };
        if (
          values.storageBytes === undefined ||
          values.mailSendPerHour === undefined ||
          values.mailSendPerDay === undefined
        ) {
          setInvalid("Enter numbers of zero or more. Messages are whole numbers.");
          return;
        }
        setInvalid(null);
        onSave(values as PersonLimitValues);
      }}
    >
      <div className="grid gap-3 sm:grid-cols-3">
        <AdminField label="Storage (GB)">
          <AdminInput
            inputMode="decimal"
            onChange={(event) => setStorage(event.target.value)}
            placeholder={hint(placeholders?.storageBytes, (bytes) => bytesToGigabytes(bytes))}
            value={storage}
          />
        </AdminField>
        <AdminField label="Messages sent per hour">
          <AdminInput
            inputMode="numeric"
            onChange={(event) => setPerHour(event.target.value)}
            placeholder={hint(placeholders?.mailSendPerHour, String)}
            value={perHour}
          />
        </AdminField>
        <AdminField label="Messages sent per day">
          <AdminInput
            inputMode="numeric"
            onChange={(event) => setPerDay(event.target.value)}
            placeholder={hint(placeholders?.mailSendPerDay, String)}
            value={perDay}
          />
        </AdminField>
      </div>
      <p className="admin-muted m-0 type-caption">
        Storage counts a person’s Drive files and the mail in their mailbox. {emptyMeans}
      </p>
      {invalid === null ? null : <ErrorNotice>{invalid}</ErrorNotice>}
      {error === null ? null : <ErrorNotice>{error.message}</ErrorNotice>}
      <div className="flex gap-2">
        <Button disabled={isPending} type="submit">
          {isPending ? "Saving" : saveLabel}
        </Button>
        {onCancel === undefined ? null : (
          <Button disabled={isPending} onClick={onCancel} type="button" variant="outline">
            Cancel
          </Button>
        )}
      </div>
    </form>
  );
}
