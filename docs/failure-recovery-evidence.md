# V4 failure and recovery evidence

`infra/scripts/failure-recovery-runner.mjs` is the opt-in Task V4 orchestrator. Its contract covers
all nine plan scenarios:

1. application restart during both the Mail undo window and dispatch;
2. Drive scanner restart during scanning;
3. NATS restart during active Chat;
4. Redis restart during rate limiting and presence;
5. temporary object-store denial;
6. critical audit-destination failure;
7. expiry of both provider and agent credentials;
8. a disposable volume crossing the low-space threshold; and
9. restore into a genuinely empty environment.

Every passing scenario must contain observed fault-injection timestamps and four independently
evidenced assertions:

- the scenario-specific user-visible behavior;
- retry counts, idempotency-key counts, side-effect counts, and exactly zero duplicates;
- the exact expected alert rule(s), firing time, and safe resource ID; and
- a scenario-specific healthy recovery check.

References are restricted to content-free API, browser, database, queue, object-store, log, metric,
Alertmanager, or restore evidence. The validator rejects sensitive field names. A harness error,
missing observation, contract mismatch, or incomplete scenario creates a safe `failed` result; it
can never be promoted to `passed`.

## Static contract check

Static mode executes no faults and truthfully records all scenarios as `not_run`:

```sh
node infra/scripts/failure-recovery-runner.mjs --static
pnpm exec vitest run infra/scripts/failure-recovery-runner.test.mjs
```

Static output is not release evidence and fails `--require-pass`.

## Live disposable run

The runner deliberately does not encode deployment-specific kill, network-denial, disk-fill, or
restore commands. An operator-supplied harness owns those actions and emits one observation JSON
document per requested scenario. This keeps production credentials and environment topology out
of the repository while retaining a strict common evidence contract.

Point this only at a dedicated disposable production-like stack:

```sh
evidence_dir="artifacts/release-readiness/$(date +%F)/$(git rev-parse HEAD)"
mkdir -p "$evidence_dir"

HELIX_FAILURE_RECOVERY_ACK=I_ACKNOWLEDGE_DISPOSABLE_FAULT_INJECTION \
HELIX_FAILURE_RECOVERY_ENVIRONMENT_CLASS=disposable \
HELIX_FAILURE_RECOVERY_ENVIRONMENT_ID=disposable-v4-$(date +%s) \
HELIX_FAILURE_RECOVERY_HARNESS=/absolute/path/to/site-specific-v4-harness.mjs \
node infra/scripts/failure-recovery-runner.mjs \
  --live \
  --allow-fault-injection \
  --require-pass \
  --output "$evidence_dir/failure-recovery-evidence.json"
```

The environment ID must start with `disposable-` and is rejected if it contains a production,
customer, or live marker. The harness path must be absolute. The runner uses no shell, caps stdout
at 1 MiB, discards harness stderr from evidence, and applies a bounded timeout.

Validate a captured report without injecting faults:

```sh
node infra/scripts/failure-recovery-runner.mjs \
  --validate "$evidence_dir/failure-recovery-evidence.json" \
  --require-pass
```

## Known release blockers

No live V4 run is included by this repository change. A site-specific harness and disposable stack
are still required, so the plan's V4 gate remains open until the resulting report passes.

The low-space contract requires the provisioned `HelixNodeFilesystemLowSpace` alert and a live
observation of that exact rule firing. A similarly named provider alert is not accepted as a
substitute.

The runner validates evidence; it does not claim that a passing JSON document independently proves
the external system was honest. Release operators must retain the referenced Alertmanager queries,
database/queue checks, logs, and restore hashes with the release bundle.

This program covers the storage-only Workspace MVP. Native document/spreadsheet/presentation
editing and `helix-editors` changes are outside its scope.
