/* Small Drive dialogs: name a new folder or rename an item, and confirm
   permanent deletion. */
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
  readonly onSubmit: (name: string) => void;
  readonly onClose: () => void;
}) {
  const inputId = useId();
  const [name, setName] = useState(initialName);
  const trimmed = name.trim();
  return (
    <Dialog
      title={<h2 className="type-h3 m-0">{title}</h2>}
      onClose={onClose}
      width={400}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            type="submit"
            form={`${inputId}-form`}
            className="btn primary"
            disabled={trimmed.length === 0}
          >
            {submitLabel}
          </button>
        </>
      }
    >
      <form
        id={`${inputId}-form`}
        onSubmit={(event) => {
          event.preventDefault();
          if (trimmed.length === 0) return;
          onSubmit(trimmed);
        }}
      >
        <label htmlFor={inputId} className="sr-only">
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
      </form>
    </Dialog>
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
