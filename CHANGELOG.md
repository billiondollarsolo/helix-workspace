# Changelog

All notable changes to Helix Workspace are documented here. This file follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- PostgreSQL deployment for CloudNativePG: the Helm `Cluster` now runs
  `helix-workspace-postgres-cnpg`, a digest-pinned CloudNativePG `minimal` PostgreSQL 18.6 operand
  with pgvector 0.8.5 built from the same pinned source as the Compose image
  (`infra/postgres/Dockerfile.cnpg`), built, scanned, and published by the Production Image
  Security workflow. The chart's bootstrap SQL creates `vector`, `pgcrypto`, and `pg_trgm` and the
  Helix role model as the superuser, managed roles reconcile the runtime logins, and migrations run
  as the non-superuser `helix_migrator`. The migration Job gets the owner credential
  (`external.postgres.migrationUrlSecret` or the CloudNativePG owner Secret), pins the operator CA,
  and runs post-install on a first CloudNativePG install while waiting for the cluster
  (`migrations.databaseWaitSeconds`).
- Database prerequisite checks: the migration runner and production application replicas verify
  PostgreSQL 18, pgvector 0.8 or newer, and the required extensions, and explain the SQL to run
  instead of failing with `permission denied` part-way through the migrations. New
  `HELIX_MIGRATION_DATABASE_WAIT_SECONDS`.
- A "Database" section in the production deployment guide and the Helm README covering the
  supported paths, extension and role bootstrap, external PostgreSQL requirements, and pgvector
  upgrades.
- Contacts app (`/contacts`, in the app launcher and the phone More sheet): an A–Z list of your
  contacts with email, phone, job title and labels, sorted by first or last name; select several
  to label, export or delete them (with Undo), or star and edit one from the row. A contact page
  shows every email, phone, address, birthday and note with Email, Chat (for people in your
  organization), Schedule and Copy. Create and edit contacts with any number of emails, phones
  and addresses, a birthday, notes, labels and a picture. Labels can be created, renamed and
  deleted. Import vCard (.vcf) or CSV files from other contacts apps after a preview of what will
  be imported, export as vCard, merge contacts that share an email or phone, browse your
  organization's Directory and add people to your contacts, and recover deleted contacts from
  Trash for 30 days. Shortcuts: `c` create, `j`/`k` move, `x` select, `e` edit, `#` delete.
- Contacts are the same vCards CardDAV clients sync, and labels are their categories. New
  `contacts.*` tools (`contacts.list`, `.get`, `.create`, `.update`, `.trash`, `.restore`,
  `.purge`, `.merge`, `.duplicates.list`, `.import`, `.export`, `.labels.list`, `.label.create`,
  `.label.rename`, `.label.delete`, `.label.apply`, `.directory.list`) under the new
  `contacts.read` and `contacts.write` permissions, which every member holds; `helix contacts …`
  in the CLI.
- Settings works like a "Manage your account" page: a Profile home with shortcuts to Personal info,
  Security, Language & region and App passwords, sections grouped under Account, Preferences and
  Apps, and a search box that finds sections and individual settings. On phones, Settings opens on
  the list of sections and each section has a back button.
- Profile photos: add a PNG, JPEG or WebP picture, crop it to a square and zoom in the browser, and
  remove it again. Photos are resized to 256 pixels before upload and show in the people directory.
- Language & region saves your time zone (searchable), date format, 12- or 24-hour clock, start of
  week and working hours. "Automatic" follows your device.
- Security lets you change your password with a strength hint and an option to sign out of other
  devices, lists your signed-in devices with "This device" and last activity, and signs out one
  device or all others.
- App passwords: create one for a mail, calendar, contacts or file app, limited to what you can
  already do; it is shown once with a copy button and the server details for SMTP, CalDAV, CardDAV
  or WebDAV. The list shows when each was last used, and revoking asks first.
- Everyone in an organization can read and change their own profile and preferences through the
  built-in Member role. People who can read or write calendars can also see free/busy and answer
  invitations.
- Meet has a pre-join screen: preview your camera and microphone, turn them on or off, pick
  devices, see who you're joining as, accept the recording notice and choose Join now. Your
  choices carry into the call and are remembered on this device.
- `/meet?code=…` (the Join link on calendar events) opens that meeting's pre-join screen, and
  the code box accepts a pasted meeting link as well as a code.
- Meet's "Today" list shows today's calendar events that have video conferencing, plus meetings
  already running, each with Join. "New meeting" offers Start an instant meeting, Create a
  meeting for later (with a link to copy) and Schedule in Calendar, which opens the event editor
  with video conferencing added (`/calendar?create=event&conference=meet`).
- In a call, Meeting details shows the joining link with Copy.
- Helix AI answers cite the mail threads, files, chat rooms and events they drew on, each linking
  to the item, and any answer can be regenerated.
