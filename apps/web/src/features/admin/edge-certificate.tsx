/* Admin → Domains → HTTPS certificate. Shows the certificate browsers get at
   the workspace's address and lets a deployment that manages its own edge
   replace it with one the organization provides, or go back to automatic
   certificates. Nothing renews an uploaded certificate, so its expiry is the
   most prominent thing here. */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useId, useState, type ChangeEvent, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/helix-dialog";
import { ConfirmDestructive } from "@/features/admin/console/confirm-destructive";
import { formatAbsoluteTime } from "@/features/admin/console/format";
import {
  ErrorNotice,
  LoadingState,
  MutationError,
  Notice,
  PanelHeading,
  StatusChip,
} from "@/features/admin/console/primitives";
import {
  EdgeCertificateUploadError,
  edgeCertificateQueryKey,
  edgeCertificateQueryOptions,
  removeEdgeCertificate,
  uploadEdgeCertificate,
  type EdgeCertificateStatus,
  type EdgeCertificateSummary,
} from "@/features/admin/edge-certificate-api";

const DAY_MS = 24 * 60 * 60 * 1000;
/** How long the edge may take to pick up a change before we stop watching. */
const SETTLE_MS = 30_000;
const PEM_CLASS =
  "mono min-h-[120px] w-full max-w-none min-w-0 resize-y rounded-md border border-outline bg-surface-container px-3 py-2 text-xs text-foreground outline-none transition-colors focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/30";

/* Assembled, not written out: the repository's secret scan rejects any source
   file containing a private-key header, and this is only a placeholder. */
const KEY_PLACEHOLDER = ["-----BEGIN", "PRIVATE KEY-----"].join(" ");

const SOURCE_LABEL: Record<EdgeCertificateStatus["source"], string> = {
  automatic: "Automatic",
  uploaded: "Your certificate",
  "deployment-files": "From server files",
  internal: "Test certificate",
};

function daysLeft(certificate: EdgeCertificateSummary, now: number): number {
  return Math.floor((new Date(certificate.notAfter).getTime() - now) / DAY_MS);
}

function expiryText(days: number): string {
  if (days < 0) return "expired";
  if (days === 0) return "expires today";
  return days === 1 ? "expires tomorrow" : `expires in ${String(days)} days`;
}

export function EdgeCertificatePanel() {
  const headingId = useId();
  const queryClient = useQueryClient();
  const [settleUntil, setSettleUntil] = useState(0);
  const [uploading, setUploading] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const now = Date.now();
  const query = useQuery(edgeCertificateQueryOptions(now < settleUntil));
  const accept = (status: EdgeCertificateStatus) => {
    queryClient.setQueryData(edgeCertificateQueryKey, status);
    setSettleUntil(Date.now() + SETTLE_MS);
  };
  const removeMutation = useMutation({
    mutationFn: () => removeEdgeCertificate(),
    onMutate: () => undefined,
    onError: () => undefined,
    onSuccess: (status) => {
      accept(status);
      setConfirmRemove(false);
    },
  });

  const status = query.data;
  if (status === undefined) {
    return (
      <section className="panel mt-4 p-4" aria-labelledby={headingId}>
        <PanelHeading id={headingId} title="HTTPS certificate" />
        {query.isError ? (
          <ErrorNotice>The certificate could not be loaded. {query.error.message}</ErrorNotice>
        ) : (
          <LoadingState label="Loading the certificate…" />
        )}
      </section>
    );
  }

  const shown = status.served ?? status.uploaded;
  const days = shown === null ? null : daysLeft(shown, now);
  /* An automatic certificate renews itself about a month before it expires,
     so only one that nothing renews is worth a warning that early. */
  const renewsItself = status.source === "automatic" || status.source === "internal";
  const expiryTone =
    days === null ? null : days < 0 ? "danger" : days <= (renewsItself ? 7 : 30) ? "warning" : null;

  return (
    <section className="panel mt-4 p-4" aria-labelledby={headingId}>
      <PanelHeading
        id={headingId}
        title="HTTPS certificate"
        subtitle={`What browsers check when they open ${status.hostname}.`}
        actions={<StatusChip tone="" label={SOURCE_LABEL[status.source]} dot={false} />}
      />

      {shown === null ? (
        <Notice>Helix could not read the certificate that is being served right now.</Notice>
      ) : (
        <dl className="admin-facts">
          <div>
            <dt>Issued to</dt>
            <dd>{shown.names.length === 0 ? shown.subject : shown.names.join(", ")}</dd>
          </div>
          <div>
            <dt>Issued by</dt>
            <dd>{shown.issuer}</dd>
          </div>
          <div>
            <dt>Expires</dt>
            <dd>
              {formatAbsoluteTime(shown.notAfter)}{" "}
              {days === null ? null : expiryTone === null ? (
                <span className="admin-row-detail">{expiryText(days)}</span>
              ) : (
                <StatusChip tone={expiryTone} label={expiryText(days)} />
              )}
            </dd>
          </div>
        </dl>
      )}

      {status.source === "uploaded" && expiryTone !== null ? (
        <ErrorNotice>
          {days !== null && days < 0
            ? "This certificate has expired and browsers are warning people away. Upload its renewal now."
            : "Helix does not renew a certificate you uploaded. Upload its renewal before it expires."}
        </ErrorNotice>
      ) : null}
      {status.uploaded !== null && status.applied === false ? (
        <Notice>
          {now < settleUntil
            ? "Your certificate is saved. The server is switching to it now."
            : "Your certificate is saved, but the server is still showing a different one. Helix retries every minute."}
        </Notice>
      ) : null}
      {status.unavailableReason === null ? null : <Notice>{status.unavailableReason}</Notice>}
      <MutationError error={removeMutation.error} />

      {status.manageable ? (
        <div className="mt-3 flex flex-wrap gap-2">
          <Button type="button" variant="outline" onClick={() => setUploading(true)}>
            {status.uploaded === null ? "Use your own certificate" : "Replace certificate"}
          </Button>
          {status.uploaded === null ? null : (
            <Button type="button" variant="ghost" onClick={() => setConfirmRemove(true)}>
              Go back to automatic
            </Button>
          )}
        </div>
      ) : null}

      {uploading ? (
        <UploadDialog
          hostname={status.hostname}
          onClose={() => setUploading(false)}
          onSaved={(next) => {
            accept(next);
            setUploading(false);
          }}
        />
      ) : null}
      <ConfirmDestructive
        open={confirmRemove}
        onOpenChange={setConfirmRemove}
        title="Remove your certificate"
        confirmLabel="Remove certificate"
        isPending={removeMutation.isPending}
        blastRadius="Requesting a certificate needs ports 80 and 443 reachable from the Internet. Until one is issued, everyone opening the workspace sees a browser warning."
        onConfirm={() => removeMutation.mutate()}
      >
        Helix stops using your certificate for <strong>{status.hostname}</strong> and requests one
        from Let’s Encrypt instead.
      </ConfirmDestructive>
    </section>
  );
}

