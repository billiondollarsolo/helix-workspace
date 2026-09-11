import { UserOffboardingButton } from "./user-offboarding-dialog";
import { Copy as CopyIcon } from "lucide-react";
import { AdminUserAddressesButton } from "./user-addresses-dialog";
import { Button } from "@/components/ui/button";
import type { DirectoryUser } from "@/features/admin/admin-console-data";

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(date);
}

function CopyButton({
  label,
  value,
  copyKey,
  copy,
  state,
}: {
  label: string;
  value: string;
  copyKey: string;
  copy: (key: string, value: string) => void;
  state: { key: string; ok: boolean } | null;
}) {
  const active = state?.key === copyKey ? state : null;
  return (
    <Button type="button" size="xs" variant="outline" onClick={() => copy(copyKey, value)}>
      <CopyIcon size={16} /> {active === null ? label : active.ok ? "Copied" : "Copy failed"}
    </Button>
  );
}

export function detailRowId(userId: string): string {
  return `user-detail-${userId}`;
}

export function UserDetail({
  user,
  copy,
  copyState,
}: {
  readonly user: DirectoryUser;
  readonly copy: (key: string, value: string) => void;
  readonly copyState: { key: string; ok: boolean } | null;
}) {
  return (
    <div
      id={detailRowId(user.id)}
      className="grid gap-2 py-2 pl-7 whitespace-normal [font-size:var(--text-meta)]"
    >
      <div className="row flex-wrap items-center gap-2">
        <span className="text-[var(--text-3)]">Actor ID</span>
        <code className="mono">{user.id}</code>
        <CopyButton
          label="Copy ID"
          value={user.id}
          copyKey={`id-${user.id}`}
          copy={copy}
          state={copyState}
        />
        {user.email === null ? null : (
          <CopyButton
            label="Copy email"
            value={user.email}
            copyKey={`email-${user.id}`}
            copy={copy}
            state={copyState}
          />
        )}
      </div>
      {user.actorType === "user" ? (
        <div>
          <AdminUserAddressesButton actorId={user.id} name={user.name} />
        </div>
      ) : null}
      {user.actorType === "user" || user.actorType === "agent" ? (
        <div>
          <UserOffboardingButton actorId={user.id} name={user.name} />
        </div>
      ) : null}
      <div>
        <span className="text-[var(--text-3)]">Admin scopes </span>
        {user.adminScopes.length === 0 ? (
          <span className="text-[var(--text-2)]">
            None — this account reaches no admin surface.
          </span>
        ) : (
          <span className="row mt-1 flex-wrap gap-1">
            {user.adminScopes.map((scope) => (
              <span key={scope} className="chip mono">
                {scope}
              </span>
            ))}
          </span>
        )}
      </div>
      <div className="text-[var(--text-2)]">
        Added {formatDate(user.createdAt)}
        {user.disabledAt === null ? "" : ` · Suspended ${formatDate(user.disabledAt)}`}
      </div>
    </div>
  );
}
