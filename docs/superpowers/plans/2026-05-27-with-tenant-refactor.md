# `withTenant(orgId)` — structural tenant scoping refactor

> **Goal:** make `orgId` scoping structural (the type system enforces it) instead of opt-in (every store remembers to add `where org_id = $1`). Eliminate an entire class of cross-tenant findings from the master review in one mechanical sweep, and make SOC2 auditors happy.

## The problem in one paragraph

Every cross-tenant finding in the master review (`docs/reviews/REVIEW.md`) has the same shape: a store method that takes an `orgId` parameter but forgets to use it (or accepts a request where `orgId` is missing and defaults to "any"). pgvector, the SMTP receiver, chat-permission subqueries, calendar RSVP, Drive share-target, app-password verify — same root cause. Adding a SOC2-grade audit requires demonstrating that tenant isolation is **structural**, not "we'll grep every PR." The compiler should refuse to compile a query that has no tenant.

## Architecture

A `TenantHandle` is a tiny wrapper around the postgres client that carries an `orgId`. Every store accepts `TenantHandle`, not raw `postgres.Sql`. Queries inside a store always interpolate `handle.orgId`. The handle is opaque: you can't pull the underlying `Sql` out and bypass.

```ts
// packages/sdk/src/db-tenant-scoped.ts
export type OrgId = string & { __brand: "OrgId" };

export class TenantHandle {
  // private constructor — only `withTenant` makes them
  private constructor(
    private readonly sql: postgres.Sql,
    readonly orgId: OrgId,
  ) {}

  static for(sql: postgres.Sql, orgId: string): TenantHandle {
    return new TenantHandle(sql, brandOrgId(orgId));
  }

  /** The only way to issue SQL through this handle. The first param of every
   *  query MUST be a string that includes `org_id`. Linted at runtime in dev. */
  query<T>(strings: TemplateStringsArray, ...values: unknown[]): postgres.PendingQuery<T> {
    const flat = strings.join("?").toLowerCase();
    if (!flat.includes("org_id")) {
      throw new TenantQueryWithoutOrgIdError(flat);
    }
    return this.sql(strings, ...values);
  }

  transaction<T>(callback: (tx: TenantHandle) => Promise<T>): Promise<T> {
    return this.sql.begin((tx) => callback(new TenantHandle(tx, this.orgId)));
  }
}

export class SystemHandle {
  /** Cross-tenant / maintenance reads. EVERY use must be audited. */
  private constructor(private readonly sql: postgres.Sql) {}
  static unsafe(sql: postgres.Sql): SystemHandle { return new SystemHandle(sql); }
  raw(): postgres.Sql { return this.sql; }
}

export async function withTenant<T>(
  sql: postgres.Sql,
  orgId: string,
  callback: (handle: TenantHandle) => Promise<T>,
): Promise<T> {
  return callback(TenantHandle.for(sql, orgId));
}
```

Two handle types only: `TenantHandle` (95% of code) and `SystemHandle` (the system actor — provisioning, cross-tenant audit shipping, hard-delete worker). System code holds `SystemHandle` and must call `.raw()` explicitly — that's a grep-able audit trail.

## File structure

- `packages/sdk/src/db-tenant-scoped.ts` — new. The handles + `withTenant` + error types.
- `packages/sdk/tests/db-tenant-scoped.test.ts` — new. Cover the runtime guard, transaction propagation, brand checks.
- `apps/helix/src/db/client.ts` — modify. Export a `withTenantFromRequest(req, callback)` helper that pulls `actor.orgId` from the authenticated request and opens a handle.
- `eslint-rules/no-raw-db.ts` — new. ESLint rule: forbids `import postgres from "postgres"` in any file under `apps/helix/src/platform/`. Only `packages/sdk/src/db-tenant-scoped.ts` and `apps/helix/src/db/` are allowed. Plus blocks `db.query` calls outside those files.
- `eslint-rules/no-system-handle-unsafe.ts` — new. Flags `SystemHandle.unsafe(...)` calls as warnings — every use must be audited.

Then mechanically:
- Every store under `apps/helix/src/platform/*` changes its constructor signature from `(sql: postgres.Sql)` to `(handle: TenantHandle)`, and changes every `this.sql` call to `this.handle.query`.
- Every route handler calls `withTenantFromRequest(req, (handle) => ...)` and passes the handle to the store, instead of mutating a globally-bound store.

## Bite-sized tasks

### Task 1: build the handle + tests

