/* Admin › Security › Agent secrets. Passwords, tokens and keys stored for the
 * organization's agents. Each secret is granted to named agents and is either
 * use-only (Helix sends it for the agent, nobody reads it) or handed to the
 * agent on request. A value is entered here and never shown again. */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  adminAgentsQueryOptions,
  agentSecretsQueryKey,
  agentSecretsQueryOptions,
  createAgentSecret,
  deleteAgentSecret,
  setAgentSecretGrants,
  updateAgentSecret,
  type AdminAgent,
  type AgentSecret,
  type AgentSecretMode,
  type AgentSecretUpdateInput,
} from "@/features/admin/agent-secrets-api";
import { ConfirmDestructive } from "@/features/admin/console/confirm-destructive";
import { AdminField, AdminInput } from "@/features/admin/console/controls";
import { formatRelativeTime } from "@/features/admin/console/format";
import {
  EmptyRow,
  ErrorNotice,
  LoadingState,
  MutationError,
  Notice,
  PageHeading,
  PanelHeading,
  QueryFailureBanner,
  StatusChip,
  useQueryFailure,
} from "@/features/admin/console/primitives";

const MODES: readonly {
  readonly mode: AgentSecretMode;
  readonly label: string;
  readonly description: string;
}[] = [
  {
    mode: "use_only",
    label: "Use only",
    description:
      "Helix adds it to requests the agent asks for, to the hosts you list. The agent never sees it, and nobody can read it back.",
  },
  {
    mode: "handover",
    label: "Handed to the agent",
    description:
      "The agent can ask for the value and use it in another system. Each time is recorded in the audit log.",
  },
];

const modeLabel = (mode: AgentSecretMode) =>
  MODES.find((option) => option.mode === mode)?.label ?? mode;

function parseHosts(value: string): string[] {
  return [
    ...new Set(
      value
        .split(/[\s,]+/u)
        .map((host) => host.trim().toLowerCase())
        .filter((host) => host !== ""),
    ),
  ];
}

/** The most recent use by any agent holding the secret. */
function lastUsed(secret: AgentSecret): string | null {
  const times = secret.grants.flatMap((grant) =>
    grant.lastUsedAt === null ? [] : [grant.lastUsedAt],
  );
  return times.length === 0
    ? null
    : times.reduce((latest, time) => (time > latest ? time : latest));
}

