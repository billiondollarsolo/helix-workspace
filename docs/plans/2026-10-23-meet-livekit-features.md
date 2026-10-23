# Meet on LiveKit: remaining features and admin settings

Started 2026-10-23. Follows [ADR-0032](../adr/adr-0032-meet-via-livekit.md) (LK-1 to LK-6 shipped).
Last updated 2026-10-23 after commit `4b932c6` (on `main`, deployed to the dev server).

## Pick up here

**Next task: F1.10 (live test of captions), then F2 (meeting policies panel).**

- F1 code is done, merged and deployed. Nobody has tried it with a real speech key yet. If you
  can't get a key, skip F1.10, leave it unchecked, and start F2.
- Work top to bottom and tick boxes as you go. Commit the plan with the code it describes.
- Each feature section lists its key files. "Working notes" at the end covers the toolchain,
  tests, deploy and rules.

## Done before this plan

- [x] Calls in Helix's own interface on `livekit-client`, host controls, guest lobby
- [x] Recording through Egress, saved to Drive → Recordings with a readable name; hosts and
      co-hosts emailed a link (`recording-ready.ts`, migration 0257)
- [x] Meeting ends right away when the last host leaves an empty call (`meet-call.tsx` Leave)
- [x] TURN, adaptive stream, dynacast, browser noise suppression, raise hand

## F1. Live captions and transcription

How it works:

- A hidden transcriber (identity `TR_<captureId>`) joins the room through `@livekit/rtc-node`,
  in the API process.
- It streams each person's microphone as 24 kHz PCM to the tenant's `meet.transcribe` realtime
  endpoint. That endpoint speaks the OpenAI realtime transcription protocol (GA `session.update`,
  falling back once to the beta `transcription_session.update`).
- Final lines go into `meet_transcripts`. The existing `MeetTranscriptWorker` then writes the Drive
  transcript, emails attendees and makes the AI recap.
- Captions reach the browser as data packets on topic `helix.captions`:
  - `{v:1,type:"caption",itemId,speakerIdentity,speakerName,text,final}`
  - `{v:1,type:"state",transcribing}`, sent to everyone when it starts or stops, and to each late
    joiner.

Key files:

- Server, in `apps/helix/src/platform/meet/`:
  - `live-transcriber.ts`: start, stop and the leader sweep
  - `livekit-transcriber-room.ts`: the rtc-node adapter
  - `realtime-speech.ts`
  - `transcript-store.ts`: `requestedRooms`, `clearRequested`
  - `transcript-tools.ts`: `meet.transcription.set` checks consent
  - `transcription-settings.ts`
- Server, in `apps/helix/src/bootstrap/`: `meet-transcription.ts` and `meet-capture.ts`
- Migration 0258
- Web, in `apps/web/src/features/meet/`:
  - `meet-call-transcription.tsx`
  - `livekit-call.ts` (captions state; accepts only senders that are missing or start with `TR_`)
  - `meet-call.tsx`
- Admin: `apps/web/src/features/admin/sections/meet.tsx` (caption language)

- [x] F1.1 Speech client for the realtime transcription protocol, with tests (`realtime-speech.test.ts`)
- [x] F1.2 Hidden LiveKit transcriber: one speech session per microphone, 100 ms batches, muted
      microphones not sent
- [x] F1.3 Start from `meet.transcription.set` (host only; everyone present needs capture
      consent); resume after restart with the leader sweep (`helix_meet_transcription_requested_rooms`)
