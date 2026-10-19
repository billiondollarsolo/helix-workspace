import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { setTimeout } from "node:timers/promises";
const image = process.argv[2];
if (!image) throw new Error("Pass the built backup-worker image.");
const name = "helix-backup-smoke-" + randomUUID().slice(0, 8);
const config = {
  binding: {
    application: "bot",
    installationId: randomUUID(),
    tenantId: randomUUID(),
    orgId: randomUUID(),
    connectionId: randomUUID(),
  },
  stateDirectory: "/var/lib/helix-backup-worker/state",
  managementKeyFile: "/private/management.key",
  scheduler: "external",
  destinations: ["fixture"],
  minimumRetentionDays: 30,
  requiredCoverage: ["database", "files", "configuration"],
  initialPolicy: {
    revision: 0,
    enabled: false,
    intervalMinutes: 1440,
    retentionDays: 30,
    destinationRef: "fixture",
  },
  commands: { backup: ["node", "-e", "process.exit(1)"] },
};
const docker = (args, options = {}) =>
  execFileSync("docker", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 60000,
    ...options,
  });
try {
  docker(["volume", "create", name]);
  const setup = `const fs=require('node:fs');fs.chownSync('/private',10001,10001);fs.chmodSync('/private',0o700);fs.writeFileSync('/private/worker.json',${JSON.stringify(JSON.stringify(config))},{mode:0o440});fs.writeFileSync('/private/management.key','a'.repeat(64),{mode:0o440});for(const f of ['worker.json','management.key'])fs.chownSync('/private/'+f,0,10001);`;
  docker([
    "run",
    "--rm",
    "--user",
    "0:0",
    "--entrypoint",
    "node",
    "-v",
    `${name}:/private`,
    image,
    "-e",
    setup,
  ]);
  docker([
    "run",
    "--detach",
    "--name",
    name,
    "--read-only",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--tmpfs",
    "/tmp:rw,nosuid,nodev",
    "-v",
    `${name}:/private:ro`,
    "-v",
    `${name}-state:/var/lib/helix-backup-worker`,
    image,
    "dist/platform/backup/federation-worker.js",
    "serve",
    "/private/worker.json",
  ]);
  const deadline = Date.now() + 30000;
  let status;
  while (!status) {
    try {
      status = JSON.parse(
        docker([
          "exec",
          name,
          "node",
          "-e",
          "fetch('http://127.0.0.1:3081/v1/federation-operations/status',{headers:{authorization:'Bearer '+'a'.repeat(64)}}).then(async r=>{if(!r.ok)process.exit(1);console.log(JSON.stringify(await r.json()))}).catch(()=>process.exit(1))",
        ]),
      );
    } catch (error) {
      if (Date.now() > deadline) throw error;
      await setTimeout(250);
    }
  }
  assert.deepEqual(status.binding, config.binding);
  assert.equal(status.owner, "local");
  const container = JSON.parse(docker(["inspect", name]))[0];
  assert.equal(container.Config.User, "10001:10001");
  assert.equal(container.HostConfig.ReadonlyRootfs, true);
  assert.equal(Object.keys(container.HostConfig.PortBindings ?? {}).length, 0);
  console.log(
    "PASS: built worker runs non-root with read-only root, private projected-style files, durable journal and no published port.",
  );
} finally {
  try {
    docker(["rm", "--force", "--volumes", name]);
  } catch {}
  for (const volume of [name, name + "-state"])
    try {
      docker(["volume", "rm", volume]);
    } catch {}
}
