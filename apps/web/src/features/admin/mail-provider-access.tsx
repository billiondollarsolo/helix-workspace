import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { AdminField, AdminInput, AdminSelect } from "./console/controls";
import { ConfirmDestructive } from "./console/confirm-destructive";
import { ErrorNotice } from "./console/primitives";
import {
  checkMailProvider,
  deleteMailProvider,
  patchMailProvider,
  saveMailProviderCredential,
  type MailProvider,
} from "./mail-admin-api";

export function ProviderAccess({
  provider,
  onChanged,
  onDeleted,
}: {
  readonly provider: MailProvider;
  readonly onChanged: () => Promise<unknown>;
  readonly onDeleted: () => void;
}) {
  const [purpose, setPurpose] = useState<"sending" | "feedback">("sending");
  const [credential, setCredential] = useState("");
  const [confirmation, setConfirmation] = useState<"delete" | "credential" | null>(null);
  const save = useMutation({
    onMutate: () => undefined,
    onError: () => undefined,
    mutationFn: (value: string | null) => saveMailProviderCredential(provider.id, purpose, value),
    onSuccess: () => {
      setCredential("");
      setConfirmation(null);
      check.reset();
      void onChanged();
    },
  });
  const check = useMutation({
    onMutate: () => undefined,
    onError: () => undefined,
    mutationFn: () => checkMailProvider(provider.id),
  });
  const toggle = useMutation({
    onMutate: () => undefined,
    onError: () => undefined,
    mutationFn: () => patchMailProvider(provider.id, { enabled: !provider.enabled }),
    onSuccess: () => {
      void onChanged();
    },
  });
  const remove = useMutation({
    onMutate: () => undefined,
    onError: () => undefined,
    mutationFn: () => deleteMailProvider(provider.id),
    onSuccess: onDeleted,
  });
  const feedback = provider.kind === "smtp" ? provider.config.feedbackProvider : provider.kind;
  const help =
    feedback === "sendgrid"
      ? "Paste SendGrid's Event Webhook verification public key. Enable signed events in SendGrid."
      : feedback === "resend"
        ? "Paste the webhook signing secret beginning whsec_ from Resend."
        : feedback === "postmark"
          ? "Use a dedicated password. Configure Postmark's webhook HTTP authentication with username helix and this password."
          : feedback === "cloudflare"
            ? "Use the dedicated signing secret from your Cloudflare Queue bridge. Configure the bridge using the mail-provider runbook."
            : "Use Mailgun's HTTP webhook signing key, separate from its sending API key.";
  return (
    <section className="panel p-4 grid gap-3" aria-label="Provider credentials and connection">
      <h3 className="type-h3">Credentials and connection</h3>
      <p className="admin-muted">
        Credentials are encrypted for this Workspace and never returned. Saving or removing one
        clears its optional Vault handle. Connection checks send no email and do not verify domain
        signing or inbox delivery.
      </p>
      <p>
        Sending credential: {provider.hasSecret ? "Configured" : "Not configured"}. Feedback
        credential: {provider.hasWebhookSecret ? "Configured" : "Not configured"}.
      </p>
      <form
        className="grid gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          save.mutate(credential);
        }}
      >
        <AdminField label="Credential purpose">
          <AdminSelect
            value={purpose}
            disabled={save.isPending}
            onChange={(event) => {
              setPurpose(event.target.value === "feedback" ? "feedback" : "sending");
              setCredential("");
              save.reset();
            }}
          >
            <option value="sending">Sending password or API key</option>
            {feedback && feedback !== "ses" ? (
              <option value="feedback">Delivery feedback verification</option>
            ) : null}
          </AdminSelect>
        </AdminField>
        {purpose === "feedback" ? <p className="admin-muted">{help}</p> : null}
        <AdminField label="New credential">
          <AdminInput
            type="password"
            autoComplete="new-password"
            value={credential}
            required
            maxLength={16384}
            onChange={(event) => setCredential(event.target.value)}
          />
        </AdminField>
        <div className="flex flex-wrap gap-2">
          <Button type="submit" disabled={save.isPending}>
            {save.isPending ? "Saving…" : "Save credential"}
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={save.isPending}
            onClick={() => setConfirmation("credential")}
          >
            Remove credential
          </Button>
        </div>
      </form>
      {save.isSuccess ? <p role="status">Credential updated.</p> : null}
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant="outline"
          disabled={check.isPending}
          onClick={() => check.mutate()}
        >
          {check.isPending ? "Checking…" : "Check connection"}
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={toggle.isPending}
          onClick={() => toggle.mutate()}
        >
          {provider.enabled ? "Disable provider" : "Enable provider"}
        </Button>
        <Button
          type="button"
          variant="destructive"
          disabled={remove.isPending}
          onClick={() => setConfirmation("delete")}
        >
          Delete provider
        </Button>
      </div>
      {check.data ? (
        <p role="status">
          {check.data.message} Checked {new Date(check.data.checkedAt).toLocaleString()}.
        </p>
      ) : null}
      {[save.error, check.error, toggle.error, remove.error].filter(Boolean).map((error, index) => (
        <ErrorNotice key={index}>{error?.message}</ErrorNotice>
      ))}
      <ConfirmDestructive
        open={confirmation !== null}
        onOpenChange={(open) => {
          if (!open) setConfirmation(null);
        }}
        title={
          confirmation === "delete" ? `Delete ${provider.name}` : `Remove ${purpose} credential`
        }
        confirmLabel={confirmation === "delete" ? "Delete provider" : "Remove credential"}
        isPending={remove.isPending || save.isPending}
        onConfirm={() => (confirmation === "delete" ? remove.mutate() : save.mutate(null))}
      >
        {confirmation === "delete"
          ? `Remove ${provider.name} and its stored credentials. Move domain assignments and default routing to another provider first.`
          : `Remove ${provider.name}'s ${purpose} credential and its Vault handle. That connection will need a new credential.`}
      </ConfirmDestructive>
    </section>
  );
}
