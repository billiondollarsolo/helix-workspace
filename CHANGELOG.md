# Changelog

All notable changes to Helix Workspace are documented here. This file follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Drive folders have a details panel to rename and share them; people added to a folder get
  access to everything inside it.
- Drive Home suggests recently updated folders and files from across Drive.

### Changed

- ClamAV is now a Helix-built image (`infra/clamav`) promoted like SpamAssassin, so the
  pinned upstream image can take patched Alpine packages first. Production Compose requires
  `HELIX_CLAMAV_IMAGE` with an immutable `helix-workspace-clamav` digest.
- Dependency images move to Go 1.26.9, Alpine 3.24.2, PostgreSQL 18.6, Redis 8.8.3,
  RustFS 1.0.0, OpenSSL 3.5.8, and patched Go modules in NATS, Cerbos, and Caddy; the
  scanned inventory now matches the Compose pins.

### Fixed

- Drive folder access grants can be changed and removed, not only created.
- The Drive file details panel resets its rename field when another file is selected.
- Drive version restore asks for confirmation, skips the current version, and reports the result;
  rename reports success or the server's error.
- Renaming an unknown Drive file reports a file error instead of an unknown folder.
- The Drive share dialog closes with Escape and focuses the people field when opened.
- Local startup supports rrule's CommonJS export and existing Meilisearch indexes;
  mail retention uses the database clock for its default cutoff.
- Fresh demo setup supplies current identity, Calendar, Chat, and Mail delivery
  fields, creates the tenant before its users, and verifies the actual login handler.
- Assistant routines are covered by forced tenant row-level security like every other
  `org_id` table; the table was created after the RLS sweeps and shipped without it.
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
