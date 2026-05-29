# Chat + Calendar — Senior Review

## Summary (Chat)

Helix Chat ships a coherent WebSocket-backed messaging surface (rooms, DMs, presence, typing, read receipts, reactions, edit/delete, search) on top of a single `/ws/chat` socket and a small `chat.*` tool surface. The backend ACL story is solid (room access is re-checked on every WS frame, edits/deletes additionally require the actor own the message and have a `permissions` row), and there is a real graceful-shutdown path that broadcasts a `reconnect` frame before closing sockets. The biggest correctness and security weaknesses are concentrated in: (1) the unbounded WebSocket subscription model with no per-actor rate or socket caps; (2) attachments accepted on send with no scanning or ownership verification; (3) no message-ordering guarantee or backfill on reconnect; (4) the frontend's local-only reactions model that is opaquely lossy; (5) several "wired but stubbed" surfaces (threads, files, pinned, formatting toolbar, attach, emoji, mini-month, AI compose). Threads in particular are visually present but functionally are just composer replies into the parent room — there is no thread persistence model.

## Summary (Calendar)

Calendar is the more ambitious surface and consequently the rougher one. The backend implements CalDAV (PROPFIND/REPORT/PUT/DELETE), an in-house RRULE/EXDATE expander, a find-time engine, mail-bridged invites with RSVP tokens, and an ICS parser. Several pieces are good (basic-auth uses app passwords with scope checks, ETag preconditions on PUT/DELETE, organizer auto-pinned as accepted attendee, RSVP tokens are per-attendee UUIDs). But the recurrence/timezone story is fragile, the ICS parser is a single-pass regex implementation that silently drops a lot of valid input and over-trusts the rest, the RSVP token endpoint is unauthenticated and unrate-limited, the calendar query time-range parser uses regex over XML, and the React shell hard-codes UTC arithmetic for what the user perceives as local-time grid positions. CalDAV write-target inference (`davCalendarWriteTarget`) silently routes "self" PUTs to a null calendar so the store auto-creates one, which produces surprising behaviour for clients that POST to a specific collection URL. The frontend's drag-to-create constructs ISO strings as `${date}T${HH:MM}:00.000Z` — treating user-local input as UTC — which will mis-place events for any non-UTC user.

## Scorecard

| Area     | Security | Correctness | Features | Quality |
|----------|----------|-------------|----------|---------|
| Chat     | 3.5/5    | 3/5         | 2.5/5    | 3.5/5   |
| Calendar | 2.5/5    | 2.5/5       | 3/5      | 3/5     |

## Findings — Chat

### C1: WebSocket frames have no per-connection rate limit or backpressure
`apps/helix/src/platform/chat/routes.ts:134-148` parses and dispatches every inbound frame with `void handleInboundMessage(...)`. A single open socket can flood `send`/`typing`/`read` frames; each `send` is an unbounded `INSERT` plus a fan-out `publish`. The only ceiling is Zod's `body.max(50_000)` and `bodyFormat` whitelist. Add a token bucket per socket (one for writes, one for typing) and a max in-flight per actor — the active-connections gauge (Follow-up B) suggests metrics infra is already wired.

### C2: `send` over WS skips classification, REST `chat.send` enforces it
The realtime path (`routes.ts:211-235`) inserts the message and publishes without invoking `options.classifyResource`. The REST tool (`chat/tools.ts:100-117`) always classifies the body. A user who types in the UI hits the WS path (per `chat-shell.tsx:275`), bypassing classification entirely. Either route both paths through a common service or call the classifier from `routes.ts` after the store insert.

### C3: Attachment object IDs accepted with no ownership/scan check
`chat/routes.ts:32` and `chat/tools.ts:38` accept arbitrary `attachmentObjectIds`. `store.ts:349-355` inserts `message_attachments` rows directly without validating that the actor owns the object, that the object exists in the same org, or that any AV/DLP scan has completed. An attacker who knows another tenant's object UUID can attach it to a chat message and have it surface through the message render path. Verify ownership + scan status before inserting.

