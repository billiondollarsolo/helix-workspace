# Federation backup management qualification — 2026-10-17

## Hosted recovery follow-up — 2026-10-19

Both hosted recovery workers are enrolled and active. Encrypted off-server
archives were authenticated, every manifest/file digest checked, and both apps'
databases, private state, keys and Workspace object/KMS volumes restored into
disposable Docker volumes. The restored apps have no public ports or outbound
network; Workspace outbound mail and SMTP reception are disabled.

Both original restored apps started. Their restored databases then upgraded to
Bot `7d5bdb6` (schema 7) and Workspace `d74ba3f` (251 migration rows). The packaged
Workspace migrator applied two migrations and skipped 249. Both current apps
report ready. The current Workspace API downloaded an authenticated 1,875,041-byte
restored object matching its stored SHA-256; unauthenticated access was denied.
The original paired-app inventory also survived.

A fresh post-pilot database copy exercised actual restored Bot identity services:
installation/key checks, recovered federation-vault decryption, stale managed-access
denial, authenticated directory checkpoint, session creation, assignment removal
and rejection of that existing session. The local password-capable recovery Owner
remained usable. This checks Bot's recovery behavior; the independent restored
Workspace-to-Bot reconciliation delivery is still separate.

Backup operator metadata now records the current schemas, and full-server
capture resolves each active release bundle from its operator configuration.
A fresh authenticated encrypted off-server checkpoint includes operator keys,
journals, deployment configuration and the reviewed API/web/Bot source bundles.
Fresh encrypted database dumps restored separately after the hosted pilot.
Private evidence is under
`~/.local/share/helix-recovery/20261019/integration-completion/`.

Production promotion, host reboot and live Kubernetes qualification remain
unperformed. Do not promote a recovered managed identity before reconciling its
current upstream assignment. Restoring a database dump into a new database must
also preserve the original database owner; table ownership alone does not grant
the runtime schema creation privileges needed by Bot's migration checks.

## Original implementation qualification

Implemented in both repositories; optional recovery enrollment defaults off.
The [operator runbook](app-federation-backups.md) covers activation and recovery.

Verified locally:

- Workspace's required full test run passed: 4,023 backend tests, 1,440 web tests,
  plus the remaining package tests. The normal suite skipped 432 backend tests
  requiring external/live fixtures; it is not a full live-system claim.
- The latest dedicated PostgreSQL qualification passed seven tests across two
  files. It runs actual tenant/RLS tables and two HTTP recovery workers, covering
  exact installation binding, tenant denial, independent credentials, durable
  policy acknowledgement, lost-reply retries, expired restore leases, removed
  approver authority, isolated restore requests, audit digests, source-policy
  rollback, detach, offline schedules and unknown-operation handling. Its worker
  command receipts are fixture receipts rather than real Workspace object backups.
- The existing live federation identity/provider regression passed separately after
  extending the shared audit writer.
- A real Bot adapter check captured and encrypted an actual PostgreSQL database
  and private file, checked ciphertext/manifest/file digests, and restored a
  conversation, file and installation identity into a separate database/directory.
  It deliberately claims neither off-host storage nor executor/coding volume recovery.
- Bot's existing cold-backup regression passed; its optional coding-volume case
  remains skipped by the existing fixture. Bot static checks, types and build passed.
- The new Workspace admin page passed Chromium enrollment/error/draft checks and
  an axe accessibility scan; focused React/request-budget tests passed too.
- Both Helm charts rendered with the optional executor and rejected missing
  capabilities/network settings and conflicting scheduler ownership. Both Compose
  overlays rendered without a host port or automatic Docker socket. Existing
  Workspace Helm/CNPG/Barman and Bot Helm checks passed. kubeconform was unavailable,
  so this does not assert live cluster admission/schema qualification.
- Both Workspace Caddy configurations adapted with the recovery prefix using
  the existing built Caddy image. The new worker image built successfully and ran
  as UID/GID 10001 with a read-only root, private projected-style key/config files,
  durable journal volume, authenticated status and no published port.
- Workspace formatting, types, lint, build and dependency boundaries passed.

Reproduce the new focused checks from Workspace:

```sh
pnpm --filter @helix/app exec vitest run src/platform/backup/federation-worker.test.ts src/platform/backup/federation-management.integration.test.ts
pnpm --filter @helix/web exec vitest run src/features/admin/sections/federation-backups.test.tsx src/features/admin/admin-request-budget.test.tsx
pnpm --filter @helix/web exec playwright test tests/e2e/admin-federation-backups.spec.ts
node --test infra/scripts/federation-backup-deployments.test.mjs
docker build --target backup-worker -f infra/docker/Dockerfile -t helix-federation-backup-worker:dev .
node infra/scripts/federation-backup-worker-smoke.mjs helix-federation-backup-worker:dev
```

The database integration needs the existing migrated isolated test database and
RLS role environment. Use both adjacent repositories for the cross-app deployment
and real Bot recovery checks; the latter command is in Bot's backup runbook.

At the original 2026-10-17 implementation checkpoint this was not activated on the
hosted installation. An operator must choose
actual backup custody/storage, mount required snapshots, provide qualified commands,
perform the scheduler handoff, route HTTPS and enroll separate capabilities.
The 2026-10-19 evidence above supersedes the original isolated two-app startup,
object recovery and Bot revocation-check gaps. Independent restored-peer
reconciliation, production promotion and live Kubernetes tests remain unqualified.
The worker base image is not a preconfigured production backup toolchain.
