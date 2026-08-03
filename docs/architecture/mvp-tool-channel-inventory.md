# MVP tool channel inventory (agents)

**Date:** 2026-08-03  
**Tasks:** E3.6 (mail), E4.6 (drive), E5.6 (chat), E9.1 (tool surface inventory)  
**Plan:** `docs/superpowers/plans/2026-08-03-elite-mvp-enterprise-production.md`  
**ADR:** `docs/architecture/adr-0005-agent-write-confirmation-and-allowlists.md`  
**Executable matrix:** `apps/helix/src/platform/tools/mvp-tool-surface-matrix.test.ts`

## Policy summary (agents)

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

Channels that project the same registry (REST / MCP / tRPC / assistant / CLI) must not expose additional MVP mutation tools without the same policy path.

---

## mail.\*

| Tool id                | Permission    | sideEffects            | Tool `confirmationRequired` | Agent confirmation expectation                                             |
| ---------------------- | ------------- | ---------------------- | --------------------------- | -------------------------------------------------------------------------- |
| `mail.alias.create`    | `mail.admin`  | write                  | unset                       | **queue-confirmation**                                                     |
| `mail.alias.delete`    | `mail.admin`  | destructive            | unset                       | **queue-confirmation**                                                     |
| `mail.alias.list`      | `mail.read`   | read                   | unset                       | allow-read                                                                 |
| `mail.archive`         | `mail.write`  | write                  | unset                       | **queue-confirmation**                                                     |
| `mail.delete`          | `mail.write`  | destructive            | unset                       | **queue-confirmation**                                                     |
| `mail.draft.discard`   | `mail.write`  | destructive            | unset                       | **queue-confirmation**                                                     |
| `mail.draft.get`       | `mail.read`   | read                   | unset                       | allow-read                                                                 |
| `mail.draft.list`      | `mail.read`   | read                   | unset                       | allow-read                                                                 |
| `mail.draft.save`      | `mail.write`  | write                  | unset                       | **queue-confirmation**                                                     |
| `mail.filter.create`   | `mail.write`  | write                  | unset                       | **queue-confirmation**                                                     |
| `mail.filter.delete`   | `mail.write`  | destructive            | unset                       | **queue-confirmation**                                                     |
| `mail.filter.list`     | `mail.read`   | read                   | unset                       | allow-read                                                                 |
| `mail.filter.update`   | `mail.write`  | write                  | unset                       | **queue-confirmation**                                                     |
| `mail.folders.list`    | `mail.read`   | read                   | unset                       | allow-read                                                                 |
| `mail.inbound.accept`  | `mail.system` | write                  | false                       | **queue-confirmation** for agents (system/service actors use trusted path) |
| `mail.label.apply`     | `mail.write`  | write                  | unset                       | **queue-confirmation**                                                     |
| `mail.labels.list`     | `mail.read`   | read                   | unset                       | allow-read                                                                 |
| `mail.outbound.cancel` | `mail.write`  | write                  | unset                       | **queue-confirmation**                                                     |
| `mail.outbound.get`    | `mail.read`   | read                   | unset                       | allow-read                                                                 |
| `mail.outbound.retry`  | `mail.send`   | external_communication | true                        | **queue-confirmation**                                                     |
| `mail.read.set`        | `mail.write`  | write                  | unset                       | **queue-confirmation**                                                     |
| `mail.reply`           | `mail.send`   | external_communication | true                        | **queue-confirmation** (+ `mail.external` conditional scope)               |
| `mail.search`          | `mail.read`   | read                   | unset                       | allow-read                                                                 |
| `mail.send`            | `mail.send`   | external_communication | true                        | **queue-confirmation** (+ `mail.external` conditional scope)               |
| `mail.snooze`          | `mail.write`  | write                  | unset                       | **queue-confirmation**                                                     |
| `mail.spam`            | `mail.write`  | write                  | unset                       | **queue-confirmation**                                                     |
| `mail.star.set`        | `mail.write`  | write                  | unset                       | **queue-confirmation**                                                     |
| `mail.thread.get`      | `mail.read`   | read                   | unset                       | allow-read                                                                 |
| `mail.threads.list`    | `mail.read`   | read                   | unset                       | allow-read                                                                 |
| `mail.vacation.get`    | `mail.read`   | read                   | unset                       | allow-read                                                                 |
| `mail.vacation.set`    | `mail.write`  | write                  | unset                       | **queue-confirmation**                                                     |

---

## drive.\*

