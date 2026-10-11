/* New label / Edit label dialog: name, "Nest label under", and a color
   picked from the 24-token palette. */

import { MAIL_LABEL_DEFAULT_COLOR, type MailLabelColorName } from "@helix/contracts";
import { useQuery } from "@tanstack/react-query";
import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { InlineError } from "@/components/ui/inline-error";
import { Skeleton } from "@/components/ui/skeleton";
import { notify } from "@/components/ui/toast";
import type { MailLabelSummary } from "../api";
import { mailLabelsQueryOptions } from "../queries";
import type { MailLabelDialogRequest } from "./dialog-store";
import { LabelColorPicker } from "./label-color-picker";
import { labelNameError, parentLabelOptions } from "./label-model";
import { MailDialog } from "./mail-dialog";
import { errorText, useCreateLabel, useRetry, useUpdateLabel } from "./mutations";

export function LabelDialog({
  request,
  onClose,
}: {
  readonly request: MailLabelDialogRequest;
  readonly onClose: () => void;
}) {
  const labels = useQuery(mailLabelsQueryOptions());
  const retry = useRetry(mailLabelsQueryOptions().queryKey);
  const editing =
    request.mode === "edit"
      ? labels.data?.find((label) => label.id === request.labelId)
      : undefined;
  const title = request.mode === "edit" ? "Edit label" : "New label";

  if (labels.data === undefined || (request.mode === "edit" && editing === undefined)) {
    const missing = labels.data !== undefined || labels.error !== null;
    return (
      <MailDialog
        title={title}
        onClose={onClose}
        size="sm"
        footer={
          <Button type="button" variant="ghost" onClick={onClose}>
            Close
          </Button>
        }
      >
        {missing ? (
          <InlineError
            variant="compact"
            title="Couldn't open this label"
            message={
              labels.error === null
                ? "It may have been removed. Close this dialog and refresh your labels."
                : errorText(labels.error, "Check your connection and try again.")
            }
            onRetry={retry}
            retrying={labels.isFetching}
          />
        ) : (
          <Skeleton variant="text" count={4} label="Loading labels" />
        )}
      </MailDialog>
    );
  }

  return (
    <LabelForm
      key={editing?.id ?? "new"}
      title={title}
      labels={labels.data}
      editing={editing ?? null}
      initialParentId={request.mode === "create" ? (request.parentId ?? null) : null}
      onClose={onClose}
    />
  );
}

function LabelForm({
  title,
  labels,
  editing,
  initialParentId,
  onClose,
}: {
  readonly title: string;
  readonly labels: readonly MailLabelSummary[];
  readonly editing: MailLabelSummary | null;
  readonly initialParentId: string | null;
  readonly onClose: () => void;
}) {
  const ids = useId();
  const parents = parentLabelOptions(labels, editing?.id ?? null);
  const startParent = editing?.parentId ?? initialParentId;
  const [name, setName] = useState(editing?.name ?? "");
  const [nested, setNested] = useState(startParent !== null);
  const [parentId, setParentId] = useState(startParent ?? parents[0]?.label.id ?? "");
  const [color, setColor] = useState<MailLabelColorName>(
    editing?.colorName ?? MAIL_LABEL_DEFAULT_COLOR,
  );
  const [nameError, setNameError] = useState<string | null>(null);
  const create = useCreateLabel();
  const update = useUpdateLabel();
  const saving = create.isPending || update.isPending;
  const saveError = create.error ?? update.error;

  const submit = () => {
    const error = labelNameError(name);
    setNameError(error);
    if (error !== null) return;
    const input = {
      name: name.trim(),
      color,
      parentId: nested && parentId !== "" ? parentId : null,
    };
    const done = (message: string) => {
      notify({ message });
      onClose();
    };
    if (editing === null) {
      create.mutate(input, { onSuccess: () => done(`Label “${input.name}” created`) });
      return;
    }
    const changes = {
      ...(input.name === editing.name ? {} : { name: input.name }),
      ...(input.color === editing.colorName ? {} : { color: input.color }),
      ...(input.parentId === editing.parentId ? {} : { parentId: input.parentId }),
    };
    if (Object.keys(changes).length === 0) {
      onClose();
      return;
    }
    update.mutate(
      { id: editing.id, ...changes },
      { onSuccess: () => done(`Label “${input.name}” saved`) },
    );
  };

  const nameId = `${ids}-name`;
  const nameErrorId = `${ids}-name-error`;
  return (
    <MailDialog
      title={title}
      onClose={onClose}
      onSubmit={submit}
      size="sm"
      footer={
        <>
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={saving} aria-busy={saving || undefined}>
            {editing === null ? "Create" : "Save"}
          </Button>
        </>
      }
    >
      <div className="grid gap-4">
        <div className="grid gap-1.5">
          <label htmlFor={nameId} className="type-body-sm font-medium">
            Label name
          </label>
          <input
            id={nameId}
            name="labelName"
            className="input"
            autoComplete="off"
            value={name}
            maxLength={225}
            onChange={(event) => {
              setName(event.target.value);
              if (nameError !== null) setNameError(null);
            }}
            aria-invalid={nameError !== null || undefined}
            aria-describedby={nameError === null ? undefined : nameErrorId}
          />
          {nameError === null ? null : (
            <p id={nameErrorId} className="m-0 type-caption text-destructive">
              {nameError}
            </p>
          )}
        </div>
        <div className="grid gap-1.5">
          <label className="flex items-center gap-2 type-body-sm">
            <input
              type="checkbox"
              name="nestLabel"
              className="focus-ring accent-[var(--accent)]"
              checked={nested}
              disabled={parents.length === 0}
              onChange={(event) => setNested(event.target.checked)}
            />
            Nest label under
          </label>
          <select
            name="parentLabel"
            className="select"
            aria-label="Parent label"
            value={parentId}
            disabled={!nested || parents.length === 0}
            onChange={(event) => setParentId(event.target.value)}
          >
            {parents.length === 0 ? <option value="">No labels to nest under</option> : null}
            {parents.map((entry) => (
              <option key={entry.label.id} value={entry.label.id}>
                {entry.path}
              </option>
            ))}
          </select>
        </div>
        <LabelColorPicker value={color} onChange={setColor} />
        {saveError === null ? null : (
          <InlineError
            variant="compact"
            title={editing === null ? "Couldn't create the label" : "Couldn't save the label"}
            message={errorText(saveError, "Check your connection and try again.")}
          />
        )}
      </div>
    </MailDialog>
  );
}