**Files:**
- Create: `packages/sdk/src/db-tenant-scoped.ts`
- Test: `packages/sdk/tests/db-tenant-scoped.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import postgres from "postgres";
import {
  TenantHandle,
  TenantQueryWithoutOrgIdError,
  withTenant,
} from "../src/db-tenant-scoped.js";

describe("TenantHandle", () => {
  const fakeSql = ((strings: TemplateStringsArray) => ({
    __query: strings.join("?"),
  })) as unknown as postgres.Sql;

  it("rejects a query that does not mention org_id", async () => {
    await withTenant(fakeSql, "org-a", async (handle) => {
      expect(() => handle.query`select 1 from messages where id = ${1}`).toThrow(
        TenantQueryWithoutOrgIdError,
      );
    });
  });

  it("passes through a query that scopes by org_id", async () => {
    await withTenant(fakeSql, "org-a", async (handle) => {
      const result = handle.query`select 1 from messages where org_id = ${"org-a"}`;
      expect((result as unknown as { __query: string }).__query).toContain("org_id");
    });
  });

  it("transaction handles inherit the same orgId", async () => {
    const begin = (cb: (tx: unknown) => Promise<unknown>) => cb(fakeSql);
    const sql = Object.assign(fakeSql, { begin });
    await withTenant(sql as unknown as postgres.Sql, "org-a", async (handle) => {
      await handle.transaction(async (tx) => {
        expect(tx.orgId).toBe("org-a");
      });
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails** — `pnpm vitest run packages/sdk/tests/db-tenant-scoped.test.ts` → fails (module not found).

- [ ] **Step 3: Implement the handle** — copy the snippet at the top of this plan into `packages/sdk/src/db-tenant-scoped.ts`.

- [ ] **Step 4: Re-run the test** — should pass.

- [ ] **Step 5: Commit** — `feat(sdk): add TenantHandle for structural org_id scoping`

### Task 2: lint rule blocking raw `postgres` imports

**Files:**
- Create: `eslint-rules/no-raw-db.ts`
- Modify: `eslint.config.mjs` (or wherever the project rules live)

- [ ] **Step 1: Write the failing test** — a small fixture file under `eslint-rules/__fixtures__/raw-db-bad.ts` that imports `postgres`. Assert the rule flags it.

- [ ] **Step 2: Implement the rule** — `noFilePathMatch: /apps\/helix\/src\/platform\//` + report on `ImportDeclaration[source.value="postgres"]`.

- [ ] **Step 3: Run lint** — `pnpm lint apps/helix/src/platform/` → expect many errors (every existing store), but the rule fires correctly.

- [ ] **Step 4: Commit.**

### Task 3: refactor stores one platform at a time

For each `apps/helix/src/platform/<area>/store.ts`:

- [ ] Change constructor from `constructor(sql: postgres.Sql)` to `constructor(handle: TenantHandle)`.
- [ ] Replace every `this.sql<…>\`…\`` with `this.handle.query<…>\`…\``.
- [ ] For every query, audit: does it mention `org_id`? If not, fix the query to add the predicate (this is the security fix — the type system is showing you the gap).
- [ ] Update the area's route registration to call `withTenantFromRequest(req, (handle) => new XxxStore(handle))`.
- [ ] Run the area's vitest suite. Most existing tests pass because the underlying SQL barely changed.

**Order to do them in** — start with the areas where the review found the most missing-org_id bugs:
1. `chat/store.ts` (review C4 + C15 missed org_id in 3 subqueries)
2. `calendar/store.ts` (review CAL12 token branch missed orgId)
3. `drive/store.ts` (review S5 share-target missed cross-org actor validation)
4. `mail/store.ts` (review S2 routes by env, S6 paginated count wrong scope)
5. `ai/memory/postgres.ts` (review A1 + the work we just did for vector)
6. `docs/store.ts`
7. `sheets/store.ts`
8. `slides/store.ts`
9. `meet/store.ts`

Each is one commit.

### Task 4: lock the door

- [ ] Make the runtime check in `TenantHandle.query` a hard throw in test mode AND in dev. In prod, also throw but log to audit first so it surfaces.
- [ ] Add a CI step that grep-fails any file under `apps/helix/src/platform/` matching `import postgres` — defense against the lint rule getting disabled in PR review.
- [ ] Add a CI step that grep-fails any new `SystemHandle.unsafe(` call — must be added to an allowlist file with a reason.

### Task 5: docs + auditor demo

- [ ] Add `docs/architecture/tenant-isolation.md` explaining the pattern.
- [ ] Add a single demo test under `apps/helix/src/platform/tenancy/cross-tenant-isolation.test.ts` (file already exists from a prior session — extend it) that instantiates two `TenantHandle`s, writes data through one, and confirms the other handle's read returns zero rows. SOC2 evidence in one screenshot.

## What NOT to refactor

- Migrations stay raw `postgres.Sql`. Migrations apply DDL across the tenancy boundary by design.
- Background workers that legitimately need cross-tenant access (hard-delete, audit shipping) hold `SystemHandle`. Each one keeps a one-line comment justifying it. Grep `SystemHandle.unsafe(` in CI prints the audit list.

## How this kills review items

Once Task 3 lands across every platform store, the following review findings disappear without further work because the query would crash on first execution:

- Mail S2, S6, S7 (folder predicates exclude rows, paginated count, hard-coded org routing)
- Chat C4, C15 (`permissions` subqueries missing org_id)
- Calendar CAL8, CAL12 (CalDAV PUT default calendar, RSVP token no org-isolation)
- AI A1 (pgvector — already fixed but the rule prevents regressions)
- Drive S5 (`drive.share` no cross-org actor validation)
- ~12-15 MEDIUM items across various stores.

## Effort

- Task 1 (handle + tests): half a day
- Task 2 (lint rule): half a day
- Task 3 (9 platform refactors): ~1 day each in parallel — one subagent per platform, the work is mechanical
- Task 4 (CI locks): half a day
- Task 5 (docs + demo): half a day

**Total: 1 senior-dev week, 9 PRs.** Most of it is parallelizable.

## Success criteria

- `grep -r 'import postgres' apps/helix/src/platform/` returns zero matches.
- `apps/helix/src/platform/tenancy/cross-tenant-isolation.test.ts` passes for every platform.
- Test suite for every refactored area still green.
- `pnpm typecheck` clean.
- Lint rule prevents future regressions.
- Master review (`REVIEW.md`) is updated to mark the killed findings.
