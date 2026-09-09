# Mail deliverability operations

Helix measures authentication, handoff, final delivery, bounces, complaints, and queue recovery. A
successful release packet is evidence for the tested domains and recipients only. It is not a claim
of Gmail-equivalent global reputation or inbox placement.

## Release gate

The mail owner stores one access-controlled packet per release. Every command below must pass; a
missing result is a failed gate.

1. Run the public DNS/TLS readiness check for every sending domain and SMTP IP. It checks MX,
   forward-confirmed PTR, SPF, the active DKIM selector, DMARC, MTA-STS, TLS-RPT, and a trusted SMTP
   STARTTLS handshake.

   ```sh
   HELIX_MAIL_EDGE_DNS_DOMAIN=example.com \
   HELIX_MAIL_EDGE_DNS_HOST=mx1.example.com \
   HELIX_MAIL_EDGE_DNS_IP=203.0.113.10 \
   HELIX_MAIL_EDGE_DKIM_SELECTOR=helix-202609 \
     pnpm infra:mail-edge:validate -- --dns
   ```

2. Send a unique seed through the real Helix queue to each approved Gmail/Microsoft probe mailbox.
   The probe fails unless it finds the message, meets the latency threshold, and the receiver's own
   `Authentication-Results` reports DMARC plus aligned DKIM or SPF. Store the JSON output as the
   seed-test artifact; never use Mailpit for this evidence.

   ```sh
   HELIX_DELIVERABILITY_RECIPIENT=deliverability-probe@example.net \
   HELIX_DELIVERABILITY_FROM_DOMAIN=example.com \
   HELIX_DELIVERABILITY_IMAP_HOST=imap.example.net \
   HELIX_DELIVERABILITY_IMAP_USER=deliverability-probe@example.net \
   HELIX_DELIVERABILITY_IMAP_PASSWORD=<injected-secret> \
   HELIX_DELIVERABILITY_OUTPUT=/secure/release/mail-seed.json \
     pnpm quality:mail-deliverability-smoke
   ```

   Inject `HELIX_DELIVERABILITY_IMAP_PASSWORD` through the job secret mechanism; do not commit it or
   place it in the artifact.

3. Export the tenant's Mail configuration panel and Deliverability panel. The configuration API is
   actor-org scoped and reports accepted, delivered, deferred, bounced, complained, queued, and
   failed counts. Record terminal delivery/bounce/complaint rates, DMARC aggregate pass rates,
   suppressions, and the recent delivery-event diagnostics. Never combine tenants in this artifact.
4. Attach the current Product SLO report. `mail.queue.p95_seconds` and
   `mail.delivery.p95_seconds` must pass the selected tier with non-empty provenance. Attach the
   alert state for mail delivery failures and the external seed latency.
5. Exercise recovery by creating a controlled transient provider failure, observing a retry and
   dead-letter if the retry budget is exhausted, restoring the provider, and using the audited admin
   replay with a reason. Attach outbound id, attempt count, dead-letter timestamp, audit event, and
   final external receipt. Do not replay accepted mail merely because final-delivery feedback is late.

The packet records release id, time window, tenant org id, domains/selectors/IPs, provider ids,
immutable CI/artifact references, all commands, redacted outputs, and the named Mail/postmaster
approvers. Raw mailbox credentials, provider credentials, recipient addresses beyond controlled
probes, and message bodies are excluded.

## Postmaster and abuse response

The postmaster owns DMARC aggregate reports, provider feedback signatures, suppressions, DNSBL and
TLS-RPT alerts, and Postfix/Rspamd daily summaries. On a bounce or complaint spike:

1. Freeze the affected tenant/provider while preserving other tenant traffic. Confirm the spike in
   tenant-scoped delivery events and DMARC reports; treat absent feedback as an incident.
2. Keep hard-bounce and complaint suppressions in place. Removal requires recipient confirmation, a
   reason, write authority, and the existing audit event.
3. Correlate provider id, handoff id, recipient domain, DKIM selector, source IP, queue age, and the
   last diagnostic. Do not export recipient addresses to shared metrics or logs.
4. Correct the list/source/authentication issue, send only controlled seeds, then gradually restore
   traffic. Escalate active abuse to the provider and security owner; retain the evidence per policy.

## Provider failover policy

Provider failover is deliberately operator-controlled. Automatic resend after an accepted handoff can
duplicate mail, so a provider is changed only when the team can prove the message was not accepted.
Disable the unhealthy provider, enable and select a tenant-configured provider with verified SPF/DKIM,
feedback signing, rate limits, and seed results, then replay only durable queued/dead-lettered records.
The provider configuration change and every replay require admin authority and audit evidence. If
acceptance is ambiguous, hold the record for reconciliation instead of sending through both providers.

After recovery, re-run the public readiness check, both external seeds, and the SLO report. Follow
[`product-slo-breach.md`](product-slo-breach.md) for error-budget handling and
[`infra/mail-edge/README.md`](../../infra/mail-edge/README.md) for inbound-edge alerts.
