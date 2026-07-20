# Cross-Cutting Elite Standard — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Read a target file before editing it — this plan gives exact anchors and the transformation, not a verbatim copy of existing file bodies.

**Goal:** Establish one written "elite component" standard for Helix and port the proven hygiene patterns (validated contracts, fail-fast config, complete error taxonomy, enforced boundaries) into the shared layers so every core-app can be held to the same bar.

**Architecture:** Helix already has strong bones — strict TS, Vitest, dependency-injected stores, a near-complete error envelope, and a rich custom-eslint layer. This plan does **not** rewrite anything. It (1) writes the standard down as a checkable rubric, then (2) closes the four cross-cutting gaps that block components from meeting it: no Zod single-source-of-truth contracts, 211 scattered `process.env` reads, an error handler that catches only three classes, and boundary enforcement that covers only the editors seam.

**Tech Stack:** pnpm@9 workspaces + Turborepo 2.5 · Node ≥22 · TypeScript 5.7 (strict, from `@helix/config`) · ESM everywhere · Zod (already a dependency of both apps) · Fastify · Vitest 2.1.8 · ESLint 9 flat config with custom `helix/*` rules · Drizzle + postgres.js.

## Global Constraints

_Every task's requirements implicitly include this section._

- **Runtime:** Node ≥ 22, ESM only (`"type": "module"` in every package). No CommonJS.
- **TypeScript:** extends `@helix/config/tsconfig/*`. `strict`, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`, `isolatedModules` are ON. `noEmitOnError` is ON.
- **Lint:** `@typescript-eslint` `strictTypeChecked`. `@typescript-eslint/no-explicit-any` is **error** — no `any`, ever. Use inline `import type`.
- **Tenancy:** every org-scoped Drizzle query must go through `tenantScoped()` — the `helix/direct-drizzle-tenant-query` rule enforces this. New DB access follows the same rule.
- **Validation library:** Zod. Do not add a second validation library (`yup`, `joi`, `valibot`).
- **Tests:** Vitest, co-located `*.test.ts`. Preset: `@helix/config/vitest`. Unit tests must not require a live Postgres/Redis; integration tests may.
- **Commits:** Conventional Commits (`feat:`, `fix:`, `refactor:`, `test:`, `chore:`). One logical change per commit. End the commit body with the standard `Co-Authored-By` trailer.
- **File size:** target ≤ 400 LOC per new/refactored file. A file crossing 400 LOC is a signal to split by responsibility.
- **Branch:** all work happens on a feature branch off `main`, never directly on `main`.

---

## The Elite Component Standard (the rubric)

**This section is the reusable definition-of-done referenced by every component plan (Drive, Mail, Chat, …).** A component is "elite" when it passes all nine gates. Copy this checklist into each component's acceptance criteria.

- [ ] **G1 — Typed contract.** Every request and response shape the component exposes (tool I/O, REST body, SDK method) is a Zod schema in `@helix/contracts`, and the TS types are `z.infer` of those schemas. No hand-duplicated DTOs in `apps/web/src/features/*/api.ts` or `packages/cli`.
- [ ] **G2 — Runtime validation at the edge.** Inputs are `.parse()`d at the boundary (tool handler / route). Tool `outputSchema` is a concrete schema, never `z.unknown()`.
- [ ] **G3 — Validated config.** The component reads no raw `process.env`. All env it needs comes from the typed, Zod-validated `env` module (Phase 2), resolved once at boot with fail-fast errors.
- [ ] **G4 — Typed errors.** The component throws subclasses of `ApiError` (Phase 3) with a stable `code`; it never `throw new Error("english message")` for anything a client sees, and never hand-builds `reply.code(4xx).send({ error: "..." })`.
- [ ] **G5 — Core/IO split.** Pure domain logic (validation, mapping, calculations, authorization predicates) lives in `<domain>/core/*` with injected dependencies and is unit-tested without a database. The `Postgres<Domain>Store` is a thin IO adapter.
- [ ] **G6 — Authorization is explicit and least-privilege.** Every mutating operation checks a role/scope appropriate to the mutation (not merely read access). Permission roles come from a closed enum, not free text.
- [ ] **G7 — Boundaries.** The component imports across tiers only through the sanctioned seams (`@helix/contracts`, `@helix/sdk*`). Cross-domain reach into another `platform/<other>/store` internals is forbidden and lint-enforced (Phase 4).
- [ ] **G8 — Surfaces are layered.** `web/cli/mcp → sdk → api → core`. A new capability is reachable from the tool registry (so MCP/OpenAPI/tRPC get it for free); the web and CLI consume it through shared contracts, not bespoke HTTP shapes.
- [ ] **G9 — Tested.** Unit tests for all pure core (no DB), integration tests for the IO adapter and routes, and at least one negative authorization test per mutating operation. No file over ~400 LOC ships without a split or an explicit `// ponytail:` note naming the ceiling.

---

## Current-State Grounding

_Where Helix already stands against the rubric (from the codebase survey). This tells you what to reuse vs. build._

| Dimension | Status today | Gap |
|---|---|---|
| Contracts (G1/G2) | `@helix/sdk-types` = **plain TS types, zero Zod**. Runtime validation ad-hoc in 3 places. CLI (`packages/cli/src/parser.ts`, 92 KB) and web feature `api.ts` files hand-duplicate every shape. | Build `@helix/contracts`. |
| Config (G3) | HelixConfig **YAML** path is validated + hot-reloaded. Operational env is **not**: 211 `process.env` reads in the API, **146 in `server.ts`**. No fail-fast env schema. | Build `env` module. |
| Errors (G4) | **~80% there.** `api/error-envelope.ts` (codes→HTTP), `app.setErrorHandler` (server.ts:961), Retry-After on 429, 202-for-approval, web parses the envelope. | Handler catches only 3 classes; ~dozen legacy `{error:"..."}` responses; no `ApiError` base. |
| Core/IO + tests (G5/G9) | Strong: constructor-injected stores, **210 co-located test files** in the API, DI used for mocking. | Pure/IO split is convention, not enforced; `server.ts` (4,897 LOC) and `sheets/store.ts` (5,612 LOC) are god-files. |
| Boundaries (G7) | Only the editors seam is enforced (`infra/scripts/verify-workspace-editor-boundaries.mjs`). 8 custom `helix/*` eslint rules already exist — the machinery is here. | No general tier/domain boundary rule. |
| Surfaces (G8) | Clean layering **except the CLI**, which bypasses the SDK entirely. MCP is embedded in `server.ts`. | `sdk-client` + CLI regen (Phase 5, later). |

---

## File Structure

**Created:**
- `packages/contracts/` — new `@helix/contracts` package: `package.json`, `tsconfig.json`, `vitest.config.mjs`, `src/index.ts`, `src/errors.ts`, `src/http.ts`, `src/tenant-config.ts` (+ per-domain files added by component plans, e.g. `src/drive.ts`).
- `apps/helix/src/config/env.ts` — Zod-validated operational-env module (single source for all `process.env`).
- `apps/helix/src/config/env.test.ts` — env schema tests.
- `apps/helix/src/api/api-error.ts` — `ApiError` base class + common subclasses.
- `apps/helix/src/api/api-error.test.ts`.
- `packages/config/eslint/rules/no-raw-process-env.js` — custom lint rule.
- `packages/config/eslint/rules/no-cross-domain-import.js` — custom lint rule.

**Modified:**
- `packages/sdk-types/src/tenant-config.ts` — re-export types from `@helix/contracts` (back-compat shim).
- `apps/helix/src/server.ts` — consume `env`; extend `setErrorHandler`; add `setNotFoundHandler`; replace legacy error responses (in slices).
- `apps/helix/src/index.ts`, `apps/helix/src/db/client.ts`, `apps/helix/src/telemetry.ts` — consume `env`.
- `apps/helix/src/api/error-envelope.ts` — re-export the code enum from `@helix/contracts`.
- `packages/config/eslint/index.js` — register the two new rules + an import-boundary rule.
- `packages/config/package.json` — add `eslint-plugin-boundaries` (dev).

---

## Phase 1 — `@helix/contracts`: one validated source of truth

**Outcome:** a package that authors Zod schemas once; API validates with them, and SDK/CLI/web infer types from them. This phase proves the pattern end-to-end on the error envelope + tenant-config, then component plans extend it per domain.

### Task 1.1: Scaffold the `@helix/contracts` package

**Files:**
- Create: `packages/contracts/package.json`, `packages/contracts/tsconfig.json`, `packages/contracts/vitest.config.mjs`, `packages/contracts/src/index.ts`

**Interfaces:**
- Produces: the `@helix/contracts` package name and build target that every later task and component plan imports.

- [ ] **Step 1: Create `packages/contracts/package.json`**

```json
{
  "name": "@helix/contracts",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": "./dist/index.js",
    "./errors": "./dist/errors.js",
    "./http": "./dist/http.js"
  },
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "scripts": {
    "build": "tsc -b",
    "typecheck": "tsc -b --noEmit",
    "test": "vitest run",
    "lint": "eslint ."
  },
  "dependencies": {
    "zod": "^3.23.8"
  },
  "devDependencies": {
    "@helix/config": "workspace:*"
  }
}
```

- [ ] **Step 2: Create `packages/contracts/tsconfig.json`**

```json
{
  "extends": "@helix/config/tsconfig/node",
  "compilerOptions": {
    "composite": true,
    "rootDir": "src",
    "outDir": "dist"
  },
  "include": ["src/**/*"]
}
```

- [ ] **Step 3: Create `packages/contracts/vitest.config.mjs`**

```js
import preset from "@helix/config/vitest";
export default preset;
```

- [ ] **Step 4: Create a placeholder `packages/contracts/src/index.ts`**

```ts
export * from "./errors.js";
export * from "./http.js";
export * from "./tenant-config.js";
```

- [ ] **Step 5: Install + verify the package resolves**

Run: `pnpm install`
Then: `pnpm --filter @helix/contracts typecheck`
Expected: FAIL — `Cannot find module './errors.js'` (files land in Task 1.2–1.4). This confirms the package is wired into the workspace.

- [ ] **Step 6: Commit**

```bash
git add packages/contracts
git commit -m "chore(contracts): scaffold @helix/contracts package"
```

### Task 1.2: Error envelope + code enum as the canonical contract

**Files:**
- Create: `packages/contracts/src/errors.ts`, `packages/contracts/src/errors.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `ErrorCode` (Zod enum), `errorCodeForStatus(status: number): ErrorCode`, `statusForErrorCode(code: ErrorCode): number`, `errorEnvelopeSchema`, `type ErrorEnvelope`. These become the single source that `apps/helix/src/api/error-envelope.ts` (Phase 3) and the web/CLI clients import.

