# Certificate trust: eMudhra incident, 2026-10-20

The [incident report](https://emudhra.we-have-a-problem.com/) describes eight
compromised intermediate keys. Helix's public certificates use Let's Encrypt;
the exposure was outbound certificate verification, including model/provider calls.
The pre-change native Node 24.15/24.18 and hosted Node 24.15/24.21 runtimes accepted
the published DV-G3B test chain.

## Mitigation

The main Dockerfile removes `emSign_ECC_Root_CA_-_G3` and
`Comodo_AAA_Services_root` from the distribution trust configuration, regenerates
its bundle, and makes Node use OpenSSL's store with `--use-openssl-ca`.
`SSL_CERT_FILE` selects that bundle and `SSL_CERT_DIR` selects an empty directory
so alternate hashed certificate paths cannot restore the distrusted roots.
Workspace's distroless API and Alpine edge copy the protected bundle explicitly.
The existing private RustFS CA remains in `NODE_EXTRA_CA_CERTS`.
Caddy is rebuilt with Go 1.26.10.

Native Ubuntu 24.04 uses ca-certificates 20260816ubuntu0.24.04.1. The hosted
Ubuntu 26.04 mirror still lacked its fixed package after refreshing indexes;
its `/etc/ca-certificates.conf` instead disables the same two root entries.
Native API, web and Agentspace units, and hosted recovery workers, use systemd drop-ins:

```ini
[Service]
Environment="NODE_OPTIONS=--use-openssl-ca"
Environment="SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt"
Environment="SSL_CERT_DIR=/etc/ssl/helix-empty"
```

Create the empty directory and preserve other required Node options when applying
these settings elsewhere. Restart processes after changing trust so existing TLS
sessions cannot retain previous verification results. Do not overwrite private CAs,
turn off certificate validation, or treat a host package update as protection for
Node's default bundled roots.

## Verification and retirement

For a release, test all 12 incident chains through both Node `https` and `fetch`,
and through Caddy's HTTPS upstream transport. Require certificate-specific failures;
a timeout or DNS failure is not evidence of distrust. Also require successful
normal HTTPS controls, live readiness, fresh federation directory synchronization,
and the private storage TLS health check. Keep probes isolated and unauthenticated.

[Node's upstream fix](https://github.com/nodejs/node/pull/66871) blocks the eight
intermediate public keys. It was merged but not present in a released Node 24
runtime at qualification. Replace the broad root workaround only after qualifying
an upstream fixed runtime with the same negative and positive controls.

This mitigation can reject legitimate sites whose only chain uses a removed root.
Explicit custom CA bundles must be reviewed separately. The first rollout covered
the core API/web/Agentspace images, native processes and hosted recovery workers. The
follow-up below extends that coverage.

Private build logs, encrypted checkpoint and verification receipts are retained at
`~/.local/share/helix-changes/20261020-ca-incident/`; hosted artifacts are under
`/srv/helix/ca-incident-20261020/`. The trust change does not migrate application data.

## Qualified deployment

Workspace API and edge images `ca-42fde1e` and Agentspace image `ca-b31dba4` were
deployed. All required repository checks passed: Workspace's backend had 4,046
passing tests and 450 gated skips; its web app had 1,453 passing tests. Both native
Node versions, both hosted APIs and both recovery workers rejected all 12 published
chains through `https` and `fetch`, with four successful HTTPS controls each. The
deployed Caddy image rejected all 12 upstream chains and passed its positive control.
Private RustFS TLS returned ready, federation synchronization was fresh, and both
public readiness endpoints passed. No schema or model-account configuration changed.

The first rollout automatically reverted after a whole-row invariant mismatch.
That attempt did not save field-level snapshots, so the changed field was not
identified. Authentication can update credential usage timestamps, but that is not
a confirmed diagnosis of the first mismatch. The retry recorded every guarded
column and passed with zero differences, including timestamps. The strict
all-fields comparison remains in the deployment helper. An encrypted post-change
checkpoint includes current source bundles, configuration, host CA policy and
recovery-worker trust drop-ins; it was authenticated off-server.

## Remaining services and clients

The follow-up replaced 16 hosted supporting images and 14 native supporting/test
containers with qualified derived images. This includes PostgreSQL, Cerbos, NATS,
Redis, RustFS, Meilisearch, ClamAV, spam filtering, inbound mail, Vaultwarden, Meet,
and native PDF/executor services where deployed. Derived images preserve their
application versions and filter the incident public-key hashes from their trust
bundles. Node images explicitly select the filtered OpenSSL store. Jicofo/JVB's
public Java trust stores were filtered separately; the private XMPP trust store
has one unaffected certificate and was retained. Eight pre-consolidation workers
were stopped with restart disabled; their data remains available for recovery.

Meilisearch 1.51.0 embeds certificate verification code, so a bundle replacement
alone was insufficient. `infra/meilisearch/Dockerfile` rebuilds that version with
`rustls-webpki` 0.103.16 and `webpki-roots` 1.0.10. The actual REST embedder rejected
all 12 chains with `CertDistrusted` and reached OpenAI's normal authentication
response without credentials. Image `helix/meilisearch:ca-compiled-20261020` is
running in both environments. Hosted index statistics were unchanged (25 documents).
Native search had previously stored `/data.ms` in its disposable container layer;
the derived index was rebuilt from PostgreSQL, then copied into its existing
volume with `MEILI_DB_PATH=/meili_data/data.ms`. Its 124 documents survived the
subsequent patched-binary replacement.

Native installed clients are also qualified:

- Claude 2.1.305 and uv 0.13.4 reject every incident chain. The paired Local Claude
  service retains its qualified 2.1.300 pin, now with all three trust environment
  variables forwarded through the assistant subprocess. `SSL_CERT_FILE` alone
  did not protect that version.
- Codex 0.163.0 was rebuilt from its upstream tag with the same two Rust security
  dependency updates. Both standalone and app-server package links select the
  local GNU build; helpers, login and configuration are retained. The CLI rejects
  all 12 endpoints, its shared rustls HTTP client reports `CertDistrusted`, normal
  OpenAI TLS succeeds, and app-server initialization passes. The CLI itself
  redacts the underlying certificate error; the library probe records the cause.
- Bun stable 1.4.3 still accepted the chains. The installed binary is pinned to
  checksum-verified 1.4.4-canary.1+ea6a2c7b7, which rejects all 12 through `https`
  and `fetch` in its default configuration and passes four normal HTTPS controls.
  Replace this canary only with a stable release that passes the same checks.
- Chromium NSS explicitly distrusts all four incident roots (`p,p,p`). Fresh
  Preview navigation rejects all 12 with `ERR_CERT_AUTHORITY_INVALID` and reaches
  normal Workspace/OpenAI HTTPS. The maintained Agentspace browser image applies the
  same policy. Restart T3 and other already-running browsers/Codex sessions after
  this turn; updating files does not replace their loaded trust or executable.

All required Workspace checks passed. Agentspace static checks, typecheck, build,
contracts, recovery and portability checks passed. Its initial unit run had two
integration timeouts during concurrent builds; the final focused rerun passed all
10 tests, including image/PDF grants, revocation and assistant environment filtering.
The full unit suite was not repeated after that focused rerun.

The supporting-service deployment passed strict all-column account, credential,
grant and membership invariants with zero differences. An initial Compose attempt
rolled back because `pull_policy: always` tried to pull local protected tags;
those services now use `never`. Native recreation preserved the original root user
where image defaults differed and corrected Cerbos's moved bind paths. The compiled
search deployment also rolled back once because Cloudflare returned 403 to Python's
health request; the corrected curl readiness check passed without index changes.

## Recovery and remaining limits

Follow-up receipts, encrypted database/configuration checkpoints and an encrypted
export of all qualified hosted supporting images are retained under
`~/.local/share/helix-changes/20261020-ca-followup/`. Hosted recipes, source bundles
and receipts are under `/srv/helix/ca-followup-20261020/`. Image tags are local to
these Docker daemons, not published to a registry: load the authenticated image
export before using restored Compose/operator configuration. The native canonical checkout
has a locally excluded `docker-compose.override.yml` selecting its eight active
protected images and persistent Meilisearch path; a copy is in the recovery folder.
Keep the previous
core-image checkpoint as well. Checkpoints were authenticated off-server; this
follow-up did not perform a destructive full restore.

This does not qualify other computers, every optional RustFS notification client,
or bundled agents inside the stopped workers. RustFS's configured clients use the
filtered platform store; Kafka/Pulsar/MySQL notification paths were not configured
or exercised. Rebuild and qualify retired workers' bundled model CLIs before
reactivation. Updaters can replace patched Codex/Bun binaries: requalify replacements.
The broad root workaround can also reject legitimate sites using those roots.
