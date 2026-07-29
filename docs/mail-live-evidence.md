# Mail live evidence

`pnpm quality:mail-live-evidence` is the dedicated M7 release smoke. It emits
`helix.mail-live-evidence.v1` JSON suitable for
`artifacts/release-readiness/<date>/<git-sha>/mail-live-evidence.json`.

The smoke has two intentionally different uses:

- `--static` validates the evidence contract without network access. Every live scenario is
  recorded as `not_run`; this output is not release evidence.
- `--local` exercises a running Helix stack, its real SMTP receiver, Mailpit, SpamAssassin, ClamAV,
  PostgreSQL-backed provider event/suppression state, and the outbound worker.

The local run sends one clean SMTP transaction to recipients in two organizations and verifies
that both receive tenant-safe copies without seeing the other organization's recipient. It then
checks clean and GTUBE spam routing, EICAR quarantine, outbound Mailpit delivery, signed hard-bounce
and complaint webhooks, durable webhook deduplication, suppression, and explicit retry of the same
failed outbound identity.

## Local prerequisites

Run the Mail-enabled development stack with:

- two verified receiving domains/mailboxes in different organizations;
- the in-process Helix SMTP receiver;
- SpamAssassin and ClamAV enabled;
- Mailpit as the local outbound sink;
- one enabled Mailgun-compatible provider row with a webhook secret reference;
- the quarantine and provider webhook/admin routes enabled;
- bearer tokens for both recipient actors and a mail administrator.

The webhook secret passed to the smoke must be the same test-only value resolved from the
configured provider's secret reference. Never use a production secret in local evidence.

```sh
evidence_dir="artifacts/release-readiness/$(date +%F)/$(git rev-parse HEAD)"
mkdir -p "$evidence_dir"

HELIX_MAIL_LIVE_ORG_A_TOKEN=<org-a-token> \
HELIX_MAIL_LIVE_ORG_B_TOKEN=<org-b-token> \
HELIX_MAIL_LIVE_ADMIN_TOKEN=<admin-token> \
HELIX_MAIL_LIVE_ORG_A_RECIPIENT=probe@org-a.test \
HELIX_MAIL_LIVE_ORG_B_RECIPIENT=probe@org-b.test \
HELIX_MAIL_LIVE_OUTBOUND_RECIPIENT=mailpit-probe@example.net \
HELIX_MAIL_LIVE_BOUNCE_RECIPIENT=hard-bounce@example.net \
HELIX_MAIL_LIVE_COMPLAINT_RECIPIENT=complaint@example.net \
HELIX_MAIL_LIVE_PROVIDER_ORG_ID=<organization-uuid> \
HELIX_MAIL_LIVE_PROVIDER_ID=<provider-uuid> \
HELIX_MAIL_LIVE_PROVIDER_WEBHOOK_SECRET=<local-test-secret> \
HELIX_MAIL_LIVE_OUTPUT="$evidence_dir/mail-live-evidence.json" \
  pnpm quality:mail-live-evidence -- --local
```

Evidence contains recipient domains, one-way address/message ID hashes, timestamps, latency,
authentication-safe outcomes, and final statuses. It rejects fields named for credentials,
secrets, tokens, message bodies, subjects, or direct recipient addresses.

## External opt-in evidence

The local smoke always emits `not_run` for `provider_sandbox`, `gmail`, and `microsoft365`.
It never turns Mailpit results or synthetic signed webhooks into external deliverability claims.

For an approved external run, use a dedicated test domain and provider sandbox/account plus
controlled Gmail and Microsoft 365 seed inboxes. Run
`pnpm quality:mail-deliverability-smoke` separately for each recipient provider. Capture:

- provider and recipient domain;
- send, provider-acceptance, and observed-receipt timestamps and latency;
- anonymized provider and RFC 822 message IDs;
- SPF, DKIM, and DMARC results from the received headers;
- observed inbox or spam/junk placement, without claiming guaranteed placement;
- provider sandbox bounce and complaint event IDs and the resulting Helix suppression status.

Store only sanitized reports beside `mail-live-evidence.json`. Do not store mailbox passwords,
OAuth tokens, provider signing secrets, recipient local parts, or message bodies. Helix does not
provide IMAP; the external deliverability smoke uses the controlled recipient provider solely as
test infrastructure.

After replacing a target's `not_run` record with observed external results, validate the combined
report before attaching it:

```sh
pnpm quality:mail-live-evidence -- --validate "$evidence_dir/mail-live-evidence.json"
```

Passed Gmail and Microsoft 365 records require provider, recipient domain, anonymized message ID,
latency, final status, observed placement, and SPF/DKIM/DMARC results. Passed provider-sandbox
records require both suppressed hard-bounce and complaint events with anonymized event IDs.

Release-manifest generation can fail closed on this report:

```sh
pnpm quality:release-readiness-manifest -- \
  --evidence-dir "$evidence_dir" \
  --mail-live-evidence mail-live-evidence.json \
  --require-external-mail-evidence \
  <image digest options>
```

Omit `--require-external-mail-evidence` for local-only preflight manifests; the manifest will retain
the external `not_run` statuses rather than promoting them to passes.
