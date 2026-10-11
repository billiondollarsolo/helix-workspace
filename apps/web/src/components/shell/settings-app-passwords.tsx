/* App passwords: let a mail, calendar, contacts or file app sign in without
   your main password. The secret is shown once, with where to use it. */

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Copy } from "lucide-react";
import { useId, useState, type FormEvent } from "react";
import { EmptyState } from "@/components/ui/empty-state";
import { InlineError } from "@/components/ui/inline-error";
import { Skeleton } from "@/components/ui/skeleton";
import { notify } from "@/components/ui/toast";
import type { AppPasswordRecord } from "@/features/account/api";
import {
  myAppPasswordsQueryOptions,
  useCreateMyAppPassword,
  useRevokeMyAppPassword,
} from "@/features/account/security-queries";
import { useDateTimeFormat } from "@/features/account/use-date-time-format";
import { sessionUserQueryOptions } from "@/lib/auth";
import {
  grantablePurposes,
  purposesForScopes,
  setupHints,
  type AppPasswordPurpose,
} from "./app-password-purposes";
import { SettingsConfirm, SettingsDialog } from "./settings-confirm";
import { SettingsCard, SettingsHeader } from "./settings-controls";

export function AppPasswordsSection() {
  const session = useQuery(sessionUserQueryOptions()).data;
  const actorId = session?.actorId ?? null;
  return (
    <>
      <SettingsHeader
        title="App passwords"
        description="Let mail, calendar, contacts and file apps sign in to Helix without your main password. Each one works only for what you choose, and you can revoke it at any time."
      />
      {actorId === null ? (
        <Skeleton variant="card" count={1} label="Loading app passwords" />
      ) : (
        <AppPasswords actorId={actorId} email={session?.email ?? ""} />
      )}
    </>
  );
}

function AppPasswords({ actorId, email }: { readonly actorId: string; readonly email: string }) {
  const queryClient = useQueryClient();
  const query = useQuery(myAppPasswordsQueryOptions(actorId));
  const { queryKey } = myAppPasswordsQueryOptions(actorId);
  const [created, setCreated] = useState<{
    readonly record: AppPasswordRecord;
    readonly password: string;
  } | null>(null);
  const [revoking, setRevoking] = useState<AppPasswordRecord | null>(null);
  const revoke = useRevokeMyAppPassword(actorId);
  const confirmRevoke = (record: AppPasswordRecord) =>
    revoke.mutate(record, {
      onSuccess: () => {
        setRevoking(null);
        notify({ message: `Revoked “${record.label}”` });
      },
    });

  if (query.data === undefined) {
    return query.isError ? (
      <InlineError
        title="Your app passwords didn’t load"
        message={query.error.message}
        retrying={query.isFetching}
        onRetry={() => void queryClient.invalidateQueries({ queryKey })}
      />
    ) : (
      <Skeleton variant="card" count={1} label="Loading app passwords" />
    );
  }

  const purposes = grantablePurposes(query.data.grantableScopes);
  const active = query.data.appPasswords.filter((record) => record.revokedAt === null);
  return (
    <>
      <CreateCard
        actorId={actorId}
        purposes={purposes}
        onCreated={(record, password) => setCreated({ record, password })}
      />
      <SettingsCard title="Your app passwords">
        {active.length === 0 ? (
          <EmptyState
            size="inline"
            headingLevel={3}
            title="No app passwords yet"
            body="Passwords you create appear here with when they were last used."
          />
        ) : (
          <ul className="m-0 list-none p-0" aria-label="App passwords">
            {active.map((record) => (
              <AppPasswordRow
                key={record.id}
                record={record}
                onRevoke={() => setRevoking(record)}
              />
            ))}
          </ul>
        )}
      </SettingsCard>
      {created === null ? null : (
        <SecretDialog
          record={created.record}
          password={created.password}
          email={email}
          onClose={() => setCreated(null)}
        />
      )}
      {revoking === null ? null : (
        <SettingsConfirm
          title={`Revoke “${revoking.label}”?`}
          description="Apps using this password stop working right away. You can create a new one at any time."
          confirmLabel="Revoke"
          pending={revoke.isPending}
          onConfirm={() => confirmRevoke(revoking)}
          onClose={() => {
            setRevoking(null);
            revoke.reset();
          }}
        />
      )}
      {revoke.isError ? <InlineError variant="compact" message={revoke.error.message} /> : null}
    </>
  );
}