export function AgentSecretsManagement() {
  const queryClient = useQueryClient();
  const secretsQuery = useQuery(agentSecretsQueryOptions());
  const agentsQuery = useQuery(adminAgentsQueryOptions());
  const [editing, setEditing] = useState<AgentSecret | null>(null);
  const [toDelete, setToDelete] = useState<AgentSecret | null>(null);
  /** Counts saves, so a stored secret leaves an empty form and no value behind. */
  const [saves, setSaves] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  const reload = () => {
    void queryClient.invalidateQueries({ queryKey: agentSecretsQueryKey });
  };
  const failure = useQueryFailure(secretsQuery, reload);
  const deleteMutation = useMutation({
    mutationFn: (secret: AgentSecret) => deleteAgentSecret(secret.id),
    // The failure is shown under the list; nothing is changed optimistically.
    onMutate: () => undefined,
    onError: () => undefined,
    onSuccess: (_result, secret) => {
      setToDelete(null);
      if (editing?.id === secret.id) setEditing(null);
      reload();
    },
  });
  const secrets = secretsQuery.data ?? [];

  return (
    <>
      <PageHeading
        title="Agent secrets"
        subtitle="Passwords, tokens and keys your agents may use, each granted to the agents you choose."
      />
      <div className="admin-stack">
        <section className="admin-card" aria-labelledby="agent-secrets-list-heading">
          <PanelHeading
            id="agent-secrets-list-heading"
            title="Stored secrets"
            subtitle="A value is never shown again after you save it."
          />
          {failure !== null ? (
            <QueryFailureBanner
              summary="Agent secrets couldn't be loaded"
              subject="agent secrets"
              error={failure.error}
              isRetrying={failure.isRetrying}
              onRetry={failure.retry}
            />
          ) : secretsQuery.isPending ? (
            <LoadingState label="Loading agent secrets" count={2} />
          ) : secrets.length === 0 ? (
            <EmptyRow>No secrets yet. Add the first one below.</EmptyRow>
          ) : (
            <ul className="m-0 grid list-none gap-2 p-0" aria-label="Stored secrets">
              {secrets.map((secret) => (
                <SecretRow
                  key={secret.id}
                  secret={secret}
                  onEdit={() => setEditing(secret)}
                  onDelete={() => setToDelete(secret)}
                />
              ))}
            </ul>
          )}
          <MutationError error={deleteMutation.error} />
          {notice === null ? null : <ErrorNotice>{notice}</ErrorNotice>}
        </section>

        <SecretForm
          key={`${editing?.id ?? "new"}:${String(saves)}`}
          secret={editing}
          agents={agentsQuery.data ?? []}
          agentsUnavailable={agentsQuery.isError}
          onSaved={(grantNotice) => {
            setEditing(null);
            setSaves((count) => count + 1);
            setNotice(grantNotice);
            reload();
          }}
          onCancel={() => setEditing(null)}
        />
      </div>

      {toDelete === null ? null : (
        <ConfirmDestructive
          open
          onOpenChange={(next) => {
            if (!next) setToDelete(null);
          }}
          title={`Delete ${toDelete.name}`}
          confirmLabel="Delete"
          isPending={deleteMutation.isPending}
          onConfirm={() => {
            deleteMutation.mutate(toDelete);
          }}
        >
          {toDelete.grants.length === 0
            ? "No agent holds this secret."
            : `${toDelete.grants.map((grant) => grant.displayName).join(", ")} will no longer be able to use it.`}{" "}
          The stored value is erased and cannot be recovered.
        </ConfirmDestructive>
      )}
    </>
  );
}

function SecretRow({
  secret,
  onEdit,
  onDelete,
}: {
  readonly secret: AgentSecret;
  readonly onEdit: () => void;
  readonly onDelete: () => void;
}) {
  const used = lastUsed(secret);
  return (
    <li className="grid gap-2 rounded-md border border-[var(--border)] p-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start">
      <div className="grid min-w-0 gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <code className="font-medium">{secret.name}</code>
          <StatusChip
            tone={secret.mode === "use_only" ? "success" : "warning"}
            label={modeLabel(secret.mode)}
            dot={false}
          />
        </div>
        {secret.description === "" ? null : <p className="m-0 type-meta">{secret.description}</p>}
        <p className="admin-muted m-0 type-caption">
          {secret.allowedHosts.length === 0
            ? "Not sent in requests."
            : `Sent to ${secret.allowedHosts.join(", ")}.`}{" "}
          {secret.grants.length === 0
            ? "No agent can use it yet."
            : `Granted to ${secret.grants
                .map((grant) =>
                  grant.disabled ? `${grant.displayName} (disabled)` : grant.displayName,
                )
                .join(", ")}.`}{" "}
          {used === null ? "Never used." : `Last used ${formatRelativeTime(used)}.`}
        </p>
      </div>
      <div className="flex gap-2">
        <Button onClick={onEdit} size="sm" type="button" variant="outline">
          Edit<span className="sr-only"> {secret.name}</span>
        </Button>
        <Button onClick={onDelete} size="sm" type="button" variant="destructive">
          Delete<span className="sr-only"> {secret.name}</span>
        </Button>
      </div>
    </li>
  );
}

interface SecretDraft {
  readonly name: string;
  readonly description: string;
  readonly value: string;
  readonly mode: AgentSecretMode;
  readonly hosts: string;
  readonly headerName: string;
  readonly headerPrefix: string;
  readonly agentIds: readonly string[];
}

function draftOf(secret: AgentSecret | null): SecretDraft {
  return {
    name: secret?.name ?? "",
    description: secret?.description ?? "",
    value: "",
    mode: secret?.mode ?? "use_only",
    hosts: secret?.allowedHosts.join(", ") ?? "",
    headerName: secret?.headerName ?? "authorization",
    headerPrefix: secret?.headerPrefix ?? "Bearer ",
    agentIds: secret?.grants.map((grant) => grant.actorId) ?? [],
  };
}

