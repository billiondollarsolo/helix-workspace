/* The console's one confirmation for destructive admin actions.
 *
 * The policy this encodes, because "add a confirm dialog" is not a policy:
 *
 *   Reversible, one object        no dialog. Confirming a toggle an operator
 *                                 can immediately flip back is friction that
 *                                 teaches them to click through dialogs.
 *   Irreversible, one object      dialog naming the target.
 *                                 -> revoke an app password / credential
 *   Irreversible, many affected   dialog naming the target AND who else it
 *                                 hits, via `blastRadius`.
 *                                 -> revoke an OAuth app (every user's tokens),
 *                                    disable a workspace app org-wide
 *   Irreversible and hard to      as above, plus `confirmPhrase`: the operator
 *   undo from this console        types the object's name. Reserved for actions
 *                                 whose recovery is a support ticket.
 *                                 -> delete a verified domain (mail stops)
 *
 * `blastRadius` must state a real consequence, never a generic warning. "This
 * cannot be undone" tells an operator nothing they did not assume; "37 users
 * currently hold tokens for this app" is a decision input. */

import { useEffect, useState, type ReactNode } from "react";
import { ShieldAlert } from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Input } from "@/components/ui/input";

export interface ConfirmDestructiveProps {
  /** Rendered when non-null; pass null to close. */
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** Imperative verb + object: "Revoke OAuth app", "Delete domain". */
  readonly title: string;
  /** What happens to the named target. */
  readonly children: ReactNode;
  /** Who or what else this affects. Omit only when the action truly touches
   *  one object and nothing downstream. */
  readonly blastRadius?: ReactNode;
  /** When set, the operator must type this exactly before confirming. Use the
   *  object's own name so the typing is a second look at what is selected. */
  readonly confirmPhrase?: string;
  readonly confirmLabel: string;
  readonly isPending: boolean;
  readonly onConfirm: () => void;
}

export function ConfirmDestructive({
  open,
  onOpenChange,
  title,
  children,
  blastRadius,
  confirmPhrase,
  confirmLabel,
  isPending,
  onConfirm,
}: ConfirmDestructiveProps) {
  const [typed, setTyped] = useState("");

  // Reopening for a different target must not inherit the previous typing.
  useEffect(() => {
    if (!open) {
      setTyped("");
    }
  }, [open]);

  const phraseSatisfied = confirmPhrase === undefined || typed.trim() === confirmPhrase;

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogMedia>
            <ShieldAlert />
          </AlertDialogMedia>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{children}</AlertDialogDescription>
        </AlertDialogHeader>

        {blastRadius === undefined ? null : (
          <p className="admin-confirm-blast" role="note">
            {blastRadius}
          </p>
        )}

        {confirmPhrase === undefined ? null : (
          <label className="admin-confirm-phrase">
            <span>
              Type <code>{confirmPhrase}</code> to confirm
            </span>
            <Input
              autoComplete="off"
              onChange={(event) => setTyped(event.target.value)}
              value={typed}
            />
          </label>
        )}

        <AlertDialogFooter>
          <AlertDialogCancel disabled={isPending}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            disabled={isPending || !phraseSatisfied}
            onClick={(event) => {
              event.preventDefault();
              onConfirm();
            }}
            variant="destructive"
          >
            {isPending ? "Working…" : confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
