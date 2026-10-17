# Helix Workspace

**Your team's mail, files, and conversations. On infrastructure you control.**

Helix brings **Mail, Drive, Chat, Assistant, and Admin** together in a self-hostable,
open-source workspace. Work in the browser, connect your tools through the CLI and
APIs, and give assistants scoped access to your workspace.

- **Keep work together.** Email, shared files, and team conversations in one place.
- **Own your deployment.** Run on your infrastructure with organization-scoped
  access, retention controls, malware scanning, and audit trails.
- **Connect the tools you use.** Access Drive through WebDAV and its S3-compatible
  API, and automate workspace tasks through REST, the SDK, CLI, and MCP.
- **Keep people in control.** Agent writes require human confirmation by default,
  with bounded, audited policies for approved automation.

Apache-2.0 licensed. No paid feature tiers or built-in usage caps; administrators
can set their own quotas. See the [license and usage policy](docs/adr/adr-0030-free-open-source-no-plans-or-limits.md).

[Documentation](docs/README.md) · [Local setup](docs/development.md) ·
[Self-hosting](docs/deployment-production.md) · [Release scope](docs/release/1.0-scope.md)

## Quick start

Use **Node.js 24.18.0**, **pnpm 11.18.0**, Docker with Compose, and a Bash-compatible
shell. This starts a local development workspace with fictional demo data. The
[development guide](docs/development.md) explains configuration, ports, and troubleshooting.

```sh
git clone https://github.com/billiondollarsolo/helix-workspace.git
cd helix-workspace
corepack enable
pnpm install --frozen-lockfile
pnpm build
cp .env.example .env
set -a; . ./.env; set +a

export DATABASE_URL=postgres://helix_app:helix_app_local@127.0.0.1:28432/helix
export BETTER_AUTH_DATABASE_URL="$DATABASE_URL"
export HELIX_MIGRATION_DATABASE_URL=postgres://helix:helix_dev_password@127.0.0.1:28432/helix
export RUSTFS_ENDPOINT=http://127.0.0.1:28437
export RUSTFS_SERVER_DOMAINS=localhost,rustfs,localhost:28437,127.0.0.1:28437,rustfs:9000
export MEILI_HOST=http://127.0.0.1:28436
export MAIL_CLAMAV_ENABLED=true MAIL_CLAMAV_HOST=127.0.0.1 MAIL_CLAMAV_PORT=28460
export POSTGRES_POOL_MAX=30
export HELIX_DEFAULT_ORG_ID=00000000-0000-4000-8000-000000000100

docker compose up -d --build --wait postgres redis nats meilisearch rustfs cerbos mailpit clamav
pnpm --filter @helix/app db:migrate
pnpm --filter @helix/app db:seed:demo -- --size small
pnpm dev
```

Open **http://localhost:5173** (or the URL Vite prints) and sign in as
`admin@helix.local` / `helix-admin-password`. The first container build and ClamAV
signature download can take several minutes. Demo credentials are for local use.
See [demo data](docs/demo-data.md) for accounts, presets, and reset behavior.

For a deployed workspace, start with the [production installation guide](docs/runbooks/pilot-install-zero-to-mail.md).
It covers secrets, managed mail delivery, deployment evidence, and recovery requirements.

## Explore the docs

| I want to…                    | Start here                                                                                                                          |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Run or contribute locally     | [Development guide](docs/development.md)                                                                                            |
| Deploy and operate Helix      | [Production deployment](docs/deployment-production.md) · [Runbook](docs/RUNBOOK.md)                                                 |
| Connect Helix Bot             | [Installation trust and optional Docker joining profiles](docs/runbooks/helix-bot-local-development.md#docker-compose-private-http) |
| Manage users and policies     | [Admin guide](docs/admin-guide.md)                                                                                                  |
| Connect storage clients       | [S3 API](docs/drive-s3-api.md) · [Desktop sync](docs/drive-desktop-sync.md)                                                         |
| Understand security and scope | [Threat model](docs/security/threat-model.md) · [1.0 scope](docs/release/1.0-scope.md)                                              |
| Find architecture and APIs    | [Documentation index](docs/README.md)                                                                                               |

## Release status

Helix 1.0 targets invite-only use by one organization with 5–50 trusted users on the
`business` security tier. Calendar and Meet are dormant behind the `full` profile and are outside 1.0.
Production uses `HELIX_APPS=mail,drive,chat,assistant` and `VITE_HELIX_MVP_ONLY=true`.
The [canonical release scope](docs/release/1.0-scope.md) records product boundaries,
security disclosures, and recovery objectives; the [release checklist](docs/release/checklist.md)
defines readiness. Package versions alone do not establish production readiness.

Licensed under [Apache-2.0](LICENSE). See [NOTICE](NOTICE) and
[third-party notices](THIRD_PARTY_NOTICES.md).
