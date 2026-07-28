# Backup and Restore

Phase 9 TASK-A04/A05 artifacts live under `infra/scripts/` and are safe by default: every script runs in dry-run mode unless `--execute` is passed.

## O4 Production Recovery Contract

New backups use `helix.backup-manifest.v3`. The embedded manifest binds one
database recovery point and one object-store recovery point to a single
recovery-set digest. It inventories and SHA-256 hashes every database, WAL,
consistency, object, and object-version artifact. The final ciphertext has a
separate `.sha256` sidecar and a content-identical `.manifest.json` sidecar.
Restore verifies the ciphertext checksum before decryption, then verifies the
embedded manifest, all artifact hashes, and equality with the external manifest
before changing a target.

Business, enterprise, and sovereign executions fail closed unless all of these
are true:

- the archive is encrypted (`age` or KMS; sovereign requires KMS);
- the database and full object snapshot are both present;
- source object-store versioning is enabled and replication is configured;
- an `s3://` off-host destination has enabled versioning, replication, and an
  enabled lifecycle expiration at least as long as `--retention-days`;
- a non-secret `--key-custody-ref` identifies the independent KMS/HSM/vault or
  keychain recovery procedure.

Private identities and plaintext data keys must never be put in the archive,
manifest, CI artifacts, or source control. KMS backups contain only the
KMS-wrapped data-key sidecar. The off-host copy happens only after all local
checks pass and includes ciphertext plus checksum/manifest sidecars (and the
wrapped KMS key where applicable).

Minimum enforced retention is 30 days for Business, 90 days for Enterprise, and
365 days for Sovereign. Sovereign also requires S3 Object Lock on the off-host
bucket. Longer legal-hold or sector-specific periods should be configured by
the operator.

## Backup Tiers

| Tier       | Backup workflow                                                                                                                                                                        |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Personal   | Local `pg_dump` logical archive plus a real `aws s3 sync` object-store copy. Copy the resulting archive off-host with scp/restic.                                                      |
| Business   | Physical `pg_basebackup` + archived WAL (PITR-capable) and an object-store copy, encrypted with `age` before upload to S3-compatible storage with versioning.                          |
| Enterprise | PITR base backup + WAL, object-store copy, **KMS-envelope-encrypted** archive (`--kms-key-id`); or CloudNativePG HA Postgres with `barmanObjectStore` continuous WAL/PITR and SSE-KMS. |
| Sovereign  | Enterprise workflow with **mandatory** KMS/HSM-backed encryption and a WORM destination.                                                                                               |

Postgres is the source of truth for Helix metadata, auth, documents, plugin state, and audit state. The `backup.sh --object-backup` flag now performs a real byte-for-byte `aws s3 sync` of the RustFS/S3 object bucket into the archive (it is no longer metadata-only); the restore path re-syncs it back. Bucket versioning and replication remain recommended for defence in depth.

## Continuous WAL Archiving and PITR

`backup.sh` supports two Postgres capture modes:

- **Logical dump** (default): `pg_dump` custom format. Portable, restores into any target database. No PITR.
- **Physical base backup** (`--pitr`): `pg_basebackup -Ft -z -Xs` streams a consistent cluster snapshot. Combined with archived WAL it allows point-in-time recovery to any moment after the backup start LSN.

Continuous WAL archiving is a one-time operator setup on the Postgres server (Compose or self-managed). Set in `postgresql.conf`:

```ini
wal_level = replica
archive_mode = on
archive_command = 'test ! -f /wal_archive/%f && cp %p /wal_archive/%f'
archive_timeout = 60        # bound RPO to 60s of un-archived WAL
```

Mount a durable volume at `/wal_archive` (override with `HELIX_WAL_ARCHIVE_DIR`). `backup.sh --include-wal` issues `pg_switch_wal()` and copies every archived segment into the backup archive under `wal/`. Tier 3 (15 min) and Tier 4 (5 min) RPO targets are met by setting `archive_timeout` at or below the target and running base backups frequently.

For Kubernetes, the enterprise Helm overlay delegates WAL archiving to CloudNativePG's `barmanObjectStore` instead of the script — see the section below.

## Backup Encryption

Three encryption options, selected per tier:

