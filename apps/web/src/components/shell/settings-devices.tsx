/* Your devices: every signed-in browser with its last activity, a Sign out
   for each other device, and Sign out of all other devices. */

import type { AccountSession } from "@helix/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Laptop, MonitorSmartphone, Smartphone, Tablet } from "lucide-react";
import { useState } from "react";
import { InlineError } from "@/components/ui/inline-error";
import { Skeleton } from "@/components/ui/skeleton";
import { notify } from "@/components/ui/toast";
import {
  accountSessionsQueryOptions,
  useRevokeAccountSession,
  useRevokeOtherAccountSessions,
} from "@/features/account/security-queries";
import { useDateTimeFormat } from "@/features/account/use-date-time-format";
import { SettingsConfirm } from "./settings-confirm";
import { SettingsCard } from "./settings-controls";

const DEVICE_ICONS = {
  desktop: Laptop,
  mobile: Smartphone,
  tablet: Tablet,
  unknown: MonitorSmartphone,
} as const;

/** "Firefox on macOS", or the closest honest description. */
export function sessionTitle(session: AccountSession): string {
  const browser = session.browser === "" || session.browser === "Unknown" ? null : session.browser;
  const os = session.os === "" || session.os === "Unknown" ? null : session.os;
  if (browser !== null && os !== null) return `${browser} on ${os}`;
  return browser ?? os ?? "Unknown device";
}

export function DevicesCard() {
  const queryClient = useQueryClient();
  const format = useDateTimeFormat();
  const query = useQuery(accountSessionsQueryOptions());
  /* How many other devices the confirmation names, fixed when it opens. */
  const [confirmAll, setConfirmAll] = useState<number | null>(null);
  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: accountSessionsQueryOptions().queryKey });
  const revokeOne = useRevokeAccountSession();
  const revokeOthers = useRevokeOtherAccountSessions();
  const signOut = (session: AccountSession) =>
    revokeOne.mutate(session, {
      onSuccess: () => notify({ message: `Signed out of ${sessionTitle(session)}` }),
      onError: (error) => notify({ message: error.message, tone: "error" }),
    });
  const signOutOthers = () =>
    revokeOthers.mutate(undefined, {
      onSuccess: (count) => {
        setConfirmAll(null);
        notify({
          message:
            count === 0
              ? "No other devices were signed in"
              : `Signed out of ${String(count)} other ${count === 1 ? "device" : "devices"}`,
        });
      },
    });
  const sessions = query.data;
  const others = sessions?.filter((session) => !session.current).length ?? 0;

  return (
    <SettingsCard
      title="Your devices"
      description="Where you’re signed in to Helix right now"
      action={
        others > 0 ? (
          <button type="button" className="btn sm" onClick={() => setConfirmAll(others)}>
            Sign out of all other devices
          </button>
        ) : undefined
      }
    >
      {sessions === undefined ? (
        query.isError ? (
          <InlineError
            variant="compact"
            title="Your devices didn’t load"
            message={query.error.message}
            retrying={query.isFetching}
            onRetry={() => void refresh()}
          />
        ) : (
          <Skeleton variant="row" count={2} label="Loading your devices" />
        )
      ) : (
        <ul className="m-0 list-none p-0" aria-label="Signed-in devices">
          {[...sessions]
            .sort((left, right) => Number(right.current) - Number(left.current))
            .map((session) => {
              const Icon = DEVICE_ICONS[session.deviceType];
              const title = sessionTitle(session);
              return (
                <li
                  key={session.id}
                  className="flex flex-wrap items-center gap-3 border-t border-border py-3 first:border-t-0"
                >
                  <Icon size={22} aria-hidden="true" className="shrink-0 text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    <p className="m-0 type-body-sm font-medium">
                      {title}
                      {session.current ? (
                        <span className="ml-2 rounded-full [background:var(--accent-soft)] [padding:1px_8px] type-caption font-semibold text-primary">
                          This device
                        </span>
                      ) : null}
                    </p>
                    <p className="m-0 type-caption text-muted-foreground">
                      {session.current
                        ? "Active now"
                        : `Last active ${format.relative(session.lastActiveAt)}`}
                      {session.ipAddress === null ? "" : ` · ${session.ipAddress}`}
                    </p>
                  </div>
                  {session.current ? null : (
                    <button
                      type="button"
                      className="btn sm"
                      aria-label={`Sign out of ${title}`}
                      disabled={revokeOne.isPending && revokeOne.variables.id === session.id}
                      onClick={() => signOut(session)}
                    >
                      Sign out
                    </button>
                  )}
                </li>
              );
            })}
        </ul>
      )}
      {confirmAll === null ? null : (
        <SettingsConfirm
          title="Sign out of all other devices?"
          description={`${String(confirmAll)} other ${confirmAll === 1 ? "device" : "devices"} will need to sign in again. You stay signed in here.`}
          confirmLabel="Sign out"
          pending={revokeOthers.isPending}
          onConfirm={signOutOthers}
          onClose={() => setConfirmAll(null)}
        />
      )}
      {revokeOthers.isError ? (
        <InlineError variant="compact" message={revokeOthers.error.message} />
      ) : null}
    </SettingsCard>
  );
}
