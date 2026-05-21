# 0001 Initial Monorepo Foundation

## Status

Accepted

## Context

The PRD requires a pnpm 9 workspace with Turborepo, strict TypeScript, shared config under `packages/config`, and a plugin-first application structure.

## Decision

Use `apps/helix` for the Fastify platform process, `apps/web` for the Vite SPA, and workspace packages under `packages/*` for shared SDK and configuration.

## Consequences

All packages inherit strict TypeScript settings. Lint, typecheck, test, and build are orchestrated by Turbo from the repository root.
