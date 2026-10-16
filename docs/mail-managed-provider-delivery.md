# Managed outbound mail provider operations

Helix production delivery uses a managed API or authenticated SMTP relay. Direct-to-MX delivery is
not supported. The selected provider signs outbound mail with DKIM; Helix's legacy local DKIM keys
are not consumed by the launch transports and must not be presented as active signing keys.

## Provider setup

Admin → Mail → **Outbound providers** lists connections in the shared sortable table. Search by
name, connection kind, or endpoint. Use **+ Add provider** or a row's name to open the nonblocking
setup panel. The default-provider action stays on the row.

| Setup choice           | Transport                                        | Feedback integration                        |
| ---------------------- | ------------------------------------------------ | ------------------------------------------- |
| Amazon SES             | SMTP                                             | Signed SNS; configure the allowed topic ARN |
| Mailgun                | HTTP API                                         | Signed provider webhooks                    |
| Postmark               | HTTP API                                         | Existing configured feedback endpoint       |
| Generic SMTP           | SMTP                                             | No generic delivery-event import            |
| Resend (SMTP preset)   | `smtp.resend.com:587`, STARTTLS, user `resend`   | No Resend event import yet                  |
| SendGrid (SMTP preset) | `smtp.sendgrid.net:587`, STARTTLS, user `apikey` | No SendGrid event import yet                |

Resend and SendGrid use their API key as the SMTP password. Store it in the tenant secret handle,
not in public provider configuration. These presets use the existing SMTP delivery path; they do
not implement native provider HTTP APIs, OAuth sign-in, automatic DNS configuration, or webhook
verification. Inbound MX routing remains independent.

Provider references: [Resend SMTP](https://resend.com/docs/send-with-smtp),
[SendGrid SMTP](https://www.twilio.com/docs/sendgrid/for-developers/sending-email/integrating-with-the-smtp-api).
Native Resend and SendGrid delivery/complaint/bounce adapters are the next useful additions;
validate signatures, tenant binding, replay protection and idempotency before enabling them.

## DNS checklist

Configure each sending domain in the managed provider, then publish and verify all records supplied
by that provider:

- SPF: authorize only the provider's documented include or sending hosts. Keep one SPF TXT record.
- DKIM: publish every provider-issued selector/CNAME or TXT record. The provider, not Helix, holds
  and rotates the production signing key.
- DMARC: start with reporting enabled, review aggregate reports, and move to `quarantine` or
  `reject` after SPF/DKIM alignment is consistently healthy.
- Return path: configure the provider's custom bounce/MAIL FROM domain so it aligns with the
  organizational domain where supported.
- MX: publish provider MX records only for a custom return-path/bounce domain when the provider
  requires them. Do not point the primary inbound domain at an outbound provider unless it also
  owns inbound receipt.

For Mailgun, configure a provider signing secret reference and send delivery webhooks to:

```text
POST /v1/webhooks/mail/providers/{organization-uuid}/{provider-uuid}
X-Helix-Signature: t={unix-seconds},v1={hmac-sha256}
```

The signature is HMAC-SHA-256 over the exact bytes `timestamp + "." + raw request body`. The edge
or provider integration must preserve those bytes. Helix rejects malformed signatures and
timestamps outside the replay window before parsing JSON, stores only normalized safe event
metadata, and deduplicates events by organization, provider, and provider event ID.

Hard bounces and complaints create an organization-scoped recipient suppression immediately. An
authorized mail administrator may clear a suppression only with a reason; that action is audited.
Soft bounces remain visible as retryable delivery feedback and do not suppress the recipient.

## Secret handling

Provider API/SMTP credentials and webhook signing secrets are stored outside the database. Provider
rows contain only secret reference names. Workers resolve the current secret for each dispatch or
webhook call; caches contain only non-secret provider/domain configuration.

## Native SES feedback

SES and SES-backed SMTP providers accept native signed SNS notifications. In
Admin → Mail → Outbound providers, add or edit the provider using its SMTP host,
username, port and tenant password-secret handle. An SES API-key reference inside
`config` is not an SMTP credential. Set `feedbackTopicArn` to the exact allowed
commercial AWS SNS topic ARN; a separate webhook shared secret is unnecessary.
The edit panel shows this provider's complete **Feedback webhook URL**.

For the development workspace, use `us-east-2` and the verified identity
`workspace.helixapps.si`:

1. Create a **Standard** SNS topic in that region. Give the SES service permission
   to publish, restricted to your AWS account and this SES identity's ARN.
2. Save that topic ARN on the Helix provider before creating its subscription.
3. Subscribe the displayed webhook URL using **HTTPS**, with raw message delivery
   disabled. Helix verifies the signed subscription message and confirms only the
   configured topic. Keep its confirmation and notification requests outside any
   interactive Cloudflare Access challenge.
4. In the SES identity's **Notifications** tab, select that topic for bounces,
   complaints and deliveries. Enable **Include original email headers** for each.
   Those signed headers preserve Helix's handoff correlation through Mail Manager.
5. Send an approved test message, then inspect its delivery events in Helix.
   Exercise bounce/complaint handling with SES's mailbox simulator before expanding
   mail volume. A successful SMTP handoff alone does not validate this callback.

AWS documents the topic permissions and identity settings in
[Configuring SNS notifications for SES](https://docs.aws.amazon.com/ses/latest/dg/configure-sns-notifications.html).
Helix checks the exact topic, restricts certificate and confirmation URLs to that
region's SNS HTTPS endpoint, verifies the SNS message signature using the retrieved certificate, and rejects
redirects. It accepts SNS signature versions 1 and 2; prefer version 2 for new
topics. See [AWS signature verification](https://docs.aws.amazon.com/sns/latest/dg/sns-verify-signature-of-message.html).

Each recipient event is correlated with the configured provider, tenant, original
recipient and delivery/handoff ID before changing delivery state or suppression.
Duplicates do not send mail or create another suppression. Safe normalized fields
are retained; the original SNS message, message headers and certificate are not
stored in the delivery log. Signing credentials never belong in chat or committed
configuration.

An environment-only SMTP fallback has no tenant provider row to bind these
callbacks to. Provision a tenant provider and secret handle, select it for the
sending domain, and verify a controlled send before switching delivery. This is
an operator configuration step, not an automatic migration of global secrets.
