# Managed outbound mail provider operations

Helix production delivery uses a managed API or authenticated SMTP relay. Direct-to-MX delivery is
not supported. The selected provider signs outbound mail with DKIM; Helix's legacy local DKIM keys
are not consumed by the launch transports and must not be presented as active signing keys.

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
POST /webhooks/mail/providers/{organization-uuid}/{provider-uuid}
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
