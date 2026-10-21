# Meet support, SLOs, and operations

This is the production support contract for Helix Meet. It describes what a release may claim, how
capacity is bounded, and the evidence required before promotion. Meet runs on a bundled
[LiveKit](https://livekit.io/) media server; see the [Meet install](deployment-production.md#meet-and-calendar).

## Supported clients

Helix tests the current and previous major desktop releases of Chrome, Edge, Firefox, and Safari.
Supported desktop operating systems are maintained Windows 11, the latest three macOS releases,
Ubuntu 22.04/24.04 LTS, and current ChromeOS. Android Chrome/Firefox and all iOS browsers are supported
for foreground calls on maintained OS releases; background audio, Bluetooth routing, CallKit, and
mobile push are not web-client guarantees. Embedded webviews, Internet Explorer, Edge Legacy,
unmaintained browsers/operating systems, rooted/jailbroken devices, and browser extensions that alter
WebRTC are outside support. Safari does not support output-device selection.

This is deliberately narrower than LiveKit's upstream [browser
support](https://docs.livekit.io/home/client/connect/#supported-browsers). Every release candidate
must run the real-media matrix in MEET-17 before its browser range advances.

Helix negotiates Opus audio and VP8 or H.264 Constrained Baseline video. These are the portable WebRTC
baseline codecs; VP9 and AV1 may be negotiated but are not required or an interoperability promise.
Screen sharing uses the same negotiated video fallback. See the WebRTC [mandatory codec
baseline](https://developer.mozilla.org/en-US/docs/Web/Media/Guides/Formats/WebRTC_codecs).

## Network boundary

- A browser-trusted TLS certificate, DNS, HTTPS/WSS on TCP 443 (signalling at `/rtc` on the
  Workspace address), and a working media path are required.
- Prefer UDP 7882 to LiveKit, then TCP 7881, then TURN on UDP 3478. Restricted networks must allow
  TURN/TLS on TCP 5349 to the DNS-only `turn.` hostname.
- Media always traverses the bundled LiveKit server. There is no peer-to-peer or third-party relay.
- Budget at least 500 kbit/s each direction for 360p and 2.5 Mbit/s each direction for 720p per sending
  participant. Audio-only and receive-only clients use less. RTT below 150 ms, jitter below 30 ms, and
  loss below 2% are recommended; the release ceiling is 400 ms RTT, 100 ms jitter, and 5% loss at p95.
- Proxies that terminate WebSocket unexpectedly, TLS interception that breaks DTLS/WebRTC, symmetric
  UDP blocking without TURN/TLS, and captive portals can prevent or materially degrade calls.

## Service objectives

These objectives are measured per rolling 30 days for production and at the stricter release gate
below. Planned maintenance announced at least 72 hours ahead is excluded; dependency and capacity
failures are not.

| User outcome     | Production objective                                          | Release gate                                                 |
| ---------------- | ------------------------------------------------------------- | ------------------------------------------------------------ |
| Join             | 99.5% of authorized attempts establish media; p95 at most 5 s | 99.5%; p95 5 s                                               |
| Established call | 99.9% healthy media minutes                                   | 99.9%; packet loss p95 5%, jitter p95 100 ms, RTT p95 400 ms |

Recording objectives return with LiveKit Egress (a follow-up task). Join latency and QoS come from the
browser client's WebRTC statistics. Participant duration, reconnects, and load come only from signed,
idempotent LiveKit webhook events. Recording evidence, once Egress ships, must exercise the server
consent gate and verify the stored artifact; UI clicks alone are not success.

## Product capability boundary

Helix exposes a meeting feature only when its deployed dependencies and authorization path are real.
The call runs in Helix's own interface on the LiveKit browser SDK, and features without a LiveKit
equivalent yet report `false` capabilities and stay hidden.

| Capability                                          | Current product status                                                                    |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Audio/video, screen share, hand raise, in-call chat | Exposed; chat uses the LiveKit data channel and hand raise uses participant attributes    |
| Mute, remove, lock, end                             | Exposed to server-authorized hosts; enforced through LiveKit's server API                 |
| Recording                                           | Hidden until LiveKit Egress ships (follow-up); consent and authorization rules unchanged  |
| Live captions/transcription                         | Hidden until a LiveKit transcription agent ships (follow-up)                              |
| Breakout rooms, background blur, server lobby       | Hidden; follow-up tasks                                                                   |
| Polls and Q&A                                       | Hidden; no governed data contract is deployed                                             |
| Whiteboard                                          | Hidden; no whiteboard service or persistence/governance path is deployed                  |
| Dial-in/out                                         | Hidden; no managed SIP/PSTN gateway is deployed                                           |
| Livestream                                          | Hidden; no server-side destination-secret, authorization, audit, or lifecycle path exists |
| Calendar-room devices                               | Hidden; no certified room-device integration is deployed                                  |
| Large meetings                                      | Limited to the certified capacity envelope below; no separate large-meeting SKU claim     |

A client SDK feature existing is not, by itself, enough to expose a feature that needs Helix
authorization, secrets, persistence, or compliance behavior.

## Capacity and routing

The bundled install is one LiveKit server on one host, sized for small meetings. There is no
certified multi-node or multi-region envelope; capacity beyond one host is not SLO-backed until a
LiveKit multi-node deployment is load qualified. Measure the host class you intend to use with
`infra/scripts/production-boot-smoke.sh --with meet` and your own load test before promising a size.

## Accessibility and keyboard boundary

The Helix host controls are semantic buttons with accessible names, visible focus, and status/error
announcements. They are operable with Tab/Shift+Tab and Enter/Space. Helix does not currently promise
mute, camera, or leave accelerator keys. Recording state is both persistent text and an assertive live-region
announcement, with an audible start notice.

Live captions/transcription are not currently exposed by the Helix call surface. Do not claim WCAG live
caption conformance or sell Meet for a workflow that requires captions until a transcription service
is deployed and the MEET-17 browser matrix verifies it. Recorded video does not render a captions track
until a real caption asset exists; an empty track is not caption support. W3C identifies captions as
the text alternative for live conferencing audio in [WCAG 1.2.4/1.2.9 guidance](https://www.w3.org/WAI/WCAG20/Understanding/audio-only-live).

## Privacy model

Browser-to-LiveKit and TURN transport is encrypted with WebRTC DTLS-SRTP, but Helix does not claim
end-to-end encryption: the LiveKit server is trusted and recording necessarily processes call media.
P2P and third-party relays are not used. Access tokens, TURN credentials, participant/room identifiers,
IP addresses, media, chat, transcripts, and recording URLs must never enter metrics or release evidence.
MEET-14 exports aggregate bounded values with fixed labels only. Prometheus retention and access are an
operator responsibility; keep only the shortest period needed for the 30-day SLO calculation.

Recording requires explicit per-device/per-join consent, a server authorization proving all present
participants consented, persistent visual/audible notice, and tenant-bound storage. Apply the tenant's
recording retention and legal-hold policy. The media server and recorder are processors inside the selected
deployment; cross-region or external processing must be disclosed before enabling it.

## Release evidence

Run at least 30 minutes at 50% of the measured host capacity with two-party, small, and screen-share
calls in real browsers, and keep only aggregate join, QoS, and duration figures. Do not hand-author a
passing report. Recorded-call evidence is added when LiveKit Egress ships.

## Incident playbooks

The Meet on-call owns first response. Freeze deployment immediately. Treat inability to join or sustain
calls, failure recovery beyond 30 seconds, unauthorized recording, or suspected media/
credential disclosure as SEV-1; treat a contained SLO breach with a working fallback as SEV-2. Assign an
incident commander, operations lead, and communications lead, update the status channel at least every
30 minutes, and prefer rollback over in-place experimentation while calls are running.

1. **Join failures:** compare `helix_meet_join_latency_seconds` and signed joins, check token/clock/TLS, the
   `/rtc` route, and LiveKit health, then test UDP 7882, TCP 7881, and TURN/TLS. If authorization succeeds without media,
   treat it as a media incident. Stop rollout and publish the affected clients/regions.
2. **Poor or reconnecting calls:** group `helix_meet_degraded_samples_total` by its fixed signal and
   `helix_meet_participant_events_total` by reconnect/device failure. Check LiveKit CPU and memory, packet loss,
   host egress, and TURN load. Restarting `livekit` ends every running call; do it only when needed.
3. **Host loss:** restore the host or move the install; running calls end and people rejoin.
4. **Recording failure (once Egress ships):** stop accepting new recording starts when Egress is unhealthy. Preserve
   consent/audit evidence, reconcile prepared uploads, quarantine incomplete or integrity-failed
   objects, and never attach an unverified artifact. Do not disable consent to restore service.
5. **Credential/privacy event:** disable recording if exposure involves the recorder or storage, rotate in the
   order in [`docs/security/meet-key-rotation.md`](security/meet-key-rotation.md), revoke affected token
   and TURN material, preserve audit evidence, and notify security/privacy owners. Never copy raw media,
   tokens, participant lists, or addresses into the incident channel.

After any SLO breach, retain the aggregate workload/recovery artifacts, release and deployment IDs,
affected region/client matrix, timeline, mitigation, and follow-up owner. A failing gate blocks release;
an exception requires the product and incident owners to narrow the published support boundary first.
