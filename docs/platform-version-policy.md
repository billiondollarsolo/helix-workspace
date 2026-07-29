# Platform version policy

This document is the reviewed compatibility baseline for Helix Workspace. Tags are useful for
humans, but every third-party container reference used by the checked-in stack is bound to a
multi-architecture manifest digest. Production promotion continues to replace Helix-built tags
with registry digests captured by the image-security workflow.

## Validated baseline

| Layer                   |        Version | Compatibility or security rule                                                                                                                                                                                             |
| ----------------------- | -------------: | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Node.js                 |    24.18.0 LTS | Production uses the current LTS line, not Node 26 Current. All local, CI, build, preview, and distroless runtime pins agree.                                                                                               |
| pnpm                    |        11.18.0 | Corepack and `packageManager` select the exact version. Frozen installs, engine strictness, one-day release aging, checksum validation, explicit build allowlists, and exotic transitive dependency blocking are required. |
| TypeScript              |          5.9.3 | Latest version supported by typescript-eslint 8.x and the Ladle toolchain. TypeScript 7 is intentionally blocked until both support it.                                                                                    |
| Docker Engine / Compose | 29.6.x / 5.3.x | Current stable operator baseline. CI actions remain commit-SHA pinned and production images remain digest-pinned.                                                                                                          |
| Dockerfile frontend     |         1.25.0 | Every production Dockerfile pins the frontend by digest.                                                                                                                                                                   |
| Go                      |         1.26.5 | Used only in reproducible source-build stages for Caddy, NATS, Cerbos, and gosu.                                                                                                                                           |
| Alpine                  |         3.24.0 | Minimal runtime/build base, always selected by exact tag and digest.                                                                                                                                                       |
| Helm                    |          4.2.3 | Exact CI version. Helm 3 is no longer part of the supported release toolchain.                                                                                                                                             |
| Kubernetes              |      1.34–1.36 | Chart `kubeVersion` rejects older and future-unvalidated clusters. The current validation target is 1.36.3.                                                                                                                |
| kubeconform             |          0.8.0 | CI downloads the exact release with a pinned SHA-256 and fails if validation is unavailable.                                                                                                                               |

## Stateful and security-sensitive services

| Component             |       Version | Upgrade posture                                                                                                                                                                                                                                    |
| --------------------- | ------------: | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PostgreSQL / pgvector |  18.4 / 0.8.5 | Major PostgreSQL upgrades require a new volume plus dump/restore or a rehearsed `pg_upgrade`. Never swap the image over a PostgreSQL 17 directory.                                                                                                 |
| Redis                 |         8.8.1 | AOF is enabled. Back up and validate persistence before promotion.                                                                                                                                                                                 |
| NATS Server           |        2.14.3 | Rebuilt from a checksum-verified commit with the pinned Go toolchain.                                                                                                                                                                              |
| Meilisearch           |        1.51.0 | Use dump/import or rebuild indexes from PostgreSQL; do not reuse an incompatible data directory.                                                                                                                                                   |
| Cerbos                |        0.54.0 | Rebuilt from a checksum-verified commit; the policy compiler image is also digest-pinned.                                                                                                                                                          |
| RustFS                | 1.0.0-beta.11 | Upstream still has no stable release. This is a recorded exception, pinned by digest, and must not be presented as stable. Re-evaluate each release or replace it with an approved stable S3-compatible provider before a higher-assurance launch. |
| SpamAssassin          |         4.0.2 | The immutable source-image digest and Apache rules archive checksum are both verified.                                                                                                                                                             |
| ClamAV                |         1.5.3 | Current stable image. The official image is amd64-only, so deployment architecture remains explicit.                                                                                                                                               |
| Mailpit               |        1.30.6 | Development/test SMTP only; pinned by digest.                                                                                                                                                                                                      |

## Optional and operational containers

The checked-in optional profiles pin Caddy 2.11.4, Jitsi `stable-11031`, OpenTelemetry Collector
Contrib 0.157.0, Prometheus 3.13.1, Alertmanager 0.33.1, Tempo 3.0.2, Loki 3.7.4, Grafana 13.1.1,
k6 2.1.0, and ZAP 2.17.0 by immutable digest. These components remain outside the storage-only MVP
unless their profile or evidence command is explicitly enabled.

## JavaScript compatibility exceptions

- `@helix/contracts` and the `zod3` alias use Zod 3.25.76. Tool-schema composition currently
  combines shared contract schemas with local Zod 3 schemas, so moving this boundary to Zod 4
  requires a coordinated schema-adapter migration. Application-only Zod consumers may use 4.4.3.
- React 18.3.1 remains in `@helix/editors-ui` because Ladle's current inspector dependency does not
  support React 19. The shipped Workspace web app uses React 19.2.8.
- TypeScript stays on 5.9.3 as described above. `@types/node` stays on the Node 24 line even though
  Node 26 types exist.
- RustFS is the only prerelease service exception and is tracked separately above.

## Transitive dependency controls

- `@esbuild-kit/core-utils` is still pulled by the current Drizzle Kit chain used by Better Auth.
  pnpm overrides only that edge to esbuild 0.28.1, eliminating the upstream development-server
  advisory while the deprecated loader package remains unreachable as an application server.
- ExcelJS 4.4.0 is the current release and still declares several deprecated archive dependencies
  plus uuid 8. pnpm overrides its uuid edge to 14.0.1; workbook import/export tests cover the API
  compatibility, and the production audit reports no known vulnerability.
- The remaining deprecated-package warnings originate in those current upstream chains and the
  OpenTelemetry GCP resource detector. They are not security exceptions: the lockfile must still
  pass an advisory audit with zero known vulnerabilities, and each direct parent is re-evaluated
  during the regular update procedure.

## Update and verification procedure

1. Query upstream releases and security advisories from authoritative project sources.
2. Resolve every container tag to its manifest-list digest and record intentional architecture
   restrictions.
3. Update both repositories on the same branch: runtime and package-manager pins, lockfiles,
   actions, Dockerfiles, Compose, Helm, tests, and this matrix.
4. Run frozen installs, peer checks, lint, typecheck, unit/component tests, builds, contracts,
   Helm 4 rendering, kubeconform, Compose rendering, production-readiness contracts, dependency
   audit, SBOM generation, and High/Critical image scans.
5. For a stateful major, rehearse backup, restore, data validation, and rollback before promotion.
6. Merge only after both repositories' exact-head CI is green. Re-run scheduled image and
   dependency scans after merge and retain their evidence with the release.
