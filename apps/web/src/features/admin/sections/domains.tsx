/* Admin › Organization › Domains — workspace domains and their DNS records. */

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Icons } from "@/components/icons";
import { DomainCapabilitiesPanel, domainSummary } from "./domain-capabilities";
import { Button } from "@/components/ui/button";
import { ConfirmDestructive } from "@/features/admin/console/confirm-destructive";
import {
  createDomain,
  deleteDomain,
  domainsQueryKeys,
  domainsQueryOptions,
  setPrimaryDomain,
  upsertDnsRecord,
  verifyDnsRecord,
  type DnsRecordType,
  type DomainWithRecords,
} from "@/features/admin/domains-api";
import {
  EmptyRow,
  EmptyState,
  HEADER_CELL,
  INPUT_STYLE,
  PageHeading,
  PageScroll,
  QueryFailureBanner,
  StateBanner,
  useQueryFailure,
} from "@/features/admin/console/primitives";

/* ------------------------------------------------------------------ */
/* Audit log                                                          */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/* Domain                                                             */
/* ------------------------------------------------------------------ */

const DOMAIN_GRID = "70px 180px 1fr 100px 90px";
const DNS_RECORD_TYPES_UI: readonly DnsRecordType[] = [
  "MX",
  "SPF",
  "DKIM",
  "DMARC",
  "TXT",
  "CNAME",
  "A",
];

/* `pending` and `failed` are database words. The chip has to say what they
   mean for the operator: nothing has been checked yet, versus we looked and
   the record was not there. */
function ownershipLabel(status: "verified" | "pending" | "failed"): string {
  switch (status) {
    case "verified":
      return "Ownership proved";
    case "failed":
      return "Verification failed";
    default:
      return "Not verified";
  }
}

function verificationVariant(status: "verified" | "pending" | "failed"): string {
  return status === "verified" ? "success" : status === "pending" ? "warning" : "danger";
}

/** What deleting this domain actually costs, read off the entry the operator is
 *  looking at.
 *
 *  The mail sentence is branched on verification on purpose: an unverified
 *  domain is not carrying mail yet, and warning that delivery stops would put a
 *  consequence on screen that does not exist. The record count is the entry's
 *  own `dnsRecords`, never an estimate. */
function domainDeletionBlastRadius(entry: DomainWithRecords): string {
  const mail =
    entry.domain.verificationStatus === "verified"
      ? `Mail delivery stops for every address at ${entry.domain.domain}.`
      : `${entry.domain.domain} is not verified, so no mail is flowing through it yet.`;

  const count = entry.dnsRecords.length;
  const records =
    count === 0
      ? "No DNS records are configured under it."
      : count === 1
        ? "Its 1 configured DNS record goes with it and has to be re-added and re-verified."
        : `Its ${String(count)} configured DNS records go with it and each has to be re-added and re-verified.`;

  const primary = entry.domain.isPrimary ? " This is the workspace's primary domain." : "";
  return `${mail} ${records}${primary}`;
}

