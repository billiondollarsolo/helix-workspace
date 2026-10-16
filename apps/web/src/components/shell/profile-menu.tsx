import { LogOut as SignOutIcon, Shield as ShieldIcon, X as XIcon } from "lucide-react";
/* ProfileMenu — the account card behind the top-bar avatar: who is signed in,
   a way to manage the account, the Admin console for admins, and sign out.
   Appearance lives in Quick settings. */

import type { SettingsSectionId } from "@/components/shell/overlay-context";
import { Avatar } from "@/components/ui/avatar";
import { hasAdminConsoleAccess } from "@/features/admin/admin-console-data";
import { sessionUserQueryOptions, signOut } from "@/lib/auth";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useRouter } from "@tanstack/react-router";
import { Popover } from "radix-ui";
import { useState } from "react";

export interface ProfileMenuProps {
  /** Open the full-screen settings page. */
  openSettings: (section?: SettingsSectionId) => void;
}

export function ProfileMenu({ openSettings }: ProfileMenuProps) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const sessionQuery = useQuery(sessionUserQueryOptions());
  const displayName = sessionQuery.data?.name ?? sessionQuery.data?.email ?? "Signed in";
  const displayEmail = sessionQuery.data?.email ?? "";
  const isAdmin = hasAdminConsoleAccess(sessionQuery.data?.scopes ?? []);

  const handleSignOut = async (): Promise<void> => {
    if (signingOut) {
      return;
    }
    setSigningOut(true);
    try {
      await signOut();
    } finally {
      // Drop any cached, actor-scoped data before leaving the workspace.
      queryClient.clear();
      setOpen(false);
      await router.navigate({ to: "/login" });
      await router.invalidate();
    }
  };

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger className="topbar-avatar" aria-label={`Account: ${displayName}`}>
        <Avatar name={displayName} size={28} />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          className="account-card"
          align="end"
          sideOffset={8}
          collisionPadding={8}
          aria-label="Account"
        >
          <Popover.Close className="icon-btn account-card-close" aria-label="Close">
            <XIcon size={16} aria-hidden="true" />
          </Popover.Close>
          <Avatar name={displayName} size={64} />
          <div className="account-card-name">{displayName}</div>
          {displayEmail.length > 0 && displayEmail !== displayName ? (
            <div className="account-card-email">{displayEmail}</div>
          ) : null}
          <button
            type="button"
            className="btn account-card-manage"
            onClick={() => {
              setOpen(false);
              openSettings("profile");
            }}
          >
            Manage your account and status
          </button>
          {isAdmin ? (
            <Link
              to="/admin"
              className="account-card-row"
              onClick={() => {
                setOpen(false);
              }}
            >
              <ShieldIcon size={16} aria-hidden="true" />
              Admin console
            </Link>
          ) : null}
          <button
            type="button"
            className="account-card-row"
            disabled={signingOut}
            onClick={() => {
              void handleSignOut();
            }}
          >
            <SignOutIcon size={16} aria-hidden="true" />
            {signingOut ? "Signing out…" : "Sign out"}
          </button>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
