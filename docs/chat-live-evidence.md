# Chat live and pilot-load evidence

`infra/scripts/chat-live-evidence-smoke.mjs` is the release-evidence runner for plan Task C6 and
the Chat portion of V3. It does not infer success from configuration or unit tests. With no live
configuration it emits a complete `not_run` report; an invalid configuration or unavailable live
fixture emits `failed` results. Only observed browser, dependency, Drive, and metrics assertions can
produce `passed`.

This evidence covers the Workspace MVP's secure organization Chat. It does not implement or test
native document editors.

## Required live fixture

Provision a disposable production-like deployment with:

- two simultaneously running Helix application replicas at two distinct HTTPS origins;
- two protected commands that each return the stable pod/process identity behind one direct
  replica origin;
- a shared PostgreSQL database, authenticated TLS Redis, and authenticated mTLS NATS;
- one private room containing the sender, receiver, and every pilot-load user;
- a third authenticated user who is not a room member;
- one Drive object whose real scanner state is `active`;
- one EICAR Drive object whose real scanner state is `quarantined`;
- explicit, non-interactive restart commands for one application replica, Redis, and NATS;
- a protected command that reads recent application logs;
- a protected metrics command that prints only a JSON object with numeric `dbPoolPending`,
  `redisBacklog`, and `natsBacklog` fields.

The two replica origins must route directly to different application processes. A load balancer URL
listed twice is rejected and cannot prove cross-instance NATS fan-out. Both origins must have valid,
trusted TLS certificates. The runner intentionally has no insecure-TLS switch.

Create Playwright storage-state files after an ordinary browser login. They contain live session
cookies, so store them outside the repository and make them owner-readable only:

```sh
chmod 600 /protected/helix-chat-evidence/*.json
```

Provide one distinct state file for each configured load user. Repeating a state path cannot prove
the parameterized user count and is rejected. The three functional actors may also appear among
the load users.

## Protected configuration

The configuration contains paths and commands, never raw cookies, passwords, bearer tokens, or
connection strings. Keep it outside the repository with mode `0600`.

```json
{
  "replicaUrls": ["https://helix-app-a.evidence.example", "https://helix-app-b.evidence.example"],
  "replicaIdentityCommands": [
    [
      "kubectl",
      "-n",
      "helix-evidence",
      "get",
      "pod",
      "helix-app-a",
      "-o",
      "jsonpath={.metadata.uid}"
    ],
    [
      "kubectl",
      "-n",
      "helix-evidence",
      "get",
      "pod",
      "helix-app-b",
      "-o",
      "jsonpath={.metadata.uid}"
    ]
  ],
  "roomId": "11111111-1111-4111-8111-111111111111",
  "actors": {
    "sender": "./sender.storage-state.json",
    "receiver": "./receiver.storage-state.json",
    "nonMember": "./non-member.storage-state.json"
  },
  "drive": {
    "cleanObjectId": "22222222-2222-4222-8222-222222222222",
    "eicarObjectId": "33333333-3333-4333-8333-333333333333"
  },
  "restartHooks": {
    "app": ["kubectl", "-n", "helix-evidence", "delete", "pod", "helix-app-a"],
    "redis": ["kubectl", "-n", "helix-evidence", "rollout", "restart", "statefulset/redis"],
    "nats": ["kubectl", "-n", "helix-evidence", "rollout", "restart", "statefulset/nats"]
  },
  "logProbe": {
    "command": [
      "kubectl",
      "-n",
      "helix-evidence",
      "logs",
      "-l",
      "app=helix",
      "--since=5m",
      "--prefix"
    ],
    "delayMs": 2000
  },
  "metrics": {
    "backlogProbeCommand": ["/protected/helix-chat-evidence/read-chat-backlogs"]
  },
  "load": {
    "users": 50,
    "sockets": 100,
    "durationSeconds": 1800,
    "steadyMessagesPerSecond": 1,
    "burstMessages": 20,
    "burstIntervalSeconds": 60,
    "sampleIntervalMs": 5000,
    "deliveryDrainMs": 30000,
    "userStorageStates": ["./load-user-01.storage-state.json", "./load-user-02.storage-state.json"],
    "thresholds": {
      "p95LatencyMs": 2000,
      "p99LatencyMs": 5000,
      "maxErrorRate": 0.01,
      "maxMemoryGrowthBytes": 268435456,
      "maxEventLoopLagMs": 250,
      "maxDbPoolPending": 0,
      "maxRedisBacklog": 0,
      "maxNatsBacklog": 0
    }
  }
}
```

The example abbreviates `userStorageStates`; a 50-user run must contain 50 distinct protected
files. Restart commands are argv arrays and are executed directly without a shell. They must return
only after initiating the intended restart and must exit nonzero if they could not do so.
Replica identity probes must each print one distinct, stable, non-secret identifier using only
letters, digits, dots, underscores, colons, or hyphens. The report stores hashes of those
identifiers, not the identifiers themselves.

The backlog probe must emit exactly one JSON object on stdout, for example:

```json
{ "dbPoolPending": 0, "redisBacklog": 0, "natsBacklog": 0 }
```

It should query authoritative deployment telemetry (database pool metrics, Redis replication/client
or queue telemetry, and NATS subscription/JetStream pending state) using credentials supplied by
the operator environment. It must not print credentials or connection URLs. Application
resident-memory and event-loop lag are independently scraped from `/metrics` on both replica
origins.

## Execute and validate

```sh
pnpm quality:chat-live-evidence -- \
  --config /protected/helix-chat-evidence/config.json \
  --output /protected/helix-chat-evidence/chat-live-evidence.json

pnpm quality:chat-live-evidence -- \
  --validate /protected/helix-chat-evidence/chat-live-evidence.json \
  --require-pass \
  --require-release-load
```

`--require-pass` requires all ten named C6/V3 scenarios to pass. `--require-release-load` additionally
enforces at least 50 measured users, 100 measured sockets, 30 minutes of traffic, p95 at or below
two seconds, and all declared p99, error-rate, memory, event-loop, database-pool, Redis, and NATS
limits. A shorter developer run can exercise the runner, but it is not release evidence.

The report contains hashes and aggregate measurements only. It rejects credential-shaped field
names and values, never serializes room/object/message identifiers, and writes `--output` with mode
`0600`.

## Scenario semantics

The runner proves:

1. Two separately authenticated browser contexts exchange messages bidirectionally over real
   WebSockets.
2. The non-member cannot enumerate the room and receives non-enumerating REST and WebSocket denials
   for list, search, subscribe, and send.
3. Messages cross both direct replica endpoints in both directions. This is the runtime proof that
   shared NATS fan-out, rather than an in-process bus, is functioning.
4. Application, Redis, and NATS are restarted independently. For each restart, the runner records a
   message before restart, waits for readiness, reconnects both browser clients, verifies durable
   search, and observes post-restart fan-out.
5. An `active` Drive object can be attached and observed, while a `quarantined` EICAR object is
   denied and never fanned out.
6. A browser socket from an invalid origin closes with policy code `4403`. A generated first-frame
   credential marker is rejected with `4401`, is not reflected to the client, and is absent from
   the protected application-log sample. Browser request and socket URLs are checked for
   credential-shaped query keys.
7. The parameterized load opens the requested sockets across distinct authenticated users, drives
   steady and burst traffic, measures accepted-to-visible p95/p99, and asserts delivery count,
   error rate, process memory growth, event-loop lag, database pool waiters, and Redis/NATS backlog.

The runner does not claim the plan's 24-hour private-pilot soak. That temporal gate requires a
separate, actually elapsed 24-hour run and its own retained evidence packet.