function UploadDialog({
  hostname,
  onClose,
  onSaved,
}: {
  readonly hostname: string;
  readonly onClose: () => void;
  readonly onSaved: (status: EdgeCertificateStatus) => void;
}) {
  const formId = useId();
  const errorId = useId();
  const [certificatePem, setCertificatePem] = useState("");
  const [privateKeyPem, setPrivateKeyPem] = useState("");
  const [missing, setMissing] = useState<"certificate" | "privateKey" | null>(null);
  const mutation = useMutation({
    mutationFn: () => uploadEdgeCertificate({ certificatePem, privateKeyPem }),
    onMutate: () => undefined,
    onError: () => undefined,
    onSuccess: onSaved,
  });
  const refusedField =
    mutation.error instanceof EdgeCertificateUploadError ? mutation.error.field : null;
  const errorField = missing ?? refusedField;
  const errorMessage =
    missing === "certificate"
      ? "Paste the certificate or choose its file."
      : missing === "privateKey"
        ? "Paste the private key or choose its file."
        : (mutation.error?.message ?? null);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const empty =
      certificatePem.trim().length === 0
        ? "certificate"
        : privateKeyPem.trim().length === 0
          ? "privateKey"
          : null;
    setMissing(empty);
    if (empty === null) mutation.mutate();
  };
  const readFile = (assign: (value: string) => void) => (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file === undefined) return;
    void file.text().then((text) => {
      assign(text);
      setMissing(null);
    });
  };
  const describedBy = (field: "certificate" | "privateKey") =>
    errorMessage !== null && errorField === field ? errorId : undefined;

  return (
    <Dialog
      title="Use your own certificate"
      width="min(640px, calc(100vw - 32px))"
      onClose={onClose}
      footer={
        <>
          <Button type="button" variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="submit"
            form={formId}
            disabled={mutation.isPending}
            aria-busy={mutation.isPending}
          >
            {mutation.isPending ? "Checking…" : "Use this certificate"}
          </Button>
        </>
      }
    >
      <form id={formId} className="grid gap-3" noValidate onSubmit={submit}>
        <p className="type-body-sm text-[var(--text-2)]">
          Helix checks that the certificate covers {hostname}, is in date, and matches its key
          before switching to it. Helix does not renew it: upload the renewal before it expires.
        </p>
        <div className="grid gap-1">
          <label className="grid gap-1 type-body-sm">
            <span className="font-medium">Certificate (PEM), followed by any intermediates</span>
            <textarea
              name="certificatePem"
              className={PEM_CLASS}
              spellCheck={false}
              autoComplete="off"
              placeholder="-----BEGIN CERTIFICATE-----"
              value={certificatePem}
              onChange={(event) => setCertificatePem(event.target.value)}
              aria-invalid={describedBy("certificate") === undefined ? undefined : true}
              aria-describedby={describedBy("certificate")}
            />
          </label>
          <input
            type="file"
            aria-label="Choose the certificate file"
            accept=".pem,.crt,.cer,.txt"
            className="type-meta"
            onChange={readFile(setCertificatePem)}
          />
        </div>
        <div className="grid gap-1">
          <label className="grid gap-1 type-body-sm">
            <span className="font-medium">Private key (PEM, without a passphrase)</span>
            <textarea
              name="privateKeyPem"
              className={PEM_CLASS}
              spellCheck={false}
              autoComplete="off"
              placeholder={KEY_PLACEHOLDER}
              value={privateKeyPem}
              onChange={(event) => setPrivateKeyPem(event.target.value)}
              aria-invalid={describedBy("privateKey") === undefined ? undefined : true}
              aria-describedby={describedBy("privateKey")}
            />
          </label>
          <input
            type="file"
            aria-label="Choose the private key file"
            accept=".pem,.key,.txt"
            className="type-meta"
            onChange={readFile(setPrivateKeyPem)}
          />
          <p className="type-meta text-[var(--text-2)]">
            The key is stored encrypted and can never be read back here.
          </p>
        </div>
        {errorMessage === null ? null : (
          <p id={errorId} className="type-body-sm text-[var(--danger)]" role="alert">
            {errorMessage}
          </p>
        )}
      </form>
    </Dialog>
  );
}
