# High availability posture and RPO/RTO (Ops O / O-D.13 / O-K.16)

**Status:** Operator contract for Full Workspace v1 dual-target ops  
**Related:** [ADR-0006](./adr-0006-business-pilot-recovery-targets.md), [backup-restore.md](../backup-restore.md), [compose-helm-parity.md](./compose-helm-parity.md)  
**Date:** 2026-08-02

## What this is (and is not)

| Claim                                          | Supported?                                                                                      |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Engineering objective: 99.5% monthly avail.    | Yes (Business pilot)                                                                            |
| RPO ≤ 24 hours                                 | Yes — gate for pilot / release evidence                                                         |
| RTO ≤ 4 hours                                  | Yes — gate for pilot / release evidence                                                         |
| Multi-region active-active HA / contractual SLA | **No** — not claimed; requires a later ADR and staffing/replication evidence                    |
| Full Workspace apps enabled in production      | **No until PKG.** Production remains MVP fail-closed (`mail,drive,chat,assistant`) per AGENTS.md |

Kubernetes scaffolding (replicas, HPA, PDB, CloudNativePG) improves **local** resilience. It does
not by itself satisfy RPO/RTO without measured backup age and timed restore drills.

## Targets by packaging tier

| Tier       | Availability objective | RPO target | RTO target | Backup path                                                                 |
| ---------- | ---------------------- | ---------- | ---------- | --------------------------------------------------------------------------- |
| Personal   | Best effort            | 24h        | 8h         | Logical `pg_dump` + object sync; operator off-host copy                     |
| Business   | 99.5% monthly          | **≤ 24h**  | **≤ 4h**   | Encrypted PITR-capable backup + object snapshot + off-host S3 (ADR-0006)    |
| Enterprise | Higher ops expectation | ≤ 1h\*     | ≤ 2h\*     | CloudNativePG continuous WAL/PITR + KMS; \*stretch targets, not pilot SLA   |
| Sovereign  | Enterprise + air-gap   | ≤ 1h\*     | ≤ 2h\*     | Enterprise + WORM/Object Lock + FIPS/STIG path                              |

Business pilot **release gates** remain RPO ≤ 24h and RTO ≤ 4h regardless of enterprise stretch
goals. Stretch targets are operator aspirations until a new ADR + evidence promote them.

## How RPO and RTO are measured

```text
RPO hours = (drill_started_at − database_captured_at_from_manifest)
RTO hours = (drill_completed_at − drill_started_at)
```

- **RPO** is bounded by the **age of the recovery point** you can actually restore (not the
  backup schedule alone). Continuous WAL with `archive_timeout` tightens the bound between base
  backups; logical-only dumps are limited to the last successful dump.
- **RTO** starts when recovery work begins on a disposable environment and ends when critical-path
  readiness checks pass (readiness, auth, sampled integrity, queues paused until reconciled).
- Evidence must use the `helix.restore-drill-evidence.v1` schema produced by
  `infra/scripts/restore-drill-evidence.mjs` (or the live wrapper that finalizes it).

### Operator commands

```sh
# Static contract (no fault injection; not release evidence)
node infra/scripts/restore-drill-evidence.mjs --static

# Gate newest backup age against Business RPO (default 24h)
node infra/scripts/rpo-rto-check.mjs --backup-dir ./backups --rpo-hours 24

# Validate a live restore-drill evidence file against ADR-0006 targets
node infra/scripts/rpo-rto-check.mjs \
  --evidence artifacts/release-readiness/<date>/<sha>/restore-drill-evidence.json \
  --rpo-hours 24 --rto-hours 4 --require-pass

# Full restore drill (dry-run default; --execute on disposable only)
infra/scripts/restore-drill.sh --prior-day --max-age-hours 24 --strict --execute
```

Compose path: `infra/scripts/live-restore-drill-smoke.sh` and O-D.13 evidence under
`artifacts/release-readiness/<date>/<sha>/deploy/compose/O-D.13/`.

Helm/CNPG path: enterprise `ScheduledBackup` + recovery cluster; O-K.16 evidence under
`artifacts/release-readiness/<date>/<sha>/deploy/helm/O-K.16/`. Same numeric targets.

## HA building blocks (by deploy target)

### Docker Compose (O-DOCKER)

| Control                         | Where                                                              | Notes                                      |
| ------------------------------- | ------------------------------------------------------------------ | ------------------------------------------ |
| Single app replica              | `docker-compose.production.yml`                                    | HA via host/VM restart + edge, not multi-AZ |
| Migrate-before-app              | `helix-migrate` + `depends_on: service_completed_successfully`     | Parity with Helm pre-upgrade Job           |
| Private data plane              | published ports only Caddy 80/443 + SMTP                           | See O-D.2                                  |
| Backup / restore                | `backup.sh` / `restore.sh` / `restore-drill.sh`                    | Business+ fail closed without encryption   |
| ClamAV / SpamAssassin           | production overlay enabled for Mail/Drive                          | Meet/editors remain disabled               |
| Meet / Calendar / Editors       | modules `enabled: false`; `HELIX_APPS=mail,drive,chat,assistant`   | PKG flip only after evidence               |

### Kubernetes / Helm (O-K8S)

