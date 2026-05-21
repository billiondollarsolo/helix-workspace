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
  agentCredentialsQueryOptions,
  createAgentCredential,
  revokeAgentCredential,
  type AgentCredential,
  type AgentCredentialCreateResult,
} from "./agent-credentials-api";

interface AgentCredentialFormState {
  readonly actorId: string;
  readonly scopes: string;
  readonly expiresAt: string;
}

const defaultFormValues: AgentCredentialFormState = {
  actorId: "",
  scopes: "platform.read tools:read",
  expiresAt: "",
};

const commonScopes = [
  "platform.read",
  "tools:read",
  "tools:write",
  "assistant.write",
  "assistant.memory",
  "mail.read",
  "mail.send",
  "drive.read",
  "drive.write",
  "calendar.read",
  "calendar.write",
  "docs.read",
  "docs.write",
  "admin.agents",
] as const;

const invalidExpiresAt = Symbol("invalidExpiresAt");

export function AgentCredentialsManagement() {
  const queryClient = useQueryClient();
  const [includeRevoked, setIncludeRevoked] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [createdCredential, setCreatedCredential] = useState<AgentCredentialCreateResult | null>(
    null,
  );
  const [credentialToRevoke, setCredentialToRevoke] = useState<AgentCredential | null>(null);
  const credentialsQuery = useQuery(agentCredentialsQueryOptions(includeRevoked));

  const createMutation = useMutation({
    mutationFn: (input: Parameters<typeof createAgentCredential>[0]) =>
      createAgentCredential(input),
    onMutate: () => {
      setCreatedCredential(null);
    },
    onError: () => undefined,
    onSuccess: async (result) => {
      setCreatedCredential(result);
      await invalidateAgentCredentialLists(queryClient);
    },
  });

  const revokeMutation = useMutation({
    mutationFn: (clientId: string) => revokeAgentCredential(clientId),
    onMutate: () => undefined,
    onError: () => undefined,
    onSuccess: async () => {
      setCredentialToRevoke(null);
      await invalidateAgentCredentialLists(queryClient);
    },
  });

  const credentials = credentialsQuery.data ?? [];
  const tableData = useMemo(() => [...credentials], [credentials]);
  const columns = useMemo<ColumnDef<AgentCredential>[]>(
    () => [
      {
        accessorKey: "clientId",
        header: "Client ID",
        cell: ({ row }) => (
          <code className="block max-w-[18rem] truncate rounded bg-muted px-1.5 py-0.5 text-[0.6875rem]">
            {row.original.clientId}
          </code>
        ),
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
            <span className="text-muted-foreground">Revoked {formatDateTime(row.original.revokedAt)}</span>
          ),
      },
      {
        id: "actions",
        header: "",
        cell: ({ row }) => (
          <Button
            aria-label={`Revoke credential ${row.original.clientId}`}
            disabled={row.original.revokedAt !== null || revokeMutation.isPending}
            onClick={() => setCredentialToRevoke(row.original)}
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

  const credentialForm = useForm({
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
      aria-labelledby="agent-credentials-title"
      className="mx-auto grid w-full max-w-7xl gap-4 px-4 py-4 sm:px-6 lg:px-8"
    >
      <header className="flex flex-col gap-3 rounded-lg border border-border bg-card p-4 text-card-foreground sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-1">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Agent credentials
          </p>
          <h2 className="text-xl font-semibold tracking-normal" id="agent-credentials-title">
            OAuth client credentials
          </h2>
          <p className="max-w-3xl text-sm text-muted-foreground">
            Create scoped client credentials for agent actors and revoke credentials that should no
            longer mint access tokens.
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

      <div className="grid gap-4 lg:grid-cols-[minmax(20rem,0.8fr)_minmax(0,1.2fr)]">
        <form
          className="grid gap-4 rounded-lg border border-border bg-card p-4"
          onSubmit={(event) => {
            event.preventDefault();
            void credentialForm.handleSubmit();
          }}
        >
          <div className="flex items-center gap-2">
            <KeyRound className="size-4 text-muted-foreground" />
            <h3 className="text-sm font-medium">Create credential</h3>
          </div>

          <credentialForm.Field name="actorId">
            {(field) => (
              <label className="grid gap-1.5 text-xs font-medium" htmlFor="agent-actor-id">
                Actor ID
                <Input
                  id="agent-actor-id"
                  onBlur={field.handleBlur}
                  onChange={(event) => field.handleChange(event.target.value)}
                  placeholder="00000000-0000-4000-8000-000000000000"
                  required
                  value={field.state.value}
                />
              </label>
            )}
          </credentialForm.Field>

          <credentialForm.Field name="scopes">
            {(field) => {
              const selectedScopes = new Set(parseScopes(field.state.value));
              return (
                <div className="grid gap-2">
                  <label className="grid gap-1.5 text-xs font-medium" htmlFor="agent-scopes">
                    Scopes
                    <textarea
                      className="min-h-20 rounded-md border border-input bg-input/20 px-2 py-1 text-xs outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30"
                      id="agent-scopes"
                      onBlur={field.handleBlur}
                      onChange={(event) => field.handleChange(event.target.value)}
                      required
                      value={field.state.value}
                    />
                  </label>
                  <div className="flex flex-wrap gap-1" aria-label="Common scopes">
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
          </credentialForm.Field>

          <credentialForm.Field name="expiresAt">
            {(field) => (
              <label className="grid gap-1.5 text-xs font-medium" htmlFor="agent-expires-at">
                Expires at
                <Input
                  id="agent-expires-at"
                  onBlur={field.handleBlur}
                  onChange={(event) => field.handleChange(event.target.value)}
                  type="datetime-local"
                  value={field.state.value}
                />
              </label>
            )}
          </credentialForm.Field>

          {formError !== null ? (
            <p className="rounded-md border border-destructive/30 bg-destructive/10 px-2 py-1 text-xs text-destructive" role="alert">
              {formError}
            </p>
          ) : null}
          {createMutation.isError ? (
            <p className="rounded-md border border-destructive/30 bg-destructive/10 px-2 py-1 text-xs text-destructive" role="alert">
              {errorMessage(createMutation.error, "Could not create the agent credential.")}
            </p>
          ) : null}

          <Button disabled={createMutation.isPending} type="submit">
            <Plus />
            {createMutation.isPending ? "Creating" : "Create credential"}
          </Button>

          {createdCredential !== null ? (
            <section
              aria-label="Created credential secret"
              className="grid gap-2 rounded-md border border-emerald-600/30 bg-emerald-600/10 p-3 text-xs"
            >
              <div className="flex items-center gap-2 font-medium text-emerald-800">
                <Check className="size-3.5" />
                Created
              </div>
              <label className="grid gap-1 font-medium" htmlFor="agent-client-secret">
                Client secret
                <Input id="agent-client-secret" readOnly value={createdCredential.clientSecret} />
              </label>
              <p className="text-muted-foreground">
                Client ID: <code>{createdCredential.credential.clientId}</code>
              </p>
              <p className="text-muted-foreground">
                Token endpoint: <code>{createdCredential.tokenEndpoint}</code>
              </p>
            </section>
          ) : null}
        </form>

        <section className="grid min-w-0 gap-3 rounded-lg border border-border bg-card p-4">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h3 className="text-sm font-medium">Issued credentials</h3>
              <p className="text-xs text-muted-foreground">
                {credentials.length} credential{credentials.length === 1 ? "" : "s"} returned
              </p>
            </div>
            <Button
              disabled={credentialsQuery.isFetching}
              onClick={() => void invalidateAgentCredentialLists(queryClient)}
              size="sm"
              type="button"
              variant="outline"
            >
              <RotateCcw />
              Refresh
            </Button>
          </div>

          {credentialsQuery.isError ? (
            <p className="rounded-md border border-destructive/30 bg-destructive/10 px-2 py-1 text-xs text-destructive" role="alert">
              {errorMessage(credentialsQuery.error, "Could not load agent credentials.")}
            </p>
          ) : null}
          {revokeMutation.isError ? (
            <p className="rounded-md border border-destructive/30 bg-destructive/10 px-2 py-1 text-xs text-destructive" role="alert">
              {errorMessage(revokeMutation.error, "Could not revoke the agent credential.")}
            </p>
          ) : null}

          <Table aria-label="Agent credentials">
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
              {credentialsQuery.isLoading ? (
                <TableRow>
                  <TableCell colSpan={columns.length}>Loading credentials</TableCell>
                </TableRow>
              ) : table.getRowModel().rows.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={columns.length}>No agent credentials found.</TableCell>
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
        open={credentialToRevoke !== null}
        onOpenChange={(open) => {
          if (!open) {
            setCredentialToRevoke(null);
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogMedia>
              <ShieldAlert />
            </AlertDialogMedia>
            <AlertDialogTitle>Revoke agent credential</AlertDialogTitle>
            <AlertDialogDescription>
              This credential will stop minting OAuth access tokens for actor{" "}
              <code>{credentialToRevoke?.actorId}</code>.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={revokeMutation.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={credentialToRevoke === null || revokeMutation.isPending}
              onClick={(event) => {
                event.preventDefault();
                if (credentialToRevoke !== null) {
                  void revokeMutation.mutateAsync(credentialToRevoke.clientId);
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

function normalizeCreateInput(value: AgentCredentialFormState) {
  const actorId = value.actorId.trim();
  const scopes = parseScopes(value.scopes);
  const expiresAt = normalizeExpiresAt(value.expiresAt);

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

async function invalidateAgentCredentialLists(
  queryClient: ReturnType<typeof useQueryClient>,
): Promise<void> {
  await queryClient.invalidateQueries({ queryKey: ["admin", "agent-credentials"] });
}
