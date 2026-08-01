/* Helix Admin — what a domain is used for.
 *
 * Helix used to model one domain in three places with nothing joining them:
 * an identity record under Domains, a sending domain under Mail, and a
 * receiving domain under Mail. An operator adding example.com typed it three
 * times and got three unrelated "verified" badges, one of which was a lie.
 *
 * Migrations 0086 and 0087 made the domain the parent and these the
 * capabilities on it. This module renders that: proof of ownership once, then
 * what the domain is used for. Both capabilities are disclosed only when the
 * domain is proved — offering a control that must refuse is worse than not
 * offering it.
 */

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { ConfirmDestructive } from "@/features/admin/console/confirm-destructive";
import { StateBanner } from "@/features/admin/console/primitives";
import {
  domainsQueryKeys,
  issueOwnershipChallenge,
  verifyDomainOwnership,
  type DomainWithRecords,
  type OwnershipChallenge,
} from "../domains-api";
import {
  createReceivingDomain,
  deleteReceivingDomain,
  disableReceivingDomain,
  enableReceivingDomain,
} from "../mail-receiving-domains-api";
import {
  createSendingDomain,
  deleteSendingDomain,
  generateDkimKey,
  rotateDkimKey,
} from "../mail-admin-api";

/** Reads the domain's posture as one sentence, in the operator's terms. */
export function domainSummary(entry: DomainWithRecords): string {
  if (entry.domain.verificationStatus !== "verified") {
    return "Ownership is not proved, so no mail flows for this domain.";
  }
  const uses: string[] = [];
  if (entry.sending !== null) {
    uses.push(entry.sending.verifiedAt === null ? "sending (DNS incomplete)" : "sending");
  }
  if (entry.receiving?.status === "active") {
    uses.push("receiving");
  }
  if (uses.length === 0) {
    return "Ownership is proved. This domain is not used for anything yet.";
  }
  return `Ownership is proved. Used for ${uses.join(" and ")}.`;
}

