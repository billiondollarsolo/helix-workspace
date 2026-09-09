# Meet support, SLOs, and operations

This is the production support contract for Helix Meet. It describes what a release may claim, how
capacity is bounded, and the evidence required before promotion. The numeric release thresholds are
defined once in [`infra/meet/ha/capacity.env`](../infra/meet/ha/capacity.env).

## Supported clients

Helix tests the current and previous major desktop releases of Chrome, Edge, Firefox, and Safari.
Supported desktop operating systems are maintained Windows 11, the latest three macOS releases,
Ubuntu 22.04/24.04 LTS, and current ChromeOS. Android Chrome/Firefox and all iOS browsers are supported
for foreground calls on maintained OS releases; background audio, Bluetooth routing, CallKit, and
mobile push are not web-client guarantees. Embedded webviews, Internet Explorer, Edge Legacy,
unmaintained browsers/operating systems, rooted/jailbroken devices, and browser extensions that alter
WebRTC are outside support. Safari does not support output-device selection.

This is deliberately narrower than Jitsi's upstream [browser compatibility
floor](https://jitsi.github.io/handbook/docs/user-guide/supported-browsers/). Every release candidate
must run the real-media matrix in MEET-17 before its browser range advances.

Helix negotiates Opus audio and VP8 or H.264 Constrained Baseline video. These are the portable WebRTC
baseline codecs; VP9 and AV1 may be negotiated but are not required or an interoperability promise.
Screen sharing uses the same negotiated video fallback. See the WebRTC [mandatory codec
baseline](https://developer.mozilla.org/en-US/docs/Web/Media/Guides/Formats/WebRTC_codecs).

## Network boundary

- A browser-trusted TLS certificate, DNS, HTTPS/WSS on TCP 443, and a working UDP path are required.
- Prefer JVB UDP 10000 and regional TURN UDP 3478. Restricted networks must allow TURN/TLS on TCP 443.
  Relay ports 50000-54999 are between the regional TURN and JVB pools, not public browser destinations.
- P2P is disabled: media always traverses the managed JVB/TURN plane. There is no public relay fallback.
- Budget at least 500 kbit/s each direction for 360p and 2.5 Mbit/s each direction for 720p per sending
  participant. Audio-only and receive-only clients use less. RTT below 150 ms, jitter below 30 ms, and
  loss below 2% are recommended; the release ceiling is 400 ms RTT, 100 ms jitter, and 5% loss at p95.
- Proxies that terminate WebSocket unexpectedly, TLS interception that breaks DTLS/WebRTC, symmetric
  UDP blocking without TURN/TLS, and captive portals can prevent or materially degrade calls.

Jitsi documents why valid HTTPS and network headroom are mandatory and gives the same 360p/720p
bandwidth estimates in its [self-hosting requirements](https://jitsi.github.io/handbook/docs/devops-guide/devops-guide-requirements/).

## Service objectives

These objectives are measured per rolling 30 days for production and at the stricter release gate
below. Planned maintenance announced at least 72 hours ahead is excluded; dependency and capacity
failures are not.

| User outcome     | Production objective                                          | Release gate                                                 |
| ---------------- | ------------------------------------------------------------- | ------------------------------------------------------------ |
| Join             | 99.5% of authorized attempts establish media; p95 at most 5 s | 99.5%; p95 5 s                                               |
| Established call | 99.9% healthy media minutes                                   | 99.9%; packet loss p95 5%, jitter p95 100 ms, RTT p95 400 ms |
| Media recovery   | interruption at most 30 s after one bridge/node/zone loss     | measured maximum 30 s                                        |
| Recording start  | 99% of authorized, fully consented requests start             | 99%                                                          |
| Recording ready  | p95 at most 5 minutes after the call ends                     | p95 5 minutes                                                |

Join latency and QoS come from the Jitsi iframe statistics added by MEET-14. Participant duration,
reconnects, and load come only from signed, idempotent media join/leave events. Recording evidence must
exercise the server consent gate and verify the stored artifact; UI clicks alone are not success.

## Product capability boundary

Helix exposes a meeting feature only when its deployed dependencies and authorization path are real.
The embedded client's supported-command response is authoritative for optional local controls: tile
layout, noise suppression, and background blur appear only when Jitsi reports their command. Breakout
controls additionally require the complete create, assign, join, close, and room-list surface and are
shown only to a server-authorized moderator. Breakout participants and movement remain enforced by
Jitsi; Helix retains only room names and participant counts in browser state.

| Capability                                          | Current product status                                                                    |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Audio/video, screen share, hand raise, in-call chat | Exposed and driven by Jitsi state/events                                                  |
| Recording                                           | Exposed only through the Helix consent and authorization gate                             |
| Lobby, lock, moderation, cohosts, attendance        | Exposed through server-authorized MEET-15 controls                                        |
| Tile layout, noise suppression, background blur     | Exposed only when the loaded Jitsi client reports support                                 |
| Breakout rooms                                      | Moderator-only and exposed only when the complete Jitsi surface is available              |
| Live captions/transcription                         | Hidden; no transcription service is deployed                                              |
| Polls and Q&A                                       | Hidden; no supported, governed iframe/API data contract is deployed                       |
| Whiteboard                                          | Hidden; no whiteboard service or persistence/governance path is deployed                  |
| Dial-in/out                                         | Hidden; no managed SIP/PSTN gateway is deployed                                           |
| Livestream                                          | Hidden; no server-side destination-secret, authorization, audit, or lifecycle path exists |
| Calendar-room devices                               | Hidden; no certified room-device integration is deployed                                  |
| Large meetings                                      | Limited to the certified capacity envelope below; no separate large-meeting SKU claim     |

The delivery sequence is: (1) keep the proven local and moderator controls above; (2) deploy and
privacy-review a transcription service before adding captions or subtitle controls; (3) add durable,
tenant-authorized poll/Q&A models; (4) add server-held livestream destinations and lifecycle audit; and
(5) qualify whiteboard, telephony, and room-device services independently. A Jitsi command existing is
not, by itself, enough to expose a feature that needs Helix authorization, secrets, persistence, or
compliance behavior.

## Capacity and routing

The certified envelope is 160 concurrent participants per regional shard after losing one of three
minimum JVBs (80 participants per bridge), or 480 across the three declared regions. The HPA can grow a
shard to nine bridges, but burst capacity above 160 per region is not SLO-backed until separately load
qualified. Admission must stop before the certified envelope rather than overload a bridge.

HAProxy and jitsi-scaler keep a room on one shard, while regional TURN endpoints keep relay traffic in
that shard. All attendees in a room follow that room affinity; this is not a promise that every attendee
uses their geographically nearest region. Octo may carry media between bridges. Data-residency
deployments must put the public hostname behind an approved geographic router and expose only allowed
shards. Mid-call cross-region migration is not promised; the supported recovery unit is a bridge,
node, or zone within the selected deployment. The signed topology, N-1 equation, drain behavior, and
rollback procedure live in [`infra/meet/ha/README.md`](../infra/meet/ha/README.md).

## Accessibility and keyboard boundary

The Helix host controls are semantic buttons with accessible names, visible focus, and status/error
announcements. They are operable with Tab/Shift+Tab and Enter/Space. Native Jitsi single-key shortcuts
are disabled because focus remains shared with the host shell; Helix does not currently promise mute,
camera, or leave accelerator keys. Recording state is both persistent text and an assertive live-region
announcement, with an audible start notice.

Live captions/transcription are not currently exposed by the Helix call surface. Do not claim WCAG live
caption conformance or sell Meet for a workflow that requires captions until a transcription service
is deployed and the MEET-17 browser matrix verifies it. Recorded video does not render a captions track
until a real caption asset exists; an empty track is not caption support. W3C identifies captions as
the text alternative for live conferencing audio in [WCAG 1.2.4/1.2.9 guidance](https://www.w3.org/WAI/WCAG20/Understanding/audio-only-live).

## Privacy model

Browser-to-JVB and TURN transport is encrypted with WebRTC DTLS-SRTP, but Helix does not claim
end-to-end encryption: the managed JVB/Jibri plane is trusted and recording necessarily processes call
media. P2P and third-party relays are disabled. JWTs, TURN credentials, participant/room identifiers,
IP addresses, media, chat, transcripts, and recording URLs must never enter metrics or release evidence.
MEET-14 exports aggregate bounded values with fixed labels only. Prometheus retention and access are an
operator responsibility; keep only the shortest period needed for the 30-day SLO calculation.

Recording requires explicit per-device/per-join consent, a server authorization proving all present
participants consented, persistent visual/audible notice, and tenant-bound storage. Apply the tenant's
recording retention and legal-hold policy. The bridge and recorder are processors inside the selected
deployment; cross-region or external processing must be disclosed before enabling it.

## Release evidence

Run at least 30 minutes at 50% of certified N-1 capacity in every region. Each region must concurrently
include two-party, small, large, screen-share, and recorded calls. The real-browser/media driver writes
only aggregate `workload.json` fields accepted by `release-evidence.mjs`; MEET-14 metrics supply the join
and QoS observations. Do not hand-author a passing report.

During that workload, run one destructive recovery drill and retain its machine-generated aggregate:

```sh
HELIX_MEET_CANARY_URL=https://canary.example.com/calls/ha/health \
HELIX_MEET_RECOVERY_EVIDENCE=recovery.json \
  infra/meet/ha/failover-drill.sh --confirm bridge

node infra/meet/ha/release-evidence.mjs workload.json recovery.json
```

`workload.json` has this intentionally small contract:

```json
{
  "schemaVersion": 1,
  "release": "candidate identifier",
  "startedAt": "ISO-8601 instant",
  "endedAt": "ISO-8601 instant",
  "workload": {
    "profiles": [{ "region": "us-east-1", "kind": "two_party", "peakConcurrentParticipants": 10 }]
  },
  "observations": {
    "participantMinutes": 7200,
    "joinAttempts": 240,
    "joinSuccessPercent": 99.9,
    "joinP95Ms": 3000,
    "healthyMediaPercent": 99.95,
    "qualitySamples": 2400,
    "packetLossP95Percent": 2,
    "jitterP95Ms": 30,
    "rttP95Ms": 150,
    "recordingAttempts": 3,
    "recordingSuccessPercent": 100,
    "recordingReadyP95Ms": 120000
  }
}
```

The gate rejects missing call shapes or regions, insufficient load/duration/samples, SLO misses,
capacity overclaims, and identity/content/credential fields. Run its focused contract test with:

```sh
node --test infra/meet/ha/release-evidence.test.mjs
```

## Incident playbooks

The Meet on-call owns first response. Freeze deployment immediately. Treat inability to join or sustain
calls across a region, failure recovery beyond 30 seconds, unauthorized recording, or suspected media/
credential disclosure as SEV-1; treat a contained SLO breach with a working fallback as SEV-2. Assign an
incident commander, operations lead, and communications lead, update the status channel at least every
30 minutes, and prefer drain/rollback over in-place experimentation on occupied bridges.

1. **Join failures:** compare `helix_meet_join_latency_seconds` and signed joins, check JWT/clock/TLS and
   Prosody/Jicofo health, then test direct UDP and TURN/TLS. If authorization succeeds without media,
   treat it as a media incident. Stop rollout and publish the affected clients/regions.
2. **Poor or reconnecting calls:** group `helix_meet_degraded_samples_total` by its fixed signal and
   `helix_meet_participant_events_total` by reconnect/device failure. Check bridge CPU, participant cap,
   packet loss, regional egress, TURN saturation, and affinity. Drain a bad bridge; do not restart every
   bridge or break healthy rooms.
3. **Bridge/node/zone loss:** run the relevant [`failover-drill.sh`](../infra/meet/ha/failover-drill.sh)
   mode against an established external RTP canary. Keep nodes cordoned only while diagnosing, verify
   N-1 headroom, and rollback the exact Helm revision if interruption exceeds 30 seconds.
4. **Recording failure:** stop accepting new recording starts when Jibri health is absent. Preserve
   consent/audit evidence, reconcile prepared uploads, quarantine incomplete or integrity-failed
   objects, and never attach an unverified artifact. Do not disable consent to restore service.
5. **Credential/privacy event:** disable recording if exposure involves Jibri or storage, rotate in the
   order in [`docs/security/meet-key-rotation.md`](security/meet-key-rotation.md), revoke affected JWT/
   TURN material, preserve audit evidence, and notify security/privacy owners. Never copy raw media,
   tokens, participant lists, or addresses into the incident channel.

After any SLO breach, retain the aggregate workload/recovery artifacts, release and deployment IDs,
affected region/client matrix, timeline, mitigation, and follow-up owner. A failing gate blocks release;
an exception requires the product and incident owners to narrow the published support boundary first.
