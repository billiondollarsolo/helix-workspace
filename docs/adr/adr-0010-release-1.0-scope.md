# ADR-0010: Helix 1.0 release scope

- **Status:** Accepted
- **Date:** 2026-09-10

## Context

Historical plans disagree about launch scope and source ownership.

## Decision

The [canonical 1.0 scope](../release/1.0-scope.md) ships invite-only Mail, Drive, Chat, Assistant, and Admin. Calendar and Meet remain dormant behind the full profile. The workspace is the only release repository. Use Apache-2.0, Lucide icons, and built-in outbound webhook formats.

## Consequences

Plans and proposed decisions cannot enable additional production surfaces. Release evidence binds the workspace revision and both deployable image digests.

## Reversal triggers

A separately approved scope and fresh deployment evidence are required to expand the release.