- [ ] **Step 1: Write the failing test** — `packages/contracts/src/errors.test.ts`

```ts
import { describe, expect, it } from "vitest";
import {
  errorCodeForStatus,
  statusForErrorCode,
  errorEnvelopeSchema,
  ERROR_CODES,
} from "./errors.js";

describe("error codes", () => {
  it("maps statuses to stable codes", () => {
    expect(errorCodeForStatus(400)).toBe("bad_request");
    expect(errorCodeForStatus(401)).toBe("unauthorized");
    expect(errorCodeForStatus(403)).toBe("forbidden");
    expect(errorCodeForStatus(404)).toBe("not_found");
    expect(errorCodeForStatus(409)).toBe("conflict");
    expect(errorCodeForStatus(429)).toBe("rate_limited");
    expect(errorCodeForStatus(500)).toBe("internal_error");
  });

  it("falls back to internal_error for unknown status", () => {
    expect(errorCodeForStatus(418)).toBe("internal_error");
  });

  it("round-trips code -> status -> code for client-facing codes", () => {
    for (const code of ERROR_CODES) {
      expect(errorCodeForStatus(statusForErrorCode(code))).toBeDefined();
    }
  });

  it("validates a well-formed envelope", () => {
    const parsed = errorEnvelopeSchema.parse({
      error: { code: "not_found", message: "gone", traceId: "abc" },
    });
    expect(parsed.error.code).toBe("not_found");
  });

  it("rejects an envelope with an unknown code", () => {
    expect(() =>
      errorEnvelopeSchema.parse({ error: { code: "nope", message: "x" } }),
    ).toThrow();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @helix/contracts test -- errors`
