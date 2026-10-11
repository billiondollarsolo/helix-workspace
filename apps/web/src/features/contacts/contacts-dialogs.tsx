/* Small Contacts dialogs: name a label (create or rename) and confirm an
   irreversible or sweeping action. */
import { contactLabelNameSchema } from "@helix/contracts";
import { useId, useState } from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Dialog } from "@/components/ui/helix-dialog";

export function LabelNameDialog({
  title,
  initialName = "",
  submitLabel,
  existing,
  onSubmit,
  onClose,
}: {
  readonly title: string;
  readonly initialName?: string;
  readonly submitLabel: string;
  /** Other label names; a duplicate (ignoring case) is refused. */
  readonly existing: readonly string[];
  readonly onSubmit: (name: string) => Promise<boolean>;
  readonly onClose: () => void;
}) {
  const id = useId();
  const [name, setName] = useState(initialName);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    const parsed = contactLabelNameSchema.safeParse(name);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "Check the label name.");
      return;
    }
    const taken = existing.some(
      (label) =>
        label.toLocaleLowerCase() === parsed.data.toLocaleLowerCase() &&
        label.toLocaleLowerCase() !== initialName.toLocaleLowerCase(),
    );
    if (taken) {
      setError(`A label named “${parsed.data}” already exists.`);
      return;
    }
    setSaving(true);
    const saved = await onSubmit(parsed.data);
    setSaving(false);
    if (saved) onClose();
  };

  return (
    <Dialog
      title={<h2 className="type-h3 m-0">{title}</h2>}
      onClose={onClose}
      width="min(400px, 100%)"
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            type="submit"
            form={`${id}-form`}
            className="btn primary"
            disabled={saving || name.trim().length === 0}
            aria-busy={saving || undefined}
          >
            {submitLabel}
          </button>
        </>
      }
    >
      <form
        id={`${id}-form`}
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <label htmlFor={`${id}-name`} className="type-body-sm font-medium">
          Label name
        </label>
        <input
          id={`${id}-name`}
          className="input mt-1 w-full"
          value={name}
          maxLength={80}
          autoComplete="off"
          aria-invalid={error !== null || undefined}
          aria-describedby={error === null ? undefined : `${id}-error`}
          onChange={(event) => {
            setName(event.target.value);
            setError(null);
          }}
        />
        {error === null ? null : (
          <p id={`${id}-error`} className="m-0 mt-1 type-caption text-destructive">
            {error}
          </p>
        )}
      </form>
    </Dialog>
  );
}

export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel,
  onConfirm,
  onOpenChange,
}: {
  readonly open: boolean;
  readonly title: string;
  readonly description: string;
  readonly confirmLabel: string;
  readonly onConfirm: () => void;
  readonly onOpenChange: (open: boolean) => void;
}) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle className="type-h3">{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction variant="destructive" onClick={onConfirm}>
            {confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
