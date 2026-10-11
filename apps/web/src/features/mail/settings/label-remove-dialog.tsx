/* Confirms removing a label. Nested labels go with it; conversations stay. */

import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { InlineError } from "@/components/ui/inline-error";
import { notify } from "@/components/ui/toast";
import { mailLabelsQueryOptions } from "../queries";
import { labelSubtreeIds } from "./label-model";
import { MailDialog } from "./mail-dialog";
import { errorText, useRemoveLabel } from "./mutations";

export function LabelRemoveDialog({
  labelId,
  onClose,
}: {
  readonly labelId: string;
  readonly onClose: () => void;
}) {
  const labels = useQuery(mailLabelsQueryOptions());
  const remove = useRemoveLabel();
  const label = labels.data?.find((entry) => entry.id === labelId);
  const nestedCount =
    labels.data === undefined ? 0 : labelSubtreeIds(labels.data, labelId).size - 1;
  const name = label?.name ?? "this label";

  return (
    <MailDialog
      role="alertdialog"
      size="sm"
      title={`Remove the label “${name}”?`}
      description={
        nestedCount === 0
          ? "Conversations with this label stay in your mailbox."
          : `Its ${String(nestedCount)} nested ${nestedCount === 1 ? "label is" : "labels are"} removed too. Conversations stay in your mailbox.`
      }
      onClose={onClose}
      onSubmit={() =>
        remove.mutate(labelId, {
          onSuccess: () => {
            notify({ message: `Label “${name}” removed` });
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
            disabled={remove.isPending || label === undefined}
            aria-busy={remove.isPending || undefined}
          >
            Remove
          </Button>
        </>
      }
    >
      {remove.error === null ? null : (
        <InlineError
          variant="compact"
          title="Couldn't remove the label"
          message={errorText(remove.error, "Check your connection and try again.")}
        />
      )}
    </MailDialog>
  );
}
