# Production deployment configuration

Helix production startup fails closed when credentials or required Business-tier controls are
missing. This guide covers the Docker Compose production overlay. It is not a substitute for the
backup, restore, monitoring, or pilot gates in the production-readiness plan.

Production promotion requires the revision-bound eight-gate manifest described in
[`final-release-readiness.md`](final-release-readiness.md). Ordinary manifests and CI contract
tests are preflight evidence only.

For the shortest path from an empty host to a signed-in administrator, follow
[the pilot install runbook](runbooks/pilot-install-zero-to-mail.md); this guide explains each
setting it uses.

## Public surface

Apply `docker-compose.production.yml` after the development Compose file. The resolved production
stack publishes only:

- Caddy HTTP and HTTPS (TCP 80, TCP/UDP 443 by default); and
- the explicitly selected inbound SMTP port (TCP 25 by default).

The optional [Meet install](#meet-and-calendar) adds its media and TURN ports, and nothing else.

Postgres, Redis, NATS, Meilisearch, RustFS, Cerbos, ClamAV, Mailpit, observability, and admin ports
remain private. The production Caddyfile does not proxy the RustFS console or Cerbos API. Reach
private operator services through a VPN, SSH tunnel, or a separately authenticated admin ingress.

Mailpit is placed behind a development-only profile and is not a Helix production dependency.
Outbound Internet mail must use `ses`, `postmark`, `mailgun`, `managed-smtp`, or `smtp-relay`.
Direct-to-MX delivery is not supported.

CI builds two targets from `infra/docker/Dockerfile`: the Helix API/worker runtime and a non-root
Caddy edge containing the compiled web client. The production overlay deliberately removes all
local `build` sections and pulls only operator-supplied, digest-qualified promoted images. This
prevents a deployment host from silently rebuilding or substituting unreviewed source. The web
edge serves the SPA and proxies only explicit API, OAuth, MCP, realtime, WebDAV, and discovery
paths to Helix. The production web shell advertises Mail, Drive, Chat, Assistant, and Admin.
Calendar and Meet remain dormant behind the full profile. Drive provides file storage and download.
The [1.0 scope](release/1.0-scope.md) defines the packaging contract.

Both images build from this repository without sibling contexts. For a local review build that
will later be scanned, signed, pushed, and selected by digest, use:

```sh
docker buildx build \
  -f infra/docker/Dockerfile \
  --target runtime \
  -t helix/workspace:production .

docker buildx build \
  -f infra/docker/Dockerfile \
  --target web-runtime \
  -t helix/workspace-web:production .
```

### Applying schema migrations

Migrations are never applied by the application at boot — the entrypoint is
`node dist/index.js` and nothing in it touches the schema. Each deployment
method runs them separately, and both are ordered so that new code never
serves against an old schema:

| Method                        | What runs migrations                  | Ordering                                                                                                                                              |
| ----------------------------- | ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Docker Compose                | the one-shot `helix-migrate` service  | the app `depends_on` it with `condition: service_completed_successfully`                                                                              |
| Helm / Kubernetes             | the `<release>-migrate` Job           | a `pre-install,pre-upgrade` hook, so Helm waits for it and aborts the release if it fails                                                             |
| Helm + in-chart CloudNativePG | the same Job                          | `post-install` on the first install (the Cluster must exist first; the runner waits up to `migrations.databaseWaitSeconds`), `pre-upgrade` afterwards |
| Anything else                 | `pnpm --filter @helix/app db:migrate` | you own the ordering; run it to completion before the new image serves traffic                                                                        |

The runner takes a Postgres advisory lock, so it is safe to run while an old
replica is still serving and safe to run concurrently from two places.

`migrations.enabled=false` turns the Helm Job off, for pipelines that apply
migrations in a separate step. A release with neither will start and then fail
on the first request touching a changed table, which is harder to diagnose than
a failed migration.

The one-shot `helix-migrate` job resolves workspace migration sources from its own
minimal operational environment; it does not require application provider, listener, or MFA
configuration merely to apply the platform schema.

Both final images run as fixed UID/GID `10001`. The application uses a digest-pinned distroless
Node.js runtime with no shell, package manager, or global npm installation. Its payload is limited
to compiled output and production dependencies; a fail-closed reachability pass removes orphaned
pnpm virtual-store entries and package-manager metadata after deployment. It includes compiled
database migrations but no source tree, package-manager cache, or source-control metadata.
Promotion must pin all base images and both resulting application images by digest and record
those digests in the release-readiness manifest.

Production Compose requires the exact promoted registry references below. Every value must include
an OCI digest (`registry/repository@sha256:<64 hex>`); human-readable tags and local image names are
not deployment inputs:

| Variable                  | Promoted image                    |
| ------------------------- | --------------------------------- |
| `HELIX_IMAGE`             | Application runtime               |
| `HELIX_WEB_IMAGE`         | Caddy/web runtime                 |
| `HELIX_POSTGRES_IMAGE`    | Helix PostgreSQL + pgvector image |
| `HELIX_NATS_IMAGE`        | Helix NATS image                  |
| `HELIX_MEILISEARCH_IMAGE` | Helix Meilisearch image           |
| `HELIX_CERBOS_IMAGE`      | Helix Cerbos image                |
| `HELIX_SPAMD_IMAGE`       | Helix SpamAssassin image          |
| `HELIX_CLAMAV_IMAGE`      | Helix ClamAV image                |

The application and migration process enforce this at startup according to
`HELIX_DEPLOYMENT_KIND`, which every production deployment declares and which fails closed when
missing or unknown. `docker-compose.production.yml` sets `compose`: all eight variables above are
required. The Helm chart sets `helm`: only `HELIX_IMAGE` is required (the chart sets it from the
image it runs, `ghcr.io/billiondollarsolo/helix-workspace` or the sovereign
`ghcr.io/billiondollarsolo/helix-workspace-fips`), because the chart deploys no other Helix
service image the application runs; any other image variable that is set must still be pinned.

The pinned Redis and RustFS references remain checked into the base Compose file. The
resolved production-config evidence must capture all ten active digests and the final release
packet must bind each digest to its scan and SBOM.

The checked-in stack also fixes the complete active dependency inventory: PostgreSQL 18.6 with
pgvector 0.8.5, Redis 8.10.2, NATS 2.14.3, Meilisearch 1.51.0, RustFS 1.0.1, Cerbos
0.54.0, SpamAssassin 4.0.2, and ClamAV 1.5.4. Registry images use immutable manifest digests.
Helix-built dependency images use digest-pinned build/runtime bases, immutable source revisions,
and verified source archives. CI builds or pulls every one of these images, produces an SPDX SBOM,
runs a fail-closed High/Critical Trivy scan (findings without a released upstream fix are
excluded and do not fail the gate), and retains the machine-readable result. No locally
built image is pushed until both application scans and all nine dependency scans (the eight
Compose services plus the CloudNativePG PostgreSQL operand) succeed. The
publication job loads checksummed archives exported by the scan jobs, verifies their source
revision and image IDs, and publishes those exact images without rebuilding. Redis and RustFS
remain digest-pinned pull-and-scan inputs and are not republished by Helix. ClamAV is rebuilt on
its pinned upstream Alpine image to pick up patched runtime packages (pcre2) before the upstream
tag does, then scanned and promoted like the other Helix-built images. A release packet
must bind the exact resolved image digests—not merely these human-readable tags—to its corresponding
scan and SBOM. The official ClamAV 1.5.4 Alpine container is amd64-only, so this Compose deployment targets
`linux/amd64` for that service.

SpamAssassin's image contains the Apache-published 4.0.2 rules archive, verified against Apache's
published SHA-256 during the build. Its startup update remains enabled, but an unavailable update
mirror cannot leave the daemon without a valid baseline ruleset. Helix waits for SpamAssassin,
ClamAV, PostgreSQL, Redis, NATS, Meilisearch, RustFS, and Cerbos health checks before starting the
application.

Meilisearch data directories must not be reused across incompatible versions. A new
installation must start with an empty `meili-data` volume and rebuild indexes from PostgreSQL. For
an existing deployment, create and download a dump with the old Meilisearch version, retain and
checksum it, stop the old service, move the old volume aside without deleting it, start 1.51.0
against a new empty volume with `--import-dump /path/to/<dump-uid>.dump`, and then run the Helix
full reindex. Promotion requires a count/sample comparison and search smoke before the old volume
can be retired. Follow the version-specific warnings in the
[official Meilisearch update guide](https://www.meilisearch.com/docs/resources/migration/updating).
Never attach an older Meilisearch database directory directly to the 1.51.0 image.

PostgreSQL 17 volumes are not binary-compatible with PostgreSQL 18. The Compose volume now mounts
at `/var/lib/postgresql`, matching the PostgreSQL 18 version-specific cluster layout. An existing
deployment must use a rehearsed logical dump/restore or `pg_upgrade`; changing only
`HELIX_POSTGRES_IMAGE` is prohibited. Before promotion:

1. Stop Helix writes and retain a filesystem/storage snapshot of the PostgreSQL 17 volume.
2. Run the existing backup verification and restore drill, then create a fresh `pg_dumpall
--globals-only` and `pg_dump --format=custom` application backup with the PostgreSQL 17 client.
3. Start PostgreSQL 18.6 with pgvector 0.8.5 against a new empty volume. Restore globals first,
   restore the application database, and run `ALTER EXTENSION vector UPDATE TO '0.8.5'`.
4. Run every Helix migration, the migration compatibility check, tenant-isolation tests, row-count
   and checksum sampling, a full search reindex, and the live data-plane smoke.
5. Keep the PostgreSQL 17 snapshot read-only until the release rollback window closes. Rollback is
   restore-based; a PostgreSQL 18 data directory must never be attached to PostgreSQL 17.

Record the source and target versions, backup hashes, restore duration, verification results, and
the exact promoted image digest in the release packet.

### Dependency image users

Every Helix-built dependency image runs as an unprivileged user:

| Service      | UID:GID       | Writable paths                                                   |
| ------------ | ------------- | ---------------------------------------------------------------- |
| PostgreSQL   | `70:70`       | `/var/lib/postgresql`, `/var/run/postgresql`                     |
| ClamAV       | `100:101`     | `/var/lib/clamav`, `/etc/clamav`, `/run/clamav`                  |
| NATS         | `10001:10001` | `/data`                                                          |
| Meilisearch  | `10001:10001` | `/meili_data` (database, dumps, snapshots)                       |
| Cerbos       | `10001:10001` | `/tmp`, `/.cache`                                                |
| SpamAssassin | `10001:10001` | `/var/lib/spamassassin`, `/run/spamd`, three network `.cf` files |

Compose mounts secret files with their host owner and mode. The PostgreSQL TLS bootstrap is the one
step that starts as root (`user: "0:0"` in the production overlay): it copies the `0600` secret
files into a postgres-owned directory, and the official entrypoint then switches to UID 70 before
the server starts. NATS reads `nats_server_cert`, `nats_server_key`, and `nats_ca`, and
Meilisearch reads `meili_master_key`, directly as UID 10001, the same UID that reads the Helix
application secrets, so those files must be readable by UID 10001.

Meilisearch now keeps its database in `/meili_data`, the mounted `meili-data` volume. Earlier
images wrote it to `/data.ms` in the container layer, so it was lost whenever the container was
recreated and could not start on the overlay's read-only root filesystem. After upgrading, rebuild
the indexes with the scoped `/api/admin/search/reindex` reconciliation.

**Upgrading existing volumes.** New volumes take their ownership from the image. Volumes written by
the earlier root images must be handed to the new users once, before the new images start.
PostgreSQL needs no change because its cluster directory is already owned by UID 70. ClamAV's
earlier entrypoint already gave its database to `clamav`, so its step is only a safeguard. Stop the
services, then run each step with the service's own image and volume:

```sh
compose="docker compose --env-file .env.production -f docker-compose.yml -f docker-compose.production.yml"
$compose stop nats meilisearch spamd clamav
$compose run --rm --no-deps --user 0:0 --cap-add CHOWN --entrypoint chown nats -R 10001:10001 /data
$compose run --rm --no-deps --user 0:0 --cap-add CHOWN --entrypoint chown meilisearch -R 10001:10001 /meili_data
$compose run --rm --no-deps --user 0:0 --cap-add CHOWN --entrypoint chown spamd -R 10001:10001 /var/lib/spamassassin
$compose run --rm --no-deps --user 0:0 --cap-add CHOWN --entrypoint chown clamav -R 100:101 /var/lib/clamav
$compose up -d nats meilisearch spamd clamav
```

For a local development stack, run the same steps with only `-f docker-compose.yml` and add
`--profile mail-security` for `spamd` and `clamav`. Without this step NATS exits on a permission
error, and Meilisearch, SpamAssassin rule updates, and ClamAV fail to write their data.

After building, execute the same runtime contract used by CI:

```sh
node infra/scripts/validate-production-images.mjs \
  --application-image helix/workspace:production \
  --web-image helix/workspace-web:production
```

The check inspects both image configurations and then runs their payload assertions with a
read-only root filesystem and no network. It requires UID/GID `10001`, the expected entrypoints and
health checks, compiled migrations and SPA assets, a valid Caddy configuration, and rejects source,
source-control, environment, package-manager tooling, metadata, and unreachable build-only
dependencies.

The overlay enables two audit destinations so the Business tier starts with enforced audit sinks:
the WORM-Postgres copy and immutable object copies in the bundled object store (see
[Audit copies](#audit-copies)). Both live on the deployment host. They are a bootstrap control,
not the final off-host assurance gate: configure and prove immutable off-host audit shipping
before the private pilot.

## Database

Helix requires **PostgreSQL 18** with **pgvector 0.8 or newer** (the shipped images pin
pgvector 0.8.5). pgvector is not optional: migrations create `vector` columns for AI memory
(`memory_items`), vector collections (`vector_items`), and semantic search, so the schema cannot be
applied without it. Which semantic-search backend a tenant selects (pgvector or Qdrant) is runtime
configuration; the extension is required either way.

| Deployment                     | PostgreSQL image                                                                  | Who creates extensions and roles                                                                                      |
| ------------------------------ | --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Compose (local and production) | `infra/postgres/Dockerfile` → `helix-workspace-postgres` (PostgreSQL 18.6 Alpine) | `infra/postgres/init/001_extensions.sql` and, with production password files, `002_production_roles.sh`, as superuser |
| Helm with CloudNativePG        | `infra/postgres/Dockerfile.cnpg` → `helix-workspace-postgres-cnpg`                | the Cluster's `bootstrap.initdb.postInitApplicationSQL` (superuser) plus CloudNativePG managed roles                  |
| Helm with external PostgreSQL  | operator-provided PostgreSQL 18 with pgvector ≥ 0.8                               | the operator, once, as a superuser (below)                                                                            |

The 1.0 release is the production Compose stack ([1.0 scope](release/1.0-scope.md)). For
Kubernetes, CloudNativePG is the supported database path and the enterprise overlay enables it;
ADR-0022/0023 are historical proposals and do not change the 1.0 packaging. The chart default
(`cloudnativepg.enabled: false`) expects an external PostgreSQL that meets the same requirements.

### Required extensions

| Extension  | Minimum | Why                                                   | Trusted |
| ---------- | ------- | ----------------------------------------------------- | ------- |
| `vector`   | 0.8.0   | `vector` columns and operators (memory, search, RAG)  | no      |
| `pgcrypto` | —       | digests and random values in defaults and functions   | yes     |
| `pg_trgm`  | —       | trigram indexes for contacts and the people directory | yes     |

`vector` is not a trusted extension, so only a superuser can create it. Helix migrations run as
the non-superuser migration login `helix_migrator`, so every deployment installs the extensions
before the first migration: Compose through its init scripts, CloudNativePG through the
superuser bootstrap SQL the chart renders. `pgcrypto` and `pg_trgm` are trusted and the owning
login could create them, but the bootstrap installs them too so all paths produce the same
function privileges.

### Role model

| Role                    | Login | Purpose                                                                            |
| ----------------------- | ----- | ---------------------------------------------------------------------------------- |
| `helix_migrator`        | yes   | migration login and database owner; NOSUPERUSER; member of `helix_migration_owner` |
| `helix_migration_owner` | no    | owns every Helix object; BYPASSRLS; assumed by the runner after migration 0090     |
| `helix_app`             | yes   | application runtime; NOSUPERUSER, NOBYPASSRLS, NOINHERIT, owns nothing             |
| `helix_worker`          | yes   | worker runtime; same constraints as `helix_app`                                    |
| `helix_readonly`        | yes   | read-only access; same constraints                                                 |

Creating roles and setting BYPASSRLS requires a superuser, so the bootstrap provisions all four
Helix roles with exactly the attributes migration 0090 enforces and grants `helix_migration_owner`
to `helix_migrator`. Migration 0090 then only verifies them; if a role is missing or has drifted
and the migrator is not a superuser, it stops with the `ALTER ROLE` statement to run. Application
replicas still refuse to start unless they connect as a non-owner, NOSUPERUSER, NOBYPASSRLS role
(`assertTenantSafeDatabaseRole`).

### Startup checks

- The migration runner first checks the server: PostgreSQL 18 or newer, each extension installed
  or creatable by the connecting role, and pgvector at least 0.8.0. A failure names the missing
  piece and the SQL to run, instead of a `permission denied` part-way through the migrations.
  `HELIX_MIGRATION_DATABASE_WAIT_SECONDS` (Helm `migrations.databaseWaitSeconds`, default 600 in
  the chart) retries connection failures only, so a CloudNativePG cluster that is still
  initialising does not fail the first install.
- Production application replicas check the same requirements at boot as the runtime role, and
  log a warning when the installed extension is older than the server's package (for example after
  an image upgrade).

### Upgrading pgvector

A new image ships new extension files but leaves the installed SQL objects at the old version.
After rolling out a PostgreSQL image with a newer pgvector, run as a superuser (the extension
owner) in the Helix database:

```sql
ALTER EXTENSION vector UPDATE;
SELECT extversion FROM pg_extension WHERE extname = 'vector';
```

Until then the application logs the version mismatch at startup.

### External PostgreSQL

Provide PostgreSQL 18 with the pgvector package (≥ 0.8.0) installed, TLS with a CA that the
application pins (`POSTGRES_TLS_CA_FILE`), and run once as a superuser in the Helix database:

```sql
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE ROLE helix_migrator LOGIN PASSWORD '<migration password>' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
CREATE ROLE helix_migration_owner NOLOGIN NOSUPERUSER BYPASSRLS NOINHERIT NOCREATEDB NOCREATEROLE NOREPLICATION;
CREATE ROLE helix_app LOGIN PASSWORD '<app password>' NOSUPERUSER NOBYPASSRLS NOINHERIT NOCREATEDB NOCREATEROLE NOREPLICATION;
CREATE ROLE helix_worker LOGIN PASSWORD '<worker password>' NOSUPERUSER NOBYPASSRLS NOINHERIT NOCREATEDB NOCREATEROLE NOREPLICATION;
CREATE ROLE helix_readonly LOGIN PASSWORD '<readonly password>' NOSUPERUSER NOBYPASSRLS NOINHERIT NOCREATEDB NOCREATEROLE NOREPLICATION;
ALTER DATABASE helix OWNER TO helix_migrator;
GRANT helix_migration_owner TO helix_migrator;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO helix_migration_owner, helix_app, helix_worker;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
```

Managed services that expose a restricted "admin" role instead of a superuser (for example
`rds_superuser` or `azure_pg_admin`) must allow-list `vector`, `pgcrypto`, and `pg_trgm`, and that
admin role must be able to create the BYPASSRLS `helix_migration_owner` role. Point
`HELIX_MIGRATION_DATABASE_URL` (Helm `external.postgres.migrationUrlSecret`) at `helix_migrator` and
`DATABASE_URL` at `helix_app`. The infra/postgres/init scripts are the reference for this SQL.

### CloudNativePG

The chart renders a `postgresql.cnpg.io/v1` `Cluster` that runs the digest-pinned
`helix-workspace-postgres-cnpg` operand. That image is the CloudNativePG `minimal` PostgreSQL
18.6 image (Debian, PGDG packages, UID 26, the layout the instance manager expects) plus pgvector
0.8.5 compiled from the same pinned commit and verified archive as the Compose image. The upstream
`standard` flavour also contains pgvector, but as whatever PGDG package was current at its weekly
rebuild, so it cannot guarantee the version Compose pins. The Production Image Security workflow
builds, SBOM-scans, Trivy-gates, and publishes the operand like every other dependency image; set
its published digest in `cloudnativepg.image.digest`. The `cloudnativepg.image.tag`
version (default `18.6`) lets CNPG detect upgrades; the digest pins the image bytes.
Tags without a digest are rejected.

Backups use the Barman Cloud Plugin (`barman-cloud.cloudnative-pg.io`): the operator injects
barman-cloud as a sidecar, which is why the operand does not bundle it. The in-core
`barmanObjectStore` integration is deprecated since CloudNativePG 1.26. Requirements: CloudNativePG
1.26 or newer and, when backups are enabled, the Barman Cloud Plugin. Details are in
[`backup-restore.md`](backup-restore.md#enterprise-cloudnativepg-pitr) and the
[Helm chart README](../infra/helm/helix/README.md#database).

## Secret files

Every secret lives in one operator-owned directory outside source control. Generate a complete
set on the deployment host (requires Node.js 22 or newer and `openssl`; the
[install runbook](runbooks/pilot-install-zero-to-mail.md) shows a Docker-only alternative):

```sh
node infra/scripts/generate-production-secrets.mjs \
  --dir /srv/helix-secrets \
  --mail-host mail.example.com
```

The script writes independent random values, creates one private certificate authority, and signs
the PostgreSQL, Redis, NATS, and object-storage server certificates, the NATS client certificate,
and a placeholder certificate for inbound SMTP. It refuses to write into a directory that already
contains files, so it cannot rotate a running deployment by accident. Afterwards:

1. Replace the contents of `mail_smtp_password` with your mail provider's SMTP password or API
   credential (at least 32 characters). Until you do, the file holds a marked placeholder.
2. Move `ca/` (the CA certificate and its private key) to offline storage. Compose never mounts it;
   you need it again only to renew the service certificates, which are valid for 825 days.
3. Back the directory up offline. Losing `rustfs_kms_master_key` makes stored files and mail
   attachments unreadable.

The directory is mode `0700` and its files are mode `0644`: the services run as different
unprivileged users (see [Dependency image users](#dependency-image-users)) and Compose mounts each
file as it is, so the directory, not the files, keeps other host users out. To create the files
yourself instead, provide these non-empty files with the same permissions:

| File                           | Content                                  |
| ------------------------------ | ---------------------------------------- |
| `database_url`                 | Least-privilege application Postgres URL |
| `migration_database_url`       | Elevated schema-migrator Postgres URL    |
| `postgres_password`            | The corresponding Postgres role password |
| `postgres_app_password`        | Base64url application-role password      |
| `postgres_migration_password`  | Base64url migrator-role password         |
| `postgres_ca`                  | PEM CA for PostgreSQL server TLS         |
| `postgres_server_cert`         | PEM PostgreSQL server certificate        |
| `postgres_server_key`          | PEM PostgreSQL server private key        |
| `redis_url`                    | `rediss:` URL with the Redis password    |
| `redis_acl`                    | Redis ACL matching `redis_password`      |
| `redis_password`               | Base64url Redis password                 |
| `redis_ca`                     | PEM CA for Redis server TLS              |
| `redis_server_cert`            | PEM Redis server certificate             |
| `redis_server_key`             | PEM Redis server private key             |
| `nats_password`                | Base64url NATS application password      |
| `nats_ca`                      | PEM CA for NATS mutual TLS               |
| `nats_server_cert`             | PEM NATS server certificate              |
| `nats_server_key`              | PEM NATS server private key              |
| `nats_client_cert`             | PEM Helix NATS client certificate        |
| `nats_client_key`              | PEM Helix NATS client private key        |
| `better_auth_secret`           | Random Better Auth secret                |
| `mfa_assertion_secret`         | Random upstream MFA assertion HMAC key   |
| `rustfs_access_key`            | Random object-store access identifier    |
| `rustfs_secret_key`            | Random object-store secret               |
| `rustfs_kms_master_key`        | Base64 of 32 random bytes (object KMS)   |
| `rustfs_ca`                    | PEM CA for object-storage server TLS     |
| `rustfs_server_cert`           | PEM object-storage server certificate    |
| `rustfs_server_key`            | PEM object-storage server private key    |
| `audit_anchor_secret`          | Random audit-copy signing secret         |
| `meili_master_key`             | Random Meilisearch master key            |
| `mail_smtp_password`           | Managed provider SMTP/API credential     |
| `mail_provider_webhook_secret` | Managed provider event-signing secret    |
| `smtp_tls_cert`                | PEM certificate for inbound SMTP         |
| `smtp_tls_key`                 | PEM private key for inbound SMTP         |

Two more files are needed only for the options that use them: `searxng_secret` for the
`web-search` profile, and `tls_cert` and `tls_key` when you
[provide your own certificate](#tls-certificates). The optional
[password manager](#password-manager) needs no secret of its own.

Secret values must contain at least 32 characters and at least 12 distinct characters. Generate
independent values from a cryptographically secure random source. Do not reuse credentials between
services. PostgreSQL, Redis, and NATS password files must use base64url characters so their
bootstrap/configuration parsers cannot interpret password bytes as configuration syntax.
`database_url` must name `helix_app` and use `postgres_app_password`;
`migration_database_url` must name `helix_migrator` and use
`postgres_migration_password`. The `database_url` role may read and mutate application data but must not own schemas,
create extensions, or change database roles. The distinct `migration_database_url` role owns Helix
schemas and runs only in the one-shot `helix-migrate` service. Application replicas never receive
that elevated secret. `postgres_password` is the bootstrap database credential consumed by the
Postgres image and must not be reused for either Helix role in a managed production database.

`redis_url` has the form `rediss://:<percent-encoded-password>@redis:6379`. Its decoded password
must match `redis_password`; `redis_acl` must contain an enabled default user with the same
credential, for example `user default on >PASSWORD ~* &* +@all`. Restrict that ACL further if Redis
is split by application role. The production overlay disables Redis's plaintext port and validates
the server certificate against `redis_ca`.

The NATS certificate authority must sign both the server and client certificates. The server
certificate must contain `nats` in its SANs. The checked-in NATS policy enables mutual TLS,
authenticates only `helix_app`, and limits that application role to `helix.>` subjects. Split worker
roles into narrower NATS users before deploying independently trusted workloads; the monolithic
pilot process legitimately publishes and subscribes across the complete Helix event namespace.

The PostgreSQL certificate must contain `postgres` in its SANs. The overlay installs a
`hostssl`-only `pg_hba.conf`, enables SCRAM-SHA-256, creates separate application and migration
roles on an empty database, and gives schema creation only to the migrator. For an existing
database, provision and verify equivalent grants before switching URLs. Helix pins `postgres_ca`
and refuses production startup without it.

Set `HELIX_PRODUCTION_SECRETS_DIR` to the absolute host directory before resolving or starting the
stack. Helix supports only its documented `*_FILE` allowlist. It rejects simultaneous inline and
file-backed values, non-absolute paths, empty/non-regular files, and files larger than 64 KiB.
Diagnostics identify the affected variable without printing the path or secret.

For Kubernetes or another orchestrator, mount equivalent secret-manager/CSI files and set the
corresponding `*_FILE` variables. Do not render secrets into a Compose file, image layer, command
line, CI artifact, or application log.

## Image references

Every push to `main` that passes the Production Image Security workflow publishes the eight
images to GitHub Container Registry, tagged with the commit. The overlay accepts only digest
references, so resolve them once for the commit you are deploying and paste the output into
`.env.production`:

```sh
commit="$(git rev-parse HEAD)"
while read -r variable image; do
  digest="$(docker buildx imagetools inspect \
    "ghcr.io/billiondollarsolo/$image:$commit" --format '{{.Manifest.Digest}}')"
  echo "$variable=ghcr.io/billiondollarsolo/$image@$digest"
done <<'IMAGES'
HELIX_IMAGE helix-workspace
HELIX_WEB_IMAGE helix-workspace-web
HELIX_POSTGRES_IMAGE helix-workspace-postgres
HELIX_NATS_IMAGE helix-workspace-nats
HELIX_MEILISEARCH_IMAGE helix-workspace-meilisearch
HELIX_CERBOS_IMAGE helix-workspace-cerbos
HELIX_SPAMD_IMAGE helix-workspace-spamassassin
HELIX_CLAMAV_IMAGE helix-workspace-clamav
IMAGES
```

A commit whose workflow run has not finished, or failed, has no images; the command then reports
that the tag was not found. Deploy the checkout that matches the images: the overlay mounts
configuration files (NATS, Cerbos policies, Meilisearch) from the repository.

## TLS certificates

Caddy terminates HTTPS for `HELIX_DOMAIN`. Choose one source for its certificate:

| Mode                      | How to select it                                               | Use it when                                                               |
| ------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Automatic                 | Nothing to set                                                 | The host is reachable from the Internet on ports 80 and 443               |
| Uploaded in the console   | **Admin → Domains → HTTPS certificate**                        | You have your own certificate and want to manage it without server access |
| Your certificate as files | Add `-f docker-compose.tls-files.yml` to every Compose command | Certificates are delivered to the server by your own tooling              |
| Internal CA               | `HELIX_CADDY_TLS=internal` in `.env.production`                | Testing on a private network; browsers will not trust it                  |

**Automatic.** Caddy obtains and renews a certificate from Let's Encrypt. The DNS record for
`HELIX_DOMAIN` must point at the host before the first start, and ports 80 and 443 must be open.
The certificate and its account key are stored in the `caddy-data` volume; include it in backups to
avoid requesting a new certificate after every restore.

**Uploaded in the console.** An administrator with security permissions opens
**Admin → Domains → HTTPS certificate**, which shows the certificate being served, who issued it,
and when it expires, and chooses **Use your own certificate**. Helix accepts a PEM certificate
followed by its intermediates and an unencrypted RSA (2048 bits or more) or ECDSA P-256/P-384 key.
It refuses, with the reason, a certificate that does not cover `HELIX_DOMAIN`, is not yet valid or
has expired, has its chain out of order, or does not match the key. The edge switches to the new
certificate within seconds, without a restart, and stops requesting automatic certificates while
an uploaded one is in place. **Go back to automatic** removes it.

Nothing renews an uploaded certificate. The console warns from 30 days before it expires, the
application log repeats the warning once a day, and the same screen takes the renewal. Uploads and
removals are recorded in the audit log as `edge.tls.certificate_uploaded` and
`edge.tls.certificate_removed`, with the certificate's names, issuer, expiry, and fingerprint, and
never the key.

The private key is stored encrypted in the database and is never returned by the API. Helix writes
the certificate and key to the `edge-certs` volume, which only Helix and the edge mount, so the
edge serves the right certificate after a restart even when Helix is down; the volume is rewritten
from the database within a minute after a restore. Helix asks the edge to load that folder again
through the edge's admin socket, a Unix socket in the `caddy-admin` volume that only those two
services mount; the edge's admin interface has no network address. This mode is available when the
deployment selects automatic HTTPS or the internal CA, in single-organization deployments.

**Your certificate as files.** Put two PEM files in `HELIX_PRODUCTION_SECRETS_DIR`: `tls_cert` (the
certificate followed by its intermediate chain) and `tls_key` (the unencrypted private key). The
certificate must cover `HELIX_DOMAIN`, and `HELIX_PASSWORDS_DOMAIN` if you installed the
[password manager](#password-manager). Caddy does not renew it, and the console shows it but
cannot replace it. To replace it, overwrite both files and restart the edge:

```sh
docker compose --env-file .env.production \
  -f docker-compose.yml -f docker-compose.production.yml -f docker-compose.tls-files.yml \
  restart caddy
```

Inbound SMTP uses a separate certificate, `smtp_tls_cert` and `smtp_tls_key`. The generated one is
signed by the private CA, which is enough for opportunistic STARTTLS: sending servers encrypt the
connection but rarely verify the certificate. Replace both files with a publicly trusted
certificate for your mail hostname if you publish MTA-STS or DANE, then restart `helix`. A
certificate uploaded in the console is not used for mail.

## Object storage

The bundled RustFS needs no settings. The overlay serves it over TLS with the generated
certificate, encrypts every object with a key held by its local key-management service, and
creates the bucket with versioning and object-lock retention before the application starts:

- `rustfs-kms-init` and `rustfs-kms-key` prepare the key directory and create the named key
  (`RUSTFS_SSE_KMS_KEY_ID`, default `helix-default`).
- `helix-storage-init` creates the bucket (`RUSTFS_BUCKET`, default `helix-objects`), turns on
  versioning, sets the default encryption key, and sets default retention
  (`RUSTFS_OBJECT_LOCK_MODE`, default `GOVERNANCE`; `RUSTFS_OBJECT_LOCK_RETENTION_DAYS`, default
  `30`). Running it again never shortens an existing retention period.

Helix refuses to start unless the bucket has all of these, and its storage region
(`RUSTFS_REGION`, which defaults to `HELIX_REGION`) matches the workspace region.

Browsers upload and download files directly through short-lived signed links. Those links use
`RUSTFS_PUBLIC_ENDPOINT`, which defaults to `https://$HELIX_DOMAIN`; Caddy forwards only the
bucket's path to RustFS. Nothing else on RustFS is reachable from outside, and its console is
disabled.

Back up the `rustfs-data` and `rustfs-kms` volumes together with the `rustfs_kms_master_key`
secret. Objects cannot be decrypted without all three.

The overlay is tested with the bundled RustFS. An external S3-compatible service must give the
same guarantees: an HTTPS endpoint, a bucket with versioning, object lock, and default SSE-KMS
encryption. Point Helix at it with `RUSTFS_ENDPOINT`, `RUSTFS_REGION`, `RUSTFS_BUCKET`, and
`RUSTFS_SSE_KMS_KEY_ID`, set `RUSTFS_PUBLIC_ENDPOINT=` (empty) when browsers can reach that
endpoint directly, and put its credentials in `rustfs_access_key` and `rustfs_secret_key`.

### Audit copies

Helix writes a signed, object-locked copy of each audit batch to a second bucket
(`AUDIT_IMMUTABLE_S3_BUCKET`, default `helix-audit`) with `COMPLIANCE` retention of 365 days
(`AUDIT_IMMUTABLE_S3_RETENTION_DAYS`). Compliance-mode objects cannot be deleted or shortened by
anyone, including the storage administrator, until the retention period ends; choose the period
before the first start. `audit_anchor_secret` signs the chain anchors, and
`AUDIT_IMMUTABLE_S3_ANCHOR_KEY_ID` names that secret so it can be rotated.

## Malware and spam scanners

ClamAV and SpamAssassin are on the private data network and on a second network,
`scanner-updates-egress`, that exists only so they can download signature and rule updates. No
other service is attached to it and it publishes no ports.

On the first start ClamAV downloads its signature database before it accepts scans, which takes
several minutes. Helix reports not ready until scanning works, so `docker compose up -d` waits for
up to ten minutes the first time. Helix also reports not ready when the signatures are more than
48 hours old (`HELIX_AV_MAX_SIGNATURE_AGE_MS`); allow outbound HTTPS from the host to
`database.clamav.net`.

## Optional installs

Some components are not part of the default stack. Nothing below is started, pulled, or
advertised to people unless you opt in when you install, and each one can be added to a running
deployment later.

### Native Passwords

KeePass-compatible personal vaults are built into Helix. Apply the normal
platform migrations, then turn on **Admin → Apps → Passwords → Passwords is on
for everyone**. No second service, DNS hostname, email verification, or vault
account is required. A person signs in to Helix, creates a vault master password,
and saves logins or secure notes in `/passwords`.

Encryption and decryption happen in a disposable browser worker. The API stores
only KDBX ciphertext, scoped to the human session and tenant; API keys, agents,
and OAuth clients cannot use the personal vault endpoint. Vaults are separate
from Drive objects, search, and MCP. The edge CSP includes `wasm-unsafe-eval`
for the bundled Argon2 implementation, without permitting JavaScript eval.

A vault has a 1 MiB operational size limit. Helix keeps the current and previous
saved encrypted revisions. Users can download either as `.kdbx`; configure and
test encrypted off-server database backups for broader recovery. Every request supplies `X-Helix-Vault-Owner`, matching the verified session
actor; this guards against an account switch while a tab has unsaved changes.
A stale save returns a conflict instead of overwriting a different tab. Download the unsaved
vault before discarding and reloading. Helix cannot recover a forgotten master
password. Sharing, imports and direct external-client synchronization are not
part of this first implementation.

### Legacy password manager

A bundled [Vaultwarden](https://github.com/dani-garcia/vaultwarden) server, compatible with the
Bitwarden apps and browser extensions. It is a separate service with its own accounts and
end-to-end encrypted vaults: Helix links to it and never sees a master password or a vault entry.

1. Point a second DNS name at the host, for example `vault.example.com`. The vault is served on
   its own address so that it never shares a browser origin with the workspace.
2. Add to `.env.production`:

   ```sh
   COMPOSE_PROFILES=passwords
   HELIX_PASSWORDS_DOMAIN=vault.example.com
   ```

3. Start the stack as usual. Caddy obtains a certificate for the second name the same way it does
   for `HELIX_DOMAIN`. If you [provide your certificate as files](#tls-certificates), it must
   cover both names. A certificate uploaded in the console applies to `HELIX_DOMAIN`; the vault
   keeps its automatic certificate.
4. An administrator opens **Admin → Apps → Passwords**, which shows that the server has a
   password manager installed, and turns on **Passwords is on for everyone**. People then get a
   Passwords entry in the app launcher. The native Passwords page retains an **Open previous
   password manager** link; the Bitwarden clients continue to use the separate vault hostname.

People create their own vault account with an address in `MAIL_FROM_DOMAIN` and confirm it from
an email the vault sends through the same mail provider as Helix, from
`passwords@MAIL_FROM_DOMAIN`. Your provider must allow that sender.

| Setting                          | Default                      | Purpose                                                    |
| -------------------------------- | ---------------------------- | ---------------------------------------------------------- |
| `HELIX_PASSWORDS_DOMAIN`         | unset (not installed)        | The vault's public hostname                                |
| `HELIX_PASSWORDS_SIGNUP_DOMAINS` | `MAIL_FROM_DOMAIN`           | Comma-separated email domains allowed to create an account |
| `HELIX_PASSWORDS_MAIL_FROM`      | `passwords@MAIL_FROM_DOMAIN` | Sender of confirmation and security email                  |
| `HELIX_PASSWORDS_SMTP_SECURITY`  | `starttls`                   | `starttls`, or `force_tls` for an implicit-TLS port (465)  |

The container publishes no port, runs with a read-only root file system and no capabilities, and
does not download website icons, so it makes no outbound request other than mail. Its server
administration page is off. Vault data lives in the `vaultwarden-data` volume: include it in
backups, because a lost vault cannot be rebuilt from anything Helix stores. Turning the workspace
setting off removes the launcher entry; it does not stop the service or delete vaults. To remove
the service, drop the profile and the variable and run `up -d --remove-orphans`.

With the Helm chart, set `passwords.enabled=true` and the values described in the
[chart README](../infra/helm/helix/README.md#optional-password-manager).

### Meet and Calendar

Video meetings on a bundled [Jitsi](https://jitsi.org/) server, with Calendar to schedule them.
This is the Full Workspace profile. It is outside the [1.0 release scope](release/1.0-scope.md):
nothing here is deployed unless you add its Compose file, and the default stack stays on Mail,
Drive, Chat, and Assistant.

1. Point a DNS name at the host, for example `meet.example.com`.
2. Open these ports to the Internet. Media cannot go through the edge:

   | Port                       | Purpose                                         |
   | -------------------------- | ----------------------------------------------- |
   | UDP 10000                  | Audio and video to the media bridge             |
   | TCP and UDP 3478, TCP 5349 | TURN, for people whose network blocks UDP 10000 |
   | UDP 49160-49200            | TURN relay                                      |

3. Add the Meet secret files to the directory the other secrets are in. This needs the `ca`
   folder that the generator left there:

   ```sh
   node infra/scripts/generate-production-secrets.mjs --add-meet \
     --dir "$HELIX_PRODUCTION_SECRETS_DIR" --meet-host meet.example.com
   ```

4. Add to `.env.production`:

   ```sh
   HELIX_MEET_DOMAIN=meet.example.com
   HELIX_MEET_PUBLIC_IP=203.0.113.10   # the address browsers reach this host on
   ```

5. Add `-f docker-compose.meet.yml` to every Compose command:

   ```sh
   docker compose --env-file .env.production \
     -f docker-compose.yml -f docker-compose.production.yml -f docker-compose.meet.yml up -d
   ```

Helix then runs with `HELIX_WORKSPACE_PROFILE=full` and
`HELIX_APPS=mail,drive,chat,assistant,calendar,meet`, and refuses to start without the Jitsi
domain, region, and secrets the file supplies. Meet and Calendar appear in the app launcher. An
administrator can turn either off for the organization in **Admin → Apps**.

How it is put together:

- The meeting page is served by Caddy at `HELIX_MEET_DOMAIN`, with a certificate obtained the
  same way as for `HELIX_DOMAIN` (a certificate you provide as files must cover both names). Only
  the workspace may embed it.
- People join with a pass that Helix signs for one room and five minutes. Jitsi accepts no other
  way in: guests are off, and a pass signed with any other key is refused.
- The conference focus and the media bridge sign in to the XMPP server with generated passwords
  and verify its certificate against the deployment CA. No signalling port is published.
- Media is encrypted between each browser and the bridge (DTLS-SRTP). Peer-to-peer calls are off,
  so every call follows the bridge or TURN.
- `jitsi_turn_cert` and `jitsi_turn_key` are issued by the private CA, which browsers do not
  trust. TURN on port 3478 works as generated; for TURN over TLS on port 5349, replace both files
  with a publicly trusted certificate for `HELIX_MEET_DOMAIN` and restart `jitsi-turn`.
- Recording is not part of this install.

| Setting                 | Default   | Purpose                                                |
| ----------------------- | --------- | ------------------------------------------------------ |
| `HELIX_MEET_DOMAIN`     | required  | The meeting page's public hostname, also the TURN name |
| `HELIX_MEET_PUBLIC_IP`  | required  | The address the bridge and TURN tell browsers to use   |
| `HELIX_MEET_BIND_IP`    | `0.0.0.0` | Host address the media and TURN ports are published on |
| `HELIX_MEET_MEDIA_PORT` | `10000`   | Media port, published and advertised                   |
| `HELIX_MEET_TURN_PORT`  | `3478`    | TURN port, published and advertised                    |
| `HELIX_MEET_TURNS_PORT` | `5349`    | TURN over TLS port, published and advertised           |

One bridge on one host is sized for small meetings. `infra/scripts/production-boot-smoke.sh
--with meet` boots this install and holds a meeting between two browsers; run it on the host
class you intend to use. Kubernetes deployments use the Helm chart's `workspace.profile=full`
values with the separate media deployment in [`infra/meet/ha`](../infra/meet/ha/README.md).

To remove Meet, drop the file from the Compose commands and the two variables, and run
`up -d --remove-orphans`. Scheduled meetings and calendar events stay in the database.

## Readiness

`GET /readyz` returns 200 only when every dependency Helix needs answers. When it does not, the
application log names the failing dependency and the reason:

```sh
docker compose --env-file .env.production \
  -f docker-compose.yml -f docker-compose.production.yml \
  logs helix | grep -i 'not ready'
```

## First administrator

Production has no default accounts and no public sign-up. After the stack is healthy, create the
workspace owner's invitation from the host:

```sh
docker compose --env-file .env.production \
  -f docker-compose.yml -f docker-compose.production.yml \
  exec helix /nodejs/bin/node dist/db/bootstrap-owner.js \
  --email owner@example.com --name "Owner Name"
```

The command prints a single-use link that expires in 7 days. Open it, choose a password, and you
are signed in as the workspace owner with full administrator access. Running the command again
for the same address replaces the link; once the owner has joined it reports that and changes
nothing. The action is recorded in the audit log as `identity.owner.bootstrapped`. Treat the link
as a credential: it is printed to your terminal only and is not written to the application log.

Administrator actions require 2-step verification on the Business tier. Before using the Admin
console, open **Settings → Security → 2-step verification** and add an authenticator app or a
passkey. Until then the Admin console explains what is missing and links to those settings.

Administrator sessions are verified again after 10 minutes by default: the Admin console asks for
a code and continues what you were doing. Someone without a second step is returned to the sign-in
page instead. The interval is the session policy's `reauthIntervalMinutes` setting (1 to 1440),
and `reauthForAdminActions` turns the check off; both are changed with
`PUT /api/admin/security-policies/session`.

## Signed upstream MFA assertions

Business and higher tiers require admin MFA by default. Administrators can choose optional or
required MFA and independently configure sensitive-action MFA and second-admin approval under
**Admin → Security policies**. Helix supports native MFA enrollment and verification; a trusted
upstream authenticator is an optional alternative. Without one, leave the issuer and audience
unset: the Compose overlay fills in `https://$HELIX_DOMAIN` and `helix-workspace`, and
administrators satisfy the requirement by signing in with an authenticator app or passkey. See
[account handoff and admin safeguards](runbooks/account-offboarding-and-admin-safeguards.md)
for the effective-policy rules and safeguards on changing them.

When using upstream assertions, configure the exact producer identity and consumer identifier:

```dotenv
HELIX_MFA_ASSERTION_ISSUER=https://auth.example.com
HELIX_MFA_ASSERTION_AUDIENCE=helix-workspace
HELIX_MFA_ASSERTION_SECRET_FILE=/run/secrets/mfa_assertion_secret
```

The HMAC secret is dedicated to this contract, shared only by the upstream authenticator and Helix,
and contains at least 32 cryptographically random bytes. It must not be reused as the Better Auth
secret or any provider credential. Production startup rejects a missing, weak, known-development,
or partially configured assertion contract.

After completing an MFA challenge, the authenticator constructs this exact JSON object:

```json
{
  "v": 1,
  "iss": "https://auth.example.com",
  "aud": "helix-workspace",
  "sub": "authenticated-actor-id",
  "org": "authenticated-organization-id",
  "amr": "mfa",
  "iat": 1784908800,
  "exp": 1784908860
}
```

`iat` and `exp` are integer Unix seconds. Use a 60-second lifetime; Helix refuses an assertion
whose lifetime exceeds 300 seconds. Encode the UTF-8 JSON bytes without padding using base64url,
compute `HMAC-SHA256(secret, encodedClaims)`, encode the 32-byte MAC without padding using
base64url, and send `encodedClaims.encodedMac` in `X-Helix-Mfa-Assertion`. The producer must derive
`sub` and `org` from the same authenticated principal for which it completed the factor challenge,
not from client-supplied identity headers.

Helix verifies the MAC with a timing-safe comparison before parsing claims. It then requires the
exact version, issuer, audience, `amr=mfa`, authenticated actor ID, authenticated organization ID,
non-future issue time, unexpired expiry, positive lifetime, and maximum lifetime. Malformed,
repeated, tampered, future, expired, overlong, cross-actor, and cross-organization assertions fail
closed. `X-Helix-Mfa-Verified` has no authority and Caddy removes it before proxying. The signed
assertion is included in the central structured-log redaction policy; producers and intermediate
proxies must also redact it and must use TLS.

The version 1 assertion is an authentication-assurance credential, not a one-operation
authorization token. Reuse by the same authenticated actor during its short validity window is
intentional for a multi-request admin UI. Replay is bounded to at most five minutes and is useful
only alongside authentication that resolves to the signed actor and organization. A nonce store is
therefore not required for this MVP contract. If a future assertion authorizes an individual
high-risk action, add a versioned `jti` claim and atomically consume it in the shared Redis data
plane until `exp`; do not retrofit one-time consumption into version 1.

Rotate the dedicated secret during a coordinated authenticator and Helix deployment, invalidate
outstanding assertions, and verify new assertions before restoring admin traffic. Never log,
persist, or place a raw assertion in an incident ticket or release artifact.

## Required attestations

For the `business` tier, all three variables below must be explicitly set to `true`:

- `HELIX_POSTGRES_ENCRYPTION_AT_REST_ATTESTED`
- `HELIX_OBJECT_STORAGE_ENCRYPTION_AT_REST_ATTESTED`
- `HELIX_BACKUP_ENCRYPTION_AT_REST_ATTESTED`

Set an attestation only after recording provider/host evidence. PostgreSQL evidence must identify
encrypted volume/database storage. Object evidence must identify bucket/disk encryption and Helix
must set `RUSTFS_SERVER_SIDE_ENCRYPTION=AES256` or `aws:kms`. Backup evidence must identify
encryption, key custody, off-host location, and a successful decryption/restore drill. These flags
do not implement encryption; false attestations are a release-blocking operational defect.

Business production requires `MAIL_SPAMD_ENABLED=true`, `MAIL_CLAMAV_ENABLED=true`, and
`DRIVE_CLAMAV_ENABLED=true`, with reachable spamd and clamd services. A missing, failed, or timed
out Mail spam/antivirus scan and a missing, failed, or timed out Drive antivirus scan remain
fail-closed under the Mail and Drive quarantine policies.

## Validate before starting

Start from `.env.production.example`, set `HELIX_DOMAIN`, `HELIX_REGION`, and
`HELIX_DEFAULT_ORG_NAME`, provide the secret directory and every required promoted image reference
above, then resolve and inspect the merged configuration:

```sh
docker compose \
  --env-file .env.production \
  -f docker-compose.yml \
  -f docker-compose.production.yml \
  config
```

The command failing because a required input or secret file is absent is intentional. Never bypass
`assertProductionConfiguration`; it runs while validated environment configuration is first loaded,
before migrations, workers, or listeners.

Then run the static production Compose regression test:

```sh
pnpm exec vitest run infra/scripts/production-compose.test.mjs
```

To prove the whole path on a Docker host, boot a disposable copy of the production stack from this
checkout:

```sh
infra/scripts/production-boot-smoke.sh              # Caddy's internal CA at the edge
infra/scripts/production-boot-smoke.sh --tls files  # an operator-provided certificate
```

It generates secrets, runs one `docker compose up -d`, and checks HTTPS at the edge, the first
administrator's invitation, 2-step verification, an invitation email delivered over STARTTLS, and
a Drive upload, download, and malware rejection. It builds its images locally, publishes only on
`127.0.0.1`, uses its own Compose project and networks, and removes everything afterwards. It
needs about 8 GB of free memory and takes a few minutes after the first image build.

Run the disposable live data-plane drill on a Docker host before promotion:

```sh
node infra/scripts/data-plane-live-evidence.mjs --local
```

The drill generates isolated one-day test certificates and credentials, creates a uniquely named
Compose project, and removes its containers, network, volumes, and temporary secrets afterward. It
proves PostgreSQL rejects plaintext connections and separates schema migration from application
data privileges; Redis rejects plaintext and unauthenticated clients; NATS requires both mutual
TLS and application authentication and rejects subjects outside `helix.>`; and all three services
recover after a complete CA/server/client certificate rotation. Use `--static` only to validate the
evidence contract—it deliberately records every live scenario as `not_run`.

Write the live result directly into the release evidence packet and require it in the manifest:

```sh
evidence_dir="artifacts/release-readiness/$(date +%F)/$(git rev-parse HEAD)"
mkdir -p "$evidence_dir"

HELIX_DATA_PLANE_EVIDENCE_OUTPUT="$evidence_dir/data-plane-live-evidence.json" \
  node infra/scripts/data-plane-live-evidence.mjs --local

pnpm quality:release-readiness-manifest -- \
  --evidence-dir "$evidence_dir" \
  --data-plane-live-evidence data-plane-live-evidence.json \
  <application and web image digest options>
```

The gate requires `mode: "local"`, top-level `status: "passed"`, canonical ordered run
timestamps, and exactly the eight required scenarios with nonnegative measured durations. Static,
failed, extra, missing, or partially run scenarios are rejected. The manifest retains the total
and per-scenario timings while the validator rejects secret-bearing fields.

Retain the redacted resolved-config digest and encryption/scanner evidence in the release-readiness
artifact packet.

The resolved stack starts `helix-migrate` after Postgres is healthy and starts application replicas
only after that job exits successfully. The migrator uses the same reviewed image as the
application, serializes concurrent attempts with a Postgres advisory lock, and applies each
migration transactionally. Application startup independently rejects pending migrations. Never
disable `HELIX_STARTUP_MIGRATION_CHECK` during a rollout. Startup also rejects applied migration
names that are unknown to the running image, which prevents an older replica from serving against
a newer incompatible schema. For incompatible changes, ship expand/backfill/contract as separate
releases; destructive rollback is performed from a tested backup, not by ad-hoc down SQL.

Migration `0075` deliberately does not guess which organization owns a legacy mail domain. For an
existing single-organization installation, verify domain ownership and run the explicit,
idempotent one-record backfill after migrations:

```sh
pnpm --filter @helix/app db:backfill:mail-receiving-domain -- \
  --org-id <organization-uuid> \
  --domain example.com \
  --created-by <admin-actor-uuid> \
  --ownership-attested
```

Add `--catch-all-actor-id <actor-uuid>` only when that active actor belongs to the same
organization. The command refuses multi-tenant mode, malformed or missing identifiers, implicit
ownership, and bulk/first-organization behavior. Re-running the exact command returns the same
active receiving-domain record.
