/* Confirms deleting a filter. Mail it already handled stays as it is. */

import { Button } from "@/components/ui/button";
import { InlineError } from "@/components/ui/inline-error";
import { notify } from "@/components/ui/toast";
import type { MailFilterRecord } from "../api";
import { describeFilterCriteria } from "./filter-model";
import { MailDialog } from "./mail-dialog";
import { errorText, useDeleteFilter } from "./mutations";

export function FilterRemoveDialog({
  filter,
  onClose,
}: {
  readonly filter: MailFilterRecord;
  readonly onClose: () => void;
}) {
  const remove = useDeleteFilter();
  return (
    <MailDialog
      role="alertdialog"
      size="sm"
      title="Delete this filter?"
      description={`New mail matching “${describeFilterCriteria(filter)}” won't be handled by it anymore. Mail it already sorted stays where it is.`}
      onClose={onClose}
      onSubmit={() =>
        remove.mutate(filter.id, {
          onSuccess: () => {
            notify({ message: "Filter deleted" });
            onClose();
          },
        })
      }
      footer={
        <>
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="submit"
            variant="destructive"
            disabled={remove.isPending}
            aria-busy={remove.isPending || undefined}
          >
            Delete
          </Button>
        </>
      }
    >
      {remove.error === null ? null : (
        <InlineError
          variant="compact"
          title="Couldn't delete the filter"
          message={errorText(remove.error, "Check your connection and try again.")}
        />
      )}
    </MailDialog>
  );
}
