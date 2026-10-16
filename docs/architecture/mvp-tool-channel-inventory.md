# MVP tool channel inventory (agents)

**Date:** 2026-08-03 (tables refreshed 2026-10-12)

**Tasks:** E3.6 (mail), E4.6 (drive), E5.6 (chat), E9.1 (tool surface inventory)

**Plan:** `docs/archive/plans/2026-08-03-elite-mvp-enterprise-production.md`

**ADR:** `docs/adr/adr-0005-agent-write-confirmation-and-allowlists.md`

**Executable matrix:** `apps/helix/src/platform/tools/mvp-tool-surface-matrix.test.ts`

## Policy summary (agents)

**2026-10-16 update:** The tables below describe the fallback firewall outcome
without a standing authorization. Routine collaboration now has bounded
scope-based standing authorizations in the actual registry. See the
[current collaboration contract](../plans/2026-10-15-helix-bot-workspace-handoff.md#routine-collaboration-2026-10-16).
Resource ACLs, explicit always-confirm settings, DLP and emergency controls
still apply; external mail and public links keep their approval boundaries.

| Actor | `sideEffects`                                      | Default outcome (`evaluateToolPolicyFirewall`)                        | Notes                                                                        |
| ----- | -------------------------------------------------- | --------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| agent | `read`                                             | `allow-read`                                                          | Still subject to scopes / AuthZ / clean-read gates at the handler.           |
| agent | `write` / `destructive` / `external_communication` | **`queue-confirmation`** (`agent_write_requires_approval`)            | Bypass only via exact automation policy match or approved pending execution. |
| agent | non-read under emergency kill                      | **denied** by `evaluateAgentOperationalControls` (`global_read_only`) | `admin.agent_controls.set` is exempt so operators can clear kill (A10).      |

Tool-level `confirmationRequired` strengthens human/tier paths; it does **not** replace the agent default. Agents still queue even when the flag is unset, because ordinary writes are mutations (ADR-0005).

Factories used for this inventory (real registration paths, empty stores for definition metadata only):

- `createMailToolDefinitions` — `apps/helix/src/platform/mail/tools.ts`
- `createDriveToolDefinitions` — `apps/helix/src/platform/drive/tools.ts`
- `createChatToolDefinitions` — `apps/helix/src/platform/chat/tools.ts`
- `createAgentOperationalControlTools` — `apps/helix/src/platform/tools/agent-operational-controls-tools.ts`

The tables also list two companion registrations that ship with the same apps but sit outside the matrix factories: `registerChatInboxTools` (`chat.unread.list`, `chat.mentions.list` — `apps/helix/src/platform/chat/inbox.ts`) and `registerDriveS3KeyTools` (`drive.s3-keys.*` — `apps/helix/src/platform/drive/s3/tools.ts`).

Channels that project the same registry (REST / MCP / tRPC / assistant / CLI) must not expose additional MVP mutation tools without the same policy path.

---

## mail.\*

| Tool id                     | Permission    | sideEffects            | Tool `confirmationRequired` | Agent confirmation expectation                                             |
| --------------------------- | ------------- | ---------------------- | --------------------------- | -------------------------------------------------------------------------- |
| `mail.alias.create`         | `mail.admin`  | write                  | unset                       | **queue-confirmation**                                                     |
| `mail.alias.delete`         | `mail.admin`  | destructive            | unset                       | **queue-confirmation**                                                     |
| `mail.alias.list`           | `mail.read`   | read                   | unset                       | allow-read                                                                 |
| `mail.archive`              | `mail.write`  | write                  | unset                       | **queue-confirmation**                                                     |
| `mail.delegate.grant`       | `mail.write`  | write                  | unset                       | **queue-confirmation**                                                     |
| `mail.delegate.list`        | `mail.read`   | read                   | unset                       | allow-read                                                                 |
| `mail.delegate.revoke`      | `mail.write`  | destructive            | unset                       | **queue-confirmation**                                                     |
| `mail.delete`               | `mail.write`  | destructive            | unset                       | **queue-confirmation**                                                     |
| `mail.draft.discard`        | `mail.write`  | destructive            | unset                       | **queue-confirmation**                                                     |
| `mail.draft.get`            | `mail.read`   | read                   | unset                       | allow-read                                                                 |
| `mail.draft.list`           | `mail.read`   | read                   | unset                       | allow-read                                                                 |
| `mail.draft.save`           | `mail.write`  | write                  | unset                       | **queue-confirmation**                                                     |
| `mail.filter.create`        | `mail.write`  | write                  | unset                       | **queue-confirmation**                                                     |
| `mail.filter.delete`        | `mail.write`  | destructive            | unset                       | **queue-confirmation**                                                     |
| `mail.filter.list`          | `mail.read`   | read                   | unset                       | allow-read                                                                 |
| `mail.filter.update`        | `mail.write`  | write                  | unset                       | **queue-confirmation**                                                     |
| `mail.folders.list`         | `mail.read`   | read                   | unset                       | allow-read                                                                 |
| `mail.forward`              | `mail.send`   | external_communication | true                        | **queue-confirmation**                                                     |
| `mail.inbound.accept`       | `mail.system` | write                  | false                       | **queue-confirmation** for agents (system/service actors use trusted path) |
| `mail.label.apply`          | `mail.write`  | write                  | unset                       | **queue-confirmation**                                                     |
| `mail.label.create`         | `mail.write`  | write                  | unset                       | **queue-confirmation**                                                     |
| `mail.label.delete`         | `mail.write`  | destructive            | true                        | **queue-confirmation**                                                     |
| `mail.label.update`         | `mail.write`  | write                  | unset                       | **queue-confirmation**                                                     |
| `mail.labels.list`          | `mail.read`   | read                   | unset                       | allow-read                                                                 |
| `mail.outbound.cancel`      | `mail.write`  | write                  | unset                       | **queue-confirmation**                                                     |
| `mail.outbound.get`         | `mail.read`   | read                   | unset                       | allow-read                                                                 |
| `mail.outbound.retry`       | `mail.send`   | external_communication | true                        | **queue-confirmation**                                                     |
| `mail.read.set`             | `mail.write`  | write                  | unset                       | **queue-confirmation**                                                     |
| `mail.reply`                | `mail.send`   | external_communication | true                        | **queue-confirmation** (+ `mail.external` conditional scope)               |
| `mail.restore`              | `mail.write`  | write                  | unset                       | **queue-confirmation**                                                     |
| `mail.scheduled.cancel`     | `mail.write`  | write                  | unset                       | **queue-confirmation**                                                     |
| `mail.scheduled.list`       | `mail.read`   | read                   | unset                       | allow-read                                                                 |
| `mail.scheduled.reschedule` | `mail.write`  | write                  | unset                       | **queue-confirmation**                                                     |
| `mail.search`               | `mail.read`   | read                   | unset                       | allow-read                                                                 |
| `mail.send`                 | `mail.send`   | external_communication | true                        | **queue-confirmation** (+ `mail.external` conditional scope)               |
| `mail.settings.get`         | `mail.read`   | read                   | unset                       | allow-read                                                                 |
| `mail.settings.set`         | `mail.write`  | write                  | unset                       | **queue-confirmation**                                                     |
| `mail.snooze`               | `mail.write`  | write                  | unset                       | **queue-confirmation**                                                     |
| `mail.spam`                 | `mail.write`  | write                  | unset                       | **queue-confirmation**                                                     |
| `mail.star.set`             | `mail.write`  | write                  | unset                       | **queue-confirmation**                                                     |
| `mail.thread.get`           | `mail.read`   | read                   | unset                       | allow-read                                                                 |
| `mail.threads.list`         | `mail.read`   | read                   | unset                       | allow-read                                                                 |
| `mail.unarchive`            | `mail.write`  | write                  | unset                       | **queue-confirmation**                                                     |
| `mail.unsnooze`             | `mail.write`  | write                  | unset                       | **queue-confirmation**                                                     |
| `mail.vacation.get`         | `mail.read`   | read                   | unset                       | allow-read                                                                 |
| `mail.vacation.set`         | `mail.write`  | write                  | unset                       | **queue-confirmation**                                                     |

---

## drive.\*

| Tool id                       | Permission     | sideEffects | Tool `confirmationRequired` | Agent confirmation expectation                          |
| ----------------------------- | -------------- | ----------- | --------------------------- | ------------------------------------------------------- |
| `drive.access.list`           | `drive.read`   | read        | unset                       | allow-read                                              |
| `drive.access.remove`         | `drive.write`  | write       | unset                       | **queue-confirmation**                                  |
| `drive.access.update`         | `drive.write`  | write       | unset                       | **queue-confirmation**                                  |
| `drive.comment.create`        | `drive.read`   | write       | unset                       | **queue-confirmation**                                  |
| `drive.comment.delete`        | `drive.read`   | write       | true                        | **queue-confirmation**                                  |
| `drive.comment.evidence.list` | `drive.read`   | read        | unset                       | allow-read                                              |
| `drive.comment.list`          | `drive.read`   | read        | unset                       | allow-read                                              |
| `drive.comment.reopen`        | `drive.read`   | write       | unset                       | **queue-confirmation**                                  |
| `drive.comment.resolve`       | `drive.read`   | write       | unset                       | **queue-confirmation**                                  |
| `drive.comment.update`        | `drive.read`   | write       | unset                       | **queue-confirmation**                                  |
| `drive.create`                | `drive.write`  | write       | unset                       | **queue-confirmation**                                  |
| `drive.delete`                | `drive.delete` | destructive | true                        | **queue-confirmation**                                  |
| `drive.finalize`              | `drive.write`  | write       | unset                       | **queue-confirmation**                                  |
| `drive.folder.move`           | `drive.write`  | write       | unset                       | **queue-confirmation**                                  |
| `drive.lifecycle.get`         | `admin.drive`  | read        | unset                       | allow-read                                              |
| `drive.lifecycle.set`         | `admin.drive`  | write       | true                        | **queue-confirmation**                                  |
| `drive.link.create`           | `drive.write`  | write       | true                        | **queue-confirmation**                                  |
| `drive.link.list`             | `drive.read`   | read        | unset                       | allow-read                                              |
| `drive.link.revoke`           | `drive.write`  | write       | true                        | **queue-confirmation**                                  |
| `drive.list`                  | `drive.read`   | read        | unset                       | allow-read (clean-read metadata only; no raw blob tool) |
| `drive.move`                  | `drive.write`  | write       | unset                       | **queue-confirmation**                                  |
| `drive.quota.usage`           | `admin.drive`  | read        | unset                       | allow-read                                              |
| `drive.rename`                | `drive.write`  | write       | unset                       | **queue-confirmation**                                  |
| `drive.restore`               | `drive.write`  | write       | unset                       | **queue-confirmation**                                  |
| `drive.s3-keys.create`        | `drive.write`  | write       | true                        | **queue-confirmation**                                  |
| `drive.s3-keys.list`          | `drive.read`   | read        | unset                       | allow-read                                              |
| `drive.s3-keys.revoke`        | `drive.write`  | destructive | true                        | **queue-confirmation**                                  |
| `drive.search`                | `drive.read`   | read        | unset                       | allow-read                                              |
| `drive.share`                 | `drive.write`  | write       | true                        | **queue-confirmation**                                  |
| `drive.star.set`              | `drive.read`   | write       | unset                       | **queue-confirmation**                                  |
| `drive.storage.usage`         | `drive.read`   | read        | unset                       | allow-read                                              |
| `drive.trash`                 | `drive.write`  | write       | unset                       | **queue-confirmation**                                  |
| `drive.upload`                | `drive.write`  | write       | unset                       | **queue-confirmation**                                  |
| `drive.upload.complete`       | `drive.write`  | write       | unset                       | **queue-confirmation**                                  |
| `drive.upload.status`         | `drive.read`   | read        | unset                       | allow-read                                              |
| `drive.versions.list`         | `drive.read`   | read        | unset                       | allow-read                                              |
| `drive.versions.revert`       | `drive.write`  | write       | true                        | **queue-confirmation**                                  |
| `drive.view.get`              | `drive.read`   | read        | unset                       | allow-read                                              |
| `drive.view.set`              | `drive.read`   | write       | unset                       | **queue-confirmation**                                  |
| `drive.workflow.create`       | `drive.write`  | write       | unset                       | **queue-confirmation**                                  |
| `drive.workflow.list`         | `drive.read`   | read        | unset                       | allow-read                                              |
| `drive.workflow.transition`   | `drive.write`  | write       | unset                       | **queue-confirmation**                                  |

Agent clean-read note: the Drive tool surface deliberately omits raw content/download tools; availability is metadata (`available` / upload state) rather than silent byte delivery of non-clean objects.

---

## chat.\*

| Tool id                       | Permission    | sideEffects | Tool `confirmationRequired` | Agent confirmation expectation                                                                    |
| ----------------------------- | ------------- | ----------- | --------------------------- | ------------------------------------------------------------------------------------------------- |
| `chat.create_room`            | `chat.create` | write       | unset                       | **queue-confirmation**                                                                            |
| `chat.dm.open`                | `chat.post`   | write       | unset                       | Standing authorization for scoped internal direct conversations; otherwise **queue-confirmation** |
| `chat.delete`                 | `chat.post`   | destructive | unset                       | **queue-confirmation**                                                                            |
| `chat.edit`                   | `chat.post`   | write       | unset                       | **queue-confirmation**                                                                            |
| `chat.export`                 | `chat.read`   | read        | unset                       | allow-read                                                                                        |
| `chat.export.organization`    | `admin.chat`  | read        | true                        | allow-read for agents at firewall (admin scope + tool confirmation for humans/export rate limits) |
| `chat.import`                 | `chat.create` | write       | unset                       | **queue-confirmation**                                                                            |
| `chat.invite`                 | `chat.create` | write       | unset                       | **queue-confirmation**                                                                            |
| `chat.legal_hold.set`         | `admin.chat`  | write       | true                        | **queue-confirmation**                                                                            |
| `chat.member.remove`          | `chat.create` | destructive | true                        | **queue-confirmation**                                                                            |
| `chat.mentions.list`          | `chat.read`   | read        | unset                       | allow-read                                                                                        |
| `chat.message.list`           | `chat.read`   | read        | unset                       | allow-read (room membership enforced in store)                                                    |
| `chat.pin`                    | `chat.post`   | write       | unset                       | **queue-confirmation**                                                                            |
| `chat.pins.list`              | `chat.read`   | read        | unset                       | allow-read                                                                                        |
| `chat.react`                  | `chat.post`   | write       | unset                       | **queue-confirmation**                                                                            |
| `chat.reply_in_thread`        | `chat.post`   | write       | unset                       | **queue-confirmation**                                                                            |
| `chat.retention.get`          | `admin.chat`  | read        | unset                       | allow-read                                                                                        |
| `chat.retention.set`          | `admin.chat`  | write       | true                        | **queue-confirmation**                                                                            |
| `chat.room.discover`          | `chat.read`   | read        | unset                       | allow-read                                                                                        |
| `chat.room.join`              | `chat.create` | write       | unset                       | **queue-confirmation**                                                                            |
| `chat.room.list`              | `chat.read`   | read        | unset                       | allow-read                                                                                        |
| `chat.room.list_organization` | `admin.chat`  | read        | unset                       | allow-read (private rooms gated by `chat_admin_private_rooms`)                                    |
| `chat.search`                 | `chat.read`   | read        | unset                       | allow-read                                                                                        |
| `chat.send`                   | `chat.post`   | write       | unset                       | **queue-confirmation**                                                                            |
| `chat.thread.list`            | `chat.read`   | read        | unset                       | allow-read                                                                                        |
| `chat.unpin`                  | `chat.post`   | write       | unset                       | **queue-confirmation**                                                                            |
| `chat.unread.list`            | `chat.read`   | read        | unset                       | allow-read                                                                                        |

---

## admin.agent_controls.\*

| Tool id                    | Permission     | sideEffects | Tool `confirmationRequired` | Agent confirmation expectation                                                                                            |
| -------------------------- | -------------- | ----------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `admin.agent_controls.get` | `admin.agents` | read        | false                       | allow-read                                                                                                                |
| `admin.agent_controls.set` | `admin.agents` | write       | true                        | **queue-confirmation** for agents; operational-control bypass only for kill evaluation so humans can clear emergency kill |

---

## Channel projection (E9.1)

| Channel             | Source                       | Dangerous MVP tools                                                    |
| ------------------- | ---------------------------- | ---------------------------------------------------------------------- |
| REST `/api/tools/*` | Tool registry                | Same inventory; non-read → confirmation/idempotency paths in registry  |
| MCP                 | `apps/helix/src/api/mcp.ts`  | Lists registry tools; agent writes require confirmation before execute |
| tRPC                | `apps/helix/src/api/trpc.ts` | Read → query; non-read → mutation procedures over the same registry    |
| Assistant           | policy channel `assistant`   | Human-proposed writes also queue (`assistant_write_requires_approval`) |
| CLI                 | projects registry metadata   | Must not invent extra mutation tools outside this inventory            |

Acceptance for this evidence package: matrix test green; every non-read tool above maps to `queue-confirmation` for agents without automation match.

## Regeneration

Re-run:

```sh
pnpm --filter @helix/app exec vitest run src/platform/tools/mvp-tool-surface-matrix.test.ts
```

The tables are maintained by hand. The matrix test fails when a factory tool id is missing from this file, so when factories add or remove tools, update the tables from the factory definitions (permission, `sideEffects`, `confirmationRequired`) and keep the test as the fail-closed check.
