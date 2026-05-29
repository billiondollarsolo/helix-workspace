# Meet — Senior Review (post-wave-1 fixes)

## Summary

Wave-1 (External API wiring, recording playback drawer, participant + chat
rails) closed the most visible gap — the embed is no longer a black box and
recordings are watchable in-product. What remains is mostly back-of-house:
dev-only stand-ins still register in production, the JWT/webhook secrets ride
unscoped env vars with no rotation story, the moderator bit is grant-on-create
(no demotion), and several "feature complete" UI affordances (Summary,
transcripts, calendar, post-call action items, branding) are inert or absent.
Code quality is good in the new frontend modules but `store.ts` is a 1.2k-line
hot spot with N+1-flavored aggregation subqueries and untyped jsonb shuttling.

## Scorecard

- Security: 2/5 — webhook secret is a single env constant with no HMAC/replay
  protection; JWT secret is shared cleartext with Prosody; moderator escalation
  on every `meet.mint-token` from the room creator; recording-message ACL relies
  on a SELECT-then-COPY snapshot that doesn't cascade later invites.
- Correctness: 3/5 — scheduled→active is implicit (no transition path is wired;
  the hub blocks join with "hasn't started yet"); mock-recorder is registered in
  any environment where `coreApps.shouldRegister("meet")` is true; double
  end-room race between Jitsi `videoConferenceLeft` and the Leave button.
- Feature completeness: 2/5 — AI summaries, transcripts, calendar, breakout
  rooms, post-call action items, pre-call device picker, lobby moderation UI are
  all unimplemented or stubbed. Hub "Summary" button is decorative.
- Code quality: 3/5 — frontend is tight and typed; backend `store.ts` mixes
  three concerns and routes/store push raw jsonb through `JSON.parse(JSON.stringify(...))`;
  the e2e spec is stale and would silently pass against the wrong DOM.

## Findings

### M1: Jitsi JWT signing secret is a single shared constant with no rotation · high · security
**File**: `apps/helix/src/platform/meet/jwt.ts`, `apps/helix/src/server.ts:2068`, `plugins/com.helix.core.meet-jitsi/compose.yaml:18,52`
**What's wrong**: `mintJitsiJwt` HS256-signs with `MEET_JITSI_JWT_SECRET`. The
same literal env var is injected into both `jitsi-web` and `jitsi-prosody`
containers (`JWT_APP_SECRET`). There is no key id (`kid`) in the header, no
support for multiple active keys, and no per-tenant key. Rotating the secret
requires a synchronized restart of Helix + every Jitsi container and invalidates
every in-flight token. Anyone with read access to the Helix container env (or a
prior leaked rotation) can mint a moderator JWT for any room in any tenant.
**Fix**: (a) include `kid` in the JWT header and accept an array of
`{kid, secret}` for verify+sign; Prosody's token plugin supports
`asap_key_server` for this. (b) Move the signing material into the existing
crypto provider (`getCryptoProvider`) backed by KMS or vault and never put the
plain secret on `process.env`. (c) Scope per org via `sub` plus a tenant prefix
on `kid`. (d) Document and script a hot-rotation runbook.
**Effort**: L

### M2: Webhook auth is a static shared secret with no replay/timestamp/signature · high · security
**File**: `apps/helix/src/platform/meet/routes.ts:82,179,287`
**What's wrong**: `acceptJitsiSecret` does a plain `===` against
`X-Helix-Jitsi-Secret`. There is no HMAC over the body, no timestamp window, no
nonce, and no idempotency key beyond the storage-key uniqueness check inside
`attachRecording`. An attacker who captures a single webhook in transit (or
recovers the secret from CI logs) can replay arbitrary recordings against any
room — `attachRecording` resolves by `roomName`, so the attacker only needs the
slug. `===` is also not constant-time, which is fixable cheaply with
`crypto.timingSafeEqual`.
**Fix**: switch to `X-Helix-Signature: t=<unix>,v1=<hex(hmac-sha256(secret, t + "." + body))>`,
require `|now - t| <= 300s`, store accepted `(uploadId|sha256)` in a short-TTL
replay table, and use `timingSafeEqual`. Bonus: validate `X-Helix-Org-Id`
against the prepare-step uploadId binding.
**Effort**: M

