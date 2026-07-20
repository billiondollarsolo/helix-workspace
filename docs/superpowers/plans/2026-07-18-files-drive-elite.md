# Drive Component — Elite Standard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Read a target file before editing it — this plan gives exact anchors and the transformation, not a verbatim copy of the existing 2,793-line `store.ts` / 888-line `tools.ts` / 2,390-line `drive-shell.tsx` bodies.

**Goal:** Bring the Drive component (`apps/helix/src/platform/drive/**` + `apps/web/src/features/drive/**`) to the **Elite Component Standard** — the nine gates G1–G9 defined in `docs/superpowers/plans/2026-07-18-cross-cutting-elite-standard.md`. Close the privilege-escalation and schema-drift defects first, then port the component onto validated contracts, typed errors, fail-fast config, and a core/IO split, and finally land the missing storage features (resumable upload, dedup, public links, AV) behind tests.

**Architecture:** Drive's primary surface is the generic tool registry (`/api/tools/<toolId>`, ~23 `drive.*` tools in `tools.ts`), consumed by the web `callDriveTool` shim (`api.ts:520`) and gated by `coreApps.shouldRegister("drive")`. Storage is S3-compatible (RustFS) via `createS3CompatibleStorage` (`apps/helix/src/platform/storage/s3-compatible.ts:56`). Upload is two-phase: `prepareUpload` (`store.ts:380`) reserves an `objects` row + presigned PUT; the browser PUTs direct; `finalizeUpload` (`store.ts:441`) writes `drive_versions` + quota + preview + metering, with a base64-inline fallback (`api.ts:234`). Download streams through `GET /api/drive/objects/:id/content` (`server.ts:2643`) → `readFile` → `sendBytesWithRangeSupport` (`range-response.ts`). This plan does **not** rewrite the working surface; it hardens it and splits the god-modules.

**Tech Stack:** pnpm@9 workspaces + Turborepo · Node ≥22 · TypeScript 5.7 (strict) · ESM · Zod · Fastify · postgres.js · Drizzle (raw-SQL migrations under `apps/helix/src/db/migrations/NNNN_*.sql`, applied by `pnpm --filter @helix/app db:migrate` = `tsx src/db/migrate.ts`) · Vitest 2.1.8 · ESLint 9 flat config with custom `helix/*` rules.

## Global Constraints

_Every task's requirements implicitly include this section._

- **Runtime:** Node ≥ 22, ESM only. No CommonJS.
- **TypeScript:** extends `@helix/config/tsconfig/*`. `strict`, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`, `isolatedModules`, `noEmitOnError` ON. `@typescript-eslint/no-explicit-any` is **error** — no `any`, ever. Use inline `import type`.
- **Tenancy:** every org-scoped query is org-scoped (`where org_id = ${orgId}`); Drive already threads `orgId` through every store method — keep it. No cross-tenant reads.
- **Validation library:** Zod only. No `yup`/`joi`/`valibot`.
- **Tests:** Vitest, co-located `*.test.ts`. Preset `@helix/config/vitest`. Unit tests must not require live Postgres/Redis (Drive's `store.test.ts` uses an in-memory fake `sql`); integration tests (`e2e-drive-flow.test.ts`) may.
- **Commits:** Conventional Commits, one logical change per commit, standard `Co-Authored-By` trailer.
- **File size:** target ≤ 400 LOC per new/refactored file. Crossing 400 LOC is a signal to split by responsibility. Every file this plan leaves over the ceiling gets an explicit `// ponytail:` note naming the ceiling.
- **Branch:** all work on `feat/drive-elite` off `main`. Never commit to `main`.

## Dependencies on the Cross-Cutting Plan

This plan **consumes** three artifacts produced by `2026-07-18-cross-cutting-elite-standard.md`. Its **Phases 1–3 must be merged before this plan's Phase 1 begins**:

| Artifact | Produced by | This plan adds/consumes |
|---|---|---|
| `@helix/contracts` package (`packages/contracts/src/{index,errors,http}.ts`, `parseInput`, `errorEnvelopeSchema`) | Cross-cutting Phase 1 | Adds `packages/contracts/src/drive.ts`; consumes `parseInput`, `driveRoleSchema` re-export target |
| `apps/helix/src/config/env.ts` (`env()`, `loadEnv`) | Cross-cutting Phase 2 | Adds `apps/helix/src/platform/drive/config.ts` reading from `env()` |
| `apps/helix/src/api/api-error.ts` (`ApiError`, `NotFoundError`, `ForbiddenError`, `ConflictError`, `BadRequestError`, `RateLimitedError`) | Cross-cutting Phase 3 | Adds `apps/helix/src/platform/drive/errors.ts` whose classes extend these |

**Phase 0 of THIS plan is the exception:** it is P0 security/correctness and cannot wait. Phase 0 therefore introduces a **local** `drive/errors.ts` and `drive/core/roles.ts` that do **not** yet import from `@helix/contracts`; Phase 1 Task 1.1 refactors them to source their enums from contracts (an explicit, tested step). This keeps the security fixes shippable ahead of the cross-cutting merge while still converging on the single source of truth.

---

## Acceptance Criteria — the Elite Component Standard

This plan does **not** redefine the rubric. Acceptance is the nine gates **G1–G9** in `docs/superpowers/plans/2026-07-18-cross-cutting-elite-standard.md` (§ "The Elite Component Standard"). The Drive-specific Definition of Done below maps each phase's work to those gates.

### Definition of Done (Drive → G1–G9)

- [ ] **G1 — Typed contract.** Every Drive tool I/O, REST body, and web DTO is a Zod schema in `packages/contracts/src/drive.ts`; `platform/drive/types.ts` and `apps/web/.../drive/api.ts` are `z.infer` of those schemas with **zero** hand-duplicated interfaces. → Phase 1 (T1.1, T1.3).
- [ ] **G2 — Runtime validation at the edge.** No `outputSchema: z.unknown()` remains in `tools.ts`; every tool validates its store result against a concrete schema before return; inputs `.parse()` at the handler. → Phase 1 (T1.2).
- [ ] **G3 — Validated config.** Drive reads no raw `process.env`; `inline-body.ts` and all `server.ts` Drive wiring (`RUSTFS_*`, office-preview URL/timeout, body-limit, auto-tag) come from `drive/config.ts` over the typed `env()` module. → Phase 2 (T2.2).
- [ ] **G4 — Typed errors.** Drive throws `DriveNotFoundError` / `DriveForbiddenError` / `DriveQuotaExceededError` / `DriveInvalidStorageKeyError` / `DriveConflictError` (extending `ApiError` subclasses); no bare `throw new Error(...)` for client-visible failures, no `reply.code(4xx).send({ error: "..." })` in `routes.ts`/`range-response.ts`/`server.ts` Drive endpoints. → Phase 0 (T0.2 subset) + Phase 2 (T2.1).
- [ ] **G5 — Core/IO split.** Row-mappers, storage-key + validation, quota math, mention parsing, and role predicates live in `drive/core/*` with injected deps, unit-tested without a DB; `PostgresDriveStore` is a thin IO adapter; `drive-shell.tsx` is decomposed into `drive/components/*`. No Drive source file over ~400 LOC without a `// ponytail:` note. → Phase 3 (T3.1–T3.4).
- [ ] **G6 — Authorization is explicit and least-privilege.** Every mutating op checks a role appropriate to the mutation via `requireObjectRole(...,minRole)` — not mere read access; content/preview endpoints enforce `drive.read` scope; `permissions.role` is a closed enum, normalized on write. → Phase 0 (T0.2 role enum, T0.3 mutation gating, T0.4 scope).
- [ ] **G7 — Boundaries.** Drive imports cross-tier only through `@helix/contracts`; `tools.ts` reaches Docs/Sheets/Slides only through their public store surfaces (already `Pick<...>` typed) — no new reach into another `platform/<other>/store` internal. → verified in Self-Review; enforced by the cross-cutting `helix/no-cross-domain-import` rule.
- [ ] **G8 — Surfaces are layered.** Every new capability (rename, version revert, share links, multipart) lands first as a `drive.*` tool (so MCP/OpenAPI/CLI inherit it); web consumes it through the shared contract, not a bespoke HTTP shape. → Phase 4.
- [ ] **G9 — Tested.** Unit tests for all pure core (roles, mappers, storage-key, quota, range), integration tests for the IO adapter/routes, and **at least one negative authorization test per mutating op** (share/move/trash/delete/updateAccess/removeAccess). → Phases 0, 3, 5.

---

## Current-State Grounding (verified against the tree)

| File | LOC | Note |
|---|---|---|
| `platform/drive/store.ts` | 2,793 ⚠⚠ | god-module. Auth predicates `canReadObjectSql` (:1942), `requireObjectAccess` (:1844); mutations `share` (:799), `removeAccess` (:865), `updateAccess` (:911), `move` (:977), `trash` (:1024), `delete` (:1067). Storage key `driveStorageKey` (:2468, template at :2474), `assertProvidedFinalizeStorageKey` (:2478). Quota `assertStorageQuotaAvailable` (:~1810). `syncTargetDeletedAt` hardcoded app→table map (:1962). Only custom error class = `DriveStorageQuotaExceededError`. |
| `platform/drive/tools.ts` | 888 ⚠ | ~23 tools; **all** `outputSchema: zodToolSchema(z.unknown(), genericObjectJsonSchema)`. `shareSchema.role` enum `["reader","commenter","editor","owner"]` (:67); `updateAccessSchema.role` `["reader","commenter","editor"]` (:88). Serializers Date→ISO at :828–888. |
| `platform/drive/routes.ts` | 803 ⚠ | WebDAV `/dav/files/*`; `parseDavFilePath` (:671); plain-string `reply.code(4xx).send("...")` throughout; WebDAV GET (:94) full-bytes, no range. |
| `platform/drive/preview.ts` | 444 ⚠ | LibreOffice HTTP client + local Chromium office→pdf/html. No SSRF allowlist on the office-preview URL. |
| `platform/drive/types.ts` | 201 | `DriveShareRole = viewer\|commenter\|editor\|owner` (mismatch vs tools' `reader`). All record interfaces. |
| `platform/drive/range-response.ts` | 108 | pure Range/206 helper; `range-response.ts:46` sends `{ error: "..." }`. **No dedicated unit test.** |
| `platform/drive/inline-body.ts` | 42 | reads `process.env.NODE_ENV` directly. |
| `apps/web/.../drive/api.ts` | 606 ⚠ | redeclares `DriveApiEntry`, `DriveApiPreview`, `DriveApiSearchHit`, `DriveShareInput`, `DriveAccessGrant`, `DriveUploadResult`, `DriveVersionResult`, `DriveAccessRole` (duplicates `types.ts`). `errorMessageFromOutput` (:586) tolerates 3 error shapes. |
| `apps/web/.../drive/drive-shell.tsx` | 2,390 ⚠⚠ | ~16 components + share-target parsing + editor routing in one file. |
| `apps/web/.../drive/file-thumbnail.tsx` | 924 ⚠ | thumbnail matrix. |
| DB `db/schema.ts` | 1,816 | `objects` (:348), `permissions` (:427, `role text notNull` free text), `driveFolders` (:1149, `parentFolderId uuid` **no FK**), `driveVersions` (:1168), `drivePdfFormStates` (:1198). **`drive_comments` is in migration `0047` but ABSENT from `schema.ts`** (Drizzle drift). Next migration number = **0065**. |
| `server.ts` Drive wiring | :1443–1580 | inline `process.env.RUSTFS_*`, `HELIX_DRIVE_OFFICE_PREVIEW_URL/TIMEOUT_MS`, `HELIX_DRIVE_LOCAL_OFFICE_PREVIEW`, `HELIX_CHROMIUM_PATH` with scattered `Number()`/`??`. Content/preview endpoints :2643 / :2715 (session-cookie auth, per-object ACL, **no scope check**). |

---

## Phase 0 — P0 Security & Correctness (do first, mergeable ahead of the cross-cutting plan)

**Outcome:** the privilege-escalation and schema-drift defects are closed with negative tests. Satisfies **G6** and the P0 subset of **G4**. All Phase 0 tasks are self-contained (local `errors.ts`/`roles.ts`), so they ship without waiting for `@helix/contracts`.

> Start: `git checkout main && git pull && git checkout -b feat/drive-elite`.

### Task 0.1: Register `drive_comments` in the Drizzle schema (schema drift)

**Files:**
- Modify: `apps/helix/src/db/schema.ts` — insert a `driveComments` table right after `drivePdfFormStates` (ends at :1230), mirroring migration `0047_drive_comments.sql` exactly.
- Test (create): `apps/helix/src/db/schema-drive-comments.test.ts`
- Reference (read-only): `apps/helix/src/db/migrations/0047_drive_comments.sql`

**Interfaces:**
- Consumes: existing `objects`, `actors` table refs; `pgTable`, `uuid`, `text`, `jsonb`, `timestamp`, `index` imports already in `schema.ts`.
- Produces: `export const driveComments` matching the 11 raw-SQL sites in `store.ts` (columns `id, org_id, object_id, parent_comment_id, actor_id, anchor, body, status, metadata, resolved_at, created_at, updated_at`).

- [ ] **Step 1: Write the failing test** — `apps/helix/src/db/schema-drive-comments.test.ts`

```ts
import { describe, expect, it } from "vitest";
import { getTableConfig } from "drizzle-orm/pg-core";
import { driveComments } from "./schema.js";

describe("driveComments schema (parity with migration 0047)", () => {
  it("exposes the drive_comments table with the migration's columns", () => {
    const config = getTableConfig(driveComments);
    expect(config.name).toBe("drive_comments");
    const columns = new Set(config.columns.map((c) => c.name));
    for (const col of [
      "id", "org_id", "object_id", "parent_comment_id", "actor_id",
      "anchor", "body", "status", "metadata", "resolved_at",
      "created_at", "updated_at",
    ]) {
      expect(columns.has(col), `missing column ${col}`).toBe(true);
    }
  });

  it("marks object_id and body NOT NULL and status defaulting to 'open'", () => {
    const config = getTableConfig(driveComments);
    const byName = new Map(config.columns.map((c) => [c.name, c]));
    expect(byName.get("object_id")?.notNull).toBe(true);
    expect(byName.get("body")?.notNull).toBe(true);
    expect(byName.get("status")?.notNull).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `pnpm --filter @helix/app test -- schema-drive-comments`. Expected: FAIL — `driveComments` is not exported from `./schema.js`.

- [ ] **Step 3: Implement** — in `apps/helix/src/db/schema.ts`, immediately after the `drivePdfFormStates` table (closes at line ~1230), insert:

```ts
export const driveComments = pgTable(
  "drive_comments",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: uuid("org_id").notNull(),
    objectId: uuid("object_id")
      .references(() => objects.id, { onDelete: "cascade" })
      .notNull(),
    parentCommentId: uuid("parent_comment_id"),
    actorId: uuid("actor_id").references(() => actors.id, { onDelete: "set null" }),
    anchor: jsonb("anchor").default({}).notNull(),
    body: text("body").notNull(),
    status: text("status").default("open").notNull(),
    metadata: jsonb("metadata").default({}).notNull(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }),
  },
  (table) => ({
    objectStatusCreatedIdx: index("drive_comments_object_status_created_idx").on(
      table.orgId,
      table.objectId,
      table.status,
      table.createdAt,
    ),
    parentCreatedIdx: index("drive_comments_parent_created_idx").on(
      table.parentCommentId,
      table.createdAt,
    ),
  }),
);
```

> `parent_comment_id`'s self-referencing FK from `0047` (`references drive_comments(id) on delete cascade`) plus the `status in ('open','resolved')` CHECK are expressed at the SQL layer; Drizzle's self-ref FK requires an `AnyPgColumn` return-type annotation and cannot express partial-index `WHERE` or CHECK clauses. This registration exists to end the schema-drift blind spot (so `pnpm drizzle-kit check` and future generated migrations see the table) — it does **not** replace `0047`. Add a `// ponytail: 0047 owns the self-ref FK + status CHECK + partial index; Drizzle can't express them.` note above the table.

