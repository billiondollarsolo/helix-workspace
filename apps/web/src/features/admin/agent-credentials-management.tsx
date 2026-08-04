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
import type { AdminUser } from "@/features/admin/admin-users";
import { AdminAccessRelatedNav } from "@/features/admin/admin-related-nav";
import { ConfirmDestructive } from "@/features/admin/console/confirm-destructive";
import { EmptyRow, PageHeading, StateBanner } from "@/features/admin/console/primitives";
import {
  ActorNoticeBanner,
  ActorSearchField,
  ActorSelectField,
  ExpiresAtField,
  ScopesField,
  useActorPicker,
} from "@/features/admin/credentials-form-fields";
import {
  actorStatusOf,
  errorMessage,
  formatDateTime,
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
} from "./agent-credentials-api";

interface AgentCredentialFormState {
  readonly actorId: string;
  readonly scopes: string;
  readonly expiresAt: string;
}

interface ActorGroup {
  readonly type: string;
  readonly label: string;
  readonly actors: readonly AdminUser[];
}

interface ActorDirectoryStatus {
  readonly kind: "loading" | "error" | "info";
  readonly message: string;
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

const AGENT_ACTOR_TYPE = "agent";

/** The picker's status banner; referenced by the controls it explains. */
const ACTOR_STATUS_ID = "agent-actor-status";

/* A disabled picker still shows its first option, so that option has to say
   which of the three reasons it is empty for. */
const actorPlaceholders: Record<ActorStatus, string> = {
  loading: "Loading actors…",
  error: "Actor directory unavailable",
  empty: "No actors available",
  truncated: "Select an actor",
  ready: "Select an actor",
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
  /* A credential is minted for an actor id the admin cannot be expected to know
     by heart, so the directory drives both the picker and the id -> name lookup
     that every actor id in this section is rendered through. */
  const { actorsQuery, searchDraft: actorSearchDraft, onSearchChange } = useActorPicker();

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

  const actors = useMemo(() => actorsQuery.data?.users ?? [], [actorsQuery.data]);
  const actorsById = useMemo(
    () => new Map(actors.map((actor) => [actor.id, actor] as const)),
    [actors],
  );
  const actorGroups = useMemo(() => groupActorsByType(actors), [actors]);
  const canPickActor = !actorsQuery.isLoading && !actorsQuery.isError && actors.length > 0;
  const actorStatus = actorStatusOf({
    actorCount: actors.length,
    hasMore: (actorsQuery.data?.nextCursor ?? null) !== null,
    isError: actorsQuery.isError,
    isPending: actorsQuery.isLoading,
  });
  const actorNotice = useMemo<ActorDirectoryStatus | null>(() => {
    if (actorStatus === "loading") {
      return { kind: "loading", message: "Loading workspace actors…" };
    }
    if (actorStatus === "error") {
      return {
        kind: "error",
        message: `${errorMessage(actorsQuery.error, "Could not load workspace actors.")} Credentials cannot be issued until the actor directory loads.`,
      };
    }
    if (actorStatus === "empty") {
      return {
        kind: "info",
        message:
          "This workspace has no enabled actors, so there is nothing to issue a credential to.",
      };
    }
    if (actorStatus === "truncated") {
      return {
        kind: "info",
        message: `Showing the first ${actors.length} enabled actors; the directory holds more.`,
      };
    }
    return null;
  }, [actorStatus, actorsQuery.error, actors.length]);

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
        cell: ({ row }) => {
          /* Absent from the directory means disabled or deleted, not "no actor":
             show the id alone rather than inventing a name for it. */
          const actor = actorsById.get(row.original.actorId);
          return (
            <div className="grid max-w-[18rem] gap-0.5">
              {actor === undefined ? null : (
                <span className="truncate font-medium">{actorLabel(actor)}</span>
              )}
              <code className="block truncate text-[0.6875rem] text-muted-foreground">
                {row.original.actorId}
              </code>
            </div>
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
        /* Not `""`: an empty <th> gives screen readers an unnamed column.
           Visually hidden text names it without adding a visible caption to a
           column of icon buttons. */
        header: () => <span className="sr-only">Credential actions</span>,
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
    [actorsById, revokeMutation.isPending],
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

  const revokeTargetActor =
    credentialToRevoke === null ? undefined : actorsById.get(credentialToRevoke.actorId);

  return (
    /* No PageScroll here: `agent-credentials` is registered through
       `withPageScroll` in admin-console.tsx, which already supplies it. */
    <section className="grid gap-4">
      <PageHeading
        title="Agent credentials"
        subtitle="Issue scoped OAuth client credentials for agent actors. Revoke credentials that should no longer mint tokens. Emergency kill switches live under Agent emergency controls; human protocol secrets live under App passwords."
      />
      <AdminAccessRelatedNav current="agent-credentials" />

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
                void queryClient.invalidateQueries({ queryKey: ["admin", "users"] });
              }}
            />
          ) : null}