- When too many Helix AI tool groups are on for one request, the reply says how far over the
  limit it is and offers one-click "Turn off <group> (count)" buttons that retry. The tool menu
  shows each group's tool count, how many are on out of the limit, and "Choose automatically".
- The Helix AI side panel takes a question or a suggestion and opens it as a new chat.

- Mail labels: create, rename, recolour (24 named palette colours) and nest your own labels, and
  delete a label with its sublabels. Label lists show unread counts.
- Mail search understands `from:`, `to:`, `cc:`, `subject:`, `label:`, `in:` (including
  `in:anywhere`), `category:`, `has:attachment`, `is:unread`, `is:starred`, `filename:`,
  `before:`/`after:`, `older_than:`/`newer_than:` and quoted phrases, across every folder except
  Spam and Trash.
- An All mail view, and a Scheduled view that lists scheduled sends; you can move a scheduled send
  to another time, or cancel it to get it back as a draft.
- Mail thread rows list up to four participants with "me" for you, and message reads include each
  attachment's name, size, type, inline flag and a download link (passive images can show inline).
- Personal preferences: language, time zone (taken from your browser until you choose one), date
  and time format, week start, working hours, and the Mail reading pane, density and conversation
  view (`account.preferences.get` / `.set`, `helix account preferences`).
- Account security: change your password (optionally signing out everywhere else), see your signed-in
  browsers and devices, and sign out any of them. People can now create, list and revoke their own
  app passwords without admin rights; creating one needs a signed-in web session.
- Chat unread and @mention counts per conversation and a Mentions feed (`chat.unread.list`,
  `chat.mentions.list`, `helix chat unread|mentions`).
- "Add video conferencing" on new calendar events creates a Meet room and stores its join link on
  the event when Meet is configured.
- Appearance offers a System theme that follows the device's light or dark setting, and is now the
  default. Density choices are Default, Comfortable, and Compact; Compact fits more rows on screen.
- Confirmation messages appear in the bottom-left corner and can offer Undo.
- Shared interface building blocks for menus with typeahead and submenus, right-click menus
  (also Shift+F10), popovers, split buttons, loading placeholders, empty and error states with
  Retry, a "1–50 of 1,234" pager, a keyboard-friendly date and time picker, side panels, and
  keyboard-driven selectable lists (j/k, x, Shift-click ranges).
- Avatars and labels draw from a 24-colour palette that stays readable in light and dark themes,
  and text everywhere follows the Text size setting.
- Keyboard shortcuts work across the workspace. Press `?` for the full list, `/` to search the
  current app, and `g` then a letter to jump: `i`/`s`/`t`/`d` for Inbox, Starred, Sent, and
  Drafts; `c` Calendar, `k` Chat, `r` Drive, `h` Meet. Mail supports `c`, `j`/`k`, `o`/Enter,
  `u`, `x`, `s`, `e`, `#`, `!`, Shift+I/Shift+U, `r`/`a`/`f`, and ⌘/Ctrl+Enter to send.
  Calendar supports `d`/`x`/`w`/`m`/`a` views, `t`, `j`/`k` or `n`/`p`, `c`, `e`, Delete, and Esc. Drive supports
  `n` (new folder), Shift+U (upload), and Delete (move to trash). Chat supports Esc to close a
  thread and Alt+↑/↓ to switch conversations. Shortcuts pause while typing and while a dialog or
  menu is open. Settings → Keyboard shortcuts lists them all and can turn single-key shortcuts off.
- Mail search box looks through all your mail with operators such as `from:` and `has:attachment`
  and shows "Search results"; Search options builds the query from From, To, Subject, Has the
  words, Date within, Search in and Has attachment.
- Mail actions (archive, delete, read/unread, move, label, snooze, spam) update the list at once and
  offer Undo; `z` undoes the last action. Snooze offers Later today, Tomorrow, This weekend, Next
  week (following your working hours) or a date and time.
- Mail list: participants such as "Samara, me (3)", bold unread conversations, red "Draft",
  select-all with Read/Unread/Starred subsets and "Select all N conversations", a right-click
  (Shift+F10) menu, dragging conversations onto folders and labels, sender avatars on or off, and a
  reading pane right of or below the list. Category tabs show only in the Inbox.
- Mail sidebar in the familiar order with Scheduled, a "More" section (All Mail, Archive, Spam,
  Trash, categories), and labels with colours, nesting, unread counts and a ⋮ menu (Label color,
  Edit, Remove label, Add sublabel). The Label menu offers Create new and Manage labels. `g a`
  opens All Mail.
- Conversations collapse read messages and fold long threads into "N older messages"; message
  headers show the contact card, "to me, Samara", the full date and how long ago, with Reply and a
  ⋮ menu (Forward, Print, Show original, Mark unread from here). Attachments show as chips with
  name and size that download, with "Download all". The toolbar adds Mark as unread, Move to,
  Labels and "3 of 76 ‹ ›".
- On phones, Mail rows show sender, subject, snippet and date, Compose floats over the list, and a
  conversation opens full screen with a back button.
