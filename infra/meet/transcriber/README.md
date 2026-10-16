# Meet speech model routing

Build from the repository root:

```sh
docker build -f infra/meet/transcriber/Dockerfile -t helix/meet-transcriber:model-routing .
```

The pinned Jitsi proxy handles Opus decoding and realtime speech recognition. The
small patch passes a validated per-session `model` to the backend on initial
connection and reconnect. Its Docker build runs the upstream parser, connection,
and OpenAI backend tests, including per-session model isolation. Do not substitute
the unpatched upstream image: it ignores Helix's model selection.

Keep this service private to the Meet network. Configure
`ENABLE_OPENAI_CUSTOM_PROVIDER=true`; do not install a shared provider API key or
fallback provider. Helix supplies the selected tenant credentials per connection,
only after checking the feature flag and host's transcription request. Disable
speech/audio dumps, transcript debug logging, translation, and dispatcher output.

`MEET_TRANSCRIPTION_PROXY_URL` points Helix at the private service.
`MEET_TRANSCRIPTION_ALLOWED_HOSTS` is a comma-separated deployment allowlist of
speech API hostnames; its default is `api.openai.com`. Providers use an HTTPS base
URL without credentials, query, fragment, or custom port. The gateway derives
`wss://<host>/<base-path>/realtime?intent=transcription`. Restrict the proxy's network
egress to those services as well; the native proxy does not pin DNS or enforce
Helix's HTTP egress policy itself. A self-hosted endpoint must implement the same
realtime speech protocol. Sovereign/local-only mode remains disabled pending
qualification of a local speech deployment.

In Admin → Assistant → Models, add the speech provider, its speech model IDs and
write-only key. Mark **Supports realtime speech transcription**, then assign
**Meeting transcription**. This declaration is not a connectivity test: a chat
completions endpoint alone cannot process realtime audio. Other native speech
protocols (such as Deepgram) need their own credential adapter before Helix can
route to them; selecting their chat endpoint does not provide that adapter.

Assign **Meeting summaries** separately to any configured text provider supported
by Helix. It uses the existing AI router, classification controls and cost limits.
In Admin → Meet, enable **Speech transcription** and/or **AI meeting recaps**.
Both default off and require explicit feature routes. Enabling recaps alone does
not capture audio. A host still starts transcription and participants must consent.
Changing providers affects subsequent captures; disabling transcription stops an
active capture on its next authorization check (up to ten seconds).

The capture deployment, recording lifecycle, storage migration and end-to-end
media qualification must be completed before this service is enabled. This image
build and its protocol tests do not validate real provider credentials or pricing.
