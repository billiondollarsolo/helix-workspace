# Mail security and reliability

Helix Mail's production MVP uses managed providers for outbound delivery and Helix's
recipient-aware SMTP receiver for inbound delivery. It does not provide IMAP, POP, direct-to-MX
outbound delivery, or mailbox synchronization. Quarantine is storage-only: unsafe raw messages
remain in the Helix database and do not create mailbox messages or Drive objects.

## Size limits

- Inbound SMTP messages are limited to 25 MiB of raw RFC 822 data by default. Operators may lower
  this with `MAIL_SMTP_RECEIVER_MAX_MESSAGE_BYTES`; the SMTP receiver rejects an oversized DATA
  transaction before persistence.
- Outbound attachments are limited to 18 MiB per message in total, with no single attachment
  larger than 18 MiB. This leaves space for MIME headers and base64 expansion under the managed
  providers' common 25 MiB message limit. The provider may impose a lower account-specific limit.
- Inline and Drive-backed outbound attachments follow the same limit. Drive permission and object
  availability are checked again when the worker dispatches the message.

## Inbound policy

Inbound messages are authenticated and scanned once before tenant partitioning. SPF, DKIM, DMARC,
spam, antivirus, and raw header evidence are retained internally. Client-visible headers and HTML
are sanitized. Remote HTML images are removed by default, and HTML is sanitized again when the
thread projection is read and displayed in a sandboxed iframe.

Business tier fails closed: an unavailable or timed-out malware scanner quarantines the message
instead of delivering it. Malware and executable or active-content attachments are also
quarantined. A spoofed but syntactically valid `From` header is not by itself grounds for SMTP
rejection; authentication failures influence spam/quarantine routing.

Mail administrators can list, release, or delete records only inside their organization. Release
and deletion require explicit confirmation and a reason, are audited, and clear the stored raw
bytes. Release first re-scans the raw message; scanner failure or a non-clean result leaves it
quarantined.

## Drafts and outbound delivery

Server drafts are authoritative across devices and carry a monotonically increasing version.
Updates must include the version they read. A stale update receives a conflict instead of silently
overwriting a newer server copy; local browser recovery is only a crash fallback and must be
explicitly merged when it is newer.

Agent and API sends require idempotency keys. The key is unique per organization and actor, so a
retry or double submission returns the original queued record rather than creating another
message. Interactive sends remain protected by the durable undo window. The outbox row and
`undo_until` timestamp survive worker restarts.

User-visible delivery states are `queued`, `sending`, `sent`, `delayed`, `failed`, and `cancelled`.
Failed messages retry only through the explicit confirmed retry action. Poison messages are
dead-lettered after the attempt cap; non-retryable failures such as revoked attachment access are
dead-lettered immediately.