- People picker: pick recipients by name or email from your organization's directory, your
  contacts and groups, as chips. Enter, Tab or a comma adds a chip, Backspace removes the last one,
  pasting a list adds one chip per address, and invalid addresses show in red. Starting a direct
  message in Chat now uses it instead of asking for an actor ID.
- Admin console search: one box at the top of every admin page finds users, groups, and settings
  ("dkim", "legal hold", "mfa") and opens the right page and tab.
- Admin app pages for Calendar, Meet, and Assistant. Each app page starts with a switch that turns
  the app on or off for everyone, and its own workspace settings: invitation import on Calendar,
  the meeting server status on Meet, and models and workspace search on Assistant.
- The audit log filters by date range, actor, event, and outcome on the server, shows each event
  in plain words with its outcome, and opens the full record, raw JSON included, in a side panel.
- Person cards: hover or focus a person in the Contacts side panel to see their photo or initials,
  email and job title, with Send email, Chat, Schedule a meeting and Copy email actions.
- The Contacts side panel shows avatars, job titles and "Group" or "Contact" labels instead of raw
  source names, and searches people and groups as you type. The people directory now returns each
  entry's job title and organization member, so a personal contact for a colleague links to them.
- Search finds content, not just commands. ⌘K lists matching mail, files, chat messages, events
  and people under the command matches, and the top search box opens a `/search` results page
  with app filter chips. In an app with its own search (Mail, Drive) the box searches that app.
- The settings cog opens a Quick settings drawer for theme and density, with a link to all
  settings. The other theme toggles in the top bar and account menu are gone.
- The hamburger collapses each app's sidebar to an icon rail on desktop and remembers the choice.
- Help opens a menu with keyboard shortcuts, documentation and About Helix.
- Notifications are grouped by app with unread dots, Mark all read and an empty state.
- The account menu is an account card with "Manage your account" and Sign out.
- Phones get a bottom bar with four apps and a More sheet, show the app title in the top bar,
  and no longer reserve space for the side-panel rail.
- An offline banner spans the top of the workspace while the device has no connection.
- "New email" and "Schedule meeting" in ⌘K go to `/mail?compose=new` and
  `/calendar?create=event`.

- Calendar rework. Day, 3-day, Week (with or without weekends), Month and Schedule views show
  the full 24 hours with sticky day headers and an all-day row, open scrolled to the current
  time, and mark only the real today. Click or drag on empty time for a quick create with
  "More options"; drag events to move them, drag the bottom edge to change their length, or use
  Alt+arrow keys. The full editor has a date and time picker, an all-day switch, plain-language
  repeat choices (including a Custom repeat with an interval, weekdays and an end), guests from
  the people picker, "Add video conferencing" (creates a Meet room), notifications as a number
  and unit, calendar, Busy/Free, and a Find a time tab that shows each guest's busy times side by
  side with suggested free slots. Event details show the repeat, a Join button, guests with their
  replies and the organizer, and "Going? Yes / No / Maybe". Deleting and moving offer Undo. The
  sidebar has a mini month and "My calendars" / "Other calendars" with colours, show/hide, and
  sharing for calendars you own. Phones get 3-day and Schedule views and a Create button. The
  calendar follows your week start, working hours, time zone and 12/24-hour clock from your
  account preferences. Video conferencing can also be added when editing an existing event
  (`calendar.event.update` accepts `conference: "meet"`).
- `calendar.free-busy` tool: busy blocks (no event details) for up to 20 organization members over
  a window of up to 14 days, for the Calendar's Find a time view.

- Drive accepts S3 commands. An S3-compatible gateway at `/v1/s3` lets the AWS CLI, rclone, boto3,
  and the AWS SDKs list, upload, download, copy, and delete Drive files, including multipart uploads,
  ranged downloads, and presigned URLs. It maps the buckets `my-drive` and `shared-with-me` onto
  Drive, and `/`-separated keys onto Drive folders, which it creates when it needs them. The gateway
  authenticates with AWS Signature V4, including the aws-chunked streaming uploads that the AWS CLI
  sends. Every request runs through the normal Drive pipeline: actor permissions, malware scanning,
  DLP, quotas, versions, trash retention, and the audit trail. Users create, list, and revoke their
  own S3 access keys in Settings → S3 access keys (`helix drive s3-keys` lists and revokes them);
  the secret is shown once. Admins can list every key in the org. The org setting `drive_s3_api` (on by default) turns
  the gateway off. See `docs/drive-s3-api.md`.

- Drive folders have a details panel to rename and share them; people added to a folder get
  access to everything inside it.
- Drive Home suggests recently updated folders and files from across Drive.
- Admins can turn on "Import calendar invitations from email" (`calendar_import_invitations`,
  off by default). Inbound iMIP `REQUEST` invitations then land on each addressed recipient's
  default calendar as awaiting a response, with the external organizer recorded; newer
  `SEQUENCE` updates apply, and `CANCEL` cancels the imported event. The import sends no mail,
  skips spam-routed messages and events the recipient already has, ignores calendars over
  1 MiB or 1,000 VEVENTs, and never fails mail delivery.