- [ ] **Step 4: Run to verify it passes** — `pnpm --filter @helix/app test -- schema-drive-comments`. Expected: PASS (2 tests). Then `pnpm --filter @helix/app typecheck`. Expected: PASS.

- [ ] **Step 5: Verify no generated-migration drift** — `pnpm --filter @helix/app exec drizzle-kit check` (drizzle.config.ts present). Expected: no error about an untracked `drive_comments`. If it wants to emit a fresh `create table`, discard that output — `0047` already created it; the schema entry is documentation/parity only.

- [ ] **Step 6: Commit**

```bash
git add apps/helix/src/db/schema.ts apps/helix/src/db/schema-drive-comments.test.ts
git commit -m "fix(drive): register drive_comments in drizzle schema to end drift"
```

### Task 0.2: Drive role enum (pure core) + P0 error classes

**Files:**
- Create: `apps/helix/src/platform/drive/core/roles.ts`, `apps/helix/src/platform/drive/core/roles.test.ts`
- Create: `apps/helix/src/platform/drive/errors.ts`, `apps/helix/src/platform/drive/errors.test.ts`
- Modify: `apps/helix/src/platform/drive/index.ts` — add `export * from "./core/roles.js";` and `export * from "./errors.js";`

**Interfaces:**
- Produces (roles.ts): `DRIVE_ROLES = ["reader","commenter","editor","owner"] as const`, `type DriveRole`, `driveRoleRank(role: DriveRole): number` (reader 0 < commenter 1 < editor 2 < owner 3), `normalizeDriveRole(raw: string): DriveRole` (maps legacy `"viewer"` → `"reader"`; unknown → `"reader"` floor), `hasRoleAtLeast(role: DriveRole, min: DriveRole): boolean`.
- Produces (errors.ts): `DriveNotFoundError`, `DriveForbiddenError`, `DriveInvalidStorageKeyError`, `DriveConflictError`, and `DriveQuotaExceededError` — see Step 3.

> **Ordering note:** Phase 0 defines `DRIVE_ROLES` locally in `core/roles.ts`. Phase 1 Task 1.1 replaces this local const with an import from `@helix/contracts` (the enum authored once in `packages/contracts/src/drive.ts`); `driveRoleRank`/`normalizeDriveRole`/`hasRoleAtLeast` remain server logic in core. Until the cross-cutting `api-error.ts` merges, `errors.ts` classes extend `Error` locally; Phase 2 Task 2.1 re-parents them onto `ApiError` subclasses.

- [ ] **Step 1: Write the failing test** — `apps/helix/src/platform/drive/core/roles.test.ts`

```ts
import { describe, expect, it } from "vitest";
import { DRIVE_ROLES, driveRoleRank, hasRoleAtLeast, normalizeDriveRole } from "./roles.js";

describe("drive roles", () => {
  it("orders reader < commenter < editor < owner", () => {
    expect(driveRoleRank("reader")).toBeLessThan(driveRoleRank("commenter"));
    expect(driveRoleRank("commenter")).toBeLessThan(driveRoleRank("editor"));
    expect(driveRoleRank("editor")).toBeLessThan(driveRoleRank("owner"));
  });

  it("normalizes the legacy 'viewer' vocab to 'reader'", () => {
    expect(normalizeDriveRole("viewer")).toBe("reader");
  });

  it("floors unknown/free-text roles to 'reader' (least privilege)", () => {
    expect(normalizeDriveRole("superadmin")).toBe("reader");
    expect(normalizeDriveRole("")).toBe("reader");
  });

  it("keeps the four canonical roles intact", () => {
    for (const role of DRIVE_ROLES) expect(normalizeDriveRole(role)).toBe(role);
  });

  it("hasRoleAtLeast is inclusive of the threshold", () => {
    expect(hasRoleAtLeast("editor", "editor")).toBe(true);
    expect(hasRoleAtLeast("owner", "editor")).toBe(true);
    expect(hasRoleAtLeast("commenter", "editor")).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `pnpm --filter @helix/app test -- drive/core/roles`. Expected: FAIL — cannot find `./roles.js`.

- [ ] **Step 3: Implement** — `apps/helix/src/platform/drive/core/roles.ts`

```ts
export const DRIVE_ROLES = ["reader", "commenter", "editor", "owner"] as const;
export type DriveRole = (typeof DRIVE_ROLES)[number];

const RANK: Record<DriveRole, number> = {
  reader: 0,
  commenter: 1,
  editor: 2,
  owner: 3,
};

export function driveRoleRank(role: DriveRole): number {
  return RANK[role];
}

/** Collapse the historical vocab (`viewer`) and any free-text `permissions.role`
 *  value onto the closed enum. Unknown values floor to `reader` — the least
 *  privilege — so a corrupt/legacy grant can never widen access. */
export function normalizeDriveRole(raw: string): DriveRole {
  const value = raw.trim().toLowerCase();
  if (value === "viewer") return "reader";
  return (DRIVE_ROLES as readonly string[]).includes(value) ? (value as DriveRole) : "reader";
}

export function hasRoleAtLeast(role: DriveRole, min: DriveRole): boolean {
  return RANK[role] >= RANK[min];
}
```

- [ ] **Step 4: Write the failing test** — `apps/helix/src/platform/drive/errors.test.ts`

```ts
import { describe, expect, it } from "vitest";
import {
  DriveConflictError,
  DriveForbiddenError,
  DriveInvalidStorageKeyError,
  DriveNotFoundError,
  DriveQuotaExceededError,
} from "./errors.js";

describe("drive errors", () => {
  it("DriveNotFoundError carries not_found/404", () => {
    const e = new DriveNotFoundError("gone");
    expect(e.code).toBe("not_found");
    expect(e.statusCode).toBe(404);
  });
  it("DriveForbiddenError carries forbidden/403", () => {
    const e = new DriveForbiddenError("nope");
    expect(e.code).toBe("forbidden");
    expect(e.statusCode).toBe(403);
  });
  it("DriveInvalidStorageKeyError is a bad_request/400", () => {
    expect(new DriveInvalidStorageKeyError("bad").statusCode).toBe(400);
  });
  it("DriveConflictError is a conflict/409", () => {
    expect(new DriveConflictError("dup").statusCode).toBe(409);
  });
  it("DriveQuotaExceededError reports the projected overage", () => {
    const e = new DriveQuotaExceededError({ orgId: "o1", limitBytes: 10, projectedBytes: 20 });
    expect(e.statusCode).toBe(409);
    expect(e.details).toMatchObject({ limitBytes: 10, projectedBytes: 20 });
  });
});
```

- [ ] **Step 5: Run to verify it fails** — `pnpm --filter @helix/app test -- drive/errors`. Expected: FAIL — cannot find `./errors.js`.

- [ ] **Step 6: Implement** — `apps/helix/src/platform/drive/errors.ts`. **Phase-0 form** (extends `Error`, carries the `code`/`statusCode` the future `ApiError` will expose, so the switch in Phase 2 is a base-class swap with no call-site change):

```ts
import type { ErrorCodeLike } from "./error-codes.js";

// Phase 0: local shape. Phase 2 T2.1 re-parents these onto ApiError subclasses
// from apps/helix/src/api/api-error.ts (which carry the identical code/statusCode).
export interface DriveErrorOptions {
  readonly details?: unknown;
  readonly cause?: unknown;
}

export class DriveError extends Error {
  readonly code: ErrorCodeLike;
  readonly statusCode: number;
  readonly details?: unknown;
  constructor(code: ErrorCodeLike, statusCode: number, message: string, options: DriveErrorOptions = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = new.target.name;
    this.code = code;
    this.statusCode = statusCode;
    this.details = options.details;
  }
}

export class DriveNotFoundError extends DriveError {
  constructor(message: string, o?: DriveErrorOptions) { super("not_found", 404, message, o); }
}
export class DriveForbiddenError extends DriveError {
  constructor(message: string, o?: DriveErrorOptions) { super("forbidden", 403, message, o); }
}
export class DriveInvalidStorageKeyError extends DriveError {
  constructor(message: string, o?: DriveErrorOptions) { super("bad_request", 400, message, o); }
}
export class DriveConflictError extends DriveError {
  constructor(message: string, o?: DriveErrorOptions) { super("conflict", 409, message, o); }
}

export class DriveQuotaExceededError extends DriveError {
  constructor(input: { readonly orgId: string; readonly limitBytes: number; readonly projectedBytes: number }) {
    super("conflict", 409, `Drive storage quota exceeded for org ${input.orgId}.`, {
      details: { limitBytes: input.limitBytes, projectedBytes: input.projectedBytes },
    });
  }
}
```

And the tiny code-type module `apps/helix/src/platform/drive/error-codes.ts` (Phase 2 swaps this `type` for the `ErrorCode` import from `@helix/contracts`):

```ts
export type ErrorCodeLike =
  | "bad_request" | "unauthorized" | "forbidden" | "not_found"
  | "conflict" | "unprocessable" | "rate_limited" | "internal_error";
```

- [ ] **Step 7: Run to verify it passes** — `pnpm --filter @helix/app test -- "drive/core/roles" "drive/errors"`. Expected: PASS (roles 5, errors 5).

- [ ] **Step 8: Wire barrel exports** — in `apps/helix/src/platform/drive/index.ts` add `export * from "./errors.js";` and `export * from "./core/roles.js";` (keep alphabetical-ish with existing lines).

- [ ] **Step 9: Commit**

```bash
git add apps/helix/src/platform/drive/core/roles.ts apps/helix/src/platform/drive/core/roles.test.ts \
        apps/helix/src/platform/drive/errors.ts apps/helix/src/platform/drive/errors.test.ts \
        apps/helix/src/platform/drive/error-codes.ts apps/helix/src/platform/drive/index.ts
