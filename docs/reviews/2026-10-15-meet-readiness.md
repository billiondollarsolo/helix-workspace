# Meet desktop fixes and remaining service gaps

Checked 2026-10-15 against the development deployment at
`https://workspace.helixapps.si/meet`.

## Fixed in the web app

- Active calls now retain the shared `.workspace` grid placement and available
  height. Previously the call replaced that element with an unplaced grid child,
  allowing the desktop call to occupy the wrong grid track.
- Successful instant joins update the URL to `/meet?code=<meeting-code>` without
  exposing the Jitsi JWT. Reload opens pre-join for that code; it does not silently
  reacquire the camera or recording consent.
- Leaving invalidates Meet queries; the hub also refreshes every 15 seconds so
  server-reported closures appear without a manual page reload.
- The Leave action uses the shared danger button styling. The new active-call
  accessibility check caught insufficient contrast in its previous custom styling.
- Embedded and standalone meeting interface branding uses Helix Meet, hides
  watermarks/powered-by and disables mobile-app promotion. Upstream license notices
  remain intact. The standalone override is loaded by the stock Jitsi startup hook.

## Confirmed gaps: do not label these working

### Recording

The live Jitsi services have `ENABLE_RECORDING=0`; no Jibri container is deployed.
The disabled recording control reflects that missing capability. Enabling a flag
alone is insufficient: deploy a healthy recorder with authenticated XMPP, recording
consent enforcement, bounded resources, the tenant-bound upload/finalize path,
malware scanning, retention and recording completion evidence. Qualify an actual
recording before reporting readiness.

### Transcripts and AI summaries

The service inventory names `meet.transcribe`, `meet.summarize` and
`meet.recording-summary`. The store can attach/display a summary, but no production
caller generates it. This review found no working recording-to-transcript-to-summary
pipeline. An AI provider key does not make those metadata entries implemented.
The AI4 tasks in `docs/plans/2026-10-14-workspace-quality-and-optional-ai.md` remain
necessary, including separate capture/transcription controls, authorized sources,
provider selection, bounded jobs, timestamps and retention/deletion behavior.

### Last participant leaves, but meeting remains active

A tenant-scoped, read-only live query found one active room with zero reported
participants, no `last_media_event_at` and no `empty_since`. No participant/conference
lifecycle events had reached Workspace for that room. The deployment mounts no
Workspace lifecycle reporting module into Prosody/Jicofo.

The existing worker runs every 30 seconds and expires rooms empty for two minutes,
but requires a trustworthy `empty_since`. It cannot safely infer that an unreported
room has no actual participants. UI Leave only disconnects the local client; the
list refresh fix does not repair this missing server event source.

Follow-up implementation and acceptance:

- [ ] Wire authenticated media-server lifecycle reporting into `/webhook/jitsi`
      using the existing signed-event validation and actor/room mapping.
- [ ] Report actual conference start/end and participant-session join/leave events;
      reject guests/clients attempting to forge those server events.
- [ ] Preserve event IDs and timestamps across retries; tolerate duplicate,
      delayed and out-of-order events. Bound retries and expose reporting failures.
- [ ] Qualify normal last-person departure, network loss, reconnect within grace,
      two tabs for one participant, recorder/focus participants, room destruction
      and media-server restart. Never close a call based only on one browser's list.
- [ ] Confirm the hub moves a terminated call to Recent and denies expired joins,
      without ending another participant's active call.

No synthetic event was injected into the user's actual call, no unknown live room
was force-ended, and no media/signaling container was restarted for the UI/branding
changes. Recording, transcription and end-to-end media closure remain unqualified.

## Verification scope

Five Playwright scenarios cover the actual web application with a fixture Jitsi
transport, including rendered iframe dimensions, instant-call URL persistence,
reload/pre-join and axe checks. Focused Meet component tests cover the URL callback
and call controls. Public `interface_config.js` was evaluated to confirm the deployed
branding values. This is UI/configuration evidence, not a two-browser live media,
recording, transcription or summary-generation test. The shared browser was signed
out, so the user's private live call was not inspected.