- Drive works the way long-time Drive users expect: sort by name, last modified, last modified by
  me, last opened by me or file size (folders stay on top); Type, People and Modified filter chips;
  a list/grid switch; checkbox selection with Shift ranges and a selection toolbar ("2 selected").
- Drive right-click menus (also Shift+F10 and each item's ⋮) with Download, Share, Copy link,
  Rename, Move, star, File information and Move to trash, applied to the whole selection.
- Drag files and folders onto a folder, a breadcrumb or My Drive to move them, or use Move to pick
  a folder with the keyboard. The current folder's name opens a menu with its actions.
- Drive's New menu offers New folder, File upload and Folder upload (folders keep their
  structure), with a floating New button on phones. A bottom-right panel shows each upload's
  progress, its security scan ("Scanning…"), a clear message when a file is blocked, Cancel and
  Retry, and "N uploads complete".
- Sharing in Drive: add people by name or email with Viewer, Commenter or Editor, change or remove
  access, and set general access to Restricted, Anyone at your organization's domain, or Anyone
  with the link. Copy link and Done close it out.
- Drive's details panel has Details and Activity tabs: type, size, location, owner, dates, who
  has access and version history.
- Drive Trash has Restore, Delete forever and Empty trash (all confirmed), and a banner with the
  real retention period. Trash now lists trashed files from every folder.
- Trash, move and rename show Undo. Drive shortcuts add `a` (details), `s` (star), Enter
  (open or download), F2 (rename), Shift+I (folder upload) and Shift+F10 (actions).
- The Drive sidebar shows how much storage you use, and the organization limit when an admin set
  one.
- Mail compose opens as a docked window you can minimize, expand to full size, or stack with
  other drafts (full screen on phones). It has recipient chips with Cc/Bcc, a formatting
  toolbar, plain text mode, emoji and links, attachment chips that show upload and malware-scan
  status, and Send ▾ with Schedule send presets (from your time zone and working hours) or any
  date and time. Messages autosave to Drafts, and ⌘/Ctrl+Enter sends; ⌘/Ctrl+Shift+C and B add
  Cc and Bcc.
- After sending, a snackbar offers Undo (reopens the message) and View message; scheduled sends
  link to the Scheduled view.
- Replies open inline at the end of the conversation with "To: …" recipient chips you can edit,
  a menu to switch between Reply, Reply all and Forward or to edit the subject, and forwards
  that include the original attachments (or not, if you untick them).
- Settings → Mail with General, Labels, and Filters and blocked addresses tabs; link to a tab
  with `?settings=mail/<tab>`. General holds conversation view, reading pane, density, the
  signature and the vacation responder (first and last day, subject, message). Labels lists your
  labels as a tree with New label, Edit (name, "Nest label under", 24 colours) and Remove.
  Filters are created in two steps, with a count of matching conversations before you choose
  what happens to new mail; blocked addresses can be added and unblocked there.
- Mail filters can mark matching mail as read and star it (`markRead`, `star` actions).
- Admins can suspend and restore a person from the Users ⋮ menu, the API
  (`/api/admin/users/:actorId/suspend` and `/restore`) or `helix admin users suspend|restore`.
  Suspending signs them out everywhere and stops sign-in, app passwords, S3 access keys and other
  API credentials until they are restored; both changes are audited. The Users list shows each
  person's status and last sign-in (`lastSignInAt`), which replaces the Added column.
- Rate any saved Helix AI answer thumbs up or down, with an optional comment on a thumbs down
  (`assistant.message.feedback`). Feedback is private to you and audited without its text.
- Drive uploads and Mail compose attachments show how much has been sent as a percentage.
- Chat has a "+ New chat" menu: Start a chat (pick one person for a direct message or several
  for a group conversation), Create a space (name, description, and restricted or open to
  everyone in the organization), and Browse spaces to join open ones.
- Chat navigation shows Home (conversations with unread first), Mentions, Direct messages and
  Spaces; unread conversations are bold with a count, @mentions show an @ badge, and opening a
  conversation marks it read.
- Chat conversations open at the newest message with an "Unread" divider, date dividers
  ("Today", "Yesterday", "Monday, 3 March"), grouped messages from the same sender, and a
  "Jump to newest" button when new messages arrive while you read older ones.
- The Chat composer is one line that grows: Enter sends, Shift+Enter adds a line, @ suggests
  members, and it adds formatting (bold, italic, strikethrough, code, link, list), emoji,
  attachments and Start a meeting, which posts a Meet link.
- Message actions in Chat: react with a quick reaction or any emoji, reply in a thread (with
  "N replies · time" under the message), forward to your inbox, copy a link, pin, and edit or
  delete your own messages. Threads open in a side panel; Esc closes it.