git commit -m "feat(drive): closed role enum + typed drive error classes (foundation)"
```

### Task 0.3: Fix the sharing/mutation privilege escalation (high severity)

**Files:**
- Modify: `apps/helix/src/platform/drive/store.ts` — add `requireObjectRole` beside `requireObjectAccess` (:1844); re-gate `share` (:812), `move`/`updateFileFolder`, `trash` (:1037), `restore`, `delete` (:1074), `updateAccess` (:911), `removeAccess` (:865).
- Test (modify): `apps/helix/src/platform/drive/store.test.ts` (add negative-authorization cases) and `apps/helix/src/platform/drive/tools.test.ts` where relevant.

**Interfaces:**
- Consumes: `DriveForbiddenError`, `DriveNotFoundError` (T0.2), `normalizeDriveRole`, `hasRoleAtLeast`, `DriveRole` (T0.2), existing `canReadObjectSql` (:1942), `SqlLike`, `ObjectRow`.
- Produces: `async function requireObjectRole(sql: SqlLike, orgId: string, actorId: string, objectId: string, minRole: DriveRole): Promise<ObjectRow>` — resolves the object, returns it when the actor is the object owner **or** holds a non-expired grant whose `normalizeDriveRole(role)` rank ≥ `minRole`; throws `DriveNotFoundError` when the object is not even readable (no existence leak) and `DriveForbiddenError` when readable but under-privileged.

**The vulnerability (verified):** `share` (:812) and `delete` (:1074) call `requireObjectAccess` = **read** gate; `move`/`restore` (`updateFileFolder`) and `trash` (:1037) gate on `canReadObjectSql` = **read**. A `reader`-grant holder can re-share, move, trash, or hard-delete. `updateAccess` (:941) is already owner-only and `removeAccess` (:890) is owner-or-self — both are correct but use free-text role comparisons; standardize them onto the enum.

- [ ] **Step 1: Write the failing tests** — append to `apps/helix/src/platform/drive/store.test.ts`. Use the suite's existing in-memory `sql` fake / seed helpers (read the top of `store.test.ts` for the `makeStore()` / `seedObject()` shape and reuse them). One negative test per mutating op:

```ts
describe("Drive mutation authorization (least privilege)", () => {
  it("rejects share by a reader-only grantee with 403", async () => {
    const { store, ownerId, readerId, objectId } = await seedSharedObject({ role: "reader" });
    await expect(
      store.share({ orgId: ORG, actorId: readerId, objectId, targetActorIds: [ownerId], role: "reader" }),
    ).rejects.toMatchObject({ code: "forbidden", statusCode: 403 });
  });

  it("rejects trash by a commenter with 403", async () => {
    const { store, commenterId, objectId } = await seedSharedObject({ role: "commenter" });
    await expect(
      store.trash({ orgId: ORG, actorId: commenterId, objectId }),
    ).rejects.toMatchObject({ code: "forbidden" });
  });

  it("rejects move by a reader with 403", async () => {
    const { store, readerId, objectId } = await seedSharedObject({ role: "reader" });
    await expect(
      store.move({ orgId: ORG, actorId: readerId, objectId, folderId: null }),
    ).rejects.toMatchObject({ code: "forbidden" });
  });

  it("rejects delete by an editor with 403 (hard delete is owner-only)", async () => {
    const { store, editorId, objectId } = await seedSharedObject({ role: "editor" });
    await expect(
      store.delete({ orgId: ORG, actorId: editorId, objectId }),
    ).rejects.toMatchObject({ code: "forbidden" });
  });

  it("allows an editor to move and trash", async () => {
    const { store, editorId, objectId } = await seedSharedObject({ role: "editor" });
    await expect(store.move({ orgId: ORG, actorId: editorId, objectId, folderId: null })).resolves.not.toThrow();
  });

  it("returns 404 (not 403) to an actor with no grant at all", async () => {
    const { store, strangerId, objectId } = await seedSharedObject({ role: "reader" });
    await expect(
      store.trash({ orgId: ORG, actorId: strangerId, objectId }),
    ).rejects.toMatchObject({ code: "not_found" });
  });
});
```

> If the current fake `sql` cannot model the `permissions`/`objects` join used by `requireObjectRole`, extend the fake in `store.test.ts` to answer the role-lookup query, or promote these six cases into the DB-backed `e2e-drive-flow.test.ts` integration suite (which has a real Postgres). Prefer the unit path; fall back to integration only if the fake can't represent the grant join.

**Role thresholds (fixed by this task):** share / updateAccess / removeAccess → `owner`; move / trash / restore → `editor`; delete (hard) → `owner`. (Sharing management and destruction are owner-scoped; content edits are editor-scoped.)

- [ ] **Step 2: Run to verify it fails** — `pnpm --filter @helix/app test -- drive/store`. Expected: FAIL — the reader/commenter/editor calls currently resolve instead of throwing.

- [ ] **Step 3: Implement `requireObjectRole`** — in `store.ts`, immediately after `requireObjectAccess` (ends :1868), add:

```ts
async function requireObjectRole(
  sql: SqlLike,
  orgId: string,
  actorId: string,
  objectId: string,
  minRole: DriveRole,
): Promise<ObjectRow> {
  // Existence + readability first (returns 404, never leaks that the object
  // exists to an actor with no grant). requireObjectAccess already throws
  // DriveNotFoundError when unreadable (see T2.1 for the throw swap).
  const object = await requireObjectAccess(sql, orgId, actorId, objectId);
  if (object.owner_actor_id === actorId) return object; // owner outranks any grant
  const rows = (await sql`
    select role
    from permissions
    where org_id = ${orgId}
      and resource_type = 'object'
      and resource_id = ${objectId}
      and actor_id = ${actorId}
      and (expires_at is null or expires_at > now())
  `) as unknown as readonly { readonly role: string }[];
  const best = rows.reduce<DriveRole>((acc, r) => {
    const norm = normalizeDriveRole(r.role);
    return driveRoleRank(norm) > driveRoleRank(acc) ? norm : acc;
  }, "reader");
  if (!hasRoleAtLeast(best, minRole)) {
    throw new DriveForbiddenError(
      `Requires '${minRole}' access on Drive object ${objectId}; actor has '${best}'.`,
    );
  }
  return object;
}
```

Add the import at the top of `store.ts`: `import { type DriveRole, driveRoleRank, hasRoleAtLeast, normalizeDriveRole } from "./core/roles.js";` and `import { DriveForbiddenError } from "./errors.js";`.

- [ ] **Step 4: Re-gate each mutation (anchored edits):**
  - **`share`** — `store.ts:812`, inside `this.sql.begin`: replace `await requireObjectAccess(tx, input.orgId, input.actorId, input.objectId);` with `await requireObjectRole(tx, input.orgId, input.actorId, input.objectId, "owner");`. Also **normalize the written role**: at the `insert into permissions ... values (..., ${input.role}, ...)` (:817), change `${input.role}` to `${normalizeDriveRole(input.role)}`.
  - **`delete`** — `store.ts:1074`: replace `const object = await requireObjectAccess(tx, input.orgId, input.actorId, input.objectId);` with `const object = await requireObjectRole(tx, input.orgId, input.actorId, input.objectId, "owner");`.
  - **`trash`** — `store.ts:1029–1039`: the current `update ... where ... and ${canReadObjectSql(tx, ...)}` silently no-ops for under-privileged actors (returns 0 rows → `null`). Add a guard **before** the update, inside the `begin`: `await requireObjectRole(tx, input.orgId, input.actorId, input.objectId, "editor");`. Keep the `canReadObjectSql` predicate in the `update` (defense in depth); the guard now throws 403/404 instead of returning `null`.
  - **`move` / `restore`** — both funnel through `updateFileFolder`. Locate `updateFileFolder` (search `private async updateFileFolder`) and add, as its first statement inside the transaction, `await requireObjectRole(tx, input.orgId, input.actorId, input.objectId, "editor");` (thread `tx`). This covers `move` (:977) and `restore` (:1054) in one place.
  - **`updateAccess`** — `store.ts:919`: keep the owner-only SQL, but add a leading `await requireObjectRole(tx, input.orgId, input.actorId, input.objectId, "owner");` so a non-owner gets an explicit 403 rather than a silent empty result, and normalize the written role: `set role = ${normalizeDriveRole(input.role)}` (:931).
  - **`removeAccess`** — `store.ts:871`: add a leading `await requireObjectRole(tx, input.orgId, input.actorId, input.objectId, "owner");` (owner may remove others; a grantee removing *their own* access is still allowed by the existing `p.actor_id = ${input.actorId}` branch, so keep that SQL — but only after the role check passes for owners; for self-removal, short-circuit: if `input.targetActorId === input.actorId`, skip the owner requirement). Concretely: `if (input.targetActorId !== input.actorId) { await requireObjectRole(tx, input.orgId, input.actorId, input.objectId, "owner"); }`.

- [ ] **Step 5: Run to verify it passes** — `pnpm --filter @helix/app test -- drive/store`. Expected: PASS. Then run the full Drive suite: `pnpm --filter @helix/app test -- drive`. Fix any existing test that asserted a reader could mutate (those tests encoded the bug — update them to expect 403, referencing this task).

- [ ] **Step 6: Commit**

```bash
git add apps/helix/src/platform/drive/store.ts apps/helix/src/platform/drive/store.test.ts
git commit -m "fix(drive): enforce least-privilege role on share/move/trash/delete (CVE-class)"
```

### Task 0.4: Explicit `drive.read` scope enforcement on content/preview endpoints

**Files:**
- Modify: `apps/helix/src/server.ts` — content endpoint (:2643) and preview endpoint (:2715).
- Test (modify): the server/drive route test that already covers these endpoints (search `objects/:objectId/content` in `apps/helix/src/**/*.test.ts`; likely `apps/helix/src/server.test.ts` or a drive-endpoints test).

**Interfaces:**
- Consumes: existing `actorFromAuthenticatedRequest(request)`; the app's session→scope resolver. Find how other authed endpoints assert a scope (grep `assertScope` / `requireScope` / `hasScope` / `scopes` in `apps/helix/src/api` and `server.ts`) and reuse that exact helper — do **not** invent a new scope mechanism.
- Produces: a `drive.read` scope gate on both endpoints, defense-in-depth on top of the existing per-object ACL.

- [ ] **Step 1: Discover the scope helper** — `grep -rn "scope" apps/helix/src/api apps/helix/src/server.ts | grep -iv "telescope" | head -40`. Identify the canonical `assertScope(actor|request, "drive.read")` (or session-scope predicate). Record its import path.

- [ ] **Step 2: Write the failing test** — add to the drive-endpoints test suite. Model a session whose scopes exclude `drive.read` and assert 403:

```ts
it("rejects /content without the drive.read scope", async () => {
  const app = await buildTestServer();
  const res = await app.inject({
    method: "GET",
    url: `/api/drive/objects/${knownObjectId}/content`,
    cookies: sessionCookieWithScopes([]), // no drive.read
  });
  expect(res.statusCode).toBe(403);
});
```

> Match the helper names to the suite's real bootstrap (`buildTestServer` / `injectAuthed` etc.). If the codebase has no scope-restricted session fixture yet, add the minimal fixture next to the existing authed-session fixture.

- [ ] **Step 3: Run to verify it fails** — `pnpm --filter @helix/app test -- <endpoints-suite>`. Expected: FAIL (currently returns 200/206).

- [ ] **Step 4: Implement** — in both handlers, immediately after the `actor.id === "anonymous"` 401 guard (:2647 for content, :2719 for preview), add the scope assertion using the discovered helper, e.g.:

```ts
// after the anonymous 401 guard:
requireScope(actor, "drive.read"); // throws ForbiddenError → 403 via the central handler
```

If the discovered helper returns a boolean instead of throwing, wrap it: `if (!hasScope(actor, "drive.read")) return reply.code(403).send({ error: "Insufficient scope." });` — and note this `{ error: "..." }` is replaced by the typed-error path in Phase 2 T2.1.

- [ ] **Step 5: Run to verify it passes** — `pnpm --filter @helix/app test -- <endpoints-suite>`. Expected: PASS. Confirm the happy-path (session *with* `drive.read`) still streams 200/206.

- [ ] **Step 6: Commit**

```bash
git add apps/helix/src/server.ts apps/helix/src/**/*.test.ts
git commit -m "fix(drive): require drive.read scope on content/preview endpoints"
```

---

## Phase 1 — Typed contracts & runtime validation (G1, G2)

**Outcome:** Drive shapes are authored once as Zod in `@helix/contracts`; the API infers its record types and validates every tool output; the web deletes its duplicated DTOs. **Prerequisite:** cross-cutting Phase 1 (`@helix/contracts` scaffold + `parseInput`) merged.

### Task 1.1: `packages/contracts/src/drive.ts` — the single source of truth

**Files:**
- Create: `packages/contracts/src/drive.ts`, `packages/contracts/src/drive.test.ts`
- Modify: `packages/contracts/src/index.ts` (add `export * from "./drive.js";`), `packages/contracts/package.json` (add `"./drive": "./dist/drive.js"` to `exports`)
- Modify: `apps/helix/src/platform/drive/core/roles.ts` — replace the local `DRIVE_ROLES` const with a re-export from `@helix/contracts`.

**Interfaces:**
- Produces: `driveRoleSchema` (`z.enum(["reader","commenter","editor","owner"])`), `DRIVE_ROLES`, `type DriveRole`, `driveItemKindSchema`, `drivePreviewSchema`/`DrivePreview`, `driveEntrySchema`/`DriveEntry`, `driveUploadResultSchema`/`DriveUploadResult`, `driveVersionSchema`/`DriveVersion`, `driveAccessGrantSchema`/`DriveAccessGrant`, `driveCommentSchema`/`DriveComment`, `driveSearchHitSchema`/`DriveSearchHit`, `drivePdfFormStateSchema`/`DrivePdfFormState`. All date fields are `z.string()` (ISO) — these model the **serialized** wire shapes the tools return (`serializeEntry` et al. emit ISO strings).

- [ ] **Step 1: Write the failing test** — `packages/contracts/src/drive.test.ts`

```ts
import { describe, expect, it } from "vitest";
import {
  DRIVE_ROLES,
  driveEntrySchema,
  driveRoleSchema,
  driveUploadResultSchema,
} from "./drive.js";

