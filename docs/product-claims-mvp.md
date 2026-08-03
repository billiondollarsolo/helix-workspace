# Helix MVP product claims and non-claims

**Audience:** Operators, pilot admins, marketing, implementers  
**Normative plan:** `docs/superpowers/plans/2026-08-03-elite-mvp-enterprise-production.md`  
**Date:** 2026-08-03

## What Helix is (after pilot release gates pass)

A self-hostable workspace for:

- **Web email** via a managed outbound provider (SES, Postmark, Mailgun, or managed SMTP)
- **Shared file storage** with folders, versions, shares, WebDAV, and **read-only previews**
- **Authenticated organization chat** (TLS, org/room access control; server-readable)
- **Admin operations** for users, domains/DNS, policies, audit, and agent controls
- **Confirmation-gated AI/agent workflows** (reads when authorized; writes need human approval
  unless a narrowly bounded automation policy applies)

## Qualifications

| Topic                | Must-state qualification                                                                                                       |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Mail delivery        | Managed provider owns reputation, bounce, and complaint integration. Helix is not a direct-to-MX outbound MTA for this launch. |
| Mail clients         | Web UI plus REST, MCP, CLI, and related APIs. **There is no Helix-hosted IMAP server.**                                        |
| Chat confidentiality | Encrypted in transit; org/room ACL; audited admin access. **Not end-to-end encrypted.**                                        |
| Drive                | Files and previews only in MVP packaging. **No native Docs/Sheets/Slides collaborative editing.** Primary file action is **Download** (not Open-in-editor). Desktop sync: open-source **rclone** over WebDAV — see `docs/drive-desktop-sync.md`. |
| Agents               | Non-read tool calls require human confirmation by default. Agents cannot approve their own actions.                            |
| Deployment           | Single-organization Business pilot (order of 5–50 trusted users). Public multi-tenant SaaS is deferred.                        |
| Recovery             | Pilot objectives: 99.5% monthly availability, RPO ≤ 24h, RTO ≤ 4h — engineering objectives, not a contractual SLA.             |
| Encryption at rest   | Depends on documented volume, database, and object-storage deployment controls.                                                |

## Non-claims (do not imply in UI or docs)

- Gmail-class global deliverability guarantees
- Signal-style or E2EE chat
- SOC 2, HIPAA, FedRAMP, ISO 27001, or similar certificates solely because control scaffolding exists
- Safe unattended agents with unrestricted workspace scopes
- Public multi-tenant SaaS readiness before a separate SaaS program
- Native Office collaborative editing under MVP packaging
- Helix-hosted IMAP or direct-to-MX outbound mail
- Multi-region active-active high availability

## Packaging boundary

Production MVP must keep:

- `HELIX_APPS=mail,drive,chat,assistant` (exact)
- `VITE_HELIX_MVP_ONLY=true` on the web build
- Editor migrations disabled
- Calendar, Meet, Docs, Sheets, Slides **not** production-enabled

Dormant code for Full Workspace surfaces is not product enablement.

## Related ADRs

ADR-0001 (single-org pilot) · ADR-0002 (managed mail) · ADR-0003 (web/API mail) ·
ADR-0004 (server-readable chat) · ADR-0005 (agent write confirmation) · ADR-0006 (RPO/RTO) ·
ADR-0007 (fail-closed uploads) · ADR-0012 (SaaS deferred) · ADR-0013 (mobile web, not native)