- **None** — Tier 1 / personal only.
- **`age`** — `AGE_RECIPIENTS` / `--age-recipient`. Tier 2 default. Produces `<archive>.tar.gz.age`.
- **KMS envelope encryption** (Tier 3 option) — `--kms-key-id <alias|arn>` or `HELIX_BACKUP_KMS_KEY_ID`. `backup.sh` calls `aws kms generate-data-key`, encrypts the archive with the plaintext data key via `openssl enc -aes-256-cbc -pbkdf2`, and stores the KMS-wrapped data key next to the ciphertext as `<archive>.tar.gz.kms.datakey`. Restore calls `aws kms decrypt` to unwrap the key. Set `HELIX_KMS_ENDPOINT` to target LocalStack or an on-prem KMS. Sovereign tier **requires** this path.

`age` and KMS encryption are mutually exclusive. Business+ backups fail closed if neither is configured.

## Create a Backup

Dry-run:

```sh
infra/scripts/backup.sh --tier personal
```

Execute a Tier 1 local backup:

```sh
infra/scripts/backup.sh --tier personal --execute
```

Execute an encrypted Tier 2 PITR backup with an object-store copy:

```sh
AGE_RECIPIENTS="age1..." \
HELIX_BACKUP_RUSTFS_BUCKET=helix-objects \
  infra/scripts/backup.sh --tier business --pitr --object-backup --execute
```

Execute a Tier 3 KMS-encrypted PITR backup:

```sh
HELIX_BACKUP_RUSTFS_BUCKET=helix-objects \
  infra/scripts/backup.sh --tier enterprise --pitr --object-backup \
    --kms-key-id alias/helix-backup --execute
```

Artifacts (staged under `backups/<backup-id>/`, then archived):

- `postgres.dump`: custom-format `pg_dump` (logical mode).
- `postgres-basebackup/`: `pg_basebackup` cluster snapshot (`--pitr` mode).
- `wal/`: archived WAL segments for PITR replay (`--include-wal`/`--pitr`).
- `objects/<bucket>/`: byte-for-byte `aws s3 sync` of the object bucket.
- `objects/<bucket>.versions.json`, `.versioning.json`, and `.replication.json`:
  object version identifiers and recovery-policy observations.
- `consistency/database.tsv`: deterministic counts and samples for objects,
  Drive versions, outbound queues, outbox, and audit-chain continuity.
- `manifest.json`: checksummed `helix.backup-manifest.v3` recovery set.
- `backups/<backup-id>.tar.gz`, `.tar.gz.age`, or `.tar.gz.kms` (+ wrapped
  `.kms.datakey`), `.sha256`, and `.manifest.json` sidecars.

Production example:

```sh
AGE_RECIPIENTS="age1..." \
HELIX_BACKUP_RUSTFS_BUCKET=helix-objects \
HELIX_BACKUP_OFFHOST_URI=s3://company-dr/helix \
HELIX_BACKUP_RETENTION_DAYS=35 \
HELIX_BACKUP_KEY_CUSTODY_REF=vault://production/helix-backup-age \
  infra/scripts/backup.sh \
    --tier business --pitr --object-backup --execute
```

## Enterprise CloudNativePG PITR

The Helm enterprise profile enables CloudNativePG and renders:

- A `Cluster` with `spec.backup.barmanObjectStore` for base backups and WAL archive.
- A daily `ScheduledBackup` using the CloudNativePG six-field cron format.
- Explicit KMS/TDE annotations and PVC template annotations under `cloudnativepg.tde`.

Before installing the enterprise overlay, set `cloudnativepg.backup.barmanObjectStore.destinationPath`, `endpointURL`, S3 credential secret names, storage encryption annotations, and Barman KMS arguments for your object store. The default values are placeholders and assume a Secret named `helix-cnpg-backup`.

For PITR drills, create a restore values file that enables `cloudnativepg.bootstrap.recovery.enabled`, sets `cloudnativepg.bootstrap.recovery.source`, supplies `cloudnativepg.recovery.externalClusters` with the source object's `barmanObjectStore`, and sets one `recoveryTarget` such as `targetTime`, `targetLSN`, or `targetName`. Restore into a new CloudNativePG cluster; CloudNativePG recovery is not an in-place operation.

## Restore

Dry-run:

