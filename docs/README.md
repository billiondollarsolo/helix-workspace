# Helix documentation

[Back to Helix](../README.md)

Helix is a self-hostable communication and file-storage workspace. Start with the
guide for your task. The [1.0 scope](release/1.0-scope.md) is the authority for
shipped features, production packaging, security disclosures, and launch limits.

## Get started

- [Local development](development.md): prerequisites, configuration, startup, ports, checks, and troubleshooting.
- [Demo data](demo-data.md): fictional workspace, sign-ins, presets, and safe reseeding.
- [Pilot installation](runbooks/pilot-install-zero-to-mail.md): production setup through first mail, chat, and file upload.
- [Production deployment](deployment-production.md): secrets, dependencies, image trust, and deployment gates.
- [Hetzner staging and agent testing](runbooks/hetzner-workspace-prestage.md): host prestage, activation inputs, and local or hosted agent access.
- [Platform versions](platform-version-policy.md): supported runtimes, containers, and Kubernetes tools.

## Use and administer

- [Admin guide](admin-guide.md): accounts, policies, audit, and operational controls.
- [Domains, addresses, and groups](runbooks/domains-addresses-and-groups.md) and [domain identity](domain-identity.md).
- [Account offboarding and admin safeguards](runbooks/account-offboarding-and-admin-safeguards.md).
- [Managed outbound mail](mail-managed-provider-delivery.md), [mail client interoperability](runbooks/mail-client-interoperability.md), and [mail security](mail-security-and-reliability.md).
- [Drive desktop sync](drive-desktop-sync.md), [S3-compatible API](drive-s3-api.md), and [storage security](drive-storage-security.md).
- [Local AI and retrieval](runbooks/local-ai-retrieval.md).
- [Meet setup](../infra/meet/README.md) and [support boundaries](meet-support-and-slos.md) for separately configured full-profile deployments.

## Integrate and develop

- [Development guide and repository map](development.md#repository-map).
- [External application integration: Helix Bot](../apps/web/public/agent-integration.md).
- [Workspace-managed app identity, bootstrap and recovery](runbooks/app-family-identity.md).
- [CLI installation and SDK integration](reference/clients.md).
- [Environment reference](reference/environment.md).
- [Tool and channel inventory](architecture/mvp-tool-channel-inventory.md): REST, CLI, and MCP coverage.
- [Webhook verification](webhooks/verify.md).
- [Request rate policy](architecture/request-rate-policy.md).
- [Provider-assisted setup proposal](architecture/provider-assisted-setup.md).
- [Accessibility](accessibility.md).
- [Architecture decisions](adr/README.md), [surface inventory](architecture/v1-surface-inventory.md), and [packaging matrix](architecture/v1-packaging-matrix.md).

A running API publishes `/v1/openapi.json` and `/v1/asyncapi.json`. Its tool catalog is
available at `/v1/api/tools`, with MCP at `/v1/mcp`; authenticated access and actor scopes
apply. The [operations runbook](RUNBOOK.md) covers API access and diagnostics.

## Operate and recover

- [Operations runbook](RUNBOOK.md) and [troubleshooting](troubleshooting.md).
- [Backup and restore](backup-restore.md), [recovery procedures](runbooks/backup-restore-recovery.md), and [backup jobs](runbooks/backup-restore-jobs.md).
- [Observability](observability.md), [production monitoring](runbooks/observability-production.md), and [SLO breaches](runbooks/product-slo-breach.md).
- [Mail delivery](runbooks/mail-deliverability.md), [provider outages](runbooks/mail-provider-outage.md), and [bounce/complaint spikes](runbooks/mail-bounce-complaint-spike.md).
- [Scanner outages](runbooks/drive-scanner-outage.md), [storage mismatches](runbooks/object-store-data-mismatch.md), and [low disk space](runbooks/node-filesystem-low-space.md).
- [Chat outages](runbooks/chat-nats-redis-outage.md), [outbox backlog](runbooks/outbox-worker-backlog.md), and [search lag](runbooks/search-projection-lag.md).
- [Dependency outages](runbooks/platform-dependency-outage.md), [audit shipping failures](runbooks/audit-integrity-shipping-failure.md), and [secret rotation](runbooks/secret-certificate-rotation.md).
- [Helm chart](../infra/helm/helix/README.md) and [Compose/Helm parity](architecture/compose-helm-parity.md).

## Security and release readiness

- [Threat model](security/threat-model.md) and [agent incident response](runbooks/agent-security-incident.md).
- [Supply-chain security](supply-chain-security.md) and [negative security matrix](security/v2-negative-security-matrix.md).
- [1.0 scope and business pilot boundaries](release/1.0-scope.md).
- [Release checklist](release/checklist.md), [final readiness gate](final-release-readiness.md), and [supporting evidence](final-release-supporting-evidence.md).
- Live evidence: [Mail](mail-live-evidence.md), [Drive](drive-live-evidence.md), [Chat](chat-live-evidence.md), [agents](agent-live-evidence.md), [failure recovery](failure-recovery-evidence.md), and [DAST](dast-evidence.md).

## Maintainer records

- [Workspace quality and optional AI roadmap — 2026-10-14](plans/2026-10-14-workspace-quality-and-optional-ai.md).
- [System quality review — 2026-10-14](reviews/2026-10-14-system-quality-review.md).

[Implementation status](release/implementation-status.md) records prior verification;
it is not a substitute for current checks. [Archived plans](archive/README.md) are
historical and do not define current product scope. Dated reviews and plans should
be read against the revision they name.

- [Project review and PR triage — 2026-10-12](reviews/2026-10-12-project-review.md).
