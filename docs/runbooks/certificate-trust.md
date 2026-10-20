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
Native API, web and Bot units, and hosted recovery workers, use systemd drop-ins:

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
Explicit custom CA bundles must be reviewed separately. This rollout covers the
core API/web/Bot images, their native processes and hosted recovery workers; it is
not a qualification of all optional third-party service images, old worker
containers, independently installed model CLIs, or desktop browsers.

Private build logs, encrypted checkpoint and verification receipts are retained at
`~/.local/share/helix-changes/20261020-ca-incident/`; hosted artifacts are under
`/srv/helix/ca-incident-20261020/`. The trust change does not migrate application data.
