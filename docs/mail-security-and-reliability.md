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

| Variable                | Purpose                                            |
| ----------------------- | -------------------------------------------------- |
| `MAIL_SPAMD_ENABLED`    | Truthy enables inbound spamd scoring (default off) |
| `MAIL_SPAMD_HOST`       | spamd host (default `spamd`)                       |
| `MAIL_SPAMD_PORT`       | spamd port (default `783`)                         |
| `MAIL_SPAMD_THRESHOLD`  | Score ≥ threshold routes to Spam (default `5`)     |
| `MAIL_SPAMD_TIMEOUT_MS` | Per-scan timeout (default `10000`)                 |

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

| Variable                    | Purpose                                                                                |
| --------------------------- | -------------------------------------------------------------------------------------- |
| `MAIL_SPAM_AI_BETA_ENABLED` | Truthy enables beta second-pass (default off)                                          |
| `MAIL_SPAM_AI_API_KEY`      | Bearer token (falls back to `OPENAI_API_KEY`)                                          |
| `MAIL_SPAM_AI_BASE_URL`     | OpenAI-compatible base URL (default `https://api.openai.com/v1`, or `OPENAI_BASE_URL`) |
| `MAIL_SPAM_AI_MODEL`        | Model id (default `gpt-4o-mini`, or `OPENAI_MODEL`)                                    |
| `MAIL_SPAM_AI_TIMEOUT_MS`   | LLM timeout (default `4000`)                                                           |

**Admin path (preferred for day-2 ops):** Admin → **AI → AI providers**. Operators set the shared
OpenAI-compatible **base URL / model / API key** and the **mail spam AI (beta)** enable toggle.
Values persist in platform-config (`ai.operatorLlm`, `ai.mailSpamAi`), override env when set, and
never return the raw key on GET (`apiKeyConfigured` only). Env remains valid bootstrap for airgap
and first boot. Do not put secrets in the web build.

### AI decision model (per organization, optional)

Admin → Mail → **Spam filtering** → **AI decision model** lets an organization send a compact
summary of each received message to a hosted _decision model_: **Cloudflare Workers AI Clef**
(`clef-flash` by default, or `clef`) or **TypeSafe Jev** (`jev-latest`). A decision model returns
a probability for every option of a few typed questions in one call, so there is no free text to
parse. Off by default; nothing here deletes mail.

**How it works.** The model runs **after the message is stored**, in a background worker fed by
the `activity.mail.received` outbox event, so SMTP accept never waits for it. SpamAssassin and the
other ingest checks still run first and still decide Spam on their own. One call per message asks:

| Question      | Type   | Options                                              |
| ------------- | ------ | ---------------------------------------------------- |
| `verdict`     | choice | legitimate, spam, phishing, scam                     |
| `category`    | choice | primary, updates, promotions, social (the Mail tabs) |
| `needs_reply` | yes/no | probability that the sender expects a reply          |
| `urgency`     | score  | can wait, this week, today                           |

Confidence is recomputed by Helix from the returned probabilities (top-option probability; for
yes/no `max(p, 1 − p)`) because the providers' own confidence formulas differ.

**What is sent.** At most about 8,000 characters: From, Reply-To, Return-Path domain, To/Cc counts,
Subject, Date, SPF/DKIM/DMARC results, the SpamAssassin score and rules, the list of link domains,
attachment names and types, and the plain-text body (HTML is reduced to text and truncated). The
admin card states "Message content is sent to <provider> for classification." Only mail from
outside senders that arrived through inbound delivery is considered; internal mail and sent copies
never are.

**Never sent (recorded as skipped).** Mail classified **confidential or restricted** — by an
explicit or stored classification (`resource_classifications`), a classification label, or the
content heuristics (sensitivity markings, payment cards, government IDs, credentials) — and anything
past the organization's **daily message cap** (default 5,000 provider calls per UTC day).

**Modes.**

- **Off** — no calls, no records.
- **Shadow** — record verdicts only (`mail_decision_verdicts`); mailboxes and messages are untouched.
  Use it first and compare with the report below.
- **Enforce** — record, then act, only for outside senders:
  - `spam` or `scam` at or above the **spam threshold** (default 0.90), or `phishing` at or above the
    **phishing threshold** (default 0.80): the thread is filed into Spam for every recipient exactly
    like ingest does (`spam_at`), with an `auto_decision_model` feedback row. Mailboxes already in
    Spam, or whose owner said **Not spam** for that thread, are left alone. Phishing adds a strong
    warning flag to the message evidence. Post-storage mail is never quarantined or deleted.
  - With **Apply categories** on, a category at or above the **category threshold** (default 0.75)
    replaces the tab the ingest heuristic chose (only while the tab still holds that heuristic value).
  - The message stores compact evidence in `metadata.decision` (provider, model, verdict,
    confidence, phishing flag, action, category, needs reply, urgency) that the thread view shows,
    and open inboxes refresh through an `activity.mail.updated` event.

**Failure handling.** Provider errors, timeouts, rate limits (429), and overload (529) fail open:
no mailbox change, an `error` verdict row with the reason, and a metric. Calls go through the
hardened outbound HTTP client to the provider's exact host only (`api.cloudflare.com`,
`api.typesafe.ai`, or the configured TypeSafe-compatible HTTPS base URL such as
`https://openrouter.ai/api`), with a 10-second timeout and at most two retries with backoff for
429, 529, 5xx, and network errors. Each message is decided at most once.

**Configuration and credentials.** Settings live in the tenant feature flags
(`mail_decision_model`), so every change is versioned in tenant-config history and audited
(`mail.decision_model.updated`; connection tests as `mail.decision_model.tested`). The API key or
token is write-only: it is sealed with the per-tenant envelope cipher in
`mail_decision_model_credentials` and the API only reports `credentialConfigured`. Cloudflare needs
the account ID and a token with Workers AI Read and Edit; TypeSafe needs an API key from
console.typesafe.ai. No environment variables are involved.

| Route                                       | Permission                                       |
| ------------------------------------------- | ------------------------------------------------ |
| `GET /api/admin/mail/spam`                  | `mail.admin`, `admin.config.read`, or admin read |
| `GET /api/admin/mail/decision-model`        | same as above                                    |
| `PUT /api/admin/mail/decision-model`        | `mail.admin` or `admin.console.write`            |
| `POST /api/admin/mail/decision-model/test`  | `mail.admin` or `admin.console.write`            |
| `GET /api/admin/mail/decision-model/report` | read, `?days=1..90` (default 30)                 |

**Report.** For the window: counts by outcome and skip/error reason, verdict and action counts,
agreement with SpamAssassin, and — against people's own **Spam / Not spam** actions as ground
truth (feedback rows now carry the message ID) — precision, recall, and the **false-positive rate on
mail people kept**, for the model and for SpamAssassin side by side. A message counts as flagged when
its proposed action is spam or phishing after the thresholds, in shadow and enforce mode alike. It
also shows average and p95 latency, tokens, an estimated cost from list prices (Jev $0.042, Clef
$0.24, Clef-flash $0.038 per million input tokens; overridable per org), and up to 20 recent
disagreements as message ID, sender domain, verdict, confidence, and the person's label — never
subjects or bodies. Enable enforce mode only when the model's false-positive rate is at or below
SpamAssassin's.

**Metrics.** `helix_mail_decision_requests_total{provider,outcome}`,
`helix_mail_decision_latency_seconds{provider}`, `helix_mail_decision_actions_total{action}`.

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