### M3: Presigned PUT TTL is fixed at 15 min with no per-tenant ceiling and no cleanup of expired upload IDs · medium · security/correctness
**File**: `apps/helix/src/platform/meet/routes.ts:139-170`
**What's wrong**: `expiresSeconds = 900` is hard-coded; the prepare endpoint
issues an unbounded number of presigned URLs (no rate limit, no actor binding —
prepare requires no actor, only the shared webhook secret), and the system
never reaps unmatched `uploadId`s. A leaked finalize.sh secret or a confused
Jibri restart can stockpile garbage objects in tenant buckets. The presign also
honors any `contentType` the caller passes, so a future caller could mint a
PUT URL for a non-video MIME and bypass `validateRecordingMedia` (only invoked
on the webhook, not on the prepare contract).
**Fix**: clamp via `MEET_RECORDING_UPLOAD_TTL_SECONDS` (default 900, max 1800);
persist `(uploadId, orgId, storageKey, expiresAt)` in an `meet_recording_uploads`
table, garbage-collect expired rows, and reject webhooks whose `uploadId` isn't
in that table or whose `orgId` doesn't match. Restrict the prepare `contentType`
to `video/mp4|video/webm` server-side.
**Effort**: M

### M4: Recording ACL is a SELECT-then-INSERT snapshot and never cascades later attendee additions · high · security/correctness
**File**: `apps/helix/src/platform/meet/store.ts:1018-1035` (`grantRecordingObjectAccess`)
**What's wrong**: When a recording attaches we grant `object:reader` for the
actor set that exists *right now*. If a user is added to the room or thread
later (`grantThreadAccess`/`grantMeetAccess` invoked post-attach by an admin or
follow-up tool), they will be visible in the meeting roster, see the thread,
but get `403` on `/api/drive/objects/:id/content` because no row was backfilled.
Conversely there is no revocation: removing someone from the thread does not
clear their object permission. The Drive surface and the Meet drawer disagree
about who can play the file.
**Fix**: switch to a view-style permission check in `objects` access — derive
read on `kind='recording'` objects from the joined room/thread permissions
instead of materializing into `permissions` at attach time. If a snapshot is
required, add a trigger on `permissions` rows for `(meet_room, thread)` that
materializes/clears the corresponding `object` rows.
**Effort**: M

### M5: Moderator bit is granted whenever the room creator mints a token, with no demote path · medium · security
**File**: `apps/helix/src/platform/meet/tools.ts:188`, `apps/helix/src/platform/meet/jwt.ts:51`
**What's wrong**: `moderator: input.moderator || room.createdByActorId === ctx.actor.id`.
The creator is always moderator regardless of the input flag, and any caller
can pass `moderator: true` — `meet.mint-token` requires only `meet.read` and
does no check that the caller actually has moderator-equivalent role on the
room (e.g. an `admin` or `owner` permission). Lower-privileged invitees can
elevate themselves to moderator by calling the tool with the flag set. The
JWT also has no `affiliation` or `room`-scoped role binding beyond
`context.user.moderator`, so Prosody's enforcement depends on this honor
system. There is also no "end for all" → demote vs co-host model.
**Fix**: derive `moderator` server-side only — `true` iff caller actor has
`owner` or `admin` permission on the `meet_room`; ignore `input.moderator`
unless `meet.admin` scope is present. Add a `meet.set-role` tool for
co-host/demote and reflect it in the JWT (`context.user.role`).
**Effort**: M

### M6: `attachRecording` matches by `roomName` only, which is a tenant-mutable, collidable identifier · high · security/correctness
**File**: `apps/helix/src/platform/meet/routes.ts:185-263`, `apps/helix/src/platform/meet/store.ts:382-395,972-986`
**What's wrong**: `selectRoomByName` returns the *latest* row for `(orgId, roomName)`.
The `meet_rooms_org_room_name_idx` is unique today, but ended rooms keep the
slug, so reusing or guessing a previous slug across orgs (combined with M2) lets
an attacker attach a recording to a stranger's old room. There is also no
verification that the webhook's `orgId` (from header) belongs to the room — the
route accepts an `X-Helix-Org-Id` header and trusts it. Defense in depth: bind
the webhook to the prepared upload (M3) and require both `roomId` *and* `orgId`
match the prepare record.
**Fix**: in `requirePreparedRecordingUpload` mode, refuse webhooks without a
known `uploadId`; tie `uploadId -> orgId,roomId` at prepare time; reject by
`roomName` lookups in that mode entirely. Outside prepare mode, log a warning
when the header `orgId` differs from the room's stored `orgId`.
**Effort**: S

