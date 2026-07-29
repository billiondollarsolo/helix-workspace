# Production deployment configuration

Helix production startup fails closed when credentials or required Business-tier controls are
missing. This guide covers the Docker Compose production overlay. It is not a substitute for the
backup, restore, monitoring, or pilot gates in the production-readiness plan.

Production promotion requires the revision-bound eight-gate manifest described in
[`final-release-readiness.md`](./final-release-readiness.md). Ordinary manifests and CI contract
tests are preflight evidence only.

## Public surface

Apply `docker-compose.production.yml` after the development Compose file. The resolved production
stack publishes only:

- Caddy HTTP and HTTPS (TCP 80, TCP/UDP 443 by default); and
- the explicitly selected inbound SMTP port (TCP 25 by default).

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
paths to Helix. The production web shell advertises Mail, Drive, Chat, Assistant, and Admin; Docs,
Sheets, Slides, Calendar, Meet, and native Editors are disabled for this MVP.

The storage-only web contract also guards direct URLs for Docs, Sheets, Slides, Calendar, Meet, and
the native PDF surface. Opening a PDF from Drive uses the read-only raw preview endpoint; PDF form
draft tools are not registered. The right-side mini-app rail, editor-specific settings, prompts,
and notifications are removed or safely rerouted in this build. These controls are
defense-in-depth around server-side module and tool registration, not the primary authorization
boundary.

The paired `../helix-editors` checkout is supplied as a BuildKit named context solely to build the
repository's existing file-linked package boundary reproducibly. `HELIX_EDITORS_MIGRATIONS_ENABLED`
is false, the Editors core app is disabled, and no native editor implementation is enabled. For
a local review build that will later be scanned, signed, pushed, and selected by digest, use:

```sh
docker buildx build \
  --build-context helix_editors=../helix-editors \
  -f infra/docker/Dockerfile \
  --target runtime \
  -t helix/workspace:production .

docker buildx build \
  --build-context helix_editors=../helix-editors \
  -f infra/docker/Dockerfile \
  --target web-runtime \
  -t helix/workspace-web:production .
```

Both the application service and the one-shot `helix-migrate` job explicitly set
`HELIX_EDITORS_MIGRATIONS_ENABLED=false`. The migrator resolves migration sources from its own
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

The pinned Redis, RustFS, and ClamAV references remain checked into the base Compose file. The
resolved production-config evidence must capture all ten active digests and the final release
packet must bind each digest to its scan and SBOM.

The checked-in stack also fixes the complete active dependency inventory: PostgreSQL 18.4 with
pgvector 0.8.5, Redis 8.8.1, NATS 2.14.3, Meilisearch 1.51.0, RustFS 1.0.0-beta.11, Cerbos
0.54.0, SpamAssassin 4.0.2, and ClamAV 1.5.3. Registry images use immutable manifest digests.
Helix-built dependency images use digest-pinned build/runtime bases, immutable source revisions,
and verified source archives. CI builds or pulls every one of these images, produces an SPDX SBOM,
runs a fail-closed High/Critical Trivy scan, and retains the machine-readable result. No locally
built image is pushed until both application scans and all eight dependency scans succeed. The
publication job loads checksummed archives exported by the scan jobs, verifies their source
revision and image IDs, and publishes those exact images without rebuilding. Redis, RustFS, and
ClamAV remain digest-pinned pull-and-scan inputs and are not republished by Helix. A release packet
must bind the exact resolved image digests—not merely these human-readable tags—to its corresponding
scan and SBOM. The official ClamAV 1.5.3 container is amd64-only, so this Compose deployment targets
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
3. Start PostgreSQL 18.4 with pgvector 0.8.5 against a new empty volume. Restore globals first,
   restore the application database, and run `ALTER EXTENSION vector UPDATE TO '0.8.5'`.
4. Run every Helix migration, the migration compatibility check, tenant-isolation tests, row-count
   and checksum sampling, a full search reindex, and the live data-plane smoke.
5. Keep the PostgreSQL 17 snapshot read-only until the release rollback window closes. Rollback is
   restore-based; a PostgreSQL 18 data directory must never be attached to PostgreSQL 17.

Record the source and target versions, backup hashes, restore duration, verification results, and
the exact promoted image digest in the release packet.

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

The overlay enables the existing WORM-Postgres audit destination so the Business tier starts with
an enforced audit sink and removes the development immutable-S3 credentials. This is a bootstrap
control, not the final off-host assurance gate: configure and prove immutable off-host audit
shipping before the private pilot.

## Secret files

Create a root/operator-owned directory outside source control, mode `0700`, containing these
non-empty files with mode `0600`:

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
| `meili_master_key`             | Random Meilisearch master key            |
| `mail_smtp_password`           | Managed provider SMTP/API credential     |
| `mail_provider_webhook_secret` | Managed provider event-signing secret    |

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

## Signed upstream MFA assertions

Business and higher tiers reject every admin-scoped request unless the authenticated actor also
presents a valid MFA assurance assertion. Helix does not currently run a native MFA enrollment or
challenge flow. A trusted upstream authenticator is therefore a required deployment dependency for
Business admin access; do not weaken or bypass the gate when that producer is unavailable.

Configure the exact producer identity and consumer identifier:

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

Start from `.env.production.example`, provide the secret directory and every required promoted
image reference above, then resolve and inspect the merged configuration:

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
