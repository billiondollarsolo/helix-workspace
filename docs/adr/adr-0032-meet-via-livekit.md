# ADR-0032: Meet on LiveKit

> Dormant full-profile decision, outside 1.0. Supersedes [ADR-0008](adr-0008-meet-via-jitsi.md).

- **Status:** Accepted (2026-10-21)
- **Date:** 2026-10-21

## Context

Meet ran on Jitsi: five containers, a separate `meet.` hostname kept apart from Workspace, and an
iframe that Workspace drove through Jitsi's External API. Helix is still a development-only product,
so there are no users or rooms to migrate.

## Decision

Run Meet on a bundled [LiveKit](https://livekit.io/) server (Apache-2.0) and remove Jitsi outright.

- One `livekit` container, pinned by version and digest, using the stack's Redis.
- The call runs in Helix's own interface on `livekit-client`. Signalling uses the Workspace address
  at `/rtc` through Caddy; there is no `meet.` hostname.
- Media goes directly to LiveKit on UDP 7882 and TCP 7881. LiveKit's built-in TURN replaces coturn
  on UDP 3478 and TLS 5349, on a DNS-only `turn.` hostname.
- Helix signs access tokens, calls LiveKit's server API for host controls, and verifies LiveKit's
  signed webhooks itself, without a LiveKit server SDK.
- Recording returns through LiveKit Egress and live transcription through a LiveKit agent, as
  follow-up tasks. Features without a LiveKit equivalent yet (breakout rooms, background blur,
  server lobby) are hidden.

## Alternatives considered

- **Keep Jitsi.** Works, but needs a separate hostname, more containers, and an iframe Helix cannot
  fully control.
- **A hosted media service.** Moves call media outside the deployment.

## Consequences

- Operators drop the `meet.` record and open TCP 7881 and UDP 7882 instead of UDP 10000.
- Host controls are enforced on the server instead of in an embedded client.
- Recording and live captions are unavailable until their follow-up tasks ship.

## Reversal triggers

- LiveKit cannot meet the Meet support objectives on the supported host classes.
- LiveKit's licence or maintenance changes so that it can no longer be bundled.