```sh
infra/scripts/restore.sh --backup backups/<backup-id>.tar.gz
```

Restore into a clean drill database:

```sh
infra/scripts/restore.sh \
  --backup backups/<backup-id>.tar.gz \
  --target-db helix_restore_drill \
  --allow-drop-target \
  --verify \
  --execute
```

Encrypted restore (`age`):

```sh
AGE_IDENTITY_FILE=/secure/helix-backup.key \
  infra/scripts/restore.sh --backup backups/<backup-id>.tar.gz.age --verify --execute
```

KMS-encrypted restore:

```sh
infra/scripts/restore.sh \
  --backup backups/<backup-id>.tar.gz.kms \
  --kms-datakey backups/<backup-id>.tar.gz.kms.datakey \
  --verify --execute
```

The data key file defaults to `<archive>.datakey` next to the archive, so
`--kms-datakey` is optional when they sit together.

## Point-in-Time Recovery (script path)

When the backup was taken with `--pitr`, `restore.sh` auto-detects the physical
base backup and switches to the PITR path. It materializes a recovered Postgres
data directory and configures archive recovery:

```sh
infra/scripts/restore.sh \
  --backup backups/<backup-id>.tar.gz \
  --pitr \
  --recovery-target-time "2026-05-21T03:30:00Z" \
  --pitr-data-dir ./backups/pitr-restore \
  --execute
```

This copies the base backup into `--pitr-data-dir`, stages the archived WAL into
`pg_wal_restore/`, and appends to `postgresql.auto.conf`:

```ini
restore_command = 'cp "<data-dir>/pg_wal_restore/%f" "%p"'
recovery_target_time = '2026-05-21T03:30:00Z'   # or recovery_target = 'immediate'
recovery_target_action = 'promote'
```

plus an empty `recovery.signal`. Start a Postgres 17 server on that directory
(for example `docker run -v <data-dir>:/var/lib/postgresql/data
helix/postgres-pgvector:17-alpine`); it replays WAL to the target time and
promotes. Then `pg_dump` the recovered cluster and load it normally, or repoint
`DATABASE_URL` at the recovered instance. CloudNativePG recovery (below) is the
preferred PITR path on Kubernetes.

## Object-Store Restore

Re-sync the RustFS/S3 object bucket from the backup:

```sh
HELIX_BACKUP_RUSTFS_BUCKET=helix-objects \
  infra/scripts/restore.sh --backup backups/<backup-id>.tar.gz --restore-objects --execute
```

`--restore-objects` runs `aws s3 sync objects/<bucket> s3://<bucket> --delete`
against the endpoint from `RUSTFS_ENDPOINT`, creating the bucket if needed.

The restore script never targets the live `helix` database by default. Dropping an existing target database requires `--allow-drop-target`.
If an emergency restore must target the live database name from `POSTGRES_DB`, the command must also include `--allow-live-target`; routine restore drills should always use a separate target such as `helix_restore_drill`.

## Restore Drill

Offline validation for CI or a workstation without a running Docker daemon:

```sh
pnpm infra:restore:validate
```

Dry-run:

```sh
infra/scripts/restore-drill.sh --create-backup
```

Execute against local Compose Postgres:

```sh
docker compose up -d postgres
infra/scripts/restore-drill.sh --create-backup --execute
```

Live smoke wrapper with migrations, deterministic OAuth seed, isolated restore
database, and post-restore SQL checks:

```sh
pnpm quality:live-restore-drill -- --execute
```

For safer workstation evidence, isolate the Compose project and move Postgres to
a separate high port:

```sh
POSTGRES_DB=helix_restore_source \
POSTGRES_PORT=39432 \
DATABASE_URL=postgres://helix:helix_dev_password@127.0.0.1:39432/helix_restore_source \
  pnpm quality:live-restore-drill -- \
    --compose-project helix_restore_smoke \
    --target-db helix_restore_drill_smoke \
    --execute
```

The wrapper remains dry-run by default, refuses to target the live
`POSTGRES_DB`, and restores through `restore-drill.sh` into the drill database
with `--verify`.

### Strict encrypted drill and release evidence

Release evidence must come from an executed, encrypted, pre-existing recovery
artifact in disposable database and object-store targets. It is not produced by
the default smoke command. A strict drill verifies:

