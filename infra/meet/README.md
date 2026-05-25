# Helix Meet Jitsi Stack

This directory holds local/dev infrastructure notes for `com.helix.core.meet-jitsi`.

The root compose file exposes the Jitsi stack behind the `meet` profile:

```sh
docker compose --profile meet config
docker compose --profile meet up -d jitsi-web
docker compose --profile meet down
```

Static validation does not require Docker or network access:

```sh
pnpm infra:meet:validate
```

Default dev host ports continue the Helix high-port block:

| Service           | Container port | Host env                  | Default |
| ----------------- | -------------: | ------------------------- | ------: |
| Jitsi web HTTP    |         80/tcp | `JITSI_WEB_HTTP_PORT`     |   28451 |
| Jitsi web HTTPS   |        443/tcp | `JITSI_WEB_HTTPS_PORT`    |   28452 |
| JVB media         |      10000/udp | `JITSI_JVB_UDP_PORT`      |   28453 |
| Prosody XMPP      |       5222/tcp | `JITSI_PROSODY_C2S_PORT`  |   28454 |
| Prosody HTTP/BOSH |       5280/tcp | `JITSI_PROSODY_HTTP_PORT` |   28455 |

For local browser testing, use a `meet.<domain>` name that resolves to the Docker
host. The default is `meet.localhost`:

```sh
MEET_JITSI_DOMAIN=meet.localhost
MEET_JITSI_PUBLIC_URL=https://meet.localhost:28452
```

For a real dev/test domain, set both values explicitly:

```sh
HELIX_DOMAIN=helix.example.test
MEET_JITSI_DOMAIN=meet.helix.example.test
MEET_JITSI_PUBLIC_URL=https://meet.helix.example.test:28452
```

JWT auth is enabled for Prosody. Helix should mint actor-session tokens with the
same app id, issuer, audience, and shared secret passed to the Jitsi containers:

```sh
MEET_JITSI_JWT_APP_ID=helix-meet
MEET_JITSI_JWT_ISSUER=helix
MEET_JITSI_JWT_AUDIENCE=jitsi
MEET_JITSI_JWT_SECRET=replace-with-a-long-random-secret
MEET_JITSI_TOKEN_TTL_SECONDS=3600
```

`MEET_JITSI_WEBHOOK_SHARED_SECRET` is reserved for `/webhook/jitsi` validation.
The compose defaults are suitable only for repeatable local tests; override every
secret outside local development.

## Recording Storage

By default, Jibri `finalize.sh` still uploads directly to the configured
RustFS/S3 bucket, then posts `/webhook/jitsi` with the logical `storageKey`.
That keeps local single-bucket development backwards compatible.

For BYO or tenant-resolved recording storage deployments, enable and require the
prepare path:

```sh
HELIX_JITSI_ORG_ID=<org-id>
HELIX_JITSI_PREPARE_UPLOAD=true
HELIX_JITSI_PREPARE_REQUIRED=true
```

`HELIX_JITSI_PREPARE_URL` can override the default
`${HELIX_INTERNAL_URL}/internal/meet/recording-uploads`.
The non-required RustFS/S3 fallback is local single-bucket dev compatibility
only. It must not be used for BYO because failures would otherwise allow a Drive
recording row to be posted without bytes in the tenant-resolved bucket.

Production upload shape:

1. Jibri calls an internal Helix prepare endpoint with `X-Helix-Jitsi-Secret`
   and `X-Helix-Org-Id`.
2. Helix resolves tenant storage and returns a presigned PUT URL, required
   signed request headers, and the logical `storageKey`.
3. Jibri uploads bytes to that URL with every returned header. BYO storage with
   metadata or SSE-KMS depends on these headers matching the signed request.
4. Jibri posts `/webhook/jitsi` with the same `storageKey`, timestamps, hashes,
   and upload metadata so Helix attaches the recording to the room.

If prepare is enabled but not required, `finalize.sh` falls back to the RustFS/S3
path on prepare or upload failure and still posts the webhook with
`metadata.uploaded = false` when no byte upload succeeded. Required mode exits
before the webhook if the prepare/upload step fails.

After the API is running with a seeded OAuth client, the live backend Meet smoke
can validate the room/tool/webhook contract without a browser media session:

```sh
HELIX_SMOKE_CLIENT_ID=helix-local-oauth-client \
HELIX_SMOKE_CLIENT_SECRET=helix-local-dev-secret \
  pnpm quality:live-auth-smoke -- --meet-smoke
```

Set `HELIX_SMOKE_MEET_JITSI_DOMAIN`, `HELIX_SMOKE_MEET_WEBHOOK_SECRET`, or
`HELIX_SMOKE_MEET_ORG_ID` when testing a non-default domain, webhook secret, or
organization id. The remaining release proof for Meet is browser/media
interoperability against the composed Jitsi iframe and real auth session.