const sameSet = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((item) => b.includes(item));

/** What changed besides the grants. Empty when nothing did. */
function changesTo(secret: AgentSecret, draft: SecretDraft): AgentSecretUpdateInput {
  const hosts = parseHosts(draft.hosts);
  return {
    ...(draft.description.trim() === secret.description
      ? {}
      : { description: draft.description.trim() }),
    ...(draft.mode === secret.mode ? {} : { mode: draft.mode }),
    ...(sameSet(hosts, secret.allowedHosts) ? {} : { allowedHosts: hosts }),
    ...(draft.headerName.trim().toLowerCase() === secret.headerName
      ? {}
      : { headerName: draft.headerName.trim() }),
    ...(draft.headerPrefix === secret.headerPrefix ? {} : { headerPrefix: draft.headerPrefix }),
    ...(draft.value === "" ? {} : { value: draft.value }),
  };
}

function SecretForm({
  secret,
  agents,
  agentsUnavailable,
  onSaved,
  onCancel,
}: {
  /** The secret being edited, or null when adding one. */
  readonly secret: AgentSecret | null;
  readonly agents: readonly AdminAgent[];
  readonly agentsUnavailable: boolean;
  /** Called with a notice when the secret was saved but its grants were not. */
  readonly onSaved: (grantNotice: string | null) => void;
  readonly onCancel: () => void;
}) {
  const [draft, setDraft] = useState(() => draftOf(secret));
  const set = (patch: Partial<SecretDraft>) => setDraft((current) => ({ ...current, ...patch }));
  const save = useMutation({
    mutationFn: async (): Promise<string | null> => {
      const stored =
        secret ??
        (await createAgentSecret({
          name: draft.name.trim(),
          description: draft.description.trim(),
          mode: draft.mode,
          value: draft.value,
          allowedHosts: parseHosts(draft.hosts),
          headerName: draft.headerName.trim(),
          headerPrefix: draft.headerPrefix,
        }));
      if (secret !== null) {
        const changes = changesTo(secret, draft);
        if (Object.keys(changes).length > 0) await updateAgentSecret(secret.id, changes);
      }
      if (
        sameSet(
          draft.agentIds,
          stored.grants.map((grant) => grant.actorId),
        )
      ) {
        return null;
      }
      // Granting is its own step and may wait for a second administrator. The
      // secret is stored either way, so say what happened instead of failing.
      try {
        await setAgentSecretGrants(stored.id, draft.agentIds);
        return null;
      } catch (error) {
        const reason = error instanceof Error ? error.message : "The change was refused.";
        return `${stored.name} was saved, but who can use it was not changed. ${reason}`;
      }
    },
    onMutate: () => undefined,
    onError: () => undefined,
    onSuccess: onSaved,
  });
  const heading = secret === null ? "Add a secret" : `Edit ${secret.name}`;
  // Agents that can be chosen, plus any that already hold the secret.
  const choosable = agents.filter((agent) => !agent.disabled || draft.agentIds.includes(agent.id));

  return (
    <section className="admin-card" aria-labelledby="agent-secret-form-heading">
      <PanelHeading
        id="agent-secret-form-heading"
        title={heading}
        subtitle={
          secret === null
            ? "Store a value, choose how agents may use it, and choose which agents."
            : "Leave the value blank to keep the one that is stored."
        }
      />
      <form
        className="grid gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          save.mutate();
        }}
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <AdminField label="Name">
            <AdminInput
              autoComplete="off"
              disabled={secret !== null}
              onChange={(event) => set({ name: event.target.value })}
              pattern="[a-z][a-z0-9._\-]{0,62}"
              placeholder="github-deploy-token"
              required
              title="Lowercase letters, digits, dots, dashes and underscores, starting with a letter."
              value={draft.name}
            />
          </AdminField>
          <AdminField label="What it is for">
            <AdminInput
              maxLength={500}
              onChange={(event) => set({ description: event.target.value })}
              placeholder="Deploys from the release pipeline"
              value={draft.description}
            />
          </AdminField>
        </div>

        <AdminField label={secret === null ? "Value" : "New value"}>
          <AdminInput
            autoComplete="new-password"
            onChange={(event) => set({ value: event.target.value })}
            required={secret === null}
            type="password"
            value={draft.value}
          />
        </AdminField>

        <fieldset className="m-0 grid min-w-0 gap-2 border-0 p-0">
          <legend className="admin-field-label p-0">How agents may use it</legend>
          {MODES.map((option) => (
            <label key={option.mode} className="flex items-start gap-2 type-meta">
              <input
                checked={draft.mode === option.mode}
                className="mt-1"
                name="agent-secret-mode"
                onChange={() => set({ mode: option.mode })}
                type="radio"
              />
              <span>
                <span className="font-medium">{option.label}</span>
                <span className="admin-muted block type-caption">{option.description}</span>
              </span>
            </label>
          ))}
        </fieldset>

        <div className="grid gap-3 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)]">
          <AdminField
            label={
              draft.mode === "use_only"
                ? "Hosts it may be sent to"
                : "Hosts it may be sent to (optional)"
            }
          >
            <AdminInput
              onChange={(event) => set({ hosts: event.target.value })}
              placeholder="api.example.com, uploads.example.com"
              required={draft.mode === "use_only"}
              value={draft.hosts}
            />
          </AdminField>
          <AdminField label="Sent in header">
            <AdminInput
              onChange={(event) => set({ headerName: event.target.value })}
              required
              value={draft.headerName}
            />
          </AdminField>
          <AdminField label="Text before the value">
            <AdminInput
              maxLength={32}
              onChange={(event) => set({ headerPrefix: event.target.value })}
              value={draft.headerPrefix}
            />
          </AdminField>
        </div>
        {secret?.mode === "use_only" ? (
          <p className="admin-muted m-0 type-caption">
            To change where a use-only secret is sent, or to let agents read it, enter its value
            again.
          </p>
        ) : null}

        <fieldset className="m-0 grid min-w-0 gap-2 border-0 p-0">
          <legend className="admin-field-label p-0">
            Agents that may use it ({String(draft.agentIds.length)} chosen)
          </legend>
          {agentsUnavailable ? (
            <Notice>
              The list of agents couldn’t be loaded. Reload the page to choose agents.
            </Notice>
          ) : choosable.length === 0 ? (
            <p className="admin-muted m-0 type-caption">
              There are no agents yet. Add one under{" "}
              <Link to="/admin/$section" params={{ section: "agent-credentials" }}>
                Agent credentials
              </Link>
              .
            </p>
          ) : (
            <ul className="m-0 grid max-h-48 list-none gap-1 overflow-y-auto rounded-md border border-[var(--border)] p-2">
              {choosable.map((agent) => {
                const checked = draft.agentIds.includes(agent.id);
                return (
                  <li key={agent.id}>
                    <label className="flex min-h-6 items-center gap-2 type-meta">
                      <input
                        checked={checked}
                        onChange={() =>
                          set({
                            agentIds: checked
                              ? draft.agentIds.filter((id) => id !== agent.id)
                              : [...draft.agentIds, agent.id],
                          })
                        }
                        type="checkbox"
                      />
                      {agent.displayName}
                      {agent.type === "service_account" ? " (service account)" : ""}
                      {agent.disabled ? " (disabled)" : ""}
                    </label>
                  </li>
                );
              })}
            </ul>
          )}
          <p className="admin-muted m-0 type-caption">
            An agent also needs a credential with the <code>secrets.use</code> permission, issued
            under{" "}
            <Link to="/admin/$section" params={{ section: "agent-credentials" }}>
              Agent credentials
            </Link>
            .
          </p>
        </fieldset>

        <MutationError error={save.error} />
        <div className="flex gap-2">
          <Button disabled={save.isPending} type="submit">
            {save.isPending ? "Saving" : secret === null ? "Store secret" : "Save changes"}
          </Button>
          {secret === null ? null : (
            <Button disabled={save.isPending} onClick={onCancel} type="button" variant="outline">
              Cancel
            </Button>
          )}
        </div>
      </form>
    </section>
  );
}
