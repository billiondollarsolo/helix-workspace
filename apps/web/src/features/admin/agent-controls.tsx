/**
 * A10 admin UI: emergency kill + org agent-write disable.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
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

  return (
    <section aria-label="Agent operational controls" data-testid="agent-controls-admin">
      <h2 style={{ marginTop: 0 }}>Agent emergency controls</h2>
      <p style={{ color: "var(--text-secondary)", fontSize: "var(--text-meta)" }}>
        Disable agent writes per organization or engage global read-only (emergency kill). These
        controls take effect immediately for non-read tools.
      </p>
      {error !== null ? (
        <div role="alert" style={{ color: "var(--danger)" }}>
          {error}
        </div>
      ) : null}
      {controlsQuery.isError ? (
        <div role="alert">Could not load agent controls. You need admin.agents permission.</div>
      ) : null}
      {controls !== undefined ? (
        <dl style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: "4px 16px" }}>
          <dt>Emergency kill (global read-only)</dt>
          <dd>{controls.globalReadOnly ? "ON" : "off"}</dd>
          <dt>Agent writes enabled (global)</dt>
          <dd>{controls.agentWritesEnabled ? "yes" : "no"}</dd>
          <dt>Orgs with agent writes disabled</dt>
          <dd>
            {controls.agentWritesDisabledOrgIds.length === 0
              ? "(none)"
              : controls.agentWritesDisabledOrgIds.join(", ")}
          </dd>
        </dl>
      ) : null}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 12 }}>
        <button
          type="button"
          className="btn danger"
          disabled={busy}
          title={
            controls?.globalReadOnly === true
              ? "Clear emergency kill"
              : "Engage emergency kill (deny all non-read tools)"
          }
          onClick={() => {
            setMutation.mutate({ globalReadOnly: !(controls?.globalReadOnly === true) });
          }}
        >
          {controls?.globalReadOnly === true ? "Clear emergency kill" : "Engage emergency kill"}
        </button>
        <button
          type="button"
          className="btn"
          disabled={busy}
          onClick={() => {
            setMutation.mutate({ agentWritesEnabled: !(controls?.agentWritesEnabled !== false) });
          }}
        >
          {controls?.agentWritesEnabled === false
            ? "Re-enable agent writes (global)"
            : "Disable agent writes (global)"}
        </button>
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 16, alignItems: "end" }}>
        <label style={{ display: "grid", gap: 4 }}>
          <span style={{ fontSize: "var(--text-meta)" }}>Organization id</span>
          <input
            value={orgId}
            onChange={(event) => {
              setOrgId(event.target.value);
            }}
            placeholder="org uuid"
            disabled={busy}
            style={{ minWidth: 280 }}
          />
        </label>
        <button
          type="button"
          className="btn"
          disabled={busy || orgId.trim().length === 0}
          onClick={() => {
            setMutation.mutate({ disableOrgId: orgId.trim() });
          }}
        >
          Disable agents for org
        </button>
        <button
          type="button"
          className="btn"
          disabled={busy || orgId.trim().length === 0}
          onClick={() => {
            setMutation.mutate({ enableOrgId: orgId.trim() });
          }}
        >
          Enable agents for org
        </button>
      </div>
    </section>
  );
}
