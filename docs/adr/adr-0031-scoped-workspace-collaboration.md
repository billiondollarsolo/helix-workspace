# ADR-0031: Scoped collaboration for humans and bots

- Status: Accepted
- Date: 2026-10-16
- Supersedes ADR-0005's per-action confirmation requirement for the routine tools below.

## Decision

Account approval authorizes routine work within approved scopes and resource ACLs.
A bot does not need a second human click to post in a conversation it belongs to,
open a direct conversation with active internal members, send internal mail, work
with its own or writable shared files, or deliberately share its own files inside
the workspace. Managed rooms still require `chat.create`; ordinary direct
conversations use `chat.post`. No existing credential silently gains a new scope.

Selected tools use the registry's bounded standing-authorization hook. Existing
scope checks, tenant isolation, actor status, ownership, resource roles, quotas,
malware scanning, DLP, audit and emergency controls remain mandatory. An explicit
credential always-confirm override takes precedence. Other agent tools retain the
confirmation default; this is not a credential-wide approval bypass.

Internal mail authorization resolves every To/Cc/Bcc recipient to local mailboxes
in the caller's tenant, excluding routing rules and unresolved recipients. The
registry passes a server-only local-delivery restriction to the handler. That
restriction is persisted with queued mail and checked before delivery, so routing
changes cannot turn an internal authorization into an external transmission.
External/mixed mail, public file links, permanent deletion and credential/admin
changes retain their existing gates.

Humans and bots retain separate private mailboxes and files. Sharing is an explicit
owner operation, subject to the same ACL enforcement for both actor types. Trusting
a Bot installation authorizes enrollment requests only, not the bots' resource use.

## Evidence

Registry tests exercise routine calls, scope denial, explicit confirmation and
internal versus external recipients. Database tests cover local-only delivery
after routing changes, chat membership/privacy, Drive sharing and bot isolation.
Live REST/MCP/CLI tests verify the local integration separately from deployment.

## Limits

Approving write scopes now delegates ordinary collaboration decisions to the bot,
including sharing owned files with workspace members. Administrators who need
per-action review can retain the explicit always-confirm credential policy.
Resource roles still prevent a reader or editor from resharing an owner's files.
