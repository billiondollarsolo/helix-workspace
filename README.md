# Helix Workspace

Helix is a productivity platform implemented from `PRD.md`. The same runtime
codebase serves self-hosted and multi-tenant SaaS deployments; `HELIX_MODE`
selects the operating shape at process boot.

## Development

Required local tools:

- Node.js 22 LTS
- pnpm 9.x
- Docker with Compose v2

Common commands:

```sh
pnpm install
pnpm typecheck
pnpm lint
pnpm test
pnpm dev
```

Synthetic signup SLO evidence for SaaS-mode stacks is available with:

```sh
pnpm quality:synthetic-signup-probe
```

The probe creates a unique public signup, reads the verification link from
Mailpit, verifies the email, and fails if activation takes longer than 60s.
Bundled Alertmanager routing for those alerts can be proven locally with:

```sh
pnpm quality:alertmanager-signup-routing
```

Local infrastructure is defined in `docker-compose.yml`. Exposed ports default to a
contiguous high-port block to avoid colliding with system Postgres, Redis, HTTP, HTTPS,
or SMTP services during tests. Base Tier 1 uses `28431`-`28443`; optional profiles occupy
`28444`-`28455`; local mail receive/outbound test ports use `28456`-`28458`; the
observability Alertmanager proof uses `28461`-`28462`. Run
`pnpm infra:config` and `pnpm infra:config:observability` for TASK-121 compose evidence.
