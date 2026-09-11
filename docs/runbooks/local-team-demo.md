# Local ten-person team demo

The additive `local-team-demo-v1` dataset represents a fictional Harbor pilot team.
It uses the existing local workspace organization
`00000000-0000-4000-8000-000000000100`. Avery, Riley, local-admin, their passwords,
and their existing content are preserved. All ten new accounts have member
permissions; account administration stays with the existing administrators.

Open <http://localhost:5173> and sign in with one of these accounts. The initial
password for these **local fictional accounts** is `helix-team-demo-password`.
If someone changes a password or profile, rerunning the seed preserves that edit.
The generated handoff lists initial credentials, not recovered passwords.

| Person       | Login                   | Role                  | Actor ID suffix |
| ------------ | ----------------------- | --------------------- | --------------- |
| Samara Malik | demo.samara@helix.local | Product lead          | 001             |
| Theo Brooks  | demo.theo@helix.local   | Platform engineer     | 002             |
| Imani Reed   | demo.imani@helix.local  | Product designer      | 003             |
| Jun Park     | demo.jun@helix.local    | Application engineer  | 004             |
| Elena Costa  | demo.elena@helix.local  | Customer success lead | 005             |
| Omar Haddad  | demo.omar@helix.local   | Operations engineer   | 006             |
| Nora Patel   | demo.nora@helix.local   | User researcher       | 007             |
| Luca Rossi   | demo.luca@helix.local   | Finance partner       | 008             |
| Priya Shah   | demo.priya@helix.local  | Security engineer     | 009             |
| Mateo Silva  | demo.mateo@helix.local  | Communications lead   | 010             |

Actor IDs use `10000000-0000-4000-8000-000000000` followed by the listed suffix.
Each profile includes pronouns, a job title, and a short work biography.

## What is populated

- Mail: 20 three-message exchanges, inbox/sent state, read/unread variation,
  stars, and ten editable drafts. These are persisted examples; the seed does
  not send SMTP traffic or establish external mail-domain ownership.
  It adds a synthetic `helix.local` domain fixture for local internal delivery,
  with verified identity/mail capability and an active receiving binding. This
  reserved local name does not represent a public DNS ownership check.
- Drive: 34 actual Markdown, CSV, and text files in 13 personal/shared folders.
  Each new file passes the normal prepare/upload/finalize path with a real
  ClamAV clean verdict before becoming available. The file bytes live in RustFS.
- Chat: five project rooms and ten pair conversations, with 80 example messages.
  An existing DM for a pair is reused, preserving its existing messages.
- Assistant: three saved conversations per person, each with four messages;
  the planning conversation is pinned. Replies are clearly marked synthetic
  fixtures, so they demonstrate saved history without claiming model execution.
- Calendar: a work calendar per person and 30 focus/review/follow-up events,
  starting from the supplied anchor date in America/New_York.
- Directory: three groups covering product, engineering, and pilot planning.

Samara, Theo, and Imani share **Harbor launch decisions** and **Harbor private
launch working files**. Mateo is outside both. Every person can access **Harbor
team lounge** and **Harbor team resources**, while personal notes remain private.

The private room ID is `10000003-0000-4000-8000-000000000003`; its folder ID is
`10000001-0000-4000-8000-000000000102`. The `private-decision` file's generated
object ID is included in the JSON handoff. All deterministic IDs and fixtures
are declared in `apps/helix/src/db/local-team-fixtures.ts`.

## Seed and verify

Run from the workspace root with Node 24 and the existing local services running.
The CLI rejects production mode and non-loopback database/storage endpoints.
It requires an existing migrated organization and does not run the older reset
demo seed. Loading `.env` below uses the existing local service credentials.

```bash
set -a
source .env
set +a
export NODE_ENV=development
export DATABASE_URL="postgres://${POSTGRES_USER:-helix}:${POSTGRES_PASSWORD:-helix_dev_password}@127.0.0.1:28432/${POSTGRES_DB:-helix}"
export RUSTFS_ENDPOINT=http://127.0.0.1:28437

docker compose -p helix-team-seed-scan --profile mail-security up -d --wait clamav
pnpm --filter @helix/app db:seed:team --anchor-date 2026-09-10 --output /tmp/helix-local-team-accounts.json
pnpm --filter @helix/app db:verify:team
```

The scanner uses the repository's pinned image on loopback port 28460. Keep it
running: the local app also uses it to scan new Drive and Chat uploads.
Omit `--anchor-date` to use today's UTC date for newly inserted content;
existing events and messages retain their dates. `--accounts-only` creates the
ten identities, profiles, and local delivery configuration without requiring a
scanner. An absent tenant storage selection becomes local Helix-default storage;
existing selections are preserved. Seed and verification use the same tenant
storage resolver as the running app, including its configured object-key prefix.

The JSON handoff is created with mode 0600 and includes accounts, resource IDs,
and content-free scanner evidence from the current run. The verifier is read-only:
it checks fixture counts, available scan state, real bytes and hashes, and the
private Drive owner/editor/outsider boundary. If a person deliberately removes a
fixture or changes its sharing, verification reports that difference.

The seed serializes concurrent runs, rejects identity collisions, and preserves
existing rows. It neither resets credentials nor restores revoked grants on a
rerun. New resource IDs stay stable through fixture keys; Drive object IDs are
allocated by the normal upload service and then reused.

## Local AI testing

The local Groq provider was configured through Admin's AI provider form. Its
default chat model is `openai/gpt-oss-20b`; `openai/gpt-oss-120b` also returned real
streamed replies. The configured `llama-3.3-70b-versatile` returned HTTP 404 from
Groq for this account, so it is not the default. Provider credentials stay in the
server-side configuration and are not part of this runbook or the account handoff.

Assistant supports Markdown, highlighted code with Copy, message Copy, and user
Edit/Resend. Editing starts a new saved branch and preserves the original chat.
File context currently supports scanned UTF-8 text/code files, up to five files,
512 KiB each and 1 MiB total, with a 100,000-character context limit. Image and PDF
understanding are not implemented.

Conversation history is saved on the server. Each model request currently uses
the latest 24 messages, including tool messages, and rechecks access to attachments
in that history. Model selection can change without starting a new conversation.
Older messages remain saved but are omitted from the model context; automatic
summarization and token-based history budgeting are not implemented. Cross-chat
memory is separate and opt-in.

Temporary backend failures preserve cached identity and conversation drafts.
They do not revoke the database-backed login session. Explicit sign-out, session
expiry/revocation, and configured admin reauthentication still apply. See
[HTTP request rate policy](../architecture/request-rate-policy.md) for separate
browser, admin, integration, and authentication limits.