/** DNS records table + add-record form + per-record verify for one domain. */
function DomainDnsPanel({ entry }: { entry: DomainWithRecords }) {
  const queryClient = useQueryClient();
  const [recordType, setRecordType] = useState<DnsRecordType>("MX");
  const [host, setHost] = useState("");
  const [expectedValue, setExpectedValue] = useState("");

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: domainsQueryKeys.domains() });
    void queryClient.invalidateQueries({
      queryKey: domainsQueryKeys.dnsRecords(entry.domain.id),
    });
  };

  const upsertMutation = useMutation({
    mutationFn: (input: { recordType: DnsRecordType; host: string; expectedValue: string }) =>
      upsertDnsRecord(entry.domain.id, input),
    onMutate: () => undefined,
    onError: () => undefined,
    onSuccess: () => {
      setHost("");
      setExpectedValue("");
      invalidate();
    },
  });
  const verifyMutation = useMutation({
    mutationFn: (recordId: string) => verifyDnsRecord(entry.domain.id, recordId),
    onMutate: () => undefined,
    onError: () => undefined,
    onSuccess: () => invalidate(),
  });

  return (
    <div className="panel" style={{ overflow: "hidden", marginBottom: 16 }}>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: DOMAIN_GRID,
          padding: "0 16px",
          height: 32,
          alignItems: "center",
          borderBottom: "1px solid var(--border)",
          background: "var(--surface-2)",
          ...HEADER_CELL,
        }}
      >
        <span>Type</span>
        <span>Host</span>
        <span>Value</span>
        <span>Status</span>
        <span />
      </div>

      {upsertMutation.isError ? (
        <div style={{ padding: "8px 16px" }}>
          <StateBanner kind="error">{upsertMutation.error.message}</StateBanner>
        </div>
      ) : null}
      {verifyMutation.isError ? (
        <div style={{ padding: "8px 16px" }}>
          <StateBanner kind="error">{verifyMutation.error.message}</StateBanner>
        </div>
      ) : null}

      {entry.dnsRecords.length === 0 ? (
        /* Helix seeds the MX / SPF / DMARC rows it needs when the deployment
           has a public mail hostname configured. An empty panel therefore means
           it does not — say so, rather than leaving an operator to guess which
           records to type into the form below. */
        <EmptyRow>
          No DNS records yet. Helix adds the records it needs automatically once
          <code> HELIX_MAIL_PUBLIC_HOSTNAME</code> is set on the deployment; until then, add them
          below.
        </EmptyRow>
      ) : (
        entry.dnsRecords.map((record) => (
          <div
            key={record.id}
            style={{
              display: "grid",
              gridTemplateColumns: DOMAIN_GRID,
              padding: "0 16px",
              height: 38,
              alignItems: "center",
              fontSize: "var(--text-meta)",
              borderBottom: "1px solid var(--border)",
            }}
          >
            <span style={{ fontWeight: 600 }}>{record.recordType}</span>
            <span className="mono" style={{ fontSize: "var(--text-caption)" }}>
              {record.host}
            </span>
            <span
              className="mono truncate"
              style={{ fontSize: "var(--text-caption)", color: "var(--text-2)" }}
            >
              {record.expectedValue}
            </span>
            <span>
              <span className={`chip ${verificationVariant(record.status)}`}>
                <span className="chip-dot" />
                {record.status}
              </span>
            </span>
            <Button
              type="button"
              size="sm"
              variant="outline"
              style={{ justifySelf: "flex-end" }}
              aria-label={`Verify ${record.recordType} ${record.host}`}
              disabled={verifyMutation.isPending}
              onClick={() => verifyMutation.mutate(record.id)}
            >
              Verify
            </Button>
          </div>
        ))
      )}

      <form
        style={{
          display: "grid",
          gridTemplateColumns: "70px 180px 1fr 90px",
          gap: 8,
          padding: "10px 16px",
          alignItems: "center",
        }}
        onSubmit={(event) => {
          event.preventDefault();
          if (host.trim().length === 0 || expectedValue.trim().length === 0) {
            return;
          }
          upsertMutation.mutate({
            recordType,
            host: host.trim(),
            expectedValue: expectedValue.trim(),
          });
        }}
      >
        <select
          aria-label="DNS record type"
          value={recordType}
          onChange={(event) => setRecordType(event.target.value as DnsRecordType)}
          style={INPUT_STYLE}
        >
          {DNS_RECORD_TYPES_UI.map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </select>
        <input
          aria-label="DNS record host"
          value={host}
          onChange={(event) => setHost(event.target.value)}
          placeholder="helix.io"
          style={INPUT_STYLE}
        />
        <input
          aria-label="DNS record value"
          value={expectedValue}
          onChange={(event) => setExpectedValue(event.target.value)}
          placeholder="10 mx1.helix.io"
          style={INPUT_STYLE}
        />
        {/* The one primary action of this panel — the Verify buttons above it
            are outline so they do not compete with it. */}
        <Button type="submit" size="sm" disabled={upsertMutation.isPending}>
          <Icons.Plus /> Record
        </Button>
      </form>
    </div>
  );
}

