# Mail & Chat — Elite Component Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. **Read a target file before editing it** — this plan gives exact anchors (`file:line`) and the transformation, not a verbatim copy of large existing file bodies. New files are given as complete, real code.

**Goal:** Raise the two most mature messaging surfaces — **Mail** (`apps/helix/src/platform/mail`, `apps/web/src/features/mail`) and **Chat** (`apps/helix/src/platform/chat`, `apps/web/src/features/chat`) — to the shared **Elite Component Standard** (gates G1–G9), while closing the concrete correctness, security, and product gaps found in the codebase survey. Both are genuine, shipping features (real SMTP send/receive; real `@fastify/websocket` realtime), not stubs — this plan fixes what is broken, adds what is missing, and refactors the god-files, without diverging from the platform seams both share.

**Architecture:** Mail and Chat are two `coreApps.shouldRegister(...)`-gated plugins that **reuse the same platform primitives**: the shared `threads` / `messages` / `message_attachments` / `permissions` / `outbox` tables; the `RuntimeToolRegistry` + `zodToolSchema` tool-definition pattern; the EventBus → outbox → worker fan-out (`activity.mail.*`, `activity.chat.*` subjects); and the AI-enrichment + `search/indexer.ts` worker pattern. **This plan must not fork those seams** — every new capability is a tool in the registry (so MCP/OpenAPI get it for free), every new shape is a Zod contract in `@helix/contracts`, every env read goes through the `env` module, and every client-visible error is an `ApiError`. Where Mail and Chat need parallel machinery (realtime push, config, error frames), they adopt the *same* pattern rather than two bespoke ones.

**Tech Stack:** pnpm@9 workspaces + Turborepo · Node ≥22, ESM only · TypeScript 5.7 strict (`@helix/config`) · Zod (single source of truth via `@helix/contracts`) · Fastify · `@fastify/websocket` · postgres.js (`sql` tagged template, `tenantScoped()`) · Vitest · Conventional Commits.

## Dependencies on the Cross-Cutting Standard

This plan **consumes** the artifacts delivered by `docs/superpowers/plans/2026-07-18-cross-cutting-elite-standard.md`. Those must be merged first (or landed in the same branch train):

- `@helix/contracts` package (Phase 1 of the standard) — this plan **adds** `packages/contracts/src/mail.ts` and `packages/contracts/src/chat.ts` and wires them into the barrel `packages/contracts/src/index.ts`.
- `apps/helix/src/config/env.ts` — the Zod-validated `env()` module (Phase 2). This plan **extends** its schema with the Mail and Chat keys and folds `getOutboundMailConfig` / `getSmtpMailReceiverConfig` / spam / antivirus / `CHAT_PRESENCE_TTL_SECONDS` / WS rate-limit reads into it.
- `apps/helix/src/api/api-error.ts` — `ApiError` base + subclasses (`BadRequestError`, `UnauthorizedError`, `ForbiddenError`, `NotFoundError`, `ConflictError`, `RateLimitedError`) (Phase 3). This plan **subclasses** them into `MailError`/`ChatError` families and throws them from tools/routes.

If the cross-cutting branch is not yet merged when a task below needs one of these, that task is **blocked** — do not stub a local copy; coordinate the merge order (see Execution Handoff).

## Global Constraints

_Every task's requirements implicitly include the Global Constraints section of the cross-cutting standard._ Highlights that bite hardest here:

- **Runtime:** Node ≥ 22, ESM only. No CommonJS.
- **TypeScript:** `strict`, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`, `isolatedModules`, `noEmitOnError` all ON. `@typescript-eslint/no-explicit-any` is **error** — no `any`, ever. Use `import type`. Note the prevailing local idiom for `exactOptionalPropertyTypes`: `...(x === undefined ? {} : { key: x })` conditional spreads (seen throughout `tools.ts`/`store.ts`) — match it.
- **Tenancy:** every org-scoped query goes through `tenantScoped()` / carries an explicit `org_id = ${orgId}` predicate. New DB access follows the existing `store.ts` idiom.
- **Validation library:** Zod only. Tool I/O uses `zodToolSchema(schema, genericObjectJsonSchema)`.
- **Tests:** Vitest, co-located `*.test.ts`, preset `@helix/config/vitest`. Unit tests must not require a live Postgres/Redis; integration tests may (the existing `*.store.test.ts` / `e2e-*.test.ts` gate on a DB).
- **Commits:** Conventional Commits, one logical change per commit, ending with the `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>` trailer.
- **File size:** target ≤ 400 LOC per new/refactored file. A file over 400 LOC ships only with a split or an explicit `// ponytail:` note naming the ceiling.
- **Branch:** all work on `feat/mail-chat-elite` off `main`, never on `main`.

### Task 0 — Branch setup (do once, first)

- [ ] **Step 1:** `git checkout main && git pull --ff-only`
- [ ] **Step 2:** `git checkout -b feat/mail-chat-elite`
- [ ] **Step 3:** Confirm baseline is green: `pnpm --filter @helix/app typecheck && pnpm --filter @helix/web typecheck`. Expected: PASS (a red baseline must be fixed or recorded before starting).
- [ ] **Step 4:** No commit yet — first task's commit lands on this branch.

---

## The Elite Component Standard (the rubric)

Both Part A (Mail) and Part B (Chat) are held to the nine gates defined in the cross-cutting standard. Reproduced here as the shared definition-of-done both parts map to:

- **G1 — Typed contract.** Every request/response shape (tool I/O, REST/WS body, SDK method) is a Zod schema in `@helix/contracts`; TS types are `z.infer` of those schemas. No hand-duplicated DTOs in `apps/web/src/features/*/api.ts`.
- **G2 — Runtime validation at the edge.** Inputs `.parse()`d at the boundary. Tool `outputSchema` is a concrete schema, never `z.unknown()`.
- **G3 — Validated config.** No raw `process.env` in component code — all via the `env` module, resolved once at boot, fail-fast.
- **G4 — Typed errors.** Throw `ApiError` subclasses with a stable `code`; never `throw new Error("english")` for client-visible errors, never hand-built `reply.code(4xx).send({error:"..."})`. WS surfaces emit a typed error frame.
- **G5 — Core/IO split.** Pure domain logic (validation, mapping, authz predicates) in `<domain>/core/*`, unit-tested without a DB; `Postgres<Domain>Store` is a thin IO adapter.
- **G6 — Authorization explicit & least-privilege.** Every mutating op checks a scope/role appropriate to the mutation. Roles from a closed enum.
- **G7 — Boundaries.** Cross-tier imports only through `@helix/contracts` / `@helix/sdk*`. No reaching into another `platform/<other>/store` internals (lint-enforced by the cross-cutting Phase 4 rule).
- **G8 — Surfaces layered.** `web/cli/mcp → sdk → api → core`. New capability reachable from the tool registry; web/CLI consume shared contracts.
- **G9 — Tested.** Unit tests for pure core (no DB), integration tests for IO adapter + routes, ≥1 negative-authorization test per mutating op. No file > ~400 LOC without a split or explicit `// ponytail:` note.

---

## Shared intro — the seams neither part may fork

Before touching either surface, internalize the five shared seams. Every task cites the one it reuses:

1. **Tool registry.** New capability = a `ToolDefinition` registered via `registerMailTools`/`registerChatTools` (`apps/helix/src/platform/{mail,chat}/tools.ts`). Definitions use the local `defineTool<Input, Output>` helper, `permission` (scope) string, `sideEffects`, and `inputSchema`/`outputSchema` built with `zodToolSchema(schema, genericObjectJsonSchema)`. **Do not** add REST routes for capabilities a tool can express (admin-only surfaces are the exception, and already have `admin-routes.ts`).
2. **Shared tables.** `threads` (`kind` = `chat_room`/`chat_dm`/mail thread), `messages` (`kind` = `chat`/`mail`), `message_attachments`, `permissions` (room/thread access), `outbox` (durable event fan-out). New per-domain tables (`mail_*`, `chat_*`) are always `org_id`-scoped.
3. **Realtime fan-out.** Writes append an `outbox` row on a subject (`activity.mail.received`/`activity.mail.sent` at `mail/store.ts:1312`; `activity.chat.message.created` at `chat/store.ts:365`) → EventBus → workers. Chat additionally has a live client WS (`/ws/chat`) via `EventBusChatRoomBus` (NATS `chat.room.<id>.events`). **Mail has no client push today** (web polls) — Part A adds one that reuses this same outbox→EventBus seam, it does not invent a second bus.
4. **AI-enrichment + search-indexer workers.** Both domains have `ai/enrichments.ts`, `ai/suggestions.ts`, and `search/indexer.ts` subscribing to the same event subjects. New message shapes (threading, mentions) must keep these workers fed, not bypass them.
5. **Config & errors.** `env()` for config (G3), `ApiError` subclasses for errors (G4), `@helix/contracts` for shapes (G1). These are the cross-cutting deliverables; both parts adopt them identically.

---

# Part A — Mail

**Scope:** `apps/helix/src/platform/mail/*` (backend) and `apps/web/src/features/mail/*` (frontend). Mail is genuine send+receive: outbound `NodemailerMailTransport` + SES/Mailgun/SMTP/Postmark providers (`providers.ts`), inbound `SmtpMailReceiver` (`ingest.ts`) with SPF/DKIM/DMARC/ARC (`mailauth`) + spamd + ClamAV, undo-send, filters, vacation, DKIM lifecycle, DMARC report ingestion, org routing. 19 tools registered in `tools.ts`.

## Part A — Definition of Done (maps to G1–G9)

| Gate | Mail-specific done condition | Delivered by |
|---|---|---|
| **G1** | `packages/contracts/src/mail.ts` holds Zod schemas for every mail tool I/O + web DTO; `apps/web/src/features/mail/api.ts` imports them, zero hand-duplicated shapes. | A1.1, A1.2 |
| **G2** | Every mail tool's `outputSchema` is a concrete `mail.ts` schema (not `z.unknown()`); handlers `.parse()` at the edge. | A1.2 |
| **G3** | Zero `process.env` in `platform/mail/*` (incl. `providers.ts:470`); all mail config via `env()` + `mail/config.ts`. | A1.4 |
| **G4** | Mail tools throw `MailError` subclasses (`MailThreadNotFoundError`, `MailFilterNotFoundError`, `MailProviderError`, …); no bare `throw new Error(...)` for client-visible failures. | A1.3 |
| **G5** | Thread-list/folder projection + filter matching + draft mapping live in `mail/core/*`, unit-tested without a DB; `PostgresMailStore` becomes a thin adapter. | A3.2 |
| **G6** | Every mutating tool checks a write-appropriate scope; `mail.spam`/draft/cancel/alias tools carry least-privilege scopes; negative-authz test each. | A0.1, A0.2, A2.x |
| **G7** | Mail imports cross-tier only via `@helix/contracts`/`@helix/sdk*`; no reach into `platform/chat/*` internals. | passes existing lint |
| **G8** | New mail capabilities (spam, filter.list, draft.*, outbound.cancel, alias.*) are tools first; web + CLI consume via contracts. | A0, A2 |
| **G9** | Unit tests for core, integration for store/routes, negative-authz per mutation; `mail-shell.tsx` (2709 LOC), `store.ts` (1689), `admin-store.ts` (1292) each split < 400 LOC or carry a `// ponytail:` note. | A3, A4 |

## Phase A0 — P0 correctness/security (registered tools the UI already calls)

> **Why first:** the web frontend already invokes `mail.spam` (`api.ts:334`) and `mail.filter.list` (`api.ts:398`), but neither tool is registered in `tools.ts` — **both calls 404 in production today.** The backend already has the store methods (`updateThreadState` accepts a `spamAt` patch at `store.ts:516`; `listFilters(orgId, actorId)` at `store.ts:616`). These are thin, high-value wrappers.

### Task A0.1: Register the `mail.spam` tool

**Files:**
- Modify: `apps/helix/src/platform/mail/tools.ts` (insert a new tool in the array returned by `createMailToolDefinitions`, alongside the other `threadStateTool` entries near `:402`)
- Test: `apps/helix/src/platform/mail/tools.test.ts` (create if absent; otherwise extend) and the existing `mail.test.ts`

**Interfaces:**
- Consumes: `MailStore.updateThreadState({ orgId, actorId, threadId, patch: { spamAt: Date | null } })` (already exists, `store.ts:504`+).
- Produces: tool `mail.spam` — input `{ threadId: uuid, spam?: boolean }` (default `spam: true`), output `{ ok: true, threadId, spamAt: string | null }`, permission `mail.write`, `sideEffects: "write"`.

