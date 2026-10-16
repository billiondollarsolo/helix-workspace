# Atlas MCP exercise, second round — 2026-10-14

Atlas completed 31 distinct additional live checks against the public HTTPS
development server. All latest results pass. Its identity, mailbox, private chat,
scoped credential, and private runner state remain available. No background
agent loop was installed, and no human was impersonated.

## Fixes found and deployed

The pending-action expiry worker was running outside tenant context, so row-level
security hid its records. It now enumerates live organizations and uses the
existing tenant-scoped database helper for each sweep. The global batch limits
remain bounded. A real PostgreSQL regression uses the restricted application
role, two concurrent workers, two selected tenants, and an excluded third tenant;
only the selected tenants' expired actions change.

Automation policy resource extraction omitted comment identifiers and attachment
object identifiers. Concrete comment grants could not match, and a room grant
did not account for chat attachments. The shared extractor now includes these
identifiers. Regression checks require exact comment and attachment resources;
changing an attachment is denied by the original bounded grant.

Fastify's automatic HEAD handler overwrote a declared file size with zero when
the streaming helper sent an undefined payload. The shared helper now returns
an empty stream without opening file storage. A regression reproduced the error
before the fix. Public HTTPS now reports 512 bytes with no HEAD response body.

The API is deployed as `helix/workspace-development:atlas-round2`. This round did
not change the deployed web image or database schema.

## Live results

- A scanned 512-byte binary fixture downloaded with exact bytes. Byte ranges,
  conditional requests, invalid ranges, HEAD metadata, and idempotent finalize
  all passed. Binary MCP resources intentionally describe the file rather than
  returning it as text; authenticated download verified the bytes.
- A deliberately incorrect checksum prevented publication and produced an
  actionable integrity error. The small fixture remains unavailable in
  `pending_upload`; it was not forced through scanning or retention controls.
- Atlas created, updated, resolved, reopened, and replied to its own file
  comment. Pagination and five immutable comment revisions passed.
- Atlas sent Mike a real chat message with the binary attachment, edited its
  own message, and retried the edit without creating another revision. Reusing
  the key with different input was rejected and left the stored edit intact.
- Drive pagination and malformed cursor, recipient, UUID, and limit inputs
  behaved correctly.
- The earlier Gmail approval request now reports `expired` through MCP. Atlas
  still cannot approve it. A database check found zero matching outbound
  messages; no human approval or external delivery is claimed.

The [safe evidence](evidence/2026-10-14-atlas-mcp-round2.json) records the latest
result per named check. Historical failing HEAD results were retained privately;
this is a verified correction, not a claim that every initial attempt passed.

## Verification and next work

Format, type, lint, build, and dependency-boundary checks passed. The complete
suite passed 5,494 tests; 391 database or environment-gated cases were skipped.
The focused tenant-expiry PostgreSQL case passed separately. The relevant
Playwright suite passed 22 cases, including navigation and review accessibility
in desktop and phone light/dark configurations.

The [quality plan](../plans/2026-10-14-workspace-quality-and-optional-ai.md)
now specifies a persistent **Action required** navigation count and nonblocking
human review queue. The existing notification bell and email review page remain
the current access points; the general queue is not yet implemented. Counts
must follow authorized pending actions independently of notification read state,
and opening a request must never approve it.

This exercise does not certify every advertised MCP tool. No configured AI
generation or live Meet media was tested. The previous encrypted off-server
archive predates these fixes; no new restore drill was performed.

## Full development app follow-up

Meet, Assistant, and Passwords are now enabled for development. The current API
and web images are `full-ai-fixed`; nested Meet and Passwords hostnames use
DNS-only records and trusted origin certificates. Workspace stays proxied, and
direct origin requests remain denied even with a spoofed forwarding header.

Public MCP AI generation and the REST streaming endpoint returned real OpenAI
replies using the configured model. Independent reads verified four saved
messages and the conversation list preview. Temporary Assistant write credentials
were revoked; Atlas remains active with its original scope set. Its actor-wide
request counter applies across credentials; a temporary three-request policy
was too restrictive after the earlier broad test run. No counters were reset.

