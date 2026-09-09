#!/usr/bin/env node

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const root = await mkdtemp(join(tmpdir(), "helix-aes-gcm-"));
const helper = new URL("./aes-gcm-file.mjs", import.meta.url);
const source = join(root, "source.tar.gz");
const encrypted = join(root, "backup.kms");
const wrapped = join(root, "backup.kms.datakey");
const restored = join(root, "restored.tar.gz");
const key = randomBytes(32).toString("base64");
const plaintext = randomBytes(128 * 1024);

try {
  await writeFile(source, plaintext);
  const encryption = spawnSync(
    process.execPath,
    [helper.pathname, "encrypt", source, encrypted, wrapped],
    {
      input: JSON.stringify({ Plaintext: key, CiphertextBlob: "wrapped-test-key" }),
      encoding: "utf8",
    },
  );
  assert.equal(encryption.status, 0, encryption.stderr);
  assert.equal((await readFile(wrapped, "utf8")).trim(), "wrapped-test-key");

  const decryption = spawnSync(process.execPath, [helper.pathname, "decrypt", encrypted, restored], {
    input: key,
    encoding: "utf8",
  });
  assert.equal(decryption.status, 0, decryption.stderr);
  assert.deepEqual(await readFile(restored), plaintext);

  const tampered = await readFile(encrypted);
  tampered[Math.floor(tampered.byteLength / 2)] ^= 1;
  await writeFile(encrypted, tampered);
  const rejected = spawnSync(process.execPath, [helper.pathname, "decrypt", encrypted, restored], {
    input: key,
    encoding: "utf8",
  });
  assert.notEqual(rejected.status, 0, "tampered ciphertext must fail authentication");
  console.log("AES-GCM file encryption validation passed");
} finally {
  await rm(root, { force: true, recursive: true });
}