Expected: FAIL — cannot find `./errors.js`.

- [ ] **Step 3: Implement `packages/contracts/src/errors.ts`**

> Keep this taxonomy identical to the existing `apps/helix/src/api/error-envelope.ts` mapping so Phase 3 can re-export from here without behavior change. Verify the existing map before finalizing.

```ts
import { z } from "zod";

export const ERROR_CODES = [
  "bad_request",
  "unauthorized",
  "forbidden",
  "not_found",
  "conflict",
  "unprocessable",
  "rate_limited",
  "internal_error",
] as const;

export const errorCodeSchema = z.enum(ERROR_CODES);
export type ErrorCode = z.infer<typeof errorCodeSchema>;

const STATUS_TO_CODE: Record<number, ErrorCode> = {
  400: "bad_request",
  401: "unauthorized",
  403: "forbidden",
  404: "not_found",
  409: "conflict",
  422: "unprocessable",
  429: "rate_limited",
};

const CODE_TO_STATUS: Record<ErrorCode, number> = {
  bad_request: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  unprocessable: 422,
  rate_limited: 429,
  internal_error: 500,
};

export function errorCodeForStatus(status: number): ErrorCode {
  return STATUS_TO_CODE[status] ?? "internal_error";
}

export function statusForErrorCode(code: ErrorCode): number {
  return CODE_TO_STATUS[code];
}

export const errorEnvelopeSchema = z.object({
  error: z.object({
    code: errorCodeSchema,
    message: z.string(),
    traceId: z.string().optional(),
    details: z.unknown().optional(),
    retryAfterSeconds: z.number().int().nonnegative().optional(),
  }),
});
export type ErrorEnvelope = z.infer<typeof errorEnvelopeSchema>;
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @helix/contracts test -- errors`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/contracts/src/errors.ts packages/contracts/src/errors.test.ts
git commit -m "feat(contracts): canonical error code enum and envelope schema"
```

### Task 1.3: A reusable edge-validation helper (`http.ts`)

**Files:**
- Create: `packages/contracts/src/http.ts`, `packages/contracts/src/http.test.ts`

**Interfaces:**
- Consumes: `errorEnvelopeSchema` conceptually (returns a shape compatible with it).
- Produces: `parseInput<T>(schema: ZodType<T>, value: unknown): T` (throws a tagged `ContractValidationError` on failure), and `type ContractValidationError`. Component route/tool handlers call `parseInput` at the boundary (G2).

- [ ] **Step 1: Write the failing test** — `packages/contracts/src/http.test.ts`

```ts
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { parseInput, ContractValidationError } from "./http.js";

const schema = z.object({ name: z.string().min(1) });

