import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Shield } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { AdminAccessRelatedNav } from "@/features/admin/admin-related-nav";
import { PageHeading, StateBanner } from "@/features/admin/console/primitives";
import {
  agentDefenderHoldsQueryOptions,
  agentDefenderPoliciesQueryOptions,
  agentDefenderQueryKeys,
  decideAgentDefenderHold,
  setAgentDefenderPolicy,
} from "./agent-defender-api";

export function AgentDefenderManagement() {
  const queryClient = useQueryClient();
  const [actorId, setActorId] = useState("");
  const [receiveMode, setReceiveMode] = useState<"allowlist" | "open">("allowlist");
  const [loopEnabled, setLoopEnabled] = useState(true);
  const [allowSend, setAllowSend] = useState(false);
  const [allowedSenders, setAllowedSenders] = useState("");
  const [error, setError] = useState<string | null>(null);

  const policiesQuery = useQuery(agentDefenderPoliciesQueryOptions());
  const holdsQuery = useQuery(agentDefenderHoldsQueryOptions());

  const saveMutation = useMutation({
    mutationFn: () =>
      setAgentDefenderPolicy({
        actorId: actorId.trim(),
        receiveMode,
        loopEnabled,
        allowedSenders: allowedSenders
          .split(/[\n,]/u)
          .map((entry) => entry.trim())
          .filter((entry) => entry.length > 0),
        allowSend: allowSend && receiveMode === "allowlist",
      }),
    onMutate: () => setError(null),
    onError: (err) => {
      setError(err instanceof Error ? err.message : "Failed to save Defender policy");
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: agentDefenderQueryKeys.root });
    },
  });

  const decideMutation = useMutation({
    mutationFn: decideAgentDefenderHold,
    onMutate: () => setError(null),
    onError: (err) => {
      setError(err instanceof Error ? err.message : "Failed to decide held mail");
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: agentDefenderQueryKeys.holds() });
    },
  });

  return (
    <section
      aria-label="Helix Agent Defender"
      className="grid gap-4"
      data-testid="agent-defender-admin"
    >
      <PageHeading
        title="Helix Agent Defender"
        subtitle="Agent mailboxes: allowlist or open receive, hold untrusted inbound, optional mail-triggered Assistant loop. Agents cannot change this policy."
      />
      <AdminAccessRelatedNav current="agent-defender" />
      {error !== null ? <StateBanner kind="error">{error}</StateBanner> : null}

      <section className="grid gap-3 rounded-lg border border-border bg-card p-4">
        <h2 className="m-0 flex items-center gap-2 text-sm font-semibold">
          <Shield aria-hidden="true" className="size-4" />
          Agent mailbox policy
        </h2>
        <label className="grid gap-1 text-sm">
          Agent actor ID
          <Input value={actorId} onChange={(event) => setActorId(event.target.value)} />
        </label>
        <fieldset className="grid gap-1 border-0 p-0">
          <legend className="text-sm">Receive</legend>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="radio"
              name="receive-mode"
              checked={receiveMode === "allowlist"}
              onChange={() => setReceiveMode("allowlist")}
            />
            Allowlist only (default)
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="radio"
              name="receive-mode"
              checked={receiveMode === "open"}
              onChange={() => setReceiveMode("open")}
            />
            Open (anyone, still held if unauthenticated or injection-like)
          </label>
        </fieldset>
        <label className="grid gap-1 text-sm">
          Allowed senders (email, @domain, or domain)
          <textarea
            className="min-h-24 rounded-md border border-input bg-background p-2 text-sm"
            value={allowedSenders}
            onChange={(event) => setAllowedSenders(event.target.value)}
          />
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={loopEnabled}
            onChange={(event) => setLoopEnabled(event.target.checked)}
          />
          Start an Assistant turn when mail is delivered
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={allowSend && receiveMode === "allowlist"}
            disabled={receiveMode !== "allowlist"}
            onChange={(event) => setAllowSend(event.target.checked)}
          />
          Loop may propose send/reply (still confirmed; allowlist only)
        </label>
        <Button
          type="button"
          disabled={actorId.trim().length === 0 || saveMutation.isPending}
          onClick={() => saveMutation.mutate()}
        >
          Save policy
        </Button>
      </section>

      <section className="grid gap-2">
        <h2 className="m-0 text-sm font-semibold">Policies</h2>
        {(policiesQuery.data ?? []).length === 0 ? (
          <p className="m-0 text-sm text-muted-foreground">No agent Defender policies yet.</p>
        ) : (
          <ul className="m-0 grid list-none gap-2 p-0">
            {(policiesQuery.data ?? []).map((policy) => (
              <li key={policy.actorId} className="rounded-md border border-border p-3 text-sm">
                {policy.actorId} · {policy.receiveMode}
                {policy.loopEnabled ? " · loop on" : " · loop off"}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="grid gap-2">
        <h2 className="m-0 text-sm font-semibold">Held mail</h2>
        {(holdsQuery.data ?? []).length === 0 ? (
          <p className="m-0 text-sm text-muted-foreground">Nothing held.</p>
        ) : (
          <ul className="m-0 grid list-none gap-2 p-0">
            {(holdsQuery.data ?? []).map((hold) => (
              <li
                key={`${hold.agentActorId}:${hold.threadId}`}
                className="grid gap-2 rounded-md border border-border p-3 text-sm"
              >
                <div>
                  {hold.subject || "(no subject)"} from {hold.fromAddress || "unknown"}
                </div>
                <div className="flex gap-2">
                  <Button
                    type="button"
                    variant="secondary"
                    onClick={() =>
                      decideMutation.mutate({
                        agentActorId: hold.agentActorId,
                        threadId: hold.threadId,
                        action: "release",
                      })
                    }
                  >
                    Release to agent
                  </Button>
                  <Button
                    type="button"
                    variant="secondary"
                    onClick={() =>
                      decideMutation.mutate({
                        agentActorId: hold.agentActorId,
                        threadId: hold.threadId,
                        action: "junk",
                      })
                    }
                  >
                    Junk
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </section>
  );
}
