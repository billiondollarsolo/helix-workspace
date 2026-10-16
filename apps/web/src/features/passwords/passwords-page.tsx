/* Native personal vaults, with access to an existing external vault during migration. */

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { iconMap } from "@/components/icon-map";
import { SurfaceFrame } from "@/components/shell";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { CopyableId } from "@/features/admin/console/widgets";
import { coreAppsShellQueryOptions } from "@/features/admin/core-apps-api";
import { sessionQueryKeys, sessionUserQueryOptions } from "@/lib/auth";
import { NativeVault } from "./native-vault";
import { InlineError } from "@/components/ui/inline-error";

export function PasswordsPage() {
  const queryClient = useQueryClient();
  const query = useQuery(coreAppsShellQueryOptions());
  const url = query.data?.passwords?.url ?? null;
  const session = useQuery(sessionUserQueryOptions());
  const native = query.data?.passwords?.native === true && query.data.passwords.enabled;

  return (
    <SurfaceFrame title="Passwords" icon={<iconMap.Key size={16} />}>
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto grid w-full max-w-5xl gap-6 p-6">
          <h1 className="m-0 text-xl font-semibold">Passwords</h1>
          {native ? (
            <>
              {session.data?.actorId ? (
                <NativeVault key={session.data.actorId} actorId={session.data.actorId} />
              ) : session.isPending ? (
                <p role="status">Checking your session…</p>
              ) : (
                <InlineError
                  message="Couldn't resolve your workspace account. Sign in again or reload your session."
                  onRetry={() =>
                    void queryClient.invalidateQueries({ queryKey: sessionQueryKeys.current })
                  }
                />
              )}
              <p className="m-0 text-sm text-[var(--text-3)]">
                Download an encrypted .kdbx copy for backup or to open in KeePassXC or another
                compatible app. Helix retains the previous saved version. Personal vaults support
                logins and notes; sharing and file imports are not enabled yet.
              </p>
              {url ? (
                <Button asChild variant="outline">
                  <a href={url} rel="noopener noreferrer" target="_blank">
                    Open previous password manager
                    <span className="sr-only"> (opens in a new tab)</span>
                  </a>
                </Button>
              ) : null}
            </>
          ) : (
            <PasswordsBody loading={query.isPending} url={url} />
          )}
        </div>
      </div>
    </SurfaceFrame>
  );
}

function PasswordsBody({
  loading,
  url,
}: {
  readonly loading: boolean;
  readonly url: string | null;
}) {
  return (
    <>
      {loading ? (
        <p className="m-0 text-[var(--text-3)]" role="status">
          Loading…
        </p>
      ) : url === null ? (
        <EmptyState
          icon={<iconMap.Key />}
          title="Passwords isn't available"
          body="Your organization hasn't turned on its password manager. Ask an administrator."
        />
      ) : (
        <>
          <p className="m-0 text-[var(--text-2)]">
            Your organization's password manager keeps logins, cards and notes in an encrypted vault
            that only you can open.
          </p>
          <div>
            <Button asChild>
              <a href={url} rel="noopener noreferrer" target="_blank">
                Open Passwords
                <span className="sr-only"> (opens in a new tab)</span>
              </a>
            </Button>
          </div>
          <section aria-labelledby="passwords-first-time" className="grid gap-2">
            <h2 className="m-0 text-sm font-semibold" id="passwords-first-time">
              First time here
            </h2>
            <ol className="m-0 grid gap-1 pl-5 text-[var(--text-2)]">
              <li>Choose “Create account” and use your work email address.</li>
              <li>Open the confirmation email it sends you.</li>
              <li>
                Choose a master password you will remember. Nobody, including your administrators,
                can recover it for you.
              </li>
            </ol>
          </section>
          <section aria-labelledby="passwords-apps" className="grid gap-2">
            <h2 className="m-0 text-sm font-semibold" id="passwords-apps">
              Apps and browser extensions
            </h2>
            <p className="m-0 text-[var(--text-2)]">
              Install a Bitwarden app or browser extension, choose “Self-hosted”, and enter this
              server address:
            </p>
            <CopyableId value={url} label="server address" />
          </section>
        </>
      )}
    </>
  );
}
