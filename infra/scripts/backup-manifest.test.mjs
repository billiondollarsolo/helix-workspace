#!/usr/bin/env node

import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const manifestScript = fileURLToPath(new URL("./backup-manifest.mjs", import.meta.url));

const root = await mkdtemp(join(tmpdir(), "helix-manifest-test-"));
try {
  const backup = join(root, "backup");
  await mkdir(join(backup, "objects"), { recursive: true });
  await writeFile(join(backup, "postgres.dump"), "database");
  await writeFile(join(backup, "objects", "one.bin"), "object");
  await writeFile(
    join(backup, "manifest.json"),
    `${JSON.stringify({ schema_version: 3, app_version: "build-1", postgres: { end_lsn: "0/123", migrations: [] } })}\n`,
  );

  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const privatePath = join(root, "private.pem");
  const publicPath = join(root, "public.pem");
  await writeFile(privatePath, privateKey.export({ type: "pkcs8", format: "pem" }));
  await writeFile(publicPath, publicKey.export({ type: "spki", format: "pem" }));

  run("sign", backup, join(backup, "manifest.json"), privatePath);
  run("verify", backup, join(backup, "manifest.json"), publicPath, "build-1");

  await writeFile(join(backup, "objects", "one.bin"), "tampered");
  mustFail("verify", backup, join(backup, "manifest.json"), publicPath, "build-1");
  await writeFile(join(backup, "objects", "one.bin"), "object");

  await rm(join(backup, "objects", "one.bin"));
  mustFail("verify", backup, join(backup, "manifest.json"), publicPath, "build-1");
  await writeFile(join(backup, "objects", "one.bin"), "object");

  mustFail("verify", backup, join(backup, "manifest.json"), publicPath, "wrong-build");
  const manifest = JSON.parse(await readFile(join(backup, "manifest.json"), "utf8"));
  manifest.app_version = "forged";
  await writeFile(join(backup, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  mustFail("verify", backup, join(backup, "manifest.json"), publicPath, "forged");

  process.stdout.write("backup manifest tests passed\n");
} finally {
  await rm(root, { recursive: true, force: true });
}

function run(...args) {
  const result = spawnSync(process.execPath, [manifestScript, ...args], {
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || "manifest command failed");
  }
}

function mustFail(...args) {
  const result = spawnSync(process.execPath, [manifestScript, ...args], {
    encoding: "utf8",
  });
  if (result.status === 0) {
    throw new Error("manifest verification unexpectedly succeeded");
  }
}
