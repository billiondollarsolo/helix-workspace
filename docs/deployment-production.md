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

The overlay enables the existing WORM-Postgres audit destination so the Business tier starts with
an enforced audit sink and removes the development immutable-S3 credentials. This is a bootstrap
control, not the final off-host assurance gate: configure and prove immutable off-host audit
shipping before the private pilot.

## Secret files

Create a root/operator-owned directory outside source control, mode `0700`, containing these
non-empty files with mode `0600`:

| File                           | Content                                                        |
| ------------------------------ | -------------------------------------------------------------- |
| `database_url`                 | Complete Postgres URL with the production password URL-encoded |
| `postgres_password`            | The corresponding Postgres role password                       |
| `better_auth_secret`           | Random Better Auth secret                                      |
| `rustfs_access_key`            | Random object-store access identifier                          |
| `rustfs_secret_key`            | Random object-store secret                                     |
| `meili_master_key`             | Random Meilisearch master key                                  |
| `mail_smtp_password`           | Managed provider SMTP/API credential                           |
| `mail_provider_webhook_secret` | Managed provider event-signing secret                          |

Secret values must contain at least 32 characters and at least 12 distinct characters. Generate
independent values from a cryptographically secure random source. Do not reuse credentials between
services. `database_url` and `postgres_password` necessarily encode the same database password,
but they remain separate mounts because the Postgres image consumes a password file while Helix
consumes an entire connection URL.

Set `HELIX_PRODUCTION_SECRETS_DIR` to the absolute host directory before resolving or starting the
stack. Helix supports only its documented `*_FILE` allowlist. It rejects simultaneous inline and
file-backed values, non-absolute paths, empty/non-regular files, and files larger than 64 KiB.
Diagnostics identify the affected variable without printing the path or secret.

For Kubernetes or another orchestrator, mount equivalent secret-manager/CSI files and set the
corresponding `*_FILE` variables. Do not render secrets into a Compose file, image layer, command
line, CI artifact, or application log.

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

Retain the redacted resolved-config digest and encryption/scanner evidence in the release-readiness
artifact packet.
