/* What an administrator can do to one account, shared by the row ⋮ menu and
 * the details sheet: edit the profile, manage mail addresses, reset sign-in
 * verification, suspend or restore, and remove access (offboarding with a
 * data handoff). */

import { RowMenuItem } from "@/features/admin/console/widgets";
import { useMutation } from "@tanstack/react-query";
import {
  AtSign as AtSignIcon,
  KeyRound as KeyIcon,
  Pencil as PencilIcon,
  UserCheck as UserCheckIcon,
  UserMinus as UserMinusIcon,
  UserX as UserXIcon,
} from "lucide-react";
import { Fragment, useState, type ReactNode } from "react";
import { MenuLabel, MenuSeparator } from "@/components/ui/menu";
import { notify } from "@/components/ui/toast";
import type { DirectoryUser } from "@/features/admin/admin-console-data";
import { resetUserSignInVerification } from "@/features/admin/admin-users";
import { ConfirmDestructive } from "@/features/admin/console/confirm-destructive";
import { AdminUserAddressesDialog } from "./user-addresses-dialog";
import { UserOffboardingDialog } from "./user-offboarding-dialog";
import { AdminUserProfileDialog } from "./user-profile-dialog";
import { UserSuspensionDialog } from "./user-suspension-dialog";

export type UserAction =
  | "profile"
  | "addresses"
  | "reset-verification"
  | "suspend"
  | "restore"
  | "offboard";

/** Which actions apply to this account. Only people have profiles, addresses
 *  and sign-in factors, and only people can be suspended and restored; people
 *  and agents can be offboarded. Removed accounts stay closed. */
export function userActionsFor(user: DirectoryUser): readonly UserAction[] {
  const actions: UserAction[] = [];
  if (user.actorType === "user") {
    actions.push("profile", "addresses");
    if (user.status === "active") actions.push("reset-verification", "suspend");
    if (user.status === "suspended") actions.push("restore");
  }
  if ((user.actorType === "user" || user.actorType === "agent") && user.status === "active") {
    actions.push("offboard");
  }
  return actions;
}

const ACTION_LABEL: Record<UserAction, string> = {
  profile: "Edit profile",
  addresses: "Mail addresses",
  "reset-verification": "Reset sign-in verification",
  suspend: "Suspend user…",
  restore: "Restore user…",
  offboard: "Remove access…",
};

const ACTION_ICON: Record<UserAction, ReactNode> = {
  profile: <PencilIcon size={16} />,
  addresses: <AtSignIcon size={16} />,
  "reset-verification": <KeyIcon size={16} />,
  suspend: <UserXIcon size={16} />,
  restore: <UserCheckIcon size={16} />,
  offboard: <UserMinusIcon size={16} />,
};

/** The first of these starts the menu's account-access group. */
const ACCESS_ACTIONS: ReadonlySet<UserAction> = new Set(["suspend", "restore", "offboard"]);

/** The account actions as menu items, for a row ⋮ menu. */
export function UserActionMenuItems({
  user,
  onAction,
}: {
  readonly user: DirectoryUser;
  readonly onAction: (action: UserAction) => void;
}) {
  const actions = userActionsFor(user);
  if (actions.length === 0) {
    return <MenuLabel>No actions for this account</MenuLabel>;
  }
  return (
    <>
      {actions.map((action, index) => (
        <Fragment key={action}>
          {index > 0 &&
          ACCESS_ACTIONS.has(action) &&
          !ACCESS_ACTIONS.has(actions[index - 1] ?? action) ? (
            <MenuSeparator />
          ) : null}
          <RowMenuItem
            icon={ACTION_ICON[action]}
            destructive={action === "offboard"}
            onSelect={() => onAction(action)}
          >
            {ACTION_LABEL[action]}
          </RowMenuItem>
        </Fragment>
      ))}
    </>
  );
}

/** The dialog for whichever action is open, or nothing. */
export function UserActionDialog({
  user,
  action,
  onClose,
}: {
  readonly user: DirectoryUser;
  readonly action: UserAction;
  readonly onClose: () => void;
}) {
  switch (action) {
    case "profile":
      return <AdminUserProfileDialog actorId={user.id} name={user.name} onClose={onClose} />;
    case "addresses":
      return <AdminUserAddressesDialog actorId={user.id} name={user.name} onClose={onClose} />;
    case "offboard":
      return <UserOffboardingDialog actorId={user.id} name={user.name} onClose={onClose} />;
    case "reset-verification":
      return <ResetVerificationDialog user={user} onClose={onClose} />;
    case "suspend":
    case "restore":
      return <UserSuspensionDialog user={user} suspend={action === "suspend"} onClose={onClose} />;
  }
}

function ResetVerificationDialog({
  user,
  onClose,
}: {
  readonly user: DirectoryUser;
  readonly onClose: () => void;
}) {
  const [open, setOpen] = useState(true);
  const mutation = useMutation({
    mutationFn: () => resetUserSignInVerification(user.id),
    onMutate: () => undefined,
    onSuccess: () => {
      notify({ message: `Sign-in verification reset for ${user.name}` });
    },
    onError: (error: Error) => {
      notify({
        message: "Couldn't reset sign-in verification",
        description: error.message,
        tone: "error",
      });
    },
    onSettled: () => {
      setOpen(false);
      onClose();
    },
  });
  return (
    <ConfirmDestructive
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      title={`Reset sign-in verification for ${user.name}?`}
      blastRadius="They are signed out on every device and must set up 2-step verification again."
      confirmLabel="Reset"
      isPending={mutation.isPending}
      onConfirm={() => mutation.mutate()}
    >
      Removes their 2-step verification methods, passkeys, and recovery codes.
    </ConfirmDestructive>
  );
}
