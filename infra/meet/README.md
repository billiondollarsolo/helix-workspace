# Helix Meet Jitsi Stack

The local Compose stack below is for development. The reproducible multi-region
production topology, signed-image gate, capacity model, and failure drill are
documented in [`ha/`](ha/README.md).

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

## Media-plane trust and ICE

The Meet profile owns its STUN/TURN service. Prosody issues HMAC-derived TURN
credentials that expire after 10 minutes; no public Jitsi relay is used. P2P is
disabled so every call follows the managed JVB/TURN path. The internal
`meet-control` network has no external route, while `meet-media` is attached
only to JVB and Coturn. Coturn exposes authenticated TURN on 3478, TLS TURN on
5349, and the bounded relay range 49160-49200/UDP.

WebRTC media is accepted only through ICE + DTLS-SRTP on JVB's UDP media port.
There is no plaintext RTP listener or SIP gateway in this profile. The
validator keeps P2P disabled, the legacy TCP harvester disabled, remote ICE
hostname resolution disabled, and rejects any public Jitsi STUN dependency.

Meet secrets live under the ignored `.local/meet-secrets` directory by default,
or in the directory selected by `HELIX_MEET_SECRETS_DIR`. Production should
materialize the same six files from its secret manager:

```text
turn-shared-secret
turn.crt
turn.key
xmpp.crt
xmpp.key
xmpp-truststore.p12
```

The XMPP certificate must contain every configured XMPP domain and the service
DNS name (defaults: `meet.jitsi`, `auth.meet.jitsi`, `muc.meet.jitsi`,
`internal-muc.meet.jitsi`, and `jitsi-prosody`). `xmpp-truststore.p12`
contains only the issuing CA and uses the conventional non-secret truststore
password `changeit`. JVB, Jicofo, and Jibri all load it and fail closed on an
unknown issuer, expired certificate, or hostname mismatch. Generate a local
set without adding any key to Git. Production `turn.crt` must instead chain to
a browser-trusted public CA and match `JITSI_TURN_HOST`:

```sh
secrets_dir=.local/meet-secrets
install -d -m 700 "$secrets_dir"
openssl rand -hex 32 > "$secrets_dir/turn-shared-secret"
openssl req -x509 -newkey rsa:3072 -nodes -days 365 -subj /CN=helix-meet-ca \
  -keyout "$secrets_dir/ca.key" -out "$secrets_dir/ca.crt"
openssl req -newkey rsa:2048 -nodes -subj /CN=auth.meet.jitsi \
  -keyout "$secrets_dir/xmpp.key" -out "$secrets_dir/xmpp.csr"
printf 'subjectAltName=DNS:meet.jitsi,DNS:auth.meet.jitsi,DNS:muc.meet.jitsi,DNS:internal-muc.meet.jitsi,DNS:jitsi-prosody\n' > "$secrets_dir/xmpp.ext"
openssl x509 -req -days 90 -in "$secrets_dir/xmpp.csr" \
  -CA "$secrets_dir/ca.crt" -CAkey "$secrets_dir/ca.key" -CAcreateserial \
  -extfile "$secrets_dir/xmpp.ext" -out "$secrets_dir/xmpp.crt"
keytool -importcert -noprompt -alias helix-meet-ca -file "$secrets_dir/ca.crt" \
  -keystore "$secrets_dir/xmpp-truststore.p12" -storetype PKCS12 \
  -storepass changeit
openssl req -newkey rsa:2048 -nodes -subj /CN=turn.localhost \
  -keyout "$secrets_dir/turn.key" -out "$secrets_dir/turn.csr"
printf 'subjectAltName=DNS:turn.localhost\n' > "$secrets_dir/turn.ext"
openssl x509 -req -days 90 -in "$secrets_dir/turn.csr" \
  -CA "$secrets_dir/ca.crt" -CAkey "$secrets_dir/ca.key" -CAcreateserial \
  -extfile "$secrets_dir/turn.ext" -out "$secrets_dir/turn.crt"
chmod 600 "$secrets_dir"/*
```

