import { ScopeChips } from "@/features/admin/console/widgets";
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
import {
  adminAgentsQueryKey,
  adminAgentsQueryOptions,
  createAdminAgent,
  type AdminAgent,
} from "@/features/admin/agent-secrets-api";
import { ConfirmDestructive } from "@/features/admin/console/confirm-destructive";
import {
  EmptyRow,
  PageHeading,
  ErrorNotice,
  StatusChip,
} from "@/features/admin/console/primitives";
import { AdminField, AdminInput, AdminSelect } from "@/features/admin/console/controls";
import {
  ActorNoticeBanner,
  ActorSelectField,
  ExpiresAtField,
  ScopesField,
} from "@/features/admin/credentials-form-fields";
import {
  actorStatusOf,
  errorMessage,
  invalidExpiresAt,
  normalizeExpiresAt,
  parseScopes,
  type ActorStatus,
} from "@/features/admin/credentials-shared";
import {
  agentCredentialsQueryOptions,
  createAgentCredential,
  revokeAgentCredential,
  type AgentCredential,
  type AgentCredentialCreateResult,
  type AgentCredentialType,
} from "./agent-credentials-api";

interface AgentCredentialFormState {
  readonly actorId: string;
  readonly credentialType: AgentCredentialType;
  readonly label: string;
  readonly purpose: string;
  readonly scopes: string;
  readonly expiresAt: string;
}

interface ActorGroup {
  readonly type: AdminAgent["type"];
  readonly label: string;
  readonly actors: readonly AdminAgent[];
}

interface ActorDirectoryStatus {
  readonly kind: "loading" | "error" | "info";
  readonly message: string;
}

const DEFAULT_LIFETIME_DAYS = 90;
/** The server refuses a credential that would live longer than this. */
const MAX_LIFETIME_DAYS = 366;

/** `days` from now, in the form a `datetime-local` input holds. */
function localDateTimeIn(days: number): string {
  const date = new Date(Date.now() + days * 86_400_000);
  date.setMinutes(date.getMinutes() - date.getTimezoneOffset(), 0, 0);
  return date.toISOString().slice(0, 16);
}

function defaultFormValues(): AgentCredentialFormState {
  return {
    actorId: "",
    credentialType: "api_key",
    label: "",
    purpose: "",
    scopes: "platform.read tools:read",
    expiresAt: localDateTimeIn(DEFAULT_LIFETIME_DAYS),
  };
}

const credentialTypes: readonly { readonly type: AgentCredentialType; readonly label: string }[] = [
  { type: "api_key", label: "API key" },
  { type: "oauth_client", label: "OAuth client" },
];

/** The day is enough in the table; the form sets the exact time. */
const expiryDate = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });

const credentialTypeLabel = (type: AgentCredential["credentialType"]) =>
  type === "mtls_cert"
    ? "Client certificate"
    : (credentialTypes.find((candidate) => candidate.type === type)?.label ?? type);

const commonScopes = [
  "platform.read",
  "tools:read",
  "tools:write",
  "secrets.use",
  "assistant.write",
  "assistant.memory",
  "mail.read",
  "mail.send",
  "drive.read",
  "drive.write",
  "calendar.read",
  "calendar.write",
] as const;

/** The picker's status banner; referenced by the controls it explains. */
const ACTOR_STATUS_ID = "agent-actor-status";

/* A disabled picker still shows its first option, so that option has to say
   which of the three reasons it is empty for. */
const actorPlaceholders: Record<ActorStatus, string> = {
  loading: "Loading agents…",
  error: "Agents unavailable",
  empty: "No agents yet",
  truncated: "Select an agent",
  ready: "Select an agent",
};

