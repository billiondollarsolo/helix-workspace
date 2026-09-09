# ADR-0007: Fail-closed untrusted uploads

- **Status:** Accepted
- **Date:** 2026-07-28
- **Plan decision:** RD-7

## Context

Helix accepts file bytes through browser upload, multipart upload, WebDAV, mail attachments, and
agent-accessible storage flows. MIME sniffing alone does not detect malware. The current Drive
scanner factory can resolve to a no-op adapter, and scanning a complete object in process memory is
not safe for large files.

Making bytes available before a clean verdict would expose downloads, previews, shares, indexing,
mail attachments, and agents to untrusted content. Treating scanner outages as clean would convert
a dependency failure into a security bypass.

## Decision

Business-tier uploads fail closed. Incoming bytes remain in an isolated, unavailable state until
integrity checks and a real malware scanner return a clean verdict.

Before a clean verdict, a file cannot be downloaded, previewed, shared, attached to mail or chat,
indexed, served through WebDAV, or read by agents. Infected files remain quarantined. Scanner
errors, timeouts, unsupported verdicts, and exhausted retries also remain quarantined.

Scanning must be streaming and bounded. The UI exposes processing and quarantine states.
Administrators receive audited retry and removal controls. Production boot for the Business tier
must reject a no-op scanner.

## Alternatives considered

- **Allow access with a warning while scanning:** rejected because users and agents can consume or
  redistribute the file before the verdict.
- **Treat scanner failure as clean:** rejected because it creates a predictable fail-open bypass.
- **Rely on MIME sniffing:** rejected because content type is an integrity signal, not malware
  detection.
- **Buffer whole files in application memory:** rejected because it creates denial-of-service and
  scaling risk.

## Consequences

- Upload completion and file availability are separate asynchronous states.
- Every retrieval and sharing surface must check the active/clean state.
- Scan jobs need durable idempotent state, bounded retries, monitoring, and backlog alerts.
- Mail and Drive should share a low-level real scanner client while retaining domain-specific
  verdict policy.
- EICAR, scanner-outage, restart, and large-stream tests are required launch evidence.

## Reversal triggers

Any policy that exposes unscanned Business-tier content requires a new owner-approved ADR, explicit
risk acceptance, surface-by-surface isolation evidence, and controls that prevent users and agents
from consuming or redistributing the bytes before verdict.
