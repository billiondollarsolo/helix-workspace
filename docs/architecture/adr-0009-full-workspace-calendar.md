# ADR-0009: Full Workspace Calendar

- **Status:** Proposed (2026-08-02) — owner approval pending for implementation authorization
- **Plan task:** G0.7
- **Date:** 2026-08-02

## Context

Calendar UI and platform code exist but are filtered out of MVP packaging.

## Decision

Ship Calendar in Full Workspace v1 with tenant isolation, mail invitations, and timezone-safe recurrence minimum. CalDAV is only in scope if hardened with authZ tests; otherwise remove product claims.

## Consequences

CAL.* tasks gate packaging (CAL.10). Cross-tenant event leakage is a release blocker.

## Reversal

Drop Calendar from v1 only with owner approval and packaging matrix update.
