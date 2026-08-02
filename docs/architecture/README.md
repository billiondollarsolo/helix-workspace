# Architecture decision records

Architecture decision records (ADRs) capture decisions that constrain the Helix Business pilot.
They are normative for implementation and product documentation until superseded by a later,
owner-approved ADR.

## Status vocabulary

- **Accepted:** approved and required for the current implementation.
- **Superseded:** replaced by a newer ADR; the replacement must be linked.
- **Proposed:** under review and not yet an implementation requirement.
- **Deprecated:** retained for historical context but no longer applicable.

## Accepted Business-pilot decisions

| Plan decision | ADR                                                             | Summary                                                                                    |
| ------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| RD-1          | [ADR-0001](adr-0001-single-organization-business-pilot.md)      | Launch one organization with 5–50 trusted users while preserving tenant-safe internals.    |
| RD-2          | [ADR-0002](adr-0002-managed-outbound-mail-provider.md)          | Use a managed provider for production outbound Internet mail; do not operate direct-to-MX. |
| RD-3          | [ADR-0003](adr-0003-web-and-api-mail-clients.md)                | Support web and API mail clients; do not ship a Helix-hosted IMAP server.                  |
| RD-4          | [ADR-0004](adr-0004-secure-server-readable-chat.md)             | Provide secure organization chat that is explicitly not end-to-end encrypted.              |
| RD-5          | [ADR-0005](adr-0005-agent-write-confirmation-and-allowlists.md) | Confirm agent writes by default and permit only bounded, audited automation exceptions.    |
| RD-6          | [ADR-0006](adr-0006-business-pilot-recovery-targets.md)         | Target 99.5% monthly availability, RPO ≤ 24 hours, and RTO ≤ 4 hours.                      |
| RD-7          | [ADR-0007](adr-0007-fail-closed-untrusted-uploads.md)           | Keep untrusted uploads unavailable until a real malware scanner returns a clean verdict.   |

## Maintenance

When an accepted decision changes:

1. create a new ADR explaining the new context and migration;
2. mark the old ADR `Superseded by ADR-NNNN` without rewriting its history;
3. update this index, the production-readiness plan, `README.md`, `docs/admin-guide.md`, and
   `docs/security/threat-model.md`; and
4. update the launch-documentation fidelity test.

The source decision set is the
[core workspace production-readiness plan](../superpowers/plans/2026-07-28-core-workspace-production-readiness.md).

## Full Workspace v1 ADRs (G0.7)

| ADR                                                                                            | Title                        |
| ---------------------------------------------------------------------------------------------- | ---------------------------- |
| [adr-0008-meet-via-jitsi.md](./adr-0008-meet-via-jitsi.md)                                     | Meet via Jitsi               |
| [adr-0009-full-workspace-calendar.md](./adr-0009-full-workspace-calendar.md)                   | Calendar                     |
| [adr-0010-editors-collab-model-v1.md](./adr-0010-editors-collab-model-v1.md)                   | Editors collab model         |
| [adr-0011-multi-org-self-host-ordering.md](./adr-0011-multi-org-self-host-ordering.md)         | Multi-org self-host ordering |
| [adr-0012-public-saas-deferred-after-v1-ga.md](./adr-0012-public-saas-deferred-after-v1-ga.md) | SaaS deferred                |
| [adr-0013-mobile-web-required-native-out.md](./adr-0013-mobile-web-required-native-out.md)     | Mobile web only              |

## G0 baseline docs

| Doc                                                            | Task |
| -------------------------------------------------------------- | ---- |
| [v1-surface-inventory.md](./v1-surface-inventory.md)           | G0.1 |
| [v1-branch-policy.md](./v1-branch-policy.md)                   | G0.2 |
| [v1-baseline-smoke-notes.md](./v1-baseline-smoke-notes.md)     | G0.3 |
| [v1-evidence-layout.md](./v1-evidence-layout.md)               | G0.5 |
| [v1-packaging-matrix.md](./v1-packaging-matrix.md)             | G0.6 |
| [v1-old-to-new-task-id-map.md](./v1-old-to-new-task-id-map.md) | G0.8 |

## Ops dual-target (O / O-DOCKER / O-K8S / O-X)

| Doc                                                        | Task        |
| ---------------------------------------------------------- | ----------- |
| [ha-rpo-rto.md](./ha-rpo-rto.md)                           | O4, O-D.13, O-K.16 |
| [compose-helm-parity.md](./compose-helm-parity.md)         | O-X.1       |
| [v1-packaging-matrix.md](./v1-packaging-matrix.md)         | G0.6 / PKG  |

Forward execution plan: [`../superpowers/plans/2026-08-02-helix-full-workspace-v1-release.md`](../superpowers/plans/2026-08-02-helix-full-workspace-v1-release.md)
