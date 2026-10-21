# Local development

[Documentation](README.md) · [Project overview and quick start](../README.md)

## Prerequisites

Use Node.js **24.18.0** from [`.node-version`](../.node-version) and pnpm **11.18.0**
from [`package.json`](../package.json). Activate pnpm with `corepack enable`.
The validated infrastructure uses Docker Engine 29.x and Compose 5.x. Use a
Bash-compatible shell for the quick-start commands. Helm 4.2.3 and kubeconform
0.8.0 are also needed for Kubernetes chart validation, but not to start the app.
See the [platform version policy](platform-version-policy.md) for the full matrix.

## Start a workspace

Follow the [README quick start](../README.md#quick-start) in a fresh checkout.
Run all commands in the same shell at the repository root. Keep an existing `.env`
instead of copying over it; adjust the example endpoints if you already use custom ports.

The startup order matters:

1. Install the locked dependencies, build the workspace packages, and load the local environment.
2. Start the named infrastructure services. The application and Vite run on the
   host; the command does not require a prebuilt Helix application image.
3. Apply migrations using the owner connection, `HELIX_MIGRATION_DATABASE_URL`.
4. Seed fictional data using the restricted `helix_app` runtime role in
   `DATABASE_URL`. The seed refuses a privileged application connection.
5. Run `pnpm dev`, which checks Cerbos and starts the API and web development servers.

The explicit exports in the quick start supplement `.env.example`: host processes
need loopback service addresses, the demo seed needs real ClamAV scanning, and the
runtime pool needs room for background workers. `RUSTFS_SERVER_DOMAINS` includes
the host and port used by local storage requests. `HELIX_DEFAULT_ORG_ID` points
local requests at the demo tenant the seed creates; without it, sign-in succeeds but
every workspace request is denied because the session resolves to an empty organization.

The root `pnpm dev` command loads `.env`; database commands do not automatically
load it. In a new terminal, load `.env` and repeat the quick-start exports before
running database commands or `pnpm dev`. You can save those local overrides in
`.env` to avoid repeating them. Never commit that file.

The [environment reference](reference/environment.md) describes supported settings.
The [demo-data guide](demo-data.md) covers all sign-ins and seed validation. An
identical seed revalidates existing data; `--reset` deletes the demo tenant's data,
objects, and search documents before rebuilding it.

## Local services and ports

Defaults come from [`docker-compose.yml`](../docker-compose.yml). Containers bind
their published ports to loopback. Vite and the API are separate host processes.

| Service                | Default address or port                           |
| ---------------------- | ------------------------------------------------- |
| Web development server | `http://localhost:5173` (use the URL Vite prints) |
| API                    | `http://localhost:3000`                           |
| PostgreSQL             | `127.0.0.1:28432`                                 |
| Redis                  | `127.0.0.1:28433`                                 |
| NATS / monitor         | `28434` / `28435`                                 |
| Meilisearch            | `http://localhost:28436`                          |
| RustFS API / console   | `28437` / `28438`                                 |
| Cerbos HTTP / gRPC     | `28439` / `28440`                                 |
| Local inbound SMTP     | `28456`                                           |
| Mailpit SMTP / inbox   | `28457` / `http://localhost:28458`                |
| ClamAV                 | `127.0.0.1:28460`                                 |
| LiveKit (Meet)         | `ws://localhost:28451`                            |

Base infrastructure uses the `28431`–`28443` block; optional profiles use
`28444`–`28455`. Observability Alertmanager proof uses `28461`–`28462`.
`pnpm infra:config` and `pnpm infra:config:observability` render the Compose setup.

Mailpit captures local outbound mail. It does not prove internet delivery; that
requires a [managed provider](mail-managed-provider-delivery.md). Assistant demo
conversations do not call a model provider. Configure a provider through Admin to
use AI; see [local AI and retrieval](runbooks/local-ai-retrieval.md).

The full profile includes Calendar and Meet development surfaces. Meet runs on
LiveKit: `docker compose --profile meet up -d` starts it with development keys,
and browsers reach it at `ws://localhost:28451` (`LIVEKIT_HTTP_PORT`). Media uses
TCP 7881 and UDP 7882, and TURN UDP 3478, on `127.0.0.1`. Recording and live
transcription are not available yet. Their presence in demo data does not change
the [1.0 production scope](release/1.0-scope.md).

## Everyday commands

| Task                               | Command                                                 |
| ---------------------------------- | ------------------------------------------------------- |
| Start API and web                  | `pnpm dev`                                              |
| Apply migrations                   | `pnpm --filter @helix/app db:migrate`                   |
| Seed a small demo                  | `pnpm --filter @helix/app db:seed:demo -- --size small` |
| Follow infrastructure logs         | `pnpm infra:logs`                                       |
| Stop containers, retain volumes    | `pnpm infra:down`                                       |
| Check formatting                   | `pnpm format:check`                                     |
| Check types and lint               | `pnpm typecheck` and `pnpm lint`                        |
| Run tests                          | `pnpm test`                                             |
| Build all packages                 | `pnpm build`                                            |
| Verify repository boundaries       | `pnpm quality:boundaries`                               |
| Verify launch docs and their links | `pnpm quality:launch-docs`                              |

Stop the foreground dev servers with Ctrl-C. Container volumes persist across
`docker compose down`; adding `--volumes` deletes local data. The optional
[background development scripts](../scripts/README.md) assume infrastructure and
environment are already configured and stop existing matching dev processes.

## Repository map

| Location                                                 | Responsibility                                                         |
| -------------------------------------------------------- | ---------------------------------------------------------------------- |
| `apps/helix`                                             | API, authentication, application services, workers, and migrations     |
| `apps/web`                                               | Browser application                                                    |
| `packages/contracts`                                     | Shared request and response schemas                                    |
| `packages/sdk-types`, `packages/sdk`, `packages/sdk-web` | SDK contracts and integrations                                         |
| `packages/cli`                                           | Command-line client                                                    |
| `packages/config`                                        | Shared tooling configuration                                           |
| `infra`                                                  | Compose, Helm, policies, deployment and verification scripts           |
| `docs`                                                   | Current guides, release evidence, architecture, and historical records |

## Before opening a PR

Keep changes scoped, reuse existing helpers, and preserve tenant authorization,
malware scanning, retention, and audit behavior. Read [AGENTS.md](../AGENTS.md).
Do not edit generated routes or commit build output, local data, or secrets.

Run focused tests first, then `pnpm format:check`, `pnpm typecheck`, `pnpm lint`,
`pnpm test`, `pnpm build`, and `pnpm quality:boundaries`. Web changes also need the
relevant Playwright suites and [accessibility checks](accessibility.md).
Tests requiring live services need their actual dependencies; skipped tests do
not count as deployment evidence. See the [release checklist](release/checklist.md)
for the broader production gates.

## Troubleshooting

- **Wrong Node version:** activate the version in `.node-version` before installing.
- **Cerbos unavailable:** inspect `docker compose logs cerbos`; `pnpm dev` requires
  its health endpoint at `http://localhost:28439/_cerbos/health`.
- **ClamAV is not healthy yet:** inspect `docker compose logs clamav`; allow the
  initial signature download to finish, then rerun the infrastructure command.
  Keep scanning enabled when retrying the seed.
- **Seed rejects the database role:** set `DATABASE_URL` to `helix_app`; use the
  owner only for `HELIX_MIGRATION_DATABASE_URL`.
- **Storage cannot resolve a bucket:** check `RUSTFS_ENDPOINT`, credentials, and
  `RUSTFS_SERVER_DOMAINS`, including `127.0.0.1:28437`, then recreate the RustFS service.
- **Storage requests fail with HTTP 502 or `blocked_destination`:** use
  `http://127.0.0.1:28437` for `RUSTFS_ENDPOINT`. The outbound request guard always
  rejects the `localhost` hostname.
- **API appears stuck during startup:** check service health and keep
  `POSTGRES_POOL_MAX=30` so worker leadership sessions do not exhaust the pool.
- **Login fails:** confirm migrations and the seed completed, and use the Vite URL
  in `BETTER_AUTH_TRUSTED_ORIGINS`. The seed prints the available accounts.

See [operational troubleshooting](troubleshooting.md) for authenticated smoke tests,
mail delivery, search, and dependency failures.
