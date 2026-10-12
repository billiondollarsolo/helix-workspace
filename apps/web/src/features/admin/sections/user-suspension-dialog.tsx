/* Suspend or restore one person, after a confirmation that says what changes:
 * suspension signs them out everywhere and stops every credential; restoring
 * lets their unrevoked credentials work again. */

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { UserCheck as UserCheckIcon } from "lucide-react";
import { useState } from "react";
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
import { notify } from "@/components/ui/toast";
import type { DirectoryUser, UserStatus } from "@/features/admin/admin-console-data";
import { setAdminUserSuspended } from "@/features/admin/admin-users";
import { ConfirmDestructive } from "@/features/admin/console/confirm-destructive";
import { StatusChip } from "@/features/admin/console/primitives";

const STATUS_CHIP: Record<UserStatus, { readonly tone: string; readonly label: string }> = {
  active: { tone: "success", label: "Active" },
  invited: { tone: "info", label: "Invited" },
  suspended: { tone: "warning", label: "Suspended" },
  removed: { tone: "danger", label: "Removed" },
};

/** The account's workspace status as a chip. */
export function UserStatusChip({ status }: { readonly status: UserStatus }) {
  const chip = STATUS_CHIP[status];
  return <StatusChip tone={chip.tone} label={chip.label} />;
}

export function UserSuspensionDialog({
  user,
  suspend,
  onClose,
}: {
  readonly user: DirectoryUser;
  /** True to suspend, false to restore. */
  readonly suspend: boolean;
  readonly onClose: () => void;
}) {
  const [open, setOpen] = useState(true);
  const queryClient = useQueryClient();
  const mutation = useMutation({
    mutationFn: () => setAdminUserSuspended(user.id, suspend),
    onMutate: () => undefined,
    onSuccess: () => {
      notify({ message: `${user.name} ${suspend ? "suspended" : "restored"}` });
      void queryClient.invalidateQueries({ queryKey: ["admin", "users"] });
    },
    onError: (error: Error) => {
      notify({
        message: suspend ? `Couldn't suspend ${user.name}` : `Couldn't restore ${user.name}`,
        description: error.message,
        tone: "error",
      });
    },
    onSettled: () => {
      setOpen(false);
      onClose();
    },
  });
  const onOpenChange = (next: boolean) => {
    if (!next) onClose();
  };

  if (suspend) {
    return (
      <ConfirmDestructive
        open={open}
        onOpenChange={onOpenChange}
        title={`Suspend ${user.name}?`}
        blastRadius="They're signed out on every device. Their app passwords, S3 access keys and other API credentials stop working until you restore them."
        confirmLabel="Suspend"
        isPending={mutation.isPending}
        onConfirm={() => mutation.mutate()}
      >
        They can't sign in to this workspace while suspended. Their files, mail and groups stay as
        they are.
      </ConfirmDestructive>
    );
  }
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogMedia>
            <UserCheckIcon />
          </AlertDialogMedia>
          <AlertDialogTitle>{`Restore ${user.name}?`}</AlertDialogTitle>
          <AlertDialogDescription>
            They can sign in again, and their app passwords, S3 access keys and other API
            credentials work again.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={mutation.isPending}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            disabled={mutation.isPending}
            onClick={(event) => {
              event.preventDefault();
              mutation.mutate();
            }}
          >
            {mutation.isPending ? "Working…" : "Restore"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
