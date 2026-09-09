# Mail client interoperability

Helix supports authenticated SMTP submission for standards-based mail clients.
JMAP and IMAP are not implemented or advertised. Mailbox reading and state
changes remain available through the Helix web/API surface until a complete
JMAP Mail implementation passes conformance; Helix will not ship a partial
JMAP or home-grown IMAP compatibility layer. The app-password catalog therefore
does not issue an `imap` scope.

## Supported client settings

| Setting | Value |
| --- | --- |
| Protocol | SMTP submission (RFC 6409) |
| Transport | Implicit TLS (RFC 8314) |
| Port | `465` by default |
| Authentication | `PLAIN` or `LOGIN` inside TLS |
| Username | Full Helix user email address |
| Password | One-time-displayed Helix app password scoped to `smtp` |
| Envelope sender | The user's primary address or an enabled send-as alias |

These settings work with Apple Mail, Thunderbird, and native iOS/Android mail
clients for outbound submission. Do not configure an IMAP/JMAP incoming server;
those protocols are intentionally unavailable.

## Server configuration

Set:

```text
MAIL_SMTP_SUBMISSION_ENABLED=true
MAIL_SMTP_SUBMISSION_HOST=0.0.0.0
MAIL_SMTP_SUBMISSION_PORT=465
MAIL_SMTP_SUBMISSION_TLS_KEY_FILE=/run/tls/submission.key
MAIL_SMTP_SUBMISSION_TLS_CERT_FILE=/run/tls/submission.crt
```

The key file must be readable only by the Helix workload. Use a publicly trusted
certificate whose names cover the submission hostname. Inbound SMTP remains on
its separate listener and never accepts client authentication or relay traffic.

## Credentials and revocation

Create an app password through `app.passwords.create` with only the `smtp`
scope. The user must retain both `mail.send` and `mail.external` authority;
submission never bypasses the external-recipient control. The secret is shown once and stored as a password hash. `PLAIN` and
`LOGIN` are refused before TLS, failed authentication returns a generic error,
and every new connection rechecks user status, current authority, expiration,
and revocation. Revoke with `app.passwords.revoke`; clients must create a new
connection and credential afterward.

OAuth bearer/SASL is not currently advertised. Add it only with a complete
standards-compatible SASL OAuth flow and client scenario coverage.

## Operational verification

The focused submission protocol test opens a real implicit-TLS socket with
Nodemailer, authenticates using a revocable scoped app password, sends To/Cc/Bcc
and an attachment, and verifies the exact envelope reaches the durable outbound
queue. Negative vectors cover bad passwords, revoked credentials, and forged
senders. Production probes should repeat a submission with each supported
client family and confirm downstream delivery status through the existing mail
delivery event view.
