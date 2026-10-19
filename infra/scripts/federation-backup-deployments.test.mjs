import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
const digest = "sha256:" + "1".repeat(64);
const worker = [
  "--set",
  "backupWorker.enabled=true",
  "--set-string",
  `backupWorker.image=example.invalid/recovery@${digest}`,
  "--set",
  "backupWorker.existingSecret=recovery",
  "--set",
  "backupWorker.ingress[0].ports[0].port=3081",
  "--set",
  "backupWorker.egress[0].ports[0].port=5432",
];
function render(chart, extra = []) {
  return spawnSync(
    "helm",
    [
      "template",
      "fixture",
      chart,
      "--set-string",
      `image.digest=${digest}`,
      "--set-string",
      `cloudnativepg.image.digest=${digest}`,
      ...extra,
    ],
    { encoding: "utf8" },
  );
}
for (const [name, chart, base] of [
  ["Workspace", "infra/helm/helix", []],
  [
    "Bot",
    "../helix-bot/deploy/helm/helix-bot",
    [
      "--set-string",
      "publicUrl=https://bot.example.test",
      "--set",
      "credentialsSecret=bot",
      "--set",
      "postgres.backup.destinationPath=s3://fixture/backups",
      "--set",
      "postgres.backup.s3Credentials.accessKeyId.name=backup",
      "--set",
      "postgres.backup.s3Credentials.accessKeyId.key=access",
      "--set",
      "postgres.backup.s3Credentials.secretAccessKey.name=backup",
      "--set",
      "postgres.backup.s3Credentials.secretAccessKey.key=secret",
    ],
  ],
]) {
  test(
    `${name} requires explicit worker custody/network/image and keeps a single private journal`,
    { skip: !existsSync(chart) },
    () => {
      const missing = render(chart, [...base, "--set", "backupWorker.enabled=true"]);
      assert.notEqual(missing.status, 0);
      assert.match(missing.stderr, /pinned by digest/);
      const success = render(chart, [...base, ...worker]);
      assert.equal(success.status, 0, success.stderr);
      assert.match(success.stdout, /ReadWriteOncePod/);
      assert.match(success.stdout, /automountServiceAccountToken: false/);
      assert.match(success.stdout, /strategy: \{type: Recreate\}/);
      assert.match(success.stdout, /readOnlyRootFilesystem: true/);
      const missingNetwork = render(chart, [
        ...base,
        ...worker,
        "--set",
        "backupWorker.egress=null",
      ]);
      assert.notEqual(missingNetwork.status, 0);
      assert.match(missingNetwork.stderr, /explicit ingress\/egress/);
      const conflict = render(chart, [
        ...base,
        ...worker,
        "--set",
        "backupWorker.ownsSchedule=true",
        ...(name === "Workspace"
          ? [
              "--set",
              "cloudnativepg.enabled=true",
              "--set",
              "cloudnativepg.scheduledBackup.enabled=true",
              "--set",
              "cloudnativepg.scheduledBackup.suspend=false",
            ]
          : []),
      ]);
      assert.notEqual(conflict.status, 0);
      assert.match(conflict.stderr, /Suspend|backup.scheduler=external/);
    },
  );
}
for (const [file, prefix] of [
  ["docker-compose.backup-worker.yml", "HELIX"],
  ["../helix-bot/deploy/compose/compose.backup-worker.yaml", "CHUNGUS"],
]) {
  test(
    `${prefix} optional compose executor publishes no port or privileged socket`,
    { skip: !existsSync(file) },
    () => {
      const rendered = spawnSync("docker", ["compose", "-f", file, "config", "--format", "json"], {
        encoding: "utf8",
        env: {
          ...process.env,
          [`${prefix}_BACKUP_WORKER_IMAGE`]: `example.invalid/recovery@${digest}`,
          [`${prefix}_BACKUP_WORKER_CONFIG`]: "/tmp/recovery-private-fixture",
        },
      });
      assert.equal(rendered.status, 0, rendered.stderr);
      const service = JSON.parse(rendered.stdout).services["backup-worker"];
      assert.equal(service.read_only, true);
      assert.deepEqual(service.cap_drop, ["ALL"]);
      assert.equal(service.ports, undefined);
      assert(!JSON.stringify(service.volumes).includes("docker.sock"));
      assert(service.volumes.some((mount) => mount.read_only === true));
    },
  );
}
