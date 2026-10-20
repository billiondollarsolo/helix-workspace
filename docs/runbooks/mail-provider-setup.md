# Mail provider setup

Tenant mail and system mail have separate owners. **Admin → Mail → Outbound providers** manages
this Workspace's queued outbound mail. **General → System mail relay** reports the deployment SMTP
relay used for invitations, authentication and fallback delivery. Tenant provider changes do not
change that relay. Deployment administrators manage its environment credentials.

## Add and check a provider

1. Add a provider using the inline panel. Save its public settings, then enter the sending credential
   under **Credentials and connection**. Credentials are encrypted with the existing tenant envelope
   key, scoped to this provider and purpose, never returned by the API, and excluded from audit data.
   Saving/removing a credential also clears its corresponding existing Vault handle. Public-settings edits leave credentials untouched.
2. Choose signing ownership. Mailgun and Postmark APIs use provider signing. SES defaults to provider
   signing. Generic SMTP defaults to Workspace signing, which requires the sender domain's active
   DKIM key. Managed SMTP presets use provider signing: complete that provider's sending-domain
   verification and publish its DKIM records. A Workspace domain verification is separate.
3. **Check connection** verifies SMTP connection/authentication or the provider's authenticated API
   lookup. It sends no email. Mailgun uses the domain lookup API; a restricted sending key without
   domain-read permission can send successfully while this check fails. Do not broaden a restricted
   key merely to satisfy the check.
4. Assign a domain or choose the default provider, then enable it. Enabled is a routing switch, not
   evidence of deliverability. Connection results are timestamped in the open panel and audited;
   they do not remain a durable readiness claim after settings or credentials change.
5. Complete an approved real send/receipt check and verify the received DKIM/SPF/DMARC results before
   relying on external delivery. No admin connection check sends a test message automatically.

Disable a provider to remove it from selection. Authenticated feedback for earlier sends continues to be accepted. A domain explicitly assigned to a disabled provider
fails closed. A disabled default also fails closed; only the absence of a saved default permits the deployment fallback. Delete is
confirmed and blocked for the default provider or providers with retained delivery history or
foreign-key references; disable retained providers instead.

## Managed SMTP presets

| Service                  | Host                   | Port / security | Username  | Sending credential      |
| ------------------------ | ---------------------- | --------------- | --------- | ----------------------- |
| SendGrid                 | smtp.sendgrid.net      | 587 / STARTTLS  | apikey    | API key                 |
| Resend                   | smtp.resend.com        | 587 / STARTTLS  | resend    | API key                 |
| Cloudflare Email Service | smtp.mx.cloudflare.net | 465 / TLS       | api_token | Email Sending API token |

Cloudflare requires Email Service sending-domain onboarding, not only inbound Email Routing. Its
SMTP service does not support STARTTLS on port 587. Provider limits still apply, including
Cloudflare's 5 MiB message size and 50-recipient limit. See the official
[Cloudflare SMTP reference](https://developers.cloudflare.com/email-service/api/send-emails/smtp/),
[Resend SMTP reference](https://resend.com/docs/send-with-smtp), and
[SendGrid SMTP guide](https://www.twilio.com/docs/sendgrid/for-developers/sending-email/integrating-with-the-smtp-api).

## Delivery, bounce and complaint feedback

Copy the provider's feedback URL from its edit panel. Select the feedback provider for SMTP.
Sending and feedback credentials are independent. Use a dedicated provider/server/domain for this
Workspace; do not reuse one signing secret across unrelated tenants.

| Service    | Verification configuration                                                                |
| ---------- | ----------------------------------------------------------------------------------------- |
| SES        | Exact SNS topic ARN; signed SNS notifications, with original headers enabled              |
| Mailgun    | Save the HTTP webhook signing key as the feedback credential; native timestamp/token HMAC |
| SendGrid   | Enable signed Event Webhook events; save its base64 ECDSA verification public key         |
| Resend     | Save the `whsec_…` signing secret; Svix timestamp/id/body signatures                      |
| Postmark   | Dedicated feedback password; HTTP Basic authentication username `helix`                   |
| Cloudflare | Queue event subscription and the signed bridge below                                      |

Subscribe only delivery, delay, bounce, rejection and complaint events. Unsupported tracking events
are acknowledged without storing their payloads. Supported events are deduplicated by tenant,
provider and event ID. Database ingestion verifies the outbound message and recipient before
changing status or suppressions. Hard bounces and complaints suppress future delivery; temporary
failures and policy rejections do not. Unmatched events normally return a retryable error. Postmark
setup probes and events without Helix metadata that match no outbound message are acknowledged and
ignored. New Postmark sends include the stable Helix handoff ID in metadata.

SendGrid correlates the original SMTP Message-ID. SES, Resend and Cloudflare SMTP acknowledgements
supply their assigned IDs; Cloudflare angle brackets are normalized. Resend acknowledgement parsing
is deliberately narrow and still requires acceptance with a real account. Failed correlation is
visible as unsuccessful feedback, never treated as delivery evidence.

Authentication details: [Mailgun](https://documentation.mailgun.com/docs/mailgun/user-manual/webhooks/securing-webhooks),
[SendGrid](https://www.twilio.com/docs/sendgrid/for-developers/tracking-events/getting-started-event-webhook-security-features),
[Resend](https://resend.com/docs/webhooks/verify-webhooks-requests),
[Postmark](https://postmarkapp.com/developer/webhooks/webhooks-overview).

### Cloudflare Queue bridge

The repository includes `infra/cloudflare-mail-feedback/worker.mjs` and a Wrangler configuration.
This is a Queue consumer, with no public fetch endpoint. It binds events to one sending domain,
signs the exact request bytes, and acknowledges a Queue message only after Workspace accepts it.

1. Create a Queue and dead-letter Queue in your Cloudflare account. Subscribe the sending domain's
   Email Service delivery events to the first Queue.
2. Copy the supplied Wrangler configuration; set both queue names, the sending domain and the exact
   Workspace provider feedback URL. Keep this deployment separate for each provider.
3. Set a dedicated random secret of at least 32 characters using `wrangler secret put
HELIX_FEEDBACK_SECRET`; enter the same secret privately in Workspace's feedback credential field.
4. Deploy with Wrangler, then inspect accepted events and monitor the dead-letter Queue. Correct the
   configuration before replaying any dead letters.

External deployment is not automatic: it requires the account's Queue permissions, event subscription,
provider credentials and an approved real delivery test. See
[Cloudflare event subscriptions](https://developers.cloudflare.com/queues/event-subscriptions/events-schemas/).

## Upgrade and recovery

Migration 0251 adds encrypted columns and extends the provider public-settings constraint. The old
application can run against the new schema. Preserve the tenant envelope master key with encrypted
backups. Schema rollback refuses to drop stored credentials or signing settings; normal application
rollback leaves these additive columns intact. No provider credentials are copied into source or
release logs.
