# ADR-0004: Secure server-readable organization chat

- **Status:** Accepted
- **Date:** 2026-07-28
- **Plan decision:** RD-4

## Context

Helix stores chat messages on the server and supports organization search, moderation, retention,
export, bots, and scoped agent access. There is no per-device identity-key or group-key protocol.
Calling the current model end-to-end encrypted would be false and would conflict with those server
capabilities.

The pilot still requires meaningful confidentiality: authenticated access, organization and room
membership enforcement, encrypted transport, storage encryption evidence, safe content handling,
retention, and audited administrative access.

## Decision

Provide conventional secure organization chat. Chat uses TLS in transit, deployment-attested
encryption at rest, server-enforced organization and room membership, retention controls, and
audited administrative access.

Chat is **not end-to-end encrypted**. Authorized server administrators can technically access
stored messages. Product, operator, privacy, and security documentation must state this
distinction directly.

## Alternatives considered

- **Claim E2EE over TLS and encrypted disks:** rejected because those controls do not prevent the
  server from reading messages.
- **Add E2EE incrementally to the existing message field:** rejected because a safe group protocol
  requires device identities, key rotation, recovery, and explicit behavior for search, exports,
  bots, and agents.
- **Unencrypted transport or storage:** rejected because it does not meet the Business-pilot
  confidentiality bar.

## Consequences

- Server-side search, moderation, retention, export, bots, and authorized agent reads remain
  possible.
- Administrators and users must receive an accurate disclosure of server readability.
- TLS and at-rest encryption are deployment controls that require evidence; configuration labels
  alone do not prove them.
- Room authorization, WebSocket origin controls, content sanitization, attachment scanning,
  retention, and audit remain launch gates.

## Reversal triggers

If E2EE becomes a product requirement, stop and create a separate protocol ADR covering device
identity and verification, key distribution and rotation, membership changes, multi-device
recovery, backups, search, moderation, legal hold, exports, bots, agents, metadata leakage, and
migration of existing messages.