export function AdminDomain() {
  const queryClient = useQueryClient();
  const domainsQuery = useQuery(domainsQueryOptions());
  const [newDomain, setNewDomain] = useState("");
  /* Snapshot of the entry under the cursor: the list refetches on its own, and
     the dialog must keep describing the domain the operator actually picked. */
  const [deleteTarget, setDeleteTarget] = useState<DomainWithRecords | null>(null);

  const invalidate = () =>
    void queryClient.invalidateQueries({ queryKey: domainsQueryKeys.domains() });

  const addMutation = useMutation({
    mutationFn: (domain: string) => createDomain({ domain }),
    onMutate: () => undefined,
    onError: () => undefined,
    onSuccess: () => {
      setNewDomain("");
      invalidate();
    },
  });
  const primaryMutation = useMutation({
    mutationFn: (id: string) => setPrimaryDomain(id),
    onMutate: () => undefined,
    onError: () => undefined,
    onSuccess: () => invalidate(),
  });
  const deleteMutation = useMutation({
    mutationFn: (id: string) => deleteDomain(id),
    onMutate: () => undefined,
    onError: () => undefined,
    onSuccess: () => invalidate(),
  });

  const domains = domainsQuery.data ?? [];

  /* Invalidating the key rather than calling the observer's own refetch keeps
     every reader of `admin/domains` in step after a recovery. */
  const domainsFailure = useQueryFailure(domainsQuery, invalidate);

  return (
    <PageScroll>
      <PageHeading
        title="Domains"
        subtitle="Every domain this workspace owns, what it is used for, and the DNS records behind it."
      />

      {domainsFailure !== null ? (
        <QueryFailureBanner
          summary="Domains are unavailable"
          subject="domains"
          error={domainsFailure.error}
          isRetrying={domainsFailure.isRetrying}
          onRetry={domainsFailure.retry}
          /* The domain list is everything this page renders, so the retry is
             the only action left on screen. */
          retryVariant="default"
        >
          Adding a domain and editing its DNS records need the current list, so both stay
          unavailable until this loads.
        </QueryFailureBanner>
      ) : domainsQuery.isPending ? (
        <StateBanner kind="loading">Loading domains…</StateBanner>
      ) : null}
      {addMutation.isError ? (
        <StateBanner kind="error">{addMutation.error.message}</StateBanner>
      ) : null}
      {primaryMutation.isError ? (
        <StateBanner kind="error">{primaryMutation.error.message}</StateBanner>
      ) : null}
      {deleteMutation.isError ? (
        <StateBanner kind="error">{deleteMutation.error.message}</StateBanner>
      ) : null}

      {domainsFailure !== null ? null : (
        <>
          <form
            className="panel"
            style={{ padding: 12, marginBottom: 16, display: "flex", gap: 8 }}
            onSubmit={(event) => {
              event.preventDefault();
              if (newDomain.trim().length === 0) {
                return;
              }
              addMutation.mutate(newDomain.trim());
            }}
          >
            <input
              aria-label="New domain"
              value={newDomain}
              onChange={(event) => setNewDomain(event.target.value)}
              placeholder="helix.io"
              /* No `flex: 1` — a hostname is ~20 characters, and stretching the
                 field across the panel put the submit button a screen away. */
              style={{ ...INPUT_STYLE, width: 320 }}
            />
            <Button type="submit" disabled={addMutation.isPending}>
              <Icons.Plus /> Add domain
            </Button>
          </form>

          {domains.length === 0 ? (
            /* The loading banner above already says it is loading; a second
               "Loading domains…" in the empty state read as two states. */
            domainsQuery.isPending ? null : (
              <EmptyState icon={<Icons.Globe />} title="No domains yet">
                Add a domain to send and receive mail from it, and to let people sign in with
                addresses at that domain. Each one needs its DNS records verified before it goes
                live.
              </EmptyState>
            )
          ) : (
            domains.map((entry) => (
              <div key={entry.domain.id} className="admin-domain-entry">
                <div className="panel admin-domain-row">
                  <span className="admin-domain-icon">
                    <Icons.Globe />
                  </span>
                  <div className="admin-domain-identity">
                    <div className="admin-domain-name">
                      {entry.domain.domain}
                      {entry.domain.isPrimary ? <span className="chip">Primary</span> : null}
                    </div>
                    {/* What the domain does, not what tier of domain it is —
                        "Secondary domain" told an operator nothing they could
                        act on. */}
                    <div className="admin-domain-summary">{domainSummary(entry)}</div>
                  </div>
                  <span className={`chip ${verificationVariant(entry.domain.verificationStatus)}`}>
                    <span className="chip-dot" />
                    {ownershipLabel(entry.domain.verificationStatus)}
                  </span>
                  {!entry.domain.isPrimary ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      aria-label={`Make ${entry.domain.domain} primary`}
                      disabled={primaryMutation.isPending}
                      onClick={() => primaryMutation.mutate(entry.domain.id)}
                    >
                      Make primary
                    </Button>
                  ) : null}
                  {/* Was a bare trash glyph in the same grey as "Make primary",
                      one click from stopping mail. It now says what it does and
                      reads as the destructive control it is. */}
                  <Button
                    type="button"
                    size="sm"
                    variant="destructive"
                    aria-label={`Delete ${entry.domain.domain}`}
                    disabled={deleteMutation.isPending}
                    onClick={() => setDeleteTarget(entry)}
                  >
                    <Icons.Trash /> Delete
                  </Button>
                </div>
                {/* Capabilities first, DNS records second: what the domain is
                    used for is the question, and the records are how you get
                    there. */}
                <DomainCapabilitiesPanel entry={entry} />
                <DomainDnsPanel entry={entry} />
              </div>
            ))
          )}
        </>
      )}

      {/* Top tier: irreversible, it takes the DNS records with it, and getting
          the domain back means re-verifying ownership outside this console — so
          the operator types the hostname rather than clicking through. */}
      {deleteTarget === null ? null : (
        <ConfirmDestructive
          open
          onOpenChange={(next) => {
            if (!next) {
              setDeleteTarget(null);
            }
          }}
          title="Delete domain"
          blastRadius={domainDeletionBlastRadius(deleteTarget)}
          confirmPhrase={deleteTarget.domain.domain}
          confirmLabel="Delete domain"
          isPending={deleteMutation.isPending}
          onConfirm={() =>
            deleteMutation.mutate(deleteTarget.domain.id, {
              /* Close on settle, not on success: a failure is reported by the
                 page banner behind this overlay, so holding the dialog open
                 would hide the only account of what went wrong. */
              onSettled: () => setDeleteTarget(null),
            })
          }
        >
          Deleting <strong>{deleteTarget.domain.domain}</strong> removes it from this workspace.
          Getting it back means adding the domain again and re-verifying ownership from DNS; this
          console cannot undo the deletion.
        </ConfirmDestructive>
      )}
    </PageScroll>
  );
}