- Chat search: the top search box searches messages in all conversations or the open one, and
  a result opens its conversation at the message.
- Chat on phones starts with the conversation list; a conversation opens full screen with Back,
  and a floating New chat button.
- Chat keyboard shortcuts: Alt+Shift+↑/↓ for the previous or next unread conversation, and
  Ctrl+Alt+Shift+↑/↓ to jump to the first unread or the newest message.
- Chat messages carry `lastReplyAt` next to `replyCount`, and Chat Markdown renders
  `~~strikethrough~~`.

### Changed

- **Breaking (Helm chart 1.0.0):** CloudNativePG values changed. Replace `cloudnativepg.imageName`
  with `cloudnativepg.image.{repository,digest}` (PostgreSQL 18 operand), rename
  `backup.barmanObjectStore.wal.additionalCommandArgs` to `wal.archiveAdditionalCommandArgs`, and
  rewrite `recovery.externalClusters` entries as `{name, barmanObjectName, serverName}`. Backups now
  need the Barman Cloud Plugin. See "Upgrading to chart 1.0.0" in the Helm README; PostgreSQL 17
  clusters must be restored into a new PostgreSQL 18 cluster.
- The production image-pinning check is deployment-aware through a required
  `HELIX_DEPLOYMENT_KIND` (`compose` or `helm`, set by `docker-compose.production.yml` and the
  chart; missing or unknown fails closed). Compose still requires all eight pinned images; Helm
  requires `HELIX_IMAGE` from an approved repository (`ghcr.io/billiondollarsolo/helix-workspace`
  or `-fips`). The chart's default `image.repository` and the sovereign FIPS repository now use
  those official names.
- The Helm migration Job gets its own NetworkPolicy (DNS and PostgreSQL egress only;
  `networkPolicy.migrate.egress.endpoints` for an external server) and every Helix pod receives
  `HELIX_IMAGE` from the selected image digest.
- CloudNativePG backups use the Barman Cloud Plugin (`ObjectStore`, `method: plugin`, plugin
  recovery sources) instead of the deprecated in-core `barmanObjectStore`.
  `cloudnativepg.imageName` is replaced by `cloudnativepg.image.{repository,digest}`, WAL arguments
  move to `wal.archiveAdditionalCommandArgs`, and `recovery.externalClusters` entries take
  `name`, `barmanObjectName`, and `serverName`. `pnpm infra:helm:validate` also checks the
  CloudNativePG resources against their CRD schemas.
- Calendar invitations for events with a Helix Meet call carry the join link: a "Join with Helix
  Meet" link in the email (text and HTML), the link in the event description and in an empty
  location, and RFC 7986 `CONFERENCE` plus `X-GOOGLE-CONFERENCE` in the `.ics`. The link is an
  absolute address on `HELIX_PUBLIC_URL`. Invitations imported from mail keep the organizer's
  meeting link (`CONFERENCE`, `X-GOOGLE-CONFERENCE` or `URL`), shown in the event as a plain link
  that opens outside Helix, never as a Helix room.
- `POST /api/admin/search/reindex` queues a reindex of your organization and answers 202 with the
  job, whose progress `GET /api/admin/search/reindex/jobs/<id>` reports; a second request while one
  runs returns that job. `helix reindex --all` follows the job and prints progress for up to 30
  minutes (`--max-wait <seconds>`), and `helix reindex --status <job-id>` checks it later, so a
  large reindex no longer times out in the CLI. Migration 0216.
- Meet is unavailable until both Jitsi secrets (`MEET_JITSI_JWT_SECRET` and
  `MEET_JITSI_WEBHOOK_SHARED_SECRET`) are configured, in every environment; there is no built-in
  development secret any more. Meet then says so: administrators see what to configure, members
  whom to ask (`meet.status`). `.env.example` and the CI end-to-end environments set local values.
- CLI commands with flags accept `--json` as well: the JSON is the base input and each flag sets,
  and overrides, its field.
- A person's own CLI login (`helix login`) can carry `profile.read` and `profile.write` from their
  membership, so `helix account preferences` and `helix account app-passwords` work. Agent and
  service credentials still get only the scopes they were issued. Creating an app password or an
  S3 access key from the CLI now says to do it in Settings on the web instead of showing a bare 403.
- Settings → S3 access keys offers, and ticks by default, only the Drive scopes you hold; the list
  reports them as `grantableScopes`.

- Helix AI answers keep the workspace items they cited after you reload. Only references are
  saved, and each item is shown only while you can still open it, title included.
- Sign-in asks for your email first, then your password (or sends you to your company sign-in when
  your domain uses one), with Show password and Forgot password. A wrong email or password always
  gets the same message, so the page never reveals whether an account exists. The demo account
  buttons appear only in development builds.
- Invitation, email verification and app-authorization pages use the same centred sign-in card.
- Settings deep links (`?settings=<section>` or `<section>/<tab>`) work on every app and stay open
  while you move around inside the app.