### M7: `mock-recorder` is registered in every environment where Meet is enabled · high · correctness
**File**: `apps/helix/src/server.ts:2083-2088`, `apps/helix/src/platform/meet/mock-recorder.ts:1-12`
**What's wrong**: The tool advertises itself as "Dev-only" but the wiring runs
unconditionally inside `if (coreApps.shouldRegister("meet"))`. In production
this exposes `meet.mock-record` to anyone with `meet.write`, letting them write
junk MP4-shaped payloads into tenant storage and fan out
"Recording is ready…" notifications to attendees. Combined with M2 the same
attacker doesn't even need the webhook secret to forge a recording.
**Fix**: gate on `process.env.NODE_ENV !== "production"` AND an explicit
`HELIX_ENABLE_MOCK_RECORDER` flag, or move the tool into a `dev-tools` plugin
that is not loaded in prod tiers. At minimum require a `meet.admin` scope.
**Effort**: S

### M8: Scheduled → active transition is not implemented · high · correctness
**File**: `apps/helix/src/platform/meet/store.ts:169-240`, `apps/web/src/features/meet/meet-hub.tsx:188-200`
**What's wrong**: `createRoom` sets `status='scheduled'` when scheduling data
is present, but nothing flips it to `'active'`. `meet.mint-token` rejects
non-active rooms (`tools.ts:174`), so the hub's "This meeting hasn't started
yet" path is the *only* outcome for any scheduled meeting. There is no
auto-transition cron, no "Start now" path that promotes the row, and the
Jitsi-side `videoConferenceJoined` event never feeds back to the store
(webhooks are recording-only). Either the schedule feature is decorative or
hosts must manually create a brand new room at the scheduled time.
**Fix**: add `meet.start-scheduled-room` (tool + UI button on the row for the
host) that updates `status='active'` and bumps `started_at`. Optionally promote
on first `meet.mint-token` from the creator within a `[scheduledStart - 5m,
scheduledEnd + 60m]` window.
**Effort**: M

### M9: Race between Jitsi hangup and the Leave button doubles `meet.end-room` · medium · correctness
**File**: `apps/web/src/features/meet/meet-call.tsx:84-113,340-350`
**What's wrong**: `Leave` click invokes both `commands.hangup()` *and*
`leaveMutation.mutate()`. The hangup fires `videoConferenceLeft` which calls
`onLeft`, which also calls `leaveMutation.mutate()` (guarded by `isPending` —
but `isPending` only flips after the mutation function awaits, and React 18
will likely fire `onLeft` after the optimistic enqueue). The result is one of
(a) two `meet.end-room` POSTs, (b) a 404 on the second because the first
succeeded and the route already returned `null` from `selectRoomForActor`
(which `endRoom` then surfaces as the error toast). The store is idempotent in
intent but throws via the tool wrapper.
**Fix**: drop the belt-and-suspenders direct `leaveMutation.mutate()` in the
Leave click handler; rely solely on `onLeft`. Or have `endRoom` return the
already-ended room (it does), but make the tool tolerate `null` as "already
ended" without throwing.
**Effort**: S

### M10: "Summary" button is inert; AI summaries + transcripts have no producer · medium · feature gap
**File**: `apps/web/src/features/meet/meet-hub.tsx:496-498`, `apps/helix/src/platform/meet/store.ts:593-648`, `infra/meet/config/web/config.js:150-159`
**What's wrong**: `attachSummary` exists in the store but there is no caller —
no tool, no AI worker, no webhook hands it a body. The hub's "Summary" button
in the Recent panel has no `onClick`. Transcription is hard-disabled in Jitsi
(`config.transcription.enabled = false`). No code reads from
`meeting.summaries` in the frontend, so even if a summary attached the user
wouldn't see it.
**Fix**: (a) add a `meet.summarize-room` tool that pulls the recording (or
transcript) and posts via `attachSummary`. (b) enable Jibri's
transcription/closed-captions pipeline OR send the audio track through the AI
provider for STT. (c) Render `meeting.summaries[0].body` in a summary drawer
mirroring `RecordingDrawer`, and wire the "Summary" button to open it.
**Effort**: L

