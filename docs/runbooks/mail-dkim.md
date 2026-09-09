# Tenant DKIM operations

Helix stores only KMS ciphertext in `mail_dkim_keys`; the plaintext RSA-2048
private key exists briefly in app memory while it is generated or used by
Nodemailer. The KMS encryption context binds ciphertext to the tenant, domain,
and `mail-dkim` purpose.

## Upgrading legacy mail credentials

Before upgrading a deployment that used environment-variable provider references,
provision each provider credential and callback signing secret in the tenant Vault
path `tenants/<org-id>/mail-provider/<handle>`. Provider credentials use the
`credential` field. Configure the provider's opaque `secretRef` and
`webhookSecretRef` handles through the mail admin API after migration, then enable
that provider and verify delivery and authenticated callbacks.

Migrations 0110 and 0119 disable providers with incompatible environment or inline
references and clear those references; they do not copy global secrets into tenant
storage. Export the non-secret provider settings and map the old references to the
correct tenant before migration. Keep the original secrets in their existing secret
manager until the replacement has been verified.

Legacy plaintext or app-envelope DKIM keys are invalidated by migrations 0110 and 0158. Provision KMS access, stage a fresh selector, publish and verify its DNS record,
and activate it using the procedure below before resuming production sending.
Existing old-selector DNS records should remain published through the old queue's
retry window. A successful schema migration alone does not establish mail delivery
readiness.

## Least-privilege KMS access

Provision one symmetric KMS/HSM key per tenant (or an equivalently isolated
key policy), then configure its ARN as `MAIL_DKIM_KMS_KEY_ID` or supply the ARN
while staging a key. The application role needs only `kms:Encrypt` and
`kms:Decrypt` on those exact key ARNs. Require these encryption-context keys in
the KMS/IAM policy:

```json
{
  "StringEquals": {
    "kms:EncryptionContext:helix:purpose": "mail-dkim"
  },
  "ForAllValues:StringEquals": {
    "kms:EncryptionContextKeys": ["helix:purpose", "helix:org-id", "helix:domain-id"]
  }
}
```

Do not grant the application role key creation, deletion, policy mutation, or
unscoped `kms:*`. KMS records Encrypt/Decrypt usage in CloudTrail; Helix audit
records key staging, activation, and retirement without key material.

## Rotation and verification

1. `POST /api/admin/mail/domains/:id/dkim` stages a pending selector and
   returns its public TXT record.
2. Publish that TXT record at `<selector>._domainkey.<domain>`.
3. `POST /api/admin/mail/domains/:id/dkim/:keyId/activate` verifies public DNS,
   activates the new selector, and changes the former active selector to
   `retiring` atomically.
4. Send a probe through the SMTP/SES path and verify aligned DKIM and DMARC at
   the receiving system. The automated `dkim-delivery.test.ts` vector also
   builds a real message and verifies its RSA-2048 signature with `mailauth`.
5. Keep the retiring TXT record published beyond the longest queued-message
   and retry window. Then call the `/retire` endpoint and remove DNS only after
   mail signed with the old selector can no longer be in flight.

Activation fails closed when the exact TXT value is absent. Outbound mail with
no active key is not claimed to be DKIM-protected; production readiness should
therefore alert on verified sending domains without one active selector.
