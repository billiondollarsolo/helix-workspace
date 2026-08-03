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

### Spam folder and user actions

- The mail UI always exposes a **Spam** folder (view over `mail_thread_state.spam_at`).
- **Report spam** (`mail.spam` with `spam: true`) and **Not spam** (`spam: false`) update thread
  state and write durable rows to `mail_spam_feedback` for ops/learning.
- Auto-routing uses **SpamAssassin spamd** when enabled (see below). Without spamd, messages are
  not auto-claimed as AI-scanned.

### SpamAssassin (primary)

| Variable | Purpose |
|----------|---------|
| `MAIL_SPAMD_ENABLED` | Truthy enables inbound spamd scoring (default off) |
| `MAIL_SPAMD_HOST` | spamd host (default `spamd`) |
| `MAIL_SPAMD_PORT` | spamd port (default `783`) |
| `MAIL_SPAMD_THRESHOLD` | Score ≥ threshold routes to Spam (default `5`) |
| `MAIL_SPAMD_TIMEOUT_MS` | Per-scan timeout (default `10000`) |

When spamd is disabled or unreachable, ingest does not invent a spam score. Business tier may still
quarantine on **malware** scanner failure (ClamAV), which is separate from the Spam folder.

### Layered classification (ordered)

```
inbound message
  → SpamAssassin (spamd), if enabled
       ├─ spam  → Spam folder (catcher=spamd)  [AI is NOT run]
       └─ pass  → beta AI spam tool (if MAIL_SPAM_AI_BETA_ENABLED)
                    ├─ spam → Spam folder (catcher=ai or rules) + feedback row
                    └─ pass → Inbox (and other normal folders)
```

Auto-caught spam stores `metadata.spam.catcher` and a `mail_spam_feedback` row (`auto_spamd` /
`auto_ai` / `auto_rules`). In the Spam UI, AI/rules catches show **Was this correct?** with
**Yes, spam** (user feedback confirm) or **No, not spam** (clears spam + ham feedback).

### Beta AI spam second-pass (optional)

Off by default. Runs **only after spamd passes** (not spam). Rules + optional LLM. Failures never
block SMTP accept (fail-open). Labeled **beta** until further notice.

| Variable | Purpose |
|----------|---------|
| `MAIL_SPAM_AI_BETA_ENABLED` | Truthy enables beta second-pass (default off) |
| `MAIL_SPAM_AI_API_KEY` | Bearer token (falls back to `OPENAI_API_KEY`) |
| `MAIL_SPAM_AI_BASE_URL` | OpenAI-compatible base URL (default `https://api.openai.com/v1`, or `OPENAI_BASE_URL`) |
| `MAIL_SPAM_AI_MODEL` | Model id (default `gpt-4o-mini`, or `OPENAI_MODEL`) |
| `MAIL_SPAM_AI_TIMEOUT_MS` | LLM timeout (default `4000`) |

Where to set them: deployment env / compose / secrets for the Helix API process — same place as
other `MAIL_*` and `OPENAI_*` keys. Do not put secrets in the web build.

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
