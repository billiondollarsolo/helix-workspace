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
