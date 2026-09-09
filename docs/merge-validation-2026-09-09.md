# Workspace v1 integration validation — 2026-09-09

This integration combines local snapshot `29b1575` with GitHub main `10a4377`.
Both contained needed changes; all 267 merge conflicts were resolved. Workspace
package versions are 1.0.0. This records code integration, not production certification.

## Product scope

Mail, Drive storage, Chat, Calendar, Meet, Assistant, Admin, CLI, and MCP remain.
Document editors, file viewers, Office conversion, PDF editing, related routes,
plugins, styles, schemas, tools, fixtures, and dependencies have been removed.
There are no optional editor packages or SheetJS compatibility inputs. Release
provenance binds the workspace and its images without requiring a sibling repository.

Drive supports file upload, folders, immutable versions, sharing, downloads,
retention, quarantine, and WebDAV. Unknown upload states do not enable downloads.
Raw downloads apply export permissions, including recording restrictions.

CLI and MCP use actor-bound credentials, scoped authorization, confirmation
policy, structured errors, and discovery. Removed editor commands and resources
are absent. Mail changes preserve newer draft revisions, reconcile ambiguous
saves, consume the saved revision transactionally, and retain provider feedback.

## Verification

- Repository formatting, TypeScript, lint, and builds. Unit tests include 3,005
  backend, 822 web, and 107 CLI assertions, plus SDK/config/contract suites.
- Browser flows for active apps and removed routes returning 404. APIs are mocked;
  the real external SMTP browser test remains explicitly skipped.
- 168 accessibility checks with zero findings across light/dark themes and
  mobile/tablet/desktop, including
  Calendar and Meet headings, keyboard scrolling, and mobile controls.
- Fresh Postgres 18 migration replay through `0183`; existing database upgrade
  removes retired tables and updates authorization, search, and sensitivity triggers.
- 230 database-backed auth, agent identity, draft, delivery, and cleanup tests.
- 256 Drive, storage-schema, and adversarial tenant-isolation tests with Postgres.
- Helm rendering, dependency boundaries, release-evidence validation, production
  configuration contracts, dependency policy, and supply-chain checks.
- Production dependency audit: zero critical/high, one moderate, two low;
  no audit exceptions. Editor/converter dependencies are absent from the lockfile.

Earlier local integration checks exercised signed logical and versioned object
backup restoration. Those predate the storage cleanup and are not final-schema
production recovery evidence.

## Deployment limits

External email delivery, production DNS/DKIM, a real Jitsi media call, sustained
load, off-host/PITR recovery, and production rollout still require deployment
verification. Calendar/Meet enablement retains the configured production profile
and dependency gates. No production v1.0 release tag is implied by package versions.