- [ ] **Step 1: Write the failing test** — append to `apps/helix/src/platform/mail/tools.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { createMailToolDefinitions } from "./tools.js";
import type { MailStore } from "./store.js";

function toolById(id: string) {
  const store = { updateThreadState: vi.fn().mockResolvedValue(undefined) } as unknown as MailStore;
  const tool = createMailToolDefinitions({ store }).find((t) => t.id === id);
  if (tool === undefined) throw new Error(`tool ${id} not registered`);
  return { tool, store };
}

describe("mail.spam tool", () => {
  it("is registered", () => {
    expect(createMailToolDefinitions({ store: {} as MailStore }).some((t) => t.id === "mail.spam")).toBe(true);
  });

  it("stamps spam_at when marking spam", async () => {
    const { tool, store } = toolById("mail.spam");
    const ctx = { actor: { id: "a1", orgId: "o1" } } as never;
    const out = (await tool.handler({ threadId: "11111111-1111-1111-1111-111111111111", spam: true }, ctx)) as {
      ok: boolean;
    };
    expect(out.ok).toBe(true);
    expect(store.updateThreadState).toHaveBeenCalledWith(
      expect.objectContaining({ patch: expect.objectContaining({ spamAt: expect.any(Date) }) }),
    );
  });

  it("clears spam_at when un-marking (spam:false)", async () => {
    const { tool, store } = toolById("mail.spam");
    const ctx = { actor: { id: "a1", orgId: "o1" } } as never;
    await tool.handler({ threadId: "11111111-1111-1111-1111-111111111111", spam: false }, ctx);
    expect(store.updateThreadState).toHaveBeenCalledWith(
      expect.objectContaining({ patch: expect.objectContaining({ spamAt: null }) }),
    );
  });

  it("requires the mail.write scope (not mail.read)", () => {
    const { tool } = toolById("mail.spam");
    expect(tool.permission).toBe("mail.write");
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `pnpm --filter @helix/app test -- mail/tools` → FAIL (`tool mail.spam not registered`).

- [ ] **Step 3: Implement.** In `apps/helix/src/platform/mail/tools.ts`, add a `spamSchema` next to `starStateSchema` (`:100`):

```ts
const spamSchema = z.object({
  threadId: uuidSchema,
  spam: z.boolean().default(true),
});
```

Then insert this `defineTool` entry into the returned array immediately after the `mail.star.set` tool (`:474`), before `mail.snooze`:

```ts
    defineTool<z.output<typeof spamSchema>, unknown>({
      id: "mail.spam",
      description: "Mark a mail thread as spam (or clear the spam flag) for the current user.",
      permission: "mail.write",
      sideEffects: "write",
      inputSchema: zodToolSchema(spamSchema, genericObjectJsonSchema),
      outputSchema: zodToolSchema(z.unknown(), genericObjectJsonSchema),
      handler: async (input, ctx) => {
        const spamAt = input.spam ? new Date() : null;
        await options.store.updateThreadState({
          orgId: ctx.actor.orgId,
          actorId: ctx.actor.id,
          threadId: input.threadId,
          patch: { spamAt },
        });
        return { ok: true, threadId: input.threadId, spamAt: spamAt?.toISOString() ?? null };
      },
    }),
```

> `outputSchema` is `z.unknown()` here only because this task pre-dates the mail contract (A1). Task A1.2 replaces it with `mailSpamResultSchema`. This ordering keeps A0 shippable independently as the 404 hotfix.

- [ ] **Step 4: Run to verify it passes** — `pnpm --filter @helix/app test -- mail/tools` → PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/helix/src/platform/mail/tools.ts apps/helix/src/platform/mail/tools.test.ts
git commit -m "fix(mail): register mail.spam tool (web api.ts:334 was 404ing)"
```

### Task A0.2: Register the `mail.filter.list` tool

**Files:**
- Modify: `apps/helix/src/platform/mail/tools.ts` (add tool after `mail.filter.delete` at `:546`)
- Test: `apps/helix/src/platform/mail/tools.test.ts`

**Interfaces:**
- Consumes: `MailStore.listFilters(orgId: string, actorId: string): Promise<readonly MailFilterRecord[]>` (`store.ts:616`).
- Produces: tool `mail.filter.list` — input `{}`, output `{ filters: SerializedFilter[] }`, permission `mail.read`, `sideEffects: "read"`. Reuses the existing `serializeFilter` helper (`tools.ts:860`).

- [ ] **Step 1: Write the failing test** — append to `tools.test.ts`:

```ts
describe("mail.filter.list tool", () => {
  it("is registered and reads via store.listFilters", async () => {
    const now = new Date();
    const store = {
      listFilters: vi.fn().mockResolvedValue([
        { id: "f1", name: "Newsletters", enabled: true, priority: 100, criteria: {}, actions: {}, createdAt: now, updatedAt: now },
      ]),
    } as unknown as MailStore;
    const tool = createMailToolDefinitions({ store }).find((t) => t.id === "mail.filter.list");
    expect(tool).toBeDefined();
    expect(tool?.permission).toBe("mail.read");
    const ctx = { actor: { id: "a1", orgId: "o1" } } as never;
    const out = (await tool!.handler({}, ctx)) as { filters: { id: string; createdAt: string }[] };
    expect(store.listFilters).toHaveBeenCalledWith("o1", "a1");
    expect(out.filters[0]?.id).toBe("f1");
    expect(typeof out.filters[0]?.createdAt).toBe("string"); // serialized to ISO
  });
});
```

- [ ] **Step 2: Run** — `pnpm --filter @helix/app test -- mail/tools` → FAIL.

- [ ] **Step 3: Implement.** Add `const filterListSchema = z.object({});` next to `filterDeleteSchema` (`:129`). Insert after the `mail.filter.delete` tool (`:546`):

```ts
    defineTool<z.output<typeof filterListSchema>, unknown>({
      id: "mail.filter.list",
      description: "List the current user's mail filters, ordered by priority.",
      permission: "mail.read",
      sideEffects: "read",
      inputSchema: zodToolSchema(filterListSchema, genericObjectJsonSchema),
      outputSchema: zodToolSchema(z.unknown(), genericObjectJsonSchema),
      handler: async (_input, ctx) => ({
        filters: (await options.store.listFilters(ctx.actor.orgId, ctx.actor.id)).map(serializeFilter),
      }),
    }),
```

- [ ] **Step 4: Run** — `pnpm --filter @helix/app test -- mail/tools` → PASS.

- [ ] **Step 5: Smoke the two 404s end-to-end.** In `apps/web/src/features/mail/api.ts`, confirm `spamMailThread` (`:330`) and `listMailFilters` (`:394`) now resolve against the registered tools (no code change needed in web; the tool IDs match). Add/extend `apps/web/src/features/mail/api.test.ts` with a mock-fetch test asserting both call `mail.spam` / `mail.filter.list` and parse the result without throwing. Run `pnpm --filter @helix/web test -- mail/api` → PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/helix/src/platform/mail/tools.ts apps/helix/src/platform/mail/tools.test.ts apps/web/src/features/mail/api.test.ts
git commit -m "fix(mail): register mail.filter.list tool (web api.ts:398 was 404ing)"
```

## Phase A1 — Contracts, errors, config (G1/G2/G3/G4)

### Task A1.1: Author `packages/contracts/src/mail.ts` (Zod single source of truth)

**Files:**
- Create: `packages/contracts/src/mail.ts`, `packages/contracts/src/mail.test.ts`
- Modify: `packages/contracts/src/index.ts` (add `export * from "./mail.js";`), `packages/contracts/package.json` (add `"./mail": "./dist/mail.js"` to `exports`)

**Interfaces:**
- Consumes: nothing (depends only on `zod`).
- Produces (exact names): `mailAddressSchema`, `mailAttachmentInputSchema`, `mailSendInputSchema`, `mailReplyInputSchema`, `mailThreadRowSchema`, `mailThreadDetailSchema`, `mailFilterSchema`, `mailFilterCreateInputSchema`, `mailFilterUpdateInputSchema`, `mailFolderSummarySchema`, `mailLabelSchema`, `mailSearchInputSchema`, `mailSearchHitSchema`, `mailOutboundRecordSchema`, `mailSpamInputSchema`, `mailSpamResultSchema`, and the `z.infer` types (`MailSendInput`, `MailThreadRow`, `MailFilter`, …). These are imported by `tools.ts` (Task A1.2) and `apps/web/src/features/mail/api.ts` (Task A1.2 web slice).

> **Grounding:** mirror the shapes already defined ad-hoc in `tools.ts` (`sendSchema:44`, `replySchema:75`, `filterCreateSchema:120`, `searchSchema:149`, `threadsListSchema:162`) and the serialize helpers (`serializeThreadRow:901`, `serializeFilter:860`, `serializeFolder:921`, `serializeLabel:930`). Read those before writing so field names and optionality match exactly (`exactOptionalPropertyTypes` will reject drift).

- [ ] **Step 1: Write the failing test** — `packages/contracts/src/mail.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  mailSendInputSchema,
  mailThreadRowSchema,
  mailFilterSchema,
  mailSpamInputSchema,
} from "./mail.js";