describe("parseInput", () => {
  it("returns the parsed value on success", () => {
    expect(parseInput(schema, { name: "ok" })).toEqual({ name: "ok" });
  });

  it("throws ContractValidationError with field details on failure", () => {
    try {
      parseInput(schema, { name: "" });
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ContractValidationError);
      const e = err as ContractValidationError;
      expect(e.code).toBe("bad_request");
      expect(e.issues[0]?.path).toEqual(["name"]);
    }
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `pnpm --filter @helix/contracts test -- http` → FAIL (no module).

- [ ] **Step 3: Implement `packages/contracts/src/http.ts`**

```ts
import { z, type ZodType } from "zod";
import type { ErrorCode } from "./errors.js";

export interface ContractIssue {
  path: (string | number)[];
  message: string;
}

export class ContractValidationError extends Error {
  readonly code: ErrorCode = "bad_request";
  readonly statusCode = 400;
  readonly issues: ContractIssue[];
  constructor(issues: ContractIssue[]) {
    super(`Request validation failed: ${issues.map((i) => i.message).join("; ")}`);
    this.name = "ContractValidationError";
    this.issues = issues;
  }
}

export function parseInput<T>(schema: ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  throw new ContractValidationError(
    result.error.issues.map((i) => ({ path: [...i.path], message: i.message })),
  );
}
```

- [ ] **Step 4: Run to verify it passes** — `pnpm --filter @helix/contracts test -- http` → PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/contracts/src/http.ts packages/contracts/src/http.test.ts
git commit -m "feat(contracts): parseInput edge-validation helper"
```

### Task 1.4: Re-express `tenant-config` as Zod and back-compat the types

**Files:**
- Create: `packages/contracts/src/tenant-config.ts`, `packages/contracts/src/tenant-config.test.ts`
- Modify: `packages/sdk-types/src/tenant-config.ts` (turn into a re-export shim), `packages/sdk-types/package.json` (add `@helix/contracts` dep)

**Interfaces:**
- Consumes: nothing.
- Produces: `tenantFeatureFlagsSchema`, `tenantConfigSchema`, and `type TenantFeatureFlags = z.infer<...>`, `type TenantConfig = z.infer<...>`, plus `SYSTEM_TENANT_FEATURE_FLAGS`. The **exported names stay identical** to today's `@helix/sdk-types` names so consumers don't change.

> Read the current `packages/sdk-types/src/tenant-config.ts` first and mirror every field and default exactly. The test below is a template — extend it to assert every existing flag and default.

- [ ] **Step 1: Write the failing test** — `packages/contracts/src/tenant-config.test.ts`

```ts
import { describe, expect, it } from "vitest";
import {
  tenantConfigSchema,
  SYSTEM_TENANT_FEATURE_FLAGS,
} from "./tenant-config.js";

describe("tenant-config contract", () => {
  it("defaults every editors flag to true (parity with sdk-types)", () => {
    expect(SYSTEM_TENANT_FEATURE_FLAGS.editors_native_document).toBe(true);
    expect(SYSTEM_TENANT_FEATURE_FLAGS.editors_native_spreadsheet).toBe(true);
    expect(SYSTEM_TENANT_FEATURE_FLAGS.editors_native_presentation).toBe(true);
    expect(SYSTEM_TENANT_FEATURE_FLAGS.editors_native_pdf).toBe(true);
  });

  it("parses a full tenant config object", () => {
    const parsed = tenantConfigSchema.parse({ features: SYSTEM_TENANT_FEATURE_FLAGS });
    expect(parsed.features.editors_native_document).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `pnpm --filter @helix/contracts test -- tenant-config` → FAIL.

- [ ] **Step 3: Implement `packages/contracts/src/tenant-config.ts`** (mirror the existing shape/defaults verbatim)

```ts
import { z } from "zod";

export const tenantFeatureFlagsSchema = z.object({
  editors_native_document: z.boolean(),
  editors_native_spreadsheet: z.boolean(),
  editors_native_presentation: z.boolean(),
  editors_native_pdf: z.boolean(),
  editors_ai_rag: z.boolean(),
  // NOTE: extend with every flag currently in sdk-types/src/tenant-config.ts
});
export type TenantFeatureFlags = z.infer<typeof tenantFeatureFlagsSchema>;

export const tenantConfigSchema = z.object({
  features: tenantFeatureFlagsSchema,
  // NOTE: mirror remaining TenantConfig fields from sdk-types.
});
export type TenantConfig = z.infer<typeof tenantConfigSchema>;

export const SYSTEM_TENANT_FEATURE_FLAGS: TenantFeatureFlags = {
  editors_native_document: true,
  editors_native_spreadsheet: true,
  editors_native_presentation: true,
  editors_native_pdf: true,
  editors_ai_rag: true,
};
```

- [ ] **Step 4: Turn `packages/sdk-types/src/tenant-config.ts` into a re-export shim**

Add `"@helix/contracts": "workspace:*"` to `packages/sdk-types/package.json` dependencies, then replace the body of `packages/sdk-types/src/tenant-config.ts` with:

```ts
// Types now authored in @helix/contracts (Zod single source of truth).
// This shim preserves the historical @helix/sdk-types import path.
export type {
  TenantFeatureFlags,
  TenantConfig,
} from "@helix/contracts/tenant-config";
export { SYSTEM_TENANT_FEATURE_FLAGS } from "@helix/contracts/tenant-config";
```

Add the `./tenant-config` subpath to `packages/contracts/package.json` exports.

- [ ] **Step 5: Run the full type + test gate**

Run: `pnpm install && pnpm --filter @helix/contracts test && pnpm --filter @helix/sdk-types typecheck && pnpm --filter @helix/app typecheck`
Expected: PASS. If `@helix/app` typecheck surfaces a shape mismatch, the Zod schema in Step 3 is missing a field — add it (this is the schema catching real drift).

- [ ] **Step 6: Commit**

```bash
git add packages/contracts packages/sdk-types
git commit -m "refactor(contracts): author tenant-config as Zod, shim sdk-types"
```

### Task 1.5: Prove adoption — one web feature imports contracts

**Files:**
- Modify: `apps/web/src/features/drive/api.ts` (replace one locally-declared DTO with a contract import) — _coordinate with the Drive plan, which adds `packages/contracts/src/drive.ts`._

- [ ] **Step 1:** After the Drive plan lands `src/drive.ts`, delete the duplicate `DriveApiEntry`/`DriveUploadResult` interfaces in `apps/web/src/features/drive/api.ts` and import them from `@helix/contracts`.
- [ ] **Step 2:** Run `pnpm --filter @helix/web typecheck && pnpm --filter @helix/web test -- drive/api`. Expected: PASS.
- [ ] **Step 3:** Commit `refactor(web): drive api uses @helix/contracts DTOs`.

> This task is the template the two component plans follow to satisfy **G1**. It is intentionally thin here; the real per-domain schemas live in those plans.

---

## Phase 2 — Fail-fast operational config (`env` module)

**Outcome:** one Zod-validated `env` object, parsed once at boot, that fails loudly on missing/invalid infrastructure env. All 211 `process.env` reads migrate to it, enforced by lint. This satisfies **G3** for every component.

### Task 2.1: Create the validated env module

**Files:**
- Create: `apps/helix/src/config/env.ts`, `apps/helix/src/config/env.test.ts`

**Interfaces:**
- Produces: `loadEnv(source?: Record<string, string | undefined>): Env` (pure, testable — takes an injectable source, defaults to `process.env`) and a memoized `env: Env` for app code. `type Env` is `z.infer` of the schema.

> Seed the schema from the real reads found in `server.ts`/`index.ts`: `DATABASE_URL`, `REDIS_URL`, `PORT`, `HOST`, `SHUTDOWN_TIMEOUT_MS`, `HELIX_MODE`, `RUSTFS_ENDPOINT`/`RUSTFS_ACCESS_KEY`/`RUSTFS_SECRET_KEY`/`RUSTFS_BUCKET`, `HELIX_BODY_LIMIT_BYTES`, `HELIX_DRIVE_OFFICE_PREVIEW_URL`, plus the editors `HELIX_EDITORS_*`. Grep `process.env` in `apps/helix/src` for the full list and add each.

- [ ] **Step 1: Write the failing test** — `apps/helix/src/config/env.test.ts`

```ts
import { describe, expect, it } from "vitest";
import { loadEnv } from "./env.js";

const base = {
  DATABASE_URL: "postgres://u:p@localhost:5432/helix",
  REDIS_URL: "redis://localhost:6379",
};

describe("loadEnv", () => {
  it("parses a valid environment and applies defaults", () => {
    const env = loadEnv(base);
    expect(env.PORT).toBe(3000); // default
    expect(env.DATABASE_URL).toContain("postgres://");
  });

  it("fails fast with a readable message when DATABASE_URL is missing", () => {
    expect(() => loadEnv({ REDIS_URL: base.REDIS_URL })).toThrow(/DATABASE_URL/);
  });

  it("rejects a non-numeric PORT", () => {
    expect(() => loadEnv({ ...base, PORT: "notaport" })).toThrow(/PORT/);
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `pnpm --filter @helix/app test -- config/env` → FAIL.

- [ ] **Step 3: Implement `apps/helix/src/config/env.ts`**

```ts
import { z } from "zod";

const envSchema = z.object({
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
  PORT: z.coerce.number().int().positive().default(3000),
  HOST: z.string().default("0.0.0.0"),
  SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().nonnegative().default(10_000),
  HELIX_MODE: z.enum(["single-tenant", "multi-tenant-saas"]).default("single-tenant"),
  HELIX_BODY_LIMIT_BYTES: z.coerce.number().int().positive().default(134_217_728),
  // Storage (optional in dev; required checks belong to the drive config in its plan)
  RUSTFS_ENDPOINT: z.string().url().optional(),
  RUSTFS_ACCESS_KEY: z.string().optional(),
  RUSTFS_SECRET_KEY: z.string().optional(),
  RUSTFS_BUCKET: z.string().optional(),
  // NOTE: extend with every remaining process.env key found in apps/helix/src.
});

export type Env = z.infer<typeof envSchema>;

export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    const details = result.error.issues
      .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid environment configuration:\n${details}`);
  }
  return Object.freeze(result.data);
}

let cached: Env | undefined;
export const env = (): Env => (cached ??= loadEnv());
```

- [ ] **Step 4: Run to verify it passes** — `pnpm --filter @helix/app test -- config/env` → PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/helix/src/config/env.ts apps/helix/src/config/env.test.ts
git commit -m "feat(config): fail-fast Zod-validated env module"
```

### Task 2.2: Adopt `env` in the boot path (index + db + telemetry)

**Files:**
- Modify: `apps/helix/src/index.ts`, `apps/helix/src/db/client.ts`, `apps/helix/src/telemetry.ts`

- [ ] **Step 1:** In `apps/helix/src/index.ts`, replace `process.env.PORT`, `process.env.HOST`, `process.env.SHUTDOWN_TIMEOUT_MS` reads with `env().PORT` etc. Import `{ env } from "./config/env.js"`.
- [ ] **Step 2:** In `apps/helix/src/db/client.ts`, replace `process.env.DATABASE_URL` with `env().DATABASE_URL`.
- [ ] **Step 3:** In `apps/helix/src/telemetry.ts`, replace any `process.env.OTEL_*`/`REDIS_URL` reads with `env()` fields (add them to the schema in Task 2.1 first if absent).
- [ ] **Step 4:** Run `pnpm --filter @helix/app typecheck && pnpm --filter @helix/app test -- config`. Expected: PASS.
- [ ] **Step 5:** Boot smoke: `HELIX_MODE=single-tenant pnpm --filter @helix/app build` and confirm it compiles. Commit `refactor(config): boot path reads validated env`.

### Task 2.3: Migrate `server.ts` env reads in domain slices

**Files:**
- Modify: `apps/helix/src/server.ts` (146 `process.env` reads)

> Do this in **reviewable slices**, one commit per domain, not one mega-commit. Each slice: replace the domain's `process.env.X` reads with `env().X`, run the domain's tests, commit.

- [ ] **Step 1:** Slice A — server core (`PORT`/`HOST`/`REDIS_URL`/`HELIX_BODY_LIMIT_BYTES`). Replace, run `pnpm --filter @helix/app test -- server`, commit `refactor(config): server core reads env`.
- [ ] **Step 2:** Slice B — storage/drive env (`RUSTFS_*`, `HELIX_DRIVE_OFFICE_PREVIEW_*`). _Coordinate with Drive plan Task on `drive/config.ts`._ Commit.
- [ ] **Step 3:** Slice C — auth/session, AI providers, search, observability slices — one commit each.
- [ ] **Step 4:** After the last slice, grep to confirm: `grep -rn "process.env" apps/helix/src --include=*.ts | grep -v ".test.ts" | grep -v "config/env.ts"` → only the env module (and any intentionally-exempt seed scripts) remain. Record the count in the commit message.

### Task 2.4: Lint rule — forbid raw `process.env` outside the env module

**Files:**
- Create: `packages/config/eslint/rules/no-raw-process-env.js`
- Modify: `packages/config/eslint/index.js`

**Interfaces:**
- Produces: eslint rule `helix/no-raw-process-env` reporting any `process.env` member access outside an allowlist (`apps/helix/src/config/env.ts`, `**/*.test.ts`, seed scripts).

- [ ] **Step 1: Write the failing test.** Add a rule test in the style of the existing custom-rule tests (see how `direct-drizzle-tenant-query` is tested in `packages/config/eslint`). Assert: `const x = process.env.FOO` reports; inside `config/env.ts` it does not.
- [ ] **Step 2: Run** the eslint rule test → FAIL.
- [ ] **Step 3: Implement `no-raw-process-env.js`** (mirror the structure of an existing `helix/*` rule; match `MemberExpression` with `object.object.name === "process"` and `object.property.name === "env"`, skip allowlisted filenames).
- [ ] **Step 4:** Register it in `packages/config/eslint/index.js` alongside the other `helix/*` rules, severity `error`.
- [ ] **Step 5: Run** `pnpm --filter @helix/app lint`. Expected: PASS (Task 2.3 already cleared the violations). If any remain, fix or add to the allowlist with justification.
- [ ] **Step 6: Commit** `feat(lint): helix/no-raw-process-env rule`.

---

## Phase 3 — Complete the error taxonomy (`ApiError`)

**Outcome:** every client-visible error is an `ApiError` with a stable code, rendered by one handler into the existing envelope. Satisfies **G4**. This is the smallest phase — the envelope already exists.

### Task 3.1: `ApiError` base class

**Files:**
- Create: `apps/helix/src/api/api-error.ts`, `apps/helix/src/api/api-error.test.ts`
- Modify: the existing `CredentialAuthError`, `TenantResolutionError`, `TenantActorMismatchError` classes to extend `ApiError`

**Interfaces:**
- Produces: `class ApiError extends Error { code: ErrorCode; statusCode: number; details?: unknown; retryAfterSeconds?: number }` and convenience subclasses `BadRequestError`, `UnauthorizedError`, `ForbiddenError`, `NotFoundError`, `ConflictError`, `RateLimitedError`. Component plans throw these (e.g. Drive's `DriveForbiddenError extends ForbiddenError`).

- [ ] **Step 1: Write the failing test** — `api-error.test.ts`

```ts
import { describe, expect, it } from "vitest";
import { ApiError, NotFoundError, RateLimitedError } from "./api-error.js";

describe("ApiError", () => {
  it("carries code + status", () => {
    const e = new NotFoundError("gone");
    expect(e).toBeInstanceOf(ApiError);
    expect(e.code).toBe("not_found");
    expect(e.statusCode).toBe(404);
  });

  it("carries retryAfterSeconds for rate limiting", () => {
    const e = new RateLimitedError("slow down", { retryAfterSeconds: 30 });
    expect(e.statusCode).toBe(429);
    expect(e.retryAfterSeconds).toBe(30);
  });
});
```

- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement `api-error.ts`**

```ts
import type { ErrorCode } from "@helix/contracts";
import { statusForErrorCode } from "@helix/contracts";

export interface ApiErrorOptions {
  details?: unknown;
  retryAfterSeconds?: number;
  cause?: unknown;
}

export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly statusCode: number;
  readonly details?: unknown;
  readonly retryAfterSeconds?: number;
  constructor(code: ErrorCode, message: string, options: ApiErrorOptions = {}) {
    super(message, options.cause ? { cause: options.cause } : undefined);
    this.name = "ApiError";
    this.code = code;
    this.statusCode = statusForErrorCode(code);
    this.details = options.details;
    this.retryAfterSeconds = options.retryAfterSeconds;
  }
}

export class BadRequestError extends ApiError {
  constructor(message: string, o?: ApiErrorOptions) { super("bad_request", message, o); }
}
export class UnauthorizedError extends ApiError {
  constructor(message: string, o?: ApiErrorOptions) { super("unauthorized", message, o); }
}
export class ForbiddenError extends ApiError {
  constructor(message: string, o?: ApiErrorOptions) { super("forbidden", message, o); }
}
export class NotFoundError extends ApiError {
  constructor(message: string, o?: ApiErrorOptions) { super("not_found", message, o); }
}
export class ConflictError extends ApiError {
  constructor(message: string, o?: ApiErrorOptions) { super("conflict", message, o); }
}
export class RateLimitedError extends ApiError {
  constructor(message: string, o?: ApiErrorOptions) { super("rate_limited", message, o); }
}
```

- [ ] **Step 4:** Make the three existing typed errors extend `ApiError` (keep their current `.statusCode`/`.code` values). Run `pnpm --filter @helix/app test -- api-error tenancy auth`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(api): ApiError base class and subclasses`.

### Task 3.2: Extend the central handler + not-found handler

**Files:**
- Modify: `apps/helix/src/server.ts` (`app.setErrorHandler` at ~:961)

- [ ] **Step 1: Write the failing test.** In an existing server/error test suite, add: a route that `throw new NotFoundError("x")` returns HTTP 404 with body `{ error: { code: "not_found", message: "x", traceId } }`; a route that throws a `ZodError`/`ContractValidationError` returns 400 with `code: "bad_request"` and issue details; an unknown route returns the envelope with `code: "not_found"` (from `setNotFoundHandler`).
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.** In `setErrorHandler`, add branches (before the current 3-class checks): `if (error instanceof ApiError)` → build envelope from `error.code/message/details`, set `retry-after` header when `retryAfterSeconds` present, `reply.code(error.statusCode)`; `if (error instanceof ContractValidationError || error instanceof ZodError)` → 400 envelope with issues in `details`. Add `app.setNotFoundHandler` that emits the `not_found` envelope. Reuse the existing `buildErrorEnvelope`.
- [ ] **Step 4: Run** → PASS. Commit `feat(api): handler renders ApiError, ZodError, and 404 as envelope`.

### Task 3.3: Replace legacy inline error responses

**Files:**
- Modify: `apps/helix/src/server.ts` lines ~2648, 2656, 2692, 2720, 2728, 2744 (and any other `reply.code(4xx).send({ error: "..." })`)

- [ ] **Step 1:** Grep: `grep -n 'send({ error:' apps/helix/src/server.ts`. For each hit, replace with `throw new <Appropriate>Error("...")` so the handler renders it.
- [ ] **Step 2:** Run the affected route tests (e.g. drive content/preview). Expected: PASS with the new envelope shape — update any test asserting the old `{ error: "string" }` body to the envelope.
- [ ] **Step 3:** Commit `refactor(api): route legacy errors through ApiError`.

### Task 3.4: Re-export the code enum from contracts

**Files:**
- Modify: `apps/helix/src/api/error-envelope.ts` (re-export `ERROR_CODES`/`ErrorCode` from `@helix/contracts`), web `apps/web/src/lib/tool-call.ts` (import the enum instead of string-matching)

- [ ] **Step 1:** Replace the local code list in `error-envelope.ts` with `export { ERROR_CODES, type ErrorCode, errorCodeForStatus } from "@helix/contracts"`. Keep `buildErrorEnvelope`/`toolErrorEnvelope` local (they’re Fastify-aware).
- [ ] **Step 2:** Run `pnpm --filter @helix/app typecheck && pnpm --filter @helix/web typecheck`. PASS.
- [ ] **Step 3:** Commit `refactor(api): error codes sourced from @helix/contracts`.

---

## Phase 4 — Enforce boundaries

**Outcome:** the tier/domain rules become lint failures, not review comments. Satisfies **G7**.

### Task 4.1: Tier import boundaries

**Files:**
- Modify: `packages/config/eslint/index.js`, `packages/config/package.json` (add `eslint-plugin-boundaries` dev dep)

- [ ] **Step 1:** Add `eslint-plugin-boundaries`. Define element types: `app-web`, `app-api`, `pkg-sdk`, `pkg-sdk-web`, `pkg-contracts`, `pkg-cli`. Rules: `app-web` may not import `pkg-sdk` or `app-api`; `pkg-*` may not import `app-*`; everyone may import `pkg-contracts`.
- [ ] **Step 2:** Run `pnpm -r lint`. Expected: a small number of real violations surface. Fix each (or record an explicit `// eslint-disable` with justification if it’s a sanctioned exception).
- [ ] **Step 3:** Commit `feat(lint): tier import boundaries via eslint-plugin-boundaries`.

### Task 4.2: `helix/no-cross-domain-import` custom rule

**Files:**
- Create: `packages/config/eslint/rules/no-cross-domain-import.js`
- Modify: `packages/config/eslint/index.js`

- [ ] **Step 1: Write the failing rule test** — importing `../mail/store` from inside `platform/drive/*` reports; importing `../mail` barrel (public surface) does not.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** the rule (flag relative imports matching `platform/<other>/<internal>` where `<other>` ≠ the current file's domain and the path is not the domain barrel `index.ts`). Register in `index.js`.
- [ ] **Step 4: Run** `pnpm --filter @helix/app lint`. Fix surfaced violations or add domain barrels to export the shared surface. Commit `feat(lint): forbid cross-domain internal imports`.

### Task 4.3: Generalize the boundary scanner

**Files:**
- Modify: `infra/scripts/verify-workspace-editor-boundaries.mjs` → generalize to a config-driven allowlist; add root script `quality:boundaries`

- [ ] **Step 1:** Extract the editors-specific allowlist into a config object keyed by seam; keep the editors seam as one entry.
- [ ] **Step 2:** Add `"quality:boundaries": "node infra/scripts/verify-workspace-boundaries.mjs"` to root `package.json`; keep `quality:editors-boundaries` as an alias for CI back-compat.
- [ ] **Step 3:** Run both; PASS. Commit `refactor(infra): config-driven boundary scanner`.

---

## Phase 5 — Surfaces & `server.ts` decomposition (later, higher-risk)

> These are large refactors that each deserve their own focused execution session behind a green test suite. Listed with first concrete steps so they’re not lost. Do **not** start Phase 5 until Phases 1–4 are merged and the component plans are underway.

### Task 5.1: Extract the composition root
- Create `apps/helix/src/server/wiring.ts` exporting `buildDependencies(env): AppDependencies` (all Postgres stores/services/Redis/auth). `createHelixServer` calls it, then only registers plugins. Move wiring in slices behind existing server tests. Target: `server.ts` under ~1,500 LOC.

### Task 5.2: `packages/sdk-client` (isomorphic HTTP client from contracts)
- New package: a typed fetch client whose method signatures are `@helix/contracts` schemas. One method per tool/route. Unit-tested against a mock fetch.

### Task 5.3: CLI consumes `sdk-client`
- Replace bespoke request building in `packages/cli/src/client.ts` with `sdk-client`; regenerate the command surface from the tool registry to retire most of `parser.ts` (92 KB). Highest reward, do last.

### Task 5.4: Extract MCP into a plugin
- Move `apps/helix/src/api/mcp.ts` wiring out of `server.ts` into a self-registering `platform/mcp` plugin.

---

## Self-Review

- [ ] **Spec coverage:** every rubric gate G1–G9 has a home — G1/G2 → Phase 1; G3 → Phase 2; G4 → Phase 3; G5 → Phase 5.1 + component plans; G6 → component plans (auth is per-domain); G7 → Phase 4; G8 → Phase 5.2/5.3; G9 → tests in every task.
- [ ] **Placeholder scan:** the only `// NOTE:` markers are explicit "mirror the existing file" instructions where faithfully copying live code (whose exact body isn't reproduced here) is the correct action — the agent reads the real file. No silent TODOs.
- [ ] **Type consistency:** `ErrorCode`, `errorCodeForStatus`, `statusForErrorCode`, `errorEnvelopeSchema`, `parseInput`, `ContractValidationError`, `ApiError`, `env`/`loadEnv` names are used identically across phases.
- [ ] **Ordering:** Phase 1 (contracts) precedes Phase 3 (ApiError imports `ErrorCode` from contracts). Phase 2 precedes the Task 2.4 lint rule. Correct.

## Execution Handoff

Recommended: **subagent-driven** — one fresh subagent per task, review between tasks. Phases 1–4 are mergeable independently and unblock the Drive and Mail/Chat component plans. Phase 5 is deferred until those are underway.
