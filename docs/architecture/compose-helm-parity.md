# Compose ↔ Helm parity checklist (O-X.1)

**Task:** O-X.1 (cross-deploy)  
**Date:** 2026-08-02  
**Status:** Living checklist — production packaging remains **MVP fail-closed** until PKG  
**Related:** [ha-rpo-rto.md](./ha-rpo-rto.md), [v1-packaging-matrix.md](./v1-packaging-matrix.md), `docker-compose.production.yml`, `infra/helm/helix/`

## Purpose

Full Workspace v1 supports **two** production deploy targets. R3 dual-evidence requires both tracks
(or an owner waiver with expiry). This matrix records intentional parity and known gaps so Compose
and Helm do not silently diverge.

Legend: **P** = parity present · **D** = documented intentional difference · **G** = gap (must close or waive before dual-target GA) · **N/A** = not applicable to target

## Packaging and fail-closed scope

| Concern                                  | Compose production                           | Helm (`values.yaml` + overlays)                  | Status |
| ---------------------------------------- | -------------------------------------------- | ------------------------------------------------ | ------ |
| `HELIX_APPS` MVP allowlist               | `mail,drive,chat,assistant`                  | `workspace.apps` default same                    | P      |
| Disabled modules in `HELIX_CONFIG_JSON`  | docs/calendar/meet/editors `enabled: false`  | `workspace.modules.*` rendered into config JSON  | P      |
| `HELIX_EDITORS_MIGRATIONS_ENABLED=false` | migrate + app services                       | `workspace.editorsMigrationsEnabled: false`      | P      |
| Meet production credentials stripped     | `MEET_JITSI_*=false` / secrets reset         | Meet not chart-installed; module disabled        | D\*    |
| Full Workspace PKG flip procedure        | Documented in compose header + ha-rpo-rto.md | Documented in values comments + ha-rpo-rto.md    | P      |
| Web `VITE_HELIX_MVP_ONLY=true`           | Built into promoted web image                | Same promoted image (chart does not rebuild SPA) | P      |

\*Helm has **no in-chart Jitsi** (O-K.10 gap). Compose can host Jitsi under a non-production profile
but production overlay forces Meet off. Enabling Meet on either target requires external/cluster
Jitsi + PKG gates — do not enable in defaults.

## Lifecycle and data plane

| Concern                             | Compose                                              | Helm                                                             | Status |
| ----------------------------------- | ---------------------------------------------------- | ---------------------------------------------------------------- | ------ |
| Schema migrate before new code      | `helix-migrate` one-shot; app `depends_on` completed | pre-install/pre-upgrade Job `dist/db/migrate.js`                 | P      |
| Advisory lock on migrate            | migrate runner                                       | same image/runner                                                | P      |
| Immutable image digests             | `${HELIX_*_IMAGE:?…}` digest-required env            | `image.digest` / STIG requireDigest on sovereign                 | P      |
| Non-root + read-only rootfs         | `user: 10001`, `read_only: true`                     | `runAsNonRoot`, `readOnlyRootFilesystem: true`                   | P      |
| Public surface                      | Caddy 80/443 + SMTP only                             | Ingress optional; no data-plane NodePorts by default             | D      |
| Postgres                            | In-compose TLS Postgres                              | External URL or CloudNativePG (enterprise)                       | D      |
| Redis / NATS / Meilisearch / object | In-compose private network                           | External services via `external.*`                               | D      |
| ClamAV / SpamAssassin               | Production overlay enables Mail+Drive scanners       | Not bundled in app chart; operator supplies endpoint (O-K.9 gap) | G      |
| Observability                       | Optional compose profile                             | PrometheusRule opt-in; scrape annotations on Deployment          | D      |

## Resilience / RPO-RTO

| Concern                    | Compose                                         | Helm                                                           | Status |
| -------------------------- | ----------------------------------------------- | -------------------------------------------------------------- | ------ |
| Multi-replica app          | Single container (host HA)                      | `replicaCount` ≥ 2 + HPA + PDB                                 | D      |
| Graceful shutdown          | `stop_grace_period: 60s`                        | preStop sleep + `terminationGracePeriodSeconds`                | P      |
| Backup toolchain           | `backup.sh` / `restore.sh` / `restore-drill.sh` | Same scripts against external DB **or** CNPG barmanObjectStore | P      |
| RPO ≤ 24h / RTO ≤ 4h gates | `rpo-rto-check.mjs` + O-D.13 drill              | Same check + O-K.16 / CNPG recovery drill                      | P      |
| Continuous WAL / PITR      | Operator `archive_command` + `--pitr`           | CNPG `barmanObjectStore` on enterprise overlay                 | D      |
| Off-host encrypted backup  | Business+ fail-closed in `backup.sh`            | Same contract; CNPG SSE-KMS path for enterprise                | P      |

## Security controls

| Concern           | Compose                           | Helm                                           | Status |
| ----------------- | --------------------------------- | ---------------------------------------------- | ------ |
| Security tier     | `HELIX_SECURITY_TIER=business`    | `security.tier` + overlay labels               | P      |
| Network isolation | docker networks edge/data-plane   | NetworkPolicy (business CIDR / sovereign deny) | D      |
| Secrets via files | Docker secrets `*_FILE`           | K8s Secrets / Vault CSI / agent inject         | D      |
| FIPS/STIG/air-gap | Tier4 docs + STIG Dockerfile path | `values-sovereign.yaml`                        | P      |

## Structural validation (CI-friendly)

| Check                                 | Command / artifact                                                    |
| ------------------------------------- | --------------------------------------------------------------------- |
| Compose production contract           | `pnpm exec vitest run infra/scripts/production-compose.test.mjs`      |
| Helm lint/template + PRD hardening    | `pnpm infra:helm:validate` (`infra/scripts/validate-helm.sh`)         |
| Helm MVP packaging assertions         | same script: `HELIX_APPS`, modules disabled, editors migrations false |
| RPO/RTO contract unit tests           | `pnpm exec vitest run infra/scripts/rpo-rto-check.test.mjs`           |
| Backup age / evidence gate (operator) | `node infra/scripts/rpo-rto-check.mjs …`                              |

## Known gaps blocking dual-target Full Workspace GA

1. **O-K.9 / O-K.10** — ClamAV and Meet/Jitsi not first-class Helm chart resources; must be external or added with fail-closed values before Meet/Drive Business claims on K8s.
2. **O-D.9 / O-D.10** — Compose production keeps Meet/editors disabled; GA profiles need evidence, not default enable.
3. **Live drills** — O-D.13 and O-K.16 evidence packs are environment-specific; repository provides scripts + gates only.
4. **O-X.2–O-X.6** — SBOM/provenance and dual R3 binding remain process gates beyond this matrix.

## Operator sign-off template

```text
Date:
Compose SHA / image digests:
Helm chart version / image digests:
RPO observed (compose):     h   (target ≤ 24)
RTO observed (compose):     h   (target ≤ 4)
RPO observed (helm):        h
RTO observed (helm):        h
Gaps waived (id, owner, expiry):
PKG profile: mvp | full
Signer:
```

## Change control

When changing production compose or the Helm chart:

1. Update this matrix in the same PR if parity status changes.
2. Keep MVP defaults fail-closed unless the PR is an evidenced PKG flip.
3. Re-run compose + helm structural tests listed above.