- Chat's conversation details (about, members, pinned) stay closed until you open them from the
  header, and people are added with the people picker. Retention, legal hold and history
  settings are no longer offered when creating a conversation; admins manage them in Admin.
- Helix AI picks its tools automatically until you choose tool groups, so a fully scoped admin's
  first prompt no longer fails.
- Helix AI shows friendly model names; admins see the model id on hover. Chats are searched from
  the top bar, the list is denser with a pin icon and ⋮ menus, "Forget memory" moved into a
  Memory menu and asks first, and the new-chat page fits phones.
- Meet's home page uses original wording, skeleton, empty and error states, and Meet's top-bar
  search searches the whole workspace. In-call colours follow the dark theme tokens, and the
  Leave button is red.
- Compose always starts a blank message; drafts are resumed from Drafts.
- Blocked senders moved from the Mail signature page to Settings → Mail → Filters and blocked
  addresses; the separate Mail signature settings page is gone.
- The admin console navigation is grouped into Home, Directory, Apps, Security, Reporting, and
  Account, and every admin page shares one layout. Feature switches moved from Workspace settings
  to the app they affect, and on/off settings use switches throughout.
- Admin lists show people and groups with avatars, roles, status, and a ⋮ menu for each row
  (edit profile, mail addresses, reset sign-in verification, remove access, delete group), support
  selecting several rows, and turn into cards on phones. Times read "3 hours ago" with the exact
  time on hover, sizes read "5 GB", and empty limits read "Unlimited".
- Workspace settings shows the organization's name, with its ID behind a copy button.
- Every quota (storage, AI tokens and images, actors, outbound webhooks, integration API
  requests per second, export jobs per hour) defaults to unlimited, and agent and AI cost
  budgets have no default for any security tier; an org admin may still set a cap (ADR-0030).
  Sovereign stays local-AI-only.
- Organizations can always create public Drive share links for anyone with permission, and
  BYO storage needs no feature flag.
- A suspended tenant now answers `423 Locked` (code `tenant-suspended`) with a message that
  says how to restore access.
- The `assistant_retrieval` tenant flag (default on) now governs the Assistant's automatic
  workspace search context: when an admin turns it off, the server runs no mail, chat, Drive
  or calendar search for Assistant turns. Admin › Workspace settings shows each flag's
  effective value, so a default-on flag no longer appears off until saved.
- Usage metering keeps AI tokens, AI images, storage and export metrics only.
- Live E2E runs give the API a deterministic OpenAI-compatible model
  (`apps/web/tests/e2e/support/fake-model-server.ts`), so the assistant spec sends a
  prompt and checks the streamed provider answer instead of only the no-model state.
- ClamAV is now a Helix-built image (`infra/clamav`) promoted like SpamAssassin, so the
  pinned upstream image can take patched Alpine packages first. Production Compose requires
  `HELIX_CLAMAV_IMAGE` with an immutable `helix-workspace-clamav` digest.
- Dependency images move to Go 1.26.9, Alpine 3.24.2, PostgreSQL 18.6, Redis 8.8.3,
  OpenSSL 3.5.9, and patched Go modules in NATS, Cerbos, and Caddy; the scanned inventory now
  matches the Compose pins (RustFS stays on 1.0.0-beta.12 until 1.0.0 passes its health check).

### Removed

- `infra/scripts/v1-phase-artifact-gate.test.mjs`, an unwired structural test that still required
  removed editor artifacts (`editor-perf-budget.ts`); the R3 go/no-go script no longer lists it.
- The `/api/people/contacts/*` import, export, update, delete and merge routes; the `contacts.*`
  tools replace them. `/api/people` and `/api/people/autocomplete` are unchanged.
- Unused tenant feature flags `ai_smart_compose`, `dlp_enforcement` and `watermark` from the
  contract, admin API and Workspace settings: there is no compose assist, DLP is configured
  by the `dlp` security policy, and nothing renders watermarks. Migration
  `0205_drop_unused_tenant_flags_and_metering_metrics.sql` strips them, and every other
  retired flag key, from stored org feature flags.
- The seat, API-call and collaboration-session metering event types and their rollup keys
  from `@helix/sdk-types`, the rollup worker and signup; nothing else emitted them. Migration
  0205 deletes their stored events and rollups.
- ADRs 0020, 0021, 0024 and 0026; what still holds is folded into ADR-0030.
- The CI step that cleared the demo org's `api_rps_limit` before the k6 load test.
- Retired editor (`docs.*`, `sheets.*`, `slides.*`), `imap` and other unknown permissions
  still left in the database permission catalog. Migration
  `0203_retire_unknown_iam_permissions.sql` retires every catalog permission the app does not
  know: roles that held only retired permissions are removed after each grant (and any
  delegated beneath it) is recorded as revoked in the append-only delegation log; other roles
  and stored credential and token scopes lose just those entries, and a credential left with
  no scope is revoked. A stale entry previously made the whole stored permission set fail
  closed. A live test now keeps the database catalog equal to the app's scope catalog.