export function DomainCapabilitiesPanel({ entry }: { readonly entry: DomainWithRecords }) {
  const queryClient = useQueryClient();
  const [challenge, setChallenge] = useState<OwnershipChallenge["verification"] | null>(null);
  const [removeReceiving, setRemoveReceiving] = useState(false);
  const [removeSending, setRemoveSending] = useState(false);
  const [rotateKeys, setRotateKeys] = useState(false);

  const invalidate = () =>
    void queryClient.invalidateQueries({ queryKey: domainsQueryKeys.domains() });

  const challengeMutation = useMutation({
    mutationFn: () => issueOwnershipChallenge(entry.domain.id),
    onMutate: () => undefined,
    onError: () => undefined,
    onSuccess: (result) => {
      setChallenge(result.verification);
      invalidate();
    },
  });
  const verifyMutation = useMutation({
    mutationFn: () => verifyDomainOwnership(entry.domain.id),
    onMutate: () => undefined,
    onError: () => undefined,
    onSuccess: () => invalidate(),
  });
  const addSending = useMutation({
    mutationFn: () => createSendingDomain(entry.domain.domain),
    onMutate: () => undefined,
    onError: () => undefined,
    onSuccess: () => invalidate(),
  });
  const dropSending = useMutation({
    mutationFn: (id: string) => deleteSendingDomain(id),
    onMutate: () => undefined,
    onError: () => undefined,
    onSuccess: () => {
      setRemoveSending(false);
      invalidate();
    },
  });
  const generateKey = useMutation({
    mutationFn: (id: string) => generateDkimKey(id),
    onMutate: () => undefined,
    onError: () => undefined,
    onSuccess: () => invalidate(),
  });
  const rotateKey = useMutation({
    mutationFn: (id: string) => rotateDkimKey(id),
    onMutate: () => undefined,
    onError: () => undefined,
    onSuccess: () => {
      setRotateKeys(false);
      invalidate();
    },
  });
  const addReceiving = useMutation({
    mutationFn: () => createReceivingDomain({ domain: entry.domain.domain }),
    onMutate: () => undefined,
    onError: () => undefined,
    onSuccess: () => invalidate(),
  });
  const toggleReceiving = useMutation({
    mutationFn: (input: { id: string; enable: boolean }) =>
      input.enable ? enableReceivingDomain(input.id) : disableReceivingDomain(input.id),
    onMutate: () => undefined,
    onError: () => undefined,
    onSuccess: () => invalidate(),
  });
  const dropReceiving = useMutation({
    mutationFn: (id: string) => deleteReceivingDomain(id),
    onMutate: () => undefined,
    onError: () => undefined,
    onSuccess: () => {
      setRemoveReceiving(false);
      invalidate();
    },
  });

  const error =
    challengeMutation.error ??
    verifyMutation.error ??
    addSending.error ??
    dropSending.error ??
    generateKey.error ??
    rotateKey.error ??
    addReceiving.error ??
    toggleReceiving.error ??
    dropReceiving.error;
  const proved = entry.domain.verificationStatus === "verified";

  return (
    <div className="admin-domain-capabilities">
      {error ? <StateBanner kind="error">{error.message}</StateBanner> : null}

      <section className="admin-domain-block">
        <div className="admin-domain-block-head">
          <h4 className="admin-domain-block-title">Ownership</h4>
          <span className={`chip ${proved ? "success" : "warning"}`}>
            <span className="chip-dot" />
            {proved ? "Proved" : "Not proved"}
          </span>
        </div>
        <p className="admin-domain-block-note">
          {proved
            ? "Helix has seen the verification record for this domain. Proving it once covers every use below."
            : "Publish the verification record below, then check it. Nothing can be switched on until this passes."}
        </p>

        {challenge ? (
          <dl className="admin-domain-challenge">
            <dt>Name</dt>
            <dd className="mono">{challenge.dnsName}</dd>
            <dt>Value</dt>
            <dd className="mono">{challenge.dnsValue}</dd>
            <dd className="admin-domain-challenge-note">
              Shown once — Helix stores only a digest. Issue a new record if you lose it.
            </dd>
          </dl>
        ) : null}

        <div className="admin-domain-block-actions">
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={challengeMutation.isPending}
            aria-label={`Issue a verification record for ${entry.domain.domain}`}
            onClick={() => challengeMutation.mutate()}
          >
            {challenge === null ? "Get verification record" : "Issue a new record"}
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={verifyMutation.isPending}
            aria-label={`Check ownership of ${entry.domain.domain}`}
            onClick={() => verifyMutation.mutate()}
          >
            {verifyMutation.isPending ? "Checking…" : "Check ownership"}
          </Button>
        </div>
      </section>

      {/* Progressive disclosure: the capabilities are the reward for proving
          the domain, and rendering them disabled beforehand would be a row of
          controls that can only refuse. */}
      {proved ? (
        <>
          <section className="admin-domain-block">
            <div className="admin-domain-block-head">
              <h4 className="admin-domain-block-title">Send mail from this domain</h4>
              <span className={`chip ${entry.sending === null ? "" : "success"}`}>
                <span className="chip-dot" />
                {entry.sending === null ? "Off" : "On"}
              </span>
            </div>
            <p className="admin-domain-block-note">
              {entry.sending === null
                ? "Helix will not send mail addressed from this domain."
                : entry.sending.verifiedAt === null
                  ? `Enabled, but SPF and DKIM have not both verified yet — receivers may reject or spam-file this mail. ${entry.sending.dkimKeyCount === 0 ? "No DKIM key has been generated." : `${String(entry.sending.dkimKeyCount)} DKIM key(s) present.`}`
                  : "SPF and DKIM verify, so mail from this domain is signed and authorized."}
            </p>
            <div className="admin-domain-block-actions">
              {entry.sending === null ? (
                <Button
                  type="button"
                  size="sm"
                  disabled={addSending.isPending}
                  aria-label={`Turn on sending for ${entry.domain.domain}`}
                  onClick={() => addSending.mutate()}
                >
                  Turn on sending
                </Button>
              ) : (
                <>
                  {/* Without a signing key a domain is "on" for sending and
                      unsigned, which receivers treat far worse than not
                      sending at all — so the key controls sit here, not in a
                      separate view. */}
                  {entry.sending.dkimKeyCount === 0 ? (
                    <Button
                      type="button"
                      size="sm"
                      disabled={generateKey.isPending}
                      aria-label={`Generate a DKIM key for ${entry.domain.domain}`}
                      onClick={() => entry.sending !== null && generateKey.mutate(entry.sending.id)}
                    >
                      Generate signing key
                    </Button>
                  ) : (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      aria-label={`Rotate the DKIM key for ${entry.domain.domain}`}
                      onClick={() => setRotateKeys(true)}
                    >
                      Rotate signing key
                    </Button>
                  )}
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    aria-label={`Turn off sending for ${entry.domain.domain}`}
                    onClick={() => setRemoveSending(true)}
                  >
                    Turn off sending
                  </Button>
                </>
              )}
            </div>
          </section>

          <section className="admin-domain-block">
            <div className="admin-domain-block-head">
              <h4 className="admin-domain-block-title">Receive mail for this domain</h4>
              <span className={`chip ${receivingChipVariant(entry)}`}>
                <span className="chip-dot" />
                {receivingLabel(entry)}
              </span>
            </div>
            <p className="admin-domain-block-note">{receivingNote(entry)}</p>
            <div className="admin-domain-block-actions">
              {entry.receiving === null ? (
                <Button
                  type="button"
                  size="sm"
                  disabled={addReceiving.isPending}
                  aria-label={`Turn on receiving for ${entry.domain.domain}`}
                  onClick={() => addReceiving.mutate()}
                >
                  Turn on receiving
                </Button>
              ) : (
                <>
                  <Button
                    type="button"
                    size="sm"
                    disabled={toggleReceiving.isPending}
                    aria-label={`${entry.receiving.status === "active" ? "Stop" : "Start"} accepting mail for ${entry.domain.domain}`}
                    onClick={() =>
                      entry.receiving !== null &&
                      toggleReceiving.mutate({
                        id: entry.receiving.id,
                        enable: entry.receiving.status !== "active",
                      })
                    }
                  >
                    {entry.receiving.status === "active"
                      ? "Stop accepting mail"
                      : "Start accepting mail"}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    aria-label={`Turn off receiving for ${entry.domain.domain}`}
                    onClick={() => setRemoveReceiving(true)}
                  >
                    Turn off receiving
                  </Button>
                </>
              )}
            </div>
          </section>
        </>
      ) : null}

      <ConfirmDestructive
        open={removeSending}
        onOpenChange={setRemoveSending}
        title={`Turn off sending for ${entry.domain.domain}?`}
        blastRadius={
          entry.sending === null
            ? undefined
            : `Helix stops sending mail addressed from ${entry.domain.domain}. ${
                entry.sending.dkimKeyCount === 0
                  ? "There are no DKIM keys to lose."
                  : `Its ${String(entry.sending.dkimKeyCount)} DKIM signing key(s) are destroyed — turning sending back on issues new selectors, so the DNS records have to be published and verified again.`
              }`
        }
        confirmLabel="Turn off sending"
        isPending={dropSending.isPending}
        onConfirm={() => {
          if (entry.sending !== null) {
            dropSending.mutate(entry.sending.id);
          }
        }}
      >
        The domain stays registered and proved — only outbound use is removed.
      </ConfirmDestructive>

      {/* Rotation is not a deletion but it is a timed outage: Helix signs with
          the new selector immediately, while receivers cannot validate it until
          its TXT record resolves in DNS. Nothing on the row said so. */}
      <ConfirmDestructive
        open={rotateKeys}
        onOpenChange={setRotateKeys}
        title={`Rotate the signing key for ${entry.domain.domain}?`}
        blastRadius={`Mail sent from ${entry.domain.domain} can fail DKIM from the moment this completes until the new selector's TXT record is published in DNS and propagates. The current key stops signing new mail.`}
        confirmLabel="Rotate key"
        isPending={rotateKey.isPending}
        onConfirm={() => {
          if (entry.sending !== null) {
            rotateKey.mutate(entry.sending.id);
          }
        }}
      >
        Publish the new record as soon as the rotation completes to close the gap.
      </ConfirmDestructive>

      <ConfirmDestructive
        open={removeReceiving}
        onOpenChange={setRemoveReceiving}
        title={`Turn off receiving for ${entry.domain.domain}?`}
        blastRadius={
          entry.receiving === null
            ? undefined
            : `${
                entry.receiving.status === "active"
                  ? `Helix stops accepting mail for ${entry.domain.domain} immediately, and senders get a bounce rather than a queued retry.`
                  : "This domain is not accepting mail right now, so no delivery is interrupted."
              } Any mailbox aliases on it stop resolving.`
        }
        confirmLabel="Turn off receiving"
        isPending={dropReceiving.isPending}
        onConfirm={() => {
          if (entry.receiving !== null) {
            dropReceiving.mutate(entry.receiving.id);
          }
        }}
      >
        The domain stays registered and proved — only inbound use is removed.
      </ConfirmDestructive>
    </div>
  );
}

function receivingChipVariant(entry: DomainWithRecords): string {
  if (entry.receiving === null) {
    return "";
  }
  return entry.receiving.status === "active" ? "success" : "warning";
}

function receivingLabel(entry: DomainWithRecords): string {
  if (entry.receiving === null) {
    return "Off";
  }
  return entry.receiving.status === "active" ? "Accepting mail" : "Not accepting";
}

/* The status word alone does not answer "is mail arriving?", which is the only
   question being asked here — so each state says what happens to a message. */
function receivingNote(entry: DomainWithRecords): string {
  if (entry.receiving === null) {
    return "Mail addressed to this domain is rejected at the SMTP edge.";
  }
  switch (entry.receiving.status) {
    case "active":
      return "Mail addressed to this domain is delivered to Helix mailboxes.";
    case "disabled":
      return "Delivery is switched off, so mail to this domain is rejected.";
    default:
      return "Set up but not switched on yet, so mail to this domain is still rejected.";
  }
}