          <credentialForm.Field name="actorId">
            {(field) => {
              const selectedActor = actorsById.get(field.state.value);
              return (
                <div className="grid gap-2">
                  <ActorSearchField
                    id="agent-actor-search"
                    value={actorSearchDraft}
                    onChange={onSearchChange}
                  />
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
                            {actorLabel(actor)}
                          </option>
                        ))}
                      </optgroup>
                    ))}
                  </ActorSelectField>
                  {/* Client credentials for a human actor mint tokens that act as
                      that person — legal, rarely intended, and invisible once the
                      credential exists. Say so while it can still be changed. */}
                  {selectedActor !== undefined && !isAgentActor(selectedActor) ? (
                    <StateBanner kind="info">
                      {actorLabel(selectedActor)} is a {selectedActor.type} actor, not an agent.
                      Tokens minted with this credential will act as that {selectedActor.type}.
                    </StateBanner>
                  ) : null}
                </div>
              );
            }}
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

          {formError !== null ? <StateBanner kind="error">{formError}</StateBanner> : null}
          {createMutation.isError ? (
            <StateBanner kind="error">
              {errorMessage(createMutation.error, "Could not create the agent credential.")}
            </StateBanner>
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
            <StateBanner kind="error">
              {errorMessage(credentialsQuery.error, "Could not load agent credentials.")}
            </StateBanner>
          ) : null}
          {revokeMutation.isError ? (
            <StateBanner kind="error">
              {errorMessage(revokeMutation.error, "Could not revoke the agent credential.")}
            </StateBanner>
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
            revokeMutation.mutate(credentialToRevoke.clientId);
          }}
        >
          This credential stops minting OAuth access tokens for{" "}
          {revokeTargetActor === undefined
            ? "an actor that is no longer in the enabled directory"
            : actorLabel(revokeTargetActor)}
          .
          {credentialToRevoke.scopes.length === 0
            ? ""
            : ` Anything running as this client loses ${credentialToRevoke.scopes.join(", ")}.`}{" "}
          The client secret cannot be shown again, so restoring access means issuing a new
          credential and redeploying it.
          <span className="mt-2 block text-xs">
            <span className="block">
              Actor ID <code>{credentialToRevoke.actorId}</code>
            </span>
            <span className="block">
              Client ID <code>{credentialToRevoke.clientId}</code>
            </span>
          </span>
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
    return "Select the actor this credential will act as.";
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

function actorLabel(actor: AdminUser): string {
  const displayName = actor.displayName.trim();
  const email = actor.email?.trim() ?? "";
  if (displayName.length === 0) {
    return email.length > 0 ? email : actor.id;
  }
  return email.length > 0 ? `${displayName} (${email})` : displayName;
}

function isAgentActor(actor: AdminUser): boolean {
  return actor.type.trim().toLowerCase() === AGENT_ACTOR_TYPE;
}

/** `agent` -> `Agent actors`; the directory returns the raw actor type. */
function actorGroupLabel(type: string): string {
  const trimmed = type.trim();
  if (trimmed.length === 0) {
    return "Untyped actors";
  }
  return `${trimmed.charAt(0).toUpperCase()}${trimmed.slice(1)} actors`;
}

function groupActorsByType(actors: readonly AdminUser[]): readonly ActorGroup[] {
  const byType = new Map<string, AdminUser[]>();
  for (const actor of actors) {
    const group = byType.get(actor.type);
    if (group === undefined) {
      byType.set(actor.type, [actor]);
    } else {
      group.push(actor);
    }
  }
  return [...byType.entries()]
    .sort(([left], [right]) => compareActorTypes(left, right))
    .map(([type, group]) => ({
      type,
      label: actorGroupLabel(type),
      actors: group.sort((left, right) => actorLabel(left).localeCompare(actorLabel(right))),
    }));
}

/* Agents first: this form exists to credential agents, so the humans it can
   also reach should not sit above them in the list. */
function compareActorTypes(left: string, right: string): number {
  if (left === AGENT_ACTOR_TYPE || right === AGENT_ACTOR_TYPE) {
    return left === AGENT_ACTOR_TYPE ? -1 : 1;
  }
  return left.localeCompare(right);
}

async function invalidateAgentCredentialLists(
  queryClient: ReturnType<typeof useQueryClient>,
): Promise<void> {
  await queryClient.invalidateQueries({ queryKey: ["admin", "agent-credentials"] });
}
