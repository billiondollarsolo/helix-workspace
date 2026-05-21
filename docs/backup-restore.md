# Backup and Restore

Phase 9 TASK-A04/A05 artifacts live under `infra/scripts/` and are safe by default: every script runs in dry-run mode unless `--execute` is passed.

## Backup Tiers

| Tier       | Backup workflow                                                                                                                                                                          |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Personal   | Local `pg_dump` logical archive plus a real `aws s3 sync` object-store copy. Copy the resulting archive off-host with scp/restic.                                                         |
| Business   | Physical `pg_basebackup` + archived WAL (PITR-capable) and an object-store copy, encrypted with `age` before upload to S3-compatible storage with versioning.                             |
| Enterprise | PITR base backup + WAL, object-store copy, **KMS-envelope-encrypted** archive (`--kms-key-id`); or CloudNativePG HA Postgres with `barmanObjectStore` continuous WAL/PITR and SSE-KMS.    |
| Sovereign  | Enterprise workflow with **mandatory** KMS/HSM-backed encryption and a WORM destination.                                                                                                 |

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
- `objects/<bucket>/`: byte-for-byte `aws s3 sync` of the object bucket (`--object-backup`), plus `<bucket>.inventory.json`.
- `manifest.json`: tier, capture mode, encryption method, and artifact metadata (`schema_version: 2`).
- `backups/<backup-id>.tar.gz`, `.tar.gz.age`, or `.tar.gz.kms` (+ `.kms.datakey`): final archive.

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

Use a prior backup:

```sh
infra/scripts/restore-drill.sh --backup backups/<backup-id>.tar.gz --execute
```

### Nightly CI restore drill

`.github/workflows/restore-drill.yml` runs every night at 08:17 UTC. It does
**not** drill a freshly created backup — it restores the **prior day's** backup
artifact, satisfying PRD §2.3/§16.5:

1. It downloads the most recent `helix-nightly-backup` artifact published by the
   previous night's run.
2. The artifact's mtime is set to "yesterday" and `restore-drill.sh --prior-day`
   selects the newest backup whose timestamp falls in the prior UTC calendar day.
3. `--max-age-hours 36` fails the drill if the selected backup is stale (a
   missed nightly backup).
4. After the drill, the workflow creates tonight's backup and uploads it as the
   next `helix-nightly-backup` artifact, closing the loop.

On the very first run (no prior artifact) the workflow synthesizes a backup and
backdates it so the `--prior-day` path is still exercised.

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
