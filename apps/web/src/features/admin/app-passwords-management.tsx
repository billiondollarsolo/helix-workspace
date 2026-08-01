import { useForm } from "@tanstack/react-form";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { flexRender, getCoreRowModel, useReactTable, type ColumnDef } from "@tanstack/react-table";
import { Check, KeyRound, Plus, RotateCcw, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { adminUsersQueryOptions, type AdminUser } from "@/features/admin/admin-users";
import { ConfirmDestructive } from "@/features/admin/console/confirm-destructive";
import { EmptyRow, PageHeading, StateBanner } from "@/features/admin/console/primitives";
import {
  appPasswordsQueryOptions,
  createAppPassword,
  revokeAppPassword,
  type AppPassword,
  type AppPasswordCreateResult,
} from "./app-passwords-api";

interface AppPasswordFormState {
  readonly actorId: string;
  readonly label: string;
  readonly scopes: string;
  readonly expiresAt: string;
}

const defaultFormValues: AppPasswordFormState = {
  actorId: "",
  label: "",
  scopes: "calendar.read",
  expiresAt: "",
};

const commonScopes = [
  "calendar.read",
  "calendar.write",
  "caldav",
  "mail.read",
  "mail.send",
  "drive.read",
  "drive.write",
  "docs.read",
  "docs.write",
] as const;

/* The actor picker sits next to `Input` fields in the same form and there is no
   shared Select primitive to inherit that shell from. */
const SELECT_CLASS =
  "h-10 w-full min-w-0 rounded-md border border-outline bg-surface-container px-3 py-1.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/30 disabled:cursor-not-allowed disabled:opacity-50";

const ACTOR_STATUS_ID = "app-password-actor-status";

const invalidExpiresAt = Symbol("invalidExpiresAt");

type ActorStatus = "loading" | "error" | "empty" | "truncated" | "ready";

const actorPlaceholders: Record<ActorStatus, string> = {
  loading: "Loading actors…",
  error: "Actors unavailable",
  empty: "No enabled actors",
  truncated: "Select an actor",
  ready: "Select an actor",
};

interface ActorNotice {
  readonly kind: "loading" | "error" | "info";
  readonly message: string;
  readonly retryable: boolean;
}

export function AppPasswordsManagement() {
  const queryClient = useQueryClient();
  const [includeRevoked, setIncludeRevoked] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [createdPassword, setCreatedPassword] = useState<AppPasswordCreateResult | null>(null);
  const [passwordToRevoke, setPasswordToRevoke] = useState<AppPassword | null>(null);
  const passwordsQuery = useQuery(appPasswordsQueryOptions(includeRevoked));
  /* One page of enabled actors, sharing the cache (and the route prefetch) with
     the Users section rather than issuing a second identical request. */
  const actorsQuery = useQuery(adminUsersQueryOptions({ includeDisabled: false }));

  const createMutation = useMutation({
    mutationFn: (input: Parameters<typeof createAppPassword>[0]) => createAppPassword(input),
    onMutate: () => {
      setCreatedPassword(null);
    },
    onError: () => undefined,
    onSuccess: async (result) => {
      setCreatedPassword(result);
      await invalidateAppPasswordLists(queryClient);
    },
  });

  const revokeMutation = useMutation({
    mutationFn: (id: string) => revokeAppPassword(id),
    onMutate: () => undefined,
    onError: () => undefined,
    onSuccess: async () => {
      setPasswordToRevoke(null);
      await invalidateAppPasswordLists(queryClient);
    },
  });

  const passwords = passwordsQuery.data ?? [];
  const actors = useMemo(
    () =>
      [...(actorsQuery.data?.users ?? [])].sort((left, right) =>
        actorLabel(left).localeCompare(actorLabel(right)),
      ),
    [actorsQuery.data],
  );
  const actorLabels = useMemo(
    () => new Map(actors.map((actor) => [actor.id, actorLabel(actor)])),
    [actors],
  );
  const actorStatus = actorStatusOf({
    actorCount: actors.length,
    hasMore: (actorsQuery.data?.nextCursor ?? null) !== null,
    isError: actorsQuery.isError,
    isPending: actorsQuery.isPending,
  });
  const actorNotice = actorNoticeFor(actorStatus, actors.length, actorsQuery.error);
  /* The confirmation names who the password authenticates as. The list endpoint
     returns actor ids only, so an actor the picker never loaded — disabled, or
     past the first page — stays an id here rather than being guessed at. */
  const revokeActorLabel =
    passwordToRevoke === null ? null : (actorLabels.get(passwordToRevoke.actorId) ?? null);
  const tableData = useMemo(() => [...passwords], [passwords]);
  const columns = useMemo<ColumnDef<AppPassword>[]>(
    () => [
      {
        accessorKey: "label",
        header: "Label",
        cell: ({ row }) => <span className="font-medium">{row.original.label}</span>,
      },
      {
        accessorKey: "actorId",
        header: "Actor",
        /* The list endpoint returns actor ids only. A name exists for the actors
           the picker loaded; for anything else — a disabled actor, or one past
           the first page — the id is genuinely all we know. */
        cell: ({ row }) => {
          const label = actorLabels.get(row.original.actorId);
          return label === undefined ? (
            <code className="block max-w-[18rem] truncate text-[0.6875rem] text-muted-foreground">
              {row.original.actorId}
            </code>
          ) : (
            <span className="block max-w-[18rem] truncate">{label}</span>
          );
        },
      },
      {
        accessorKey: "scopes",
        header: "Scopes",
        cell: ({ row }) => (
          <div className="flex max-w-md flex-wrap gap-1">
            {row.original.scopes.map((scope) => (
              <span
                className="rounded border border-border bg-background px-1.5 py-0.5 text-[0.6875rem]"
                key={scope}
              >
                {scope}
              </span>
            ))}
          </div>
        ),
      },
      {
        id: "lastUsed",
        header: "Last used",
        cell: ({ row }) => formatDateTime(row.original.lastUsedAt) ?? "Never",
      },
      {
        id: "expires",
        header: "Expires",
        cell: ({ row }) => formatDateTime(row.original.expiresAt) ?? "Never",
      },
      {
        id: "status",
        header: "Status",
        cell: ({ row }) =>
          row.original.revokedAt === null ? (
            <span className="inline-flex items-center gap-1 text-emerald-700">
              <Check className="size-3" />
              Active
            </span>
          ) : (
            <span className="text-muted-foreground">
              Revoked {formatDateTime(row.original.revokedAt)}
            </span>
          ),
      },
      {
        id: "actions",
        header: "",
        cell: ({ row }) => (
          <Button
            aria-label={`Revoke app password ${row.original.label}`}
            disabled={row.original.revokedAt !== null || revokeMutation.isPending}
            onClick={() => setPasswordToRevoke(row.original)}
            size="sm"
            type="button"
            variant="destructive"
          >
            <Trash2 />
            Revoke
          </Button>
        ),
      },
    ],
    [actorLabels, revokeMutation.isPending],
  );
  const table = useReactTable({
    data: tableData,
    columns,
    getCoreRowModel: getCoreRowModel(),
  });

  const passwordForm = useForm({
    defaultValues: defaultFormValues,
    onSubmit: async ({ value }) => {
      const normalized = normalizeCreateInput(value);
      if (typeof normalized === "string") {
        setFormError(normalized);
        return;
      }
      setFormError(null);
      await createMutation.mutateAsync(normalized);
    },
  });

  /* An app password is always bound to an actor id. With no loaded actor there
     is nothing valid to submit, so the CTA stays disabled and the notice below
     the picker carries the reason. */
  const canPickActor = actors.length > 0;

  return (
    // No PageScroll: admin-console.tsx registers this section through
    // `withPageScroll`, which already supplies the scroll container and cap.
    <section className="grid gap-4">
      <PageHeading
        title="App passwords"
        subtitle="Issue one-time app passwords for protocol clients and revoke access that should no longer be usable."
        actions={
          <label className="inline-flex items-center gap-2 text-xs text-muted-foreground">
            <input
              checked={includeRevoked}
              className="size-3.5"
              onChange={(event) => setIncludeRevoked(event.target.checked)}
              type="checkbox"
            />
            Include revoked
          </label>
        }
      />

      {/* `items-start` / `content-start`: a grid track is stretch-aligned by
          default, so the short panel used to inherit the tall form's height and
          spread its two rows apart — several hundred pixels of blank card above
          the panel heading. */}
      <div className="grid items-start gap-4 lg:grid-cols-[minmax(20rem,0.75fr)_minmax(0,1.25fr)]">
        <form
          className="grid content-start gap-4 rounded-lg border border-border bg-card p-4"
          onSubmit={(event) => {
            event.preventDefault();
            void passwordForm.handleSubmit();
          }}
        >
          <div className="flex items-center gap-2">
            <KeyRound className="size-4 text-muted-foreground" />
            <h2 className="text-sm font-medium">Create app password</h2>
          </div>

          <passwordForm.Field name="label">
            {(field) => (
              <label className="grid gap-1.5 text-xs font-medium" htmlFor="app-password-label">
                Label
                <Input
                  id="app-password-label"
                  onBlur={field.handleBlur}
                  onChange={(event) => field.handleChange(event.target.value)}
                  placeholder="Calendar sync"
                  required
                  value={field.state.value}
                />
              </label>
            )}
          </passwordForm.Field>

          <passwordForm.Field name="actorId">
            {(field) => (
              <div className="grid gap-2">
                <label className="grid gap-1.5 text-xs font-medium" htmlFor="app-password-actor-id">
                  Actor
                  {/* A native select over the loaded actors: a labelled form
                      control with type-ahead and platform focus behaviour, over
                      a request that returns one bounded page. */}
                  <select
                    aria-describedby={actorNotice === null ? undefined : ACTOR_STATUS_ID}
                    className={SELECT_CLASS}
                    disabled={!canPickActor}
                    id="app-password-actor-id"
                    onBlur={field.handleBlur}
                    onChange={(event) => field.handleChange(event.target.value)}
                    required
                    value={field.state.value}
                  >
                    <option value="">{actorPlaceholders[actorStatus]}</option>
                    {actors.map((actor) => (
                      <option key={actor.id} value={actor.id}>
                        {actorLabel(actor)}
                      </option>
                    ))}
                  </select>
                </label>
                {actorNotice === null ? null : (
                  <div id={ACTOR_STATUS_ID}>
                    <StateBanner kind={actorNotice.kind}>
                      {actorNotice.message}
                      {actorNotice.retryable ? (
                        <Button
                          className="mt-2"
                          onClick={() => void invalidateAdminUserLists(queryClient)}
                          size="xs"
                          type="button"
                          variant="outline"
                        >
                          <RotateCcw />
                          Retry
                        </Button>
                      ) : null}
                    </StateBanner>
                  </div>
                )}
              </div>
            )}
          </passwordForm.Field>

          <passwordForm.Field name="scopes">
            {(field) => {
              const selectedScopes = new Set(parseScopes(field.state.value));
              return (
                <div className="grid gap-2">
                  <label className="grid gap-1.5 text-xs font-medium" htmlFor="app-password-scopes">
                    Scopes
                    <textarea
                      className="min-h-20 rounded-md border border-input bg-input/20 px-2 py-1 text-xs outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30"
                      id="app-password-scopes"
                      onBlur={field.handleBlur}
                      onChange={(event) => field.handleChange(event.target.value)}
                      required
                      value={field.state.value}
                    />
                  </label>
                  <div className="flex flex-wrap gap-1" aria-label="Common app password scopes">
                    {commonScopes.map((scope) => {
                      const selected = selectedScopes.has(scope);
                      return (
                        <Button
                          aria-pressed={selected}
                          key={scope}
                          onClick={() =>
                            field.handleChange(toggleScope(field.state.value, scope, selected))
                          }
                          size="xs"
                          type="button"
                          variant={selected ? "secondary" : "outline"}
                        >
                          {scope}
                        </Button>
                      );
                    })}
                  </div>
                </div>
              );
            }}
          </passwordForm.Field>

          <passwordForm.Field name="expiresAt">
            {(field) => (
              <label className="grid gap-1.5 text-xs font-medium" htmlFor="app-password-expires-at">
                Expires at
                <Input
                  id="app-password-expires-at"
                  onBlur={field.handleBlur}
                  onChange={(event) => field.handleChange(event.target.value)}
                  type="datetime-local"
                  value={field.state.value}
                />
              </label>
            )}
          </passwordForm.Field>

          {formError !== null ? <StateBanner kind="error">{formError}</StateBanner> : null}
          {createMutation.isError ? (
            <StateBanner kind="error">
              {errorMessage(createMutation.error, "Could not create the app password.")}
            </StateBanner>
          ) : null}

          <Button
            aria-describedby={canPickActor ? undefined : ACTOR_STATUS_ID}
            disabled={createMutation.isPending || !canPickActor}
            type="submit"
            variant="default"
          >
            <Plus />
            {createMutation.isPending ? "Creating" : "Create app password"}
          </Button>

          {createdPassword !== null ? (
            <section
              aria-label="Created app password"
              className="grid gap-2 rounded-md border border-emerald-600/30 bg-emerald-600/10 p-3 text-xs"
            >
              <div className="flex items-center gap-2 font-medium text-emerald-800">
                <Check className="size-3.5" />
                Created
              </div>
              <label className="grid gap-1 font-medium" htmlFor="generated-app-password">
                Password
                <Input id="generated-app-password" readOnly value={createdPassword.password} />
              </label>
              <p className="text-muted-foreground">Shown once.</p>
              <p className="text-muted-foreground">
                Label: <code>{createdPassword.appPassword.label}</code>
              </p>
            </section>
          ) : null}
        </form>

        <section className="grid min-w-0 content-start gap-3 rounded-lg border border-border bg-card p-4">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h2 className="text-sm font-medium">Issued app passwords</h2>
              <p className="text-xs text-muted-foreground">
                {passwords.length} app password{passwords.length === 1 ? "" : "s"} returned
              </p>
            </div>
            <Button
              disabled={passwordsQuery.isFetching}
              onClick={() => void invalidateAppPasswordLists(queryClient)}
              size="sm"
              type="button"
              variant="outline"
            >
              <RotateCcw />
              Refresh
            </Button>
          </div>

          {passwordsQuery.isError ? (
            <StateBanner kind="error">
              {errorMessage(passwordsQuery.error, "Could not load app passwords.")}
            </StateBanner>
          ) : null}
          {revokeMutation.isError ? (
            <StateBanner kind="error">
              {errorMessage(revokeMutation.error, "Could not revoke the app password.")}
            </StateBanner>
          ) : null}

          <Table aria-label="App passwords">
            <TableHeader>
              {table.getHeaderGroups().map((headerGroup) => (
                <TableRow key={headerGroup.id}>
                  {headerGroup.headers.map((header) => (
                    <TableHead key={header.id}>
                      {header.isPlaceholder
                        ? null
                        : flexRender(header.column.columnDef.header, header.getContext())}
                    </TableHead>
                  ))}
                </TableRow>
              ))}
            </TableHeader>
            <TableBody>
              {passwordsQuery.isLoading || table.getRowModel().rows.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={columns.length}>
                    <EmptyRow>{passwordListMessage(passwordsQuery, includeRevoked)}</EmptyRow>
                  </TableCell>
                </TableRow>
              ) : (
                table.getRowModel().rows.map((row) => (
                  <TableRow key={row.id}>
                    {row.getVisibleCells().map((cell) => (
                      <TableCell key={cell.id}>
                        {flexRender(cell.column.columnDef.cell, cell.getContext())}
                      </TableCell>
                    ))}
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </section>
      </div>

      {/* The shared confirmation, not a fourth hand-rolled copy of the same
          AlertDialog stack — it is where the console's destructive-action policy
          is written down, so a section that rebuilds it drifts out of policy
          silently. Tier: irreversible, one object → name the target, no
          `blastRadius`. One app password authenticates one actor, and nothing
          here counts the clients holding it, so there is no second number
          honest enough to state. */}
      {passwordToRevoke === null ? null : (
        <ConfirmDestructive
          open
          onOpenChange={(next) => {
            if (!next) {
              setPasswordToRevoke(null);
            }
          }}
          title="Revoke app password"
          confirmLabel="Revoke"
          isPending={revokeMutation.isPending}
          /* `mutate`, not `mutateAsync`: nothing awaits the result, and a
             floating rejection surfaces as an unhandled promise rejection even
             though the banner already reports the failure. */
          onConfirm={() => {
            revokeMutation.mutate(passwordToRevoke.id);
          }}
        >
          <code>{passwordToRevoke.label}</code> stops authenticating as{" "}
          {revokeActorLabel === null ? <code>{passwordToRevoke.actorId}</code> : revokeActorLabel}.
          {passwordToRevoke.scopes.length === 0
            ? " Any client still using it fails on its next request."
            : ` Any client still using it loses ${passwordToRevoke.scopes.join(", ")} on its next request.`}{" "}
          The password cannot be shown again; a replacement has to be issued and re-entered on every
          device.
        </ConfirmDestructive>
      )}
    </section>
  );
}

function actorStatusOf(input: {
  readonly actorCount: number;
  readonly hasMore: boolean;
  readonly isError: boolean;
  readonly isPending: boolean;
}): ActorStatus {
  if (input.isError) {
    return "error";
  }
  if (input.isPending) {
    return "loading";
  }
  if (input.actorCount === 0) {
    return "empty";
  }
  return input.hasMore ? "truncated" : "ready";
}

function actorNoticeFor(
  status: ActorStatus,
  actorCount: number,
  error: unknown,
): ActorNotice | null {
  if (status === "error") {
    return {
      kind: "error",
      message: `${errorMessage(error, "Could not load actors.")} An app password is issued to an existing actor, so creation stays disabled until the list loads.`,
      retryable: true,
    };
  }
  if (status === "loading") {
    return { kind: "loading", message: "Loading actors…", retryable: false };
  }
  if (status === "empty") {
    return {
      kind: "info",
      message: "No enabled actors. Create or re-enable one before issuing an app password.",
      retryable: false,
    };
  }
  if (status === "truncated") {
    return {
      kind: "info",
      message: `Showing the first ${actorCount} enabled actors; the directory holds more. An actor beyond this page cannot be picked here.`,
      retryable: false,
    };
  }
  return null;
}

function actorLabel(actor: AdminUser): string {
  const displayName = actor.displayName.trim();
  const name = displayName.length > 0 ? displayName : (actor.email ?? actor.id);
  return actor.email === null || actor.email === name ? name : `${name} (${actor.email})`;
}

function passwordListMessage(
  passwordsQuery: { readonly isError: boolean; readonly isLoading: boolean },
  includeRevoked: boolean,
): string {
  if (passwordsQuery.isLoading) {
    return "Loading app passwords…";
  }
  if (passwordsQuery.isError) {
    return "App passwords could not be loaded.";
  }
  return includeRevoked
    ? "No app passwords have been issued."
    : "No active app passwords. Turn on “Include revoked” to see revoked ones.";
}

function normalizeCreateInput(value: AppPasswordFormState) {
  const actorId = value.actorId.trim();
  const label = value.label.trim();
  const scopes = parseScopes(value.scopes);
  const expiresAt = normalizeExpiresAt(value.expiresAt);

  if (label.length === 0) {
    return "Label is required.";
  }
  if (actorId.length === 0) {
    return "Select the actor this app password belongs to.";
  }
  if (scopes.length === 0) {
    return "At least one scope is required.";
  }
  if (expiresAt === invalidExpiresAt) {
    return "Expiration must be a valid date and time.";
  }

  return {
    actorId,
    label,
    scopes,
    ...(expiresAt === null ? {} : { expiresAt }),
  };
}

function parseScopes(value: string): string[] {
  return value
    .split(/[\s,]+/u)
    .map((scope) => scope.trim())
    .filter((scope) => scope.length > 0);
}

function toggleScope(value: string, scope: string, selected: boolean): string {
  const scopes = parseScopes(value).filter((candidate) => candidate !== scope);
  return (selected ? scopes : [...scopes, scope]).join(" ");
}

function normalizeExpiresAt(value: string): string | null | typeof invalidExpiresAt {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return null;
  }
  const date = new Date(trimmed);
  return Number.isNaN(date.getTime()) ? invalidExpiresAt : date.toISOString();
}

function formatDateTime(value: string | null): string | null {
  if (value === null) {
    return null;
  }
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.length > 0 ? error.message : fallback;
}

async function invalidateAppPasswordLists(
  queryClient: ReturnType<typeof useQueryClient>,
): Promise<void> {
  await queryClient.invalidateQueries({ queryKey: ["admin", "app-passwords"] });
}

async function invalidateAdminUserLists(
  queryClient: ReturnType<typeof useQueryClient>,
): Promise<void> {
  await queryClient.invalidateQueries({ queryKey: ["admin", "users"] });
}
