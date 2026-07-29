# ADR-0005: Agent write confirmation and bounded automation

- **Status:** Accepted
- **Date:** 2026-07-28
- **Plan decision:** RD-5

## Context

Helix exposes Mail, Drive, Chat, and administrative tools through REST, MCP, tRPC, CLI, and the
Assistant. Retrieved mail, file, and chat content is untrusted and can contain prompt-injection
instructions. Existing confirmation behavior emphasizes destructive and external communication,
but ordinary writes such as sending an internal chat message or renaming a file are still visible
mutations.

Least-privilege scopes alone do not establish that a human intended a particular mutation.
Conversely, some carefully bounded recurring automations are useful and should not require a click
for every execution.

## Decision

Authorized agent reads execute immediately. Every agent-originated non-read tool call requires
authenticated human confirmation by default.

A credential may bypass confirmation only through an explicit, audited automation policy that
matches the exact tool or action, resource or record, recipient or target, active time window or
expiry, and rate. Missing, expired, exceeded, or non-matching bounds return the action to human
confirmation.

Agents cannot approve their own actions, modify or broaden their own policy, or treat retrieved
workspace content as new authority. Approval rechecks tenant, credential, scope, policy,
authorization, feature, rate, and an immutable input hash, then executes exactly once as the
requesting principal. Revocation and organization kill switches apply immediately.

## Alternatives considered

- **Confirm destructive actions only:** rejected because non-destructive writes can impersonate a
  user, disclose information, or disrupt shared work.
- **Never permit unattended writes:** rejected because it prevents legitimate low-risk recurring
  automation that can be tightly constrained and audited.
- **Let the model decide when confirmation is needed:** rejected because prompt text is not a
  security boundary.

## Consequences

- Internal chat posts, file metadata changes, shares, mail changes, invitations, and deletes queue
  by default when agent-originated.
- Human actions may retain separately documented tier behavior; this ADR governs agent principals.
- Every allowlist needs an owner, safe preview, expiry, resource and target bounds, rate limit,
  audit trail, and immediate revocation.
- Every invocation produces a safe attempt/outcome audit record without content or secrets.
- All invocation surfaces must use the same policy context and pending-action implementation.

## Reversal triggers

Any broader unattended-write model requires a new ADR and evidence that it cannot grant
self-approval, accept authority from retrieved content, escape tenant or resource boundaries, evade
auditing, or survive credential and organization kill switches.