### M11: No calendar integration despite the schedule flow · medium · feature gap
**File**: `apps/web/src/features/meet/meet-hub.tsx:541-649` (ScheduleDialog), `apps/helix/src/server.ts:2053-2062` (calendar exists, not wired to Meet)
**What's wrong**: Scheduling a meeting writes a `meet_room` row but does not
create a calendar event, send `.ics` invitations to participants, or appear in
the Calendar surface. The Calendar runtime is already constructed two lines
above the Meet registration. There is no "Add to calendar" affordance and no
RSVP linkback.
**Fix**: pipe `meet.create-room` with schedule fields through
`calendarStore.create()` and `createMailCalendarInvitationSender`; embed the
join code in the event body; carry `roomId` in event metadata so the calendar
surface can render a "Join meeting" CTA.
**Effort**: M

### M12: No pre-call device picker, no lobby/moderation UI, no breakout rooms · medium · feature gap
**File**: `apps/web/src/features/meet/jitsi-external-api.ts:219-244`
**What's wrong**: `prejoinPageEnabled: false` is hard-coded, so users land in
the call with whatever default mic/cam Chrome chose. The Prosody config has
`muc_lobby_rooms` and `muc_breakout_rooms` plugins enabled, but the embed
exposes no UI to admit lobby guests, no breakout-room controls, and the
External API listeners for `knockingParticipant` /
`participantKickedOut` / `breakoutRoomsUpdated` are not subscribed. The
schedule dialog also has no attendee picker — only the creator is invited.
**Fix**: (a) add a `<PreCallDevicePicker>` that runs against
`navigator.mediaDevices` before mounting Jitsi (or re-enable `prejoinPageEnabled`
behind a setting). (b) listen for `knockingParticipant` and surface
`answerKnockingParticipant` for moderators. (c) wire `toggleBreakoutRooms` and
the breakout-room list events into the participant rail. (d) extend the
schedule dialog with `participantActorIds`.
**Effort**: L

### M13: No Helix branding — Jitsi watermark and "Jitsi Meet" name still surface inside the iframe · low · feature gap / brand
**File**: `infra/meet/config/web/interface_config.js:12,30,74,103,130`, `apps/web/src/features/meet/jitsi-external-api.ts:234-243`
**What's wrong**: `APP_NAME: 'Jitsi Meet'`, `PROVIDER_NAME: 'Jitsi'`,
`SHOW_JITSI_WATERMARK: true`, default watermark image, `SUPPORT_URL`
pointing to `community.jitsi.org`. The hook passes
`SHOW_JITSI_WATERMARK: false` via `interfaceConfigOverwrite` but modern Jitsi
ignores most of `interface_config.js` in favor of `config.dynamicBrandingUrl`,
so the watermark may still flash on slow connects. No favicon override, no
default avatar, no `defaultLogoUrl`.
**Fix**: serve a Helix `dynamicBrandingUrl` JSON (`{ logoImageUrl, backgroundImageUrl,
favicon, supportUrl, ... }`) from the Helix API; set `APP_NAME: 'Helix Meet'`
and `PROVIDER_NAME: 'Helix'` at the container level via env override; ship a
custom favicon and `defaultLogoUrl` mounted into `/usr/share/jitsi-meet/images`.
**Effort**: M

### M14: E2E spec `meet-jitsi-embed.spec.ts` is stale — references DOM that no longer exists · medium · stub / test rot
**File**: `apps/web/tests/e2e/meet-jitsi-embed.spec.ts:42-48`
**What's wrong**: The spec asserts `page.locator(".meet-iframe")` and an
`allow="camera; microphone; fullscreen; display-capture"` attribute. The new
`useJitsiCall` hook creates the iframe via `JitsiMeetExternalAPI` into an
unstyled host `div` with no `.meet-iframe` class, and the `allow` attribute now
includes `autoplay` (`jitsi-external-api.ts:253`). The locator will time out
and the spec will fail — or worse, if the upstream loader is mocked away, will
pass against a fixture that doesn't reflect the production path.
**Fix**: rewrite the spec to (a) mock `external_api.js` with a fake constructor
that records `domain/options`, (b) assert the constructor was called with the
minted `jwt` and `roomName`, (c) assert hangup → `endMeetRoom` is invoked. Drop
the iframe attribute assertions or rewrite against the new `allow` set.
**Effort**: S

