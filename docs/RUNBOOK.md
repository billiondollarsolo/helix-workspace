# Helix Runbook

## Workspace incident runbooks

The [Workspace observability contract](observability.md) defines the dashboard,
alerts, safe labels, and required telemetry. Start with the alert's
`resource_id` and `trace_query`; never paste message content, filenames,
prompts, tokens, or personal data into an incident channel or ticket.

- [Platform or dependency outage](runbooks/platform-dependency-outage.md)
- [Signup activation SLO breach](specs/05-operations/runbooks/signup-activation-slo-breach.md)
- [Outbox or worker backlog](runbooks/outbox-worker-backlog.md)
- [Mail provider outage or backlog](runbooks/mail-provider-outage.md)
- [Mail bounce, complaint, or sender compromise](runbooks/mail-bounce-complaint-spike.md)
- [Inbound mail spam or malware surge](runbooks/mail-inbound-malware-surge.md)
- [Drive scanner outage or quarantine backlog](runbooks/drive-scanner-outage.md)
- [Object-store outage or data mismatch](runbooks/object-store-data-mismatch.md)
- [Chat, NATS, or Redis outage](runbooks/chat-nats-redis-outage.md)
- [Agent credential or prompt-injection incident](runbooks/agent-security-incident.md)
- [Audit integrity or shipping failure](runbooks/audit-integrity-shipping-failure.md)
- [Secret, certificate, or key rotation](runbooks/secret-certificate-rotation.md)
- [Backup restore or total deployment recovery](runbooks/backup-restore-recovery.md)

## Backup

1. Confirm Compose can see the target stack:

   ```sh
   docker compose ps
   ```

2. Run a dry-run backup:

   ```sh
   infra/scripts/backup.sh --tier personal
   ```

3. Execute the backup. Choose the capture mode and encryption per tier:

   ```sh
   # Tier 1: logical dump + object-store copy
   HELIX_BACKUP_RUSTFS_BUCKET=helix-objects \
     infra/scripts/backup.sh --tier personal --object-backup --execute

   # Tier 2: PITR base backup + WAL, age-encrypted
   AGE_RECIPIENTS="age1..." HELIX_BACKUP_RUSTFS_BUCKET=helix-objects \
     infra/scripts/backup.sh --tier business --pitr --object-backup --execute

   # Tier 3: PITR + WAL + objects, KMS-envelope-encrypted
   HELIX_BACKUP_RUSTFS_BUCKET=helix-objects \
     infra/scripts/backup.sh --tier enterprise --pitr --object-backup \
       --kms-key-id alias/helix-backup --execute
   ```

   `--pitr` requires continuous WAL archiving on the Postgres server
   (`archive_mode = on`, `archive_command` -> `/wal_archive`, `archive_timeout`
   at or below the tier RPO). See `docs/backup-restore.md` for the one-time
   `postgresql.conf` setup.

4. Move the resulting `.tar.gz`, `.tar.gz.age`, or `.tar.gz.kms` (+ `.kms.datakey`)
   archive off-host. The object bucket is now copied byte-for-byte into the
   archive by `--object-backup`; bucket versioning/replication remain
   recommended for defence in depth.

Operator evidence to capture:

```sh
pnpm infra:restore:validate
infra/scripts/backup.sh --tier personal --object-backup
infra/scripts/backup.sh --tier personal --object-backup --execute
AGE_RECIPIENTS="age1..." infra/scripts/backup.sh --tier business --pitr --object-backup --execute
ls -lh backups/*.tar.gz backups/*.tar.gz.age backups/*.tar.gz.kms 2>/dev/null
```

For enterprise or sovereign tiers, also attach CloudNativePG base backup, WAL/PITR,
object-store versioning or WORM retention, KMS key references, and restore-drill
proof from the deployed backup backend.

## Restore

1. Provision a target environment at the same or higher tier.
2. Start Postgres only:

   ```sh
   docker compose up -d postgres
   ```

3. Restore into a drill database first:

   ```sh
   infra/scripts/restore.sh \
     --backup backups/<backup-id>.tar.gz \
     --target-db helix_restore_drill \
     --allow-drop-target \
     --verify \
     --execute
   ```

   The restore script refuses to target the live database name from `POSTGRES_DB` unless `--allow-live-target` is also passed for an explicit emergency restore.

4. For encrypted backups:

   ```sh
   AGE_IDENTITY_FILE=/secure/helix-backup.key \
     infra/scripts/restore.sh --backup backups/<backup-id>.tar.gz.age --verify --execute
   ```

5. Restore RustFS/S3 object storage from the backup, or repoint it using the
   deployment's replication procedure:

   ```sh
   HELIX_BACKUP_RUSTFS_BUCKET=helix-objects \
     infra/scripts/restore.sh --backup backups/<backup-id>.tar.gz --restore-objects --execute
   ```

   For a point-in-time recovery from a `--pitr` backup, use the PITR restore
   path documented in `docs/backup-restore.md` (`restore.sh --pitr
   --recovery-target-time ...`).
6. Start remaining services:

   ```sh
   docker compose up -d
   ```

