# ADR-0008: Full Workspace Meet via Jitsi

- **Status:** Proposed (2026-08-02) — owner approval pending for implementation authorization
- **Plan task:** G0.7
- **Date:** 2026-08-02

## Context

Full Workspace v1 includes video meetings. Code exists under platform/meet and web Meet with Jitsi External API.

## Decision

Ship Meet via Jitsi. Support external Jitsi URL and/or in-compose/in-cluster topology documented in O-D.9 / O-K.10. Production packaging must fail closed if Meet is enabled without Jitsi domain and JWT signing secret.

## Consequences

- MT.* and deploy tasks are on the critical path for Meet enablement.
- No fake “live” embed when unconfigured.
- Recording is out of default v1 unless a follow-up ADR enables it.

## Reversal

Replace Jitsi only with an ADR and security review of the new SFU stack.