### Fixed

- Migrations could not run as a non-superuser owner: the CloudNativePG path failed on
  `CREATE EXTENSION vector` and production Compose on migration 0090's role DDL. Migration 0090 now
  only verifies roles that the superuser bootstrap provisioned (and still creates or repairs them
  when the migrator is a superuser), with identical resulting privileges.
- Production Compose no longer lets the development role script give `helix_worker` and
  `helix_readonly` well-known passwords; the production bootstrap creates them without one.
- The CloudNativePG `Cluster` rendered invalid `pvcTemplate` metadata and WAL
  `additionalCommandArgs`; PVC annotations now travel through `inheritedMetadata`.
- Two people uploading through the S3 API into the same new folder of a shared folder get one
  folder, not two: folder creation is serialized per parent folder rather than per person.
- Signed-in devices name Chromium, Edge and headless Chrome correctly instead of "Safari".

- Meetings added to Calendar events can be joined: the first invited person to join opens the
  scheduled meeting, instead of getting "No meeting is open with that code".
- Mail you read in Helix keeps its text colour, highlight, size, weight, style, underline,
  alignment and indent. Only those inline styles with plain values are kept; anything else in a
  style attribute is still removed.
- A tool that needs confirmation (such as creating an app password) no longer fails after you
  approve it when your permission comes from a role rather than your own account scopes.
- Opening an invitation link no longer shows the "Choose a new password" step.
- Dates and times no longer fail to render when the browser reports an unusual language tag.
- When Chat can't reach the server it says so with Retry, instead of "Offline" and an empty
  placeholder room with a working composer. The composer no longer covers the newest messages.
- Opening a Chat thread shows its replies.
- Drive trash now keeps items for the retention period an admin set (30 days by default) instead
  of always 30 days. Items already in trash keep at least their original recovery window.
- When a session must be verified again, the page goes to sign-in once. Requests that were already
  waiting no longer reach the server with the expired session or flash errors first.
- Retry on "We couldn’t load this view" no longer sometimes leaves a blank page when the server
  comes back.
- The "Active" status and the "Created" notice for app passwords and agent credentials are
  readable in dark mode.
- With Helix AI's Evidence panel open, menus such as the composer's options no longer close by
  themselves when the conversation updates.

- Mail search no longer looks only in the Inbox's Primary tab, the Label button no longer toggles
  just the first label, Spam uses a report icon, the empty pager no longer says "No results", and
  `?settings=` links on /mail keep the settings page open. Mail shows loading placeholders, a
  Retry on load errors, an empty state per folder, and list rows no longer nest buttons inside
  buttons. "Filter messages like these" opens the filter dialog with the sender filled in instead
  of creating an archive filter without asking.
- The API no longer stops answering after the Drive grid/list toggle. Signing in no longer holds
  identity locks for the whole request, and Drive layout, star and other database-only changes stay
  in the request's own transaction.
- The Assistant no longer fails with "Too many Assistant tools are selected" for fully scoped
  admins. Without an explicit choice it picks the most relevant tool groups up to the provider
  limit; an explicit choice over the limit returns `assistant_tool_limit_exceeded` with the groups
  to turn off.
- The scenarios seed runs again on the current calendar and chat schema.
- One-time secrets are no longer stored with confirmed tool actions. App passwords, agent
  credential secrets, Drive share-link tokens, and Drive S3 secret keys used to be saved in the
  pending action's result (and the idempotency replay cache), and `actions.get` could fetch them
  again. Tools now declare their secret output fields (`sensitiveOutputKeys`): the approval
  response still shows the secret once, and every stored copy keeps a redacted placeholder.
- Confirmed tool actions that ran successfully are recorded as executed. Before, they were stored
  as failed with "Pending action did not execute.".
- Request logs no longer include the `X-Amz-Signature`, `X-Amz-Credential`, or
  `X-Amz-Security-Token` values of presigned URLs.

- Inbound mail is stored again: the receiver crashed summarizing DMARC for senders with no
  DMARC record (mailauth omits `alignment`), and raw-source integrity always failed because
  ingest and verification parsed with different mailparser options. Both answered 451.
- External mail sends work with Cerbos: the composite `mail.external` scope is checked against
  the actor's grants, as tool scope composition intends, instead of the tool policy, which has
  no rule for it and denied every external send.
- Single-tenant default orgs get the default object-store namespace at boot, as SaaS
  provisioning gives every org, so Drive uploads and inbound mail evidence have storage on a
  fresh install.
- Approved sends from API credentials keep the actor's email, so the default From address is
  the sender's mailbox instead of `<actor-id>@localhost`.
- Approved mail sends from the CLI and other API callers succeed: the compose tools accept the
  request `Idempotency-Key` header (kept across approval) as the send's idempotency key.
