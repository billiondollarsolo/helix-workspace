/* One account's details in a side sheet: who it is, its access, and the
 * actions an administrator can take on it. */

import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { SideSheet } from "@/components/ui/side-sheet";
import type { DirectoryUser } from "@/features/admin/admin-console-data";
import { StatusChip } from "@/features/admin/console/primitives";
import { CopyableId, CopyButton, RelativeTime } from "@/features/admin/console/widgets";
import { userActionsFor, type UserAction } from "./user-actions";

const ACTION_BUTTON_LABEL: Record<UserAction, string> = {
  profile: "Edit profile",
  addresses: "Mail addresses",
  "reset-verification": "Reset sign-in verification",
  offboard: "Remove access",
};

export function actorTypeLabel(type: string): string {
  if (type.length === 0) {
    return "—";
  }
  const spaced = type.replace(/_/gu, " ");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

export function UserDetailsSheet({
  user,
  onClose,
  onAction,
}: {
  readonly user: DirectoryUser;
  readonly onClose: () => void;
  readonly onAction: (action: UserAction) => void;
}) {
  const actions = userActionsFor(user);
  return (
    <SideSheet
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={user.name}
      description={user.email ?? "No email address"}
      size="md"
    >
      <div className="admin-stack">
        <div className="flex items-center gap-3">
          <Avatar name={user.name} size={48} />
          <div className="grid gap-1">
            <StatusChip
              tone={user.status === "active" ? "success" : "danger"}
              label={user.status === "active" ? "Active" : "Suspended"}
            />
          </div>
        </div>

        {actions.length === 0 ? null : (
          <div className="flex flex-wrap gap-2">
            {actions.map((action) => (
              <Button
                key={action}
                type="button"
                size="sm"
                variant={action === "offboard" ? "destructive" : "outline"}
                onClick={() => onAction(action)}
              >
                {ACTION_BUTTON_LABEL[action]}
              </Button>
            ))}
          </div>
        )}

        <dl className="admin-facts">
          <div>
            <dt>Email</dt>
            <dd className="flex items-center gap-1">
              {user.email === null ? (
                "None"
              ) : (
                <>
                  <span className="truncate">{user.email}</span>
                  <CopyButton value={user.email} label="Copy email address" />
                </>
              )}
            </dd>
          </div>
          <div>
            <dt>Account type</dt>
            <dd>{actorTypeLabel(user.actorType)}</dd>
          </div>
          <div>
            <dt>Role</dt>
            <dd>{user.role}</dd>
          </div>
          <div>
            <dt>Added</dt>
            <dd>
              <RelativeTime value={user.createdAt} />
            </dd>
          </div>
          {user.disabledAt === null ? null : (
            <div>
              <dt>Suspended</dt>
              <dd>
                <RelativeTime value={user.disabledAt} />
              </dd>
            </div>
          )}
          <div>
            <dt>User ID</dt>
            <dd>
              <CopyableId value={user.id} label="user ID" />
            </dd>
          </div>
        </dl>

        <section aria-labelledby="user-admin-access-heading" className="grid gap-2">
          <h3 id="user-admin-access-heading" className="m-0 type-body-sm font-semibold">
            Admin access
          </h3>
          {user.adminScopes.length === 0 ? (
            <p className="admin-muted">No admin access.</p>
          ) : (
            <ul className="flex flex-wrap gap-1 p-0 m-0 list-none">
              {user.adminScopes.map((scope) => (
                <li key={scope} className="chip mono">
                  {scope}
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </SideSheet>
  );
}
