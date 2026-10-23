# Meet on LiveKit: remaining features and admin settings

Date: 2026-10-23. Follows [ADR-0032](../adr/adr-0032-meet-via-livekit.md) (LK-1 to LK-6 shipped).

## Where we are

Shipped on LiveKit: calls in Helix's own interface, host controls, the guest lobby, recording
through Egress (saved to Drive → Recordings, named, hosts and co-hosts emailed), TURN, adaptive
stream and dynacast, browser noise suppression, raise hand, ending the meeting when the last host
leaves an empty call.

Not working: live transcription. The storage, Drive transcript, attendee emails, AI recaps, admin
flag and host tool exist, but the audio source was Jitsi's transcriber posting to
`/internal/meet/transcribe`. Nothing feeds it under LiveKit and the call has no Transcribe button.

## Work, in order

### F1. Live captions and transcription (built 2026-10-23; needs a live test with a speech key)

- An in-process **LiveKit transcriber** (`@livekit/rtc-node`, Apache-2.0) joins the room as a hidden
  participant, subscribes to each speaker's microphone, and streams 24 kHz PCM to the tenant's
  `meet.transcribe` realtime speech endpoint (OpenAI realtime transcription protocol; allowlisted
  hosts only, unchanged).
- Final lines go into the existing `meet_transcripts` store, so the existing worker still writes the
  Drive transcript, emails attendees and makes the AI recap.
- Live captions go back to the room as reliable data packets on topic `helix.captions`
  (`{v:1,type:"caption",itemId,speakerIdentity,speakerName,text,final}`); a `state` packet tells
  everyone, and each late joiner, whether it's on.
- Starts from `meet.transcription.set` (host only, everyone present must have accepted the capture
  notice) and from a leader sweep that resumes requested rooms after a restart. Stops when the host
  stops it, the admin turns it off, the meeting ends, or after four hours.
- Remove the Jitsi relay (`transcription.ts`, `MEET_TRANSCRIPTION_PROXY_URL`).
- Web: host Transcribe button with confirmation, "Transcribing" chip and notice for everyone, CC
  toggle and a caption overlay.
- Admin (existing "Speech transcription" flag and model route), new: caption language (done).
- Captions are accepted only from the hidden transcriber (no visible sender or a `TR_` identity).
- Risk: the native binding runs in the API process. If it proves unstable, move the transcriber
  into its own container from the same image.

### F2. Meeting policies panel (Admin → Meet)

One panel, settings stored per tenant, enforced on the server:

- Who can record: hosts only / hosts and co-hosts / anyone.
- Recording layout: grid or speaker; audio-only option; auto-record on start.
- Recording retention (days, then delete from Drive → Recordings) and maximum length.
- Max participants, max meeting length, LiveKit empty-room timeout.
- Defaults for new meetings: guests allowed, lobby on.
- Video quality cap (maximum resolution / bitrate).

### F3. Background blur and virtual backgrounds

Browser-only (`@livekit/track-processors`). Admin: allow custom background images.

### F4. Breakout rooms

App logic: child LiveKit rooms, hosts move people and call everyone back. Admin: allow or deny.

### F5. Live streaming to RTMP (YouTube and others)

Egress stream output. Admin: on/off and allowed destinations.

### F6. Phone dial-in and dial-out

Needs the `livekit-sip` service and a paid SIP trunk (Twilio, Telnyx). Admin: numbers, PINs.

### F7. End-to-end encryption

Client-side. Turns off recording and transcription for that meeting. Admin: allow / require.

### F8. Ingress (OBS / RTMP / WHIP into a meeting) for webinars

Needs the `livekit-ingress` service. Admin: on/off.

### Small follow-ups

- Show guests the meeting title in the lobby; guests-allowed indicator and Block guests button;
  "You were removed" message.
- Times in recording names and emails are UTC; use the host's time zone.

### Housekeeping

- Retire Vaultwarden; delete old Jitsi images and volumes on the dev server.
- Rotate the dev server LiveKit API secret and Redis password (printed into a session log on
  2026-10-23).

## Not available self-hosted

Krisp noise cancellation and LiveKit analytics dashboards are LiveKit Cloud only.
