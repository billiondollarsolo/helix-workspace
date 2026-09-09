# Backup and Restore

Phase 9 TASK-A04/A05 artifacts live under `infra/scripts/` and are safe by default: every script runs in dry-run mode unless `--execute` is passed.

## Backup Tiers

| Tier       | Backup workflow                                                                                                                                                                        |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Personal   | Exported-snapshot `pg_dump` plus the exact immutable version of every ready object reference. Copy the resulting archive off-host.                                                     |
| Business   | The coherent logical backup plus optional `pg_basebackup`/WAL PITR evidence, encrypted with `age`; object storage is mandatory and must have versioning enabled.                       |
| Enterprise | PITR base backup + WAL, object-store copy, **KMS-envelope-encrypted** archive (`--kms-key-id`); or CloudNativePG HA Postgres with `barmanObjectStore` continuous WAL/PITR and SSE-KMS. |
| Sovereign  | Enterprise workflow with **mandatory** KMS/HSM-backed encryption and a WORM destination.                                                                                               |

Postgres is the source of truth for Helix metadata and object references. Backup opens one
repeatable-read transaction, exports its snapshot, and uses that snapshot for both `pg_dump` and the
ready-reference query. For every unique referenced key, it selects the newest immutable S3 version
whose `LastModified` is no later than the database boundary and downloads that version by ID. A
missing version, disabled bucket versioning, duplicate/conflicting reference, size mismatch, or digest
mismatch aborts the backup. Objects created after the boundary are never claimed. Business and higher
tiers fail closed when the bucket is omitted.

Every executed backup requires an Ed25519 manifest-signing key. Generate or provision the key pair
outside the backup destination, set `HELIX_BACKUP_SIGNING_PRIVATE_KEY` for backup jobs and
`HELIX_BACKUP_SIGNING_PUBLIC_KEY` for restore jobs, and protect/rotate them like other recovery
credentials. Restore verifies the signature and SHA-256/size inventory for every file before touching
PostgreSQL or object storage. `HELIX_RESTORE_EXPECTED_APP_VERSION` can pin a compatible source build.

## Continuous WAL Archiving and PITR

`backup.sh` supports two Postgres capture modes:

- **Logical dump** (default): `pg_dump` custom format. Portable, restores into any target database. No PITR.
- **Physical PITR artifact** (`--pitr`): in addition to the coherent logical backup,
  `pg_basebackup -Ft -z -X fetch` captures the cluster and archived WAL. PITR restore is selected explicitly
  with `restore.sh --pitr`.

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
- **KMS envelope encryption** (Tier 3 option) — `--kms-key-id <alias|arn>` or `HELIX_BACKUP_KMS_KEY_ID`. `backup.sh` calls `aws kms generate-data-key`, streams the plaintext data key directly into the AES-256-GCM helper, and stores the KMS-wrapped data key next to the authenticated ciphertext as `<archive>.tar.gz.kms.datakey`. Restore pipes the unwrapped key directly from `aws kms decrypt`; plaintext keys never appear in process arguments. Set `HELIX_KMS_ENDPOINT` to target LocalStack or an on-prem KMS. Sovereign tier **requires** this path.

`age` and KMS encryption are mutually exclusive. Business+ backups fail closed if neither is configured.

## Create a Backup

Dry-run:

```sh
infra/scripts/backup.sh --tier personal
```

Execute a Tier 1 local backup:

