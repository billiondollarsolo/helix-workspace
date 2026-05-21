import { useForm } from "@tanstack/react-form";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { flexRender, getCoreRowModel, useReactTable, type ColumnDef } from "@tanstack/react-table";
import { Check, KeyRound, Plus, RotateCcw, ShieldAlert, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
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

const invalidExpiresAt = Symbol("invalidExpiresAt");

export function AppPasswordsManagement() {
  const queryClient = useQueryClient();
  const [includeRevoked, setIncludeRevoked] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [createdPassword, setCreatedPassword] = useState<AppPasswordCreateResult | null>(null);
  const [passwordToRevoke, setPasswordToRevoke] = useState<AppPassword | null>(null);
  const passwordsQuery = useQuery(appPasswordsQueryOptions(includeRevoked));

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
        cell: ({ row }) => (
          <code className="block max-w-[18rem] truncate text-[0.6875rem] text-muted-foreground">
            {row.original.actorId}
          </code>
        ),
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
    [revokeMutation.isPending],
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

  return (
    <section
      aria-labelledby="app-passwords-title"
      className="mx-auto grid w-full max-w-7xl gap-4 px-4 py-4 sm:px-6 lg:px-8"
    >
      <header className="flex flex-col gap-3 rounded-lg border border-border bg-card p-4 text-card-foreground sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-1">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            App passwords
          </p>
          <h2 className="text-xl font-semibold tracking-normal" id="app-passwords-title">
            Scoped app access
          </h2>
          <p className="max-w-3xl text-sm text-muted-foreground">
            Issue one-time app passwords for protocol clients and revoke access that should no
            longer be usable.
          </p>
        </div>
        <label className="inline-flex items-center gap-2 text-xs text-muted-foreground">
          <input
            checked={includeRevoked}
            className="size-3.5"
            onChange={(event) => setIncludeRevoked(event.target.checked)}
            type="checkbox"
          />
          Include revoked
        </label>
      </header>

      <div className="grid gap-4 lg:grid-cols-[minmax(20rem,0.75fr)_minmax(0,1.25fr)]">
        <form
          className="grid gap-4 rounded-lg border border-border bg-card p-4"
          onSubmit={(event) => {
            event.preventDefault();
            void passwordForm.handleSubmit();
          }}
        >
          <div className="flex items-center gap-2">
            <KeyRound className="size-4 text-muted-foreground" />
            <h3 className="text-sm font-medium">Create app password</h3>
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
              <label className="grid gap-1.5 text-xs font-medium" htmlFor="app-password-actor-id">
                Actor ID
                <Input
                  id="app-password-actor-id"
                  onBlur={field.handleBlur}
                  onChange={(event) => field.handleChange(event.target.value)}
                  placeholder="00000000-0000-4000-8000-000000000000"
                  required
                  value={field.state.value}
                />
              </label>
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

          {formError !== null ? (
            <p
              className="rounded-md border border-destructive/30 bg-destructive/10 px-2 py-1 text-xs text-destructive"
              role="alert"
            >
              {formError}
            </p>
          ) : null}
          {createMutation.isError ? (
            <p
              className="rounded-md border border-destructive/30 bg-destructive/10 px-2 py-1 text-xs text-destructive"
              role="alert"
            >
              {errorMessage(createMutation.error, "Could not create the app password.")}
            </p>
          ) : null}

          <Button disabled={createMutation.isPending} type="submit">
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

        <section className="grid min-w-0 gap-3 rounded-lg border border-border bg-card p-4">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h3 className="text-sm font-medium">Issued app passwords</h3>
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
            <p
              className="rounded-md border border-destructive/30 bg-destructive/10 px-2 py-1 text-xs text-destructive"
              role="alert"
            >
              {errorMessage(passwordsQuery.error, "Could not load app passwords.")}
            </p>
          ) : null}
          {revokeMutation.isError ? (
            <p
              className="rounded-md border border-destructive/30 bg-destructive/10 px-2 py-1 text-xs text-destructive"
              role="alert"
            >
              {errorMessage(revokeMutation.error, "Could not revoke the app password.")}
            </p>
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
              {passwordsQuery.isLoading ? (
                <TableRow>
                  <TableCell colSpan={columns.length}>Loading app passwords</TableCell>
                </TableRow>
              ) : table.getRowModel().rows.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={columns.length}>No app passwords found.</TableCell>
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

      <AlertDialog
        open={passwordToRevoke !== null}
        onOpenChange={(open) => {
          if (!open) {
            setPasswordToRevoke(null);
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogMedia>
              <ShieldAlert />
            </AlertDialogMedia>
            <AlertDialogTitle>Revoke app password</AlertDialogTitle>
            <AlertDialogDescription>
              This app password for <code>{passwordToRevoke?.label}</code> will stop authenticating.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={revokeMutation.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={passwordToRevoke === null || revokeMutation.isPending}
              onClick={(event) => {
                event.preventDefault();
                if (passwordToRevoke !== null) {
                  void revokeMutation.mutateAsync(passwordToRevoke.id);
                }
              }}
              variant="destructive"
            >
              Revoke
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
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
    return "Actor ID is required.";
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
