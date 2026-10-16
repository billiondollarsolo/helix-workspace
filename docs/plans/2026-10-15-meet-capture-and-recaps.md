# Meet lifecycle, recording and AI recaps

User authorized implementation and live development qualification on 2026-10-15.
Preserve participant consent, tenant/actor authorization, scanning, audit and retention.

- [x] Fix desktop grid placement and retain meeting code in the browser URL.
- [x] Remove visible upstream meeting branding through supported configuration.
- [ ] Deploy and verify the UI fixes.
- [ ] Emit authenticated participant/conference events from Prosody, carrying only
      server-verified Workspace identity. Persist retries and keep stable event IDs.
- [ ] Verify last-person departure, duplicate events, reconnect and unauthorized events.
- [ ] Deploy a healthy Jibri recorder with existing secret, trust and upload helpers.
- [ ] Record a real consented test meeting, upload, scan and retrieve its bytes.
- [ ] Add optional transcription and AI recaps using configured providers and bounded
      jobs, with source authorization, cost limits, explicit error/retry states and
      no automatic external actions from meeting content.
- [ ] Show recording, transcript and recap status/content in the existing Meet UI;
      expose the same authorized operations through the shared tool registry.
- [ ] Validate real transcription/summary, negative access, deletion and restart cases.
- [ ] Run focused tests, browser/accessibility checks and required repository checks.

Recording infrastructure and AI processing are separate administrator capabilities.
No placeholder transcript, fabricated summary or simulated recording counts as live proof.

## Native transcription and artifact delivery

Use Jitsi's bridge-based transcription service, not the deprecated Jigasi path.
The installed Jicofo selector includes the transcription URL/header configuration.
Configure a pinned upstream proxy on a private network and authorize capture before
forwarding audio. Captions/transcription do not require a video recording.

The meeting owner owns the recording, transcript and recap in Drive. Send actual
attendees a completion email with authenticated, permission-controlled links;
do not distribute public links or raw transcript attachments by default. Check
access again on every read. External guest delivery requires a verified identity
and an authorized sharing path. Preserve consent, scanning, retention and deletion.

Acceptance includes failed provider requests, disabled capabilities, interrupted
capture, duplicate completion/delivery, owner versus attendee access, other-tenant
denial, and deletion after delivery. Recaps must identify their source transcript
and remain AI-generated drafts; meeting content cannot trigger tools or actions.

## Independent optional AI configuration

- [x] Default speech transcription and AI recaps to off; configuring a model does not enable recording or transcription.
- [x] Add separate Admin provider/model assignments for `meet.transcribe` and `meet.summarize`; neither inherits Assistant defaults.
- [x] Allow summary routing through all supported text-provider protocols. Honor configured fallbacks only; never silently use an unrelated provider when an explicit route is unavailable or blocked by classification.
- [x] Require declared realtime speech compatibility for transcription. Support OpenAI realtime-compatible HTTPS endpoints on the deployment allowlist, with tenant credentials passed privately per connection.
- [x] Pass the selected speech model through the pinned native proxy on connection and reconnect, rather than using a global default.
- [x] Test settings isolation, disabled states, endpoint restrictions, browser save/reload, accessibility, and native proxy model handling.
- [ ] Qualify live speech providers and model versions before enabling capture. Chat compatibility alone does not imply speech compatibility.
- [ ] Complete the capture deployment and outstanding lifecycle/storage/consent checks above. No cloud transcription has been enabled by these settings changes.

See [speech service setup](../../infra/meet/transcriber/README.md) for the pinned image,
private-network requirements, model configuration, and current protocol limitations.