For zero-downtime rotation, add the new CA to the truststore first, restart the
XMPP clients, replace the Prosody leaf, then remove the old CA. Rotate the TURN
shared secret on a second Coturn/Prosody pool, direct new sessions to it, and
drain the old pool for at least `TURN_TTL` (10 minutes).

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
MEET_JITSI_TOKEN_TTL_SECONDS=300
```

## Host-control enforcement

Helix is authoritative for the host, cohosts, lock/ban state, and participant
capabilities. Prosody's `token_affiliation` module grants moderator affiliation
only when a Helix-signed JWT says so; automatic first-participant ownership and
Jicofo's unchecked moderator path are disabled. Lobby membership, room
passwords, kick/admit, group-chat filtering, and audio/video/desktop moderation
are enforced in Prosody/Jicofo rather than trusted to toolbar visibility.

Every control first mutates `meet_rooms` and appends an immutable
`meet_control_events` row. The authorized host client then executes the returned
Jitsi command. Ban and lock state is also checked whenever Helix mints a join
grant, so a removed participant cannot obtain a fresh token. A host transfer is
atomic: the target becomes host and the prior host becomes cohost in the same
locked row update, ensuring the meeting is never left without a host.

`MEET_JITSI_WEBHOOK_SHARED_SECRET` is reserved for `/webhook/jitsi` validation.
The compose defaults are suitable only for repeatable local tests; override every
secret outside local development.

## Recording Storage

Jibri always uses Helix's tenant-bound prepare path. Configure the organization
whose rooms this recorder serves:

```sh
HELIX_JITSI_ORG_ID=<org-id>
```

Production upload shape:

1. Jibri signs the exact request body with a timestamped HMAC and calls Helix's
   internal prepare endpoint with the organization and room name in that body.
2. Helix resolves tenant storage and returns a presigned PUT URL, required
   signed request headers, a random upload capability, and the logical
   `storageKey`.
3. Jibri uploads bytes to that URL with every returned header. BYO storage with
   metadata or SSE-KMS depends on these headers matching the signed request.
4. Jibri signs a completion body containing only the upload capability. Helix
   derives the tenant, room, key, and expected media metadata from prepared
   server state, validates the stored bytes, and attaches the recording.

Prepare, upload, or completion failure stops finalization; there is no
cross-tenant direct-bucket fallback.

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

## Real media release gate

MEET-17 is an explicit live-cluster gate, separate from the mocked Playwright
suite. It creates a fresh room through Helix, launches two isolated Chromium
processes with synthetic camera and microphone devices, forces each WebRTC peer
connection to `iceTransportPolicy=relay`, and fails unless both clients send and
receive non-zero audio and video through selected TURN relay candidates. It also
proves reconnect, rejects an attendee's forged server and Jitsi moderator
commands, applies a server-authorized host mute, records through Jibri, waits for
the signed completion webhook, downloads the stored MP4, and recomputes its
SHA-256 and byte size. Only a fully successful run writes `evidence.json`; join
URLs, OAuth credentials, and the webhook secret are never included.

Run it with:

```sh
HELIX_MEET_LIVE_API_URL=https://workspace.example.com \
HELIX_MEET_LIVE_HOST_CLIENT_ID=meet-gate-host \
HELIX_MEET_LIVE_HOST_CLIENT_SECRET=... \
HELIX_MEET_LIVE_HOST_ACTOR_ID=... \
HELIX_MEET_LIVE_ATTENDEE_CLIENT_ID=meet-gate-attendee \
HELIX_MEET_LIVE_ATTENDEE_CLIENT_SECRET=... \
HELIX_MEET_LIVE_ATTENDEE_ACTOR_ID=... \
HELIX_MEET_LIVE_WEBHOOK_SECRET=... \
pnpm quality:meet-live-media
```

The two OAuth clients must belong to active actors in the same tenant and allow
`meet.read`, `meet.write`, and `drive.read`. The deployment must have valid
public TLS, owned TURN, JVB, Jibri, tenant recording storage, and the same
webhook secret configured. The nightly/manual GitHub workflow reads these
values from the protected `meet-live` environment. Missing prerequisites fail
the run rather than skipping it. The ordinary E2E workflow deliberately ignores
this spec so a mocked result cannot be mistaken for media evidence.
