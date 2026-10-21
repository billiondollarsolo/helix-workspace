/* Admin → Domains → DNS and proxy. For each hostname this installation
   answers on, whether its DNS record should go through an HTTP proxy such as
   Cloudflare and whether it does now. Web apps may be proxied; mail and the
   Meet relay carry traffic a web proxy cannot pass, so they must not be. */

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useId } from "react";
import { Button } from "@/components/ui/button";
import {
  EmptyRow,
  ErrorNotice,
  LoadingState,
  PanelHeading,
  StatusChip,
} from "@/features/admin/console/primitives";
import { AdminTable, type AdminColumn } from "@/features/admin/console/table";
import {
  dnsChecklistQueryKey,
  dnsChecklistQueryOptions,
  type DnsChecklistRow,
} from "@/features/admin/dns-checklist-api";

const PURPOSE: Record<DnsChecklistRow["role"], string> = {
  web: "Workspace",
  app: "Federated app",
  mail: "Mail",
  turn: "Meet relay",
};

const MODE: Record<DnsChecklistRow["observed"], string> = {
  proxied: "Proxied",
  "dns-only": "DNS-only",
  mixed: "Mixed",
  unresolved: "Not found",
};

const TONE: Record<DnsChecklistRow["status"], string> = {
  ok: "success",
  recommend: "warning",
  problem: "danger",
};

const columns: readonly AdminColumn<DnsChecklistRow>[] = [
  {
    id: "hostname",
    header: "Hostname",
    cell: (row) => (
      <span className="grid">
        <span className="mono">{row.hostname}</span>
        {row.addresses.length === 0 ? null : (
          <span className="admin-row-detail mono">{row.addresses.join(", ")}</span>
        )}
      </span>
    ),
  },
  { id: "purpose", header: "Purpose", width: "130px", cell: (row) => PURPOSE[row.role] },
  { id: "expected", header: "Should be", width: "110px", cell: (row) => MODE[row.expected] },
  {
    id: "observed",
    header: "Now",
    width: "120px",
    cell: (row) => <StatusChip tone={TONE[row.status]} label={MODE[row.observed]} />,
  },
  {
    id: "advice",
    header: "What to do",
    width: "100%",
    cell: (row) =>
      row.status === "ok" ? null : <span className="text-[var(--text-2)]">{row.advice}</span>,
  },
];

export function DnsChecklistPanel() {
  const headingId = useId();
  const queryClient = useQueryClient();
  const query = useQuery(dnsChecklistQueryOptions());

  return (
    <section className="panel mt-4 p-4" aria-labelledby={headingId}>
      <PanelHeading
        id={headingId}
        title="DNS and proxy"
        subtitle="Web apps can sit behind Cloudflare (orange cloud). Mail and Meet’s relay must stay DNS-only."
        actions={
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={query.isFetching}
            aria-busy={query.isFetching}
            onClick={() => void queryClient.invalidateQueries({ queryKey: dnsChecklistQueryKey })}
          >
            {query.isFetching ? "Checking…" : "Refresh"}
          </Button>
        }
      />
      {query.isError ? (
        <ErrorNotice>DNS records could not be checked. {query.error.message}</ErrorNotice>
      ) : null}
      {query.data === undefined ? (
        query.isError ? null : (
          <LoadingState label="Checking DNS records…" />
        )
      ) : (
        <AdminTable
          label="DNS and proxy checklist"
          columns={columns}
          rows={query.data}
          rowKey={(row) => row.hostname}
          empty={<EmptyRow>This installation has no public hostnames configured yet.</EmptyRow>}
        />
      )}
    </section>
  );
}
