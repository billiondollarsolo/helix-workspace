# Helix Workspace

Helix is a productivity platform being productionized as a self-hostable workspace for web email,
shared file storage, authenticated organization chat, and approval-gated AI/agent workflows. The
initial production target is one organization with 5–50 trusted users on the `business` security
tier. Until the production-readiness gates below pass, these are target boundaries rather than a
production-readiness claim.

## Business pilot boundaries

- Internet mail delivery requires a supported managed outbound email provider. Helix does not
  operate direct-to-MX outbound delivery for the pilot.
- Mail is available through the Helix web UI and supported APIs. The pilot does not include a
  Helix-hosted IMAP server.
- Drive provides file upload, storage, organization, versions, sharing, download, and WebDAV.
  Native document editing is outside this MVP.
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

The runtime retains tenant-aware interfaces and test modes, but public multi-tenant SaaS is not an
approved launch claim. See the [architecture decision records](docs/architecture/README.md) and
[production-readiness plan](docs/superpowers/plans/2026-07-28-core-workspace-production-readiness.md)
for the normative boundaries and release gates.

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

Synthetic signup SLO evidence for SaaS-mode stacks is available with:

```sh
pnpm quality:synthetic-signup-probe
```

The probe creates a unique public signup, reads the verification link from
Mailpit, verifies the email, and fails if activation takes longer than 60s.
Bundled Alertmanager routing for those alerts can be proven locally with:

```sh
pnpm quality:alertmanager-signup-routing
```

Local infrastructure is defined in `docker-compose.yml`. Exposed ports default to a
contiguous high-port block to avoid colliding with system Postgres, Redis, HTTP, HTTPS,
or SMTP services during tests. Base Tier 1 uses `28431`-`28443`; optional profiles occupy
`28444`-`28455`; local mail receive/outbound test ports use `28456`-`28458`; the
observability Alertmanager proof uses `28461`-`28462`. Run
`pnpm infra:config` and `pnpm infra:config:observability` for TASK-121 compose evidence.
