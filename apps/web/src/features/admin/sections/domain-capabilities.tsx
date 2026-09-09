import { Link } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { ConfirmDestructive } from "@/features/admin/console/confirm-destructive";
import { MutationError, StatusChip } from "@/features/admin/console/primitives";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import {
  domainsQueryKeys,
  rotateDomainChallenge,
  updateDomainCapabilities,
  verifyDomainOwnership,
  type DomainWithRecords,
  type UpdateDomainCapabilitiesInput,
} from "../domains-api";

export function domainSummary({ domain }: DomainWithRecords): string {
  if (domain.status !== "verified") return "Ownership is not proved, so capabilities are disabled.";
  const uses = [
    domain.identityEnabled && "identity",
    domain.mailEnabled && "mail",
    domain.aliasesEnabled && "aliases",
    domain.customHostEnabled && "custom host",
    domain.federationEnabled && "federation",
  ].filter(Boolean);
  return uses.length === 0
    ? "Ownership is proved. This domain is not used for anything yet."
    : `Ownership is proved. Enabled for ${uses.join(", ")}.`;
}

export function DomainCapabilitiesPanel({ entry }: { readonly entry: DomainWithRecords }) {
  const { domain } = entry;
  const queryClient = useQueryClient();
  const [disableMail, setDisableMail] = useState(false);
  const invalidate = () =>
    void queryClient.invalidateQueries({ queryKey: domainsQueryKeys.domains() });
  const verify = useMutation({
    onMutate: () => undefined,
    onError: () => undefined,
    mutationFn: () => verifyDomainOwnership(domain.id),
    onSuccess: invalidate,
  });
  const rotate = useMutation({
    onMutate: () => undefined,
    onError: () => undefined,
    mutationFn: () => rotateDomainChallenge(domain.id),
    onSuccess: invalidate,
  });
  const update = useMutation({
    onMutate: () => undefined,
    onError: () => undefined,
    mutationFn: (input: UpdateDomainCapabilitiesInput) =>
      updateDomainCapabilities(domain.id, input),
    onSuccess: () => {
      setDisableMail(false);
      invalidate();
    },
  });
  const proved = domain.status === "verified";
  const pending = verify.isPending || rotate.isPending || update.isPending;
  return (
    <div className="admin-domain-capabilities">
      <MutationError error={verify.error ?? rotate.error ?? update.error} />
      <section className="admin-domain-block">
        <h4>
          Ownership{" "}
          <StatusChip
            tone={proved ? "success" : "warning"}
            label={proved ? "Proved" : "Not proved"}
          />
        </h4>
        <p>{domainSummary(entry)}</p>
        {!proved && domain.status === "pending" ? (
          <>
            <p>Publish this TXT record in your DNS, then verify ownership.</p>
            <dl className="admin-domain-challenge">
              <dt>Name</dt>
              <dd className="mono">{domain.verificationHost}</dd>
              <dt>Value</dt>
              <dd className="mono">{domain.verificationValue}</dd>
            </dl>
            <Button
              disabled={pending}
              onClick={() => verify.mutate()}
              aria-label={`Verify ownership of ${domain.domain}`}
            >
              Verify ownership
            </Button>
            <Button
              disabled={pending}
              onClick={() => rotate.mutate()}
              aria-label={`Rotate verification record for ${domain.domain}`}
            >
              Rotate verification record
            </Button>
          </>
        ) : null}
      </section>
      {proved ? (
        <section className="admin-domain-block">
          <h4>Capabilities</h4>
          {(
            [
              ["identityEnabled", "Identity"],
              ["mailEnabled", "Mail"],
              ["aliasesEnabled", "Aliases"],
              ["customHostEnabled", "Custom host"],
              ["federationEnabled", "Federation"],
            ] as const
          ).map(([key, label]) => (
            <label key={key} className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={domain[key]}
                disabled={pending}
                onChange={(event) => {
                  if (key === "mailEnabled" && !event.target.checked) setDisableMail(true);
                  else update.mutate({ [key]: event.target.checked });
                }}
              />
              {label}
            </label>
          ))}
          <p>
            Mail delivery also requires a configured provider and verified mail DNS records. Manage
            providers and DKIM keys in{" "}
            <Link to="/admin/$section" params={{ section: "mail" }}>
              Mail settings
            </Link>
            .
          </p>
          <p>
            Configure identity providers in{" "}
            <Link to="/admin/$section" params={{ section: "identity" }}>
              Identity settings
            </Link>
            .
          </p>
        </section>
      ) : null}
      <ConfirmDestructive
        open={disableMail}
        onOpenChange={setDisableMail}
        title={`Turn off mail for ${domain.domain}?`}
        confirmLabel="Turn off mail"
        onConfirm={() =>
          update.mutate({
            mailEnabled: false,
            providerId: null,
            ...(!domain.identityEnabled ? { aliasesEnabled: false } : {}),
          })
        }
        isPending={update.isPending}
      >
        This domain stops accepting and sending mail. Existing messages and DKIM keys are retained.
      </ConfirmDestructive>
    </div>
  );
}
