# Atlas development MCP exercise — 2026-10-14

Follow-up: the [second round](2026-10-14-atlas-mcp-round2.md) records additional
live checks, deployed fixes, and the earlier email request's verified expiry.

Atlas is a persistent agent owned by Mike Johnson, with its own
`atlas@workspace.helixapps.si` mailbox, an Atlas Test Workspace folder, and a
private Atlas and Mike chat. Its scoped runner credential expires on
2026-11-13; bounded automation for its own test files and chat expires on
2026-10-21. External email has no automation grant and requires Mike's decision.
The identity and private runner state are retained. No continuous agent process
or autonomous reply loop was installed.

This is a development exercise against public HTTPS, not the OAuth A7 release
gate or a certification of every registered tool. The deployment advertises
126 scoped tools and three prompts. Supported MCP protocol surfaces were
exercised: initialization, notifications, ping, tool discovery/calls, resource
discovery/reads, and prompt discovery/rendering.

## Live results

- A 97-byte UTF-8 text file was uploaded using the returned HTTPS URL and signed
  headers, scanned, finalized, and read through an MCP resource with matching
  bytes and checksum. Folder creation, rename, move, listing, immutable version
  listing, sharing with Mike, access listing, trash, read denial while trashed,
  and restore with exact bytes preserved passed.
- The harmless 68-byte EICAR antivirus fixture was quarantined by the configured
  scanner. Quarantined bytes could not be read through MCP.
- Atlas sent real chat messages, and MCP read a real reply authored by Mike.
  Thread replies, reactions and removal, pin/unpin, history search, export, and
  resource reads passed. A repeated send returned the original message without
  duplication. No message was authored by impersonating Mike.
- Anonymous/invalid credentials were denied. Atlas could not read Mike's private
  mail through either a tool or a resource, administer identities, or issue its
  own credential. A separate ten-minute read-only probe could authenticate,
  could not read Mail, and lost MCP access after revocation. Atlas's primary
  credential remained active; its secret was retained privately.
- The real CLI discovered MCP tools and called ping, chat history, and Drive
  listing against the public endpoint. Prompt rendering passed for all three
  prompts; this does not prove configured AI generation.

Starring a valid agent-owned file initially returned a misleading not-found
error. Stars are deliberately stored against human memberships. The shared
store now returns an actionable forbidden error explaining that boundary,
without adding a human membership to an agent. Both the live denial and the
real PostgreSQL regression passed.

## Browser changes and validation

Mail and Chat unread counts now appear in the desktop rail and phone navigation
across workspace pages. The Mail event subscription lives in the shared shell;
Chat counts and the notification bell retain their existing 30-second refresh.
Unconfirmed apps stay hidden until configuration arrives, so unavailable Meet
and AI entries do not flash during startup.

A pending `mail.send` returns a human review URL. Only its authorized human
owner can load the stored recipients, message and attachments. HTML is shown
as inert source. Approve and send/Deny use the existing decision routes, CSRF,
fresh authorization, input integrity, requester identity, and execution guards.
The notification opens the review page. Agent self-approval and unrelated
human/tenant reads are denied. Viewing a request never sends it, and changing
requests cannot carry an earlier decision into the new request.

Required format, type, lint, unit, build and boundary checks passed. The full
suite passed 5,488 tests with 390 skipped integration cases. The focused real
PostgreSQL preference suite passed four tests. The final browser suite passed
22 cases, including draft/focus preservation, delayed configuration without
icon flashes, cross-app unread updates, explicit approval/denial, expiry, and
decision isolation. Axe checks passed on the review and navigation in desktop
and phone light/dark configurations.

Public browser verification caught an incomplete asset upload and the resulting
cached HTML response for a missing stylesheet. The complete upload was rebuilt,
the final image asserts its stylesheet exists, and all 207 current public assets
were then checked for status, content type, and checksum against the local build.
The native browser loaded the styled login and preserved the review return URL.

## Boundaries and remaining work

The external Gmail send remains a human approval exercise. Its pending action
and delivery outcome are recorded separately; SMTP acceptance or inbox arrival
must not be inferred from creating a pending request.

The queued test is
[d59032a6-b1f2-4017-ac94-492e12427221](https://workspace.helixapps.si/approvals/d59032a6-b1f2-4017-ac94-492e12427221),
expiring at 18:19:01 UTC on 2026-10-14. The agent's approval attempt returned
404, its human-review read returned 403, and a database snapshot showed the
action still pending with zero corresponding outbound messages. A fresh Atlas
chat delivered the review link. No human decision was fabricated.

The safe companion [evidence](evidence/2026-10-14-atlas-mcp-test.json) records
108 distinct passing development checks, separate service restrictions, and the
encrypted recovery copy. Its authentication and current-runtime archive checks
passed; a new restore drill remains outstanding.

Calendar and Meet are not registered in this MVP deployment. Jitsi gates were
preserved. No configured AI generation or live Meet media was tested.
`tasks.list` is advertised but remains Assistant-context-only; the direct MCP
call returns a clear context restriction. Optional MCP resource templates,
subscriptions, GET streams, and DELETE sessions are unsupported. A cancellation
notification for an unknown completed request was accepted; active job
cancellation was not claimed as tested.

The shared actor-scoped workspace event stream is recorded in the
[quality plan](../plans/2026-10-14-workspace-quality-and-optional-ai.md).
Polling is the current fallback and cross-app Chat mechanism. The earlier
[system review](2026-10-14-system-quality-review.md) still governs open provenance,
resource budget/audit, OTP, delivery feedback, client, and production gaps.
The latest encrypted recovery copy is a development artifact and has not been
restored in a new drill.
