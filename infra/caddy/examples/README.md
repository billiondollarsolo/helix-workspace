# Caddy Examples

- `tier2-upstream-mtls.Caddyfile` shows the TASK-A00 / Tier 2 pattern: public TLS at Caddy and mTLS from Caddy to the Helix upstream.

Use the example as a deployment overlay, not as a development replacement for `infra/caddy/Caddyfile`.

Validate the hardening contract without Docker:

```sh
pnpm infra:caddy:validate
```

The validator enforces edge TLS, upstream HTTPS, trusted upstream CA, SNI, client certificate authentication, and strict request security headers. If the `caddy` binary is installed locally, it also runs `caddy validate --adapter caddyfile`.
