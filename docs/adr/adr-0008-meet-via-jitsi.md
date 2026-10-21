# ADR-0008: Full Workspace Meet via Jitsi

> Superseded by [ADR-0032: Meet on LiveKit](adr-0032-meet-via-livekit.md) (2026-10-21). Jitsi has been removed.
>
> Dormant full-profile proposal, outside 1.0. Superseded for release packaging by [ADR-0010](adr-0010-release-1.0-scope.md).

- **Status:** Superseded by ADR-0032 (2026-10-21); originally proposed 2026-08-02
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
