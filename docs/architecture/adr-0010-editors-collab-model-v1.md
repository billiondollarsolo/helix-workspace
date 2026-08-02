# ADR-0010: Editors collab model for v1

- **Status:** Proposed (2026-08-02) — owner approval pending for implementation authorization
- **Plan task:** G0.7
- **Date:** 2026-08-02

## Context

Docs/Sheets/Slides depend on helix-editors. Realtime collab increases correctness and ops risk.

## Decision

**Default for v1:** single-active editing + Drive versions/autosave. Full multi-caret realtime collab is not required for v1 GA unless load/security evidence is completed under ED.0 follow-ups.

## Consequences

ED.* implement native open/save/import; collab features stay off or experimental until proven.
Editors source stays in the sibling repo; boundary scanner remains required.

## Reversal

Enable realtime collab only with a new ADR and evidence pack.