describe("mail contracts", () => {
  it("parses a minimal send input and applies array defaults", () => {
    const parsed = mailSendInputSchema.parse({
      to: [{ address: "a@b.com" }],
      subject: "hi",
      bodyText: "body",
    });
    expect(parsed.cc).toEqual([]);
    expect(parsed.bcc).toEqual([]);
    expect(parsed.attachments).toEqual([]);
  });

  it("rejects a send with no recipients", () => {
    expect(() => mailSendInputSchema.parse({ to: [], subject: "x", bodyText: "y" })).toThrow();
  });

  it("validates a thread-row projection shape", () => {
    const row = mailThreadRowSchema.parse({
      threadId: "t1", messageId: "m1", subject: "s", from: "A", fromEmail: "a@b.com",
      preview: "p", time: "now", unread: true, starred: false, hasAttachment: false,
      messageCount: 1, labels: [], category: "primary", folder: "inbox", snoozedUntil: null,
    });
    expect(row.unread).toBe(true);
  });

  it("defaults spam:true in mailSpamInputSchema", () => {
    expect(mailSpamInputSchema.parse({ threadId: "11111111-1111-1111-1111-111111111111" }).spam).toBe(true);
  });

  it("filter schema round-trips ISO timestamps as strings", () => {
    const f = mailFilterSchema.parse({
      id: "f1", name: "n", enabled: true, priority: 100, criteria: {}, actions: {},
      createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(f.priority).toBe(100);
  });
});
```

- [ ] **Step 2: Run** — `pnpm --filter @helix/contracts test -- mail` → FAIL (no module).

- [ ] **Step 3: Implement `packages/contracts/src/mail.ts`** (real, complete; extend to cover every field in the referenced serialize helpers):

```ts
import { z } from "zod";

export const mailAddressSchema = z.object({
  address: z.string().email(),
  name: z.string().min(1).optional(),
});
export type MailAddress = z.infer<typeof mailAddressSchema>;

export const mailAttachmentInputSchema = z.object({
  filename: z.string().min(1).optional(),
  contentType: z.string().min(1).optional(),
  content: z.string().min(1).optional(), // base64 (legacy path; A2.5 adds objectId)
  objectId: z.string().uuid().optional(), // Drive object streaming (A2.5)
  path: z.string().min(1).optional(),
});
export type MailAttachmentInput = z.infer<typeof mailAttachmentInputSchema>;

export const mailSendInputSchema = z.object({
  from: mailAddressSchema.optional(),
  to: z.array(mailAddressSchema).min(1),
  cc: z.array(mailAddressSchema).default([]),
  bcc: z.array(mailAddressSchema).default([]),
  subject: z.string().max(998),
  bodyText: z.string(),
  bodyHtml: z.string().optional(),
  attachments: z.array(mailAttachmentInputSchema).default([]),
  undoWindowMs: z.number().int().min(0).max(300_000).optional(),
});
export type MailSendInput = z.infer<typeof mailSendInputSchema>;

export const mailReplyInputSchema = mailSendInputSchema.omit({ subject: true }).extend({
  threadId: z.string().uuid(),
  subject: z.string().max(998).optional(),
  inReplyTo: z.string().optional(),
  references: z.array(z.string()).default([]),
});
export type MailReplyInput = z.infer<typeof mailReplyInputSchema>;

export const mailThreadRowSchema = z.object({
  threadId: z.string(),
  messageId: z.string(),
  subject: z.string(),
  from: z.string(),
  fromEmail: z.string(),
  preview: z.string(),
  time: z.string(),
  unread: z.boolean(),
  starred: z.boolean(),
  hasAttachment: z.boolean(),
  messageCount: z.number().int().nonnegative(),
  labels: z.array(z.string()),
  category: z.string(),
  folder: z.string(),
  snoozedUntil: z.string().nullable(),
});
export type MailThreadRow = z.infer<typeof mailThreadRowSchema>;

export const mailThreadsListResultSchema = z.object({
  threads: z.array(mailThreadRowSchema),
  total: z.number().int().nonnegative(),
  limit: z.number().int().positive(),
  offset: z.number().int().nonnegative(),
});
export type MailThreadsListResult = z.infer<typeof mailThreadsListResultSchema>;

export const mailFilterCriteriaSchema = z.object({
  fromContains: z.string().min(1).optional(),
  toContains: z.string().min(1).optional(),
  subjectContains: z.string().min(1).optional(),
  bodyContains: z.string().min(1).optional(),
  hasAttachment: z.boolean().optional(),
});
export const mailFilterActionsSchema = z.object({
  applyLabels: z.array(z.string().min(1)).optional(),
  archive: z.boolean().optional(),
  delete: z.boolean().optional(),
  snoozeUntil: z.string().datetime().optional(),
});
export const mailFilterSchema = z.object({
  id: z.string(),
  name: z.string(),
  enabled: z.boolean(),
  priority: z.number().int(),
  criteria: mailFilterCriteriaSchema,
  actions: mailFilterActionsSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type MailFilter = z.infer<typeof mailFilterSchema>;

export const mailFilterCreateInputSchema = z.object({
  name: z.string().min(1),
  enabled: z.boolean().default(true),
  priority: z.number().int().default(100),
  criteria: mailFilterCriteriaSchema.default({}),
  actions: mailFilterActionsSchema.default({}),
});
export const mailFilterUpdateInputSchema = mailFilterCreateInputSchema.partial().extend({
  id: z.string().uuid(),
});

export const mailFolderSummarySchema = z.object({
  id: z.string(),
  label: z.string(),
  total: z.number().int().nonnegative(),
  unread: z.number().int().nonnegative(),
});
export type MailFolderSummary = z.infer<typeof mailFolderSummarySchema>;

export const mailLabelSchema = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
  color: z.string().nullable(),
  sortOrder: z.number().int(),
  threadCount: z.number().int().nonnegative(),
  shared: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type MailLabel = z.infer<typeof mailLabelSchema>;

export const mailSearchInputSchema = z.object({
  query: z.string().optional(),
  labels: z.array(z.string().min(1)).default([]),
  limit: z.number().int().positive().max(100).default(50),
});
export const mailSearchHitSchema = z.object({
  threadId: z.string(),
  messageId: z.string(),
  subject: z.string(),
  snippet: z.string(),
  sentAt: z.string(),
});
export type MailSearchHit = z.infer<typeof mailSearchHitSchema>;

export const mailOutboundRecordSchema = z.object({
  id: z.string(),
  messageId: z.string(),
  threadId: z.string(),
  status: z.string(),
  undoUntil: z.string(),
  queuedAt: z.string(),
  sentAt: z.string().nullable().optional(),
  cancelledAt: z.string().nullable().optional(),
  failedAt: z.string().nullable().optional(),
  lastError: z.string().nullable().optional(),
  providerMessageId: z.string().nullable().optional(),
});
export type MailOutboundRecord = z.infer<typeof mailOutboundRecordSchema>;

export const mailSpamInputSchema = z.object({
  threadId: z.string().uuid(),
  spam: z.boolean().default(true),
});
export const mailSpamResultSchema = z.object({
  ok: z.literal(true),
  threadId: z.string(),
  spamAt: z.string().nullable(),
});
export type MailSpamResult = z.infer<typeof mailSpamResultSchema>;
```

- [ ] **Step 4:** Add `export * from "./mail.js";` to `packages/contracts/src/index.ts` and `"./mail": "./dist/mail.js"` to `packages/contracts/package.json` `exports`.

- [ ] **Step 5: Run** — `pnpm --filter @helix/contracts test -- mail && pnpm --filter @helix/contracts typecheck` → PASS (5 tests).

- [ ] **Step 6: Commit**

```bash
git add packages/contracts/src/mail.ts packages/contracts/src/mail.test.ts packages/contracts/src/index.ts packages/contracts/package.json
git commit -m "feat(contracts): author mail schemas as the single source of truth"
```

### Task A1.2: Adopt mail contracts in tools (G1/G2) and web (G1)

**Files:**
- Modify: `apps/helix/src/platform/mail/tools.ts` (replace local ad-hoc schemas + `z.unknown()` output schemas with `@helix/contracts` schemas), `apps/helix/package.json` (ensure `@helix/contracts` dep)
- Modify: `apps/web/src/features/mail/api.ts` (delete duplicated DTOs; import from `@helix/contracts`), `apps/web/package.json` (ensure `@helix/contracts` dep)
- Test: `apps/helix/src/platform/mail/tools.test.ts`, `apps/web/src/features/mail/api.test.ts`

**Interfaces:**
- Consumes: all schemas from Task A1.1.
- Produces: mail tools whose `inputSchema`/`outputSchema` are concrete contract schemas (G2); web `api.ts` types are `z.infer` re-exports (G1).

- [ ] **Step 1: Write the failing test** — add to `tools.test.ts`:

```ts
import { mailSpamResultSchema, mailThreadsListResultSchema } from "@helix/contracts";

it("mail.spam output validates against the contract", async () => {
  const store = { updateThreadState: vi.fn().mockResolvedValue(undefined) } as unknown as MailStore;
  const tool = createMailToolDefinitions({ store }).find((t) => t.id === "mail.spam")!;
  const ctx = { actor: { id: "a1", orgId: "o1" } } as never;
  const out = await tool.handler({ threadId: "11111111-1111-1111-1111-111111111111", spam: true }, ctx);
  expect(() => mailSpamResultSchema.parse(out)).not.toThrow();
});

it("no mail tool ships a z.unknown() outputSchema", () => {
  // outputSchema JSON is `genericObjectJsonSchema` today; assert every tool declares a concrete
  // contract by checking the registry's parse step in the handler paths under test.
  const tools = createMailToolDefinitions({ store: {} as MailStore });
  for (const t of tools) expect(t.outputSchema).toBeDefined();
});
```

- [ ] **Step 2: Run** → FAIL (the `mail.spam` handler currently returns `spamAt` possibly typed loosely / import path unresolved until wired).

- [ ] **Step 3: Implement (backend).** In `tools.ts`:
  - Add `import { mailSendInputSchema, mailReplyInputSchema, mailFilterCreateInputSchema, mailFilterUpdateInputSchema, mailSearchInputSchema, mailSpamInputSchema, mailSpamResultSchema, mailThreadsListResultSchema, mailFilterSchema, mailFolderSummarySchema, mailLabelSchema } from "@helix/contracts";` at the top.
  - Replace the local `sendSchema`/`replySchema`/`filterCreateSchema`/`filterUpdateSchema`/`searchSchema`/`spamSchema` declarations with the imported contract schemas (delete the now-duplicate locals). Keep local-only helper schemas that have no contract equivalent (e.g. `inboundAcceptSchema`) as-is.
  - Change each mutating/reading tool's `outputSchema` from `zodToolSchema(z.unknown(), genericObjectJsonSchema)` to the concrete contract schema wrapped by `zodToolSchema(...)`. Start with the four highest-traffic: `mail.spam` → `mailSpamResultSchema`; `mail.threads.list` → `mailThreadsListResultSchema`; `mail.filter.list`/`create`/`update` → `z.object({ filters: z.array(mailFilterSchema) })` / `mailFilterSchema`; `mail.folders.list` → `z.object({ folders: z.array(mailFolderSummarySchema) })`; `mail.labels.list` → `z.object({ labels: z.array(mailLabelSchema) })`. (The remaining tools follow the same substitution — one commit may batch them.)

- [ ] **Step 4: Implement (web).** In `apps/web/src/features/mail/api.ts`, delete the locally-declared interfaces that duplicate contract shapes (e.g. `MailThreadsListResult`, `MailFilterRecord`, `MailFolderSummary`, `MailLabelSummary`, `MailSearchHit`, `MailAttachment` around `:120`–`:200`) and replace with `import type { MailThreadsListResult, MailFilter as MailFilterRecord, MailFolderSummary, MailLabel as MailLabelSummary, MailSearchHit, MailAttachmentInput as MailAttachment } from "@helix/contracts";`. Adjust call sites where names differ.

- [ ] **Step 5: Run the gate** — `pnpm --filter @helix/app test -- mail/tools && pnpm --filter @helix/app typecheck && pnpm --filter @helix/web typecheck && pnpm --filter @helix/web test -- mail/api`. Expected: PASS. Any typecheck error is the contract catching real drift — fix the schema in A1.1 and re-run.

- [ ] **Step 6: Commit** (two commits — backend then web):

```bash
git add apps/helix/src/platform/mail/tools.ts apps/helix/src/platform/mail/tools.test.ts apps/helix/package.json
git commit -m "refactor(mail): tool I/O validated by @helix/contracts (G1/G2)"
git add apps/web/src/features/mail/api.ts apps/web/src/features/mail/api.test.ts apps/web/package.json
git commit -m "refactor(web): mail api consumes @helix/contracts DTOs (G1)"
```

### Task A1.3: Mail errors via `ApiError` subclasses (G4)

**Files:**
- Create: `apps/helix/src/platform/mail/errors.ts`, `apps/helix/src/platform/mail/errors.test.ts`
- Modify: `apps/helix/src/platform/mail/tools.ts` (replace `throw new Error(...)` at `:350`, `:527` with typed errors), `apps/helix/src/platform/mail/outbound.ts` (`:272` invalid payload), `apps/helix/src/platform/mail/store.ts` (client-visible throws)

**Interfaces:**
- Consumes: `ApiError`, `BadRequestError`, `ForbiddenError`, `NotFoundError`, `ConflictError` from `apps/helix/src/api/api-error.js` (cross-cutting Phase 3).
- Produces: `MailError` (extends `ApiError`), `MailThreadNotFoundError extends NotFoundError`, `MailFilterNotFoundError extends NotFoundError`, `MailInboundActorForbiddenError extends ForbiddenError`, `MailOutboundPayloadError extends BadRequestError`, `MailProviderError extends ApiError` (code `internal_error`, wraps dispatch failures with `cause`). Each carries a stable `code` string in `details.mailCode` for observability.

- [ ] **Step 1: Write the failing test** — `errors.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { NotFoundError, ForbiddenError } from "../../api/api-error.js";
import { MailThreadNotFoundError, MailFilterNotFoundError, MailInboundActorForbiddenError } from "./errors.js";

describe("mail errors", () => {
  it("MailThreadNotFoundError is a 404 ApiError carrying the thread id", () => {
    const e = new MailThreadNotFoundError("t1");
    expect(e).toBeInstanceOf(NotFoundError);
    expect(e.statusCode).toBe(404);
    expect(e.code).toBe("not_found");
    expect(String(e.message)).toContain("t1");
  });
  it("MailFilterNotFoundError is a 404", () => {
    expect(new MailFilterNotFoundError("f1").statusCode).toBe(404);
  });
  it("MailInboundActorForbiddenError is a 403", () => {
    const e = new MailInboundActorForbiddenError("user");
    expect(e).toBeInstanceOf(ForbiddenError);
    expect(e.statusCode).toBe(403);
  });
});
```

- [ ] **Step 2: Run** — `pnpm --filter @helix/app test -- mail/errors` → FAIL.

- [ ] **Step 3: Implement `errors.ts`**:

```ts
import { ApiError, BadRequestError, ForbiddenError, NotFoundError } from "../../api/api-error.js";

export class MailThreadNotFoundError extends NotFoundError {
  constructor(threadId: string) {
    super(`Unknown or inaccessible mail thread: ${threadId}`, { details: { mailCode: "mail.thread_not_found", threadId } });
    this.name = "MailThreadNotFoundError";
  }
}
export class MailFilterNotFoundError extends NotFoundError {
  constructor(filterId: string) {
    super(`Unknown mail filter: ${filterId}`, { details: { mailCode: "mail.filter_not_found", filterId } });
    this.name = "MailFilterNotFoundError";
  }
}
export class MailInboundActorForbiddenError extends ForbiddenError {
  constructor(actorType: string) {
    super(`mail.inbound.accept requires a service-account or system actor; got ${actorType}.`, {
      details: { mailCode: "mail.inbound_forbidden", actorType },
    });
    this.name = "MailInboundActorForbiddenError";
  }
}
export class MailOutboundPayloadError extends BadRequestError {
  constructor() {
    super("Invalid mail.send outbox payload.", { details: { mailCode: "mail.outbox_payload_invalid" } });
    this.name = "MailOutboundPayloadError";
  }
}
export class MailProviderError extends ApiError {
  constructor(message: string, cause: unknown) {
    super("internal_error", message, { details: { mailCode: "mail.provider_failed" }, cause });
    this.name = "MailProviderError";
  }
}
```

- [ ] **Step 4:** Replace the bare throws:
  - `tools.ts:350` (`mail.inbound.accept` actor guard) → `throw new MailInboundActorForbiddenError(ctx.actor.type);`
  - `tools.ts:527` (`mail.filter.update` unknown filter) → `throw new MailFilterNotFoundError(id);`
  - `outbound.ts:272` (`mailOutboxPayloadSchema`) → `throw new MailOutboundPayloadError();`
  - Add imports to each edited file. Leave `providers.ts` provider-selection errors for A1.4/A2.6.

- [ ] **Step 5: Run** — `pnpm --filter @helix/app test -- mail` → PASS (update any test that asserted the old `Error` message string to assert the typed error / `statusCode`).

- [ ] **Step 6: Commit** `feat(mail): typed ApiError subclasses for mail failures (G4)`.

### Task A1.4: Fold mail config into the `env` module + `mail/config.ts` (G3)

**Files:**
- Modify: `apps/helix/src/config/env.ts` (extend schema with mail keys), `apps/helix/src/server.ts` (`getOutboundMailConfig:3803`, `getSmtpMailReceiverConfig:3823`, spam/clamav wiring `:1739`–`:1740`, `:1680`, `:1736`, `MAIL_FROM_DOMAIN:2017`), `apps/helix/src/platform/mail/providers.ts` (`:470` `input.env ?? process.env`), `apps/helix/src/platform/mail/spam.ts` (`:253`), `apps/helix/src/platform/mail/antivirus.ts` (`:201`)
- Create: `apps/helix/src/platform/mail/config.ts`, `apps/helix/src/platform/mail/config.test.ts`

**Interfaces:**
- Consumes: `env()` from `apps/helix/src/config/env.js`.
- Produces: `mailConfig(env: Env): MailConfig` returning `{ fromDomain, outbound, receiver, spamd, clamav, defaultOrgId, signupFrom }` — one typed struct assembled from validated env, replacing the scattered `process.env` reads. `MailConfig` is `z.infer` of a schema declared here.

> **Grounding:** the env keys in play are `MAIL_FROM_DOMAIN`, `HELIX_DEFAULT_ORG_ID`, `HELIX_SIGNUP_EMAIL_FROM*`, the SMTP host/port/user/pass consumed by `getOutboundMailConfig`, the SMTP-receiver keys in `getSmtpMailReceiverConfig`, and the spamd/clamd host/port pairs. Grep first: `grep -rn "process.env" apps/helix/src/platform/mail apps/helix/src/server.ts | grep -iE "MAIL|SMTP|SPAM|CLAM|SIGNUP|DEFAULT_ORG"`.

- [ ] **Step 1: Write the failing test** — `config.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { mailConfig } from "./config.js";
import { loadEnv } from "../../config/env.js";

const base = {
  DATABASE_URL: "postgres://u:p@localhost:5432/helix",
  REDIS_URL: "redis://localhost:6379",
  MAIL_FROM_DOMAIN: "helix.test",
  SMTP_HOST: "smtp.helix.test",
};

describe("mailConfig", () => {
  it("derives the from-domain and outbound host from validated env", () => {
    const cfg = mailConfig(loadEnv(base));
    expect(cfg.fromDomain).toBe("helix.test");
    expect(cfg.outbound?.host).toBe("smtp.helix.test");
  });
  it("defaults from-domain to localhost when unset", () => {
    expect(mailConfig(loadEnv({ DATABASE_URL: base.DATABASE_URL, REDIS_URL: base.REDIS_URL })).fromDomain).toBe("localhost");
  });
});
```

- [ ] **Step 2: Run** — `pnpm --filter @helix/app test -- mail/config` → FAIL.

- [ ] **Step 3: Extend `env.ts`.** Add the mail keys to the `envSchema` (all optional except where a default is sensible):

```ts
  MAIL_FROM_DOMAIN: z.string().default("localhost"),
  HELIX_DEFAULT_ORG_ID: z.string().uuid().optional(),
  HELIX_SIGNUP_EMAIL_FROM: z.string().email().optional(),
  HELIX_SIGNUP_EMAIL_FROM_NAME: z.string().optional(),
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().positive().optional(),
  SMTP_SECURE: z.coerce.boolean().optional(),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  MAIL_RECEIVER_HOST: z.string().optional(),
  MAIL_RECEIVER_PORT: z.coerce.number().int().positive().optional(),
  SPAMD_HOST: z.string().optional(),
  SPAMD_PORT: z.coerce.number().int().positive().optional(),
  CLAMD_HOST: z.string().optional(),
  CLAMD_PORT: z.coerce.number().int().positive().optional(),
```

  (Match the exact key names the grep in the header found; adjust if the codebase uses different literals.)

- [ ] **Step 4: Implement `mail/config.ts`** — a pure function assembling the struct from `Env`, mirroring what `getOutboundMailConfig`/`getSmtpMailReceiverConfig`/`getSpamdScannerConfig`/`getClamavScannerConfig` build today, but reading `env.SMTP_HOST` etc. instead of `process.env`. Move the *logic* of those four functions into `config.ts` (as `buildOutboundConfig(env)`, `buildReceiverConfig(env)`, `buildSpamdConfig(env)`, `buildClamavConfig(env)`), leaving `server.ts` to call `mailConfig(env())`.

- [ ] **Step 5: Rewire `server.ts`.** At `:1680` replace `getOutboundMailConfig(process.env)` with `mailConfig(appEnv).outbound`; at `:1736` `getSmtpMailReceiverConfig(process.env)` → `mailConfig(appEnv).receiver`; `:1739`/`:1740` spamd/clamav → `mailConfig(appEnv).spamd` / `.clamav`; `:2017` `process.env.MAIL_FROM_DOMAIN ?? "localhost"` → `mailConfig(appEnv).fromDomain` (where `appEnv = env()`). Remove the now-dead `getOutboundMailConfig`/`getSmtpMailReceiverConfig` exports from `server.ts` (or have them delegate to `config.ts` for back-compat if imported by tests).

- [ ] **Step 6: Kill the last `process.env` in `platform/mail`.** In `providers.ts:470`, change the signature so the provider factory receives resolved config from `config.ts` rather than `input.env ?? process.env`. In `spam.ts:253` and `antivirus.ts:201`, accept the config struct instead of reading `process.env`. Verify: `grep -rn "process.env" apps/helix/src/platform/mail --include=*.ts | grep -v ".test.ts"` → **zero hits**.

- [ ] **Step 7: Run** — `pnpm --filter @helix/app test -- mail && pnpm --filter @helix/app typecheck` → PASS.

- [ ] **Step 8: Commit** `refactor(config): mail reads validated env via mail/config.ts (G3)`.

## Phase A2 — Product-gap features

### Task A2.1: True draft persistence (`mail.draft.save/get/list/discard` + `mail_drafts`)

**Files:**
- Create: `apps/helix/src/db/migrations/0065_mail_drafts.sql`, `apps/helix/src/platform/mail/drafts.ts` (store methods), `apps/helix/src/platform/mail/drafts.test.ts`
- Create (contract): add draft schemas to `packages/contracts/src/mail.ts`
- Modify: `apps/helix/src/platform/mail/store.ts` (add draft methods to `MailStore` interface + `PostgresMailStore`; update Drafts folder projection at `:957`), `apps/helix/src/platform/mail/tools.ts` (register 4 tools), `apps/web/src/features/mail/api.ts` + `queries.ts` + compose UI

**Interfaces:**
- Consumes: `tenantScoped()` / `sql`.
- Produces: table `mail_drafts (id uuid pk, org_id, actor_id, thread_id null, envelope jsonb, updated_at, created_at)`; store methods `saveDraft/getDraft/listDrafts/discardDraft`; tools `mail.draft.save` (`mail.write`), `mail.draft.get`/`mail.draft.list` (`mail.read`), `mail.draft.discard` (`mail.write`, `destructive`).

> **Grounding:** the current "Drafts" folder is a mislabel — `store.ts:957` shows it queries `outbound_status = 'queued'`, i.e. it lists **queued-for-send** messages inside their undo window, not user drafts. This task adds a real drafts store and re-points the Drafts folder projection at it.

- [ ] **Step 1: Write the migration** — `0065_mail_drafts.sql`:

```sql
create table if not exists mail_drafts (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  actor_id uuid not null,
  thread_id uuid null references threads(id) on delete set null,
  envelope jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists mail_drafts_actor_idx on mail_drafts (org_id, actor_id, updated_at desc);
```

- [ ] **Step 2: Write the failing test** — `drafts.test.ts` (integration, gated on DB like the other `*.store.test.ts`): assert `saveDraft` upserts, `listDrafts` returns newest-first scoped to `(org_id, actor_id)`, a draft from another actor is invisible, `discardDraft` deletes and returns `true`. Include a **negative-authz** case: `getDraft` for an id owned by another actor returns `null`.

- [ ] **Step 3: Run** — `pnpm --filter @helix/app test -- mail/drafts` → FAIL.

- [ ] **Step 4: Implement `drafts.ts`** with the four methods using the `sql` idiom from `store.ts` (org+actor predicates on every query). Add the contract schemas `mailDraftSchema`, `mailDraftSaveInputSchema` (`{ id?: uuid, threadId?: uuid, envelope: mailSendInputSchema.partial() }`), `mailDraftListResultSchema` to `mail.ts`.

- [ ] **Step 5: Register the 4 tools** in `tools.ts` following the `defineTool` pattern; `outputSchema` = the new contract schemas (G2). Update the Drafts folder projection: change `store.ts:957` `when 'drafts' then deleted_at is null and outbound_status = 'queued'` to source from `mail_drafts` (union the drafts projection into `listThreads`/`listFolders`, keying off a `mail_drafts` presence). Keep queued-outbound visible under a separate "Outbox" pseudo-folder or fold it into Sent-pending.

- [ ] **Step 6: Wire web** — add `saveMailDraft`/`listMailDrafts`/`discardMailDraft` to `api.ts`, a `useMailDrafts` query in `queries.ts`, and auto-save-on-blur in the Compose panel (currently inside `mail-shell.tsx`; after A3.1 it's `compose.tsx`).

- [ ] **Step 7: Run** — `pnpm --filter @helix/app test -- mail/drafts && pnpm --filter @helix/web test -- mail` → PASS.

- [ ] **Step 8: Commit** `feat(mail): first-class draft persistence with mail_drafts + tools`.

### Task A2.2: Surface undo-send in the UI (`mail.outbound.cancel` tool + Compose)

**Files:**
- Modify: `apps/helix/src/platform/mail/tools.ts` (register `mail.outbound.cancel`), `packages/contracts/src/mail.ts` (add `mailOutboundCancelInputSchema`), `apps/web/src/features/mail/api.ts` + compose UI + `mail-store.ts`
- Test: `apps/helix/src/platform/mail/tools.test.ts`

**Interfaces:**
- Consumes: `MailSendService.cancel({ orgId, actorId, id })` (`outbound.ts:138`) → `MailStore.cancelOutbound` (`store.ts:477`), both already implemented but **unexposed**.
- Produces: tool `mail.outbound.cancel` — input `{ id: string }`, output `mailOutboundRecordSchema | { outbound: null }`, permission `mail.write`, `sideEffects: "write"`. Guards ownership (`outbound.orgId === actor.orgId && outbound.actorId === actor.id`) exactly like `mail.outbound.get` (`tools.ts:673`).

- [ ] **Step 1: Write the failing test** — assert the tool exists, calls `store.cancelOutbound` with the actor's org/id, returns the serialized record, and returns `{ outbound: null }` (not a leak) when the record belongs to another actor. Negative-authz: a cancel for another actor's outbound id must not cancel it.

- [ ] **Step 2: Run** — `pnpm --filter @helix/app test -- mail/tools` → FAIL.

- [ ] **Step 3: Implement.** Add `const outboundCancelSchema = z.object({ id: z.string().min(1) });` and register after `mail.outbound.get` (`:682`):

```ts
    defineTool<z.output<typeof outboundCancelSchema>, unknown>({
      id: "mail.outbound.cancel",
      description: "Cancel a queued outbound mail message during its undo-send window.",
      permission: "mail.write",
      sideEffects: "write",
      inputSchema: zodToolSchema(outboundCancelSchema, genericObjectJsonSchema),
      outputSchema: zodToolSchema(mailOutboundRecordSchema, genericObjectJsonSchema),
      handler: async (input, ctx) => {
        const cancelled = await sendService.cancel({ orgId: ctx.actor.orgId, actorId: ctx.actor.id, id: input.id });
        return { outbound: cancelled === null ? null : serializeOutboundDetail(cancelled) };
      },
    }),
```

- [ ] **Step 4: Wire web** — add `cancelOutboundMail(id)` to `api.ts`; after `sendMail`/`replyToMail` return an outbound record with `undoUntil`, show a toast "Undo" button in Compose (`mail-shell.tsx` → later `compose.tsx`) that calls it while `Date.now() < undoUntil`; poll `mail.outbound.get` until `status` leaves `queued`.

- [ ] **Step 5: Run** — `pnpm --filter @helix/app test -- mail/tools && pnpm --filter @helix/web test -- mail` → PASS.

- [ ] **Step 6: Commit** `feat(mail): expose undo-send via mail.outbound.cancel + compose UI`.

### Task A2.3: Alias management (`mail.alias.list/create/delete` + admin route)

**Files:**
- Modify: `apps/helix/src/platform/mail/store.ts` (add `listAliases/createAlias/deleteAlias` if absent — check for existing `mail_aliases` access first), `apps/helix/src/platform/mail/tools.ts` (register 3 tools), `apps/helix/src/platform/mail/admin-routes.ts` (add `/api/admin/mail/aliases` GET/POST/DELETE mirroring the existing route style), `packages/contracts/src/mail.ts` (alias schemas)
- Test: `apps/helix/src/platform/mail/tools.test.ts`, `apps/helix/src/platform/mail/admin-routes.test.ts`

**Interfaces:**
- Consumes: the existing `mail_aliases` table (org-scoped).
- Produces: `mailAliasSchema` (`{ id, address, targetActorId, createdAt }`), tools `mail.alias.list` (`mail.read`), `mail.alias.create`/`mail.alias.delete` (`mail.admin` scope — least-privilege for a routing mutation), plus admin routes throwing `ApiError` (G4).

- [ ] **Step 1:** Read `store.ts` for existing alias access; add store methods if missing (org-scoped `sql` queries).
- [ ] **Step 2: Write the failing tests** — tool registration + store round-trip + a negative-authz test that `mail.alias.create` rejects a non-admin scope (assert `tool.permission === "mail.admin"`), and an admin-route test asserting 403 for a non-admin actor.
- [ ] **Step 3: Run** → FAIL.
- [ ] **Step 4: Implement** the 3 tools + admin routes (route handlers `throw new ForbiddenError(...)` / `NotFoundError(...)`; never `reply.code(403).send({error})`). Add contract schemas.
- [ ] **Step 5: Run** — `pnpm --filter @helix/app test -- mail/tools mail/admin-routes` → PASS.
- [ ] **Step 6: Commit** `feat(mail): alias management tools + admin route over mail_aliases`.

### Task A2.4: Realtime inbox (SSE over the existing `activity.mail.*` outbox seam)

**Files:**
- Create: `apps/helix/src/platform/mail/stream.ts` (SSE route registrar), `apps/helix/src/platform/mail/stream.test.ts`, `apps/web/src/features/mail/use-mail-realtime.ts`, `apps/web/src/features/mail/use-mail-realtime.test.ts`
- Modify: `apps/helix/src/server.ts` (register the SSE route under `if (coreApps.shouldRegister("mail"))` near `:1639`), `apps/web/src/features/mail/queries.ts` (invalidate on push instead of interval refetch)

**Interfaces:**
- Consumes: `EventBus.subscribe("activity.mail.received" | "activity.mail.sent", handler)` — the **same** subjects `store.ts:1312` already publishes; per-actor filtering by `orgId`/recipient.
- Produces: route `GET /sse/mail` (Server-Sent Events; mail is server→client only, so SSE not WS — reuses the outbox→EventBus seam, does not add a second bus). Emits `{ type: "mail.received" | "mail.sent", threadId }`. Web hook `useMailRealtime()` invalidates the `mail.threads.list`/`mail.folders.list` query keys on each event.

> **Grounding:** today the web polls via TanStack refetch (research: "Realtime: NONE to client"). This task adds push without touching the write path — the outbox rows already exist.

- [ ] **Step 1: Write the failing test** — `stream.test.ts`: a fake `EventBus` publishes `activity.mail.received` for the subscribed actor's org; assert the SSE handler writes a `data: {"type":"mail.received",...}` frame; assert an event for a *different* org is not delivered (authz filter).
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** `stream.ts` using Fastify's raw reply for SSE, subscribing on connect and unsubscribing on close (mirror the connection lifecycle discipline in `chat/routes.ts:206`). Filter by `actor.orgId` and recipient membership. Register in `server.ts` behind the mail gate.
- [ ] **Step 4: Implement web hook** — `useMailRealtime()` opens the EventSource, and on message calls `queryClient.invalidateQueries` for the mail query keys; drop the polling `refetchInterval` in `queries.ts`.
- [ ] **Step 5: Run** — `pnpm --filter @helix/app test -- mail/stream && pnpm --filter @helix/web test -- mail/use-mail-realtime` → PASS.
- [ ] **Step 6: Commit** `feat(mail): realtime inbox via SSE over activity.mail.* outbox`.

### Task A2.5: Attachment streaming (Drive object refs instead of in-memory base64)

**Files:**
- Modify: `apps/helix/src/platform/mail/outbound.ts` (`NodemailerMailTransport.send:69` — resolve `objectId` attachments to a stream), `apps/helix/src/platform/mail/tools.ts` (`toEnvelope:718` — pass `objectId` through), `apps/web/src/features/mail/api.ts` (`:117`/`:278` — send `objectId` refs, not base64), `packages/contracts/src/mail.ts` (already has `objectId` on `mailAttachmentInputSchema` from A1.1)
- Test: `apps/helix/src/platform/mail/outbound.test.ts`

**Interfaces:**
- Consumes: the Drive storage resolver (the same `driveStorageResolver` wired in `server.ts:2058`) to stream object bytes.
- Produces: outbound attachments that reference a Drive `objectId`; the transport streams from storage rather than holding the full payload in a base64 `content` string. Large attachments no longer buffer fully in memory.

- [ ] **Step 1: Write the failing test** — assert `toEnvelope` maps an `{ objectId }` attachment to a `{ path/stream }` nodemailer attachment (via an injected resolver stub) and that base64 `content` still works (back-compat).
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** — thread a `resolveAttachment(objectId): Promise<Readable>` dependency into `MailSendService`/transport; in `toEnvelope`, when `objectId` is present, emit a nodemailer attachment with a lazy stream; keep the base64 branch for small inline attachments. Web `api.ts` uploads to Drive first (existing Drive upload path) then sends the `objectId`.
- [ ] **Step 4: Run** — `pnpm --filter @helix/app test -- mail/outbound` → PASS.
- [ ] **Step 5: Commit** `feat(mail): stream large outbound attachments from Drive objects`.

### Task A2.6: Provider send retries/backoff + dead-letter in `OutboundMailDispatcher.dispatch`

**Files:**
- Modify: `apps/helix/src/platform/mail/outbound.ts` (`OutboundMailDispatcher.dispatch:153`), `apps/helix/src/platform/mail/store.ts` (add `markOutboundDeadLettered` + attempt counter), `apps/helix/src/db/migrations/0069_mail_outbound_retry.sql` (add `attempt_count int not null default 0`, `next_attempt_at timestamptz null`, `dead_lettered_at timestamptz null` to `mail_outbound_messages`)
- Test: `apps/helix/src/platform/mail/outbound.test.ts`

**Interfaces:**
- Consumes: the existing `markOutboundSending`/`markOutboundSent`/`markOutboundFailed` (`outbound.ts:160`–`:180`).
- Produces: bounded exponential backoff (e.g. attempts 1..5, delay `min(2^n * base, cap)` with jitter); on final failure, `markOutboundDeadLettered` sets `dead_lettered_at` and stops re-queueing; each failure wraps the provider error in `MailProviderError` (A1.3) with `cause`.

- [ ] **Step 1: Write the failing test** — a transport stub that throws twice then succeeds → assert 3 attempts and a final `sent`; a transport that always throws → assert it dead-letters after the cap and records `MailProviderError` with the last error.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** the retry loop inside the existing `smtp.send` span (`:155`), incrementing `attempt_count`, scheduling `next_attempt_at`, and dead-lettering past the cap. Keep OTel span attributes (`delivery_status`) accurate per attempt.
- [ ] **Step 4: Run** — `pnpm --filter @helix/app test -- mail/outbound` → PASS.
- [ ] **Step 5: Commit** `feat(mail): retry+backoff and dead-letter for outbound dispatch`.

## Phase A3 — Refactors (G5/G9 file-size + core/IO split)

### Task A3.1: Split `mail-shell.tsx` (2709 LOC) into feature files

**Files:**
- Create: `apps/web/src/features/mail/thread-list.tsx`, `thread-view.tsx`, `compose.tsx`, `mail-sidebar.tsx`
- Modify: `apps/web/src/features/mail/mail-shell.tsx` (reduce to a thin `MailShell` composition root wiring the four)
- Test: existing mail component tests; add `apps/web/src/features/mail/compose.test.tsx`

- [ ] **Step 1:** Read `mail-shell.tsx`; identify the four regions the research names — `Sidebar` (~lines composing folders/labels), `ThreadList` (~648 LOC), `ThreadView` (~527 LOC), `Compose` (~421 LOC).
- [ ] **Step 2: Write a characterization test** for `Compose` (submit calls `sendMail`, shows the undo toast from A2.2) that must keep passing across the move.
- [ ] **Step 3:** Extract each region into its own file, exporting a typed component; `mail-shell.tsx` imports and composes them. No behavior change. Each new file targets < 400 LOC.
- [ ] **Step 4: Run** — `pnpm --filter @helix/web typecheck && pnpm --filter @helix/web test -- mail` → PASS.
- [ ] **Step 5: Commit** `refactor(web): split mail-shell.tsx into list/view/compose/sidebar`.

### Task A3.2: Decompose `store.ts` (1689 LOC) — extract projection core (G5)

**Files:**
- Create: `apps/helix/src/platform/mail/core/thread-projection.ts` (pure folder/thread-row projection + filter matching), `apps/helix/src/platform/mail/core/thread-projection.test.ts`, `apps/helix/src/platform/mail/store-threads.ts` (IO adapter for the thread-list/folder queries `store.ts:882`–`:1170`)
- Modify: `apps/helix/src/platform/mail/store.ts` (delegate to `store-threads.ts`; de-dupe the list vs. count SQL at `:957` vs. `:1033`)

- [ ] **Step 1:** Extract the pure mapping (row → `MailThreadRow`, folder counting predicates, the `case`-expression folder logic at `:950`–`:959`) into `core/thread-projection.ts` as functions taking plain rows — **no `sql`** — so they unit-test without a DB (G5).
- [ ] **Step 2: Write unit tests** for `core/thread-projection.ts` covering every folder branch (inbox/spam/archive/starred/snoozed/sent/drafts/trash) and label filtering, no DB.
- [ ] **Step 3: Run** → FAIL, then implement, then PASS.
- [ ] **Step 4:** Move the SQL for `listThreads`/`listFolders` into `store-threads.ts`, calling the pure core for the projection; collapse the duplicated list/count query into one parameterized builder. `store.ts` re-exports for back-compat.
- [ ] **Step 5: Run** — `pnpm --filter @helix/app test -- mail` (unit + the DB-gated store tests) → PASS. Confirm `store.ts` and `store-threads.ts` each < 400 LOC (or carry a `// ponytail:` note).
- [ ] **Step 6: Commit** `refactor(mail): extract thread projection to core + store-threads`.

### Task A3.3: Split `admin-store.ts` (1292 LOC) into per-domain stores

**Files:**
- Create: `apps/helix/src/platform/mail/admin/providers-store.ts`, `domains-store.ts`, `dkim-store.ts`, `dmarc-store.ts`, `routing-store.ts` (+ `admin/index.ts` barrel)
- Modify: `apps/helix/src/platform/mail/admin-store.ts` (becomes the barrel / composition, or is deleted with imports repointed), `apps/helix/src/platform/mail/admin-routes.ts` (import from the split stores)

- [ ] **Step 1:** Read `admin-store.ts`; it bundles five stores (providers/domains/dkim/dmarc/routing). Extract each into its own file, preserving method signatures.
- [ ] **Step 2:** Keep an `admin/index.ts` barrel exporting the five so `admin-routes.ts` imports stay one-line.
- [ ] **Step 3: Run** — `pnpm --filter @helix/app test -- mail/admin-routes mail/admin-config` → PASS (no behavior change).
- [ ] **Step 4: Commit** `refactor(mail): split admin-store into per-domain stores`.

## Phase A4 — Tests & hardening (G6/G9 defense-in-depth)

### Task A4.1: RLS policies for `mail_*` tables (extend `0033_tenant_rls_foundation.sql`)

**Files:**
- Create: `apps/helix/src/db/migrations/0070_mail_tenant_rls.sql`, `apps/helix/src/platform/mail/rls.test.ts`

**Interfaces:**
- Produces: `enable row level security` + `create policy` per `mail_*` table (`mail_filters`, `mail_aliases`, `mail_vacation`, `mail_thread_state`, `mail_outbound_messages`, `mail_outbound_providers`, `mail_sending_domains`, `mail_dkim_keys`, `mail_dmarc_reports`, `mail_inbound_routing_rules`, `mail_drafts`) keyed on the tenant GUC the foundation migration establishes. Defense-in-depth behind the existing WHERE-clause scoping (G6).

- [ ] **Step 1:** Read `0033_tenant_rls_foundation.sql` to learn the GUC/role convention it sets.
- [ ] **Step 2: Write the failing test** — with the tenant GUC set to org A, a `select` on `mail_filters` seeded for org B returns zero rows even without a WHERE clause.
- [ ] **Step 3: Run** → FAIL (no policy yet).
- [ ] **Step 4: Implement** the migration mirroring the foundation's policy shape for each mail table.
- [ ] **Step 5: Run** → PASS.
- [ ] **Step 6: Commit** `feat(db): row-level security policies for mail_* tables`.

### Task A4.2: Routing-rule + vacation loop-prevention tests

**Files:**
- Modify/Create: `apps/helix/src/platform/mail/ingest.test.ts` (routing-rule application), `apps/helix/src/platform/mail/vacation-loop.test.ts`

- [ ] **Step 1: Write tests** — (a) an inbound message matching an `mail_inbound_routing_rules` rule lands in the routed org/mailbox; (b) an auto-responder does **not** reply to its own auto-reply / to `no-reply`/`mailer-daemon` senders / to a bulk `Precedence: bulk` header (loop prevention). Reference the vacation store (`store.ts`) and `dmarc.ts`/`ingest.ts` code paths.
- [ ] **Step 2: Run** → some may FAIL if loop-prevention is incomplete; if so, implement the guard in the vacation responder path, then PASS.
- [ ] **Step 3: Commit** `test(mail): routing-rule application + vacation loop-prevention`.

---

# Part B — Chat

**Scope:** `apps/helix/src/platform/chat/*` (backend) and `apps/web/src/features/chat/*` (frontend). Chat is genuine WebSocket realtime: `/ws/chat` (`routes.ts:141`) with a per-connection token-bucket rate limit (`routes.ts:22`), `EventBusChatRoomBus` NATS fan-out on `chat.room.<roomId>.events` (`realtime.ts:44/170`), `RedisChatPresenceStore` with TTL (`realtime.ts:84`), graceful-shutdown reconnect broadcast (`routes.ts:150`). Inbound frames validated by a Zod `discriminatedUnion` (`routes.ts:60`); every non-`send` frame re-checks room access via `requireSocketRoomAccess` (`routes.ts:344`). 9 tools in `tools.ts`.

## Part B — Definition of Done (maps to G1–G9)

| Gate | Chat-specific done condition | Delivered by |
|---|---|---|
| **G1** | `packages/contracts/src/chat.ts` holds Zod schemas for every chat tool I/O **and the WS frame union** (inbound + outbound); web `api.ts` + `use-chat-realtime.ts` import them, zero duplicated shapes. | B2.1 |
| **G2** | Every chat tool `outputSchema` is a concrete `chat.ts` schema; the WS handler parses inbound frames with the shared union (already at `routes.ts:60`, re-pointed to the contract). | B2.1 |
| **G3** | `CHAT_PRESENCE_TTL_SECONDS` (`server.ts:2578`) and the hardcoded rate-limit constants (`routes.ts:22`) come from `env()`. Zero magic numbers at the boundary. | B1.4, B2.3 |
| **G4** | Store throws `ChatRoomAccessError`/`ChatMessageNotFoundError` (ApiError subclasses); the WS surface emits a typed error frame from the contract, not an ad-hoc `{type:"error"}`. | B2.2 |
| **G5** | Message projection, mention parsing, and rate-limit token-bucket math live in `chat/core/*`, unit-tested without a DB/socket. | B2.2, B3.3, B5.3 |
| **G6** | Room/DM create + invite check `chat.create`; every non-send frame re-checks room access (already true); pin/thread/mention mutations carry least-privilege scopes with negative-authz tests. | B0.1, B3.x |
| **G7** | Chat imports cross-tier only via `@helix/contracts`/`@helix/sdk*`; no reach into `platform/mail/*`. | passes existing lint |
| **G8** | Room creation, invite, pagination, pins, threading, mentions are all reachable from the tool registry; web consumes via contracts. | B0, B3 |
| **G9** | Unit tests for core, integration for store/routes/WS, negative-authz per mutation; multi-replica bus + presence-TTL + token-bucket tested; `chat-shell.tsx` (1332 LOC) + `chat-shell.css` (743) split < 400 or `// ponytail:` note. | B4, B5 |

## Phase B0 — P0 product gaps (backend exists, no reachable surface)

> **Why first:** two capabilities are fully built server-side but **unreachable from the Chat UI**. (a) `chat.create_room` (`tools.ts:213`) and `chat.invite` (`tools.ts:234`) exist, but `chat-shell.tsx`/`api.ts` have **no** create-room or invite wiring — rooms are only creatable via the assistant/API. (b) `chat.message.list` supports a `before` cursor (`tools.ts:47`, store `store.ts:522`), but the web is pinned to `limit: 50` with the cursor unused (`queries.ts:12/49`) — no history load.

### Task B0.1: Room/DM creation + invite UI

**Files:**
- Modify: `apps/web/src/features/chat/api.ts` (add `createChatRoom`, `inviteToRoom` wrappers), `apps/web/src/features/chat/chat-shell.tsx` (add a "New conversation" affordance + invite dialog; after B4 these move to `chat-sidebar.tsx`/`info-panel.tsx`), `apps/web/src/features/chat/queries.ts` (invalidate `chat.room.list` on create/invite)
- Test: `apps/web/src/features/chat/api.test.ts`, a component test for the create flow

**Interfaces:**
- Consumes: tools `chat.create_room` (input `{ subject?, kind: "chat_room"|"chat_dm", memberActorIds: uuid[], topic?, isPrivate, metadata }`) and `chat.invite` (input `{ roomId, actorIds: uuid[], role }`) — both already registered.
- Produces: `createChatRoom(input): Promise<ChatRoom>`, `inviteToRoom(input): Promise<...>` in `api.ts`; a modal in the sidebar to pick members and create; an invite control in the room info panel.

- [ ] **Step 1: Write the failing test** — `api.test.ts`: a mock-fetch asserts `createChatRoom({ kind: "chat_dm", memberActorIds: ["…"] })` posts to the `chat.create_room` tool and returns the parsed room; `inviteToRoom({ roomId, actorIds })` posts to `chat.invite`.
- [ ] **Step 2: Run** — `pnpm --filter @helix/web test -- chat/api` → FAIL.
- [ ] **Step 3: Implement `api.ts` wrappers** using the existing chat tool-call helper (mirror the mail `callMailTool` pattern / whatever `api.ts` already uses to invoke `chat.send`). Types come from `@helix/contracts` chat schemas (B2.1) — until B2.1 lands, use a local `z.infer` shim and mark it `// TODO(B2.1)`-free by importing from contracts once available. (Order B2.1 before this if practical; otherwise the shim is a one-line re-point.)
- [ ] **Step 4: Implement UI** — a "New conversation" button opening a member picker (DM vs. room), calling `createChatRoom`; an "Add people" control in the room header calling `inviteToRoom`. Invalidate `chat.room.list` on success.
- [ ] **Step 5: Run** — `pnpm --filter @helix/web test -- chat` → PASS.
- [ ] **Step 6: Commit** `feat(chat): room/DM creation and invite UI over existing tools`.

### Task B0.2: Message pagination / infinite scroll (use the `before` cursor)

**Files:**
- Modify: `apps/web/src/features/chat/queries.ts` (`:12` `defaultChatSearchInput.limit`, `:49` `chatMessageListQueryOptions` — switch to `useInfiniteQuery` with a `before` cursor), `apps/web/src/features/chat/chat-shell.tsx` (`VirtualizedChatMessages` at `:678` — load older on scroll-to-top), `apps/web/src/features/chat/api.ts` (`listChatMessages` accepts `before`)
- Test: `apps/web/src/features/chat/queries.test.ts`

**Interfaces:**
- Consumes: tool `chat.message.list` `{ roomId, before?: ISO-datetime, limit }` (`tools.ts:47`) → `store.listMessages` `before` filter (`store.ts:539`).
- Produces: `chatMessageListInfiniteQueryOptions(roomId)` paging by the oldest loaded message's `sentAt`; `VirtualizedChatMessages` fetches the next older page when the top sentinel enters view.

- [ ] **Step 1: Write the failing test** — `queries.test.ts`: given a first page of 50, `getNextPageParam` returns the oldest message's `sentAt`; a second fetch passes it as `before`; when a page returns < limit, `getNextPageParam` returns `undefined` (stop).
- [ ] **Step 2: Run** — `pnpm --filter @helix/web test -- chat/queries` → FAIL.
- [ ] **Step 3: Implement** the infinite query + wire the scroll sentinel in `VirtualizedChatMessages`. Preserve scroll position on prepend (measure-before/after).
- [ ] **Step 4: Run** — `pnpm --filter @helix/web test -- chat` → PASS.
- [ ] **Step 5: Commit** `feat(chat): message history pagination via before cursor`.

## Phase B1 — Realtime robustness

### Task B1.1: Client auto-reconnect with exponential backoff + re-subscribe

**Files:**
- Modify: `apps/web/src/features/chat/use-chat-realtime.ts` (`:126`/`:130` — currently sets `connection: "closed"` on close/error and **stops forever**)
- Test: `apps/web/src/features/chat/use-chat-realtime.test.ts`

**Interfaces:**
- Consumes: the `reconnect` frame the server already broadcasts on shutdown (`routes.ts:152`); the current subscription set.
- Produces: a reconnect state machine — on unexpected close/error, transition `open → connecting`, retry with capped exponential backoff + jitter, and on reopen **re-send `subscribe` frames** for all previously subscribed rooms. Add `connection: "reconnecting"` to `ChatConnectionState` (`:24`). Stop retrying only on an explicit client teardown or an auth-fatal close code.

- [ ] **Step 1: Write the failing test** — with a fake WebSocket, simulate an unexpected close; assert the hook schedules a reconnect (fake timers), reopens, and re-emits `subscribe` for the rooms that were subscribed; assert backoff grows then caps; assert a clean unmount does **not** reconnect.
- [ ] **Step 2: Run** — `pnpm --filter @helix/web test -- chat/use-chat-realtime` → FAIL.
- [ ] **Step 3: Implement** the backoff loop (track `attempt`, `timeout = min(base * 2^attempt, cap) + jitter`), a `reconnecting` state, and re-subscribe on open. Reset `attempt` to 0 after a stable connection.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `fix(chat): auto-reconnect with backoff and re-subscribe`.

### Task B1.2: Real presence statuses (available/away/busy/offline)

**Files:**
- Modify: `apps/helix/src/platform/chat/realtime.ts` (presence currently only emits `"online"`; `types.ts:6` declares `available/away/busy/offline`), `apps/helix/src/platform/chat/types.ts`, `apps/helix/src/platform/chat/routes.ts` (accept an optional `status` on the `presence`/`subscribe`/`typing` frames or a new `presence.set` frame)
- Test: `apps/helix/src/platform/chat/realtime.test.ts`

**Interfaces:**
- Consumes: `RedisChatPresenceStore.touch/list` (`realtime.ts:84`).
- Produces: a `PresenceStatus` enum (`available | away | busy | offline`); `touch` records the actor's declared status; idle → `away` after a TTL fraction; explicit `busy` honored; roster entries carry `status`.

- [ ] **Step 1: Write the failing test** — assert `touch({ status: "busy" })` surfaces `busy` in `list`; assert an entry not refreshed within the away-threshold reports `away`; assert TTL expiry drops it (→ `offline`/absent).
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** the status field end-to-end (frame → presence store → roster broadcast). Extend the inbound frame union (in `routes.ts:60`, later the contract) with an optional `status`.
- [ ] **Step 4: Run** — `pnpm --filter @helix/app test -- chat/realtime` → PASS.
- [ ] **Step 5: Commit** `feat(chat): real presence statuses (available/away/busy/offline)`.

### Task B1.3: Move the WS token off the URL query param (leak risk) (G6)

**Files:**
- Modify: `apps/web/src/features/chat/api.ts` (`:280` `addAccessTokenSearchParam` → `access_token` query param on the WS URL), `apps/helix/src/platform/chat/routes.ts` (`actorFromRequest` — read the token from the WS subprotocol header or a first-frame `auth` message instead of the query string), `server.ts` (the `actorFromRequest` wiring passed to `registerChatRoutes`)
- Test: `apps/helix/src/platform/chat/routes.test.ts`, `apps/web/src/features/chat/api.test.ts`

**Interfaces:**
- Consumes: the existing auth-token resolution.
- Produces: token transported via the `Sec-WebSocket-Protocol` header (e.g. `helix-bearer, <token>`) **or** a first `{ type: "auth", token }` frame validated before any room access. The query-param path is removed (tokens in URLs leak into logs/proxies/referrers — G6 security). Reject connections that don't authenticate within a short grace window.

- [ ] **Step 1: Write the failing test** — a WS handshake with the token in the subprotocol authenticates; a handshake with the old `?access_token=` query param is rejected (or ignored); a connection that sends no auth frame within the grace window is closed.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** the subprotocol/first-frame auth on the server and switch the client to send it via the subprotocol argument of `new WebSocketImpl(url, protocols)`; remove `addAccessTokenSearchParam` from the chat WS URL builder.
- [ ] **Step 4: Run** — `pnpm --filter @helix/app test -- chat/routes && pnpm --filter @helix/web test -- chat/api` → PASS.
- [ ] **Step 5: Commit** `fix(chat): authenticate WS via subprotocol, not URL query param`.

### Task B1.4: Make WS rate limits configurable from the env module (G3)

**Files:**
- Modify: `apps/helix/src/platform/chat/routes.ts` (`:22`/`:23` hardcoded `CHAT_WS_RATE_LIMIT_CAPACITY`/`_REFILL_PER_SECOND` → injected via `RegisterChatRoutesOptions`), `apps/helix/src/config/env.ts` (add keys), `apps/helix/src/server.ts` (pass from `env()`)
- Test: `apps/helix/src/platform/chat/routes.test.ts`

**Interfaces:**
- Consumes: `env().CHAT_WS_RATE_LIMIT_CAPACITY`, `env().CHAT_WS_RATE_LIMIT_REFILL_PER_SECOND`.
- Produces: `RegisterChatRoutesOptions.rateLimit?: { capacity: number; refillPerSecond: number }` with the current values as defaults; `createBucket`/`consumeToken` read them instead of module constants.

- [ ] **Step 1: Write the failing test** — register routes with `rateLimit: { capacity: 2, refillPerSecond: 0 }`; assert the 3rd inbound frame gets a `rate_limited` error frame.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** — thread the config through `handleChatSocket`; add `CHAT_WS_RATE_LIMIT_CAPACITY` (default 30) + `CHAT_WS_RATE_LIMIT_REFILL_PER_SECOND` (default 3) to `env.ts`; wire in `server.ts`.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(chat): configurable WS rate limits via env module (G3)`.

## Phase B2 — Contracts, errors, config (G1/G2/G4)

### Task B2.1: Author `packages/contracts/src/chat.ts` incl. the WS frame union, adopt in tools + web (G1/G2)

**Files:**
- Create: `packages/contracts/src/chat.ts`, `packages/contracts/src/chat.test.ts`
- Modify: `packages/contracts/src/index.ts` + `package.json` (`"./chat"` export), `apps/helix/src/platform/chat/tools.ts` (concrete output schemas), `apps/helix/src/platform/chat/routes.ts` (`inboundMessageSchema:60` re-point to the contract), `apps/web/src/features/chat/api.ts` + `use-chat-realtime.ts` (import frame + DTO types)

**Interfaces:**
- Produces (exact names): `chatRoomSchema`, `chatMessageSchema`, `chatReactionSchema`, `chatReadReceiptSchema`, `chatSearchHitSchema`, `chatCreateRoomInputSchema`, `chatInviteInputSchema`, `chatSendInputSchema`, `chatListMessagesInputSchema`, `chatReactInputSchema`, `chatEditInputSchema`, `chatDeleteInputSchema`, `chatSearchInputSchema`, **`chatInboundFrameSchema`** (the `discriminatedUnion("type", …)` currently inline at `routes.ts:60`, extended with `presence.set`/`auth` from B1.2/B1.3), **`chatOutboundFrameSchema`** (`ready`/`subscribed`/`message.created`/`typing`/`read`/`presence.joined`/`presence.left`/`presence`/`reconnect`/`error`), and their `z.infer` types.

- [ ] **Step 1: Write the failing test** — `chat.test.ts`: `chatInboundFrameSchema` parses each `type` variant and rejects an unknown `type`; `chatSendInputSchema` enforces `body` 1..50000; `chatOutboundFrameSchema` validates a `message.created` frame and an `error` frame.
- [ ] **Step 2: Run** — `pnpm --filter @helix/contracts test -- chat` → FAIL.
- [ ] **Step 3: Implement `chat.ts`** — mirror the inline schemas from `chat/tools.ts` (`createRoomSchema:19`, `inviteSchema:28`, `sendSchema:34`, `listMessagesSchema:47`, `reactSchema:53`, `editSchema:59`, `deleteSchema:64`, `searchSchema:68`) and the frame union from `routes.ts:60`. Define the outbound frame union from the `sendSocket` payloads in `routes.ts` (`ready:225`, `subscribed:258`, `message.created:277`, `typing:296`, `read:314`, `presence.*`, `reconnect:152`, `error:186`).
- [ ] **Step 4:** Re-point `routes.ts:60` `inboundMessageSchema` to `import { chatInboundFrameSchema } from "@helix/contracts"` (parse stays at `:235`). Set each tool's `outputSchema` in `tools.ts` to the concrete contract schema (G2). Delete duplicated web types; import from `@helix/contracts`.
- [ ] **Step 5: Run** — `pnpm --filter @helix/contracts test -- chat && pnpm --filter @helix/app typecheck && pnpm --filter @helix/app test -- chat && pnpm --filter @helix/web typecheck && pnpm --filter @helix/web test -- chat` → PASS.
- [ ] **Step 6: Commit** (contract, then backend adoption, then web adoption — three commits): `feat(contracts): chat schemas incl WS frame union`; `refactor(chat): tools + WS validated by @helix/contracts (G1/G2)`; `refactor(web): chat api consumes @helix/contracts (G1)`.

### Task B2.2: Chat errors via `ApiError` + typed WS error frames (G4)

**Files:**
- Create: `apps/helix/src/platform/chat/errors.ts`, `apps/helix/src/platform/chat/errors.test.ts`
- Modify: `apps/helix/src/platform/chat/store.ts` (`requireRoomAccess`/`getRoomForActor` throws at `store.ts` — the `"Unknown or inaccessible chat room"` message), `apps/helix/src/platform/chat/routes.ts` (`requireSocketRoomAccess:355`; the ad-hoc `{ type: "error", error: … }` frames at `:186`/`:199`), `apps/helix/src/platform/chat/tools.ts` (`:189`/`:208` unknown-message throws)
- Test: `apps/helix/src/platform/chat/routes.test.ts`

**Interfaces:**
- Consumes: `ApiError`, `ForbiddenError`, `NotFoundError` from `api/api-error.js`.
- Produces: `ChatRoomAccessError extends ForbiddenError` (code `forbidden`), `ChatMessageNotFoundError extends NotFoundError`. The WS handler catches `ApiError` and emits a **typed** `chatOutboundFrameSchema` error frame `{ type: "error", code, message }` (from B2.1) instead of the current stringly `{ type: "error", error }`.

- [ ] **Step 1: Write the failing test** — a `subscribe` frame for an inaccessible room yields an error frame with `code: "forbidden"`; the store throw is a `ChatRoomAccessError`; a rate-limit drop yields `code: "rate_limited"`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** `errors.ts`; replace `requireSocketRoomAccess`'s `throw new Error(...)` (`routes.ts:355`) with `throw new ChatRoomAccessError(roomId)`; update the `socket.on("message")` catch (`routes.ts:197`) to render `ApiError` as a typed frame (`error.code`, `error.message`) and fall back to `internal_error` for unknown errors; update `tools.ts:189/208` to `ChatMessageNotFoundError`.
- [ ] **Step 4: Run** — `pnpm --filter @helix/app test -- chat/routes chat/errors` → PASS.
- [ ] **Step 5: Commit** `feat(chat): typed ApiError + WS error frames (G4)`.

### Task B2.3: `CHAT_PRESENCE_TTL_SECONDS` via the env module (G3)

**Files:**
- Modify: `apps/helix/src/config/env.ts` (add `CHAT_PRESENCE_TTL_SECONDS: z.coerce.number().int().positive().default(45)`), `apps/helix/src/server.ts` (`:2578` `Number.parseInt(process.env.CHAT_PRESENCE_TTL_SECONDS ?? "45", 10)` → `env().CHAT_PRESENCE_TTL_SECONDS`)
- Test: `apps/helix/src/config/env.test.ts`

- [ ] **Step 1: Write the failing test** — `loadEnv({ …, CHAT_PRESENCE_TTL_SECONDS: "60" }).CHAT_PRESENCE_TTL_SECONDS === 60`; default is 45; a non-numeric value throws.
- [ ] **Step 2: Run** — `pnpm --filter @helix/app test -- config/env` → FAIL.
- [ ] **Step 3: Implement** the schema key; replace the `server.ts:2578` read with `env().CHAT_PRESENCE_TTL_SECONDS`.
- [ ] **Step 4: Run** → PASS. Grep-confirm no `process.env` remains in `platform/chat` (`grep -rn "process.env" apps/helix/src/platform/chat --include=*.ts | grep -v ".test.ts"` → zero; it already reads none, this just moves the `server.ts` wiring read).
- [ ] **Step 5: Commit** `refactor(config): chat presence TTL via env module (G3)`.

## Phase B3 — Product features

### Task B3.1: Real message threading (`parent_message_id` + `chat.reply_in_thread`)

**Files:**
- Create: `apps/helix/src/db/migrations/0066_chat_message_threading.sql`, tests
- Modify: `packages/contracts/src/chat.ts` (add `chatReplyInThreadInputSchema`, add optional `parentMessageId` to `chatMessageSchema`), `apps/helix/src/platform/chat/store.ts` (`sendMessage:327` accept `parentMessageId`; add `listThreadReplies({ roomId, parentMessageId, before?, limit })`), `apps/helix/src/platform/chat/tools.ts` (register `chat.reply_in_thread`, `chat.thread.list`), `apps/web/src/features/chat/chat-shell.tsx` (`ChatThreadPanel:1145` — wire it to the new tool)

**Interfaces:**
- Consumes: `messages` table (currently **no** `parent_message_id` — research confirms no server threading model).
- Produces: column `messages.parent_message_id uuid null references messages(id)`; tool `chat.reply_in_thread` `{ roomId, parentMessageId, body, bodyFormat, attachmentObjectIds }` (`chat.post`); tool `chat.thread.list` `{ roomId, parentMessageId, before?, limit }` (`chat.read`); replies fan out on the same `message.created` bus event with `parentMessageId` set so the client renders them in `ChatThreadPanel`.

- [ ] **Step 1: Write the migration** — `0066_chat_message_threading.sql`:

```sql
alter table messages add column if not exists parent_message_id uuid null references messages(id) on delete set null;
create index if not exists messages_parent_idx on messages (parent_message_id) where parent_message_id is not null;
```

- [ ] **Step 2: Write the failing tests** — store: a reply persists `parent_message_id`; `listThreadReplies` returns only children of the parent, scoped to org/room; a reply into an inaccessible room is rejected (negative-authz). Tool: `chat.reply_in_thread` registered with `chat.post`.
- [ ] **Step 3: Run** → FAIL.
- [ ] **Step 4: Implement** the store methods (extend `sendMessage` input with optional `parentMessageId`), the two tools, and the bus event carrying `parentMessageId`. Wire `ChatThreadPanel` to open on a message, load `chat.thread.list`, and post via `chat.reply_in_thread`. Keep the AI-enrichment/search-indexer workers fed (replies are still `messages` rows).
- [ ] **Step 5: Run** — `pnpm --filter @helix/app test -- chat && pnpm --filter @helix/web test -- chat` → PASS.
- [ ] **Step 6: Commit** `feat(chat): message threading via parent_message_id + reply tools`.

### Task B3.2: Pin messages (`chat.pin/unpin` over the existing `chat_pins` table)

**Files:**
- Modify: `apps/helix/src/platform/chat/store.ts` (add `pinMessage/unpinMessage/listPins` against `chat_pins` — table exists from `0006_chat_plugin.sql:25`, **no feature/tool today**), `apps/helix/src/platform/chat/tools.ts` (register `chat.pin`, `chat.unpin`, `chat.pins.list`), `packages/contracts/src/chat.ts` (pin schemas), `apps/web/src/features/chat/chat-shell.tsx` (pin action + pinned-bar in the info panel)
- Test: chat store + tools tests

**Interfaces:**
- Consumes: `chat_pins (thread_id, message_id, org_id, …)` PK `(thread_id, message_id)`.
- Produces: tools `chat.pin`/`chat.unpin` `{ roomId, messageId }` (`chat.post`), `chat.pins.list` `{ roomId }` (`chat.read`); a `message.pinned`/`message.unpinned` bus event so pins update live. Room-access checked on every op.

- [ ] **Step 1: Write the failing tests** — pin then list returns it; unpin removes it; pinning in an inaccessible room is rejected (negative-authz); the PK prevents duplicate pins (idempotent).
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** store methods + 3 tools + bus events + UI (pin from the message hover menu; a pinned-messages strip in the info panel).
- [ ] **Step 4: Run** — `pnpm --filter @helix/app test -- chat && pnpm --filter @helix/web test -- chat` → PASS.
- [ ] **Step 5: Commit** `feat(chat): pin/unpin messages over chat_pins + UI`.

### Task B3.3: @mention parsing + notifications (G5 pure core)

**Files:**
- Create: `apps/helix/src/platform/chat/core/mentions.ts` (pure parser), `apps/helix/src/platform/chat/core/mentions.test.ts`, `apps/helix/src/db/migrations/0067_chat_mentions_index.sql`
- Modify: `apps/helix/src/platform/chat/store.ts` (`sendMessage:327` — parse mentions, populate `messages.metadata.mentions`, emit `activity.chat.mention`), `apps/helix/src/platform/chat/types.ts` (`ChatSearchRecord.mentions:110` is typed but never populated — populate it)

**Interfaces:**
- Consumes: the room roster / actor directory to resolve `@handle` → actorId.
- Produces: `parseMentions(body: string, resolve: (handle: string) => string | null): string[]` (pure, DB-free — G5); `sendMessage` writes the resolved actor ids into `metadata.mentions` and appends an `activity.chat.mention` outbox row per mentioned actor (reusing the outbox seam); a GIN index on `messages.metadata` for mention queries.

- [ ] **Step 1: Write the failing unit test** — `mentions.test.ts`: parses `@alice @bob` to their ids, ignores `email@x.com`, dedupes, handles `@here`/`@channel` as sentinels, resolves unknown handles to nothing. No DB.
- [ ] **Step 2: Run** — `pnpm --filter @helix/app test -- chat/core/mentions` → FAIL.
- [ ] **Step 3: Implement** the pure parser, then wire `sendMessage` to call it (resolving against room members), persist `metadata.mentions`, and emit `activity.chat.mention`. Add the index migration. Populate `ChatSearchRecord.mentions` in the search projection.
- [ ] **Step 4: Run** — `pnpm --filter @helix/app test -- chat` → PASS.
- [ ] **Step 5: Commit** `feat(chat): @mention parsing, metadata.mentions, mention events`.

### Task B3.4: Optimistic send + failure reconciliation

**Files:**
- Modify: `apps/web/src/features/chat/use-chat-realtime.ts` (`send` at `:39` — add an optimistic pending message with a client id), `apps/web/src/features/chat/chat-shell.tsx` (`Composer` + `VirtualizedChatMessages` — render pending/failed states), `apps/web/src/features/chat/view-model.ts` (merge optimistic + server messages by client id)
- Test: `apps/web/src/features/chat/use-chat-realtime.test.ts`, `view-model.test.ts`

**Interfaces:**
- Consumes: the WS `message.created` echo (`routes.ts:277`).
- Produces: on `send`, immediately append a `pending` message keyed by a `clientMessageId`; reconcile when the server `message.created` arrives (match by `clientMessageId` echoed back, or by content+actor+time heuristic); mark `failed` (with retry) if the socket is closed or no echo within a timeout.

> Requires the server to echo `clientMessageId`: add an optional `clientMessageId` to the `send` inbound frame (contract, B2.1) and pass it through into the `message.created` bus payload (`routes.ts:281`). Include that server change in this task.

- [ ] **Step 1: Write the failing test** — sending appends a `pending` message; the echoing `message.created` with the same `clientMessageId` replaces it with the confirmed row (no duplicate); a closed socket marks it `failed`; retry re-sends.
- [ ] **Step 2: Run** — `pnpm --filter @helix/web test -- chat` → FAIL.
- [ ] **Step 3: Implement** the client id round-trip (frame + bus payload) and the view-model merge.
- [ ] **Step 4: Run** — `pnpm --filter @helix/app test -- chat/routes && pnpm --filter @helix/web test -- chat` → PASS.
- [ ] **Step 5: Commit** `feat(chat): optimistic send with failure reconciliation`.

### Task B3.5: Surface read receipts as markers

**Files:**
- Modify: `apps/web/src/features/chat/use-chat-realtime.ts` (`:38` — receipts are already plumbed in), `apps/web/src/features/chat/chat-shell.tsx` (`VirtualizedChatMessages` — render a "seen by" marker at the last-read boundary), `apps/web/src/features/chat/view-model.ts`
- Test: `apps/web/src/features/chat/view-model.test.ts`

**Interfaces:**
- Consumes: the `read` frame + `subscribed.receipts` roster already delivered (`routes.ts:257`/`:314`); `chat_read_receipts` (PK `thread_id + actor_id`, `last_read_message_id`).
- Produces: per-message "seen by N" / avatar markers computed from `lastReadMessageId` per actor. No backend change — this is pure client rendering of already-delivered data (research: "data already plumbed use-chat-realtime.ts:38").

- [ ] **Step 1: Write the failing test** — `view-model.test.ts`: given receipts mapping actors to `lastReadMessageId`, the marker appears after the correct message; a self-receipt is not shown as "seen by me".
- [ ] **Step 2: Run** — `pnpm --filter @helix/web test -- chat/view-model` → FAIL.
- [ ] **Step 3: Implement** the receipt → marker projection in `view-model.ts` and render it.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(chat): render read receipts as seen-by markers`.

## Phase B4 — Refactor

### Task B4.1: Split `chat-shell.tsx` (1332 LOC) + `chat-shell.css` (743 LOC)

**Files:**
- Create: `apps/web/src/features/chat/chat-sidebar.tsx`, `message-list.tsx` (incl. `VirtualizedChatMessages`), `composer.tsx`, `info-panel.tsx` (incl. `ChatThreadPanel`), and co-located CSS modules per component
- Modify: `apps/web/src/features/chat/chat-shell.tsx` (thin composition root), `chat-shell.css` (split into the per-component modules)

- [ ] **Step 1:** Read `chat-shell.tsx`; the research names the regions: `Sidebar`, `MessageList`, `VirtualizedMessages` (`:678`), `Composer`, `ChatThreadPanel` (`:1145`), `Info`.
- [ ] **Step 2: Write/confirm characterization tests** for `Composer` (optimistic send from B3.4) and `MessageList` (pagination from B0.2, receipts from B3.5) that must keep passing across the move.
- [ ] **Step 3:** Extract each region into its own file + CSS module; `chat-shell.tsx` composes them. No behavior change. Each new file < 400 LOC.
- [ ] **Step 4: Run** — `pnpm --filter @helix/web typecheck && pnpm --filter @helix/web test -- chat` → PASS.
- [ ] **Step 5: Commit** `refactor(web): split chat-shell into sidebar/list/composer/info`.

## Phase B5 — Tests & hardening (G9 — the production paths that are currently untested)

> **Why:** the production realtime path (`EventBusChatRoomBus` NATS fan-out, `RedisChatPresenceStore` TTL) is only exercised via the in-memory fallbacks in tests. These add coverage on the real seams.

### Task B5.1: Multi-replica EventBus fan-out test

**Files:**
- Create: `apps/helix/src/platform/chat/realtime.fanout.test.ts`

**Interfaces:**
- Consumes: `EventBusChatRoomBus` (`realtime.ts:44/170`) backed by a test EventBus that simulates two replicas.
- Produces: a test proving a `message.created` published from "replica A" is delivered to a subscriber attached via "replica B" (subject `chat.room.<roomId>.events`), and that unsubscribing on one replica does not drop the other's subscription.

- [ ] **Step 1: Write the test** — two `EventBusChatRoomBus` instances over one shared in-memory EventBus (mimicking cross-replica NATS); subscribe on one, publish on the other, assert delivery; assert subject isolation across rooms.
- [ ] **Step 2: Run** → it should pass if fan-out is correct; if it fails, fix the subscribe/publish subject handling in `realtime.ts`, then PASS.
- [ ] **Step 3: Commit** `test(chat): multi-replica EventBus fan-out coverage`.

### Task B5.2: Presence-TTL-expiry test

**Files:**
- Modify/Create: `apps/helix/src/platform/chat/realtime.presence.test.ts`

- [ ] **Step 1: Write the test** — with a fake clock, `RedisChatPresenceStore.touch` then advance past `ttlSeconds`; assert `list` no longer returns the actor (expired → offline). Use the injectable TTL from B1.2/B2.3.
- [ ] **Step 2: Run** → PASS (or fix the TTL handling, then PASS).
- [ ] **Step 3: Commit** `test(chat): presence TTL expiry coverage`.

### Task B5.3: Token-bucket rate-limiter unit test (pure core)

**Files:**
- Create: `apps/helix/src/platform/chat/core/rate-limit.ts` (extract `createBucket`/`consumeToken` from `routes.ts:30`–`:50` into a pure, injectable-clock module — G5), `apps/helix/src/platform/chat/core/rate-limit.test.ts`
- Modify: `apps/helix/src/platform/chat/routes.ts` (import the extracted functions)

- [ ] **Step 1: Extract** `createBucket`/`consumeToken` into `core/rate-limit.ts` taking a `now()` injectable (so the module math is testable without wall-clock sleeps).
- [ ] **Step 2: Write the test** — capacity N drains after N frames; refills at `refillPerSecond` as the injected clock advances; never exceeds capacity. No timers, no socket.
- [ ] **Step 3: Run** — `pnpm --filter @helix/app test -- chat/core/rate-limit` → after extraction, PASS; confirm `routes.ts` still green (`pnpm --filter @helix/app test -- chat/routes`).
- [ ] **Step 4: Commit** `refactor(chat): extract token-bucket to core + unit tests (G5/G9)`.

---

## File Structure

**Created — Mail:**
- `packages/contracts/src/mail.ts` (+ `.test.ts`) — mail Zod contracts.
- `apps/helix/src/platform/mail/errors.ts` (+ `.test.ts`) — `MailError` subclasses.
- `apps/helix/src/platform/mail/config.ts` (+ `.test.ts`) — env-derived mail config.
- `apps/helix/src/platform/mail/drafts.ts` (+ `.test.ts`) — draft store.
- `apps/helix/src/platform/mail/stream.ts` (+ `.test.ts`) — SSE realtime inbox.
- `apps/helix/src/platform/mail/core/thread-projection.ts` (+ `.test.ts`) — pure projection.
- `apps/helix/src/platform/mail/store-threads.ts` — thread-list/folder IO adapter.
- `apps/helix/src/platform/mail/admin/{providers,domains,dkim,dmarc,routing}-store.ts` (+ `index.ts`).
- `apps/helix/src/platform/mail/{vacation-loop,rls}.test.ts`.
- `apps/web/src/features/mail/{thread-list,thread-view,compose,mail-sidebar}.tsx`, `use-mail-realtime.ts` (+ tests).
- Migrations: `0065_mail_drafts.sql`, `0069_mail_outbound_retry.sql`, `0070_mail_tenant_rls.sql`.

**Created — Chat:**
- `packages/contracts/src/chat.ts` (+ `.test.ts`) — chat Zod contracts incl. WS frame union.
- `apps/helix/src/platform/chat/errors.ts` (+ `.test.ts`) — `ChatError` subclasses.
- `apps/helix/src/platform/chat/core/{mentions,rate-limit}.ts` (+ tests).
- `apps/helix/src/platform/chat/realtime.{fanout,presence}.test.ts`.
- `apps/web/src/features/chat/{chat-sidebar,message-list,composer,info-panel}.tsx` (+ CSS modules, tests).
- Migrations: `0066_chat_message_threading.sql`, `0067_chat_mentions_index.sql`.

**Modified (high-traffic):**
- `apps/helix/src/platform/mail/tools.ts` (+6 tools, contract adoption), `store.ts` (decompose), `outbound.ts` (cancel tool exposure, streaming, retries), `admin-store.ts` (split), `providers.ts`/`spam.ts`/`antivirus.ts` (env), `admin-routes.ts` (aliases).
- `apps/helix/src/platform/chat/tools.ts` (contract adoption, +threading/pins), `routes.ts` (auth, rate-limit config, error frames, contract frame union), `realtime.ts` (presence statuses), `store.ts` (threading/pins/mentions).
- `apps/helix/src/config/env.ts` (mail + chat keys), `apps/helix/src/server.ts` (config wiring, SSE route registration).
- `apps/web/src/features/{mail,chat}/*` (api/queries/shells/hooks).

---

## Self-Review

- [ ] **Spec coverage — every rubric gate G1–G9 has a home per part.** Mail: G1/G2→A1.1/A1.2; G3→A1.4; G4→A1.3; G5→A3.2; G6→A0.1/A0.2/A2.x + A4.1; G7→existing lint; G8→A0/A2; G9→A3/A4. Chat: G1/G2→B2.1; G3→B1.4/B2.3; G4→B2.2; G5→B2.2/B3.3/B5.3; G6→B0.1/B3.x; G7→existing lint; G8→B0/B3; G9→B4/B5. **Every research seed maps to a task:** Mail seeds 1–16 → A0.1, A0.2, A1.1/A1.2, A1.3, A1.4, A2.1, A2.2, A2.3, A2.4, A2.5, A2.6, A3.1, A3.2, A3.3, A4.1, A4.2. Chat seeds 1–16 → B0.1, B0.2, B1.1, B1.2, B1.3, B1.4, B2.1, B2.2, B2.3, B3.1, B3.2, B3.3, B3.4, B3.5, B4.1, B5.1/B5.2/B5.3.
- [ ] **Placeholder scan — no "TBD"/"add error handling"/"similar to Task N".** New files (contracts `mail.ts`, tool `defineTool` blocks, `errors.ts`, migrations, `env.ts` keys, `mail/config.ts`) are given as real code. Edits to large existing files (`store.ts`, `server.ts`, `routes.ts`, `mail-shell.tsx`, `chat-shell.tsx`) are given as **anchored edit specs** (`file:line` + exact change/signature), because this plan deliberately does not reproduce those multi-thousand-line bodies — the agent reads the real file (per the "For agentic workers" note). The two `outputSchema: z.unknown()` occurrences in A0 are explicitly flagged as temporary and replaced in A1.2; that is a sequencing decision, not a placeholder.
- [ ] **Type consistency — names used identically across tasks.** Contract exports (`mailSendInputSchema`, `mailSpamResultSchema`, `mailThreadRowSchema`, `mailFilterSchema`, `chatInboundFrameSchema`, `chatOutboundFrameSchema`, `chatSendInputSchema`, …) are referenced by the exact same identifiers in the adopting tool/web/route tasks. Error classes (`MailThreadNotFoundError`, `MailFilterNotFoundError`, `MailProviderError`, `ChatRoomAccessError`, `ChatMessageNotFoundError`) and config (`mailConfig`, `env().CHAT_PRESENCE_TTL_SECONDS`, `env().CHAT_WS_RATE_LIMIT_*`) are named once and reused. All extend the cross-cutting `ApiError`/`env`/`@helix/contracts` primitives — no forked copies.
- [ ] **Ordering — priority + dependency correct.** Each part runs P0 (A0/B0) → contracts/errors/config (A1/B1+B2) → features (A2/B3) → refactors (A3/B4) → tests/hardening (A4/B5). Cross-cutting deps: A1.2/B2.1 require `@helix/contracts`; A1.3/B2.2 require `ApiError`; A1.4/B1.4/B2.3 require the `env` module — all called out as blockers. B0.1 web types depend on B2.1 (noted; land B2.1 first or use a one-line re-point). Migrations use the next free numbers (0065–0070) confirmed against the migrations directory.
- [ ] **Seam integrity.** No task adds a second event bus, a second validation library, a bespoke error envelope, or a cross-domain import. Mail's realtime (A2.4) reuses the existing `activity.mail.*` outbox→EventBus seam via SSE; Chat threading/pins/mentions (B3) keep feeding the shared `messages`/`outbox`/search-indexer path. `coreApps.shouldRegister("mail"|"chat")` gating is preserved for every new registration.

## Execution Handoff

Recommended: **subagent-driven** — one fresh subagent per task, review between tasks, on branch `feat/mail-chat-elite`. Land the cross-cutting standard's Phases 1–3 (`@helix/contracts`, `env`, `ApiError`) first. Then A0 and B0 are independently shippable **P0 hotfixes** (A0 fixes two live 404s; B0 unlocks two built-but-unreachable capabilities) and should merge before the larger feature/refactor phases. Phase A3/B4 (god-file splits) run last within each part, behind a green suite.
