# Demo data

`pnpm --filter @helix/app db:seed:demo` builds **Quillfeather Labs**, a
fictional logistics-software company (product: _Waypoint_, domain
`quillfeather.example`), in the local default tenant
`00000000-0000-4000-8000-000000000100`. It is the only seed in the repository:
local development, screenshots, end-to-end tests and the CI demo-data smoke all
use it.

Everything goes through the same store functions the API uses, inside the same
tenant row-level-security context, so the data obeys the product's invariants:
Drive and Mail bytes are staged, malware-scanned by ClamAV and committed under
the tenant's storage prefix (`tenants/<org>/`), storage usage is accounted,
every write leaves its audit and outbox entries, and mail arrives through the
real inbound and outbound paths with SPF, DKIM and DMARC evidence.

## Signing in

| Account                                         | Password               | Who                                              |
| ----------------------------------------------- | ---------------------- | ------------------------------------------------ |
| `admin@helix.local`                             | `helix-admin-password` | Avery Park, IT & Workspace Administrator (admin) |
| `user@helix.local`                              | `helix-user-password`  | Riley Chen, Senior Product Manager               |
| anyone else (`first.last@quillfeather.example`) | `helix-demo-password`  | the rest of the company                          |

The seed prints the full sign-in list in its summary. Avery and Riley also
receive mail at their `@quillfeather.example` addresses. A few accounts are
deliberately not usable: some are suspended, some former employees are
offboarded (their Drive, mail and calendars were handed to their manager), and
some invitations were never accepted.

The local OAuth client `helix-local-oauth-client` / `helix-local-dev-secret`
acts as Avery, so API, MCP and k6 smokes see the same workspace.

## What is in it

- **People and directory:** departments and teams with managers, org units,
  pronouns, job titles, locations, deterministic profile photos, working hours
  and time zones; all-staff and team groups, distribution lists such as
  `support@`, `sales@` and `billing@`, security groups and social clubs.
- **Mail:** internal threads with replies and forwards, external customer and
  vendor correspondence, newsletters, promotions, receipts and invoices with
  PDF, CSV and PNG attachments, security notices, spam, calendar invitations
  (imported through iMIP), nested coloured labels, filters, signatures, starred,
  snoozed, archived and trashed mail, drafts, scheduled sends and one vacation
  responder. Mail from the last few hours went through the outbound queue.
- **Drive:** a company shared drive and one per department, personal files,
  version history, comments, stars, internal shares and public links, a trash
  with a 30-day retention policy, and a few multi-megabyte data exports.
- **Chat:** company, department, team and social spaces, an announcements
  space, direct and group messages over months, threads, reactions, mentions,
  pins, edits, deletions and varied unread state. Attachments are added only
  when object storage has server-side encryption, which chat requires.
- **Calendar and Meet:** recurring 1:1s, stand-ups, weeklies and all-hands,
  one-off meetings, external invitations, holidays, out-of-office and focus
  time, mixed RSVPs, shared and coloured calendars, working hours, and Meet
  rooms on most meetings, including finished meetings with participants and
  meetings later today.
- **Contacts:** customers, vendors and personal contacts with labels, and a few
  duplicates waiting to be merged.
- **Assistant:** past conversations with tool calls, citations of real mail,
  files and events, and feedback, recorded as the local test model
  (`helix-e2e-model`). Nothing calls a model provider.
- **Admin:** security policies (MFA, sessions, external sharing, DLP), app
  passwords, S3 access keys, reviewed third-party OAuth apps, service accounts
  with issued credentials, outbound webhooks with a delivery log, retention
  policies, a legal matter with a hold, notifications, and the audit history
  all of the above produced.

History reaches back more than two years and ends at the moment of seeding, so
"today" always has meetings and unread mail.

## Presets

| `--size`           | People | Drive files | Mail messages | Chat messages |   Typical time |
| ------------------ | -----: | ----------: | ------------: | ------------: | -------------: |
| `small` (CI)       |     60 |        ~120 |          ~700 |        ~1,500 |       ~2.5 min |
| `medium` (default) |     80 |        ~300 |        ~1,900 |        ~3,200 |         ~6 min |
| `large`            |    120 |      ~1,900 |       ~10,000 |       ~25,000 | 30 min or more |

Times include the final validation and are for a 4-core development machine;
Postgres is the bottleneck.

## Running it

The seed needs Postgres (migrated), RustFS, ClamAV and, for search, Meilisearch,
all on loopback addresses; it refuses to run with `NODE_ENV=production`.

```sh
export MAIL_CLAMAV_ENABLED=true MAIL_CLAMAV_HOST=127.0.0.1 MAIL_CLAMAV_PORT=28460
pnpm --filter @helix/app db:seed:demo -- --size small
```

`scripts/dev-up.sh --seed` does this for the local stack (`DEMO_SIZE` picks the
preset), and `pnpm quality:live-demo-data -- --execute` starts throwaway
services, migrates and seeds them.

Run the seed with the same `HELIX_SECRET_ENCRYPTION_KEY` (or `BETTER_AUTH_SECRET`)
and `MEILI_INDEX_UID` as the API, so the API can read the seeded webhook and S3
key secrets and searches the index the seed filled.

| Option            | Effect                                                                   |
| ----------------- | ------------------------------------------------------------------------ |
| `--size <preset>` | `small`, `medium` (default) or `large`.                                  |
| `--reset`         | Delete the demo tenant first: rows, stored objects and search documents. |
| `--accounts-only` | Only the tenant, people, sign-ins, domains, groups and account states.   |

The seed is deterministic: the same preset produces the same people, subjects,
messages and files. Timestamps are placed relative to the minute the seed runs,
so scheduled mail, snoozes and today's meetings are always ahead of you.
Running it again on an already-seeded tenant of
the same preset only re-validates it. A seed that was interrupted is reset and
started over automatically. A different preset, or an org the seed did not
create, needs `--reset`.

## Validation

Every run ends by checking what it built and fails loudly if anything is off:

- content counts per area against the preset's floors;
- every stored object (Drive versions, mail sources and attachments) exists in
  tenant storage at its recorded size, and every file has a clean scan;
- every Drive file loads with its contents the way search does;
- one pass of the Drive maintenance worker, after which storage accounting has
  nothing left to correct;
- a full search reindex of Mail, Drive and Calendar and a Drive reconciliation
  pass, both clean (Chat is indexed by the API's event indexer when it starts);
- the audit hash chain verifies;
- the documented sign-ins accept their passwords.

The live integration test `src/db/demo-seed/seed.integration.test.ts` runs the
`small` preset on a fresh database and asserts this validation.

## Resetting

```sh
pnpm --filter @helix/app db:seed:demo -- --reset --size small
```

`--reset` removes only the demo tenant. Other tenants in the same database are
left alone.