### C4: Edit/delete authorization is duplicate-keyed and racy
`store.ts:415-444` and `:446-474` gate edits/deletes on `actor_id = $self AND exists(permissions row)`. The `exists` is on any `permissions` row for the thread by the actor — i.e., "member can edit own message". That is correct, but the `org_id` check is missing from the `exists` subquery (line 432 has no `p.org_id` constraint), so a cross-org permission row would satisfy it. Add `p.org_id = ${input.orgId}` to both subqueries.

### C5: No message ordering guarantee — clients dedupe by id only
`chat-shell.tsx:150-163` merges history (from `listMessages` newest-first, reversed) with live WS frames into a Map keyed by id, then sorts by `sentAt`. There is no monotonic sequence number from the server; if two messages share `sent_at = now()` from concurrent writers (clock resolution or DB precision), client ordering becomes nondeterministic across reloads. Add `seq bigserial` to the messages projection (or use a stable tiebreaker like `id` ASC) and order by `(sent_at, seq)` everywhere.

### C6: No backfill on reconnect — missed messages stay missed
The graceful-shutdown path (`routes.ts:105-117`) sends `{type:"reconnect"}` and closes the socket. The client (`use-chat-realtime.ts:126-131`) just flips state to `closed` and stops. There is no replay-since-cursor protocol; messages published while the socket was closed are silently lost until the user re-opens the room and TanStack Query invalidates. Add a `since` cursor or sequence on `subscribe`, and return all events from the bus replay buffer (Redis stream / outbox tail) since that cursor.

### C7: Presence TTL is server-side only; client UI never expires entries
`realtime.ts:153-167` correctly drops Redis presence entries past their `ttlSeconds`. But the frontend (`use-chat-realtime.ts:240-265`) only mutates presence on explicit `presence.joined` / `presence.left` / `presence` frames. A client that never receives a fresh roster will show a stale "online" dot indefinitely. Subscribe should re-request a roster on a heartbeat, or the server should push a periodic full roster.

