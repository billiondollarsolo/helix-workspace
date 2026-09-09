# ADR-0002: Managed outbound mail provider

- **Status:** Accepted
- **Date:** 2026-07-28
- **Plan decision:** RD-2

## Context

Reliable Internet mail delivery requires more than opening an SMTP connection. Sender reputation,
DKIM signing, SPF/DMARC alignment, bounce and complaint feedback, suppression, retry behavior,
blocklist response, and abuse handling are launch-critical. Direct-to-MX operation would make the
Helix operator responsible for IP reputation and mail-transfer-agent operations that are outside
the Business-pilot scope.

Helix already has provider adapters and an outbound queue, so the product can retain provider
choice without becoming a direct Internet MTA.

## Decision

Production outbound Internet mail must use a supported managed provider such as Amazon SES,
Postmark, Mailgun, or an approved managed SMTP relay. At least one selected provider must be
verified end to end for the pilot.

The provider performs launch DKIM signing and exposes authenticated delivery, bounce, complaint,
and suppression feedback. Helix stores safe provider identifiers and normalized event state,
enforces suppression, and presents delivery status. Helix will not operate direct-to-MX outbound
delivery for this launch.

Mailpit and similar sinks remain local test infrastructure and are not production providers or
deliverability evidence.

## Alternatives considered

- **Direct-to-MX Helix delivery:** rejected because it adds reputation, warm-up, blocklist, retry,
  and abuse-response obligations beyond the pilot.
- **One hard-coded provider:** rejected because deployment portability matters; the selected launch
  integration can be mandatory without eliminating the provider abstraction.
- **Unauthenticated generic relay:** rejected because production evidence needs signing and
  authenticated feedback events.

## Consequences

- Production boot must fail when outbound mail is enabled without a supported provider.
- Provider secrets must be resolved securely and must not appear in logs, audits, or database
  configuration.
- Provider-specific DNS, webhook verification, event idempotency, suppression, and incident
  procedures are required launch evidence.
- Helix may describe mail as provider-backed, but may not claim Gmail-equivalent placement or
  global deliverability.
- Local DKIM-key controls must be hidden or qualified unless an active transport consumes them.

## Reversal triggers

Reconsider direct-to-MX only through a new ADR backed by a staffed MTA operations model, dedicated
IP/reputation strategy, queue and retry evidence, abuse and blocklist response procedures,
deliverability monitoring, and a security review.
