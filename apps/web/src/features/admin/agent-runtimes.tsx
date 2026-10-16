import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import {
  agentRuntimeConfigSchema,
  type AgentRuntime,
  type AgentRuntimeConfig,
} from "@helix/contracts";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/input";
import { FormPanel } from "@/components/ui/form-panel";
import { AdminField, AdminInput, AdminSelect } from "./console/controls";
import { AdminTable, type AdminColumn } from "./console/table";
import { ErrorNotice, EmptyRow, LoadingState } from "./console/primitives";
import { ConfirmDestructive } from "./console/confirm-destructive";
import type { AdminAgent } from "./agent-secrets-api";
import type { AgentCredential } from "./agent-credentials-api";
import {
  agentRuntimeQueryKey,
  agentRuntimeQueryOptions,
  saveAgentRuntime,
} from "./agent-runtime-api";
const defaults = () => agentRuntimeConfigSchema.parse({ mode: "external" });
const eventLabels = {
  "chat.direct": "Direct messages",
  "chat.mentioned": "Chat mentions",
  "approval.updated": "Approval decisions",
  "mail.received": "Incoming mail",
} as const;
export function AgentRuntimes({
  actors,
  credentials,
}: {
  readonly actors: readonly AdminAgent[];
  readonly credentials: readonly AgentCredential[];
}) {
  const [open, setOpen] = useState(false),
    [editing, setEditing] = useState(false),
    [actorId, setActorId] = useState("");
  const [config, setConfig] = useState<AgentRuntimeConfig>(defaults),
    [error, setError] = useState<string | null>(null),
    [reset, setReset] = useState(false);
  const client = useQueryClient();
  const query = useQuery(agentRuntimeQueryOptions(open));
  const save = useMutation({
    mutationFn: ({ resetToNow = false }: { resetToNow?: boolean }) =>
      saveAgentRuntime(actorId, config, resetToNow),
    onMutate: () => setError(null),
    onError: (e) => setError(e instanceof Error ? e.message : "Could not save hosting."),
    onSuccess: async () => {
      setEditing(false);
      setReset(false);
      await client.invalidateQueries({ queryKey: agentRuntimeQueryKey });
    },
  });
  const edit = (runtime?: AgentRuntime) => {
    setActorId(runtime?.actorId ?? "");
    setConfig(runtime?.config ?? defaults());
    setError(null);
    setEditing(true);
  };
  const current = query.data?.items.find((r) => r.actorId === actorId);
  const columns: AdminColumn<AgentRuntime>[] = [
    {
      id: "agent",
      header: "Agent",
      sortValue: (r) => actors.find((a) => a.id === r.actorId)?.displayName ?? r.actorId,
      cell: (r) => actors.find((a) => a.id === r.actorId)?.displayName ?? r.actorId,
    },
    {
      id: "mode",
      header: "Runs in",
      sortValue: (r) => r.config.mode,
      cell: (r) => (r.config.mode === "helix" ? "Helix" : "External app"),
    },
    {
      id: "state",
      header: "Status",
      sortValue: (r) => r.state,
      cell: (r) => (
        <span title={r.lastError ?? undefined}>
          {r.config.mode === "external" ? "Managed externally" : r.state.replace("_", " ")}
        </span>
      ),
    },
    {
      id: "actions",
      header: "Actions",
      cell: (r) => (
        <Button variant="ghost" onClick={() => edit(r)}>
          Configure
        </Button>
      ),
    },
  ];
  return (
    <section className="grid gap-3" aria-label="Agent hosting">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="m-0 text-sm font-semibold">Agent hosting</h2>
          <p className="m-0 type-caption text-muted-foreground">
            Let Helix run an agent, or connect one running in another app. Both keep the same
            permissions and approvals.
          </p>
        </div>
        <Button variant="outline" onClick={() => setOpen(!open)}>
          {open ? "Hide hosting" : "Manage hosting"}
        </Button>
      </div>
      {open ? (
        <>
          {query.isPending ? <LoadingState label="Loading agent hosting…" /> : null}
          {query.isError ? (
            <ErrorNotice>
              Could not load hosting settings.{" "}
              <Button
                variant="ghost"
                onClick={() => void client.invalidateQueries({ queryKey: agentRuntimeQueryKey })}
              >
                Retry
              </Button>
            </ErrorNotice>
          ) : null}
          {query.data ? (
            <>
              <div>
                <Button variant="outline" onClick={() => edit()}>
                  <Plus aria-hidden="true" /> Add hosting configuration
                </Button>
              </div>
              <AdminTable
                label="Agent hosting"
                rows={query.data.items}
                columns={columns}
                rowKey={(r) => r.actorId}
                searchText={(r) =>
                  `${actors.find((a) => a.id === r.actorId)?.displayName ?? r.actorId} ${r.config.mode} ${r.state}`
                }
                empty={
                  <EmptyRow>
                    No hosted agents configured. Existing agents continue to connect externally.
                  </EmptyRow>
                }
              />
            </>
          ) : null}
          {editing ? (
            <FormPanel
              title="Configure agent hosting"
              onClose={() => {
                if (!save.isPending) setEditing(false);
              }}
            >
              <form
                className="grid gap-4"
                onSubmit={(e) => {
                  e.preventDefault();
                  const parsed = agentRuntimeConfigSchema.safeParse(config);
                  if (!actorId || !parsed.success) {
                    setError(
                      !actorId
                        ? "Choose an agent."
                        : (parsed.error?.issues[0]?.message ?? "Check the hosting settings."),
                    );
                    return;
                  }
                  save.mutate({});
                }}
              >
                <AdminField label="Agent">
                  <AdminSelect
                    value={actorId}
                    required
                    onChange={(e) => {
                      setActorId(e.target.value);
                      const existing = query.data?.items.find((r) => r.actorId === e.target.value);
                      setConfig(existing?.config ?? defaults());
                    }}
                  >
                    <option value="">Select an agent</option>
                    {actors
                      .filter((a) => a.type === "agent" && !a.disabled)
                      .map((a) => (
                        <option key={a.id} value={a.id}>
                          {a.displayName}
                        </option>
                      ))}
                  </AdminSelect>
                </AdminField>
                <AdminField label="Where the agent runs">
                  <AdminSelect
                    value={config.mode}
                    onChange={(e) =>
                      setConfig({
                        ...config,
                        mode: e.target.value as AgentRuntimeConfig["mode"],
                        enabled: false,
                      })
                    }
                  >
                    <option value="external">External agent app</option>
                    <option value="helix">Helix hosted</option>
                  </AdminSelect>
                </AdminField>
                {config.mode === "external" ? (
                  <div className="grid gap-2">
                    <p className="m-0 type-caption">
                      Connect your agent app to <code>{window.location.origin}/v1/mcp</code> using
                      its scoped credential. Subscribe to <code>helix://events/inbox</code> to
                      receive changes. Your agent app chooses when to think and respond.
                    </p>
                    <p className="m-0 type-caption text-muted-foreground">
                      No Helix model is needed. Live subscriptions require notifications.read plus
                      the relevant Chat or Mail read scope.
                    </p>
                  </div>
                ) : (
                  <>
                    <AdminField label="Credential">
                      <AdminSelect
                        required
                        value={config.credentialId ?? ""}
                        onChange={(e) =>
                          setConfig({ ...config, credentialId: e.target.value || null })
                        }
                      >
                        <option value="">Choose the agent’s credential</option>
                        {credentials
                          .filter((c) => c.actorId === actorId && !c.revokedAt)
                          .map((c) => (
                            <option key={c.id} value={c.id}>
                              {c.label || c.id}
                            </option>
                          ))}
                      </AdminSelect>
                    </AdminField>
                    <p className="m-0 type-caption text-muted-foreground">
                      Requires notifications.read and assistant.write, plus permissions for its
                      work. Hosting adds no permissions and never skips human approval.
                    </p>
                    <AdminField label="AI model">
                      <AdminSelect
                        required
                        value={config.modelId ?? ""}
                        onChange={(e) => setConfig({ ...config, modelId: e.target.value || null })}
                      >
                        <option value="">Choose a configured model</option>
                        {query.data?.models.models.map((m) => (
                          <option key={m.id} value={m.id}>
                            {m.label}
                          </option>
                        ))}
                      </AdminSelect>
                    </AdminField>
                    {query.data?.models.models.length === 0 ? (
                      <p className="m-0 type-caption">Configure a model in AI settings first.</p>
                    ) : null}
                    <AdminField label="Instructions">
                      <Textarea
                        value={config.instructions}
                        maxLength={4000}
                        onChange={(e) => setConfig({ ...config, instructions: e.target.value })}
                      />
                    </AdminField>
                    <fieldset className="grid gap-2">
                      <legend className="text-sm font-medium">Wake up for</legend>
                      {Object.entries(eventLabels).map(([key, label]) => (
                        <label className="flex items-center gap-2 text-sm" key={key}>
                          <AdminInput
                            type="checkbox"
                            checked={config.events.includes(
                              key as AgentRuntimeConfig["events"][number],
                            )}
                            onChange={(e) =>
                              setConfig({
                                ...config,
                                events: e.target.checked
                                  ? [...config.events, key as AgentRuntimeConfig["events"][number]]
                                  : config.events.filter((v) => v !== key),
                              })
                            }
                          />
                          {label}
                        </label>
                      ))}
                    </fieldset>
                    <AdminField label="Maximum turns per hour">
                      <AdminInput
                        type="number"
                        min={1}
                        max={120}
                        value={config.turnsPerHour}
                        onChange={(e) =>
                          setConfig({ ...config, turnsPerHour: Number(e.target.value) })
                        }
                      />
                    </AdminField>
                    <AdminField label="Hosting status">
                      <AdminSelect
                        value={String(config.enabled)}
                        onChange={(e) =>
                          setConfig({ ...config, enabled: e.target.value === "true" })
                        }
                      >
                        <option value="false">Paused</option>
                        <option value="true">Enabled</option>
                      </AdminSelect>
                    </AdminField>
                    <p className="m-0 type-caption text-muted-foreground">
                      New configurations start with future events. Each turn is limited to 90
                      seconds and 8 tool rounds. Idle listening uses no model calls. Agent-authored
                      chats do not trigger automatic replies.
                    </p>
                  </>
                )}
                {current?.lastError ? <ErrorNotice>{current.lastError}</ErrorNotice> : null}
                {error ? <ErrorNotice>{error}</ErrorNotice> : null}
                <div className="flex flex-wrap gap-2">
                  <Button type="submit" disabled={save.isPending}>
                    {save.isPending ? "Saving…" : "Save hosting"}
                  </Button>
                  {current?.lastError ? (
                    <Button
                      type="button"
                      variant="outline"
                      disabled={save.isPending}
                      onClick={() => setReset(true)}
                    >
                      Review and start from now
                    </Button>
                  ) : null}
                </div>
              </form>
            </FormPanel>
          ) : null}
        </>
      ) : null}
      <ConfirmDestructive
        open={reset}
        onOpenChange={setReset}
        title="Start from the current inbox?"
        isPending={save.isPending}
        children="Review the previous turn and any pending approvals first. This skips the unprocessed event backlog and will not repeat earlier actions. Your saved hosting choices will be applied."
        confirmLabel="Start from now"
        onConfirm={() => save.mutate({ resetToNow: true })}
      />
    </section>
  );
}