The composer clears during sending, restores a failed draft, and explains when
streaming changes were not saved. Assistant navigation and settings refreshes
were corrected. Model requests now set the supported reasoning mode and omit
`tool_choice` when no tools are supplied. Quota and temporary throttling errors
are distinguished without exposing provider responses.

A saved global-provider configuration exposed inconsistent startup residency
validation. The workspace was recovered while retaining its keys. Development
now permits global AI endpoints; production retains regional processing checks,
and validation runs before saving, during reload, and at boot. Storage and Meet
residency requirements remain enforced.

Thirty-five relevant Playwright cases passed, including existing accessibility
checks. Jitsi services authenticated and TURN allocation worked; a real
two-participant media call, Jibri recording, and vault signup were not tested.
Jibri is not installed. The general Action required queue and optional Mail AI
features remain planned. See the [current deployment runbook](../runbooks/hetzner-workspace-prestage.md).

Final follow-up verification passed: format, typecheck, lint, full tests, build,
and workspace boundaries. The complete suite passed 5,508 cases and skipped
391 environment-gated cases. All 207 public hashed assets matched the final web
build. Fresh five-minute TURN credentials passed authenticated UDP and trusted
TLS allocations, with unauthenticated allocation denied and test allocations
released. [Safe follow-up evidence](evidence/2026-10-14-full-development-apps.json)
contains no credentials or private message bodies.

## CLI, MCP, and Passwords follow-up

Passwords is pinned in the shared app registry. Desktop enablement, hiding when
disabled, administrator activation, external link attributes, and phone More
navigation passed six Playwright cases with accessibility checks in light/dark
phone views. All 207 hashed public assets matched the deployed build.

The built CLI passed MCP/REST/OpenAPI discovery, tool descriptions, feature reads,
JSON-input errors, destructive-scope denial, mailbox row isolation, and real stdio
MCP forwarding. Newline and Content-Length framing, Unicode resource replies,
and prompt discovery passed. A 2,160-byte Unicode file crossed MCP preparation,
CLI signed upload, scanning/finalization, and exact MCP/CLI resource readback.
CLI Chat stdin and flag overrides, file attachment, and idempotent retry passed.
The initial attachment grant was deliberately narrow; its queued test request
was cancelled, and only the owned room/file pair was added to the test policy.

The CLI external-email request queued a human action. Agent self-approval and
human-only preview were denied. The real owner approved it; execution remained
as Atlas. One SMTP handoff was accepted by SES, and Mike confirmed Gmail arrival.
No synthetic human approval was issued by the runner.

The standalone vault passed signup and email verification, login-item creation,
secure-note creation/editing, lock, wrong-password denial, correct unlock, logout,
and fresh login with exact edited Unicode note recovery. Fixture-only storage
inspection showed encrypted fields. Both disposable vault registrations were
removed through the normal email-confirmed or authenticated deletion flows.
The temporary mailbox credential was revoked, its actor disabled, and test
password/link files removed. The persistent Atlas identity remains active.

The missing DMARC policy initially held verification mail, despite valid DKIM.
After the operator published the policy, fresh verification mail reached the
allowlisted test inbox. The old held copy retains its original evidence and
retention policy. No sender-verification or malware gate was bypassed.

Assistant checklist tools require conversation context. Their shared descriptions
now say that explicitly, and `tasks.list` points external clients to the existing
conversation read API. This preserves internal checklist execution without
introducing a separate public task service.

[Safe round-three evidence](evidence/2026-10-14-atlas-mcp-round3.json) records
passing live checks, the vault flow results, and an initial test-runner assumption:
foreign mailbox listings return no rows under RLS rather than necessarily
returning HTTP 403. The original failed expectation is preserved separately.
Required repository checks passed with 5,508 tests and 391 environment-gated
skips. The e2e code's lint/type checks also passed. Native Passwords UI/SSO,
Bitwarden extension/mobile compatibility, and a new restore drill remain
outstanding; these standalone tests do not certify those integrations.