### M15: `store.ts` is 1.2k lines mixing schema mapping, SQL, jsonb shuttling, and metering · medium · code quality
**File**: `apps/helix/src/platform/meet/store.ts` (entire file)
**What's wrong**: Three concerns share one file — `PostgresMeetStore` (700 LOC
of raw SQL with nested `coalesce(jsonb_agg(...), '[]')` correlated subqueries),
`InMemoryMeetStore` (260 LOC duplicating projection logic), and free helper
functions (`grant*`, `appendMeetActivity`, `formatMeetCode`, `mapRoom`,
`mapMeeting`, etc.). Each list query embeds the same recording-artifacts
subquery copy/pasted twice (`listRoomsForActor` and `listMeetingsForActor`).
`toSqlJson` round-trips through `JSON.parse(JSON.stringify(...))` to coerce
types — fine for safety, expensive at the room-list page boundary, and hides
real type errors. The `MeetRoomRow` type has six optional aggregated columns
that are only ever populated by some of the queries.
**Fix**: split into `store-postgres.ts`, `store-in-memory.ts`,
`store-projections.ts` (the SQL fragments for `recording_artifacts`/`summaries`/
`attendees` reused by both list queries), and `store-helpers.ts`
(`grant*`, `appendMeetActivity`, `formatMeetCode`). Replace the manual jsonb
coercion with a single typed `toJsonObject(value: unknown): JsonObject` that
narrows once at the boundary.
**Effort**: M

### M16: Webhook payload typing leans on `z.passthrough()` and ad-hoc field aliasing · low · code quality
**File**: `apps/helix/src/platform/meet/routes.ts:8-66`
**What's wrong**: The schema accepts 14 aliased shapes (`storageKey`/`storage_key`/`fileKey`/`file_key`/`url`,
`roomName`/`room_name`/`room`, etc.) plus `.passthrough()`. The handler then
re-coalesces them manually. This makes the contract opaque, hides typos, and
means a Jibri version bump that renames a field can silently start ignoring
inputs because every field is optional. There is also no JSON Schema published
to the plugin manifest for Jitsi operators to validate against.
**Fix**: pick the canonical shape (Jibri's actual payload is documented;
prefer `snake_case`), normalize aliases in a thin compat shim, then validate
against a strict (`z.strictObject`) schema downstream. Reject unknown fields
in `requirePreparedRecordingUpload` mode.
**Effort**: S

### M17: Recording-attached notification fan-out cannot be opted out and has no body · low · UX/correctness
**File**: `apps/helix/src/platform/meet/store.ts:544-580`
**What's wrong**: Every attendee + thread member receives a notification with
`summary` only; `body: null`. There is no respect for per-actor preferences
(do-not-disturb, mute thread), no batching for sequential uploads from the
same session, and no link payload. If Jibri produces three files per meeting
(common with breakouts), users see three near-identical alerts.
**Fix**: route through the existing notifier preferences layer; debounce on
`(roomId, recipient)` within a 60s window; include `body` with file size +
duration; deep-link payload to the meeting drawer instead of an opaque
`meet_room` object id.
**Effort**: S

### M18: `meet.create-room` activity hash is not chained to prior hash · low · audit
**File**: `apps/helix/src/platform/meet/store.ts:1045-1051`
**What's wrong**: `appendMeetActivity` writes `prev_hash=null` and computes
`this_hash` over `(orgId, actorId, verb, roomId, now)`. The audit chain
elsewhere in the codebase computes `this_hash = sha256(prev_hash || payload)`
which is what makes tampering detectable. Meet-emitted activity rows are
unverifiable.
**Fix**: use the shared audit-chain helper (the same one used by Drive/Mail
activity inserts) rather than rolling a local hash; set `prev_hash` to the
last row's hash inside the org or the chain tip the audit subsystem exposes.
**Effort**: S