export function AgentCredentialsManagement() {
  const queryClient = useQueryClient();
  const [includeRevoked, setIncludeRevoked] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [createdCredential, setCreatedCredential] = useState<AgentCredentialCreateResult | null>(
    null,
  );
  const [credentialToRevoke, setCredentialToRevoke] = useState<AgentCredential | null>(null);
  const credentialsQuery = useQuery(agentCredentialsQueryOptions(includeRevoked));
  /* Credentials are issued to agents and service accounts only. Their list
     drives both the picker and the id -> name lookup that every agent id in
     this section is rendered through. */
  const actorsQuery = useQuery(adminAgentsQueryOptions());
  const [newAgentName, setNewAgentName] = useState("");

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

  const addAgentMutation = useMutation({
    mutationFn: (displayName: string) => createAdminAgent({ displayName, description: "" }),
    onMutate: () => undefined,
    onError: () => undefined,
    onSuccess: async (agent) => {
      setNewAgentName("");
      await queryClient.invalidateQueries({ queryKey: adminAgentsQueryKey });
      credentialForm.setFieldValue("actorId", agent.id);
    },
  });

  const revokeMutation = useMutation({
    mutationFn: (credentialId: string) => revokeAgentCredential(credentialId),
    onMutate: () => undefined,
    onError: () => undefined,
    onSuccess: async () => {
      setCredentialToRevoke(null);
      await invalidateAgentCredentialLists(queryClient);
    },
  });

  const allActors = useMemo(() => actorsQuery.data ?? [], [actorsQuery.data]);
  const actors = useMemo(() => allActors.filter((actor) => !actor.disabled), [allActors]);
  const actorsById = useMemo(
    () => new Map(allActors.map((actor) => [actor.id, actor] as const)),
    [allActors],
  );
  const actorGroups = useMemo(() => groupActorsByType(actors), [actors]);
  const canPickActor = !actorsQuery.isLoading && !actorsQuery.isError && actors.length > 0;
  const actorStatus = actorStatusOf({
    actorCount: actors.length,
    hasMore: false,
    isError: actorsQuery.isError,
    isPending: actorsQuery.isLoading,
  });
  const actorNotice = useMemo<ActorDirectoryStatus | null>(() => {
    if (actorStatus === "loading") {
      return { kind: "loading", message: "Loading agents…" };
    }
    if (actorStatus === "error") {
      return {
        kind: "error",
        message: `${errorMessage(actorsQuery.error, "Could not load agents.")} Credentials cannot be issued until the list loads.`,
      };
    }
    if (actorStatus === "empty") {
      return {
        kind: "info",
        message: "There are no agents yet. Add one below, then issue it a credential.",
      };
    }
    return null;
  }, [actorStatus, actorsQuery.error]);

  const credentials = credentialsQuery.data ?? [];
  const tableData = useMemo(() => [...credentials], [credentials]);
  const columns = useMemo<ColumnDef<AgentCredential>[]>(
    () => [
      {
        accessorKey: "label",
        header: "Credential",
        cell: ({ row }) => (
          <div className="grid max-w-[10rem] min-w-[7rem] gap-0.5">
            <span className="truncate font-medium">{row.original.label}</span>
            <span className="truncate type-caption text-muted-foreground">
              {credentialTypeLabel(row.original.credentialType)}
              {row.original.clientId === null ? "" : ` · ${row.original.clientId}`}
            </span>
          </div>
        ),
      },
      {
        accessorKey: "actorId",
        header: "Agent",
        cell: ({ row }) => {
          /* Not in the list means it is not one of this organization's agents
             or service accounts: show the id rather than inventing a name. */
          const actor = actorsById.get(row.original.actorId);
          return actor === undefined ? (
            <code className="block max-w-[6rem] truncate type-caption text-muted-foreground">
              {row.original.actorId}
            </code>
          ) : (
            <span className="block max-w-[8rem] min-w-[5rem] truncate font-medium">
              {actor.displayName}
              {actor.disabled ? " (disabled)" : ""}
            </span>
          );
        },
      },
      {
        accessorKey: "scopes",
        header: "Scopes",
        cell: ({ row }) => <ScopeChips scopes={row.original.scopes} />,
      },
      {
        /* One column for both: a credential is active until it expires or is
           revoked, and the table has no room to say so twice. */
        id: "status",
        header: "Status",
        cell: ({ row }) =>
          row.original.revokedAt !== null ? (
            <span className="text-muted-foreground">
              Revoked {expiryDate.format(new Date(row.original.revokedAt))}
            </span>
          ) : (
            <div className="grid justify-items-start gap-1">
              <StatusChip tone="success" label="Active" />
              <span className="whitespace-nowrap type-caption text-muted-foreground">
                {row.original.expiresAt === null
                  ? "Does not expire"
                  : `Until ${expiryDate.format(new Date(row.original.expiresAt))}`}
              </span>
            </div>
          ),
      },
      {
        id: "actions",
        /* Not `""`: an empty <th> gives screen readers an unnamed column.
           Visually hidden text names it without adding a visible caption to a
           column of icon buttons. */
        header: () => <span className="sr-only">Credential actions</span>,
        cell: ({ row }) => (
          <Button
            aria-label={`Revoke credential ${row.original.label}`}
            disabled={row.original.revokedAt !== null || revokeMutation.isPending}
            onClick={() => setCredentialToRevoke(row.original)}
            size="sm"
            title="Revoke"
            type="button"
            variant="destructive"
          >
            <Trash2 />
            {/* The row has no room for the word; the name above carries it. */}
            <span className="sr-only">Revoke</span>
          </Button>
        ),
      },
    ],
    [actorsById, revokeMutation.isPending],
  );
  const table = useReactTable({
    data: tableData,
    columns,
    getCoreRowModel: getCoreRowModel(),
  });

  const credentialForm = useForm({
    defaultValues: defaultFormValues(),
    onSubmit: ({ value }) => {
      const normalized = normalizeCreateInput(value);
      if (typeof normalized === "string") {
        setFormError(normalized);
        return;
      }
      setFormError(null);
      // `mutate`: the banner reports a refusal, and nothing awaits the result.
      createMutation.mutate(normalized);
    },
  });

  const revokeTargetActor =
    credentialToRevoke === null ? undefined : actorsById.get(credentialToRevoke.actorId);

  return (
    /* No PageScroll here: `agent-credentials` is registered through
       `withPageScroll` in admin-console.tsx, which already supplies it. */
    <section className="grid gap-4">
      <PageHeading
        title="Agent credentials"
        subtitle="Agents, and the API keys and OAuth clients that let them call the API with limited scopes."
      />

      <div className="grid items-start gap-4 lg:grid-cols-[minmax(20rem,0.8fr)_minmax(0,1.2fr)]">
        <form
          className="grid content-start gap-4 rounded-lg border border-border bg-card p-4"
          onSubmit={(event) => {
            event.preventDefault();
            void credentialForm.handleSubmit();
          }}
        >
          <div className="flex items-center gap-2">
            <KeyRound className="size-4 text-muted-foreground" />
            <h2 className="text-sm font-medium">Create credential</h2>
          </div>

          {actorNotice !== null ? (
            <ActorNoticeBanner
              id={ACTOR_STATUS_ID}
              kind={actorNotice.kind}
              message={actorNotice.message}
              /* Only the failed-directory notice has a way back to offer; the
                 empty and truncated ones are answers, not faults. */
              retryable={actorNotice.kind === "error"}
              onRetry={() => {
                void queryClient.invalidateQueries({ queryKey: adminAgentsQueryKey });
              }}
            />
          ) : null}

          <credentialForm.Field name="actorId">
            {(field) => (
              <ActorSelectField
                id="agent-actor-id"
                describedBy={actorNotice === null ? undefined : ACTOR_STATUS_ID}
                disabled={!canPickActor}
                placeholder={actorPlaceholders[actorStatus]}
                value={field.state.value}
                onBlur={field.handleBlur}
                onChange={(value) => field.handleChange(value)}
              >
                {actorGroups.map((group) => (
                  <optgroup key={group.type} label={group.label}>
                    {group.actors.map((actor) => (
                      <option key={actor.id} value={actor.id}>
                        {actor.displayName}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </ActorSelectField>
            )}
          </credentialForm.Field>

          {/* An agent is only a name until it holds a credential, so adding one
              belongs beside issuing its first credential. Not a nested form:
              Enter in this box must not submit the credential. */}
          <div className="grid gap-1.5">
            <AdminField label="New agent name">
              <AdminInput
                maxLength={120}
                onChange={(event) => setNewAgentName(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key !== "Enter") return;
                  event.preventDefault();
                  if (newAgentName.trim() !== "") addAgentMutation.mutate(newAgentName.trim());
                }}
                placeholder="Release bot"
                value={newAgentName}
              />
            </AdminField>
            <Button
              className="justify-self-start"
              disabled={addAgentMutation.isPending || newAgentName.trim() === ""}
              onClick={() => addAgentMutation.mutate(newAgentName.trim())}
              size="sm"
              type="button"
              variant="outline"
            >
              <Plus />
              {addAgentMutation.isPending ? "Adding" : "Add agent"}
            </Button>
            {addAgentMutation.isError ? (
              <ErrorNotice>
                {errorMessage(addAgentMutation.error, "Could not add the agent.")}
              </ErrorNotice>
            ) : null}
          </div>

          <credentialForm.Field name="credentialType">
            {(field) => (
              <AdminField label="Type">
                <AdminSelect
                  onBlur={field.handleBlur}
                  onChange={(event) =>
                    field.handleChange(event.target.value as AgentCredentialType)
                  }
                  value={field.state.value}
                >
                  {credentialTypes.map((option) => (
                    <option key={option.type} value={option.type}>
                      {option.label}
                    </option>
                  ))}
                </AdminSelect>
              </AdminField>
            )}
          </credentialForm.Field>

          <credentialForm.Field name="label">
            {(field) => (
              <AdminField label="Label">
                <AdminInput
                  maxLength={200}
                  onBlur={field.handleBlur}
                  onChange={(event) => field.handleChange(event.target.value)}
                  placeholder="Release pipeline key"
                  required
                  value={field.state.value}
                />
              </AdminField>
            )}
          </credentialForm.Field>

          <credentialForm.Field name="purpose">
            {(field) => (
              <AdminField label="What it is for">
                <AdminInput
                  maxLength={500}
                  onBlur={field.handleBlur}
                  onChange={(event) => field.handleChange(event.target.value)}
                  placeholder="Publishes release notes from CI"
                  required
                  value={field.state.value}
                />
              </AdminField>
            )}
          </credentialForm.Field>

          <credentialForm.Field name="scopes">
            {(field) => (
              <ScopesField
                id="agent-scopes"
                scopes={commonScopes}
                scopesLabel="Common scopes"
                value={field.state.value}
                onBlur={field.handleBlur}
                onChange={(value) => field.handleChange(value)}
              />
            )}
          </credentialForm.Field>

          <credentialForm.Field name="expiresAt">
            {(field) => (
              <ExpiresAtField
                id="agent-expires-at"
                value={field.state.value}
                onBlur={field.handleBlur}
                onChange={(value) => field.handleChange(value)}
              />
            )}
          </credentialForm.Field>

          {formError !== null ? <ErrorNotice>{formError}</ErrorNotice> : null}
          {createMutation.isError ? (
            <ErrorNotice>
              {errorMessage(createMutation.error, "Could not create the agent credential.")}
            </ErrorNotice>
          ) : null}

          <Button
            aria-describedby={canPickActor ? undefined : ACTOR_STATUS_ID}
            disabled={createMutation.isPending || !canPickActor}
            type="submit"
          >
            <Plus />
            {createMutation.isPending ? "Creating" : "Create credential"}
          </Button>

          {createdCredential !== null ? (
            <section
              aria-label="Created credential secret"
              className="grid gap-2 rounded-md border border-[var(--success)] p-3 text-xs"
            >
              <div className="flex items-center gap-2 font-medium text-[var(--success)]">
                <Check className="size-3.5" />
                Created
              </div>
              <label className="grid gap-1 font-medium" htmlFor="agent-client-secret">
                {createdCredential.credential.credentialType === "api_key"
                  ? "API key"
                  : "Client secret"}
                <Input id="agent-client-secret" readOnly value={createdCredential.secret ?? ""} />
              </label>
              <p className="text-muted-foreground">
                Copy it now. It cannot be shown again.
                {createdCredential.credential.credentialType === "api_key"
                  ? " Send it in the x-api-key header."
                  : ""}
              </p>
              {createdCredential.credential.clientId === null ? null : (
                <p className="text-muted-foreground">
                  Client ID: <code>{createdCredential.credential.clientId}</code>
                </p>
              )}
              {createdCredential.tokenEndpoint === undefined ? null : (
                <p className="text-muted-foreground">
                  Token endpoint: <code>{createdCredential.tokenEndpoint}</code>
                </p>
              )}
            </section>
          ) : null}
        </form>

        <section className="grid min-w-0 content-start gap-3 rounded-lg border border-border bg-card p-4">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h2 className="text-sm font-medium">Issued credentials</h2>
              <p className="text-xs text-muted-foreground">
                {credentials.length} credential{credentials.length === 1 ? "" : "s"} returned
              </p>
            </div>
            <div className="flex items-center gap-3">
              <label className="inline-flex items-center gap-2 text-xs text-muted-foreground">
                <input
                  checked={includeRevoked}
                  className="size-3.5"
                  onChange={(event) => setIncludeRevoked(event.target.checked)}
                  type="checkbox"
                />
                Include revoked
              </label>
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
          </div>

          {credentialsQuery.isError ? (
            <ErrorNotice>
              {errorMessage(credentialsQuery.error, "Could not load agent credentials.")}
            </ErrorNotice>
          ) : null}
          {revokeMutation.isError ? (
            <ErrorNotice>
              {errorMessage(revokeMutation.error, "Could not revoke the agent credential.")}
            </ErrorNotice>
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
                  <TableCell colSpan={columns.length}>
                    <EmptyRow>Loading credentials…</EmptyRow>
                  </TableCell>
                </TableRow>
              ) : credentialsQuery.isError ? (
                /* `credentials` falls back to [] on failure, so without this
                   branch a failed request rendered the same sentence as a
                   genuinely empty workspace — a positive claim about state we
                   could not read. */
                <TableRow>
                  <TableCell colSpan={columns.length}>
                    <EmptyRow>Could not load credentials.</EmptyRow>
                  </TableCell>
                </TableRow>
              ) : table.getRowModel().rows.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={columns.length}>
                    <EmptyRow>
                      {includeRevoked
                        ? "No credentials have been issued in this workspace yet."
                        : "No active credentials. Select “Include revoked” to see credentials that were already revoked."}
                    </EmptyRow>
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

      {/* The shared confirmation rather than a private copy of the AlertDialog
          stack: the policy for destructive admin actions is written in that one
          component, and a section that rebuilds the markup drifts away from it
          without anything failing. Tier: irreversible, one object → name the
          target, no `blastRadius`. One credential mints tokens for one actor,
          and nothing here counts the agents holding it. */}
      {credentialToRevoke === null ? null : (
        <ConfirmDestructive
          open
          onOpenChange={(next) => {
            if (!next) {
              setCredentialToRevoke(null);
            }
          }}
          title="Revoke agent credential"
          confirmLabel="Revoke"
          isPending={revokeMutation.isPending}
          /* `mutate`, not `mutateAsync`: nothing awaits the result, and a
             floating rejection surfaces as an unhandled promise rejection even
             though the banner already reports the failure. */
          onConfirm={() => {
            revokeMutation.mutate(credentialToRevoke.id);
          }}
        >
          {credentialToRevoke.label} stops working for{" "}
          {revokeTargetActor === undefined
            ? "an agent that is no longer active"
            : revokeTargetActor.displayName}
          .
          {credentialToRevoke.scopes.length === 0
            ? ""
            : ` Anything using it loses ${credentialToRevoke.scopes.join(", ")}.`}{" "}
          The secret cannot be shown again, so restoring access means issuing a new credential and
          redeploying it.
        </ConfirmDestructive>
      )}
    </section>
  );
}

function normalizeCreateInput(value: AgentCredentialFormState) {
  const actorId = value.actorId.trim();
  const scopes = parseScopes(value.scopes);
  const expiresAt = normalizeExpiresAt(value.expiresAt);

  if (actorId.length === 0) {
    return "Select the agent this credential is for.";
  }
  if (value.label.trim().length === 0 || value.purpose.trim().length === 0) {
    return "Give the credential a label and say what it is for.";
  }
  if (scopes.length === 0) {
    return "At least one scope is required.";
  }
  if (expiresAt === invalidExpiresAt || expiresAt === null) {
    return "Choose when the credential expires.";
  }
  const lifetimeDays = (new Date(expiresAt).getTime() - Date.now()) / 86_400_000;
  if (lifetimeDays <= 0 || lifetimeDays > MAX_LIFETIME_DAYS) {
    return `The credential must expire within ${String(MAX_LIFETIME_DAYS)} days.`;
  }

  return {
    actorId,
    credentialType: value.credentialType,
    label: value.label.trim(),
    purpose: value.purpose.trim(),
    scopes,
    expiresAt,
  };
}

const actorGroupLabels: Record<AdminAgent["type"], string> = {
  agent: "Agents",
  service_account: "Service accounts",
};

/* Agents first: this form exists to credential agents. */
function groupActorsByType(actors: readonly AdminAgent[]): readonly ActorGroup[] {
  return (["agent", "service_account"] as const).flatMap((type) => {
    const group = actors
      .filter((actor) => actor.type === type)
      .sort((left, right) => left.displayName.localeCompare(right.displayName));
    return group.length === 0 ? [] : [{ type, label: actorGroupLabels[type], actors: group }];
  });
}

async function invalidateAgentCredentialLists(
  queryClient: ReturnType<typeof useQueryClient>,
): Promise<void> {
  await queryClient.invalidateQueries({ queryKey: ["admin", "agent-credentials"] });
}
