# Helix Workspace

Helix 1.0 is an invite-only, self-hostable workspace for **Mail, Drive, Chat, Assistant, and Admin**.
The initial production target is one organization with 5–50 trusted users on the `business` security
tier. Calendar and Meet are dormant behind the `full` profile and are outside 1.0.

The [canonical 1.0 scope](docs/release/1.0-scope.md) defines the shipped surfaces and non-claims.
Production uses `HELIX_APPS=mail,drive,chat,assistant` and `VITE_HELIX_MVP_ONLY=true`.
Package versions alone do not establish production readiness.

## Business pilot boundaries

- Internet mail delivery requires a supported managed outbound email provider. Helix does not
  operate direct-to-MX outbound delivery for the pilot.
- Mail is available through the Helix web UI and supported APIs. The pilot does not include a
  Helix-hosted IMAP server.
- Drive provides file upload, storage, organization, versions, sharing, download, and WebDAV.
  Editors, file viewers, and converters are not part of this product.
- Chat uses TLS, organization and room authorization, retention controls, and deployment-attested
  encrypted storage. Chat is **not end-to-end encrypted**, and authorized server administrators can
  technically access stored messages.
- Authorized agent reads may execute immediately. Agent writes require authenticated human
  confirmation by default unless an explicit, audited automation policy limits the exact action,
  resource, target, time window, and rate.
- Untrusted Business-tier uploads remain unavailable until integrity checks and a real malware
  scanner return a clean verdict. Scanner failures remain quarantined.
- Pilot objectives are 99.5% monthly availability, an RPO of no more than 24 hours, and an RTO of
  no more than 4 hours. These are engineering objectives, not a contractual SLA.

The runtime retains tenant-aware interfaces, but public multi-tenant SaaS is not an approved launch claim.

- [Production deployment](docs/deployment-production.md)
- [Admin guide](docs/admin-guide.md)
- [Operations runbook](docs/RUNBOOK.md)
- [Security threat model](docs/security/threat-model.md)
- [Architecture decisions](docs/adr/README.md)

Licensed under [Apache-2.0](LICENSE); see [NOTICE](NOTICE) and [third-party notices](THIRD_PARTY_NOTICES.md).

## Development

Required local tools:

- Node.js 24.18.0 LTS (the exact version is in `.node-version`)
- pnpm 11.18.0 (activated from `packageManager` with Corepack)
- Docker Engine 29.x with Compose 5.x for the fully validated local stack
- Helm 4.2.3 and kubeconform 0.8.0 for Kubernetes chart validation

See the [platform version policy](docs/platform-version-policy.md) for the complete runtime,
container, Kubernetes, and compatibility matrix.

Common commands:

```sh
pnpm install
pnpm typecheck
pnpm lint
pnpm test
pnpm dev
```

Local infrastructure is defined in `docker-compose.yml`. Exposed ports default to a
contiguous high-port block to avoid colliding with system Postgres, Redis, HTTP, HTTPS,
or SMTP services during tests. Base Tier 1 uses `28431`-`28443`; optional profiles occupy
`28444`-`28455`; local mail receive/outbound test ports use `28456`-`28458`; the
observability Alertmanager proof uses `28461`-`28462`. Run
`pnpm infra:config` and `pnpm infra:config:observability` for TASK-121 compose evidence.
