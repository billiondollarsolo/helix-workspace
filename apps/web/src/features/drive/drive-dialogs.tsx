/* Small Drive dialogs: name a new folder or rename an item, and confirm
   permanent deletion. */
import { InlineError } from "@/components/ui/inline-error";
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
import { FormPanel } from "@/components/ui/form-panel";

/** "New folder" and "Rename": one text field, selected on open. */
export function DriveNameDialog({
  title,
  label,
  initialName,
  submitLabel,
  onSubmit,
  onClose,
}: {
  readonly title: string;
  readonly label: string;
  readonly initialName: string;
  readonly submitLabel: string;
  readonly onSubmit: (name: string) => Promise<boolean>;
  readonly onClose: () => void;
}) {
  const inputId = useId();
  const [name, setName] = useState(initialName);
  const trimmed = name.trim();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <FormPanel
      title={<h2 className="type-h3 m-0">{title}</h2>}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            type="submit"
            form={`${inputId}-form`}
            className="btn primary"
            disabled={trimmed.length === 0 || pending}
            aria-busy={pending}
          >
            {pending ? "Saving…" : submitLabel}
          </button>
        </>
      }
    >
      <form
        id={`${inputId}-form`}
        onSubmit={(event) => {
          event.preventDefault();
          if (trimmed.length === 0 || pending) return;
          setError(null);
          setPending(true);
          void onSubmit(trimmed)
            .then((saved) => {
              if (saved) onClose();
              else setError("The name could not be saved. Your entry is kept; try again.");
            })
            .catch((cause) =>
              setError(cause instanceof Error ? cause.message : "The name could not be saved."),
            )
            .finally(() => setPending(false));
        }}
      >
        <label htmlFor={inputId} className="mb-2 block type-body-sm font-semibold">
          {label}
        </label>
        <input
          id={inputId}
          className="input w-full"
          value={name}
          maxLength={255}
          onChange={(event) => setName(event.target.value)}
          onFocus={(event) => {
            const dot = event.target.value.lastIndexOf(".");
            event.target.setSelectionRange(0, dot > 0 ? dot : event.target.value.length);
          }}
        />
        {error ? <InlineError variant="compact" title="Couldn’t save" message={error} /> : null}
      </form>
    </FormPanel>
  );
}

/** Confirmation before an irreversible action such as "Delete forever". */
export function DriveConfirmDialog({
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
