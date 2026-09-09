# Agent live evidence

`pnpm quality:agent-live-evidence` is the opt-in A7 real-stack smoke. It writes
`helix.agent-live-evidence.v1` JSON for the release evidence bundle.

The command has deliberately separate modes:

- `--static` validates the report contract and records every live scenario as `not_run`.
- `--live` uses real OAuth credentials and a reachable Helix stack. Missing configuration,
  unavailable services, or a failed assertion produce `failed` evidence and a non-zero exit.
- `--validate <report.json>` validates an existing report without contacting Helix.

Static output is useful for checking CI wiring, but it is never accepted as live release evidence.

## Dedicated live fixture

Use a disposable organization and OAuth client. The client must have exactly:

```text
mail.read drive.read chat.read chat.post
```

Do not grant `mail.send`, Drive write scopes, admin scopes, or wildcard scopes. Prepare:

- one Mail thread, Drive object, and Chat room the agent may read;
- three direct URI guesses for resources the agent must not read, preferably covering Mail, Drive,
  and Chat in another tenant or outside its memberships;
- one pre-seeded prompt-injection fixture in each of Mail, Drive, and Chat;
- one human session that owns the credential and can approve its pending Chat action;
- one separate administrator session with `admin.agents` and `admin.audit`;
- `chat.send` JSON targeting the dedicated room;
- valid `mail.send` JSON targeting a test address. It is submitted only as a forbidden call and
  the smoke fails if it reaches execution.

The smoke sends one unique Chat marker and revokes the supplied OAuth client. Never point it at a
production credential or room.

## Run

```sh
evidence_dir="artifacts/release-readiness/$(date +%F)/$(git rev-parse HEAD)"
mkdir -p "$evidence_dir"

HELIX_BASE_URL=http://127.0.0.1:28431 \
HELIX_AGENT_LIVE_CLIENT_ID=<dedicated-client-id> \
HELIX_AGENT_LIVE_CLIENT_SECRET=<one-time-test-secret> \
HELIX_AGENT_LIVE_HUMAN_TOKEN=<credential-owner-session-token> \
HELIX_AGENT_LIVE_ADMIN_TOKEN=<agent-and-audit-admin-token> \
HELIX_AGENT_LIVE_RESOURCE_URIS='{"mail":"helix://mail/thread/<id>","drive":"helix://drive/object/<id>","chat":"helix://chat/room/<id>"}' \
HELIX_AGENT_LIVE_FORBIDDEN_URIS='["helix://mail/thread/<forbidden>","helix://drive/object/<forbidden>","helix://chat/room/<forbidden>"]' \
HELIX_AGENT_LIVE_INJECTION_URIS='{"mail":"helix://mail/thread/<fixture>","drive":"helix://drive/object/<fixture>","chat":"helix://chat/room/<fixture>"}' \
HELIX_AGENT_LIVE_CHAT_SEND_INPUT='{"roomId":"<uuid>","body":"replaced-by-smoke","bodyFormat":"plain","attachmentObjectIds":[],"metadata":{}}' \
HELIX_AGENT_LIVE_MAIL_SEND_INPUT='{"to":["agent-live-denied@example.test"],"cc":[],"bcc":[],"subject":"must-not-send","bodyText":"must-not-send","attachments":[]}' \
HELIX_AGENT_LIVE_OUTPUT="$evidence_dir/agent-live-evidence.json" \
  pnpm quality:agent-live-evidence -- --live
```

`HELIX_AGENT_LIVE_ACCESS_TOKEN` may skip minting when the access token was created separately.
Client ID and secret remain required so the smoke can introspect the supplied token, prove its
exact scopes, and revoke that credential.

The report contains only status, counts, error codes, timestamps, scope names, and one-way
identifier hashes. Its validator rejects fields named for tokens, secrets, passwords,
authorization values, URIs, message bodies, subjects, or raw content.

## Release gate

Validate the report directly:

```sh
pnpm quality:agent-live-evidence -- --validate "$evidence_dir/agent-live-evidence.json"
```

Then require it in the release manifest:

```sh
pnpm quality:release-readiness-manifest -- \
  --evidence-dir "$evidence_dir" \
  --agent-live-evidence agent-live-evidence.json \
  <application and web image digest options>
```

The manifest fails closed unless the top-level status and all eight A7 scenarios are `passed`.
`static_validated`, `not_run`, and `failed` reports remain useful diagnostic artifacts but cannot
satisfy this gate.