### C8: Reactions are visible only to the actor who added them
`chat-shell.tsx:144-148, 282-294` keeps reactions in `localReactions` state. The realtime bus does not publish a `reaction.created` event, and the `listMessages` projection does not include reactions (only `chat.search`'s record does — `store.ts:891-919`). So if Alice reacts, Bob never sees the heart. Fix the projection to include reactions and emit a bus event on `react()`.

### C9: Read-count UI undercounts when messages arrive between reloads
`view-model.ts:222-243`'s `readCountFor` uses `orderedIds.indexOf(receipt.lastReadMessageId)`. If a peer's last-read points at a message no longer in the current window (paginated), `indexOf` returns -1 and they're silently dropped from "seen by". This is technically correct, but combined with C5/C6 it under-reports systematically. Use `lastReadAt` timestamps as a fallback comparison.

### C10: Typing indicator on the channel-pane composer always uses the active room
`chat-shell.tsx:372-377` wires `onTyping={realtime.setTyping}` to the channel composer, but the thread reply composer (line 1086-1103) has no `onTyping` at all — replying in a thread produces no typing indicator at all. Either thread the typing-actor through the parent message id or accept the gap and document it.

### C11: Thread panel is decorative — replies go to the room, not a thread
`chat-shell.tsx:1049-1051` comment is candid: "Threads share the room channel — replies post into the active room." The "Reply in thread" button (line 818-827) opens a UI panel that visually frames a parent message but no `parentMessageId` is sent to the server, no `messages.parent_id` column exists, and no separate listing is rendered. This is a missing feature, not just a stub. Either add a `parent_id`/thread root model or remove the panel.

### C12: Pinned / Files / About info tabs are static empty states
`chat-shell.tsx:1213-1219` renders "No shared files yet." / "No pinned messages yet." unconditionally. No query, no API call. Same for the toolbar `Bold`/`Italic`/`Link`/`List`/`Code`/`Paperclip`/`Smile`/`Sparkles` buttons in the composer (`:949-992`) — none of them have handlers. Either implement or hide.

### C13: `chatRealtimeUrl` puts the access token in the query string
`chat/api.ts:273-281` calls `addAccessTokenSearchParam` so the JWT lands in the URL. The Fastify access log (and any upstream proxy log) will record `/ws/chat?access_token=...`. Use the `Sec-WebSocket-Protocol` header negotiation pattern, or a short-lived single-use ticket exchange (`POST /ws/chat/ticket` → opaque token), to keep the long-lived JWT out of access logs.

### C14: `requireSocketRoomAccess` runs on every frame — no positive subscription state
`routes.ts:182, 238, 250, 267` re-hits `selectRoomForActor` for every WS frame. A user holding 10 sockets each subscribed to 10 rooms produces a DB round-trip per keystroke (`typing`). Cache the room-access decision in the `subscriptions` map (which already exists) and invalidate on the bus `permission.revoked` event you'll need anyway.

### C15: Search is `ILIKE`, no FTS, no permission re-check on the subject path
`store.ts:544-572` is a substring `ILIKE` over `t.subject` and `m.body`. Two issues: at scale this is unindexed full-table scan; and the join through `threads.subject` exposes any subject the actor could resolve — which is fine here, but the `created_by_actor_id = $actor or exists(permissions...)` predicate again omits `org_id` from the permissions subquery. Add `p.org_id = ${input.orgId}` (same as C4).

### C16: WS schema accepts a `presence` frame but server doesn't enforce subscription
`routes.ts:268-269` answers a `presence` query for an arbitrary room id with no prior `subscribe` — `requireSocketRoomAccess` is checked, so the ACL holds, but a malicious actor can probe room ids cheaply by sending presence frames and watching errors vs rosters. Either require `subscribe` first, or normalize the error so existence is not observable.

## Findings — Calendar

### CAL1: CalDAV basic auth — passwords decoded but never compared with constant-time
`apps/helix/src/platform/calendar/routes.ts:251-267` decodes `Authorization: Basic` and forwards to `store.authenticateAppPassword` (`store.ts:521-562`). The store uses `verifySecret(input.password, row.hash)` for comparison (good, presumably constant-time), but the `lower(a.email) = lower(${username}) or a.id::text = ${username}` path returns multiple candidate rows and short-circuits at the first match — meaning timing leaks the presence of an email by how many bcrypt comparisons run. Order is non-deterministic; tighten to one candidate per identifier.

### CAL2: RSVP endpoint is unauthenticated, unrate-limited, token-only
`routes.ts:40-57` accepts any `/dav/cal/rsvp/:token` GET and changes attendee state. The token is a UUID stored in `cal_attendees.rsvp_token`. A leaked email forward, mail-server log, or scanner-prefetch on inbox URLs will silently flip RSVPs (`?response=declined`). Use POST with a CSRF-style confirmation page, or require a click-then-confirm flow. Also rate-limit per token to prevent enumeration.

### CAL3: ICS parser regex `parseIcsDate` is permissive and silently lossy
`routes.ts:803-846` and `recurrence.ts:182-198` each have their own date parser. The route parser interprets `DTSTART;VALUE=DATE:20260521` as all-day **with timezone "UTC"** (line 810) which is wrong (all-day is timezone-free in iCalendar; pinning it to UTC will shift the visual date for non-UTC users by up to a day). Floating local times (no `TZID`, no `Z`) are treated as UTC. Use a real parser (e.g. `ical.js`) or document the floating-time policy explicitly.

### CAL4: ICS parser DoS — unfolding allocates O(n²) for a worst-case input
`routes.ts:754-766` calls `lines[lines.length - 1] = previous + line.slice(1)` per continuation line, which is O(n²) string concatenation. A 5 MB ICS body of all-continuation lines pegs a CPU core. Cap body size (`addContentTypeParser` does not bound it) and switch to a chunked builder.

### CAL5: RRULE expander caps iterations at 3660 and silently truncates
`recurrence.ts:40-78` uses `maxIterations = Math.max((rule.count ?? 0) + 366, 3660)` and breaks on overflow with no diagnostic. A daily RRULE without UNTIL spanning >10 years will silently stop emitting. Free/busy and find-time will produce false-available slots beyond that horizon. Either expand on demand to the query window's actual horizon, or surface a "truncated" signal up to callers.

### CAL6: Recurrence weekly BYDAY ignores `BYHOUR`/`BYMINUTE`, anchors to event start UTC components
`recurrence.ts:140-161` builds occurrences as "start of UTC week + day*86400000ms" then copies UTCHours/Minutes from `eventStartsAt`. This is wrong across DST transitions for events stored in a real timezone: e.g. a 9 AM US/Eastern weekly event will drift by an hour in March/November because the calculation never consults `event.timezone`. Compute occurrences in the event's TZID.

### CAL7: All-day events lose their datelessness on the way out
`store.ts:251-287` stores `starts_at`/`ends_at` as `timestamptz` even when `all_day = true`. The ICS round-trip `formatIcsDateOnly` (`ics.ts:345-347`) just slices the ISO; for `2026-05-21T00:00:00-04:00` stored as `2026-05-21T04:00:00Z`, `formatIcsDateOnly` emits `20260521`, but for `2026-05-21T20:00:00-04:00` (organizer in a positive-UTC zone) it'll emit `20260522`. All-day must be stored as a date string or as midnight-of-tz with explicit handling.

### CAL8: CalDAV PUT inferred write target collapses unknown calendars to "self"
`routes.ts:380-382`'s `davCalendarWriteTarget` returns `null` whenever the URL's calendar segment equals the actor id. `store.createEvent` then auto-creates a default calendar (`store.ts:204-205`) instead of erroring. A client PUTting to `/dav/cal/<some other actor uuid>/<event>.ics` will silently create or update inside the wrong collection. Validate that `calendarId` is a known calendar the actor can write to, or 404.

### CAL9: CalDAV REPORT time-range parsed by regex over XML
`routes.ts:384-398` does `/<[^>:\s]*:?\s*time-range\b(?<attributes>[^>]*)\/?>/iu` against the raw body. Any client that places `<C:time-range>` inside a CDATA block or with a non-trivial namespace prefix will be silently misparsed. Use an XML parser (the project already ships through Fastify with content-type parsers).

### CAL10: Find-time emits aggregate `busy: []`, drops per-attendee identification
`store.ts:432-440` returns slots whose `busy: []` is always empty. The tool serializer (`tools.ts:330-338`) maps `slot.busy` through, but since busy is empty, the UI cannot show "Bob is busy at 2 PM." Either populate the conflict array or remove the field from the public contract.

### CAL11: Scheduling find-time iterates one slot per `stepMinutes` regardless of working hours
`store.ts:828-856` does not consult working-hours or attendee TZ preferences. `freebusy.ts:findAvailableSlots` does have a `workingHours` parameter, but it isn't passed through from `findTime`. The tool (`tools.ts:318-329`) also drops it. Wire working hours end-to-end or it will propose 3 AM meetings.

### CAL12: RSVP reply path skips org-isolation check
`routes.ts:40-57` calls `store.respondToEvent({ rsvpToken: token, ... })`. The store's token branch (`store.ts:336-341`) updates any attendee with that token regardless of org. The token space is 122 bits of randomness so practical collision is nil, but a server-side log or backup leak of one org's tokens lets a cross-org caller mutate state without ever proving org membership. Add `org_id` scoping in the update or sign the token.

### CAL13: ICS generator emits `STATUS:CANCELLED` for soft-deleted events but reuses the same UID
`ics.ts:143-145` and `store.ts:299-303` send a CANCEL with the original UID — correct for iCalendar — but `recurrenceExceptionDates` (`recurrence.ts:83-93`) reads `metadata.caldav.exdate`. After a cancellation, exdates are not propagated to attendees' CalDAV clients which re-PUT a copy with no exdates, effectively un-cancelling occurrences on the server's next round-trip.

### CAL14: ICS attendee parser drops everything that isn't `MAILTO:user@host`
`routes.ts:965-980` lowercases the whole value to test the `mailto:` prefix and slices using `.length`. Mixed-case schemes (`Mailto:`) work; uppercase mailbox names are correctly preserved (slice from the original `propertyValue.value`). Good. But `ATTENDEE;CN="Alice"` with a non-mailto URI (e.g. `urn:`) is silently dropped — fine for invite roundtrips, surprising for resource bookings.

### CAL15: Frontend drag-to-create constructs UTC ISO from local-clock input
`calendar-shell.tsx:307-316` builds `${date}T${decimalHourToClock(start)}:00.000Z`. The `Z` claims UTC. The user dragged a slot at 2 PM in their local TZ. The event lands at 2 PM UTC instead — which renders as 10 AM EDT or 5 AM PDT on next load. Either set `timezone: Intl.DateTimeFormat().resolvedOptions().timeZone` and drop the `Z`, or convert local→UTC before formatting.

### CAL16: Calendar grid `decimalHourForIso` uses UTC components
`data.ts:106-109` and `:99-103` use `getUTCHours()` / `getUTCDay()` for grid placement. Combined with CAL15, the whole timeline operates in UTC; a user in IST and a user in PDT looking at the same event see it placed at different times of day, but the day header label is "Mon" in both. The grid needs a single resolved display timezone (user preference or browser default) and all positioning should be derived from that.

### CAL17: Calendar event list and find-time over-broad query — recurring events without window match
`store.ts:464-465` includes `or e.recurrence_rule is not null` in the window predicate, which is correct but pulls every recurring event ever for an actor on every list. With the iteration cap (CAL5) and no per-recurrence index, large mailboxes will see latency cliffs. Either bound the search by `e.starts_at < ${endsAt + maxLookback}` or store an expanded-occurrence projection.

### CAL18: `MiniMonth` is hard-coded to May 2026
`calendar-shell.tsx:579-647` hard-codes `"May 2026"`, today=21, and a fixed 35-cell layout with offset `index - 3`. Today's date in this project is set via env, but the mini-month never moves. Either drive it from the same `state.date` the main grid uses, or delete it.

### CAL19: RSVP URL leak via mail subject/Text body
`ics.ts:247-260` writes the accept/decline URLs as plain text in the mail body. The token is now in the recipient's mail provider, IMAP backup, and any forwarded message. Mitigations: short-lived signed URLs, single-use tokens, or click-through confirmation pages (also helps CAL2).

## Findings — CardDAV (calendar invite dependency)

### CD1: CardDAV uses the same `parseBasicAuthorization` code path duplicated
`carddav/routes.ts:517-533` is byte-for-byte the same function as `calendar/routes.ts:251-267`. Factor into `apps/helix/src/platform/auth/basic.ts` to avoid drift; both should add constant-time decoding and a length cap on the decoded buffer (currently unbounded).

### CD2: vCard parser is line-oriented and unfolds nothing
`carddav/store.ts:317-337` splits on `\n` and matches `VERSION:`/`UID:`/`FN:`/`EMAIL:` by upper-case prefix. RFC 6350 vCards may use line-folding (a continuation line beginning with a space). Any field that exceeds the wrap-at-75-octet recommendation will be silently dropped, including legitimate FN/EMAIL produced by Apple Contacts.

### CD3: `valueForProperty` returns the first match, ignores `EMAIL;TYPE=HOME` vs `EMAIL;TYPE=WORK`
`store.ts:341-354` returns whichever EMAIL appears first; a real contact with multiple typed emails has them collapsed. For calendar attendee resolution this means RSVP routing picks an unpredictable address. Either store the full vCard JCard or pick the `PREF` / `TYPE=WORK` one explicitly.

### CD4: CardDAV REPORT body parsed with the same XML-regex pattern as CalDAV
`carddav/routes.ts:450-457` and CAL9 share the same shortcut. Same fix applies.

---

**File sizes worth flagging for refactor:** `calendar-shell.tsx` (1819 LOC), `calendar/routes.ts` (1016 LOC), `calendar/store.ts` (1033 LOC), and `chat/store.ts` (964 LOC) are all past the point where a single reviewer can hold them in their head. The chat shell at 1224 LOC is also large but has clearer internal sectioning. Split the calendar shell into sidebar / week / popover / dialog modules, and lift the ICS read/write code out of `calendar/routes.ts` entirely into `calendar/ics.ts` (which currently only writes).

**Shared util duplication:** `parseBasicAuthorization`, `xmlEscape`/`xmlUnescape`, `reportHrefs`, `propfindDepth`, and `headerString` are duplicated between `calendar/routes.ts` and `carddav/routes.ts`. The CalDAV `parseIcsDate` is duplicated between `routes.ts` and `recurrence.ts`.

**Missing types at the WebSocket boundary:** `routes.ts` declares `ChatSocket` locally instead of importing from `@fastify/websocket`; `parseChatRealtimeEvent` in the frontend casts JSON to `ChatRealtimeEvent` with no runtime guard beyond `typeof type === "string"` — malformed payloads can crash event handlers. Adopt a Zod schema (mirroring the backend's `inboundMessageSchema`) on the client side.