describe("drive contracts", () => {
  it("exposes the four canonical roles", () => {
    expect(DRIVE_ROLES).toEqual(["reader", "commenter", "editor", "owner"]);
    expect(driveRoleSchema.parse("editor")).toBe("editor");
    expect(() => driveRoleSchema.parse("viewer")).toThrow();
  });

  it("parses a serialized drive entry (ISO date strings)", () => {
    const parsed = driveEntrySchema.parse({
      id: "11111111-1111-4111-8111-111111111111",
      type: "file",
      name: "q3.pdf",
      folderId: null,
      ownerActorId: "22222222-2222-4222-8222-222222222222",
      metadata: {},
      deletedAt: null,
      createdAt: "2026-07-18T00:00:00.000Z",
      updatedAt: "2026-07-18T00:00:00.000Z",
    });
    expect(parsed.name).toBe("q3.pdf");
  });

  it("rejects a drive entry with a non-uuid id", () => {
    expect(() => driveEntrySchema.parse({ id: "nope", type: "file", name: "x",
      folderId: null, ownerActorId: null, metadata: {}, deletedAt: null,
      createdAt: "2026-07-18T00:00:00.000Z", updatedAt: "2026-07-18T00:00:00.000Z" })).toThrow();
  });

  it("upload result carries a nullable uploadUrl and headers map", () => {
    const parsed = driveUploadResultSchema.parse({
      objectId: "33333333-3333-4333-8333-333333333333",
      orgId: "44444444-4444-4444-8444-444444444444",
      ownerActorId: "55555555-5555-4555-8555-555555555555",
      name: "a.bin", folderId: null, storageKey: "drive/o/x/v1/a.bin",
      mimeType: "application/octet-stream", byteSize: 3, sha256: null,
      status: "prepared", uploadUrl: null, uploadHeaders: {}, metadata: {},
      createdAt: "2026-07-18T00:00:00.000Z", updatedAt: "2026-07-18T00:00:00.000Z",
    });
    expect(parsed.uploadUrl).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `pnpm --filter @helix/contracts test -- drive`. Expected: FAIL (no module).

- [ ] **Step 3: Implement `packages/contracts/src/drive.ts`** — model each shape from `apps/helix/src/platform/drive/types.ts` (read it) with ISO-string dates. Real code:

```ts
import { z } from "zod";

export const DRIVE_ROLES = ["reader", "commenter", "editor", "owner"] as const;
export const driveRoleSchema = z.enum(DRIVE_ROLES);
export type DriveRole = z.infer<typeof driveRoleSchema>;

export const driveItemKindSchema = z.enum(["file", "folder"]);
export type DriveItemKind = z.infer<typeof driveItemKindSchema>;

export const drivePreviewKindSchema = z.enum(["text", "image", "pdf", "office", "unsupported"]);
export const drivePreviewStatusSchema = z.enum(["available", "unsupported"]);

export const drivePreviewSchema = z.object({
  kind: drivePreviewKindSchema,
  status: drivePreviewStatusSchema,
  mimeType: z.string(),
  text: z.string().optional(),
  url: z.string().optional(),
  storageKey: z.string().optional(),
  pageCount: z.number().int().nonnegative().optional(),
  width: z.number().int().nonnegative().optional(),
  height: z.number().int().nonnegative().optional(),
  blocker: z.string().optional(),
  generatedAt: z.string().optional(),
});
export type DrivePreview = z.infer<typeof drivePreviewSchema>;

const jsonObjectSchema = z.record(z.unknown());

export const driveEntrySchema = z.object({
  id: z.string().uuid(),
  type: driveItemKindSchema,
  name: z.string(),
  folderId: z.string().uuid().nullable(),
  ownerActorId: z.string().uuid().nullable(),
  ownerDisplayName: z.string().optional(),
  ownerEmail: z.string().optional(),
  app: z.string().nullable().optional(),
  mimeType: z.string().optional(),
  byteSize: z.number().int().nonnegative().optional(),
  sha256: z.string().nullable().optional(),
  storageKey: z.string().optional(),
  versionNumber: z.number().int().positive().optional(),
  preview: drivePreviewSchema.optional(),
  metadata: jsonObjectSchema.default({}),
  deletedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type DriveEntry = z.infer<typeof driveEntrySchema>;

export const driveUploadResultSchema = z.object({
  objectId: z.string().uuid(),
  orgId: z.string().uuid(),
  ownerActorId: z.string().uuid(),
  name: z.string(),
  folderId: z.string().uuid().nullable(),
  storageKey: z.string(),
  mimeType: z.string(),
  byteSize: z.number().int().nonnegative(),
  sha256: z.string().nullable(),
  status: z.string(),
  uploadUrl: z.string().nullable(),
  uploadHeaders: z.record(z.string()).default({}),
  metadata: jsonObjectSchema.default({}),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type DriveUploadResult = z.infer<typeof driveUploadResultSchema>;

export const driveVersionSchema = z.object({
  id: z.string().uuid(),
  orgId: z.string().uuid(),
  objectId: z.string().uuid(),
  versionNumber: z.number().int().positive(),
  storageKey: z.string(),
  mimeType: z.string(),
  byteSize: z.number().int().nonnegative(),
  sha256: z.string(),
  metadata: jsonObjectSchema.default({}),
  createdByActorId: z.string().uuid().nullable(),
  createdAt: z.string(),
});
export type DriveVersion = z.infer<typeof driveVersionSchema>;

export const driveAccessGrantSchema = z.object({
  actorId: z.string().uuid(),
  role: z.string(), // stored value; normalize with normalizeDriveRole on read
  displayName: z.string().optional(),
  email: z.string().optional(),
  grantedByActorId: z.string().uuid().nullable(),
  expiresAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type DriveAccessGrant = z.infer<typeof driveAccessGrantSchema>;

export const driveSearchHitSchema = z.object({
  objectId: z.string().uuid(),
  name: z.string(),
  mimeType: z.string(),
  byteSize: z.number().int().nonnegative(),
  sha256: z.string().nullable(),
  folderId: z.string().uuid().nullable(),
  preview: z.string(),
  previewMetadata: drivePreviewSchema.optional(),
  updatedAt: z.string(),
});
export type DriveSearchHit = z.infer<typeof driveSearchHitSchema>;

export const driveCommentSchema = z.object({
  id: z.string().uuid(),
  orgId: z.string().uuid(),
  objectId: z.string().uuid(),
  parentCommentId: z.string().uuid().nullable(),
  actorId: z.string().uuid().nullable(),
  anchor: jsonObjectSchema.default({}),
  body: z.string(),
  status: z.string(),
  metadata: jsonObjectSchema.default({}),
  resolvedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string().nullable(),
  author: z.object({ id: z.string(), displayName: z.string().optional(), email: z.string().optional() }).optional(),
});
export type DriveComment = z.infer<typeof driveCommentSchema>;

export const drivePdfFormStateSchema = z.object({
  orgId: z.string().uuid(),
  objectId: z.string().uuid(),
  actorId: z.string().uuid(),
  fieldValues: z.array(jsonObjectSchema),
  sourceVersionNumber: z.number().int().nullable(),
  sourceSha256: z.string().nullable(),
  sourceByteSize: z.number().int().nullable(),
  sourceChanged: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type DrivePdfFormState = z.infer<typeof drivePdfFormStateSchema>;
```

- [ ] **Step 4: Run to verify it passes** — `pnpm --filter @helix/contracts test -- drive`. Expected: PASS. Wire `index.ts` export + `package.json` `./drive` subpath; `pnpm install`.

- [ ] **Step 5: Converge the Phase-0 role enum onto contracts** — in `apps/helix/src/platform/drive/core/roles.ts`, replace the local `export const DRIVE_ROLES = [...] as const; export type DriveRole = ...;` (Step 3 of T0.2) with:

```ts
export { DRIVE_ROLES, type DriveRole } from "@helix/contracts/drive";
```

Keep `driveRoleRank`, `normalizeDriveRole`, `hasRoleAtLeast` (server logic). Add `"@helix/contracts": "workspace:*"` to `apps/helix/package.json` if not already present. Run `pnpm --filter @helix/app test -- drive/core/roles` → PASS (unchanged behavior).

- [ ] **Step 6: Re-infer `types.ts` from the contract** — in `apps/helix/src/platform/drive/types.ts`, replace hand-written interfaces that now have a contract twin (`DrivePreview`, and the wire-facing serialized shapes) with `import type` re-exports from `@helix/contracts/drive` where the field sets match. Leave the **DB record** interfaces (`DriveEntryRecord`, `DriveUploadRecord`, … which carry `Date` and DB-only fields) as-is — they model rows, not wire. Change `export type DriveShareRole = "viewer" | ...` to `export type { DriveRole as DriveShareRole } from "@helix/contracts/drive";` and fix the one call site if the literal `"viewer"` was used anywhere (grep). Run `pnpm --filter @helix/app typecheck`. Expected: PASS (or a short list of real drifts to fix).

- [ ] **Step 7: Commit**

```bash
git add packages/contracts apps/helix/src/platform/drive/core/roles.ts apps/helix/src/platform/drive/types.ts apps/helix/package.json
git commit -m "feat(contracts): author drive shapes as Zod; drive sources infer from them"
```

### Task 1.2: Concrete tool output schemas + validate-before-return

**Files:**
- Create: `apps/helix/src/platform/drive/tool-output-schemas.ts`
- Modify: `apps/helix/src/platform/drive/tools.ts` — replace all ~23 `outputSchema: zodToolSchema(z.unknown(), genericObjectJsonSchema)`.
- Test (modify): `apps/helix/src/platform/drive/tools.test.ts` — assert outputs validate.

**Interfaces:**
- Consumes: contract schemas from `@helix/contracts/drive`; `zodToolSchema` (`platform/webhooks/tool-schemas.ts` — signature `zodToolSchema<T>(schema: T, jsonSchema: JsonObject)`, whose `.parse(value)` runs `schema.parse`).
- Produces: one concrete `z.output`-typed schema per tool (envelope + payload), e.g. `driveListOutputSchema = z.object({ entries: driveEntrySchema.array() })`.

> `zodToolSchema`'s **first** argument is the runtime validator that satisfies G2. Keep `genericObjectJsonSchema` as the advertised JSON-schema (second arg) for now — precise JSON-schema generation is a non-blocking follow-up; the concrete Zod validator is what the gate requires.

- [ ] **Step 1: Write the failing test** — append to `tools.test.ts`:

```ts
it("drive.list output validates against the concrete schema", async () => {
  const tools = createDriveToolDefinitions(baseOptions);
  const listTool = tools.find((t) => t.id === "drive.list")!;
  const out = await listTool.handler({ folderId: null, includeTrashed: false, limit: 100 }, ctx);
  // outputSchema.parse must accept the handler's own return value:
  expect(() => listTool.outputSchema.parse(out)).not.toThrow();
});

it("no drive tool ships an unknown/passthrough output schema", () => {
  const tools = createDriveToolDefinitions(baseOptions);
  for (const t of tools) {
    // z.unknown().parse(anything) never throws; a concrete schema rejects junk.
    expect(() => t.outputSchema.parse({ __definitely_not_a_valid_output__: Symbol() as unknown })).toThrow();
  }
});
```

> Reuse the suite's existing `baseOptions`/`ctx` fixtures (read the top of `tools.test.ts`). The second assertion is the anti-`z.unknown()` guard; if a genuinely-empty-object output tool exists, exclude it explicitly by id with a comment.

- [ ] **Step 2: Run to verify it fails** — `pnpm --filter @helix/app test -- drive/tools`. Expected: FAIL (current `z.unknown()` accepts the junk object).

- [ ] **Step 3: Implement `tool-output-schemas.ts`** — one schema per tool, composed from contracts:

```ts
import { z } from "zod";
import {
  driveAccessGrantSchema,
  driveCommentSchema,
  driveEntrySchema,
  drivePdfFormStateSchema,
  driveSearchHitSchema,
  driveUploadResultSchema,
  driveVersionSchema,
} from "@helix/contracts/drive";

export const driveCreateOutputSchema = z.union([
  z.object({ id: z.string().uuid(), app: z.string() }),
  driveEntrySchema, // folder kind returns a full entry
]);
export const driveUploadOutputSchema = driveUploadResultSchema;
export const driveFinalizeOutputSchema = driveVersionSchema;
export const driveListOutputSchema = z.object({ entries: driveEntrySchema.array() });
export const driveShareOutputSchema = z.object({
  objectId: z.string().uuid(),
  sharedWithActorIds: z.string().uuid().array(),
  role: z.string(),
});
export const driveAccessListOutputSchema = z.object({ grants: driveAccessGrantSchema.array() });
export const driveAccessRemoveOutputSchema = z.object({
  objectId: z.string().uuid(),
  actorId: z.string().uuid(),
  removed: z.boolean(),
});
export const driveAccessUpdateOutputSchema = z.object({
  objectId: z.string().uuid(),
  actorId: z.string().uuid(),
  grant: driveAccessGrantSchema.nullable(),
});
export const driveEntryOrNullOutputSchema = driveEntrySchema.nullable(); // move/star/trash/restore
export const driveDeleteOutputSchema = z.object({ objectId: z.string().uuid(), deleted: z.boolean() });
export const driveSearchOutputSchema = z.object({ hits: driveSearchHitSchema.array() });
export const driveCommentOutputSchema = driveCommentSchema;
export const driveCommentListOutputSchema = z.object({ comments: driveCommentSchema.array() });
export const drivePdfFormStateOutputSchema = drivePdfFormStateSchema.nullable();
```

> Confirm each envelope against the tool handler's actual `return` (e.g. `drive.list` returns `{ entries }`, `drive.search` returns `{ hits }`, `drive.access.list` returns `{ grants }` — verified). Adjust any envelope key that differs.

- [ ] **Step 4: Rewire `tools.ts`** — for each `defineTool`, replace `outputSchema: zodToolSchema(z.unknown(), genericObjectJsonSchema)` with the matching concrete schema, e.g. for `drive.list` (:332): `outputSchema: zodToolSchema(driveListOutputSchema, genericObjectJsonSchema)`. Add the import block from `./tool-output-schemas.js`. Map:
  - `drive.create` → `driveCreateOutputSchema`; `drive.upload` → `driveUploadOutputSchema`; `drive.finalize` → `driveFinalizeOutputSchema`; `drive.list` → `driveListOutputSchema`; `drive.share` → `driveShareOutputSchema`; `drive.access.list` → `driveAccessListOutputSchema`; `drive.access.remove` → `driveAccessRemoveOutputSchema`; `drive.access.update` → `driveAccessUpdateOutputSchema`; `drive.move`/`drive.star.set`/`drive.trash`/`drive.restore` → `driveEntryOrNullOutputSchema`; `drive.delete` → `driveDeleteOutputSchema`; `drive.search` → `driveSearchOutputSchema`; `drive.comment.create`/`.update`/`.resolve`/`.reopen`/`.delete` → `driveCommentOutputSchema`; `drive.comment.list` → `driveCommentListOutputSchema`; `drive.pdfFormState.get`/`.save`/`.clear` → `drivePdfFormStateOutputSchema`.
  - Update the `defineTool<Input, unknown>` second type param to `z.output<typeof <schema>>` for each (removes the `unknown` output type).

- [ ] **Step 5: Run to verify it passes** — `pnpm --filter @helix/app test -- drive/tools` then `pnpm --filter @helix/app typecheck`. Expected: PASS. If a handler's real return violates its schema, that is a genuine shape bug — fix the handler or the schema so they agree (the point of G2).

- [ ] **Step 6: Commit**

```bash
git add apps/helix/src/platform/drive/tool-output-schemas.ts apps/helix/src/platform/drive/tools.ts apps/helix/src/platform/drive/tools.test.ts
git commit -m "feat(drive): concrete tool output schemas, remove all z.unknown() (G2)"
```

### Task 1.3: Web `api.ts` consumes contracts, delete duplicated DTOs

**Files:**
- Modify: `apps/web/src/features/drive/api.ts` (delete local `DriveApiEntry`, `DriveApiPreview`, `DriveApiSearchHit`, `DriveShareInput.role` literal, `DriveAccessGrant`, `DriveAccessRole`, `DriveUploadResult`, `DriveVersionResult`; import from `@helix/contracts/drive`).
- Test (modify): `apps/web/src/features/drive/api.test.ts`.

**Interfaces:**
- Consumes: `DriveEntry`, `DrivePreview`, `DriveSearchHit`, `DriveAccessGrant`, `DriveUploadResult`, `DriveVersion`, `DriveRole` from `@helix/contracts/drive`.
- Produces: web-local type **aliases** for source back-compat (`export type DriveApiEntry = DriveEntry;`) so the ~15 importing components in `drive-shell.tsx`/`file-thumbnail.tsx` compile unchanged.

- [ ] **Step 1: Write the failing test** — add to `api.test.ts`:

```ts
import { driveEntrySchema } from "@helix/contracts/drive";
import type { DriveApiEntry } from "./api";

it("DriveApiEntry is assignable from a contract DriveEntry", () => {
  const parsed = driveEntrySchema.parse({
    id: "11111111-1111-4111-8111-111111111111", type: "file", name: "x",
    folderId: null, ownerActorId: null, metadata: {}, deletedAt: null,
    createdAt: "2026-07-18T00:00:00.000Z", updatedAt: "2026-07-18T00:00:00.000Z",
  });
  const entry: DriveApiEntry = parsed; // compiles only if alias === contract type
  expect(entry.id).toContain("1111");
});
```

- [ ] **Step 2: Run to verify it fails** — `pnpm --filter @helix/web test -- drive/api`. Expected: FAIL (contract not yet imported / structural mismatch, e.g. web's `DriveApiPreview.text?: string` vs contract optional — reconcile).

- [ ] **Step 3: Implement** — at the top of `api.ts`, replace the interface blocks (`api.ts:5–130` region: `DriveApiEntryType`…`DriveVersionResult`) with:

```ts
import type {
  DriveAccessGrant,
  DriveEntry,
  DrivePreview,
  DriveRole,
  DriveSearchHit,
  DriveUploadResult as DriveUploadResultContract,
  DriveVersion,
} from "@helix/contracts/drive";

export type DriveApiEntryType = DriveEntry["type"];
export type DriveApiPreview = DrivePreview;
export type DriveApiEntry = DriveEntry;
export type DriveApiSearchHit = DriveSearchHit;
export type DriveAccessRole = Exclude<DriveRole, "owner">; // update UI never sets owner
export type { DriveAccessGrant };
export type DriveUploadResult = DriveUploadResultContract;
export type DriveVersionResult = DriveVersion;

export interface DriveShareInput {
  readonly objectId: string;
  readonly actorIds?: readonly string[];
  readonly actorRefs?: readonly string[];
  readonly role?: DriveRole;
  readonly expiresAt?: string | null;
}
export interface DriveUploadInput { /* unchanged — request-only shape, keep local */ }
export interface DriveFinalizeInput { /* unchanged */ }
```

Keep the request-only input interfaces (`DriveUploadInput`, `DriveFinalizeInput`, `DriveCreateInput`) local — they are not wire records. Delete only the **response** duplicates.

- [ ] **Step 4: Run to verify it passes** — `pnpm --filter @helix/web typecheck && pnpm --filter @helix/web test -- drive`. Expected: PASS. Fix any component that relied on a field the contract renamed (none expected — the contract mirrors the DTOs field-for-field).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/features/drive/api.ts apps/web/src/features/drive/api.test.ts
git commit -m "refactor(web): drive api DTOs sourced from @helix/contracts (G1)"
```

---

## Phase 2 — Typed errors & validated config (G4, G3)

**Outcome:** every client-visible Drive failure is a typed error rendered by the central handler; Drive reads zero raw `process.env`. **Prerequisite:** cross-cutting Phase 3 (`api-error.ts`) + Phase 2 (`env.ts`) merged.

### Task 2.1: Re-parent Drive errors onto `ApiError`; replace bare throws & inline error responses

**Files:**
- Modify: `apps/helix/src/platform/drive/errors.ts` (extend `ApiError` subclasses), `apps/helix/src/platform/drive/error-codes.ts` (re-export `ErrorCode` from contracts).
- Modify: `apps/helix/src/platform/drive/store.ts` (`throw new Error(...)` → typed; `requireObjectAccess` :1865, `requireFolderAccess` :1886, `requireDriveCommentParent` :1907, quota `DriveStorageQuotaExceededError` → `DriveQuotaExceededError`, `assertProvidedFinalizeStorageKey` :2478).
- Modify: `apps/helix/src/platform/drive/tools.ts` (bare throws at :390 share, :811/:817 resolveDriveShareActorRefs).
- Modify: `apps/helix/src/platform/drive/routes.ts` (WebDAV plain-string `reply.code(4xx).send("...")`), `apps/helix/src/platform/drive/range-response.ts:46` (`{ error: "..." }`).
- Modify: `apps/helix/src/server.ts` content/preview endpoints (:2648, :2656, :2692, :2720, :2728, :2744 `send({ error: "..." })`).
- Test (modify): the corresponding suites.

**Interfaces:**
- Consumes: `ApiError`, `NotFoundError`, `ForbiddenError`, `BadRequestError`, `ConflictError` from `apps/helix/src/api/api-error.js`; `ErrorCode` from `@helix/contracts`.
- Produces: `DriveNotFoundError extends NotFoundError`, `DriveForbiddenError extends ForbiddenError`, `DriveInvalidStorageKeyError extends BadRequestError`, `DriveConflictError extends ConflictError`, `DriveQuotaExceededError extends ConflictError` — same names/`code`/`statusCode` as Phase 0, so no call-site changes.

- [ ] **Step 1: Write the failing test** — extend `errors.test.ts`:

```ts
import { ApiError } from "../../api/api-error.js";
it("drive errors are ApiError instances (rendered by the central handler)", () => {
  expect(new DriveNotFoundError("x")).toBeInstanceOf(ApiError);
  expect(new DriveForbiddenError("x")).toBeInstanceOf(ApiError);
  expect(new DriveQuotaExceededError({ orgId: "o", limitBytes: 1, projectedBytes: 2 })).toBeInstanceOf(ApiError);
});
```

- [ ] **Step 2: Run to verify it fails** — `pnpm --filter @helix/app test -- drive/errors`. Expected: FAIL (currently extends `Error`).

- [ ] **Step 3: Re-parent `errors.ts`** — rewrite the class bodies to extend the `ApiError` subclasses; delete the local `DriveError` base and `error-codes.ts` local type (replace with `export type { ErrorCode as ErrorCodeLike } from "@helix/contracts";`). Real code:

```ts
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError } from "../../api/api-error.js";

export class DriveNotFoundError extends NotFoundError {}
export class DriveForbiddenError extends ForbiddenError {}
export class DriveInvalidStorageKeyError extends BadRequestError {}
export class DriveConflictError extends ConflictError {}

export class DriveQuotaExceededError extends ConflictError {
  constructor(input: { readonly orgId: string; readonly limitBytes: number; readonly projectedBytes: number }) {
    super(`Drive storage quota exceeded for org ${input.orgId}.`, {
      details: { limitBytes: input.limitBytes, projectedBytes: input.projectedBytes },
    });
  }
}
```

- [ ] **Step 4: Replace bare throws in `store.ts` (anchored):**
  - `:1865` `throw new Error(\`Unknown or inaccessible Drive object: ${objectId}\`)` → `throw new DriveNotFoundError(\`Unknown or inaccessible Drive object: ${objectId}\`)`.
  - `:1886` folder → `throw new DriveNotFoundError(\`Unknown or inaccessible Drive folder: ${folderId}\`)`.
  - `:1907` comment parent → `throw new DriveNotFoundError(\`Unknown parent Drive comment: ${input.parentCommentId}\`)`.
  - The existing `DriveStorageQuotaExceededError` (:360) throw at `assertStorageQuotaAvailable` (:1840) → replace the class usage with `DriveQuotaExceededError({ orgId, limitBytes: limit, projectedBytes: projected })`. Keep the `onExceeded?.(...)` callback. Delete the old `DriveStorageQuotaExceededError` class (or make it `= DriveQuotaExceededError` alias if externally imported — grep first; if imported by tools/tests, keep the export name as an alias `export { DriveQuotaExceededError as DriveStorageQuotaExceededError }`).
  - `assertProvidedFinalizeStorageKey` (:2478) — any `throw new Error(...)` inside → `throw new DriveInvalidStorageKeyError(...)`.
  - Grep the file for remaining client-visible `throw new Error(`: `grep -n "throw new Error" apps/helix/src/platform/drive/store.ts` and convert each to the appropriate `Drive*Error` (invariant/programmer errors that are never client-visible may stay as `Error` — judge per message).

- [ ] **Step 5: Replace bare throws in `tools.ts`:**
  - `:390` `throw new Error("Drive share requires at least one workspace user.")` → `throw new DriveInvalidStorageKeyError(...)`? No — semantically a bad request: `throw new BadRequestError("Drive share requires at least one workspace user.")` (import from `../../api/api-error.js`) or a new `DriveBadRequestError`. Use `BadRequestError`.
  - `resolveDriveShareActorRefs` (:811, :817) `throw new Error("Drive share by email or name is not configured.")` / `Could not find workspace user(s): ...` → the first is a config/programmer error (500-class) — keep as `Error`; the second is user-facing → `throw new BadRequestError(\`Could not find workspace user(s): ${...}\`)`.

- [ ] **Step 6: Standardize `routes.ts` (WebDAV) + `range-response.ts`:**
  - `range-response.ts:46` — the 416 branch currently `.send({ error: "Requested range not satisfiable." })`. RFC-wise a 416 body is fine, but for envelope consistency change to `.send({ error: { code: "unprocessable", message: "Requested range not satisfiable." } })` **or** leave the body empty (`.send()`), since the `Content-Range: bytes */total` header is the contract. Choose empty body: `return reply.code(416).header("content-range", \`bytes */${total}\`).send();`. Update `range-response.test.ts` (created in Phase 5 T5.1 — for now, if the existing range coverage lives in `routes.test.ts`, adjust it).
  - `routes.ts` WebDAV handlers use `reply.code(4xx).send("plain string")` per the WebDAV contract (DAV clients expect text/XML bodies, not JSON envelopes). **Do not** JSON-envelope WebDAV responses — that would break DAV clients. Instead, leave the DAV string bodies but route them through a tiny local helper `davError(reply, code, message)` for consistency, and add a `// ponytail: WebDAV bodies stay plain-text per RFC 4918; not the JSON error envelope.` note. This is the one sanctioned exception to G4's envelope rule.

- [ ] **Step 7: Standardize `server.ts` Drive endpoints (:2643–2760):** replace each `return reply.code(4xx).send({ error: "..." })` with a `throw`:
  - `:2648` `reply.code(401).send({ error: "Authentication required." })` → `throw new UnauthorizedError("Authentication required.")`.
  - `:2656` / `:2728` `404 File not found.` → `throw new DriveNotFoundError("File not found.")`.
  - `:2692` / `:2744` `404 File content unavailable.` → `throw new DriveNotFoundError("File content unavailable.")`.
  - The 403 scope guard from T0.4 (if written as a boolean `reply.code(403)`) → `throw new ForbiddenError("Insufficient scope.")`.
  Import `UnauthorizedError`, `ForbiddenError` from `../api/api-error.js` (adjust relative path from server.ts). The central handler (cross-cutting T3.2) renders these into the envelope, so the web `errorMessageFromOutput` (:586) already parses them.

- [ ] **Step 8: Run** — `pnpm --filter @helix/app test -- drive` and the server endpoints suite. Update any test asserting the old `{ error: "string" }` body to the envelope `{ error: { code, message } }`. Expected: PASS.

- [ ] **Step 9: Grep sweep** — `grep -rn "throw new Error\|send({ error: \"" apps/helix/src/platform/drive apps/helix/src/server.ts | grep -i drive` → only sanctioned exceptions (WebDAV plain-text, non-client invariants) remain. Record the residual count in the commit message.

- [ ] **Step 10: Commit**

```bash
git add apps/helix/src/platform/drive apps/helix/src/server.ts
git commit -m "refactor(drive): route all client-visible errors through ApiError (G4)"
```

### Task 2.2: Validated `drive/config.ts` over the `env` module

**Files:**
- Create: `apps/helix/src/platform/drive/config.ts`, `apps/helix/src/platform/drive/config.test.ts`
- Modify: `apps/helix/src/config/env.ts` (cross-cutting) — extend the schema with the Drive keys (see below).
- Modify: `apps/helix/src/platform/drive/inline-body.ts` (stop reading `process.env.NODE_ENV` directly).
- Modify: `apps/helix/src/server.ts` (:1443–1580) — consume `driveConfig` instead of inline `process.env`.

**Interfaces:**
- Consumes: `env()` from `apps/helix/src/config/env.js`.
- Produces: `loadDriveConfig(e: Env = env()): DriveConfig` and `type DriveConfig` = `{ storage: { endpoint?: string; region: string; bucket: string; accessKeyId: string; secretAccessKey: string; serverSideEncryption?: "AES256"|"aws:kms"; forcePathStyle: boolean }, officePreview: { url?: string; localFallback: boolean; timeoutMs: number }, bodyLimitBytes: number, autoTagEnrichment: boolean, chromiumPath?: string, isProduction: boolean }`.

- [ ] **Step 1: Extend the env schema** — in `apps/helix/src/config/env.ts` (cross-cutting T2.1), add the Drive keys to `envSchema` (mirror the raw reads at `server.ts:1443–1568`): `RUSTFS_ENDPOINT`, `RUSTFS_API_PORT`, `RUSTFS_REGION` (default `"us-east-1"`), `RUSTFS_BUCKET` (default `"helix-objects"`), `RUSTFS_ACCESS_KEY` (default `"helixrustfs"`), `RUSTFS_SECRET_KEY`, `RUSTFS_SERVER_SIDE_ENCRYPTION` (optional enum), `HELIX_DRIVE_OFFICE_PREVIEW_URL` (`.url().optional()`), `HELIX_DRIVE_OFFICE_PREVIEW_TIMEOUT_MS` (`z.coerce.number().int().positive().default(10_000)`), `HELIX_DRIVE_LOCAL_OFFICE_PREVIEW` (`z.coerce.boolean().optional()`), `DRIVE_AUTO_TAG_ENRICHMENT` (`z.coerce.boolean().default(false)`), `HELIX_BODY_LIMIT_BYTES` (already there per cross-cutting seed), `HELIX_CHROMIUM_PATH` (optional), `NODE_ENV` (enum default `"development"`).

- [ ] **Step 2: Write the failing test** — `apps/helix/src/platform/drive/config.test.ts`

```ts
import { describe, expect, it } from "vitest";
import { loadDriveConfig } from "./config.js";
import { loadEnv } from "../../config/env.js";

const base = { DATABASE_URL: "postgres://u:p@localhost:5432/h", REDIS_URL: "redis://localhost:6379" };

describe("loadDriveConfig", () => {
  it("derives the RustFS endpoint from RUSTFS_API_PORT when RUSTFS_ENDPOINT is unset", () => {
    const cfg = loadDriveConfig(loadEnv({ ...base, RUSTFS_API_PORT: "28437" }));
    expect(cfg.storage.endpoint).toBe("http://localhost:28437");
  });

  it("defaults office-preview timeout and local fallback off in production", () => {
    const cfg = loadDriveConfig(loadEnv({ ...base, NODE_ENV: "production" }));
    expect(cfg.officePreview.timeoutMs).toBe(10_000);
    expect(cfg.officePreview.localFallback).toBe(false);
    expect(cfg.isProduction).toBe(true);
  });

  it("enables local office preview by default outside production", () => {
    const cfg = loadDriveConfig(loadEnv({ ...base, NODE_ENV: "development" }));
    expect(cfg.officePreview.localFallback).toBe(true);
  });
});
```

- [ ] **Step 3: Run to verify it fails** — `pnpm --filter @helix/app test -- drive/config`. Expected: FAIL (no module).

- [ ] **Step 4: Implement `config.ts`** — pure derivation from `Env`, no `process.env`:

```ts
import { env, type Env } from "../../config/env.js";

export interface DriveStorageConfig {
  readonly endpoint?: string;
  readonly region: string;
  readonly bucket: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly serverSideEncryption?: "AES256" | "aws:kms";
  readonly forcePathStyle: boolean;
}
export interface DriveConfig {
  readonly storage: DriveStorageConfig;
  readonly officePreview: { readonly url?: string; readonly localFallback: boolean; readonly timeoutMs: number };
  readonly bodyLimitBytes: number;
  readonly autoTagEnrichment: boolean;
  readonly chromiumPath?: string;
  readonly isProduction: boolean;
}

export function loadDriveConfig(e: Env = env()): DriveConfig {
  const isProduction = e.NODE_ENV === "production";
  const endpoint =
    e.RUSTFS_ENDPOINT ??
    (e.RUSTFS_API_PORT === undefined ? undefined : `http://localhost:${String(e.RUSTFS_API_PORT)}`);
  return {
    storage: {
      ...(endpoint === undefined ? {} : { endpoint }),
      region: e.RUSTFS_REGION,
      bucket: e.RUSTFS_BUCKET,
      accessKeyId: e.RUSTFS_ACCESS_KEY,
      secretAccessKey: e.RUSTFS_SECRET_KEY,
      ...(e.RUSTFS_SERVER_SIDE_ENCRYPTION === undefined ? {} : { serverSideEncryption: e.RUSTFS_SERVER_SIDE_ENCRYPTION }),
      forcePathStyle: true,
    },
    officePreview: {
      ...(e.HELIX_DRIVE_OFFICE_PREVIEW_URL === undefined ? {} : { url: e.HELIX_DRIVE_OFFICE_PREVIEW_URL }),
      localFallback: e.HELIX_DRIVE_LOCAL_OFFICE_PREVIEW ?? !isProduction,
      timeoutMs: e.HELIX_DRIVE_OFFICE_PREVIEW_TIMEOUT_MS,
    },
    bodyLimitBytes: e.HELIX_BODY_LIMIT_BYTES,
    autoTagEnrichment: e.DRIVE_AUTO_TAG_ENRICHMENT,
    ...(e.HELIX_CHROMIUM_PATH === undefined ? {} : { chromiumPath: e.HELIX_CHROMIUM_PATH }),
    isProduction,
  };
}
```

- [ ] **Step 5: Run to verify it passes** — `pnpm --filter @helix/app test -- drive/config`. Expected: PASS (3 tests).

- [ ] **Step 6: Consume in `server.ts` (anchored, :1443–1580):** introduce `const driveConfig = loadDriveConfig();` near the top of the storage-wiring block. Replace:
  - `:1443–1447` endpoint derivation → `driveConfig.storage.endpoint`.
  - `:1456–1472` `createS3CompatibleStorage({...})` args → build from `driveConfig.storage` (`region`, `bucket`, `credentials`, `serverSideEncryption`, `forcePathStyle`).
  - `:1555–1568` office-preview selection → drive `driveConfig.officePreview` (`url` → `createLibreOfficePreviewClient`; else `localFallback` → `createLocalOfficePreviewConverter` with `timeoutMs` and `chromiumPath`).
  - `HELIX_CHROMIUM_PATH` (:1559) → `driveConfig.chromiumPath`.
  Keep the unrelated non-Drive `process.env` reads in that block (tenant-storage workers, docs PDF renderer) — those migrate under the cross-cutting Task 2.3 Slice B, coordinate but don't scope-creep here. Add only the Drive keys.

- [ ] **Step 7: Fix `inline-body.ts`** — it reads `env.NODE_ENV` via an injected `InlineBodyFallbackEnv = process.env` default. Change the default from `process.env` to a call that pulls from the validated env: keep the injectable signature (tests pass a fake), but change the default argument to `= { NODE_ENV: env().NODE_ENV }`. Import `{ env } from "../../config/env.js"`. The existing `inline-body.test.ts` (injects its own env) stays green.

- [ ] **Step 8: Run** — `pnpm --filter @helix/app typecheck && pnpm --filter @helix/app test -- "drive" "inline-body"` then boot-smoke `pnpm --filter @helix/app build`. Expected: PASS/compiles.

- [ ] **Step 9: Grep sweep** — `grep -n "process.env" apps/helix/src/platform/drive/*.ts` → zero (config/env.ts and test files exempt). Record in commit.

- [ ] **Step 10: Commit**

```bash
git add apps/helix/src/platform/drive/config.ts apps/helix/src/platform/drive/config.test.ts apps/helix/src/config/env.ts apps/helix/src/platform/drive/inline-body.ts apps/helix/src/server.ts
git commit -m "feat(drive): validated drive/config over env module; drop raw process.env (G3)"
```

---

## Phase 3 — Core/IO split (G5)

**Outcome:** pure domain logic leaves `store.ts` for unit-tested `drive/core/*`; `drive-shell.tsx` decomposes into `drive/components/*`. Every touched file targets ≤ 400 LOC.

### Task 3.1: Extract row-mappers to `drive/core/mappers.ts`

**Files:**
- Create: `apps/helix/src/platform/drive/core/mappers.ts`, `apps/helix/src/platform/drive/core/mappers.test.ts`
- Modify: `apps/helix/src/platform/drive/store.ts` — move `mapObjectEntry`, `mapDriveAccessGrant`, `mapVersion`, `mapFolder`, `mapComment`, `mapSearchHit`, `mapPdfFormState`, and the ~30 row→record mappers (`store.ts:2242–2685`) out; import them back.

**Interfaces:**
- Consumes: the `*Row` DB-shape types (co-locate or import them), `JsonObject`, `DrivePreview`; pure — **no `sql`, no I/O**.
- Produces: `mapObjectEntry(row: ObjectRow & { version_number?: number|null }): DriveEntryRecord`, `mapDriveAccessGrant(row: DriveAccessGrantRow): DriveAccessGrantRecord`, etc. — same signatures the store already calls.

- [ ] **Step 1: Write the failing test** — `apps/helix/src/platform/drive/core/mappers.test.ts`. Pick the two highest-value mappers (`mapObjectEntry` — parses `metadata.folder/status/app/starred/preview`; `mapDriveAccessGrant`):

```ts
import { describe, expect, it } from "vitest";
import { mapObjectEntry, mapDriveAccessGrant } from "./mappers.js";

describe("mapObjectEntry", () => {
  it("lifts folder/app/preview out of metadata jsonb into typed fields", () => {
    const entry = mapObjectEntry({
      id: "11111111-1111-4111-8111-111111111111",
      org_id: "o", owner_actor_id: "a", kind: "file",
      storage_key: "drive/o/x/v1/f.pdf", mime_type: "application/pdf",
      byte_size: 10, sha256: "d".repeat(64), classification: "internal",
      metadata: { folder: "44444444-4444-4444-8444-444444444444", app: "docs", starred: true },
      deleted_at: null, created_at: new Date("2026-07-18T00:00:00Z"),
      updated_at: new Date("2026-07-18T00:00:00Z"), version_number: 3,
    } as never);
    expect(entry.type).toBe("file");
    expect(entry.folderId).toBe("44444444-4444-4444-8444-444444444444");
    expect(entry.app).toBe("docs");
    expect(entry.versionNumber).toBe(3);
  });
});

describe("mapDriveAccessGrant", () => {
  it("maps a permissions row to a grant record", () => {
    const grant = mapDriveAccessGrant({
      actor_id: "55555555-5555-4555-8555-555555555555", role: "editor",
      display_name: "Mo", email: "mo@x.io", granted_by_actor_id: null,
      expires_at: null, created_at: new Date("2026-07-18T00:00:00Z"),
      updated_at: new Date("2026-07-18T00:00:00Z"),
    } as never);
    expect(grant.role).toBe("editor");
    expect(grant.displayName).toBe("Mo");
  });
});
```

> Read the real `mapObjectEntry`/`mapDriveAccessGrant` bodies (`store.ts` ~:2242–2685) before writing assertions so the test matches actual field derivation (esp. how `folder`, `status`, `starred`, `preview`, `versionNumber` are pulled from `metadata`).

- [ ] **Step 2: Run to verify it fails** — `pnpm --filter @helix/app test -- drive/core/mappers`. Expected: FAIL (no module).

- [ ] **Step 3: Implement** — **move** (cut, not copy) the mapper functions and their private helpers (`toSqlJson` readers, `numberFromBigIntLike`, `bytesFromDatabase`, `mapPreviewFromMetadata`, etc. that are pure) from `store.ts:2242–2685` into `core/mappers.ts`. Also move the `*Row` interface declarations they depend on (or re-export them). Keep exact bodies — this is a mechanical relocation, not a rewrite.

- [ ] **Step 4: Re-import in `store.ts`** — add `import { mapObjectEntry, mapDriveAccessGrant, mapVersion, mapFolder, mapComment, mapSearchHit, mapPdfFormState /* + row types */ } from "./core/mappers.js";` and delete the moved definitions. The call sites (`store.ts:782`, `:862`, `:963`, `:1020`, `:1050`, etc.) are unchanged.

- [ ] **Step 5: Run** — `pnpm --filter @helix/app test -- drive` and `pnpm --filter @helix/app typecheck`. Expected: PASS (behavior identical; the existing `store.test.ts`/`store-query-shape.test.ts` are the regression net). Record new `store.ts` LOC (target: dropped by ~440).

- [ ] **Step 6: Commit** `refactor(drive): extract pure row-mappers to core/mappers (G5)`.

### Task 3.2: Extract storage-key derivation + validation to `drive/core/storage-key.ts`

**Files:**
- Create: `apps/helix/src/platform/drive/core/storage-key.ts`, `apps/helix/src/platform/drive/core/storage-key.test.ts`
- Modify: `store.ts` — move `driveStorageKey` (:2468) and `assertProvidedFinalizeStorageKey` (:2478).

**Interfaces:**
- Produces: `driveStorageKey(orgId: string, objectId: string, versionNumber: number, name: string): string` and `assertFinalizeStorageKey(provided: string, current: string): void` (renamed from `assertProvidedFinalizeStorageKey`; throws `DriveInvalidStorageKeyError`).

- [ ] **Step 1: Write the failing test** — `core/storage-key.test.ts`

```ts
import { describe, expect, it } from "vitest";
import { driveStorageKey, assertFinalizeStorageKey } from "./storage-key.js";
import { DriveInvalidStorageKeyError } from "../errors.js";

describe("driveStorageKey", () => {
  it("builds the versioned key with a sanitized name", () => {
    expect(driveStorageKey("org1", "obj1", 1, "Q3 Report/../x.pdf"))
      .toBe("drive/org1/obj1/v1/Q3_Report_.._x.pdf");
  });
  it("falls back to 'upload' when the name sanitizes to empty", () => {
    expect(driveStorageKey("o", "x", 2, "///")).toBe("drive/o/x/v2/upload");
  });
});

describe("assertFinalizeStorageKey", () => {
  it("accepts the exact reserved key", () => {
    expect(() => assertFinalizeStorageKey("drive/o/x/v1/f", "drive/o/x/v1/f")).not.toThrow();
  });
  it("rejects a traversal / mismatched key", () => {
    expect(() => assertFinalizeStorageKey("drive/o/../etc/passwd", "drive/o/x/v1/f"))
      .toThrow(DriveInvalidStorageKeyError);
  });
});
```

> Read the real `driveStorageKey` (template `drive/${orgId}/${objectId}/v${n}/${safeName}`, sanitizer `replaceAll(/[^A-Za-z0-9._-]/g, "_").slice(0,180) || "upload"`) and `assertProvidedFinalizeStorageKey` bodies so the expected strings match the actual sanitizer output exactly.

- [ ] **Step 2: Run to verify it fails** — `pnpm --filter @helix/app test -- drive/core/storage-key`. Expected: FAIL.

- [ ] **Step 3: Implement** — move both functions verbatim into `core/storage-key.ts`; change the throw in `assertFinalizeStorageKey` to `DriveInvalidStorageKeyError` (T2.1 already did the class). Export.

- [ ] **Step 4: Re-import in `store.ts`** — `import { driveStorageKey, assertFinalizeStorageKey } from "./core/storage-key.js";`; update the call at :447 (`assertProvidedFinalizeStorageKey(...)` → `assertFinalizeStorageKey(...)`) and :390.

- [ ] **Step 5: Run** — `pnpm --filter @helix/app test -- drive`. Expected: PASS.

- [ ] **Step 6: Commit** `refactor(drive): extract storage-key derivation/validation to core (G5)`.

### Task 3.3: Extract quota math + mention parsing to `drive/core/`

**Files:**
- Create: `apps/helix/src/platform/drive/core/quota.ts` (+ `.test.ts`), `apps/helix/src/platform/drive/core/mentions.ts` (+ `.test.ts`)
- Modify: `store.ts` — move the pure quota projection out of `assertStorageQuotaAvailable` (:~1810) and the mention-parsing block (`store.ts:2143–2231`).

**Interfaces:**
- Produces (quota.ts): `projectQuota(input: { usedBytes: number; limitBytes: number; byteDelta: number }): { projectedBytes: number; exceeded: boolean }` and `distinctStoredBytes(rows: readonly { storageKey: string; byteSize: number }[]): number` (dedupes by key — already exists in store). The **`sql` reads stay in the store**; only the arithmetic moves.
- Produces (mentions.ts): `parseMentions(body: string): readonly string[]` (extract `@actorRef` tokens) and whatever normalization the comment path uses.

- [ ] **Step 1 (quota): Write the failing test** — `core/quota.test.ts`

```ts
import { describe, expect, it } from "vitest";
import { distinctStoredBytes, projectQuota } from "./quota.js";

describe("projectQuota", () => {
  it("flags exceeded when used + delta crosses the limit", () => {
    expect(projectQuota({ usedBytes: 90, limitBytes: 100, byteDelta: 20 }))
      .toEqual({ projectedBytes: 110, exceeded: true });
  });
  it("stays within budget at the boundary", () => {
    expect(projectQuota({ usedBytes: 80, limitBytes: 100, byteDelta: 20 }).exceeded).toBe(false);
  });
});

describe("distinctStoredBytes", () => {
  it("counts each storage key once", () => {
    expect(distinctStoredBytes([
      { storageKey: "k1", byteSize: 10 }, { storageKey: "k1", byteSize: 10 }, { storageKey: "k2", byteSize: 5 },
    ])).toBe(15);
  });
});
```

- [ ] **Step 2: Run** → FAIL (`pnpm --filter @helix/app test -- drive/core/quota`).
- [ ] **Step 3: Implement** — move `distinctStoredBytes` (currently private in store) and factor the projection arithmetic out of `assertStorageQuotaAvailable` into `projectQuota`. Rewire `assertStorageQuotaAvailable` (:1810) to: read `storage_used_bytes` (SQL, stays), call `projectQuota`, and on `exceeded` fire `onExceeded?.(...)` + `throw new DriveQuotaExceededError(...)`.
- [ ] **Step 4 (mentions): Write the failing test** — `core/mentions.test.ts` asserting `parseMentions("hi @maya and @leo!")` → `["maya","leo"]` (match the real token grammar in `store.ts:2143–2231` — read it first).
- [ ] **Step 5: Run** → FAIL. **Implement** — move the parser; re-import in the comment-create path.
- [ ] **Step 6: Run** — `pnpm --filter @helix/app test -- drive`. Expected: PASS. Record `store.ts` LOC.
- [ ] **Step 7: Commit** `refactor(drive): extract quota math + mention parsing to core (G5)`.

> After T3.1–T3.3, `store.ts` should be well under its original 2,793 LOC. If still > 400, add a `// ponytail:` note at the top naming the remaining IO-adapter responsibilities and the follow-up split (comments store, pdf-form store) — do not force a further split in this plan.

### Task 3.4: Decompose `drive-shell.tsx` into `drive/components/*`

**Files:**
- Create: `apps/web/src/features/drive/components/{DriveSidebar,DriveBreadcrumb,DriveMain,DriveFileCard,DriveFileRow,DriveDetailsPanel,AccessList}.tsx` (+ co-located `.test.tsx` for the two with logic: `DriveDetailsPanel`, `AccessList`)
- Create: `apps/web/src/features/drive/drive-shell-context.tsx` (a context/hook hoisting the prop-drilled state)
- Modify: `apps/web/src/features/drive/drive-shell.tsx` — import the extracted components; drop from 2,390 → ≤ 400 LOC (orchestration only).

**Interfaces:**
- Produces: `DriveShellProvider` + `useDriveShell()` exposing `{ entries, selection, currentFolderId, viewPreference, actions: { move, trash, restore, share, rename, star } }`; presentational components consume the hook instead of ~20 drilled props.

- [ ] **Step 1: Write the failing test first for the highest-logic extraction** — `components/AccessList.test.tsx` (render an access list, assert role labels + the "remove" affordance calls the injected handler). Model it on the existing `drive-shell.test.tsx` render helpers (reuse its test-utils import).

```tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AccessList } from "./AccessList";

it("renders grants and fires onRemove", async () => {
  const onRemove = vi.fn();
  render(<AccessList grants={[{ actorId: "a1", role: "editor", displayName: "Mo",
    grantedByActorId: null, expiresAt: null, createdAt: "", updatedAt: "" }]} onRemove={onRemove} canManage />);
  await userEvent.click(screen.getByRole("button", { name: /remove/i }));
  expect(onRemove).toHaveBeenCalledWith("a1");
});
```

- [ ] **Step 2: Run** → FAIL (`pnpm --filter @helix/web test -- drive/components/AccessList`).

- [ ] **Step 3: Implement the extraction in slices** (one component per commit is acceptable; keep the shell green between slices):
  1. Create `drive-shell-context.tsx` with the provider/hook wrapping the state currently held at the top of `drive-shell.tsx`.
  2. Cut each sub-component's JSX + local logic from `drive-shell.tsx` into its own file under `components/`, replacing drilled props with `useDriveShell()` where the value is shell-global; keep genuinely-local props (e.g. `entry` for a card) as props.
  3. In `drive-shell.tsx`, wrap the tree in `<DriveShellProvider>` and render the extracted components.
  Move (don't rewrite) the share-target parsing + editor-routing helpers into `drive-data.ts` (already the home for pure drive helpers) or a new `drive/components/routing.ts`.

- [ ] **Step 4: Run** — `pnpm --filter @helix/web test -- drive` (the large `drive-shell.test.tsx`, 1,288 lines, is the regression net) and `pnpm --filter @helix/web typecheck`. Expected: PASS unchanged. If `drive-shell.test.tsx` reaches into internals that moved, update its imports to the new component paths.

- [ ] **Step 5: Verify LOC** — `wc -l apps/web/src/features/drive/components/*.tsx apps/web/src/features/drive/drive-shell.tsx`; each ≤ 400, or a `// ponytail:` note. `file-thumbnail.tsx` (924) is out of scope here — add a `// ponytail: 924 LOC thumbnail matrix; split tracked separately` note if not split.

- [ ] **Step 6: Commit** `refactor(web): decompose drive-shell into components + context (G5/G9)`.

---

## Phase 4 — Missing capabilities (G8)

**Outcome:** the feature gaps close, each landing first as a `drive.*` tool (so MCP/CLI/OpenAPI inherit it), consumed by the web through contracts. Ordered small→large.

### Task 4.1: First-class `drive.rename` tool

**Files:**
- Modify: `store.ts` (add `rename` method), `tools.ts` (add `drive.rename`), `tool-output-schemas.ts` (add `driveRenameOutputSchema = driveEntryOrNullOutputSchema`), `packages/contracts/src/drive.ts` (add `driveRenameInputSchema`), `apps/web/.../drive/api.ts` (`renameDriveObject`).
- Test: `store.test.ts`, `tools.test.ts`, `api.test.ts`.

**Interfaces:**
- Produces: `store.rename(input: { orgId; actorId; objectId; name: string }): Promise<DriveEntryRecord | null>` (gated `requireObjectRole(..., "editor")`); tool `drive.rename` (`permission: "drive.write"`, `sideEffects: "write"`, input `{ objectId, name }`).

- [ ] **Step 1: Write the failing tests** — `store.test.ts`: an editor renames and the entry name changes; a reader gets 403. `tools.test.ts`: `drive.rename` output validates against `driveEntryOrNullOutputSchema`.

```ts
it("renames a file for an editor and rejects a reader", async () => {
  const { store, editorId, readerId, objectId } = await seedSharedObject({ role: "editor" });
  const renamed = await store.rename({ orgId: ORG, actorId: editorId, objectId, name: "new.pdf" });
  expect(renamed?.name).toBe("new.pdf");
  const r = await seedSharedObject({ role: "reader" });
  await expect(r.store.rename({ orgId: ORG, actorId: r.readerId, objectId: r.objectId, name: "x" }))
    .rejects.toMatchObject({ code: "forbidden" });
});
```

- [ ] **Step 2: Run** → FAIL (`pnpm --filter @helix/app test -- drive/store`).

- [ ] **Step 3: Implement `store.rename`** — mirror `setStarred` (:990) structure but gate on `requireObjectRole(tx, ..., "editor")` and `update objects set metadata = metadata || jsonb_build_object('name', ...)` **or** the dedicated name column — read how the current `name` is stored (`objects` has no `name` column; the display name lives in `metadata` — confirm via `mapObjectEntry`). Set `metadata = metadata || ${tx.json(toSqlJson({ name: input.name }))}::jsonb`, `updated_at = now()`, return `mapObjectEntry(row)`; append `drive.object.renamed` activity.

- [ ] **Step 4: Add the tool** — in `tools.ts`, define `renameSchema = z.object({ objectId: uuidSchema, name: z.string().min(1).max(255) })` and a `defineTool` `drive.rename` calling `store.rename`, `outputSchema: zodToolSchema(driveEntryOrNullOutputSchema, genericObjectJsonSchema)`.

- [ ] **Step 5: Wire the web** — add `renameDriveObject(objectId, name, fetchImpl?)` in `api.ts` calling `callDriveTool<DriveApiEntry | null>("drive.rename", { objectId, name })`; wire the shell's rename affordance (currently client-only) to it.

- [ ] **Step 6: Run** — `pnpm --filter @helix/app test -- drive` && `pnpm --filter @helix/web test -- drive`. Expected: PASS.

- [ ] **Step 7: Commit** `feat(drive): first-class drive.rename tool + store method (G8)`.

### Task 4.2: Version history — `drive.versions.list` / `drive.versions.revert`

**Files:**
- Modify: `store.ts` (add `listVersions`, `revertToVersion`), `tools.ts` (2 tools), `tool-output-schemas.ts`, `packages/contracts/src/drive.ts` (input schemas), `apps/web/.../drive/api.ts` + `drive/components/DriveDetailsPanel.tsx` (versions section).
- Test: `store.test.ts`, `tools.test.ts`.

**Interfaces:**
- Produces: `store.listVersions(input: { orgId; actorId; objectId }): Promise<readonly DriveVersionRecord[]>` (gated `requireObjectRole(..., "reader")`); `store.revertToVersion(input: { orgId; actorId; objectId; versionNumber: number }): Promise<DriveVersionRecord>` (gated `"editor"`; writes a **new** version whose bytes/sha/storageKey copy the target version — never mutates history). Tools `drive.versions.list` / `drive.versions.revert`.

- [ ] **Step 1: Write the failing tests** — list returns versions newest-first; revert creates version N+1 copying version K's `storage_key`/`sha256`/`byte_size`; reader revert → 403.

- [ ] **Step 2: Run** → FAIL.

- [ ] **Step 3: Implement** — `listVersions`: `select * from drive_versions where org_id=.. and object_id=.. order by version_number desc` after `requireObjectRole(..., "reader")`, map via `mapVersion`. `revertToVersion`: in a `begin`, `requireObjectRole(tx, ..., "editor")`, read target version row (404 `DriveNotFoundError` if absent), read current `max(version_number)`, `insert into drive_versions (..., version_number = max+1, storage_key = <target.storage_key>, sha256, byte_size, mime_type, created_by_actor_id)`, update `objects` current pointer/metadata + `updated_at`, append `drive.version.reverted` activity, return the new version. (Storage bytes are reused by key — no re-upload; if content-addressing from T4.9 is merged, refcount++.)

- [ ] **Step 4: Add tools** — `drive.versions.list` (`permission: "drive.read"`, output `z.object({ versions: driveVersionSchema.array() })`) and `drive.versions.revert` (`permission: "drive.write"`, `confirmationRequired: true`, output `driveVersionSchema`).

- [ ] **Step 5: Wire the web** — `listDriveVersions(objectId)` + `revertDriveVersion(objectId, versionNumber)` in `api.ts`; render a "Version history" section in `DriveDetailsPanel.tsx` with a revert button.

- [ ] **Step 6: Run** — `pnpm --filter @helix/app test -- drive` && `pnpm --filter @helix/web test -- drive`. Expected: PASS.

- [ ] **Step 7: Commit** `feat(drive): version history list + revert tools and details-panel UX (G8)`.

### Task 4.3: Server-side MIME sniffing + pluggable AV hook

**Files:**
- Create: `apps/helix/src/platform/drive/scanning.ts` (+ `.test.ts`)
- Modify: `store.ts` `finalizeUpload` (:441) — sniff magic bytes, run scanner, quarantine.
- Modify: `server.ts` (:1569) — inject a `virusScanner` (no-op default from config).

**Interfaces:**
- Produces: `sniffMimeType(bytes: Buffer): string | null` (magic-byte table for pdf/png/jpeg/gif/zip-family(docx/xlsx/pptx)/mp4/webm/svg-heuristic); `interface VirusScanner { scan(bytes: Buffer): Promise<{ readonly clean: boolean; readonly signature?: string }>; }`; `createNoopVirusScanner(): VirusScanner`; and a `resolveEffectiveMime(clientMime: string, sniffed: string | null): string` policy (trust sniff for disposition/preview when it disagrees with the client on a security-relevant type).

- [ ] **Step 1: Write the failing test** — `scanning.test.ts`

```ts
import { describe, expect, it } from "vitest";
import { sniffMimeType, resolveEffectiveMime, createNoopVirusScanner } from "./scanning.js";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const PDF = Buffer.from("%PDF-1.7\n...", "utf8");

describe("sniffMimeType", () => {
  it("detects PNG and PDF by magic bytes", () => {
    expect(sniffMimeType(PNG)).toBe("image/png");
    expect(sniffMimeType(PDF)).toBe("application/pdf");
  });
  it("returns null for unrecognized bytes", () => {
    expect(sniffMimeType(Buffer.from("just text"))).toBeNull();
  });
});

describe("resolveEffectiveMime", () => {
  it("overrides a client mime that lies about an executable-ish type", () => {
    // client claims image/png but bytes are a PDF → trust the sniff
    expect(resolveEffectiveMime("image/png", "application/pdf")).toBe("application/pdf");
  });
  it("keeps the client mime when the sniff is inconclusive", () => {
    expect(resolveEffectiveMime("text/csv", null)).toBe("text/csv");
  });
});

it("noop scanner reports clean", async () => {
  expect(await createNoopVirusScanner().scan(PNG)).toEqual({ clean: true });
});
```

- [ ] **Step 2: Run** → FAIL (`pnpm --filter @helix/app test -- drive/scanning`).

- [ ] **Step 3: Implement `scanning.ts`** — magic-byte prefix table + heuristics; `resolveEffectiveMime` policy; `createNoopVirusScanner`. Keep ≤ 400 LOC.

- [ ] **Step 4: Wire into `finalizeUpload` (store.ts:441, anchored):** after the content buffer is available (presigned path reads back, or inline `content` branch) and before writing the version row: `const sniffed = sniffMimeType(content); const effectiveMime = resolveEffectiveMime(input.mimeType ?? current.mime_type, sniffed);` use `effectiveMime` for the version's `mime_type`. Then `const scan = await this.virusScanner.scan(content); if (!scan.clean) { update objects set metadata = metadata || {status:'infected', avSignature: scan.signature}; throw new DriveConflictError("File failed virus scan.", { details: { signature } }); }`. Add `virusScanner: VirusScanner` to the store constructor deps (default `createNoopVirusScanner()`).

> The presigned path uploads bytes direct to storage (server never sees them at prepare-time). Sniff/scan at **finalize** by reading the object back from storage (`this.readObjectBytes(orgId, storageKey)`), which finalize already does for preview generation — reuse that read. Note the tradeoff in a `// ponytail:` comment: sniff/scan happens post-PUT, so quarantine marks metadata rather than blocking the write.

- [ ] **Step 5: Inject in `server.ts`** — add `virusScanner` to the `PostgresDriveStore` options (:1569). Default no-op; a ClamAV impl is a follow-up (leave a `createClamAvVirusScanner` stub file with a `// ponytail:` note, not wired).

- [ ] **Step 6: Run** — `pnpm --filter @helix/app test -- drive`. Expected: PASS.

- [ ] **Step 7: Commit** `feat(drive): server-side MIME sniff + pluggable AV quarantine hook`.

### Task 4.4: Public/anonymous share links

**Files:**
- Create: migration `apps/helix/src/db/migrations/0065_drive_share_links.sql`; register `driveShareLinks` in `db/schema.ts`.
- Modify: `store.ts` (`createShareLink`, `revokeShareLink`, `listShareLinks`, `resolveShareLink`), `tools.ts` (`drive.link.create`/`.revoke`/`.list`), `server.ts` (unauthenticated `GET /api/drive/share/:token`), `packages/contracts/src/drive.ts` (`driveShareLinkSchema`), `apps/web/.../drive/drive-share-dialog.tsx:107` (Copy link → real public URL).
- Test: `store.test.ts`, `tools.test.ts`, share-dialog test, a route test for the token resolver.

**Interfaces:**
- Produces: table `drive_share_links (id uuid pk, org_id uuid, token text unique, object_id uuid → objects on delete cascade, role text, expires_at timestamptz, created_by_actor_id uuid, created_at, revoked_at)`; `store.createShareLink(input: { orgId; actorId; objectId; role: DriveRole; expiresAt?: Date|null }): Promise<DriveShareLinkRecord>` (gated `requireObjectRole(..., "owner")`, token = 32-byte base64url from `crypto.randomBytes`, role normalized, capped at `editor` for anonymous — no `owner` links); `store.resolveShareLink(token): Promise<{ orgId; objectId; role } | null>` (checks `revoked_at is null and (expires_at is null or > now())`).

- [ ] **Step 1: Write the migration + schema** — `0065_drive_share_links.sql`:

```sql
create table if not exists drive_share_links (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  token text not null unique,
  object_id uuid not null references objects(id) on delete cascade,
  role text not null default 'reader' check (role in ('reader','commenter','editor')),
  expires_at timestamptz,
  created_by_actor_id uuid references actors(id) on delete set null,
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);
create index if not exists drive_share_links_object_idx on drive_share_links (org_id, object_id) where revoked_at is null;
```

Register `driveShareLinks` in `schema.ts` (mirror columns; `token` unique index).

- [ ] **Step 2: Write the failing tests** — `store.test.ts`: owner creates a link, `resolveShareLink(token)` returns `{ objectId, role }`; expired/revoked link resolves `null`; a reader creating a link → 403; anonymous `owner` role is rejected/downgraded. A route test: `GET /api/drive/share/<token>` streams bytes (200/206) with no session; unknown token → 404.

- [ ] **Step 3: Run** → FAIL.

- [ ] **Step 4: Implement** the store methods + tools (`drive.link.create` output `driveShareLinkSchema`, `confirmationRequired: true`; `.revoke`; `.list`), and the **unauthenticated** resolver route in `server.ts`: look up the token, load the object via a system-actor read (bypasses per-user ACL because the link *is* the grant), enforce `expires_at`/`revoked_at`, then reuse `sendBytesWithRangeSupport`. Cap anonymous role: `resolveShareLink` never returns `owner`; `createShareLink` rejects `owner` with `DriveInvalidStorageKeyError`/`BadRequestError`.

- [ ] **Step 5: Wire the web** — `createDriveShareLink(objectId, role, expiresAt?)` in `api.ts`; in `drive-share-dialog.tsx:107` (the "Copy link" handler that currently copies the in-app URL), call it and copy the returned `${origin}/api/drive/share/${token}` public URL.

- [ ] **Step 6: Run migration + tests** — `pnpm --filter @helix/app db:migrate` (against the test DB) then `pnpm --filter @helix/app test -- drive` && `pnpm --filter @helix/web test -- drive-share-dialog`. Expected: PASS.

- [ ] **Step 7: Commit** `feat(drive): public share links (tool + anonymous resolver + copy-link UX)`.

### Task 4.5: Resumable/chunked (S3 multipart) upload

**Files:**
- Modify: `apps/helix/src/platform/storage/s3-compatible.ts` (extend `S3CompatibleStorageClient` with multipart methods), its test.
- Modify: `store.ts` `prepareUpload` (:380) — return part URLs for large files; add `completeMultipartUpload` finalize path.
- Modify: `tools.ts` (`drive.upload.parts.sign`, `drive.upload.complete` or extend `drive.upload`/`drive.finalize`), `packages/contracts/src/drive.ts`.
- Modify: `apps/web/.../drive/api.ts` (`uploadDriveFile` chunked path replacing whole-file `arrayBuffer()`/base64).
- Test: storage test, `store.test.ts`, `tools.test.ts`, `api.test.ts`.

**Interfaces:**
- Produces (storage): `createMultipartUpload(key, opts?): Promise<{ uploadId: string }>`, `presignUploadPart(key, uploadId, partNumber, opts?): Promise<string>`, `completeMultipartUpload(key, uploadId, parts: { partNumber: number; etag: string }[]): Promise<void>`, `abortMultipartUpload(key, uploadId): Promise<void>` — implemented with the existing SigV4 signer in `s3-compatible.ts`.
- Produces (store): `prepareUpload` returns, when `byteSize > MULTIPART_THRESHOLD` (e.g. 8 MiB from `driveConfig`), `{ ...record, multipart: { uploadId, partSize, partUrls: string[] } }`; `completeUpload(input)` calls `completeMultipartUpload` then the normal version-write.

- [ ] **Step 1: Write the failing storage test** — mock `fetch`, assert `createMultipartUpload` POSTs `?uploads`, `presignUploadPart` signs `?partNumber=N&uploadId=..`, `completeMultipartUpload` POSTs the XML `CompleteMultipartUpload` body. (Follow the existing `s3-compatible` test's fetch-mock style.)

- [ ] **Step 2: Run** → FAIL (`pnpm --filter @helix/app test -- s3-compatible`).

- [ ] **Step 3: Implement** the four methods on `FetchS3CompatibleStorageClient` reusing `#signedRequest`/presign internals. Add to the `S3CompatibleStorageClient` interface.

- [ ] **Step 4: Store + tools** — `prepareUpload` branches on size; add `drive.upload.complete` tool (input `{ objectId, uploadId, parts, byteSize, sha256, mimeType? }`) → `store.completeUpload`. Keep the small-file presigned-PUT path unchanged.

- [ ] **Step 5: Web chunked uploader** — in `uploadDriveFile` (`api.ts:175`), when `prepared.multipart` is present, slice the `File` into `partSize` blobs, `PUT` each to its part URL (bounded concurrency, collect ETags), then call `drive.upload.complete`. Fall back to the existing single-PUT/base64 path when `multipart` is absent. This removes the whole-file `arrayBuffer()` for large files (memory-DoS mitigation).

- [ ] **Step 6: Run** — `pnpm --filter @helix/app test -- "s3-compatible" "drive"` && `pnpm --filter @helix/web test -- drive/api`. Expected: PASS.

- [ ] **Step 7: Commit** `feat(drive): resumable S3 multipart upload (storage + tool + chunked web uploader)`.

### Task 4.6: Content-addressed dedup

**Files:**
- Create: migration `0066_drive_blobs.sql`; register `driveBlobs` in `schema.ts`.
- Modify: `core/storage-key.ts` (add `driveBlobKey(orgId, sha256): string`), `store.ts` `finalizeUpload`/`completeUpload`/`delete`/`revertToVersion` (refcount).
- Test: `core/storage-key.test.ts`, `store.test.ts`.

**Interfaces:**
- Produces: table `drive_blobs (org_id uuid, sha256 text, storage_key text, byte_size bigint, refcount int, primary key(org_id, sha256))`; `driveBlobKey(orgId, sha256) = drive/${orgId}/blobs/${sha256}`; finalize short-circuits: if `(org_id, sha256)` blob exists, skip the storage write, `refcount++`, and point the version at the existing `storage_key`; `delete`/version-drop `refcount--` and delete the blob at zero.

- [ ] **Step 1: Write the failing tests** — `store.test.ts`: uploading identical bytes twice into one org writes storage once and yields `refcount = 2`; deleting one keeps the blob (refcount 1); deleting the last removes it. `core/storage-key.test.ts`: `driveBlobKey("o", "ab..")` → `drive/o/blobs/ab..`.

- [ ] **Step 2: Run** → FAIL.

- [ ] **Step 3: Implement** — new blob key + `drive_blobs` upsert in a `begin`. Gate the whole feature behind `driveConfig` flag `contentAddressedDedup` (default off) so it can ship dark: when off, keep the current `driveStorageKey` per-version path. When on, finalize resolves the blob key, `insert ... on conflict (org_id, sha256) do update set refcount = drive_blobs.refcount + 1`, and only PUTs bytes when the insert (not the update) created the row.

> This changes the storage-key contract (`drive/${orgId}/${objectId}/v${n}/...` → `drive/${orgId}/blobs/${sha256}`). Keep `assertFinalizeStorageKey` valid for **both** shapes (the presigned path still reserves a per-object key at prepare-time when dedup is off). Document the two-mode behavior in a header comment.

- [ ] **Step 4: Run** — `pnpm --filter @helix/app test -- drive`. Expected: PASS (both modes).

- [ ] **Step 5: Commit** `feat(drive): content-addressed blob dedup with refcounts (flagged)`.

---

## Phase 5 — Hardening & tests (G9)

**Outcome:** the untested pure helpers get coverage, WebDAV gains range support, quota moves to preflight, preview gets an SSRF guard, folders become orphan-proof, and cross-app trash sync is decoupled.

### Task 5.1: Range unit tests + WebDAV GET range support

**Files:**
- Create: `apps/helix/src/platform/drive/range-response.test.ts`
- Modify: `apps/helix/src/platform/drive/routes.ts` (WebDAV GET :94 → use `sendBytesWithRangeSupport`).

**Interfaces:**
- Consumes: `parseRangeHeader(header, total)` and `sendBytesWithRangeSupport(opts)` (already exported from `range-response.ts`).

- [ ] **Step 1: Write the failing test** — `range-response.test.ts` (the pure `parseRangeHeader` has zero dedicated coverage today):

```ts
import { describe, expect, it } from "vitest";
import { parseRangeHeader } from "./range-response.js";

describe("parseRangeHeader", () => {
  it("parses bytes=0-99", () => expect(parseRangeHeader("bytes=0-99", 1000)).toEqual({ start: 0, end: 99 }));
  it("parses open-ended bytes=500-", () => expect(parseRangeHeader("bytes=500-", 1000)).toEqual({ start: 500, end: 999 }));
  it("parses suffix bytes=-200", () => expect(parseRangeHeader("bytes=-200", 1000)).toEqual({ start: 800, end: 999 }));
  it("clamps end past total", () => expect(parseRangeHeader("bytes=0-5000", 1000)).toEqual({ start: 0, end: 999 }));
  it("marks multi-range unsupported", () => expect(parseRangeHeader("bytes=0-10,20-30", 1000)).toBe("unsupported"));
  it("marks start>=total invalid", () => expect(parseRangeHeader("bytes=1000-1001", 1000)).toBe("invalid"));
  it("marks total=0 invalid", () => expect(parseRangeHeader("bytes=0-0", 0)).toBe("invalid"));
  it("marks garbage invalid", () => expect(parseRangeHeader("chunks=0-1", 1000)).toBe("invalid"));
});
```

- [ ] **Step 2: Run** → FAIL only if a branch is wrong; if all pass immediately, that's acceptable coverage backfill — but first confirm they run (`pnpm --filter @helix/app test -- range-response`). (Coverage-backfill tests may pass on first run; the deliverable is the coverage + the WebDAV wiring below, which is genuinely TDD.)

- [ ] **Step 3: Write the failing WebDAV test** — in `routes.test.ts`, add: a `GET /dav/files/<path>` with `Range: bytes=0-3` returns 206 + `Content-Range`. Expected: FAIL (WebDAV GET currently returns full bytes/200).

- [ ] **Step 4: Run** → FAIL (`pnpm --filter @helix/app test -- drive/routes`).

- [ ] **Step 5: Implement** — in `routes.ts` GET handler (:94), replace the full-body `reply.send(bytes)` with `return sendBytesWithRangeSupport({ reply, request, bytes, mimeType, disposition })` (import from `./range-response.js`; build `disposition` from the file name as the content endpoint does). Preserve the WebDAV auth/lookup above it.

- [ ] **Step 6: Run** — `pnpm --filter @helix/app test -- "range-response" "drive/routes"`. Expected: PASS.

- [ ] **Step 7: Commit** `test(drive): range-response unit tests + WebDAV GET range support`.

### Task 5.2: Quota preflight in `prepareUpload`

**Files:**
- Modify: `store.ts` `prepareUpload` (:380) — call `assertStorageQuotaAvailable` at prepare-time when `byteSize` is known.
- Test: `store.test.ts` / `store-metering.test.ts`.

**Interfaces:**
- Consumes: `assertStorageQuotaAvailable` (:1810, now delegating to `projectQuota` from T3.3).

- [ ] **Step 1: Write the failing test** — a `prepareUpload` with `byteSize` exceeding the org quota throws `DriveQuotaExceededError` **before** reserving the object row (assert no `objects` row was inserted).

- [ ] **Step 2: Run** → FAIL (currently the quota check only fires at finalize).

- [ ] **Step 3: Implement** — in `prepareUpload` (:380), when `input.byteSize !== undefined`, call `await assertStorageQuotaAvailable(this.sql, input.orgId, input.byteSize, this.onQuotaEvent)` before the `insert into objects`. Keep the finalize-time check (bytes may differ / be unknown at prepare). Document the two-checkpoint model.

- [ ] **Step 4: Run** — `pnpm --filter @helix/app test -- "drive/store" "store-metering"`. Expected: PASS.

- [ ] **Step 5: Commit** `feat(drive): quota preflight at prepareUpload (fail before reserving)`.

### Task 5.3: Preview SSRF allowlist + timeout tests

**Files:**
- Modify: `apps/helix/src/platform/drive/preview.ts` (`createLibreOfficePreviewClient` — validate the office-preview URL against an allowlist; enforce timeout).
- Modify: `config.ts` (add `officePreview.allowedHosts?: string[]` derived from a new env key `HELIX_DRIVE_OFFICE_PREVIEW_ALLOWED_HOSTS`).
- Test: `preview.test.ts`.

**Interfaces:**
- Produces: `assertPreviewUrlAllowed(url: string, allowedHosts: readonly string[]): void` (throws `DriveForbiddenError` for a disallowed/loopback/metadata host); wired into the LibreOffice client's request path.

- [ ] **Step 1: Write the failing test** — `preview.test.ts`:

```ts
import { assertPreviewUrlAllowed } from "./preview.js";
it("rejects a link-local metadata host", () => {
  expect(() => assertPreviewUrlAllowed("http://169.254.169.254/latest/meta-data", ["office.internal"]))
    .toThrow(/forbidden|not allowed/i);
});
it("permits an allowlisted office host", () => {
  expect(() => assertPreviewUrlAllowed("http://office.internal:8080/convert", ["office.internal"])).not.toThrow();
});
it("times out a slow converter", async () => { /* mock fetch that never resolves; assert rejects within timeoutMs */ });
```

- [ ] **Step 2: Run** → FAIL (`pnpm --filter @helix/app test -- drive/preview`).

- [ ] **Step 3: Implement** — `assertPreviewUrlAllowed`: parse URL, reject non-http(s), reject hosts in the loopback/link-local/private-metadata set unless explicitly allowlisted, require the host to be in `allowedHosts` when the list is non-empty. Call it in `createLibreOfficePreviewClient` before every request; ensure the `AbortController` timeout (`timeoutMs`) already present is asserted by the timeout test.

- [ ] **Step 4: Run** — `pnpm --filter @helix/app test -- drive/preview`. Expected: PASS.

- [ ] **Step 5: Commit** `feat(drive): office-preview SSRF allowlist + timeout coverage`.

### Task 5.4: Orphan-proof folders — FK on `parent_folder_id`

**Files:**
- Create: migration `0067_drive_folders_parent_fk.sql`; update `driveFolders` in `schema.ts` to declare the self-ref FK.
- Test: `store.test.ts` (or an integration test) — inserting a folder with a non-existent parent fails.

**Interfaces:** none new — a DB integrity constraint.

- [ ] **Step 1: Write the migration** — `0067_drive_folders_parent_fk.sql`:

```sql
-- Null out any pre-existing orphan pointers so the FK can be added.
update drive_folders f set parent_folder_id = null
 where parent_folder_id is not null
   and not exists (select 1 from drive_folders p where p.id = f.parent_folder_id);

alter table drive_folders
  add constraint drive_folders_parent_fk
  foreign key (parent_folder_id) references drive_folders(id) on delete set null;
```

- [ ] **Step 2: Update `schema.ts`** — give `parentFolderId` the self-ref: `parentFolderId: uuid("parent_folder_id").references((): AnyPgColumn => driveFolders.id, { onDelete: "set null" })` (import `AnyPgColumn` from `drizzle-orm/pg-core`).

- [ ] **Step 3: Write the failing test** — an integration test (real DB via `e2e-drive-flow.test.ts` harness) inserting a folder with a random non-existent `parent_folder_id` expects a FK violation.

- [ ] **Step 4: Run migration + test** — `pnpm --filter @helix/app db:migrate` then the integration test. Expected: PASS (violation raised).

- [ ] **Step 5: Commit** `fix(drive): FK drive_folders.parent_folder_id to prevent orphans`.

### Task 5.5: Decouple cross-app trash sync via a handler registry

**Files:**
- Create: `apps/helix/src/platform/drive/core/trash-sync.ts` (+ `.test.ts`)
- Modify: `store.ts` `syncTargetDeletedAt` (:1962) — replace the hardcoded `app → table` switch with a registered handler map injected into the store.
- Modify: `server.ts` — register the docs/sheets/slides handlers when wiring `PostgresDriveStore`.

**Interfaces:**
- Produces: `type TrashSyncHandler = (input: { sql: SqlLike; orgId: string; objectId: string; deletedAt: Date | null }) => Promise<void>`; `createTrashSyncRegistry(handlers: Record<string, TrashSyncHandler>)` with `run(app, input)`. The store calls `this.trashSync.run(app, {...})` instead of the inline `if (app === "docs") ... else if (app === "sheets") ...` switch.

- [ ] **Step 1: Write the failing test** — `core/trash-sync.test.ts`: a registry with a fake `docs` handler runs it for `app="docs"`; an unregistered app is a no-op; the handler receives the correct `deletedAt` for trash vs restore.

- [ ] **Step 2: Run** → FAIL (`pnpm --filter @helix/app test -- drive/core/trash-sync`).

- [ ] **Step 3: Implement** — the registry in `core/trash-sync.ts`. Refactor `syncTargetDeletedAt` (:1962) to read `app` (unchanged) then `await this.trashSync.run(app, { sql, orgId, objectId, deletedAt })`. Add `trashSync` to the store constructor deps (default: empty registry = today's no-op-for-unknown-app behavior, but now the docs/sheets/slides updates are handlers, not store-internal SQL).

- [ ] **Step 4: Register in `server.ts`** — build the registry with `docs`/`sheets`/`slides` handlers (each does the `update <table> set deleted_at = ..` the switch did) and pass it to `new PostgresDriveStore(...)`. This removes Drive's hardcoded knowledge of `docs_documents`/`sheets`/`slide_decks` (a G7 cross-domain-reach cleanup).

- [ ] **Step 5: Run** — `pnpm --filter @helix/app test -- drive`. Expected: PASS (trash/restore/delete still cascade to editor tables).

- [ ] **Step 6: Commit** `refactor(drive): registry-driven cross-app trash sync (decouple from editor tables)`.

---

## File Structure

**Created (backend):**
- `packages/contracts/src/drive.ts` (+ `.test.ts`) — the Zod single source of truth.
- `apps/helix/src/platform/drive/errors.ts` (+ `.test.ts`), `error-codes.ts` — typed errors.
- `apps/helix/src/platform/drive/config.ts` (+ `.test.ts`) — validated config over `env()`.
- `apps/helix/src/platform/drive/scanning.ts` (+ `.test.ts`) — MIME sniff + AV hook.
- `apps/helix/src/platform/drive/tool-output-schemas.ts` — concrete tool outputs.
- `apps/helix/src/platform/drive/range-response.test.ts` — range unit tests.
- `apps/helix/src/platform/drive/core/roles.ts`, `mappers.ts`, `storage-key.ts`, `quota.ts`, `mentions.ts`, `trash-sync.ts` (+ `.test.ts` each) — pure core.
- `apps/helix/src/db/migrations/0065_drive_share_links.sql`, `0066_drive_blobs.sql`, `0067_drive_folders_parent_fk.sql`.
- `apps/helix/src/db/schema-drive-comments.test.ts`.

**Created (frontend):**
- `apps/web/src/features/drive/drive-shell-context.tsx`.
- `apps/web/src/features/drive/components/{DriveSidebar,DriveBreadcrumb,DriveMain,DriveFileCard,DriveFileRow,DriveDetailsPanel,AccessList}.tsx` (+ tests for `AccessList`, `DriveDetailsPanel`).

**Modified (backend):** `db/schema.ts` (register `driveComments`, `driveShareLinks`, `driveBlobs`, folder FK), `platform/drive/{store,tools,types,routes,preview,inline-body,index}.ts`, `platform/storage/s3-compatible.ts` (multipart), `config/env.ts` (Drive keys), `server.ts` (config consumption, scope guards, typed errors, share-link resolver, store deps).

**Modified (frontend):** `features/drive/{api,drive-shell,drive-share-dialog}.tsx/.ts`.

---

## Self-Review

- [ ] **Spec coverage — all 20 seeds land:** (1) contracts → T1.1/T1.3; (2) output schemas → T1.2; (3) error taxonomy → T0.2 (P0 subset) + T2.1; (4) sharing authz → T0.3; (5) core/IO split → T3.1–T3.3; (6) multipart → T4.5; (7) dedup → T4.6; (8) share links → T4.4; (9) config → T2.2; (10) drive_comments schema → T0.1; (11) MIME/AV → T4.3; (12) drive-shell split → T3.4; (13) versions → T4.2; (14) range tests + WebDAV range → T5.1; (15) scope enforcement → T0.4; (16) rename → T4.1; (17) quota preflight → T5.2; (18) preview SSRF → T5.3; (19) folder FK → T5.4; (20) trash-sync registry → T5.5. Plus the role enum (T0.2) and role vocab normalization (T0.3/T1.1).
- [ ] **Gate coverage:** G1 → T1.1/T1.3; G2 → T1.2; G3 → T2.2; G4 → T0.2+T2.1; G5 → T3.1–T3.4; G6 → T0.2(enum)/T0.3(mutation gating)/T0.4(scope); G7 → T5.5 + Self-Review boundary check; G8 → all of Phase 4; G9 → negative-authz tests in T0.3 + unit tests in every core task + T5.1.
- [ ] **P0 ordering:** Phase 0 (schema drift, privilege escalation, scope enforcement, typed-error foundation) precedes everything and is independently shippable ahead of the cross-cutting merge. The one forward-dependency (Phase 0 `errors.ts`/`roles.ts` are local, then re-parented in T1.1/T2.1) is called out explicitly with the exact converging step.
- [ ] **Placeholder scan:** no "TBD"/"add error handling"/"similar to Task N". Every edit is either full new-file code or a `file:line` + exact-transformation spec. The only `// ponytail:` notes are deliberate ceiling/exception markers (WebDAV plain-text bodies; Drizzle self-ref-FK limitation; post-PUT sniff/scan; `file-thumbnail.tsx` split deferred; residual `store.ts` LOC), each naming what it defers and why.
- [ ] **Type consistency:** `DriveRole`/`DRIVE_ROLES`/`driveRoleRank`/`normalizeDriveRole`/`hasRoleAtLeast`, `requireObjectRole`, `DriveNotFoundError`/`DriveForbiddenError`/`DriveInvalidStorageKeyError`/`DriveConflictError`/`DriveQuotaExceededError`, `driveEntrySchema`/`DriveEntry`, `loadDriveConfig`/`DriveConfig`, `sniffMimeType`/`VirusScanner`, `sendBytesWithRangeSupport`/`parseRangeHeader` are spelled identically across every task that references them. Wire dates are ISO strings in contracts (matching the `serialize*` helpers); DB record types keep `Date`.
- [ ] **Authorization matrix (the crux):** reader → read/list/comment-read only; commenter → + comment-write; editor → + move/trash/restore/rename/version-revert/upload; owner → + share/updateAccess/removeAccess/delete/share-link-create. Content/preview/share-link endpoints additionally gate `drive.read` scope. Every mutating op has ≥1 negative-authz test (T0.3, T4.1, T4.2, T4.4).
- [ ] **No regressions to the working surface:** the existing large suites (`store.test.ts`, `tools.test.ts`, `routes.test.ts`, `drive-shell.test.tsx` 1,288 lines, `api.test.ts` 612 lines, `e2e-drive-flow.test.ts`) are the regression net for every refactor task; each refactor step ends by running them green.

## Execution Handoff

Recommended: **subagent-driven** — one fresh subagent per task, review between tasks. **Phase 0 ships first and independently** (security). Phases 1–3 require the cross-cutting plan's Phases 1–3 merged (contracts, env, ApiError). Phase 4 features are independent of each other after Phase 1; Phase 5 hardening can interleave. Land each phase behind a green `pnpm --filter @helix/app test -- drive` + `pnpm --filter @helix/web test -- drive` before opening the next.
