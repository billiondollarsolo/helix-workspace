import { useState } from "react";
import { Button } from "@/components/ui/button";
import { apiPath } from "@/lib/auth";
import { AdminField, AdminInput, AdminSelect } from "./console/controls";
import {
  MAIL_PROVIDER_KINDS,
  mailProviderKindLabels,
  type MailProvider,
  type MailProviderKind,
  type MailProviderConfig,
  type CreateMailProviderInput,
} from "./mail-admin-api";

export function ProviderForm({
  onCancel,
  onSubmit,
  pending,
  initial,
}: {
  readonly onCancel: () => void;
  readonly onSubmit: (input: CreateMailProviderInput) => void;
  readonly pending: boolean;
  readonly initial?: MailProvider | undefined;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [setup, setSetup] = useState<string>(
    initial?.config.feedbackProvider ?? initial?.kind ?? "ses",
  );
  const [kind, setKind] = useState<MailProviderKind>(initial?.kind ?? "ses");
  const [config, setConfig] = useState<MailProviderConfig>(initial?.config ?? {});
  const smtp = kind === "ses" || kind === "smtp";
  const setField = (key: keyof MailProviderConfig, value: string) =>
    setConfig((current) => ({
      ...current,
      [key]: key === "port" ? (value === "" ? null : Number(value)) : value,
    }));
  const field = (
    key: Exclude<keyof MailProviderConfig, "secure">,
    label: string,
    placeholder: string,
    required = false,
  ) => (
    <AdminField key={key} label={label}>
      <AdminInput
        aria-label={label}
        required={required}
        type={key === "port" ? "number" : "text"}
        min={key === "port" ? 1 : undefined}
        max={key === "port" ? 65535 : undefined}
        value={config[key] ?? ""}
        onChange={(event) => setField(key, event.target.value)}
        placeholder={placeholder}
      />
    </AdminField>
  );
  return (
    <form
      className="panel p-4 mb-3 grid gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        const keys: (keyof MailProviderConfig)[] = smtp
          ? [
              "host",
              "port",
              "user",
              "feedbackTopicArn",
              ...(kind === "ses" ? ["region" as const] : []),
            ]
          : kind === "mailgun"
            ? ["domain", "baseUrl"]
            : ["messageStream", "baseUrl"];
        const publicConfig = Object.fromEntries(
          keys
            .filter(
              (key) => config[key] !== undefined && config[key] !== null && config[key] !== "",
            )
            .map((key) => [
              key,
              typeof config[key] === "string" ? config[key].trim() : config[key],
            ]),
        );
        publicConfig.dkimMode = config.dkimMode ?? (kind === "smtp" ? "tenant" : "provider");
        if (kind === "smtp" && config.feedbackProvider)
          publicConfig.feedbackProvider = config.feedbackProvider;
        if (smtp) publicConfig.secure = config.secure ?? Number(config.port) === 465;
        onSubmit({
          name: name.trim(),
          kind,
          config: publicConfig,
        });
      }}
    >
      <h3 className="type-h3">Connection settings</h3>
      <div className="grid gap-3 sm:grid-cols-2">
        <AdminField label="Name">
          <AdminInput
            aria-label="Provider name"
            value={name}
            required
            maxLength={200}
            onChange={(event) => setName(event.target.value)}
          />
        </AdminField>
        <AdminField label="Kind">
          <AdminSelect
            aria-label="Provider kind"
            value={setup}
            disabled={initial !== undefined}
            onChange={(event) => {
              const value = event.target.value;
              setSetup(value);
              if (value === "resend" || value === "sendgrid" || value === "cloudflare") {
                setKind("smtp");
                setConfig({
                  host:
                    value === "cloudflare"
                      ? "smtp.mx.cloudflare.net"
                      : value === "resend"
                        ? "smtp.resend.com"
                        : "smtp.sendgrid.net",
                  port: value === "cloudflare" ? 465 : 587,
                  secure: value === "cloudflare",
                  user:
                    value === "cloudflare" ? "api_token" : value === "resend" ? "resend" : "apikey",
                  dkimMode: "provider",
                  feedbackProvider: value,
                });
              } else {
                setKind(MAIL_PROVIDER_KINDS.find((entry) => entry === value) ?? "ses");
                setConfig({});
              }
            }}
          >
            {MAIL_PROVIDER_KINDS.map((value) => (
              <option key={value} value={value}>
                {mailProviderKindLabels[value]}
              </option>
            ))}
            <option value="cloudflare">Cloudflare Email Service (SMTP)</option>
            <option value="resend">Resend (SMTP)</option>
            <option value="sendgrid">SendGrid (SMTP)</option>
          </AdminSelect>
        </AdminField>
        {kind === "smtp" ? (
          <p className="admin-muted sm:col-span-2">
            Save the provider, then add its SMTP password or API token in Credentials.
            Provider-managed signing requires a verified sending domain at that provider. Cloudflare
            uses TLS on port 465 and requires Email Service onboarding.
          </p>
        ) : null}
        {smtp ? (
          <>
            {field("host", "SMTP host", "email-smtp.us-east-2.amazonaws.com", true)}
            {field("port", "SMTP port", "587")}
            <AdminField label="Transport security">
              <AdminSelect
                value={(config.secure ?? config.port === 465) ? "tls" : "starttls"}
                onChange={(event) =>
                  setConfig((current) => ({ ...current, secure: event.target.value === "tls" }))
                }
              >
                <option value="starttls">STARTTLS (usually port 587)</option>
                <option value="tls">TLS (usually port 465)</option>
              </AdminSelect>
            </AdminField>
            {field("user", "SMTP username", "AWS SMTP username")}
            {kind === "ses" ? field("region", "Region", "us-east-2", true) : null}
            {field(
              "feedbackTopicArn",
              "SES feedback topic ARN",
              "arn:aws:sns:us-east-2:123456789012:helix-feedback",
            )}
          </>
        ) : kind === "mailgun" ? (
          field("domain", "Mailgun domain", "mg.example.com", true)
        ) : (
          field("messageStream", "Message stream", "outbound")
        )}
        {!smtp
          ? field(
              "baseUrl",
              "API endpoint (optional)",
              kind === "mailgun" ? "https://api.mailgun.net" : "https://api.postmarkapp.com",
            )
          : null}
        {smtp ? (
          <AdminField label="DKIM signing">
            <AdminSelect
              value={config.dkimMode ?? (kind === "ses" ? "provider" : "tenant")}
              onChange={(event) =>
                setConfig((current) => ({
                  ...current,
                  dkimMode: event.target.value === "provider" ? "provider" : "tenant",
                }))
              }
            >
              <option value="provider">Provider signs using its verified domain</option>
              <option value="tenant">Workspace signs using the domain's active key</option>
            </AdminSelect>
          </AdminField>
        ) : (
          <p className="admin-muted">
            The provider signs API messages. Verify your sending domain and publish its DKIM records
            at the provider.
          </p>
        )}
        {kind === "smtp" ? (
          <AdminField label="Delivery feedback">
            <AdminSelect
              value={config.feedbackProvider ?? ""}
              onChange={(event) =>
                setConfig((current) => {
                  const next = { ...current };
                  delete next.feedbackProvider;
                  if (event.target.value)
                    next.feedbackProvider = event.target.value as
                      "sendgrid" | "resend" | "cloudflare";
                  return next;
                })
              }
            >
              <option value="">None / SES topic above</option>
              <option value="sendgrid">SendGrid</option>
              <option value="resend">Resend</option>
              <option value="cloudflare">Cloudflare Queue bridge</option>
            </AdminSelect>
          </AdminField>
        ) : null}
      </div>
      <p className="type-meta text-muted-foreground">
        Save connection settings first, then enter credentials securely below.
      </p>
      {kind === "ses" ? (
        <p className="type-meta text-muted-foreground">
          For signed delivery, bounce and complaint feedback, set the exact SNS topic ARN, subscribe
          this provider’s webhook URL below, and enable original headers in SES notifications.
        </p>
      ) : null}
      {initial?.orgId ? (
        <AdminField label="Feedback webhook URL">
          <AdminInput
            readOnly
            value={`${window.location.origin}${apiPath(`/webhooks/mail/providers/${initial.orgId}/${initial.id}`)}`}
          />
        </AdminField>
      ) : null}
      <div className="flex gap-2 justify-end">
        <Button type="button" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" disabled={pending}>
          {pending ? "Saving…" : initial ? "Save provider" : "Add provider"}
        </Button>
      </div>
    </form>
  );
}