- `helix mail reply` takes `--to`, which API and agent replies must set so the approval shows
  who receives the reply.
- Outbound mail with inline attachments, including calendar invitations, is delivered: dispatch
  read staged mail attachments through Drive access checks, which never cover them.
- Staged mail attachments keep their filename and Content-ID on the object and record a clean
  scan, so received attachments show their names.
- Calendar RSVP links use `HELIX_PUBLIC_URL` like the rest of the app instead of
  `http://localhost:3000` when only that is configured.
- The Assistant works again for fully scoped members: Meet tools get their own opt-in tool
  group, so the default groups stay within the 128-tool limit instead of failing every turn
  with "Too many Assistant tools are selected".
- Drive folder access grants can be changed and removed, not only created.
- The Drive file details panel resets its rename field when another file is selected.
- Drive version restore asks for confirmation, skips the current version, and reports the result;
  rename reports success or the server's error.
- Renaming an unknown Drive file reports a file error instead of an unknown folder.
- The Drive share dialog closes with Escape and focuses the people field when opened.
- OAuth client lookups work for the constrained runtime database role: `agent_credentials`
  had only the restrictive tenant boundary, so forced RLS hid every row and the token
  endpoint answered "Unknown OAuth client". Migration 0201 adds the permissive tenant
  policy, and the boot-time RLS coverage check now rejects any tenant table without one.
- The live demo data job runs its API in the demo org and points authenticated k6 at the
  versioned `/v1` API, so tool, MCP, and search scenarios hit real routes instead of 404s.
  The k6 metrics scenario now polls once a second instead of saturating the API.
- Search reindex keyset cursors keep PostgreSQL's microsecond precision, so rows
  that share one millisecond (bulk seeds and imports) no longer return the same
  page forever and stall demo preparation.
- Local startup supports rrule's CommonJS export and existing Meilisearch indexes;
  mail retention uses the database clock for its default cutoff.
- Fresh demo setup supplies current identity, Calendar, Chat, and Mail delivery
  fields, creates the tenant before its users, and verifies the actual login handler.
- Assistant routines are covered by forced tenant row-level security like every other
  `org_id` table; the table was created after the RLS sweeps and shipped without it.
- Drive no longer replaces the whole view with an error page when a member without
  `admin.drive` loads it; the optional storage meter now hides on a permission error.
- Inbound spam scanning half-closes its spamd request; spamd otherwise waited out its 30s read
  timeout, so every scan hit the client's 10s timeout and mail went unscanned.
- The standalone OAuth and login seeds create their tenant on a fresh database.
- CI builds workspace packages before tests and jobs, creates the S3 contract bucket for
  live e2e, and its mocked browser suites match BetterAuth's signed-out session response.
- Oversized Drive web tests, unused exports, and stale third-party notices no longer
  fail the source-quality gates.

## [1.0.0-rc.1] - 2026-09-10

### Added

- Release scope, licensing, release checklist, and a workflow for RC drafts and
  evidence-gated final release drafts.
- Production CSP with isolated mail rendering, configured Jitsi origins, and an
  external appearance bootstrap.
- Full PostgreSQL/RLS and RustFS CI suites with unexpected-skip rejection, plus
  generated route freshness verification.

### Changed

- Drive stores, shares, and downloads files without document editors or converters.
- The invite-only 1.0 profile includes Mail, Drive, Chat, Assistant, and Admin.
  Calendar and Meet remain dormant implementations outside that release claim.
- Hardened tenant isolation, authentication, administration, mail delivery,
  storage, dependency images, and release evidence binding.
- Split server startup, Drive/Mail stores, database schemas, and web shells;
  centralized shared helpers and enforce formatting, file-size, and dependency gates.

### Removed

- Editors, editor integrations and search types, public signup stubs, and the
  installable plugin runtime. Built-in webhook formatters remain available.
- Duplicate icons, obsolete dependencies, production test fixtures, and tracked
  screenshots of retired features.

### Fixed

- Mail threading and mailbox visibility use canonical recipient deliveries;
  Calendar invitations create mail threads instead of reusing event threads.
- Domain capabilities use canonical ownership challenges and reject foreign
  claims; tenant constraints preserve actor rules and couple newly added references.
- WebDAV records the correct audiences for uploads, moves, and deletions.
  Raw mail evidence remains immutable, and Mail/Meet attachments retain snapshots.
- Outbound mail no longer strands a leased send silently; failures include
  actionable diagnostics and the runbook covers stuck queues.
- Core-app status respects `HELIX_APPS`, and cross-tenant checks execute their
  complete live database suite.

This initial changelog is seeded from the integration milestone `9b3f6cd` and
its preceding readiness work (`29b1575`, `bfd4e3c`, `10a4377`, `546b1e3`, and
`aad4592`). Package version `1.0.0` is not a release claim; no GA is recorded
until its signed tag and complete final evidence packet exist.
