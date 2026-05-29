# Helix dev scripts

Agent-runnable orchestration for the local dev stack.

## `dev-up.sh` — bring stack up

```sh
scripts/dev-up.sh             # backend + web, no seed
scripts/dev-up.sh --seed      # backend + web + seed the test corpus
scripts/dev-up.sh --reseed    # same as --seed (idempotent)
scripts/dev-up.sh --no-web    # backend only (CI smoke)
```

What it does:
1. Verifies docker infra (postgres, rustfs, meilisearch) is running.
2. Stops any existing helix backend / web dev processes.
3. Loads env from `.env` + `apps/helix/.env`.
4. Derives `RUSTFS_ENDPOINT` from `RUSTFS_API_PORT` when absent.
5. Sets `POSTGRES_POOL_MAX=30` so all 12+ singleton workers can each hold an advisory-lock session without starving the pool.
6. Starts the helix backend (`apps/helix`) and waits for `/healthz`.
7. Starts the web dev server (`apps/web`) and waits for the vite port.
8. Optionally runs `pnpm corpus:seed` to populate Drive with the 1272-file test corpus.

Exit codes: 0 ok · 2 infra missing · 3 backend unhealthy · 4 web unhealthy · 5 seed failed.

Logs: `/tmp/helix-backend.log`, `/tmp/helix-web.log`, `/tmp/helix-seed.log`.

Default credentials: `admin@helix.local` / `helix-admin-password`.

## `dev-down.sh` — stop stack

```sh
scripts/dev-down.sh
```

Gracefully terminates backend + web dev (SIGTERM, then SIGKILL). Leaves docker infra running (use `pnpm infra:down` to stop those too).

## Notes for coding agents

- **Always run from repo root** (the scripts `cd` there themselves, but absolute paths are clearer).
- **Re-running `dev-up.sh` is safe** — it kills prior instances first.
- **Re-running `dev-up.sh --seed`** is idempotent: `drive.upload` checks sha256 and reports `alreadyExists`, the seed counts those as `existed` instead of `uploaded`.
- **If `dev-up.sh` reports "backend never became healthy"**, check `/tmp/helix-backend.log`. Most common causes:
  - Postgres pool exhausted (workers waiting for sessions) — already mitigated by `POSTGRES_POOL_MAX=30`. If you add more workers, bump it again.
  - A connector plugin hanging in its `register()` hook — set `HELIX_PLUGINS_DIR=/tmp/empty-plugins` to skip plugins, then identify the offender.
  - Postgres/RustFS/Meilisearch container not running — `pnpm infra:up`.
- **The web dev server proxies API calls to the backend on `:3000`** — both must be up for the UI to work end-to-end.
