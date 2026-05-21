# Helix Workspace

Helix is a self-hostable productivity platform implemented from `PRD.md`.

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

Local infrastructure is defined in `docker-compose.yml`. Exposed ports default to a
contiguous high-port block to avoid colliding with system Postgres, Redis, HTTP, HTTPS,
or SMTP services during tests. Base Tier 1 uses `28431`-`28443`; optional profiles occupy
`28444`-`28455`; local mail receive/outbound test ports use `28456`-`28458`. Run
`pnpm infra:config` and `pnpm infra:config:observability` for TASK-121 compose evidence.
