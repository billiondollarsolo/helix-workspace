# Production deployment configuration

Helix production startup fails closed when credentials or required Business-tier controls are
missing. This guide covers the Docker Compose production overlay. It is not a substitute for the
backup, restore, monitoring, or pilot gates in the production-readiness plan.

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

The overlay builds two targets from `infra/docker/Dockerfile`: the Helix API/worker runtime and a
non-root Caddy edge containing the compiled web client. The web edge serves the SPA and proxies
only explicit API, OAuth, MCP, realtime, WebDAV, and discovery paths to Helix. The production web
shell advertises Mail, Drive, Chat, Assistant, and Admin; Docs, Sheets, Slides, Calendar, Meet, and
native Editors are disabled for this MVP.

The paired `../helix-editors` checkout is supplied as a BuildKit named context solely to build the
repository's existing file-linked package boundary reproducibly. `HELIX_EDITORS_MIGRATIONS_ENABLED`
is false, the Editors core app is disabled, and no native editor implementation is enabled. For
standalone builds, use:

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

Both final images run as fixed UID/GID `10001`. The application payload is limited by its package
manifest to compiled output and production dependencies; it includes compiled database migrations
but no source tree, package-manager cache, or source-control metadata. Promotion must pin all base
images and both resulting application images by digest and record those digests in the
release-readiness manifest.

After building, execute the same runtime contract used by CI:

```sh
node infra/scripts/validate-production-images.mjs \
  --application-image helix/workspace:production \
  --web-image helix/workspace-web:production
```

The check inspects both image configurations and then runs their payload assertions with a
read-only root filesystem and no network. It requires UID/GID `10001`, the expected entrypoints and
health checks, compiled migrations and SPA assets, a valid Caddy configuration, and rejects source,
source-control, environment, and package-manager-cache payloads.

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

Business production also requires both `MAIL_CLAMAV_ENABLED=true` and
`DRIVE_CLAMAV_ENABLED=true`, with a reachable clamd host. Scanner errors and timeouts remain
fail-closed under the Mail and Drive quarantine policies.

## Validate before starting

Start from `.env.production.example`, provide the secret directory, then resolve and inspect the
merged configuration:

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