```sh
HELIX_BACKUP_SIGNING_PRIVATE_KEY=/secure/helix-backup-signing-private.pem \
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
- `object-references.json`: every ready storage reference read from the exported DB snapshot.
- `object-versions.json`: immutable S3 version evidence captured after the DB boundary.
- `objects/inventory.json` and `objects/blobs/*`: exactly one versioned, SHA-256-verified blob per
  unique ready reference.
- `manifest.json`: tier, build, exported snapshot boundary, database LSN/applied migrations,
  capture/encryption metadata, and a
  sorted SHA-256/size inventory for every backup file (`schema_version: 3`).
- `manifest.sig`: Ed25519 signature plus trusted public-key identity for the exact manifest bytes.
- `backups/<backup-id>.tar.gz`, `.tar.gz.age`, or `.tar.gz.kms` (+ `.kms.datakey`): final archive.

## Enterprise CloudNativePG PITR

The Helm enterprise profile enables CloudNativePG and renders:

- A `Cluster` with `spec.backup.barmanObjectStore` for base backups and WAL archive.
- A daily `ScheduledBackup` using the CloudNativePG six-field cron format.
- Explicit KMS/TDE annotations and PVC template annotations under `cloudnativepg.tde`.

Before installing the enterprise overlay, set `cloudnativepg.backup.barmanObjectStore.destinationPath`, `endpointURL`, S3 credential secret names, storage encryption annotations, and Barman KMS arguments for your object store. The default values are placeholders and assume a Secret named `helix-cnpg-backup`.

For PITR drills, create a restore values file that enables `cloudnativepg.bootstrap.recovery.enabled`, sets `cloudnativepg.bootstrap.recovery.source`, supplies `cloudnativepg.recovery.externalClusters` with the source object's `barmanObjectStore`, and sets one `recoveryTarget` such as `targetTime`, `targetLSN`, or `targetName`. Restore into a new CloudNativePG cluster; CloudNativePG recovery is not an in-place operation.

## Restore

Production restore requests use the durable, dual-controlled Admin API workflow documented in
[`runbooks/backup-restore-jobs.md`](runbooks/backup-restore-jobs.md). The commands below invoke the
lower-level script directly and are intended for isolated drills and break-glass operator work.

Dry-run:

```sh
infra/scripts/restore.sh --backup backups/<backup-id>.tar.gz
```

Restore into a clean drill database:

```sh
infra/scripts/restore.sh \
  --backup backups/<backup-id>.tar.gz \
  --manifest-public-key /secure/helix-backup-signing-public.pem \
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

When the backup was taken with `--pitr`, select the physical recovery path explicitly. Restore
materializes the data directory, starts a network-isolated Postgres container, waits for WAL replay
and promotion, verifies core schema/invariants, and removes the container:

```sh
infra/scripts/restore.sh \
  --backup backups/<backup-id>.tar.gz \
  --pitr \
  --recovery-target-time "2026-05-21T03:30:00Z" \
  --pitr-data-dir ./backups/pitr-restore \
  --execute
```

This stages WAL and appends to `postgresql.auto.conf`:

```ini
restore_command = 'cp "<data-dir>/pg_wal_restore/%f" "%p"'
recovery_target_time = '2026-05-21T03:30:00Z'   # or recovery_target = 'immediate'
recovery_target_action = 'promote'
```

plus an empty `recovery.signal`. `HELIX_BACKUP_PITR_PROOF=true` makes the backup write one marker
before the recorded recovery target and one after it. The restore then proves the first row exists and
the second does not; a replay that stops early, runs through the target, or never promotes fails.
The live wrapper configures WAL archiving and exercises this path in an explicitly isolated Compose
project (required so cleanup cannot touch the default stack):

```sh
POSTGRES_PORT=39432 RUSTFS_API_PORT=39437 RUSTFS_CONSOLE_PORT=39438 \
  pnpm quality:live-restore-drill -- \
    --pitr --compose-project helix_pitr_drill --execute
```

## Object-Store Restore

Restore into a new versioned bucket and atomically switch the deployment's object route:

```sh
HELIX_BACKUP_RUSTFS_BUCKET=helix-objects \
HELIX_OBJECT_ROUTE_COMMAND=/usr/local/bin/helix-object-route \
  infra/scripts/restore.sh --backup backups/<backup-id>.tar.gz \
    --restore-objects --object-rollback-state /secure/object-restore-state.json --execute
```

The route adapter has a deliberately small compare-and-swap contract: `current` prints the active
bucket, `switch <expected-old> <new>` atomically changes it, and `rollback <expected-new> <old>`
reverses it. Restore refuses an existing target bucket, enables versioning, uploads every signed
inventory blob, downloads and hashes every result, then calls `switch`. An interruption before that
call cannot change production. The durable receipt preserves both targets; rollback is explicit:

```sh
infra/scripts/restore.sh --rollback-objects /secure/object-restore-state.json \
  --object-route-command /usr/local/bin/helix-object-route --execute
```

Drills pass `--no-object-switch` and therefore validate a new isolated bucket without changing live
routing.

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
HELIX_BACKUP_RUSTFS_BUCKET=helix-objects \
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

1. It queries completed earlier workflow runs and downloads that run's immutable
   `helix-nightly-backup` artifact; the current run can never supply the input.
2. Missing, expired, incomplete, or older-than-36-hour artifacts fail the job and surface through the
   repository's workflow-failure paging integration.
3. The signed archive restores into a clean DB and a new versioned object bucket. Signature/file
   verification catches corruption, and every referenced blob is downloaded and SHA-256 checked.
4. A separate `if: always()` job creates tonight's independent backup, including a referenced run-unique
   proof blob, and uploads it for the next run. The first-ever run intentionally fails the missing-
   previous-backup check while bootstrapping the next artifact.

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
