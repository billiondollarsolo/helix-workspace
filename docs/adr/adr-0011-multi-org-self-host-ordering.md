# ADR-0011: Multi-org self-host ordering

- **Status:** Proposed (2026-08-02) — owner approval pending for implementation authorization
- **Plan task:** G0.7
- **Date:** 2026-08-02

## Context

ADR-0001 targets one organization pilot. Tenancy code is multi-org aware.

## Decision

Self-host **v1 GA may ship single-org first**. Multi-org self-host admin create-org is optional under ID.6 after isolation proof. Public multi-tenant SaaS is **not** this decision (see ADR-0012).

## Consequences

Do not block single-org GA on full SaaS lifecycle. Tenant isolation tests remain mandatory whenever multi-org is enabled.

## Reversal

Require multi-org for GA only via owner change to this ADR.