function CreateCard({
  actorId,
  purposes,
  onCreated,
}: {
  readonly actorId: string;
  readonly purposes: readonly AppPasswordPurpose[];
  readonly onCreated: (record: AppPasswordRecord, password: string) => void;
}) {
  const ids = { name: useId(), error: useId(), purposes: useId() };
  const [name, setName] = useState("");
  const [chosen, setChosen] = useState<readonly AppPasswordPurpose["id"][]>([]);
  const [error, setError] = useState<string | null>(null);
  const create = useCreateMyAppPassword(actorId);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    if (name.trim() === "") {
      setError("Name the app or device that will use this password.");
      return;
    }
    if (chosen.length === 0) {
      setError("Choose what this password can be used for.");
      return;
    }
    const scopes = purposes
      .filter((purpose) => chosen.includes(purpose.id))
      .flatMap((purpose) => purpose.scopes);
    create.mutate(
      { label: name.trim(), scopes: [...new Set(scopes)] },
      {
        onSuccess: (result) => {
          setName("");
          setChosen([]);
          onCreated(result.appPassword, result.password);
        },
        onError: (caught) => setError(caught.message),
      },
    );
  };

  if (purposes.length === 0) {
    return (
      <SettingsCard title="Create an app password">
        <p className="m-0 type-body-sm text-muted-foreground">
          Your account doesn’t have access to any app that signs in with an app password. Ask your
          administrator if you need one.
        </p>
      </SettingsCard>
    );
  }

  const describedBy = error === null ? undefined : ids.error;
  return (
    <SettingsCard title="Create an app password">
      <form onSubmit={submit} className="grid max-w-120 gap-4" noValidate>
        <fieldset disabled={create.isPending} className="m-0 grid gap-4 border-0 p-0">
          <legend className="sr-only">New app password</legend>
          <div className="grid gap-1">
            <label htmlFor={ids.name} className="type-body-sm font-medium">
              App or device name
            </label>
            <input
              id={ids.name}
              className="input"
              maxLength={120}
              autoComplete="off"
              placeholder="For example, Phone mail"
              value={name}
              aria-describedby={describedBy}
              aria-invalid={error !== null && name.trim() === "" ? true : undefined}
              onChange={(event) => setName(event.target.value)}
            />
          </div>
          <fieldset className="m-0 grid gap-2 border-0 p-0" aria-describedby={describedBy}>
            <legend className="mb-1 p-0 type-body-sm font-medium">What it can do</legend>
            {purposes.map((purpose) => (
              <label key={purpose.id} className="flex items-center gap-2 type-body-sm">
                <input
                  type="checkbox"
                  checked={chosen.includes(purpose.id)}
                  onChange={(event) =>
                    setChosen((current) =>
                      event.target.checked
                        ? [...current, purpose.id]
                        : current.filter((id) => id !== purpose.id),
                    )
                  }
                  className="focus-ring accent-[var(--accent)]"
                />
                <span>
                  {purpose.label}{" "}
                  <span className="text-muted-foreground">({purpose.protocol})</span>
                </span>
              </label>
            ))}
          </fieldset>
        </fieldset>
        {error === null ? null : (
          <p id={ids.error} role="alert" className="m-0 type-body-sm text-destructive">
            {error}
          </p>
        )}
        <div>
          <button type="submit" className="btn primary sm" disabled={create.isPending}>
            {create.isPending ? "Creating…" : "Create password"}
          </button>
        </div>
      </form>
    </SettingsCard>
  );
}

function AppPasswordRow({
  record,
  onRevoke,
}: {
  readonly record: AppPasswordRecord;
  readonly onRevoke: () => void;
}) {
  const format = useDateTimeFormat();
  const uses = purposesForScopes(record.scopes);
  return (
    <li className="flex flex-wrap items-center gap-3 border-t border-border py-3 first:border-t-0">
      <div className="min-w-0 flex-1">
        <p className="m-0 type-body-sm font-medium">{record.label}</p>
        <p className="m-0 type-caption text-muted-foreground">
          {uses.length === 0
            ? record.scopes.join(", ")
            : uses.map((use) => use.protocol).join(", ")}
          {" · "}Created {format.date(record.createdAt)}
          {" · "}
          {record.lastUsedAt === null
            ? "Never used"
            : `Last used ${format.relative(record.lastUsedAt)}`}
        </p>
      </div>
      <button
        type="button"
        className="btn sm"
        aria-label={`Revoke ${record.label}`}
        onClick={onRevoke}
      >
        Revoke
      </button>
    </li>
  );
}

function SecretDialog({
  record,
  password,
  email,
  onClose,
}: {
  readonly record: AppPasswordRecord;
  readonly password: string;
  readonly email: string;
  readonly onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const hints = setupHints(purposesForScopes(record.scopes), window.location.origin);
  return (
    <SettingsDialog
      title="Your app password"
      description={`Use it in “${record.label}” instead of your main password. You won’t see it again after you close this.`}
      onClose={onClose}
      footer={
        <button type="button" className="btn primary" onClick={onClose}>
          Done
        </button>
      }
    >
      <div className="grid gap-4">
        <div className="flex flex-wrap items-center gap-2">
          <code
            aria-label="App password"
            className="mono min-w-0 flex-1 rounded-md bg-muted [padding:10px_12px] type-body [overflow-wrap:anywhere]"
          >
            {password}
          </code>
          <button
            type="button"
            className="btn sm"
            onClick={() => {
              void navigator.clipboard.writeText(password).then(
                () => setCopied(true),
                () =>
                  notify({
                    message: "Couldn’t copy. Select the password and copy it.",
                    tone: "error",
                  }),
              );
            }}
          >
            {copied ? (
              <Check size={14} aria-hidden="true" />
            ) : (
              <Copy size={14} aria-hidden="true" />
            )}
            {copied ? "Copied" : "Copy"}
          </button>
          <span role="status" className="sr-only">
            {copied ? "Password copied" : ""}
          </span>
        </div>
        {hints.length === 0 ? null : (
          <div>
            <h3 className="m-0 mb-1 type-body-sm font-semibold">Set up your app</h3>
            <dl className="m-0 grid gap-2 type-body-sm">
              <div>
                <dt className="font-medium">User name</dt>
                <dd className="m-0 text-muted-foreground [overflow-wrap:anywhere]">{email}</dd>
              </div>
              {hints.map((hint) => (
                <div key={hint.purpose.id}>
                  <dt className="font-medium">{hint.purpose.protocol} server</dt>
                  <dd className="m-0 text-muted-foreground [overflow-wrap:anywhere]">
                    {hint.server}
                  </dd>
                </div>
              ))}
            </dl>
          </div>
        )}
      </div>
    </SettingsDialog>
  );
}