- archive, external/embedded manifest, recovery-set, and artifact hashes;
- exact restored counts/samples for objects, Drive versions, outbound mail,
  transactional outbox, and audit rows;
- zero broken `activity.prev_hash` links;
- byte-for-byte SHA-256 matches for up to 25 sampled object files;
- a real search rebuild using a database URL whose database name is the
  disposable restore target;
- measured RPO from the manifest database recovery point and measured RTO from
  drill start to completed verification.

```sh
AGE_IDENTITY_FILE=/secure/helix-backup.agekey \
RUSTFS_ENDPOINT=https://restore-object-store.example \
RUSTFS_ACCESS_KEY=<ephemeral-restore-access> \
RUSTFS_SECRET_KEY=<ephemeral-restore-secret> \
MEILI_HOST=https://restore-search.example \
MEILI_MASTER_KEY=<ephemeral-restore-key> \
  infra/scripts/restore-drill.sh \
    --backup backups/20260727T200000Z.tar.gz.age \
    --target-db helix_restore_20260728 \
    --target-object-bucket helix-objects-restore-20260728 \
    --age-identity /secure/helix-backup.agekey \
    --strict \
    --reindex \
    --target-database-url postgres://helix:<password>@restore-db/helix_restore_20260728 \
    --evidence-output artifacts/restore-drill-evidence.json \
    --execute
```

`restore-drill-evidence.mjs` writes `status: passed` only when every strict
scenario passed and measured RPO is at most 24 hours and RTO is at most 4
hours. `--static` writes `static_validated` with every live scenario
`not_run`; it can never satisfy the release gate. Import a genuine report with:

```sh
node infra/scripts/release-readiness-manifest.mjs \
  ... \
  --restore-drill-evidence restore-drill-evidence.json
```

Use a prior backup:

```sh
infra/scripts/restore-drill.sh --backup backups/<backup-id>.tar.gz --execute
```

### Nightly CI restore drill

`.github/workflows/restore-drill.yml` runs every night at 08:17 UTC. The
repository workflow validates the shell/manifest/evidence contracts and runs a
disposable database smoke. It uploads a truthful **static** evidence report and
does not claim a production RPO/RTO pass.

The deployment operator must schedule the strict command above against the
off-host backup repository and disposable database/object/search endpoints.
Store the resulting live JSON with release evidence. A missing service,
identity, object sample, search rebuild, stale recovery point, slow recovery, or
failed consistency check produces failed/not-run evidence and blocks
`--restore-drill-evidence`.

Run the prior-day selection manually:

```sh
infra/scripts/restore-drill.sh --backup-dir backups --prior-day --max-age-hours 36 --execute
```

Optional app checks:

```sh
HELIX_VERIFY_APP_URL=http://localhost:28431 infra/scripts/restore-drill.sh --backup backups/<backup-id>.tar.gz --execute
```

Optional derived-search rebuild:

```sh
HELIX_RESTORE_DRILL_REINDEX=true \
HELIX_BASE_URL=http://localhost:28431 \
HELIX_ACCESS_TOKEN=<admin-token> \
infra/scripts/restore-drill.sh --backup backups/<backup-id>.tar.gz --execute
```

Local derived-search rebuild without a running app server:

```sh
DATABASE_URL=postgres://helix:...@127.0.0.1:28432/helix \
MEILI_HOST=http://127.0.0.1:28436 \
MEILI_MASTER_KEY=<key> \
pnpm --filter @helix/app db:reindex:search -- --all
```

Critical path verification commands:

```sh
docker compose exec -T postgres psql -U helix -d helix_restore_drill -v ON_ERROR_STOP=1 -c "select count(*) from information_schema.tables where table_schema='public';"
docker compose exec -T postgres psql -U helix -d helix_restore_drill -v ON_ERROR_STOP=1 -c "select 'public.actors'::regclass, 'public.activity'::regclass, 'public.installed_plugins'::regclass;"
docker compose exec -T postgres psql -U helix -d helix_restore_drill -v ON_ERROR_STOP=1 -c "select count(*) as activity_rows, count(this_hash) as hashed_activity_rows from public.activity;"
curl -fsS http://localhost:28431/readyz
curl -fsS http://localhost:28431/openapi.json
```