| Tool id                 | Permission     | sideEffects | Tool `confirmationRequired` | Agent confirmation expectation                          |
| ----------------------- | -------------- | ----------- | --------------------------- | ------------------------------------------------------- |
| `drive.access.list`     | `drive.read`   | read        | unset                       | allow-read                                              |
| `drive.access.remove`   | `drive.write`  | write       | unset                       | **queue-confirmation**                                  |
| `drive.access.update`   | `drive.write`  | write       | unset                       | **queue-confirmation**                                  |
| `drive.comment.create`  | `drive.write`  | write       | unset                       | **queue-confirmation**                                  |
| `drive.comment.delete`  | `drive.write`  | write       | true                        | **queue-confirmation**                                  |
| `drive.comment.list`    | `drive.read`   | read        | unset                       | allow-read                                              |
| `drive.comment.reopen`  | `drive.write`  | write       | unset                       | **queue-confirmation**                                  |
| `drive.comment.resolve` | `drive.write`  | write       | unset                       | **queue-confirmation**                                  |
| `drive.comment.update`  | `drive.write`  | write       | unset                       | **queue-confirmation**                                  |
| `drive.create`          | `drive.write`  | write       | unset                       | **queue-confirmation**                                  |
| `drive.delete`          | `drive.delete` | destructive | true                        | **queue-confirmation**                                  |
| `drive.finalize`        | `drive.write`  | write       | unset                       | **queue-confirmation**                                  |
| `drive.lifecycle.get`   | `admin.drive`  | read        | unset                       | allow-read                                              |
| `drive.lifecycle.set`   | `admin.drive`  | write       | true                        | **queue-confirmation**                                  |
| `drive.link.create`     | `drive.write`  | write       | true                        | **queue-confirmation**                                  |
| `drive.link.list`       | `drive.read`   | read        | unset                       | allow-read                                              |
| `drive.link.revoke`     | `drive.write`  | write       | true                        | **queue-confirmation**                                  |
| `drive.list`            | `drive.read`   | read        | unset                       | allow-read (clean-read metadata only; no raw blob tool) |
| `drive.move`            | `drive.write`  | write       | unset                       | **queue-confirmation**                                  |
| `drive.quota.usage`     | `admin.drive`  | read        | unset                       | allow-read                                              |
| `drive.rename`          | `drive.write`  | write       | unset                       | **queue-confirmation**                                  |
| `drive.restore`         | `drive.write`  | write       | unset                       | **queue-confirmation**                                  |
| `drive.search`          | `drive.read`   | read        | unset                       | allow-read                                              |
| `drive.share`           | `drive.write`  | write       | true                        | **queue-confirmation**                                  |
| `drive.star.set`        | `drive.write`  | write       | unset                       | **queue-confirmation**                                  |
| `drive.trash`           | `drive.write`  | write       | unset                       | **queue-confirmation**                                  |
| `drive.upload`          | `drive.write`  | write       | unset                       | **queue-confirmation**                                  |
| `drive.upload.complete` | `drive.write`  | write       | unset                       | **queue-confirmation**                                  |
| `drive.upload.status`   | `drive.read`   | read        | unset                       | allow-read                                              |
| `drive.versions.list`   | `drive.read`   | read        | unset                       | allow-read                                              |
| `drive.versions.revert` | `drive.write`  | write       | true                        | **queue-confirmation**                                  |

Agent clean-read note: the Drive tool surface deliberately omits raw content/download tools; availability is metadata (`available` / upload state) rather than silent byte delivery of non-clean objects.

---

## chat.\*

| Tool id                    | Permission    | sideEffects | Tool `confirmationRequired` | Agent confirmation expectation                                                                    |
| -------------------------- | ------------- | ----------- | --------------------------- | ------------------------------------------------------------------------------------------------- |
| `chat.create_room`         | `chat.create` | write       | unset                       | **queue-confirmation**                                                                            |
| `chat.delete`              | `chat.post`   | destructive | unset                       | **queue-confirmation**                                                                            |
| `chat.edit`                | `chat.post`   | write       | unset                       | **queue-confirmation**                                                                            |
| `chat.export.organization` | `admin.chat`  | read        | true                        | allow-read for agents at firewall (admin scope + tool confirmation for humans/export rate limits) |
| `chat.invite`              | `chat.create` | write       | unset                       | **queue-confirmation**                                                                            |
| `chat.legal_hold.set`      | `admin.chat`  | write       | true                        | **queue-confirmation**                                                                            |
| `chat.member.remove`       | `chat.create` | destructive | true                        | **queue-confirmation**                                                                            |
| `chat.message.list`        | `chat.read`   | read        | unset                       | allow-read (room membership enforced in store)                                                    |
| `chat.pin`                 | `chat.post`   | write       | unset                       | **queue-confirmation**                                                                            |
| `chat.pins.list`           | `chat.read`   | read        | unset                       | allow-read                                                                                        |
| `chat.react`               | `chat.post`   | write       | unset                       | **queue-confirmation**                                                                            |
| `chat.reply_in_thread`     | `chat.post`   | write       | unset                       | **queue-confirmation**                                                                            |
| `chat.retention.get`       | `admin.chat`  | read        | unset                       | allow-read                                                                                        |
| `chat.retention.set`       | `admin.chat`  | write       | true                        | **queue-confirmation**                                                                            |
| `chat.room.list`           | `chat.read`   | read        | unset                       | allow-read                                                                                        |
| `chat.search`              | `chat.read`   | read        | unset                       | allow-read                                                                                        |
| `chat.send`                | `chat.post`   | write       | unset                       | **queue-confirmation**                                                                            |
| `chat.thread.list`         | `chat.read`   | read        | unset                       | allow-read                                                                                        |
| `chat.unpin`               | `chat.post`   | write       | unset                       | **queue-confirmation**                                                                            |

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
pnpm --filter helix exec vitest run src/platform/tools/mvp-tool-surface-matrix.test.ts
```

If factories add/remove tools, update the tables in this file from the factory definitions and keep the test as the fail-closed check.
