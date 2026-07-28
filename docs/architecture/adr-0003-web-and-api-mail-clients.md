# ADR-0003: Web and API mail clients

- **Status:** Accepted
- **Date:** 2026-07-28
- **Plan decision:** RD-3

## Context

Helix provides a web mail surface and programmatic REST, MCP, CLI, and notification interfaces. It
does not contain a Helix-hosted IMAP server. IMAP would add a separate protocol, synchronization
model, mailbox semantics, compatibility matrix, authentication surface, and operations burden.
Ambiguous documentation can lead operators to expose credentials or promise unsupported client
compatibility.

An external deliverability test may read a controlled recipient mailbox through that mailbox
provider's IMAP endpoint. That test mechanism is not a Helix client capability.

## Decision

Launch Mail through the Helix web UI and supported REST, MCP, CLI, and notification interfaces.
Do not add or advertise a Helix-hosted IMAP server for the Business pilot.

App-password scopes, settings, setup instructions, product copy, and support answers must not imply
that desktop or mobile IMAP clients can connect to Helix. Any reference to IMAP in release
documentation must clearly identify a third-party mailbox used only to verify external delivery.

## Alternatives considered

- **Ship IMAP before the pilot:** rejected because its protocol and synchronization work would
  delay the core mail, storage, chat, and agent safety gates.
- **Advertise partial or experimental IMAP:** rejected because partial compatibility is likely to
  cause client data-loss and support problems.
- **Remove programmatic mail access:** rejected because scoped APIs are required for agentic
  workflows and are already part of the product architecture.

## Consequences

- The launch claim is “web/API-first mail,” not “works with every mail client.”
- External mailbox polling in deliverability tooling must be explicitly labelled as third-party
  test infrastructure.
- Native editing and mail-client protocol expansion remain separate future projects.
- Unsupported IMAP settings or controls must be removed or disabled with a clear explanation.

## Reversal triggers

Reconsider after a separate IMAP plan defines protocol coverage, authentication and app-password
scopes, mailbox and flag synchronization, concurrency, search, quota behavior, compatibility
clients, migrations, monitoring, load tests, and recovery semantics.