| Control                    | Chart / values                                      | Notes                                                |
| -------------------------- | --------------------------------------------------- | ---------------------------------------------------- |
| Replicas ≥ 2               | `replicaCount` / HPA `minReplicas`                  | Not multi-region                                     |
| HPA (CPU/mem/WS)           | `autoscaling`                                       | Needs metrics adapter for WS gauge                   |
| PDB                        | `podDisruptionBudget`                               | minAvailable 1 by default                            |
| NetworkPolicy              | `networkPolicy`                                     | Business+ CIDR allow-list                            |
| Migrate Job                | `migrations` pre-install/pre-upgrade hook           | Aborts release on failure                            |
| CNPG HA + barmanObjectStore| `values-enterprise.yaml`                            | Preferred K8s RPO path                               |
| Workspace packaging        | `workspace.*` in `values.yaml`                      | MVP fail-closed defaults; see PKG flip below         |

## Full Workspace readiness gates (document only — not enabled)

Production must stay fail-closed on MVP until packaging tasks **PKG.1–PKG.4** and domain evidence
(CAL/MT/ED, O-D.7–10, O-K.9–10) are green. Design matrix:
[v1-packaging-matrix.md](./v1-packaging-matrix.md).

### Required before any claim of Full Workspace production

1. Domain gates: Calendar, Meet (Jitsi), Editors pin + migrations policy, ClamAV Business.
2. Dual-target deploy: Compose O-D.V and Helm O-K.V (or owner waivers with expiry).
3. RPO/RTO live drills within targets on **both** targets (O-D.13, O-K.16) + O-X parity notes.
4. Negative boot tests: Meet without Jitsi refused; editors without pin/migrations refused.
5. Explicit packaging profile flip (below) + `AGENTS.md` boundary update in the same release train.

### PKG flip procedure (operators — do not run until evidence is bound)

This is the **documented** enablement procedure. Defaults in this repository remain MVP.

**Compose**

1. Confirm evidence pack SHAs under `artifacts/release-readiness/<date>/<sha>/` for CAL/MT/ED/O-D/O-K/V.
2. Rebuild web with `VITE_HELIX_MVP_ONLY=false` only in the promoted image build; pin digests.
3. In the production overlay (or env override file **not** committed with secrets), set:
   - `HELIX_WORKSPACE_PROFILE=full` (when server packaging profile is accepted)
   - `HELIX_APPS=mail,drive,chat,assistant,calendar,meet,docs,sheets,slides`
   - `HELIX_EDITORS_MIGRATIONS_ENABLED=true` **only** with helix-editors pin process
   - `HELIX_CONFIG_JSON` modules: enable only apps that passed gates; leave others `enabled: false`
   - Meet: real `MEET_JITSI_*` secrets + domain; never dev secrets
4. Run migrate Job/service, then app; confirm production assertions pass (illegal combos refuse boot).
5. Smoke Full Workspace matrix; attach digests to release readiness manifest.
6. Update `AGENTS.md` production MVP boundary in the same PR train as PKG.2.

**Helm**

1. Same evidence prerequisites as Compose.
2. Override values (do not change default `values.yaml` MVP fail-closed without PKG):

```yaml
workspace:
  profile: full
  apps: "mail,drive,chat,assistant,calendar,meet,docs,sheets,slides"
  editorsMigrationsEnabled: true
  modules:
    docs: { enabled: true }
    calendar: { enabled: true }
    meet: { enabled: true }
    editors: { enabled: true }
# Plus Meet/Jitsi external config, ClamAV, editors pin env as required by gates
```

3. `helm upgrade` with migrate hook; confirm Job success before traffic.
4. Record O-K evidence + O-X parity checklist row for the flip.

**Forbidden until PKG**

- Shipping `VITE_HELIX_MVP_ONLY=false` without server allowlist + migrations policy alignment.
- Enabling Meet in `HELIX_APPS` without Jitsi domain + strong JWT secret.
- Setting `HELIX_EDITORS_MIGRATIONS_ENABLED=true` without editors pin and ED.11 evidence.
- Claiming multi-region HA or contractual RPO/RTO tighter than ADR-0006 without a new ADR.

## Alert → runbook linkage (minimum)

| Signal                                      | Runbook                                                                 |
| ------------------------------------------- | ----------------------------------------------------------------------- |
| Backup missing / age > RPO                  | [backup-restore-recovery.md](../runbooks/backup-restore-recovery.md)    |
| Restore drill fail / RTO exceed             | same + [backup-restore.md](../backup-restore.md)                        |
| Object-store mismatch                       | [object-store-data-mismatch.md](../runbooks/object-store-data-mismatch.md) |
| Node disk low                               | [node-filesystem-low-space.md](../runbooks/node-filesystem-low-space.md) |
| Platform dependency outage                  | [platform-dependency-outage.md](../runbooks/platform-dependency-outage.md) |

## Definition of done for Ops O4 / O-D.13 / O-K.16 (engineering artifacts)

- [x] Documented targets + measurement (this file)
- [x] Scripted RPO/RTO gate: `infra/scripts/rpo-rto-check.mjs`
- [x] Existing backup/restore/drill toolchain retained and linked
- [ ] Live disposable drill evidence attached per environment (site-specific; not in-repo secrets)
- [ ] Dual-target parity checklist maintained: [compose-helm-parity.md](./compose-helm-parity.md)