- [x] F1.4 Stop when the host stops it, the admin disables it, nobody's left for 15 s, the room
      closes, the provider fails (clears the request so it doesn't loop), or after 4 h
- [x] F1.5 Removed the Jitsi relay (`transcription.ts`, `/internal/meet/transcribe`,
      `MEET_TRANSCRIPTION_PROXY_URL`)
- [x] F1.6 Join response has `transcriptionAvailable` (hosts only) and `transcriptionActive`
- [x] F1.7 Web: Transcribe button with confirmation, Transcribing chip and notice, CC toggle,
      caption overlay, screen-reader live region for finished lines only
- [x] F1.8 Admin → Meet: caption language (`features.meet_transcription_language`, `""` = detect)
- [x] F1.9 Deployed to the dev server; checked that rtc-node loads in the distroless image
- [ ] F1.10 **Live test.**
  - On the dev server, add an OpenAI provider in Admin → Assistant → Models. Mark it as
    supporting realtime transcription, and route `meet.transcribe` to `gpt-4o-transcribe`.
  - Turn on Admin → Meet → Speech transcription.
  - In a two-person call:
    - captions appear for both people;
    - a late joiner sees the chip;
    - Stop saves the transcript to Drive and the attendee email arrives;
    - an invalid key shows the error and turns transcription off.
  - Check the logs for `Meet live transcription failed`.
- [ ] F1.11 If the GA protocol shape is wrong for the real provider, fix `speechSessionUpdate` in
      `realtime-speech.ts` and its test
- [ ] F1.12 Show the transcriber's failure to the host in the call. Today the chip just goes off;
      the error is only in the transcript row and the logs
- [ ] F1.13 Keep the CC choice across a stop and restart (today hiding captions lasts until the
      call ends)
- [ ] F1.14 Optional: if the native binding proves unstable, run the transcriber in its own
      container from the same image (a `meet-transcriber` entrypoint that runs only the sweep)

## F2. Meeting policies panel (Admin → Meet)

One "Meeting policies" panel in `apps/web/src/features/admin/sections/meet.tsx`:

- Store the settings as tenant feature keys. Add each one to `featureFlagsSchema` in
  `apps/helix/src/platform/admin/tenant-config.ts`, which is `.strict()`.
- Enforce every setting on the server, never only in the UI.

Tasks:

- [ ] F2.1 Who can record: hosts only / hosts and co-hosts / anyone. Enforce in
      `recording-tools.ts` (`meet.recording.start`) and `canStartRecording` in `tools.ts`
- [ ] F2.2 Recording layout: grid or speaker. Pass it to `StartRoomCompositeEgress` in
      `livekit-egress.ts`
- [ ] F2.3 Audio-only recordings option (Egress `audio_only`; saved as `audio/ogg` or `mp4`;
      check that Drive previews it)
- [ ] F2.4 Auto-record when the first host joins (consent rules still apply)
- [ ] F2.5 Recording retention in days. A worker deletes expired recordings from Drive →
      Recordings, and the deletion is audited
- [ ] F2.6 Maximum recording length (stop Egress at the limit)
- [ ] F2.7 Max participants per meeting. Enforce at join in `mintMemberJoin` and guest join, and
      set LiveKit `max_participants` when the room is created
- [ ] F2.8 Maximum meeting length (end the room at the limit; warn 5 minutes before)
- [ ] F2.9 Defaults for new meetings: guests allowed, lobby on (`meet.create-room`)
- [ ] F2.10 Video quality cap (maximum publish resolution or bitrate, sent in the join response
      and applied by `livekit-call.ts`)
- [ ] F2.11 Tests for each enforcement point, then deploy

## F3. Background blur and virtual backgrounds

- [ ] F3.1 Add `@livekit/track-processors`. Blur and image backgrounds on the camera track in
      `livekit-call.ts` / `meet-media.ts`. Check that it isn't newer than pnpm's 1-day
      `minimumReleaseAge`
- [ ] F3.2 Picker in the prejoin screen and in call options; remember the choice per device
- [ ] F3.3 Admin: allow custom background images (upload limits, image types)
- [ ] F3.4 Fall back cleanly on browsers without WebGL or insertable streams

## F4. Breakout rooms

- [ ] F4.1 Data model: child rooms per meeting, plus assignments
- [ ] F4.2 Host UI to create rooms, assign people (manually or automatically), open and close
- [ ] F4.3 Move participants: new token for the child room, with a client reconnect; "Return to
      main room"
- [ ] F4.4 Broadcast to all rooms, plus a countdown before closing
- [ ] F4.5 Admin: allow or deny breakout rooms

## F5. Live streaming to RTMP (YouTube and others)

- [ ] F5.1 Egress `stream_outputs` on the room composite; host enters the stream URL and key
- [ ] F5.2 "LIVE" indicator for everyone; consent notice wording
- [ ] F5.3 Admin: on/off, allowed destination hosts

## F6. Phone dial-in and dial-out

- [ ] F6.1 Add the `livekit-sip` service to compose (pinned by digest)
- [ ] F6.2 SIP trunk with a provider (Twilio or Telnyx). This needs an account and costs money,
      so ask the user first
- [ ] F6.3 Dial-in numbers and meeting PINs; dial-out from the call
- [ ] F6.4 Admin: numbers, PIN policy

## F7. End-to-end encryption

- [ ] F7.1 `livekit-client` E2EE with a per-meeting key handed out by Helix
- [ ] F7.2 Recording and transcription unavailable while E2EE is on (server-enforced)
- [ ] F7.3 Admin: allow / require

## F8. Ingress (OBS / RTMP / WHIP into a meeting) for webinars

- [ ] F8.1 Add the `livekit-ingress` service; host creates an ingest URL
- [ ] F8.2 Admin: on/off

## Small follow-ups

- [ ] S1 Guest lobby shows the meeting title
- [ ] S2 Guests-allowed indicator and a Block guests button for hosts
- [ ] S3 "You were removed from the meeting" message
- [ ] S4 Recording names and emails use the host's time zone instead of UTC
      (`recording-ready.ts`)

## Housekeeping

- [ ] H1 Rotate the dev server LiveKit API secret and Redis password (printed into a session log
      on 2026-10-23)
- [ ] H2 Delete old Jitsi images and volumes on the dev server
- [ ] H3 Retire Vaultwarden

## Not available self-hosted

Krisp noise cancellation and LiveKit analytics dashboards exist only on LiveKit Cloud.

## Working notes

Toolchain:

- Node: `export PATH=~/.nvm/versions/node/v24.15.0/bin:$PATH`, then `corepack pnpm exec …` from
  `apps/helix` or `apps/web`.
- New dependencies: pin exact versions. pnpm refuses releases less than 1 day old.

Database tests:

1. Start a throwaway Postgres:
   ```
   docker run -d --name helix-lk-testdb -e POSTGRES_DB=helix -e POSTGRES_USER=helix -e POSTGRES_PASSWORD=helix_dev_password -p 127.0.0.1:28532:5432 -v $PWD/infra/postgres/init:/docker-entrypoint-initdb.d:ro helix/postgres-pgvector:18.6-pgvector0.8.5
   ```
2. Set `DATABASE_URL=postgres://helix:helix_dev_password@127.0.0.1:28532/helix`.
3. Run `corepack pnpm db:migrate` from `apps/helix`.
4. Remove the container afterwards.

Known test failures that predate this work:

- many `*.integration.test.ts` files need extra database URLs (they fail with
  `password authentication failed for user "mj"`);
- 7 files under `infra/scripts` say "No test suite found".

Deploying to the dev server (`89.167.14.138`, key `~/.ssh/mj_hetzner_091123`):

1. `git archive` the commit into `/srv/helix/livekit-20261021/workspace-$SHA`.
2. Build:
   ```
   docker build -f infra/docker/Dockerfile --target runtime -t helix/workspace:lk-$SHA .
   docker build -f infra/docker/Dockerfile --target web-runtime -t helix/workspace-web:lk-$SHA .
   ```
3. Change only the `lk-*` tags in `/srv/helix/config/development-compose.json` with sed. The
   `rename-*` tags belong to other services.
4. Run `docker compose -f <that file> up -d`. Migrations run automatically.
5. The public API is under `https://workspace.helixapps.si/v1/`.

Rules:

- Don't read hosted Workspace user data.
- Don't use the stored Cloudflare credentials.
- Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Work happens on `agentspace-rename`, which is fast-forwarded into `main`.
