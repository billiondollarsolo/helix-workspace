# Family backup management qualification — 2026-10-17

Implemented in both repositories; optional recovery enrollment defaults off.
The [operator runbook](app-family-backups.md) covers activation and recovery.

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
- The existing live family identity/provider regression passed separately after
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
pnpm --filter @helix/app exec vitest run src/platform/backup/family-worker.test.ts src/platform/backup/family-management.integration.test.ts
pnpm --filter @helix/web exec vitest run src/features/admin/sections/family-backups.test.tsx src/features/admin/admin-request-budget.test.tsx
pnpm --filter @helix/web exec playwright test tests/e2e/admin-family-backups.spec.ts
node --test infra/scripts/family-backup-deployments.test.mjs
docker build --target backup-worker -f infra/docker/Dockerfile -t helix-family-backup-worker:dev .
node infra/scripts/family-backup-worker-smoke.mjs helix-family-backup-worker:dev
```

The database integration needs the existing migrated isolated test database and
RLS role environment. Use both adjacent repositories for the cross-app deployment
and real Bot recovery checks; the latter command is in Bot's backup runbook.

Not activated on the hosted installation in this change. An operator must choose
actual backup custody/storage, mount required snapshots, provide qualified commands,
perform the scheduler handoff, route HTTPS and enroll separate capabilities.
A deployed full two-app restore including real Workspace objects and revocation
reconciliation, production promotion and live Kubernetes tests remain unqualified.
The worker base image is not a preconfigured production backup toolchain.
