/* Federated app → Operations → Connection path. Workspace's own calls to the app
   (directory sync, credentials, backups) should stay on a private network instead
   of crossing a public proxy such as Cloudflare. Same-server installs are found
   automatically; other setups enter one private address here. */

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useId, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { AdminField, AdminInput } from "@/features/admin/console/controls";
import { MutationError, PanelHeading, StatusChip } from "@/features/admin/console/primitives";
import {
  checkFederationPrivateLink,
  resetFederationPrivateLink,
  setFederationPrivateLink,
  type FederationApplication,
  type FederationConnection,
} from "@/features/admin/federation-applications-api";

const SETUPS = [
  {
    id: "server",
    label: "Same server",
    steps:
      "Usually found automatically. If not, join both apps to the same Docker network and enter the app's container name and port.",
    example: "helix-agentspace:3000",
  },
  {
    id: "cloud",
    label: "Same cloud network",
    steps:
      "Attach both servers to your provider's private network (Hetzner private network, AWS or GCP VPC) and enter the app server's private IP and port.",
    example: "10.0.0.5:3000",
  },
  {
    id: "tailscale",
    label: "Tailscale or WireGuard",
    steps:
      "Install Tailscale (or another WireGuard mesh) on both servers and enter the app server's tailnet name and port.",
    example: "agentspace.tailnet-name.ts.net:3000",
  },
  {
    id: "cloudflare",
    label: "Cloudflare Tunnel",
    steps:
      "Connect both servers to Cloudflare Zero Trust with a tunnel and WARP Connector, then enter the app's private address and port.",
    example: "10.10.0.5:3000",
  },
] as const;

const SOURCE = {
  discovered: "Found automatically",
  manual: "Set by an administrator",
  configured: "Set by your operator",
} as const;

export function FederationPrivateLink({
  application,
  connection,
}: {
  readonly application: FederationApplication;
  readonly connection: FederationConnection;
}) {
  const queries = useQueryClient();
  const headingId = useId();
  const [setup, setSetup] = useState<(typeof SETUPS)[number]["id"]>("server");
  const [target, setTarget] = useState("");
  const [open, setOpen] = useState(false);
  const chosen = SETUPS.find((item) => item.id === setup) ?? SETUPS[0];
  const done = async () => {
    await queries.invalidateQueries({ queryKey: ["admin", "federation-applications"] });
  };
  const save = useMutation({
    mutationFn: () => setFederationPrivateLink(application.id, target.trim()),
    onMutate: () => undefined,
    onError: () => undefined,
    onSuccess: async () => {
      setOpen(false);
      setTarget("");
      await done();
    },
  });
  const check = useMutation({
    mutationFn: () => checkFederationPrivateLink(application.id),
    onMutate: () => undefined,
    onError: () => undefined,
    onSuccess: done,
  });
  const reset = useMutation({
    mutationFn: () => resetFederationPrivateLink(application.id),
    onMutate: () => undefined,
    onError: () => undefined,
    onSuccess: done,
  });
  const busy = save.isPending || check.isPending || reset.isPending;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    save.mutate();
  };

  return (
    <section className="admin-section" aria-labelledby={headingId}>
      <PanelHeading
        id={headingId}
        title="Connection path"
        subtitle="How Workspace reaches this app for sign-in directory, credentials and backups."
      />
      <dl className="admin-facts">
        <div>
          <dt>Path</dt>
          <dd>
            {connection.path === "private" ? (
              <StatusChip tone="success" label="Private network" />
            ) : (
              <StatusChip tone="warning" label="Public internet" />
            )}
          </dd>
        </div>
        {connection.target ? (
          <div>
            <dt>Private address</dt>
            <dd>
              <span className="mono">{connection.target}</span>
              {connection.source ? (
                <span className="admin-row-detail"> {SOURCE[connection.source]}</span>
              ) : null}
            </dd>
          </div>
        ) : null}
      </dl>
      {connection.error ? <p className="admin-muted">{connection.error}</p> : null}
      {connection.path === "public" && !connection.error ? (
        <p className="admin-muted">
          Calls use the app’s public address. If it’s behind Cloudflare, set up a private link so
          bot protection and timeouts can’t interrupt them.
        </p>
      ) : null}
      {connection.source !== "configured" ? (
        <div className="admin-section-actions">
          <Button variant="outline" disabled={busy} onClick={() => check.mutate()}>
            {check.isPending ? "Checking…" : "Check now"}
          </Button>
          {connection.source === "manual" ? (
            <Button variant="ghost" disabled={busy} onClick={() => reset.mutate()}>
              {reset.isPending ? "Resetting…" : "Detect automatically"}
            </Button>
          ) : null}
          <Button variant="ghost" aria-expanded={open} onClick={() => setOpen(!open)}>
            {open ? "Close setup" : "Set up a private link"}
          </Button>
        </div>
      ) : null}
      <MutationError error={check.error ?? reset.error} />
      {open ? (
        <form className="grid gap-3" onSubmit={submit}>
          <fieldset className="grid gap-2">
            <legend className="admin-field-label">Where does the app run?</legend>
            {SETUPS.map((item) => (
              <label key={item.id} className="flex items-center gap-2">
                <input
                  type="radio"
                  name={`${headingId}-setup`}
                  value={item.id}
                  checked={setup === item.id}
                  onChange={() => setSetup(item.id)}
                />
                {item.label}
              </label>
            ))}
          </fieldset>
          <p className="admin-muted">{chosen.steps}</p>
          <AdminField label="Private address (host:port)">
            <AdminInput
              value={target}
              onChange={(event) => setTarget(event.target.value)}
              placeholder={chosen.example}
              autoComplete="off"
              spellCheck={false}
              required
            />
          </AdminField>
          <p className="admin-muted">
            Workspace tests the address before saving: the app must answer there with a valid
            certificate for {new URL(application.origin).hostname}.
          </p>
          <MutationError error={save.error} />
          <div className="admin-section-actions">
            <Button type="submit" disabled={busy || target.trim() === ""}>
              {save.isPending ? "Testing…" : "Test and save"}
            </Button>
          </div>
        </form>
      ) : null}
    </section>
  );
}
