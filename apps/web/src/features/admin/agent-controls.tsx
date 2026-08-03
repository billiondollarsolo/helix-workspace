/**
 * Admin › Agent emergency controls — kill switch + per-org agent write disable.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ShieldAlert } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { AdminAccessRelatedNav } from "@/features/admin/admin-related-nav";
import { PageHeading, StateBanner } from "@/features/admin/console/primitives";
import {
  agentControlsQueryKeys,
  agentControlsQueryOptions,
  setAgentOperationalControls,
} from "./agent-controls-api";

export function AgentControlsManagement() {
  const queryClient = useQueryClient();
  const [orgId, setOrgId] = useState("");
  const [error, setError] = useState<string | null>(null);

  const controlsQuery = useQuery(agentControlsQueryOptions());

  const setMutation = useMutation({
    mutationFn: (input: {
      readonly globalReadOnly?: boolean;
      readonly agentWritesEnabled?: boolean;
      readonly disableOrgId?: string;
      readonly enableOrgId?: string;
    }) => setAgentOperationalControls(input),
    onMutate: () => {
      setError(null);
    },
    onError: (err) => {
      setError(err instanceof Error ? err.message : "Failed to update agent controls");
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: agentControlsQueryKeys.root });
    },
  });

  const controls = controlsQuery.data;
  const busy = setMutation.isPending || controlsQuery.isPending;
  const killOn = controls?.globalReadOnly === true;
  const agentWritesOn = controls?.agentWritesEnabled !== false;
  const disabledOrgs = controls?.agentWritesDisabledOrgIds ?? [];

  return (
    <section
      aria-label="Agent operational controls"
      className="grid gap-4"
      data-testid="agent-controls-admin"
    >
      <PageHeading
        title="Agent emergency controls"
        subtitle="Stop agent writes platform-wide or for one organization. These take effect immediately on non-read tools. Credentials are managed under Agent credentials."
      />
      <AdminAccessRelatedNav current="agent-controls" />

      {error !== null ? <StateBanner kind="error">{error}</StateBanner> : null}
      {controlsQuery.isError ? (
        <StateBanner kind="error">
          Could not load agent controls. You need admin.agents permission.
        </StateBanner>
      ) : null}
      {controlsQuery.isPending ? (
        <StateBanner kind="loading">Loading agent controls…</StateBanner>
      ) : null}

      {controls !== undefined ? (
        <section
          aria-labelledby="agent-controls-status-heading"
          className="grid gap-3 rounded-lg border border-border bg-card p-4 text-card-foreground"
        >
          <h2
            className="m-0 flex items-center gap-2 text-sm font-semibold"
            id="agent-controls-status-heading"
          >
            <ShieldAlert aria-hidden="true" className="size-4 text-muted-foreground" />
            Current posture
          </h2>
          <dl className="m-0 grid gap-3 sm:grid-cols-3">
            <div className="grid gap-1 rounded-md border border-border/70 p-3">
              <dt className="text-xs text-muted-foreground">Emergency kill (global read-only)</dt>
              <dd className="m-0">
                <span className={`chip ${killOn ? "danger" : "success"}`}>
                  <span className="chip-dot" />
                  {killOn ? "ON" : "off"}
                </span>
              </dd>
              <p className="m-0 text-[0.7rem] text-muted-foreground">
                When on, non-read tools are denied for everyone.
              </p>
            </div>
            <div className="grid gap-1 rounded-md border border-border/70 p-3">
              <dt className="text-xs text-muted-foreground">Agent writes (global)</dt>
              <dd className="m-0">
                <span className={`chip ${agentWritesOn ? "success" : "warning"}`}>
                  <span className="chip-dot" />
                  {agentWritesOn ? "yes" : "disabled"}
                </span>
              </dd>
              <p className="m-0 text-[0.7rem] text-muted-foreground">
                Agent write tools are blocked when disabled.
              </p>
            </div>
            <div className="grid gap-1 rounded-md border border-border/70 p-3">
              <dt className="text-xs text-muted-foreground">Orgs with agent writes disabled</dt>
              <dd className="m-0 text-sm font-medium">
                {disabledOrgs.length === 0 ? "None" : String(disabledOrgs.length)}
              </dd>
              {disabledOrgs.length === 0 ? (
                <p className="m-0 text-[0.7rem] text-muted-foreground">No per-org overrides.</p>
              ) : (
                <ul className="m-0 list-none space-y-1 p-0 text-[0.7rem] text-muted-foreground">
                  {disabledOrgs.map((id) => (
                    <li key={id}>
                      <code className="break-all">{id}</code>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </dl>

          <div className="flex flex-wrap gap-2 border-t border-border pt-3">
            <Button
              disabled={busy}
              type="button"
              variant={killOn ? "outline" : "destructive"}
              title={
                killOn ? "Clear emergency kill" : "Engage emergency kill (deny all non-read tools)"
              }
              onClick={() => {
                setMutation.mutate({ globalReadOnly: !killOn });
              }}
            >
              {killOn ? "Clear emergency kill" : "Engage emergency kill"}
            </Button>
            <Button
              disabled={busy}
              type="button"
              variant="outline"
              onClick={() => {
                setMutation.mutate({ agentWritesEnabled: !agentWritesOn });
              }}
            >
              {agentWritesOn ? "Disable agent writes (global)" : "Re-enable agent writes (global)"}
            </Button>
          </div>
        </section>
      ) : null}

      <section
        aria-labelledby="agent-controls-org-heading"
        className="grid gap-3 rounded-lg border border-border bg-card p-4 text-card-foreground"
      >
        <h2 className="m-0 text-sm font-semibold" id="agent-controls-org-heading">
          Per-organization override
        </h2>
        <p className="m-0 text-xs text-muted-foreground">
          Disable or re-enable agent writes for a single org without engaging the global kill
          switch. Use the organization UUID from Users or platform config.
        </p>
        <div className="flex flex-wrap items-end gap-3">
          <label className="grid min-w-[16rem] flex-1 gap-1.5 text-xs font-medium">
            Organization id
            <Input
              aria-label="Organization id"
              disabled={busy}
              onChange={(event) => {
                setOrgId(event.target.value);
              }}
              placeholder="00000000-0000-0000-0000-000000000000"
              value={orgId}
            />
          </label>
          <Button
            disabled={busy || orgId.trim().length === 0}
            type="button"
            variant="outline"
            onClick={() => {
              setMutation.mutate({ disableOrgId: orgId.trim() });
            }}
          >
            Disable agents for org
          </Button>
          <Button
            disabled={busy || orgId.trim().length === 0}
            type="button"
            variant="outline"
            onClick={() => {
              setMutation.mutate({ enableOrgId: orgId.trim() });
            }}
          >
            Enable agents for org
          </Button>
        </div>
      </section>
    </section>
  );
}