7. Rebuild derived indexes:

   ```sh
   helix reindex --all
   ```

   If the app server is not running yet but the restored database and Meilisearch are reachable from the operator shell, use the local reindex command instead:

   ```sh
   DATABASE_URL=postgres://helix:...@127.0.0.1:28432/helix \
   MEILI_HOST=http://127.0.0.1:28436 \
   MEILI_MASTER_KEY=<key> \
   pnpm --filter @helix/app db:reindex:search -- --all
   ```

   For a local test stack that should be ready for UI/API smoke against seeded
   mail, Drive, Docs, Calendar, RustFS objects, and Meilisearch results, use the
   live demo data wrapper. It starts only Postgres, RustFS, and Meilisearch under
   an isolated Compose project on contiguous high ports (`39532`-`39535` by
   default), then runs the stricter all-in-one preparation command:

   ```sh
   pnpm quality:live-demo-data -- --execute
   ```

   Pull requests and pushes run the same backend smoke in the Quality Gates
   workflow with a small deterministic volume mailbox (`--volume-mail-count 25`)
   and an always-on Compose cleanup step.
   Add `--anchor-date <YYYY-MM-DD>` when the seeded mail, calendar, chat, and
   volume-mail timestamps should sit near a current test day without changing
   deterministic IDs, storage keys, or search markers.

   The underlying command remains useful when services are already running:

   ```sh
   DATABASE_URL=postgres://helix:...@127.0.0.1:28432/helix \
   RUSTFS_ENDPOINT=http://127.0.0.1:28437 \
   MEILI_HOST=http://127.0.0.1:28436 \
   MEILI_MASTER_KEY=<key> \
   pnpm --filter @helix/app db:prepare:demo -- --require-storage --require-search
   ```

8. Verify critical paths:

   ```sh
   docker compose exec -T postgres psql -U helix -d helix_restore_drill -v ON_ERROR_STOP=1 -c "select count(*) from information_schema.tables where table_schema='public';"
   docker compose exec -T postgres psql -U helix -d helix_restore_drill -v ON_ERROR_STOP=1 -c "select 'public.actors'::regclass, 'public.activity'::regclass, 'public.installed_plugins'::regclass;"
   docker compose exec -T postgres psql -U helix -d helix_restore_drill -v ON_ERROR_STOP=1 -c "select count(*) as activity_rows, count(this_hash) as hashed_activity_rows from public.activity;"
   curl -fsS http://localhost:28431/readyz
   curl -fsS http://localhost:28431/openapi.json
   ```

9. For app-level audit proof against a running stack, run the live auth smoke
   audit slice and keep the `/metrics` sample with the release evidence:

   ```sh
   HELIX_SMOKE_CLIENT_ID=helix-local-oauth-client \
   HELIX_SMOKE_CLIENT_SECRET=helix-local-dev-secret \
   HELIX_TRACE_TOKEN=runbook-audit-$(date +%Y%m%d) \
     pnpm quality:live-auth-smoke -- --base-url http://127.0.0.1:28431 --audit-runtime-smoke
   ```

10. Switch DNS only after application health, auth, search, audit, and object download checks pass.

## Restore Drill

The nightly CI restore drill (`.github/workflows/restore-drill.yml`, 08:17 UTC
daily) restores the **prior day's** backup artifact, not a freshly created one.
Each run downloads the previous night's `helix-nightly-backup` artifact, selects
it with `restore-drill.sh --prior-day`, executes the drill against Compose
Postgres, then publishes tonight's backup for the next run. `--max-age-hours 36`
fails the drill if the prior-day backup is missing or stale.

Offline validation:

```sh
pnpm infra:restore:validate
```

Local full drill against an existing prior-day backup:

```sh
docker compose up -d postgres
infra/scripts/restore-drill.sh --backup-dir backups --prior-day --max-age-hours 36 --execute
```

Local full drill that creates its own backup first (development convenience):

```sh
docker compose up -d postgres
infra/scripts/restore-drill.sh --create-backup --execute
```

Live smoke wrapper with migrations, seeded local OAuth data, backup creation,
isolated restore, and post-restore SQL checks:

```sh
pnpm quality:live-restore-drill -- --execute
```

For workstation evidence, prefer an isolated Compose project and high Postgres
port so the drill does not share the normal local volume:

```sh
POSTGRES_DB=helix_restore_source \
POSTGRES_PORT=39432 \
DATABASE_URL=postgres://helix:helix_dev_password@127.0.0.1:39432/helix_restore_source \
  pnpm quality:live-restore-drill -- \
    --compose-project helix_restore_smoke \
    --target-db helix_restore_drill_smoke \
    --execute
```

The drill restores to a separate target database, validates schema visibility,
and can check `/readyz` and `/openapi.json` when `HELIX_VERIFY_APP_URL` or
`--verify-app-url` is set. Those app probes are backend HTTP checks only.

To include the derived-search rebuild step, run the drill with an authenticated app endpoint:

```sh
HELIX_RESTORE_DRILL_REINDEX=true \
HELIX_BASE_URL=http://localhost:28431 \
HELIX_ACCESS_TOKEN=<admin-token> \
infra/scripts/restore-drill.sh --backup backups/<backup-id>.tar.gz --execute
```

Dry-runs redact the access token while still proving the `helix reindex --all` command path.
For local restore drills without the app server, set `HELIX_REINDEX_COMMAND="pnpm --filter @helix/app db:reindex:search -- --all"` and provide the database/Meilisearch environment variables.
